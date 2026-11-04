//! LoRA training: projects of photographs kept on this machine, and runs on
//! a GPU host reached over SSH.
//!
//! The webview never touches the files or the host directly. It asks for
//! one narrow action at a time (import these photos, upload this run, read
//! its status), and this module does it: dialogs, copies and conversions on
//! disk, keychain reads, and every byte sent to or read from the host.

mod dataset;
mod db;
mod remote;
mod ssh;
#[cfg(test)]
mod transport_test;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::error::{Error, Result};
use crate::{files, secrets};
use db::{Artifact, Item, ItemPatch, Project, Run};
use remote::{Command, HostSpec, Layout, Snapshot, SnapshotItem, TrainConfig};

pub struct Training {
    conn: Mutex<Connection>,
    root: PathBuf,
    /// Hosts (by workspace) this session already gave the current runner.
    deployed: Mutex<HashSet<String>>,
}

impl Training {
    pub fn open(app: &AppHandle) -> Result<Self> {
        let root = app.path().app_data_dir()?.join("training");
        fs::create_dir_all(root.join("projects"))?;
        fs::create_dir_all(root.join("artifacts"))?;
        let conn = Connection::open(root.join("training.sqlite3"))?;
        db::open(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            root,
            deployed: Mutex::new(HashSet::new()),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn project_dir(&self, project_id: &str) -> Result<PathBuf> {
        check_uuid(project_id)?;
        Ok(self.root.join("projects").join(project_id))
    }

    fn run_dir(&self, project_id: &str, run_id: &str) -> Result<PathBuf> {
        check_uuid(run_id)?;
        Ok(self.project_dir(project_id)?.join("runs").join(run_id))
    }

    fn original_path(&self, item: &Item) -> Result<PathBuf> {
        Ok(self
            .project_dir(&item.project_id)?
            .join("originals")
            .join(&item.file_name))
    }

    fn thumb_path(&self, item: &Item) -> Result<PathBuf> {
        Ok(self
            .project_dir(&item.project_id)?
            .join("thumbs")
            .join(format!("{}.jpg", item.id)))
    }

    fn artifact_path(&self, artifact: &Artifact) -> PathBuf {
        self.root.join("artifacts").join(&artifact.file_name)
    }
}

fn check_uuid(id: &str) -> Result<()> {
    remote::check_job_id(id).map_err(|_| Error::msg("bad id"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    name: String,
    objective: String,
    trigger_token: String,
    family: String,
    base_model: String,
    config: TrainConfig,
}

/// Trigger tokens are single rare-looking words: letters and digits, with
/// at least one letter, so they can be found in a caption and a prompt.
fn check_project_input(input: &ProjectInput) -> Result<()> {
    if input.name.trim().is_empty() || input.name.chars().count() > 80 {
        return Err(Error::msg(
            "Give the project a name of up to 80 characters.",
        ));
    }
    let token = input.trigger_token.trim();
    let ok = (3..=24).contains(&token.len())
        && token.chars().all(|c| c.is_ascii_alphanumeric())
        && token.chars().any(|c| c.is_ascii_alphabetic());
    if !ok {
        return Err(Error::msg(
            "The trigger token must be one word of 3 to 24 letters and digits, such as ohwx.",
        ));
    }
    if input.family != remote::FAMILY || !remote::BASE_MODELS.contains(&input.base_model.as_str()) {
        return Err(Error::msg(format!(
            "{} ({}) cannot be trained here. This version trains Qwen-Image 2.1 LoRAs with the Diffusers DreamBooth script.",
            input.base_model, input.family
        )));
    }
    input.config.check()
}

#[tauri::command]
pub fn training_projects(training: State<'_, Training>) -> Result<Vec<Value>> {
    let conn = training.conn();
    let projects = db::list_projects(&conn)?;
    projects
        .into_iter()
        .map(|p| {
            let items = db::list_items(&conn, &p.id)?;
            let included = items
                .iter()
                .filter(|i| i.included && i.decode_error.is_none())
                .count();
            Ok(json!({"project": p, "itemCount": items.len(), "includedCount": included}))
        })
        .collect()
}

#[tauri::command]
pub fn training_project_create(
    input: ProjectInput,
    training: State<'_, Training>,
) -> Result<Project> {
    check_project_input(&input)?;
    let now = now_ms();
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name: input.name.trim().to_owned(),
        objective: input.objective,
        trigger_token: input.trigger_token.trim().to_owned(),
        trainer: remote::TRAINER_ID.into(),
        family: input.family,
        base_model: input.base_model,
        config: serde_json::to_value(&input.config)?,
        created_at: now,
        updated_at: now,
    };
    db::insert_project(&training.conn(), &project)?;
    fs::create_dir_all(training.project_dir(&project.id)?.join("originals"))?;
    fs::create_dir_all(training.project_dir(&project.id)?.join("thumbs"))?;
    Ok(project)
}

#[tauri::command]
pub fn training_project_update(
    id: String,
    input: ProjectInput,
    training: State<'_, Training>,
) -> Result<Project> {
    check_project_input(&input)?;
    let conn = training.conn();
    let mut project = db::get_project(&conn, &id)?;
    project.name = input.name.trim().to_owned();
    project.objective = input.objective;
    project.trigger_token = input.trigger_token.trim().to_owned();
    project.family = input.family;
    project.base_model = input.base_model;
    project.config = serde_json::to_value(&input.config)?;
    project.updated_at = now_ms();
    db::update_project(&conn, &project)?;
    Ok(project)
}

/// Removes the project, its copies of the photographs and its local run
/// files. Nothing on a host is touched; registered LoRA files are removed
/// with their records.
#[tauri::command]
pub fn training_project_delete(id: String, training: State<'_, Training>) -> Result<()> {
    let dir = training.project_dir(&id)?;
    let artifacts = {
        let conn = training.conn();
        // A run that may still be going would be left on its host with no
        // record here to check, cancel or clean it up.
        if db::list_runs(&conn, &id)?
            .iter()
            .any(|r| ACTIVE_STATES.contains(&r.state.as_str()))
        {
            return Err(Error::msg(
                "A run of this project may still be running. Cancel it, or check its status, before deleting the project.",
            ));
        }
        let artifacts = db::list_artifacts(&conn, Some(&id))?;
        db::delete_project(&conn, &id)?;
        artifacts
    };
    for artifact in artifacts {
        let _ = fs::remove_file(training.artifact_path(&artifact));
    }
    if dir.is_dir() {
        fs::remove_dir_all(dir)?;
    }
    Ok(())
}

#[tauri::command]
pub fn training_dir(training: State<'_, Training>) -> String {
    path_string(&training.root)
}

// ---------------------------------------------------------------------------
// Photographs
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    #[serde(flatten)]
    item: Item,
    path: String,
    thumb_path: Option<String>,
}

fn item_view(training: &Training, item: Item) -> Result<ItemView> {
    let thumb = training.thumb_path(&item)?;
    Ok(ItemView {
        path: path_string(&training.original_path(&item)?),
        thumb_path: thumb.is_file().then(|| path_string(&thumb)),
        item,
    })
}

#[tauri::command]
pub fn training_items(project_id: String, training: State<'_, Training>) -> Result<Vec<ItemView>> {
    let items = db::list_items(&training.conn(), &project_id)?;
    items
        .into_iter()
        .map(|item| item_view(&training, item))
        .collect()
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    added: usize,
    /// Exact copies of a photo already in the project: "new.jpg" → "old.jpg".
    duplicates: Vec<(String, String)>,
    /// Files that are not JPEG, PNG or WebP.
    unsupported: Vec<String>,
    /// Added, but could not be decoded; they stay out of training.
    unreadable: Vec<String>,
    /// Added with GPS data in their EXIF, which is never uploaded.
    with_location: usize,
}

/// Copies one photograph into the project. The original is only read.
fn import_one(
    training: &Training,
    project_id: &str,
    name: &str,
    bytes: &[u8],
    report: &mut ImportReport,
) -> Result<()> {
    let Some(ext) = dataset::stored_ext(bytes) else {
        report.unsupported.push(name.to_owned());
        return Ok(());
    };
    let sha = dataset::sha256_hex(bytes);
    if let Some(existing) = db::has_item_hash(&training.conn(), project_id, &sha)? {
        report.duplicates.push((name.to_owned(), existing));
        return Ok(());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = training.project_dir(project_id)?;
    fs::create_dir_all(dir.join("originals"))?;
    fs::create_dir_all(dir.join("thumbs"))?;
    let file_name = format!("{id}.{ext}");
    fs::write(dir.join("originals").join(&file_name), bytes)?;

    let decoded = dataset::decode(bytes);
    let mut item = Item {
        id: id.clone(),
        project_id: project_id.to_owned(),
        file_name: file_name.clone(),
        original_name: name.chars().take(200).collect(),
        sha256: sha,
        width: None,
        height: None,
        orientation: 1,
        has_location: false,
        decode_error: None,
        caption: String::new(),
        caption_source: String::new(),
        caption_suggestion: None,
        included: true,
        category: String::new(),
        crop: None,
        added_at: now_ms(),
    };
    match decoded {
        Ok((image, probe)) => {
            item.width = Some(probe.width as i64);
            item.height = Some(probe.height as i64);
            item.orientation = probe.orientation as i64;
            item.has_location = probe.has_location;
            if let Ok(thumb) = dataset::thumbnail(&image) {
                fs::write(dir.join("thumbs").join(format!("{id}.jpg")), thumb)?;
            }
            if probe.has_location {
                report.with_location += 1;
            }
        }
        Err(err) => {
            item.decode_error = Some(err.to_string());
            item.included = false;
            report.unreadable.push(name.to_owned());
        }
    }
    if db::insert_item(&training.conn(), &item)? {
        report.added += 1;
    } else {
        // Imported by a concurrent call in the meantime.
        let _ = fs::remove_file(dir.join("originals").join(&file_name));
        let _ = fs::remove_file(dir.join("thumbs").join(format!("{id}.jpg")));
    }
    Ok(())
}

/// Asks for photographs (or a folder of them) in a native dialog and
/// imports them. The webview never names a file.
#[tauri::command]
pub async fn training_import_dialog(
    window: WebviewWindow,
    project_id: String,
    folder: bool,
    training: State<'_, Training>,
) -> Result<Option<ImportReport>> {
    db::get_project(&training.conn(), &project_id)?;
    let win = window.clone();
    let picked: Option<Vec<PathBuf>> = tauri::async_runtime::spawn_blocking(move || {
        let dialog = win.dialog().file().set_parent(&win);
        if folder {
            dialog
                .blocking_pick_folder()
                .and_then(|p| p.into_path().ok())
                .map(|dir| {
                    let mut files: Vec<PathBuf> = fs::read_dir(dir)
                        .map(|entries| {
                            entries
                                .filter_map(|e| e.ok().map(|e| e.path()))
                                .filter(|p| p.is_file())
                                .collect()
                        })
                        .unwrap_or_default();
                    files.sort();
                    files
                })
        } else {
            dialog
                .add_filter("Photos", &["jpg", "jpeg", "png", "webp"])
                .blocking_pick_files()
                .map(|paths| {
                    paths
                        .into_iter()
                        .filter_map(|p| p.into_path().ok())
                        .collect()
                })
        }
    })
    .await
    .map_err(|err| Error::msg(err.to_string()))?;
    let Some(paths) = picked else { return Ok(None) };

    let mut report = ImportReport::default();
    for path in paths {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if folder && !dataset::is_supported_name(&name) {
            report.unsupported.push(name);
            continue;
        }
        let bytes = fs::read(&path)?;
        import_one(&training, &project_id, &name, &bytes, &mut report)?;
    }
    db::touch_project(&training.conn(), &project_id, now_ms())?;
    Ok(Some(report))
}

/// Imports one dropped photograph: raw bytes in the body, the project in
/// `x-project-id` and the file's name in `x-file-name` (URI-encoded).
#[tauri::command]
pub fn training_import_bytes(
    request: Request<'_>,
    training: State<'_, Training>,
) -> Result<ImportReport> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::msg("expected raw image bytes"));
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    };
    let project_id = header("x-project-id");
    db::get_project(&training.conn(), &project_id)?;
    let name = percent_decode(&header("x-file-name"));
    let mut report = ImportReport::default();
    import_one(&training, &project_id, &name, bytes, &mut report)?;
    db::touch_project(&training.conn(), &project_id, now_ms())?;
    Ok(report)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok());
        if bytes[i] == b'%'
            && let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
pub fn training_item_patch(
    id: String,
    patch: ItemPatch,
    training: State<'_, Training>,
) -> Result<ItemView> {
    let item = db::patch_item(&training.conn(), &id, &patch)?;
    if item.decode_error.is_some() && item.included {
        let item = db::patch_item(
            &training.conn(),
            &id,
            &ItemPatch {
                included: Some(false),
                ..Default::default()
            },
        )?;
        return Err(Error::msg(format!(
            "{} could not be read, so it cannot be trained on.",
            item.original_name
        )));
    }
    item_view(&training, item)
}

#[tauri::command]
pub fn training_item_delete(id: String, training: State<'_, Training>) -> Result<()> {
    let item = db::get_item(&training.conn(), &id)?;
    db::delete_item(&training.conn(), &id)?;
    let _ = fs::remove_file(training.original_path(&item)?);
    let _ = fs::remove_file(training.thumb_path(&item)?);
    Ok(())
}

/// A reduced copy of a photo, with no metadata, for a captioning service
/// the user chose to send it to.
#[tauri::command]
pub fn training_caption_image(
    id: String,
    training: State<'_, Training>,
) -> Result<tauri::ipc::Response> {
    let item = db::get_item(&training.conn(), &id)?;
    let bytes = fs::read(training.original_path(&item)?)?;
    Ok(tauri::ipc::Response::new(dataset::caption_copy(
        &bytes,
        item.crop.as_ref(),
    )?))
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

fn secret(connection_id: &str, field: &str) -> Result<Option<String>> {
    secrets::read(&format!("connection:{connection_id}:{field}"))
}

fn target(training: &Training, spec: &HostSpec) -> Result<ssh::Target> {
    let host = spec.host.trim();
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err(Error::msg("Set the host's address."));
    }
    if spec.user.trim().is_empty() {
        return Err(Error::msg("Set the SSH user."));
    }
    let private_key = match &spec.private_key {
        Some(key) if !key.trim().is_empty() => key.clone(),
        _ => secret(&spec.connection_id, "privateKey")?
            .ok_or_else(|| Error::msg("Add the SSH private key to this connection."))?,
    };
    let passphrase = match &spec.passphrase {
        Some(p) if !p.is_empty() => Some(p.clone()),
        _ => secret(&spec.connection_id, "passphrase")?.filter(|p| !p.is_empty()),
    };
    Ok(ssh::Target {
        host: host.to_owned(),
        port: spec.port,
        user: spec.user.trim().to_owned(),
        private_key,
        passphrase,
        known_hosts: training.root.join("known_hosts"),
    })
}

struct Host {
    session: ssh::Session,
    layout: Layout,
}

const CALL_TIMEOUT: Duration = Duration::from_secs(60);

impl Host {
    async fn open(training: &Training, spec: &HostSpec) -> Result<Self> {
        let layout = Layout::new(spec)?;
        let session = ssh::Session::connect(&target(training, spec)?).await?;
        let host = Self { session, layout };
        host.deploy(training, &spec.host).await?;
        Ok(host)
    }

    /// Puts this version's runner on the host, once per app session.
    async fn deploy(&self, training: &Training, host: &str) -> Result<()> {
        let key = format!(
            "{host}:{}:{}",
            self.layout.workspace,
            remote::RUNNER_VERSION
        );
        if training.deployed.lock().unwrap().contains(&key) {
            return Ok(());
        }
        let sftp = self.session.sftp().await?;
        ssh::make_dirs(&sftp, &self.layout.runner_dir()).await?;
        for (path, source) in [
            (self.layout.runner(), remote::RUNNER_SOURCE),
            (self.layout.validator(), remote::VALIDATE_SOURCE),
        ] {
            let current = ssh::read_small(&sftp, &path, 1 << 20).await.ok();
            if current.as_deref() != Some(source.as_bytes()) {
                ssh::write_small(&sftp, &path, source.as_bytes()).await?;
            }
        }
        training.deployed.lock().unwrap().insert(key);
        Ok(())
    }

    async fn call(&self, command: Command, job: Option<&str>, request: &Value) -> Result<Value> {
        let line = self.layout.command(command, job)?;
        let stdin = if request.is_null() {
            Vec::new()
        } else {
            serde_json::to_vec(request)?
        };
        let timeout = if command == Command::Preflight {
            Duration::from_secs(240)
        } else {
            CALL_TIMEOUT
        };
        let out = self.session.exec(&line, &stdin, timeout).await?;
        remote::parse_reply(&out.stdout, &out.stderr)
    }

    async fn close(self) {
        self.session.close().await;
    }
}

#[tauri::command]
pub async fn training_host_test(spec: HostSpec, training: State<'_, Training>) -> Result<Value> {
    let host = Host::open(&training, &spec).await?;
    let result = host.call(Command::Version, None, &Value::Null).await;
    host.close().await;
    result
}

/// Records a host key the user compared and approved, by its fingerprint.
#[tauri::command]
pub async fn training_host_trust(
    spec: HostSpec,
    fingerprint: String,
    training: State<'_, Training>,
) -> Result<()> {
    ssh::Session::trust(&target(&training, &spec)?, &fingerprint).await
}

#[tauri::command]
pub async fn training_host_preflight(
    spec: HostSpec,
    base_model: String,
    training: State<'_, Training>,
) -> Result<Value> {
    let host = Host::open(&training, &spec).await?;
    let request = json!({"model": {"repo": base_model}, "loraDir": spec.lora_dir.as_deref().filter(|d| !d.is_empty())});
    let result = host.call(Command::Preflight, None, &request).await;
    host.close().await;
    result
}

/// Starts environment setup on the host: an isolated virtual environment,
/// the pinned trainer, and the base model if asked. It runs detached.
#[tauri::command]
pub async fn training_host_setup(
    spec: HostSpec,
    base_model: Option<String>,
    training: State<'_, Training>,
) -> Result<Value> {
    if let Some(model) = &base_model
        && !remote::BASE_MODELS.contains(&model.as_str())
    {
        return Err(Error::msg("unsupported base model"));
    }
    let token = secret(&spec.connection_id, "hfToken")?.filter(|t| !t.is_empty());
    let host = Host::open(&training, &spec).await?;
    let request = json!({
        "model": base_model.map(|repo| json!({"repo": repo, "revision": "main"})),
        "hfToken": token,
    });
    let result = host.call(Command::Setup, None, &request).await;
    host.close().await;
    result
}

#[tauri::command]
pub async fn training_host_setup_status(
    spec: HostSpec,
    training: State<'_, Training>,
) -> Result<Value> {
    let host = Host::open(&training, &spec).await?;
    let result = host.call(Command::SetupStatus, None, &Value::Null).await;
    host.close().await;
    result.map(|mut v| {
        if let Some(log) = v["logTail"].as_str() {
            v["logTail"] = Value::String(remote::redact(log));
        }
        v
    })
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    #[serde(flatten)]
    run: Run,
    /// Local copies of validation images, keyed by their file on the host.
    validation_files: Value,
}

fn run_view(training: &Training, run: Run) -> Result<RunView> {
    let dir = training
        .run_dir(&run.project_id, &run.id)?
        .join("validation");
    let mut files = serde_json::Map::new();
    if let Some(images) = run
        .remote
        .as_ref()
        .and_then(|r| r["validation"]["images"].as_array())
    {
        for image in images {
            if let Some(file) = image["file"].as_str()
                && valid_validation_file(file)
            {
                let local = dir.join(file);
                if local.is_file() {
                    files.insert(file.to_owned(), Value::String(path_string(&local)));
                }
            }
        }
    }
    Ok(RunView {
        run,
        validation_files: Value::Object(files),
    })
}

/// Validation images are `<label>/<prompt>-<seed>.png`, label "base" or a step.
fn valid_validation_file(file: &str) -> bool {
    let Some((label, name)) = file.split_once('/') else {
        return false;
    };
    (label == "base" || (!label.is_empty() && label.chars().all(|c| c.is_ascii_digit())))
        && name.ends_with(".png")
        && name[..name.len() - 4]
            .split_once('-')
            .is_some_and(|(a, b)| {
                !a.is_empty()
                    && !b.is_empty()
                    && a.chars().all(|c| c.is_ascii_digit())
                    && b.chars().all(|c| c.is_ascii_digit())
            })
}

#[tauri::command]
pub fn training_runs(project_id: String, training: State<'_, Training>) -> Result<Vec<RunView>> {
    let runs = db::list_runs(&training.conn(), &project_id)?;
    runs.into_iter()
        .map(|run| run_view(&training, run))
        .collect()
}

/// Records a run: the included photos are converted for training into the
/// run's own folder, and the snapshot of what it trains on is fixed.
#[tauri::command]
pub async fn training_run_create(
    project_id: String,
    spec: HostSpec,
    base_revision: Option<String>,
    training: State<'_, Training>,
) -> Result<RunView> {
    let layout = Layout::new(&spec)?;
    let (project, items) = {
        let conn = training.conn();
        (
            db::get_project(&conn, &project_id)?,
            db::list_items(&conn, &project_id)?,
        )
    };
    let config: TrainConfig = serde_json::from_value(project.config.clone())
        .map_err(|err| Error::msg(format!("The project's settings are incomplete: {err}")))?;
    config.check()?;
    let included: Vec<Item> = items
        .into_iter()
        .filter(|i| i.included && i.decode_error.is_none())
        .collect();
    if included.is_empty() {
        return Err(Error::msg("Include at least one photo."));
    }

    let run_id = uuid::Uuid::new_v4().to_string();
    let run_dir = training.run_dir(&project_id, &run_id)?;
    let data_dir = run_dir.join("dataset");
    fs::create_dir_all(&data_dir)?;
    let mut snapshot_items = Vec::new();
    for (index, item) in included.iter().enumerate() {
        let original = fs::read(training.original_path(item)?)?;
        if dataset::sha256_hex(&original) != item.sha256 {
            let _ = fs::remove_dir_all(&run_dir);
            return Err(Error::msg(format!(
                "The stored copy of {} has changed on disk. Remove and re-import it.",
                item.original_name
            )));
        }
        let (bytes, width, height) = dataset::convert_for_training(&original, item.crop.as_ref())?;
        let name = remote::training_file_name(index);
        fs::write(data_dir.join(&name), &bytes)?;
        snapshot_items.push(SnapshotItem {
            item_id: item.id.clone(),
            name,
            original_sha256: item.sha256.clone(),
            sha256: dataset::sha256_hex(&bytes),
            caption: item.caption.trim().to_owned(),
            category: item.category.clone(),
            crop: item.crop.clone(),
            width,
            height,
        });
    }
    let revision = base_revision.filter(|r| {
        !r.is_empty()
            && r.chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c))
    });
    let snapshot = Snapshot {
        trainer: remote::TRAINER_ID.into(),
        trainer_version: remote::TRAINER_VERSION.into(),
        family: project.family.clone(),
        base_model: project.base_model.clone(),
        base_revision: revision.unwrap_or_else(|| "main".into()),
        trigger_token: project.trigger_token.clone(),
        instance_prompt: format!("photo of {} person", project.trigger_token),
        conversion: dataset::CONVERSION.into(),
        dataset_hash: remote::dataset_hash(&snapshot_items),
        config,
        items: snapshot_items,
    };
    // Checked now, so a run that could never be uploaded is not recorded.
    remote::build_request(&run_id, &snapshot)?;
    let now = now_ms();
    let run = Run {
        id: run_id.clone(),
        project_id: project_id.clone(),
        created_at: now,
        host_id: spec.connection_id.clone(),
        host_label: spec.label.clone(),
        dataset_hash: snapshot.dataset_hash.clone(),
        snapshot: serde_json::to_value(&snapshot)?,
        remote_dir: layout.job(&run_id)?,
        state: "draft".into(),
        remote: None,
        connection: "unchecked".into(),
        connection_error: None,
        checked_at: None,
        updated_at: now,
    };
    db::insert_run(&training.conn(), &run)?;
    run_view(&training, run)
}

fn load_run(training: &Training, run_id: &str, spec: &HostSpec) -> Result<(Run, Snapshot)> {
    let run = db::get_run(&training.conn(), run_id)?;
    if run.host_id != spec.connection_id {
        return Err(Error::msg(format!(
            "This run belongs to {}. Select that host.",
            run.host_label
        )));
    }
    let snapshot: Snapshot = serde_json::from_value(run.snapshot.clone())?;
    Ok((run, snapshot))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferProgress<'a> {
    run_id: &'a str,
    phase: &'a str,
    done: u64,
    total: u64,
}

/// Uploads a run's dataset and request, continuing an interrupted upload,
/// and checks every file's hash on the host before calling it uploaded.
#[tauri::command]
pub async fn training_run_upload(
    app: AppHandle,
    run_id: String,
    spec: HostSpec,
    training: State<'_, Training>,
) -> Result<RunView> {
    let (run, snapshot) = load_run(&training, &run_id, &spec)?;
    if !["draft", "uploading", "uploaded"].contains(&run.state.as_str()) {
        return Err(Error::msg("This run was already started on the host."));
    }
    let local = training.run_dir(&run.project_id, &run.id)?.join("dataset");
    let request = remote::build_request(&run.id, &snapshot)?;
    db::set_local_state(&training.conn(), &run.id, "uploading", now_ms())?;

    let result = async {
        let host = Host::open(&training, &spec).await?;
        let job = host.layout.job(&run.id)?;
        let sftp = host.session.sftp().await?;
        ssh::make_dirs(&sftp, &format!("{job}/dataset")).await?;
        let total: u64 = snapshot
            .items
            .iter()
            .map(|i| {
                fs::metadata(local.join(&i.name))
                    .map(|m| m.len())
                    .unwrap_or(0)
            })
            .sum();
        let mut before = 0;
        for attempt in 0..2 {
            for item in &snapshot.items {
                let path = local.join(&item.name);
                let len = fs::metadata(&path)?.len();
                let remote_path = format!("{job}/dataset/{}", item.name);
                ssh::upload(&sftp, &path, &remote_path, |done| {
                    let _ = app.emit(
                        "training-progress",
                        TransferProgress {
                            run_id: &run.id,
                            phase: "upload",
                            done: before + done,
                            total,
                        },
                    );
                })
                .await?;
                before += len;
            }
            let hashes = host
                .call(Command::DatasetHashes, Some(&run.id), &Value::Null)
                .await?;
            let bad: Vec<&SnapshotItem> = snapshot
                .items
                .iter()
                .filter(|i| hashes["hashes"][&i.name].as_str() != Some(i.sha256.as_str()))
                .collect();
            if bad.is_empty() {
                break;
            }
            if attempt == 1 {
                return Err(Error::msg(format!(
                    "{} file(s) did not arrive intact on the host. Try the upload again.",
                    bad.len()
                )));
            }
            // A damaged copy is removed and sent again from the start.
            for item in bad {
                ssh::remove_if_exists(&sftp, &format!("{job}/dataset/{}", item.name)).await;
            }
            before = 0;
        }
        ssh::write_small(
            &sftp,
            &format!("{job}/request.json"),
            &serde_json::to_vec_pretty(&request)?,
        )
        .await?;
        let report = host
            .call(Command::Status, Some(&run.id), &Value::Null)
            .await?;
        host.close().await;
        Ok::<Value, Error>(report)
    }
    .await;

    match result {
        Ok(report) => {
            db::set_run_state(
                &training.conn(),
                &run.id,
                &remote::state_from_report(&report),
                Some(&redact_report(report)),
                now_ms(),
            )?;
        }
        Err(err) => {
            // Left as uploading: the next attempt continues the upload.
            db::set_run_unreachable(&training.conn(), &run.id, &err.to_string(), now_ms())?;
            return Err(err);
        }
    }
    run_view(&training, db::get_run(&training.conn(), &run.id)?)
}

fn redact_report(mut report: Value) -> Value {
    if let Some(log) = report["logTail"].as_str() {
        report["logTail"] = Value::String(remote::redact(log));
    }
    report
}

/// Calls the runner for a run and records what it reported. A failure to
/// reach the host is recorded as such and leaves the run's state alone.
async fn run_call(
    training: &Training,
    run_id: &str,
    spec: &HostSpec,
    command: Command,
) -> Result<RunView> {
    let (run, _) = load_run(training, run_id, spec)?;
    let outcome = async {
        let host = Host::open(training, spec).await?;
        let report = host.call(command, Some(&run.id), &Value::Null).await;
        let report = match (command, report) {
            (Command::Status, r) => r?,
            // After an action, read the full status the same way a check does.
            (_, Ok(_)) => {
                host.call(Command::Status, Some(&run.id), &Value::Null)
                    .await?
            }
            (_, Err(err)) => {
                host.close().await;
                return Err(err);
            }
        };
        let fetched = fetch_validation(training, &host, &run, &report).await;
        host.close().await;
        if let Err(err) = fetched {
            log::warn!("could not fetch validation images: {err}");
        }
        Ok::<Value, Error>(report)
    }
    .await;
    match outcome {
        Ok(report) => {
            db::set_run_state(
                &training.conn(),
                &run.id,
                &remote::state_from_report(&report),
                Some(&redact_report(report)),
                now_ms(),
            )?;
        }
        Err(err) => {
            let text = err.to_string();
            // Only transport failures mean "unknown"; a runner refusal (such
            // as "already running") is the answer itself.
            if command == Command::Status
                || text.contains("connect")
                || text.contains("SSH")
                || text.contains("in time")
            {
                db::set_run_unreachable(&training.conn(), &run.id, &text, now_ms())?;
            }
            return Err(err);
        }
    }
    run_view(training, db::get_run(&training.conn(), &run.id)?)
}

/// Copies validation images the host has made and this machine lacks.
async fn fetch_validation(
    training: &Training,
    host: &Host,
    run: &Run,
    report: &Value,
) -> Result<()> {
    let Some(images) = report["validation"]["images"].as_array() else {
        return Ok(());
    };
    let dir = training
        .run_dir(&run.project_id, &run.id)?
        .join("validation");
    let job = host.layout.job(&run.id)?;
    let mut sftp = None;
    for image in images {
        let Some(file) = image["file"].as_str().filter(|f| valid_validation_file(f)) else {
            continue;
        };
        let local = dir.join(file);
        if local.is_file() {
            continue;
        }
        if sftp.is_none() {
            sftp = Some(host.session.sftp().await?);
        }
        let bytes = ssh::read_small(
            sftp.as_ref().unwrap(),
            &format!("{job}/validation/{file}"),
            64 << 20,
        )
        .await?;
        if image::guess_format(&bytes).ok() != Some(image::ImageFormat::Png) {
            continue;
        }
        if let Some(parent) = local.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&local, bytes)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn training_run_start(
    run_id: String,
    spec: HostSpec,
    training: State<'_, Training>,
) -> Result<RunView> {
    let run = db::get_run(&training.conn(), &run_id)?;
    if run.state != "uploaded" {
        return Err(Error::msg("Upload the run before starting it."));
    }
    run_call(&training, &run_id, &spec, Command::Start).await
}

#[tauri::command]
pub async fn training_run_resume(
    run_id: String,
    spec: HostSpec,
    training: State<'_, Training>,
) -> Result<RunView> {
    run_call(&training, &run_id, &spec, Command::Resume).await
}

#[tauri::command]
pub async fn training_run_status(
    run_id: String,
    spec: HostSpec,
    training: State<'_, Training>,
) -> Result<RunView> {
    run_call(&training, &run_id, &spec, Command::Status).await
}

#[tauri::command]
pub async fn training_run_cancel(
    run_id: String,
    spec: HostSpec,
    training: State<'_, Training>,
) -> Result<RunView> {
    run_call(&training, &run_id, &spec, Command::Cancel).await
}

/// Deletes this run's job folder on the host (only that folder; the runner
/// refuses while it runs). Registered LoRAs stay.
#[tauri::command]
pub async fn training_run_cleanup_remote(
    run_id: String,
    spec: HostSpec,
    training: State<'_, Training>,
) -> Result<RunView> {
    let (run, _) = load_run(&training, &run_id, &spec)?;
    let host = Host::open(&training, &spec).await?;
    let result = host
        .call(Command::Cleanup, Some(&run.id), &Value::Null)
        .await;
    host.close().await;
    result?;
    db::set_run_state(&training.conn(), &run.id, "removed", None, now_ms())?;
    run_view(&training, db::get_run(&training.conn(), &run.id)?)
}

/// States in which a run may be using its host.
const ACTIVE_STATES: [&str; 6] = [
    "queued",
    "preparing",
    "training",
    "saving",
    "validating",
    "unknown",
];

/// Forgets a run on this machine. A run that may still be training on its
/// host is kept, so its job is never orphaned unknowingly.
#[tauri::command]
pub fn training_run_delete(run_id: String, training: State<'_, Training>) -> Result<()> {
    let run = db::get_run(&training.conn(), &run_id)?;
    let settled = [
        "draft",
        "uploading",
        "uploaded",
        "completed",
        "failed",
        "cancelled",
        "missing",
        "removed",
    ];
    if !settled.contains(&run.state.as_str()) {
        return Err(Error::msg(
            "This run may still be running on its host. Cancel it, or check its status, first.",
        ));
    }
    db::delete_run(&training.conn(), &run_id)?;
    let dir = training.run_dir(&run.project_id, &run.id)?;
    if dir.is_dir() {
        fs::remove_dir_all(dir)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/// Downloads one checkpoint's LoRA, confirms it against the host's hash and
/// checks it really is a Qwen-Image 2.1 transformer LoRA, then records it
/// with everything needed to know where it came from.
#[tauri::command]
pub async fn training_artifact_register(
    app: AppHandle,
    run_id: String,
    step: i64,
    spec: HostSpec,
    training: State<'_, Training>,
) -> Result<Artifact> {
    let (run, snapshot) = load_run(&training, &run_id, &spec)?;
    let project = db::get_project(&training.conn(), &run.project_id)?;
    let checkpoint = run
        .remote
        .as_ref()
        .and_then(|r| r["checkpoints"].as_array())
        .and_then(|list| {
            list.iter()
                .find(|c| c["step"].as_i64() == Some(step))
                .cloned()
        })
        .ok_or_else(|| {
            Error::msg(format!(
                "The run has no LoRA at step {step}. Check its status first."
            ))
        })?;

    let host = Host::open(&training, &spec).await?;
    let info = host
        .call(Command::LoraHash, Some(&run.id), &json!({"step": step}))
        .await?;
    let remote_path = info["path"].as_str().unwrap_or_default().to_owned();
    let job = host.layout.job(&run.id)?;
    if !remote_path.starts_with(&format!("{job}/output/")) {
        host.close().await;
        return Err(Error::msg(
            "The host named an unexpected file for this LoRA.",
        ));
    }
    let expected = info["sha256"].as_str().unwrap_or_default().to_owned();
    let size = info["size"].as_i64().unwrap_or(0);

    let artifact_id = uuid::Uuid::new_v4().to_string();
    let local = training
        .root
        .join("artifacts")
        .join(format!("{artifact_id}.safetensors"));
    let sftp = host.session.sftp().await?;
    let got = ssh::download(&sftp, &remote_path, &local, |done| {
        let _ = app.emit(
            "training-progress",
            TransferProgress {
                run_id: &run.id,
                phase: "download",
                done,
                total: size as u64,
            },
        );
    })
    .await;
    host.close().await;
    let got = got?;
    if got != expected {
        let _ = fs::remove_file(&local);
        return Err(Error::msg(
            "The downloaded LoRA does not match the host's copy. Try again.",
        ));
    }
    let header = read_header(&local)?;
    let check = match remote::check_lora_header(&header) {
        Ok(check) => check,
        Err(err) => {
            let _ = fs::remove_file(&local);
            return Err(err);
        }
    };

    let report = run.remote.clone().unwrap_or(Value::Null);
    let validation: Vec<Value> = report["validation"]["images"]
        .as_array()
        .map(|images| {
            images
                .iter()
                .filter(|i| i["step"].as_i64() == Some(step) || i["label"] == "base")
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let manifest = json!({
        "format": "imagegen-lora-manifest/1",
        "name": project.name,
        "family": snapshot.family,
        "baseModel": snapshot.base_model,
        "baseRevision": report["modelRevision"].as_str().unwrap_or(&snapshot.base_revision),
        "trainer": snapshot.trainer,
        "trainerVersion": snapshot.trainer_version,
        "triggerToken": snapshot.trigger_token,
        "instancePrompt": snapshot.instance_prompt,
        "settings": snapshot.config,
        "datasetHash": snapshot.dataset_hash,
        "datasetSize": snapshot.items.len(),
        "conversion": snapshot.conversion,
        "runId": run.id,
        "step": step,
        "checkpointKind": checkpoint["kind"],
        "file": {"sha256": got, "size": size, "tensors": check.tensors, "rank": check.rank},
        "format_note": "PEFT LoRA in Diffusers naming (transformer.*), as saved by QwenImage21Pipeline.save_lora_weights",
        "validation": validation,
    });
    let artifact = Artifact {
        id: artifact_id.clone(),
        project_id: run.project_id.clone(),
        run_id: run.id.clone(),
        step,
        family: snapshot.family.clone(),
        base_model: snapshot.base_model.clone(),
        trainer: snapshot.trainer.clone(),
        trigger_token: snapshot.trigger_token.clone(),
        dataset_hash: snapshot.dataset_hash.clone(),
        file_name: format!("{artifact_id}.safetensors"),
        size,
        sha256: got,
        manifest,
        installs: json!([]),
        created_at: now_ms(),
    };
    if let Err(err) = db::insert_artifact(&training.conn(), &artifact) {
        let _ = fs::remove_file(&local);
        return Err(err);
    }
    Ok(artifact)
}

fn read_header(path: &Path) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut len = [0u8; 8];
    file.read_exact(&mut len)?;
    let n = u64::from_le_bytes(len).min(100 << 20) as usize;
    let mut out = len.to_vec();
    out.resize(8 + n, 0);
    file.read_exact(&mut out[8..])?;
    Ok(out)
}

#[tauri::command]
pub fn training_artifacts(
    project_id: Option<String>,
    training: State<'_, Training>,
) -> Result<Vec<Artifact>> {
    db::list_artifacts(&training.conn(), project_id.as_deref())
}

/// Saves the LoRA where the user chooses, with its manifest next to it.
/// Photographs and credentials are never part of an export.
#[tauri::command]
pub async fn training_artifact_export(
    window: WebviewWindow,
    id: String,
    manifest_only: bool,
    training: State<'_, Training>,
) -> Result<Option<String>> {
    let artifact = db::get_artifact(&training.conn(), &id)?;
    let project = db::get_project(&training.conn(), &artifact.project_id)?;
    let name = remote::lora_file_name(&project.name, artifact.step, &artifact.sha256);
    let stem = name.trim_end_matches(".safetensors").to_owned();
    let manifest = serde_json::to_vec_pretty(&artifact.manifest)?;
    if manifest_only {
        let filter = Some(("Manifest".to_owned(), "json".to_owned()));
        let Some(path) =
            files::ask_save_path(&window, Some(format!("{stem}.json")), filter).await?
        else {
            return Ok(None);
        };
        fs::write(&path, manifest)?;
        return Ok(Some(path_string(&path)));
    }
    let filter = Some(("LoRA".to_owned(), "safetensors".to_owned()));
    let Some(path) = files::ask_save_path(&window, Some(name), filter).await? else {
        return Ok(None);
    };
    fs::copy(training.artifact_path(&artifact), &path)?;
    fs::write(path.with_extension("json"), manifest)?;
    Ok(Some(path_string(&path)))
}

/// Copies the LoRA into ComfyUI's LoRA folder on a host over SFTP and
/// confirms the copy by hash. The folder is the one set on that host's
/// connection; the app never guesses where ComfyUI keeps its models.
#[tauri::command]
pub async fn training_artifact_install(
    app: AppHandle,
    id: String,
    spec: HostSpec,
    training: State<'_, Training>,
) -> Result<Artifact> {
    let artifact = db::get_artifact(&training.conn(), &id)?;
    let project = db::get_project(&training.conn(), &artifact.project_id)?;
    let dir = spec
        .lora_dir
        .as_deref()
        .filter(|d| !d.trim().is_empty())
        .ok_or_else(|| Error::msg("Set ComfyUI's LoRA folder on this host's connection first."))?;
    let dir = remote::check_remote_path(dir, "ComfyUI's LoRA folder")?;
    let name = remote::lora_file_name(&project.name, artifact.step, &artifact.sha256);
    let local = training.artifact_path(&artifact);
    if dataset::sha256_hex(&fs::read(&local)?) != artifact.sha256 {
        return Err(Error::msg(
            "The local copy of this LoRA has changed. Register it again.",
        ));
    }

    let host = Host::open(&training, &spec).await?;
    let result = async {
        let sftp = host.session.sftp().await?;
        if !sftp.try_exists(dir.clone()).await.unwrap_or(false) {
            return Err(Error::msg(format!(
                "{dir} does not exist on {}. Check ComfyUI's LoRA folder setting.",
                spec.label
            )));
        }
        let remote_path = format!("{dir}/{name}");
        let total = artifact.size as u64;
        ssh::upload(&sftp, &local, &remote_path, |done| {
            let _ = app.emit(
                "training-progress",
                TransferProgress {
                    run_id: &artifact.run_id,
                    phase: "install",
                    done,
                    total,
                },
            );
        })
        .await?;
        let check = host
            .call(Command::FileHash, None, &json!({"dir": dir, "name": name}))
            .await?;
        if check["sha256"].as_str() != Some(artifact.sha256.as_str()) {
            ssh::remove_if_exists(&sftp, &remote_path).await;
            return Err(Error::msg("The installed copy does not match. Try again."));
        }
        Ok(())
    }
    .await;
    host.close().await;
    result?;

    let mut installs: Vec<Value> = artifact.installs.as_array().cloned().unwrap_or_default();
    installs.retain(|i| i["hostId"] != spec.connection_id.as_str());
    installs.push(json!({"hostId": spec.connection_id, "hostLabel": spec.label, "dir": dir, "fileName": name, "at": now_ms()}));
    let installs = Value::Array(installs);
    db::set_artifact_installs(&training.conn(), &id, &installs)?;
    db::get_artifact(&training.conn(), &id)
}

#[tauri::command]
pub fn training_artifact_delete(id: String, training: State<'_, Training>) -> Result<()> {
    let artifact = db::get_artifact(&training.conn(), &id)?;
    db::delete_artifact(&training.conn(), &id)?;
    let _ = fs::remove_file(training.artifact_path(&artifact));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_file_names() {
        assert!(valid_validation_file("base/0-1.png"));
        assert!(valid_validation_file("400/2-12345.png"));
        for bad in [
            "../0-1.png",
            "400/../../x.png",
            "400/0-1.jpg",
            "a/0-1.png",
            "400/x-1.png",
            "400/0-1.png/..",
            "400",
        ] {
            assert!(!valid_validation_file(bad), "{bad}");
        }
    }

    #[test]
    fn decodes_dropped_names() {
        assert_eq!(percent_decode("IMG%20001.jpg"), "IMG 001.jpg");
        assert_eq!(percent_decode("%E5%86%99%E7%9C%9F.png"), "写真.png");
        assert_eq!(percent_decode("100%.png"), "100%.png");
    }

    fn input(token: &str) -> ProjectInput {
        ProjectInput {
            name: "Me".into(),
            objective: "identity".into(),
            trigger_token: token.into(),
            family: remote::FAMILY.into(),
            base_model: remote::BASE_MODELS[0].into(),
            config: serde_json::from_value(json!({
                "resolution": 1024, "buckets": true, "rank": 16, "alpha": 16, "learningRate": 1e-4,
                "batchSize": 1, "gradAccum": 4, "maxSteps": 500, "seed": 0, "precision": "bf16",
                "use8bitAdam": true, "gradientCheckpointing": true, "cacheLatents": true, "offload": false,
                "quantize4bit": false, "lrScheduler": "constant", "warmupSteps": 0, "checkpointSteps": 100,
                "randomFlip": false, "captionDropout": 0.0, "validationPrompts": ["photo of ohwx person"],
                "validationSeeds": [1], "validationEvery": 100, "validationSteps": 40, "validationIncludeBase": true
            }))
            .unwrap(),
        }
    }

    #[test]
    fn project_inputs() {
        assert!(check_project_input(&input("ohwx")).is_ok());
        for bad in [
            "",
            "ab",
            "my token",
            "1234",
            "tok;en",
            "x".repeat(30).as_str(),
        ] {
            assert!(check_project_input(&input(bad)).is_err(), "{bad}");
        }
        let mut other = input("ohwx");
        other.family = "sdxl".into();
        other.base_model = "stabilityai/stable-diffusion-xl-base-1.0".into();
        assert!(
            check_project_input(&other)
                .unwrap_err()
                .to_string()
                .contains("cannot be trained here")
        );
    }
}
