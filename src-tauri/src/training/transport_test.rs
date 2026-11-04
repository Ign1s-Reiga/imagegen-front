//! The SSH transport against a real SSH server, with a fake trainer on the
//! other side: host-key trust, runner deployment, a resumed upload, start,
//! status, LoRA download and cleanup. It checks the app's
//! side of the protocol, not training.
//!
//! Ignored by default. To run it, start an SSH server whose workspace holds
//! the fake environment (see docs/training.md, "Testing the transport"), then:
//!
//! ```text
//! IMAGEGEN_SSH_TEST_HOST=127.0.0.1 IMAGEGEN_SSH_TEST_PORT=2222 \
//! IMAGEGEN_SSH_TEST_USER=$USER IMAGEGEN_SSH_TEST_KEY=/path/to/client_key \
//! IMAGEGEN_SSH_TEST_WORKSPACE=/tmp/igssh/ws cargo test -- --ignored transport
//! ```

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;
use serde_json::{Value, json};

use super::remote::{self, Command, HostSpec, Snapshot, SnapshotItem};
use super::{Host, Training, dataset, db, ssh};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name}"))
}

fn png(seed: u8) -> Vec<u8> {
    let mut img = image::RgbImage::new(64, 48);
    for (i, p) in img.pixels_mut().enumerate() {
        *p = image::Rgb([seed, (i % 251) as u8, 7]);
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

async fn wait_for(host: &Host, job: &str, states: &[&str], what: &str) -> Value {
    for _ in 0..300 {
        let status = host
            .call(Command::Status, Some(job), &Value::Null)
            .await
            .unwrap();
        if states.contains(&status["state"].as_str().unwrap_or_default()) {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    panic!("{what}: timed out");
}

#[test]
#[ignore = "needs an SSH server; see the module notes"]
fn transport_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    db::open(&conn).unwrap();
    let training = Training {
        conn: Mutex::new(conn),
        root: dir.path().to_owned(),
        deployed: Mutex::new(HashSet::new()),
    };
    let spec = HostSpec {
        connection_id: "test".into(),
        label: "Test host".into(),
        host: env("IMAGEGEN_SSH_TEST_HOST"),
        port: env("IMAGEGEN_SSH_TEST_PORT").parse().unwrap(),
        user: env("IMAGEGEN_SSH_TEST_USER"),
        workspace: env("IMAGEGEN_SSH_TEST_WORKSPACE"),
        python: "python3".into(),
        lora_dir: None,
        private_key: Some(std::fs::read_to_string(env("IMAGEGEN_SSH_TEST_KEY")).unwrap()),
        passphrase: None,
    };

    tauri::async_runtime::block_on(async {
        // An unknown host is refused with its fingerprint, then trusted by it.
        let target = super::target(&training, &spec).unwrap();
        let err = ssh::Session::connect(&target)
            .await
            .err()
            .expect("an unknown host must be refused")
            .to_string();
        let problem: Value =
            serde_json::from_str(err.strip_prefix(ssh::HOST_KEY_PREFIX).expect(&err)).unwrap();
        assert_eq!(problem["kind"], "unknown");
        let fingerprint = problem["fingerprint"].as_str().unwrap().to_owned();
        assert!(ssh::Session::trust(&target, "SHA256:not-it").await.is_err());
        ssh::Session::trust(&target, &fingerprint).await.unwrap();

        let host = Host::open(&training, &spec).await.unwrap();
        let version = host
            .call(Command::Version, None, &Value::Null)
            .await
            .unwrap();
        assert_eq!(version["runnerVersion"], remote::RUNNER_VERSION);
        let pre = host
            .call(
                Command::Preflight,
                None,
                &json!({"model": {"repo": "Qwen/Qwen-Image-2.1"}}),
            )
            .await
            .unwrap();
        assert_eq!(pre["environment"]["venv"], true);
        assert_eq!(pre["model"]["repo"], "Qwen/Qwen-Image-2.1");

        // A run of two photos, one of them half uploaded before.
        let job_id = uuid::Uuid::new_v4().to_string();
        let local = dir.path().join("dataset");
        std::fs::create_dir_all(&local).unwrap();
        let mut items = Vec::new();
        for i in 0..2 {
            let bytes = png(i as u8 * 90);
            let name = remote::training_file_name(i);
            std::fs::write(local.join(&name), &bytes).unwrap();
            items.push(SnapshotItem {
                item_id: format!("i{i}"),
                name,
                original_sha256: "o".into(),
                sha256: dataset::sha256_hex(&bytes),
                caption: format!("photo of ohwx person, \"{i}\"; $(touch /tmp/igssh/pwned)"),
                category: String::new(),
                crop: None,
                width: 64,
                height: 48,
            });
        }
        let mut config: remote::TrainConfig = serde_json::from_value(json!({
            "resolution": 1024, "buckets": true, "rank": 16, "alpha": 16, "learningRate": 1e-4,
            "batchSize": 1, "gradAccum": 1, "maxSteps": 20, "seed": 0, "precision": "bf16",
            "use8bitAdam": true, "gradientCheckpointing": true, "cacheLatents": true, "offload": false,
            "quantize4bit": false, "lrScheduler": "constant", "warmupSteps": 0, "checkpointSteps": 10,
            "randomFlip": false, "captionDropout": 0.0, "validationPrompts": [],
            "validationSeeds": [1], "validationEvery": 10, "validationSteps": 40, "validationIncludeBase": true
        }))
        .unwrap();
        config.validation_prompts.clear();
        let snapshot = Snapshot {
            trainer: remote::TRAINER_ID.into(),
            trainer_version: remote::TRAINER_VERSION.into(),
            family: remote::FAMILY.into(),
            base_model: remote::BASE_MODELS[0].into(),
            base_revision: "main".into(),
            trigger_token: "ohwx".into(),
            instance_prompt: "photo of ohwx person".into(),
            conversion: dataset::CONVERSION.into(),
            dataset_hash: remote::dataset_hash(&items),
            config,
            items,
        };
        let job = host.layout.job(&job_id).unwrap();
        let sftp = host.session.sftp().await.unwrap();
        ssh::make_dirs(&sftp, &format!("{job}/dataset"))
            .await
            .unwrap();
        let first = std::fs::read(local.join("0001.png")).unwrap();
        ssh::write_small(
            &sftp,
            &format!("{job}/dataset/0001.png.part"),
            &first[..first.len() / 2],
        )
        .await
        .unwrap();
        let mut sent = 0;
        for item in &snapshot.items {
            sent += ssh::upload(
                &sftp,
                &local.join(&item.name),
                &format!("{job}/dataset/{}", item.name),
                |_| {},
            )
            .await
            .unwrap();
        }
        let total: u64 = snapshot
            .items
            .iter()
            .map(|i| std::fs::metadata(local.join(&i.name)).unwrap().len())
            .sum();
        assert!(
            sent < total,
            "the interrupted upload should continue, not restart"
        );
        let hashes = host
            .call(Command::DatasetHashes, Some(&job_id), &Value::Null)
            .await
            .unwrap();
        for item in &snapshot.items {
            assert_eq!(hashes["hashes"][&item.name], item.sha256.as_str());
        }
        let request = remote::build_request(&job_id, &snapshot).unwrap();
        ssh::write_small(
            &sftp,
            &format!("{job}/request.json"),
            &serde_json::to_vec(&request).unwrap(),
        )
        .await
        .unwrap();

        // Start, follow to the end, and fetch a checkpoint's LoRA.
        host.call(Command::Start, Some(&job_id), &Value::Null)
            .await
            .unwrap();
        let done = wait_for(&host, &job_id, &["completed", "failed"], "first run").await;
        assert_eq!(done["state"], "completed", "{}", done["logTail"]);
        let steps: Vec<i64> = done["checkpoints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["step"].as_i64().unwrap())
            .collect();
        assert_eq!(steps, [10, 20]);
        assert_eq!(done["step"], 20);
        assert!(done["loss"].as_f64().is_some());
        assert!(
            !sftp
                .try_exists("/tmp/igssh/pwned".to_owned())
                .await
                .unwrap(),
            "a caption ran as a command"
        );

        let info = host
            .call(Command::LoraHash, Some(&job_id), &json!({"step": 10}))
            .await
            .unwrap();
        let path = dir.path().join("lora.safetensors");
        let got = ssh::download(&sftp, info["path"].as_str().unwrap(), &path, |_| {})
            .await
            .unwrap();
        assert_eq!(got, info["sha256"].as_str().unwrap());
        let check = remote::check_lora_header(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(check.rank, Some(4));

        // A finished run is not started again; its files go on request only.
        assert!(
            host.call(Command::Start, Some(&job_id), &Value::Null)
                .await
                .is_err()
        );
        host.call(Command::Cleanup, Some(&job_id), &Value::Null)
            .await
            .unwrap();
        let gone = host
            .call(Command::Status, Some(&job_id), &Value::Null)
            .await
            .unwrap();
        assert_eq!(remote::state_from_report(&gone), "missing");

        // A path outside the jobs folder is refused by both sides.
        assert!(host.layout.job("../../etc").is_err());
        let refused = host
            .session
            .exec(
                &format!("python3 {} cleanup ../../etc", host.layout.runner()),
                b"",
                Duration::from_secs(30),
            )
            .await
            .unwrap();
        assert!(remote::parse_reply(&refused.stdout, &refused.stderr).is_err());

        host.close().await;
    });
}
