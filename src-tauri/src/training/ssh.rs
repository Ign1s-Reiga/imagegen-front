//! SSH transport to a training host: key authentication, host-key checks,
//! running the runner with a request on stdin, and SFTP transfers that can
//! pick up where an interrupted one stopped.
//!
//! Host keys are checked as OpenSSH does: a key recorded in the user's
//! `~/.ssh/known_hosts` or in the app's own file is accepted, a different key
//! for a recorded host is refused, and an unknown host is refused with its
//! fingerprint so the user can compare it and choose to trust it.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, AuthResult, Handle};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::error::{Error, Result};

/// Everything needed to reach a host. Secrets are filled in from the
/// keychain by the caller, never stored here or in settings.
#[derive(Clone)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub private_key: String,
    pub passphrase: Option<String>,
    pub known_hosts: PathBuf,
}

/// Why a connection was refused before any credential was sent.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum HostKeyProblem {
    /// Never seen: show the fingerprint and let the user decide.
    Unknown {
        fingerprint: String,
        algorithm: String,
    },
    /// A different key than the one recorded: possibly an attack, or a
    /// reinstalled host. Never accepted from the app.
    Changed {
        fingerprint: String,
        algorithm: String,
    },
}

pub const HOST_KEY_PREFIX: &str = "HOST_KEY:";

impl HostKeyProblem {
    /// Carried to the webview inside the error text, as JSON after a marker.
    pub fn into_error(self) -> Error {
        Error::msg(format!(
            "{HOST_KEY_PREFIX}{}",
            serde_json::to_string(&self).unwrap_or_default()
        ))
    }
}

fn user_known_hosts() -> Option<PathBuf> {
    std::env::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

/// Looks the key up in each known_hosts file in turn.
pub fn check_host_key(
    host: &str,
    port: u16,
    key: &PublicKey,
    files: &[PathBuf],
) -> std::result::Result<(), HostKeyProblem> {
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    let algorithm = key.algorithm().to_string();
    for file in files {
        if !file.is_file() {
            continue;
        }
        match keys::check_known_hosts_path(host, port, key, file) {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(keys::Error::KeyChanged { .. }) => {
                return Err(HostKeyProblem::Changed {
                    fingerprint,
                    algorithm,
                });
            }
            Err(err) => log::warn!("could not read {}: {err}", file.display()),
        }
    }
    Err(HostKeyProblem::Unknown {
        fingerprint,
        algorithm,
    })
}

struct Checker {
    host: String,
    port: u16,
    files: Vec<PathBuf>,
    /// The key the server offered, kept for the error the caller reports.
    seen: Arc<Mutex<Option<std::result::Result<(), HostKeyProblem>>>>,
    /// When trusting: the fingerprint the user approved. A matching unknown
    /// key is then recorded in the app's file.
    trust: Option<String>,
    app_file: PathBuf,
}

impl client::Handler for Checker {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        offered: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = offered else {
            *self.seen.lock().unwrap() = Some(Err(HostKeyProblem::Unknown {
                fingerprint: "host certificate".into(),
                algorithm: "certificate".into(),
            }));
            return Ok(false);
        };
        let mut verdict = check_host_key(&self.host, self.port, key, &self.files);
        if let (Err(HostKeyProblem::Unknown { fingerprint, .. }), Some(approved)) =
            (&verdict, &self.trust)
            && fingerprint == approved
        {
            keys::known_hosts::learn_known_hosts_path(&self.host, self.port, key, &self.app_file)
                .map_err(|err| russh::Error::IO(std::io::Error::other(err.to_string())))?;
            verdict = Ok(());
        }
        let ok = verdict.is_ok();
        *self.seen.lock().unwrap() = Some(verdict);
        Ok(ok)
    }
}

pub struct Session {
    handle: Handle<Checker>,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

impl Session {
    pub async fn connect(target: &Target) -> Result<Self> {
        Self::open(target, None).await
    }

    /// Connects once to record a host key the user approved by fingerprint.
    pub async fn trust(target: &Target, fingerprint: &str) -> Result<()> {
        let session = Self::open(target, Some(fingerprint.to_owned())).await?;
        session.close().await;
        Ok(())
    }

    async fn open(target: &Target, trust: Option<String>) -> Result<Self> {
        let key = keys::decode_secret_key(&target.private_key, target.passphrase.as_deref())
            .map_err(|err| Error::msg(format!("The private key could not be read: {err}. Paste an OpenSSH private key, and its passphrase if it has one.")))?;

        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(20)),
            keepalive_max: 3,
            ..Default::default()
        });
        let seen = Arc::new(Mutex::new(None));
        let mut files: Vec<PathBuf> = user_known_hosts().into_iter().collect();
        files.push(target.known_hosts.clone());
        let checker = Checker {
            host: target.host.clone(),
            port: target.port,
            files,
            seen: seen.clone(),
            trust,
            app_file: target.known_hosts.clone(),
        };
        let addr = (target.host.as_str(), target.port);
        let connected =
            tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, addr, checker)).await;
        let mut handle = match connected {
            Err(_) => {
                return Err(Error::msg(format!(
                    "Timed out connecting to {}:{}.",
                    target.host, target.port
                )));
            }
            Ok(Ok(handle)) => handle,
            Ok(Err(err)) => {
                if let Some(Err(problem)) = seen.lock().unwrap().take() {
                    return Err(problem.into_error());
                }
                return Err(Error::msg(format!(
                    "Could not connect to {}:{}: {err}",
                    target.host, target.port
                )));
            }
        };

        let hash = if key.algorithm().is_rsa() {
            handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten()
        } else {
            None
        };
        let auth = handle
            .authenticate_publickey(
                &target.user,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await
            .map_err(|err| Error::msg(format!("SSH authentication failed: {err}")))?;
        if !matches!(auth, AuthResult::Success) {
            return Err(Error::msg(format!(
                "{} refused the key for user {}. Check that its public key is in the host's authorized_keys.",
                target.host, target.user
            )));
        }
        Ok(Self { handle })
    }

    pub async fn close(self) {
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    }

    /// Runs one command, writing `stdin` to it, and collects its output.
    pub async fn exec(&self, command: &str, stdin: &[u8], timeout: Duration) -> Result<Output> {
        let run = async {
            let mut channel = self.handle.channel_open_session().await?;
            channel.exec(true, command).await?;
            if !stdin.is_empty() {
                channel.data_bytes(stdin.to_vec()).await?;
            }
            channel.eof().await?;
            let mut out = Output::default();
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => out.stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => out.stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => out.status = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            Ok::<_, russh::Error>(out)
        };
        tokio::time::timeout(timeout, run)
            .await
            .map_err(|_| Error::msg("The host did not answer in time."))?
            .map_err(|err| Error::msg(format!("SSH error: {err}")))
    }

    pub async fn sftp(&self) -> Result<SftpSession> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|err| Error::msg(format!("SSH error: {err}")))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|err| Error::msg(format!("The host does not offer SFTP: {err}")))?;
        SftpSession::new(channel.into_stream())
            .await
            .map_err(|err| Error::msg(format!("SFTP error: {err}")))
    }
}

#[derive(Default, Debug)]
pub struct Output {
    pub status: Option<u32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

fn sftp_err(what: &str) -> impl Fn(russh_sftp::client::error::Error) -> Error + '_ {
    move |err| Error::msg(format!("{what}: {err}"))
}

/// `mkdir -p` over SFTP, for paths the app built.
pub async fn make_dirs(sftp: &SftpSession, path: &str) -> Result<()> {
    let mut current = String::new();
    for part in path.split('/').filter(|p| !p.is_empty()) {
        current.push('/');
        current.push_str(part);
        if !sftp.try_exists(current.clone()).await.unwrap_or(false) {
            sftp.create_dir(current.clone())
                .await
                .map_err(sftp_err("Could not create a folder on the host"))?;
        }
    }
    Ok(())
}

const CHUNK: usize = 256 * 1024;

/// Uploads a local file to `remote`. Bytes go to `remote.part` first, which
/// a later attempt continues from rather than restarting; the finished file
/// is then renamed into place. A file already there at the full size is left
/// for the caller's hash check to confirm. Returns bytes sent.
pub async fn upload(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    mut progress: impl FnMut(u64),
) -> Result<u64> {
    let mut file = tokio::fs::File::open(local).await?;
    let len = file.metadata().await?.len();
    if let Ok(meta) = sftp.metadata(remote.to_owned()).await
        && meta.size == Some(len)
    {
        progress(len);
        return Ok(0);
    }
    let part = format!("{remote}.part");
    let mut offset = match sftp.metadata(part.clone()).await {
        Ok(meta) if meta.size.is_some_and(|s| s <= len) => meta.size.unwrap_or(0),
        _ => 0,
    };
    let flags = if offset > 0 {
        OpenFlags::WRITE
    } else {
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
    };
    let mut out = sftp
        .open_with_flags(part.clone(), flags)
        .await
        .map_err(sftp_err("Could not write on the host"))?;
    out.seek(std::io::SeekFrom::Start(offset)).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    progress(offset);
    let mut sent = 0;
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).await?;
        offset += n as u64;
        sent += n as u64;
        progress(offset);
    }
    out.flush().await?;
    out.shutdown().await?;
    if sftp.try_exists(remote.to_owned()).await.unwrap_or(false) {
        sftp.remove_file(remote.to_owned())
            .await
            .map_err(sftp_err("Could not replace a file on the host"))?;
    }
    sftp.rename(part, remote.to_owned())
        .await
        .map_err(sftp_err("Could not finish an upload"))?;
    Ok(sent)
}

pub async fn remove_if_exists(sftp: &SftpSession, remote: &str) {
    for path in [remote.to_owned(), format!("{remote}.part")] {
        if sftp.try_exists(path.clone()).await.unwrap_or(false) {
            let _ = sftp.remove_file(path).await;
        }
    }
}

/// Downloads a remote file to `local` through a temporary name, returning
/// its SHA-256.
pub async fn download(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    mut progress: impl FnMut(u64),
) -> Result<String> {
    let mut src = sftp
        .open(remote.to_owned())
        .await
        .map_err(sftp_err("Could not read from the host"))?;
    let tmp = local.with_extension("part");
    let mut dst = tokio::fs::File::create(&tmp).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0;
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        dst.write_all(&buf[..n]).await?;
        total += n as u64;
        progress(total);
    }
    dst.flush().await?;
    drop(dst);
    tokio::fs::rename(&tmp, local).await?;
    Ok(hex::encode(hasher.finalize()))
}

pub async fn read_small(sftp: &SftpSession, remote: &str, limit: usize) -> Result<Vec<u8>> {
    let mut file = sftp
        .open(remote.to_owned())
        .await
        .map_err(sftp_err("Could not read from the host"))?;
    let mut out = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        if out.len() > limit {
            return Err(Error::msg("a file on the host is larger than expected"));
        }
    }
    Ok(out)
}

pub async fn write_small(sftp: &SftpSession, remote: &str, data: &[u8]) -> Result<()> {
    let tmp = format!("{remote}.tmp");
    let mut file = sftp
        .open_with_flags(
            tmp.clone(),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(sftp_err("Could not write on the host"))?;
    file.write_all(data).await?;
    file.shutdown().await?;
    if sftp.try_exists(remote.to_owned()).await.unwrap_or(false) {
        sftp.remove_file(remote.to_owned())
            .await
            .map_err(sftp_err("Could not replace a file on the host"))?;
    }
    sftp.rename(tmp, remote.to_owned())
        .await
        .map_err(sftp_err("Could not write on the host"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO0mAwry0If89VYE/lseCm6eK33Lu58f8dgNICx6e1l0";
    const KEY_B: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEJRoiXtgTAO6dZOpy/KKc6/0T248OqoEPd4MzjI4+M4";

    fn key(line: &str) -> PublicKey {
        keys::parse_public_key_base64(line.split_whitespace().nth(1).unwrap()).unwrap()
    }

    #[test]
    fn known_unknown_and_changed_keys() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("known_hosts");
        let files = vec![dir.path().join("missing"), file.clone()];

        let first = check_host_key("pod.example", 2222, &key(KEY_A), &files).unwrap_err();
        let HostKeyProblem::Unknown { fingerprint, .. } = first else {
            panic!("{first:?}")
        };
        assert!(fingerprint.starts_with("SHA256:"));

        keys::known_hosts::learn_known_hosts_path("pod.example", 2222, &key(KEY_A), &file).unwrap();
        assert!(check_host_key("pod.example", 2222, &key(KEY_A), &files).is_ok());
        // Another port is another host.
        assert!(matches!(
            check_host_key("pod.example", 22, &key(KEY_A), &files),
            Err(HostKeyProblem::Unknown { .. })
        ));
        assert!(matches!(
            check_host_key("pod.example", 2222, &key(KEY_B), &files),
            Err(HostKeyProblem::Changed { .. })
        ));
    }

    #[test]
    fn host_key_errors_carry_json() {
        let err = HostKeyProblem::Unknown {
            fingerprint: "SHA256:x".into(),
            algorithm: "ssh-ed25519".into(),
        }
        .into_error();
        let text = err.to_string();
        let json: serde_json::Value =
            serde_json::from_str(text.strip_prefix(HOST_KEY_PREFIX).unwrap()).unwrap();
        assert_eq!(json["kind"], "unknown");
        assert_eq!(json["fingerprint"], "SHA256:x");
    }
}
