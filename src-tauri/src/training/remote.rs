//! The protocol with the runner on a training host: where things live, the
//! one command line the app ever sends, and the requests it uploads.
//!
//! The command is built only from values that are checked to be plain path
//! characters (the workspace and interpreter the user configured), a fixed
//! command name and a job UUID. Everything else (captions, prompts, settings)
//! travels as JSON on stdin or in an uploaded file.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{Error, Result};

/// The runner files the app installs, embedded at build time.
pub const RUNNER_VERSION: u32 = 1;
pub const RUNNER_SOURCE: &str = include_str!("../../runner/imagegen_train_runner.py");
pub const VALIDATE_SOURCE: &str = include_str!("../../runner/imagegen_train_validate.py");

pub const TRAINER_ID: &str = "diffusers-qwenimage21";
pub const TRAINER_VERSION: &str = "diffusers-0.42.1";
pub const FAMILY: &str = "qwen-image-2.1";
pub const BASE_MODELS: [&str; 1] = ["Qwen/Qwen-Image-2.1"];

/// A training host as configured in Connections.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostSpec {
    pub connection_id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Where the app keeps everything on the host, e.g. /workspace/imagegen-train.
    pub workspace: String,
    /// Interpreter that runs the runner (not the training environment).
    pub python: String,
    /// ComfyUI's LoRA folder on this host, if LoRAs are installed there.
    #[serde(default)]
    pub lora_dir: Option<String>,
    /// Only while testing a connection that is not saved yet.
    #[serde(default)]
    pub private_key: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
}

fn plain_path_chars(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
}

/// An absolute host path the app may put in a command: plain characters,
/// no `..`, and not the root itself.
pub fn check_remote_path(path: &str, what: &str) -> Result<String> {
    let trimmed = path.trim_end_matches('/');
    let ok = trimmed.starts_with('/')
        && trimmed.len() > 1
        && plain_path_chars(trimmed)
        && !trimmed.split('/').any(|part| part == ".." || part == ".");
    if !ok {
        return Err(Error::msg(format!(
            "{what} must be an absolute path using only letters, digits, '.', '_', '-' and '/', such as /workspace/imagegen-train."
        )));
    }
    Ok(trimmed.to_owned())
}

pub fn check_python(python: &str) -> Result<String> {
    let python = python.trim();
    if python.is_empty() {
        return Ok("python3".into());
    }
    if python.starts_with('/') {
        return check_remote_path(python, "The Python interpreter");
    }
    if python
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Ok(python.into());
    }
    Err(Error::msg(
        "The Python interpreter must be a command name such as python3, or an absolute path.",
    ))
}

pub fn check_job_id(id: &str) -> Result<()> {
    match uuid::Uuid::try_parse(id) {
        Ok(u) if u.hyphenated().to_string() == id => Ok(()),
        _ => Err(Error::msg("bad run id")),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Command {
    Version,
    Preflight,
    Setup,
    SetupStatus,
    Status,
    Start,
    Resume,
    Cancel,
    Cleanup,
    DatasetHashes,
    LoraHash,
    FileHash,
}

impl Command {
    fn name(self) -> &'static str {
        match self {
            Self::Version => "version",
            Self::Preflight => "preflight",
            Self::Setup => "setup",
            Self::SetupStatus => "setup-status",
            Self::Status => "status",
            Self::Start => "start",
            Self::Resume => "resume",
            Self::Cancel => "cancel",
            Self::Cleanup => "cleanup",
            Self::DatasetHashes => "dataset-hashes",
            Self::LoraHash => "lora-hash",
            Self::FileHash => "file-hash",
        }
    }

    fn takes_job(self) -> bool {
        matches!(
            self,
            Self::Status
                | Self::Start
                | Self::Resume
                | Self::Cancel
                | Self::Cleanup
                | Self::DatasetHashes
                | Self::LoraHash
        )
    }
}

/// Paths on one host, from its checked workspace.
#[derive(Clone, Debug)]
pub struct Layout {
    pub workspace: String,
    pub python: String,
}

impl Layout {
    pub fn new(spec: &HostSpec) -> Result<Self> {
        Ok(Self {
            workspace: check_remote_path(&spec.workspace, "The workspace")?,
            python: check_python(&spec.python)?,
        })
    }

    pub fn runner_dir(&self) -> String {
        format!("{}/runner", self.workspace)
    }

    pub fn runner(&self) -> String {
        format!("{}/runner-{RUNNER_VERSION}.py", self.runner_dir())
    }

    pub fn validator(&self) -> String {
        format!("{}/validate-{RUNNER_VERSION}.py", self.runner_dir())
    }

    pub fn job(&self, job_id: &str) -> Result<String> {
        check_job_id(job_id)?;
        Ok(format!("{}/jobs/{job_id}", self.workspace))
    }

    /// The command line for one runner call. Its parts are all checked
    /// tokens, so the remote shell sees them exactly as written.
    pub fn command(&self, command: Command, job_id: Option<&str>) -> Result<String> {
        let mut line = format!("{} {} {}", self.python, self.runner(), command.name());
        match (command.takes_job(), job_id) {
            (true, Some(id)) => {
                check_job_id(id)?;
                line.push(' ');
                line.push_str(id);
            }
            (false, None) => {}
            _ => return Err(Error::msg("internal: wrong arguments for the runner")),
        }
        Ok(line)
    }
}

/// The runner's answer: `{"ok": true, "result": ...}` or `{"ok": false, "error": ...}`.
pub fn parse_reply(stdout: &[u8], stderr: &[u8]) -> Result<Value> {
    let text = String::from_utf8_lossy(stdout);
    let line = text.lines().rev().find(|l| l.trim_start().starts_with('{'));
    let Some(line) = line else {
        let err = String::from_utf8_lossy(stderr);
        let err = err.trim();
        return Err(Error::msg(
            if err.contains("No such file") || err.contains("not found") {
                format!(
                    "The runner could not start on the host ({}). Check the Python interpreter setting.",
                    redact(err)
                )
            } else if err.is_empty() {
                "The runner gave no answer.".to_owned()
            } else {
                format!(
                    "The runner failed: {}",
                    redact(&err.chars().take(800).collect::<String>())
                )
            },
        ));
    };
    let reply: Value = serde_json::from_str(line)
        .map_err(|_| Error::msg("The runner's answer could not be read."))?;
    if reply["ok"] == Value::Bool(true) {
        Ok(reply["result"].clone())
    } else {
        Err(Error::msg(
            reply["error"]
                .as_str()
                .unwrap_or("The runner reported an error.")
                .to_owned(),
        ))
    }
}

/// Hides tokens and keys in text bound for the UI or the database.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("hf_") {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 3..];
        let len = tail
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .count();
        if len >= 20 {
            out.push_str("hf_***");
            rest = &tail[len..];
        } else {
            out.push_str("hf_");
            rest = tail;
        }
    }
    out.push_str(rest);
    if let Some(start) = out.find("-----BEGIN")
        && out[start..].contains("PRIVATE KEY")
    {
        out.truncate(start);
        out.push_str("[private key removed]");
    }
    out
}

// ---------------------------------------------------------------------------
// Training configuration
// ---------------------------------------------------------------------------

/// The settings a project trains with. The webview offers them; they are
/// checked here again before a run is recorded or uploaded.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrainConfig {
    pub resolution: u32,
    pub buckets: bool,
    pub rank: u32,
    pub alpha: u32,
    pub learning_rate: f64,
    pub batch_size: u32,
    pub grad_accum: u32,
    pub max_steps: u32,
    pub seed: u32,
    pub precision: String,
    pub use8bit_adam: bool,
    pub gradient_checkpointing: bool,
    pub cache_latents: bool,
    pub offload: bool,
    pub quantize4bit: bool,
    pub lr_scheduler: String,
    pub warmup_steps: u32,
    pub checkpoint_steps: u32,
    pub random_flip: bool,
    pub caption_dropout: f64,
    #[serde(default)]
    pub lora_layers: Option<String>,
    pub validation_prompts: Vec<String>,
    pub validation_seeds: Vec<u32>,
    pub validation_every: u32,
    pub validation_steps: u32,
    pub validation_include_base: bool,
}

fn range<T: PartialOrd + std::fmt::Display>(value: T, lo: T, hi: T, what: &str) -> Result<()> {
    if value < lo || value > hi {
        return Err(Error::msg(format!("{what} must be between {lo} and {hi}.")));
    }
    Ok(())
}

impl TrainConfig {
    pub fn check(&self) -> Result<()> {
        range(self.resolution, 256, 2048, "Resolution")?;
        if !self.resolution.is_multiple_of(32) {
            return Err(Error::msg(
                "Resolution must be a multiple of 32 for Qwen-Image 2.1.",
            ));
        }
        range(self.rank, 1, 256, "Rank")?;
        range(self.alpha, 1, 512, "Alpha")?;
        if !(self.learning_rate.is_finite() && (1e-7..=1e-2).contains(&self.learning_rate)) {
            return Err(Error::msg("Learning rate must be between 1e-7 and 1e-2."));
        }
        range(self.batch_size, 1, 16, "Batch size")?;
        range(self.grad_accum, 1, 64, "Gradient accumulation")?;
        range(self.max_steps, 1, 100_000, "Steps")?;
        range(
            self.checkpoint_steps,
            1,
            self.max_steps.max(1),
            "The checkpoint interval",
        )?;
        range(self.warmup_steps, 0, 100_000, "Warmup steps")?;
        if !["bf16", "fp16", "no"].contains(&self.precision.as_str()) {
            return Err(Error::msg("Precision must be bf16, fp16 or no."));
        }
        if !["constant", "constant_with_warmup", "linear", "cosine"]
            .contains(&self.lr_scheduler.as_str())
        {
            return Err(Error::msg("Unsupported learning rate schedule."));
        }
        if !(0.0..=1.0).contains(&self.caption_dropout) {
            return Err(Error::msg("Caption dropout must be between 0 and 1."));
        }
        if let Some(layers) = &self.lora_layers
            && !layers.is_empty()
            && !layers.split(',').all(|l| {
                !l.is_empty()
                    && l.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
            })
        {
            return Err(Error::msg(
                "LoRA layers must be a comma-separated list of module names.",
            ));
        }
        if self.validation_prompts.len() > 8
            || self
                .validation_prompts
                .iter()
                .any(|p| p.trim().is_empty() || p.len() > 1000)
        {
            return Err(Error::msg("Use up to 8 non-empty validation prompts."));
        }
        if self.validation_seeds.is_empty()
            || self.validation_seeds.len() > 4
            || self.validation_seeds.iter().any(|&s| s >= 1 << 31)
        {
            return Err(Error::msg("Use 1 to 4 validation seeds."));
        }
        range(self.validation_steps, 1, 100, "Validation sampling steps")?;
        if self.validation_every == 0
            || !self.validation_every.is_multiple_of(self.checkpoint_steps)
        {
            return Err(Error::msg(
                "The validation interval must be a multiple of the checkpoint interval.",
            ));
        }
        Ok(())
    }
}

/// One training image in a run's snapshot.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotItem {
    pub item_id: String,
    /// The training file's name in the run: 0001.png and so on.
    pub name: String,
    pub original_sha256: String,
    pub sha256: String,
    pub caption: String,
    pub category: String,
    pub crop: Option<super::db::Crop>,
    pub width: u32,
    pub height: u32,
}

/// Everything a run trains on, fixed when the run is created.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub trainer: String,
    pub trainer_version: String,
    pub family: String,
    pub base_model: String,
    pub base_revision: String,
    pub trigger_token: String,
    pub instance_prompt: String,
    pub conversion: String,
    pub config: TrainConfig,
    pub items: Vec<SnapshotItem>,
    pub dataset_hash: String,
}

/// The dataset's identity: a hash over each training file's hash and caption,
/// in order. Equal datasets give equal hashes, whatever run they are in.
pub fn dataset_hash(items: &[SnapshotItem]) -> String {
    let mut text = String::new();
    for item in items {
        text.push_str(&item.sha256);
        text.push('\t');
        text.push_str(&serde_json::to_string(&item.caption).unwrap_or_default());
        text.push('\n');
    }
    super::dataset::sha256_hex(text.as_bytes())
}

pub fn training_file_name(index: usize) -> String {
    format!("{:04}.png", index + 1)
}

/// The request.json the runner reads for a run.
pub fn build_request(job_id: &str, snapshot: &Snapshot) -> Result<Value> {
    check_job_id(job_id)?;
    snapshot.config.check()?;
    if snapshot.items.is_empty() {
        return Err(Error::msg("The dataset is empty."));
    }
    let c = &snapshot.config;
    Ok(json!({
        "version": 1,
        "jobId": job_id,
        "trainer": snapshot.trainer,
        "model": {"repo": snapshot.base_model, "revision": snapshot.base_revision},
        "dataset": {
            "files": snapshot.items.iter().map(|i| json!({"name": i.name, "sha256": i.sha256, "caption": i.caption})).collect::<Vec<_>>(),
            "instancePrompt": snapshot.instance_prompt,
        },
        "train": {
            "resolution": c.resolution,
            "buckets": c.buckets,
            "rank": c.rank,
            "alpha": c.alpha,
            "learningRate": c.learning_rate,
            "batchSize": c.batch_size,
            "gradAccum": c.grad_accum,
            "maxSteps": c.max_steps,
            "seed": c.seed,
            "precision": c.precision,
            "use8bitAdam": c.use8bit_adam,
            "gradientCheckpointing": c.gradient_checkpointing,
            "cacheLatents": c.cache_latents,
            "offload": c.offload,
            "quantize4bit": c.quantize4bit,
            "lrScheduler": c.lr_scheduler,
            "warmupSteps": c.warmup_steps,
            "checkpointSteps": c.checkpoint_steps,
            "randomFlip": c.random_flip,
            "captionDropout": c.caption_dropout,
            "loraLayers": c.lora_layers.as_ref().filter(|l| !l.is_empty()),
        },
        "validation": {
            "prompts": c.validation_prompts,
            "seeds": c.validation_seeds,
            "everySteps": c.validation_every,
            "steps": c.validation_steps,
            "includeBase": c.validation_include_base,
        },
    }))
}

/// Run states the host reports, and the app's own before and around them.
pub const HOST_STATES: [&str; 9] = [
    "uploaded",
    "queued",
    "preparing",
    "training",
    "saving",
    "validating",
    "completed",
    "failed",
    "cancelled",
];

/// The app state for a host report. A run the host no longer has is
/// "missing", which is not the same as failed.
pub fn state_from_report(report: &Value) -> String {
    match report["state"].as_str() {
        Some(s) if HOST_STATES.contains(&s) => s.to_owned(),
        Some("missing") => "missing".to_owned(),
        _ => "unknown".to_owned(),
    }
}

// ---------------------------------------------------------------------------
// LoRA files
// ---------------------------------------------------------------------------

/// What a LoRA file's safetensors header says it is for.
#[derive(Debug, PartialEq)]
pub struct LoraCheck {
    pub tensors: usize,
    pub rank: Option<u64>,
}

/// Checks that a file is a PEFT/diffusers LoRA for the Qwen-Image 2.1
/// transformer: a safetensors header whose tensors are all `transformer.`
/// LoRA pairs on its `transformer_blocks`. A .safetensors name alone says
/// nothing about what a file is for.
pub fn check_lora_header(bytes: &[u8]) -> Result<LoraCheck> {
    let len = bytes
        .get(..8)
        .map(|b| u64::from_le_bytes(b.try_into().unwrap_or_default()) as usize)
        .ok_or_else(|| Error::msg("This is not a safetensors file."))?;
    if len > 100 << 20 || bytes.len() < 8 + len {
        return Err(Error::msg("This is not a safetensors file."));
    }
    let header: serde_json::Map<String, Value> = serde_json::from_slice(&bytes[8..8 + len])
        .map_err(|_| Error::msg("This is not a safetensors file."))?;
    let mut tensors = 0;
    let mut rank = None;
    for (name, info) in &header {
        if name == "__metadata__" {
            continue;
        }
        tensors += 1;
        let is_lora = name.starts_with("transformer.transformer_blocks.")
            && (name.ends_with(".lora_A.weight") || name.ends_with(".lora_B.weight"));
        if !is_lora {
            return Err(Error::msg(format!(
                "This file is not a Qwen-Image 2.1 transformer LoRA (it has a tensor named {name})."
            )));
        }
        if name.ends_with(".lora_A.weight") {
            rank = info["shape"][0].as_u64().or(rank);
        }
    }
    if tensors == 0 {
        return Err(Error::msg("This LoRA file holds no tensors."));
    }
    Ok(LoraCheck { tensors, rank })
}

/// A file name for ComfyUI's LoRA folder: the project's slug, the step and a
/// piece of the hash, so two checkpoints never overwrite each other.
pub fn lora_file_name(project_name: &str, step: i64, sha256: &str) -> String {
    let mut slug: String = project_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-');
    let slug: String = slug.chars().take(40).collect();
    let slug = if slug.is_empty() {
        "lora".to_owned()
    } else {
        slug
    };
    format!(
        "imagegen-{slug}-qwenimage21-step{step}-{}.safetensors",
        &sha256[..sha256.len().min(8)]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(workspace: &str, python: &str) -> HostSpec {
        HostSpec {
            connection_id: "c".into(),
            label: "Pod".into(),
            host: "1.2.3.4".into(),
            port: 22,
            user: "root".into(),
            workspace: workspace.into(),
            python: python.into(),
            lora_dir: None,
            private_key: None,
            passphrase: None,
        }
    }

    pub fn config() -> TrainConfig {
        TrainConfig {
            resolution: 1024,
            buckets: true,
            rank: 16,
            alpha: 16,
            learning_rate: 1e-4,
            batch_size: 1,
            grad_accum: 4,
            max_steps: 500,
            seed: 0,
            precision: "bf16".into(),
            use8bit_adam: true,
            gradient_checkpointing: true,
            cache_latents: true,
            offload: false,
            quantize4bit: false,
            lr_scheduler: "constant".into(),
            warmup_steps: 0,
            checkpoint_steps: 100,
            random_flip: false,
            caption_dropout: 0.0,
            lora_layers: None,
            validation_prompts: vec!["photo of ohwx person".into()],
            validation_seeds: vec![1],
            validation_every: 100,
            validation_steps: 40,
            validation_include_base: true,
        }
    }

    #[test]
    fn paths_are_plain() {
        assert_eq!(
            check_remote_path("/workspace/imagegen-train/", "w").unwrap(),
            "/workspace/imagegen-train"
        );
        for bad in [
            "",
            "/",
            "workspace",
            "/a/../b",
            "/a b",
            "/a;rm -rf /",
            "/a/$(x)",
            "/a/`x`",
            "/a\nb",
            "/a/./b",
            "~/x",
        ] {
            assert!(check_remote_path(bad, "w").is_err(), "{bad:?}");
        }
        assert_eq!(check_python("").unwrap(), "python3");
        assert_eq!(
            check_python("/usr/bin/python3.11").unwrap(),
            "/usr/bin/python3.11"
        );
        assert!(check_python("python3 -c 'x'").is_err());
        assert!(check_python("python3;id").is_err());
    }

    #[test]
    fn commands_hold_only_checked_tokens() {
        let layout = Layout::new(&spec("/workspace/imagegen-train", "python3")).unwrap();
        let id = "67e55044-10b1-426f-9247-bb680e5fe0c8";
        assert_eq!(
            layout.command(Command::Status, Some(id)).unwrap(),
            format!(
                "python3 /workspace/imagegen-train/runner/runner-{RUNNER_VERSION}.py status {id}"
            )
        );
        assert!(layout.command(Command::Status, Some("../x")).is_err());
        assert!(layout.command(Command::Status, None).is_err());
        assert!(layout.command(Command::Preflight, Some(id)).is_err());
        assert!(Layout::new(&spec("/w;id", "python3")).is_err());
        assert_eq!(
            layout.job(id).unwrap(),
            format!("/workspace/imagegen-train/jobs/{id}")
        );
    }

    #[test]
    fn replies() {
        assert_eq!(
            parse_reply(b"noise\n{\"ok\": true, \"result\": {\"a\": 1}}\n", b"").unwrap()["a"],
            1
        );
        let err = parse_reply(b"{\"ok\": false, \"error\": \"busy\"}", b"").unwrap_err();
        assert_eq!(err.to_string(), "busy");
        let err = parse_reply(b"", b"bash: python3: command not found").unwrap_err();
        assert!(err.to_string().contains("Python interpreter"), "{err}");
    }

    #[test]
    fn redacts_tokens_and_keys() {
        let text = redact("token hf_abcdefghijklmnopqrstuvwxyz12 ok hf_short");
        assert_eq!(text, "token hf_*** ok hf_short");
        assert_eq!(
            redact("x -----BEGIN OPENSSH PRIVATE KEY-----\nabc"),
            "x [private key removed]"
        );
    }

    #[test]
    fn config_checks() {
        assert!(config().check().is_ok());
        for broken in [
            TrainConfig {
                resolution: 1000,
                ..config()
            },
            TrainConfig {
                rank: 0,
                ..config()
            },
            TrainConfig {
                learning_rate: f64::NAN,
                ..config()
            },
            TrainConfig {
                validation_every: 150,
                ..config()
            },
            TrainConfig {
                validation_seeds: vec![],
                ..config()
            },
            TrainConfig {
                lora_layers: Some("to_q;id".into()),
                ..config()
            },
            TrainConfig {
                checkpoint_steps: 600,
                ..config()
            },
        ] {
            assert!(broken.check().is_err(), "{broken:?}");
        }
    }

    fn snapshot() -> Snapshot {
        let items = vec![SnapshotItem {
            item_id: "i".into(),
            name: training_file_name(0),
            original_sha256: "o".into(),
            sha256: "a".repeat(64),
            caption: "ohwx person, \"quoted\" $(id)".into(),
            category: "face".into(),
            crop: None,
            width: 10,
            height: 10,
        }];
        Snapshot {
            trainer: TRAINER_ID.into(),
            trainer_version: TRAINER_VERSION.into(),
            family: FAMILY.into(),
            base_model: BASE_MODELS[0].into(),
            base_revision: "main".into(),
            trigger_token: "ohwx".into(),
            instance_prompt: "photo of ohwx person".into(),
            conversion: super::super::dataset::CONVERSION.into(),
            config: config(),
            dataset_hash: dataset_hash(&items),
            items,
        }
    }

    #[test]
    fn requests_carry_captions_as_data() {
        let id = "67e55044-10b1-426f-9247-bb680e5fe0c8";
        let req = build_request(id, &snapshot()).unwrap();
        assert_eq!(req["dataset"]["files"][0]["name"], "0001.png");
        assert_eq!(
            req["dataset"]["files"][0]["caption"],
            "ohwx person, \"quoted\" $(id)"
        );
        assert_eq!(req["train"]["loraLayers"], Value::Null);
        assert_eq!(req["validation"]["everySteps"], 100);
        assert!(build_request("x", &snapshot()).is_err());
    }

    #[test]
    fn dataset_hash_follows_content() {
        let a = snapshot();
        let mut b = snapshot();
        assert_eq!(dataset_hash(&a.items), dataset_hash(&b.items));
        b.items[0].caption.push('!');
        assert_ne!(dataset_hash(&a.items), dataset_hash(&b.items));
    }

    #[test]
    fn states() {
        assert_eq!(state_from_report(&json!({"state": "training"})), "training");
        assert_eq!(state_from_report(&json!({"state": "missing"})), "missing");
        assert_eq!(state_from_report(&json!({"state": "weird"})), "unknown");
    }

    fn safetensors(names: &[&str]) -> Vec<u8> {
        let mut header = serde_json::Map::new();
        header.insert("__metadata__".into(), json!({"format": "pt"}));
        for name in names {
            header.insert(
                (*name).into(),
                json!({"dtype": "BF16", "shape": [16, 3072], "data_offsets": [0, 0]}),
            );
        }
        let text = serde_json::to_vec(&header).unwrap();
        let mut out = (text.len() as u64).to_le_bytes().to_vec();
        out.extend(text);
        out
    }

    #[test]
    fn lora_headers() {
        let good = safetensors(&[
            "transformer.transformer_blocks.0.attn.to_q.lora_A.weight",
            "transformer.transformer_blocks.0.attn.to_q.lora_B.weight",
        ]);
        assert_eq!(
            check_lora_header(&good).unwrap(),
            LoraCheck {
                tensors: 2,
                rank: Some(16)
            }
        );
        // An SDXL-style LoRA is a .safetensors too.
        let sdxl = safetensors(&["lora_unet_down_blocks_0_attentions_0_proj_in.lora_down.weight"]);
        assert!(
            check_lora_header(&sdxl)
                .unwrap_err()
                .to_string()
                .contains("not a Qwen-Image 2.1")
        );
        assert!(check_lora_header(b"garbage!").is_err());
        assert!(check_lora_header(&safetensors(&[])).is_err());
    }

    #[test]
    fn lora_names() {
        assert_eq!(
            lora_file_name("My Face / 2026!", 400, "abcdef0123456789"),
            "imagegen-my-face-2026-qwenimage21-step400-abcdef01.safetensors"
        );
        assert!(lora_file_name("日本語", 1, "ab").starts_with("imagegen-lora-"));
    }
}
