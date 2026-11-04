//! Training projects in SQLite: projects, their photographs, runs with an
//! immutable snapshot of what they trained on, checkpoints and registered
//! LoRAs. Image and model bytes live in files next to the database; rows only
//! name them.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};

pub const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    objective     TEXT NOT NULL,
    trigger_token TEXT NOT NULL UNIQUE,
    trainer       TEXT NOT NULL,
    family        TEXT NOT NULL,
    base_model    TEXT NOT NULL,
    config        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    file_name          TEXT NOT NULL,
    original_name      TEXT NOT NULL,
    sha256             TEXT NOT NULL,
    width              INTEGER,
    height             INTEGER,
    orientation        INTEGER NOT NULL DEFAULT 1,
    has_location       INTEGER NOT NULL DEFAULT 0,
    decode_error       TEXT,
    caption            TEXT NOT NULL DEFAULT '',
    caption_source     TEXT NOT NULL DEFAULT '',
    caption_suggestion TEXT,
    included           INTEGER NOT NULL DEFAULT 1,
    category           TEXT NOT NULL DEFAULT '',
    crop               TEXT,
    added_at           INTEGER NOT NULL,
    UNIQUE (project_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_items_project ON items (project_id, added_at);

CREATE TABLE IF NOT EXISTS runs (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    created_at     INTEGER NOT NULL,
    host_id        TEXT NOT NULL,
    host_label     TEXT NOT NULL,
    snapshot       TEXT NOT NULL,
    dataset_hash   TEXT NOT NULL,
    remote_dir     TEXT NOT NULL,
    state          TEXT NOT NULL,
    remote         TEXT,
    connection     TEXT NOT NULL DEFAULT 'unchecked',
    connection_error TEXT,
    checked_at     INTEGER,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project_id, created_at);

-- What a run trained on never changes once it is recorded.
CREATE TRIGGER IF NOT EXISTS runs_snapshot_immutable
BEFORE UPDATE OF snapshot, dataset_hash, project_id, host_id, remote_dir ON runs
BEGIN
    SELECT RAISE(ABORT, 'a run''s snapshot cannot be changed');
END;

CREATE TABLE IF NOT EXISTS artifacts (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    run_id       TEXT NOT NULL,
    step         INTEGER NOT NULL,
    family       TEXT NOT NULL,
    base_model   TEXT NOT NULL,
    trainer      TEXT NOT NULL,
    trigger_token TEXT NOT NULL,
    dataset_hash TEXT NOT NULL,
    file_name    TEXT NOT NULL,
    size         INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    manifest     TEXT NOT NULL,
    installs     TEXT NOT NULL DEFAULT '[]',
    created_at   INTEGER NOT NULL,
    UNIQUE (run_id, step)
);
"#;

pub fn open(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub objective: String,
    pub trigger_token: String,
    pub trainer: String,
    pub family: String,
    pub base_model: String,
    pub config: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub project_id: String,
    pub file_name: String,
    pub original_name: String,
    pub sha256: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub orientation: i64,
    pub has_location: bool,
    pub decode_error: Option<String>,
    pub caption: String,
    pub caption_source: String,
    pub caption_suggestion: Option<String>,
    pub included: bool,
    pub category: String,
    pub crop: Option<Crop>,
    pub added_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub project_id: String,
    pub created_at: i64,
    pub host_id: String,
    pub host_label: String,
    pub snapshot: Value,
    pub dataset_hash: String,
    pub remote_dir: String,
    /// The app's view: draft, uploading, uploaded, or the host's last state.
    pub state: String,
    /// The host's last full status report.
    pub remote: Option<Value>,
    /// Whether the last check reached the host: unchecked, ok or lost.
    pub connection: String,
    pub connection_error: Option<String>,
    pub checked_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub project_id: String,
    pub run_id: String,
    pub step: i64,
    pub family: String,
    pub base_model: String,
    pub trainer: String,
    pub trigger_token: String,
    pub dataset_hash: String,
    pub file_name: String,
    pub size: i64,
    pub sha256: String,
    pub manifest: Value,
    pub installs: Value,
    pub created_at: i64,
}

fn json_col(row: &Row, idx: usize) -> rusqlite::Result<Value> {
    let text: String = row.get(idx)?;
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn project_row(row: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        objective: row.get(2)?,
        trigger_token: row.get(3)?,
        trainer: row.get(4)?,
        family: row.get(5)?,
        base_model: row.get(6)?,
        config: json_col(row, 7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

const PROJECT_COLS: &str = "id, name, objective, trigger_token, trainer, family, base_model, config, created_at, updated_at";

pub fn insert_project(conn: &Connection, project: &Project) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO projects ({PROJECT_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
        ),
        params![
            project.id,
            project.name,
            project.objective,
            project.trigger_token,
            project.trainer,
            project.family,
            project.base_model,
            project.config.to_string(),
            project.created_at,
            project.updated_at,
        ],
    )
    .map_err(|err| unique_error(err, "Another project already uses this trigger token."))?;
    Ok(())
}

fn unique_error(err: rusqlite::Error, message: &str) -> Error {
    match err {
        rusqlite::Error::SqliteFailure(e, _)
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            Error::msg(message)
        }
        err => err.into(),
    }
}

pub fn update_project(conn: &Connection, project: &Project) -> Result<()> {
    let changed = conn
        .execute(
            "UPDATE projects SET name = ?2, objective = ?3, trigger_token = ?4, trainer = ?5, family = ?6,
                 base_model = ?7, config = ?8, updated_at = ?9 WHERE id = ?1",
            params![
                project.id,
                project.name,
                project.objective,
                project.trigger_token,
                project.trainer,
                project.family,
                project.base_model,
                project.config.to_string(),
                project.updated_at,
            ],
        )
        .map_err(|err| unique_error(err, "Another project already uses this trigger token."))?;
    if changed == 0 {
        return Err(Error::msg("project not found"));
    }
    Ok(())
}

pub fn list_projects(conn: &Connection) -> Result<Vec<Project>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PROJECT_COLS} FROM projects ORDER BY updated_at DESC"
    ))?;
    let rows = stmt.query_map([], project_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn get_project(conn: &Connection, id: &str) -> Result<Project> {
    conn.query_row(
        &format!("SELECT {PROJECT_COLS} FROM projects WHERE id = ?1"),
        params![id],
        project_row,
    )
    .optional()?
    .ok_or_else(|| Error::msg("project not found"))
}

pub fn touch_project(conn: &Connection, id: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE projects SET updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

pub fn delete_project(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
    Ok(())
}

const ITEM_COLS: &str =
    "id, project_id, file_name, original_name, sha256, width, height, orientation, has_location,
    decode_error, caption, caption_source, caption_suggestion, included, category, crop, added_at";

fn item_row(row: &Row) -> rusqlite::Result<Item> {
    let crop: Option<String> = row.get(15)?;
    Ok(Item {
        id: row.get(0)?,
        project_id: row.get(1)?,
        file_name: row.get(2)?,
        original_name: row.get(3)?,
        sha256: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        orientation: row.get(7)?,
        has_location: row.get::<_, i64>(8)? != 0,
        decode_error: row.get(9)?,
        caption: row.get(10)?,
        caption_source: row.get(11)?,
        caption_suggestion: row.get(12)?,
        included: row.get::<_, i64>(13)? != 0,
        category: row.get(14)?,
        crop: crop.and_then(|c| serde_json::from_str(&c).ok()),
        added_at: row.get(16)?,
    })
}

/// Records a photograph; false when the project already has these exact
/// bytes (the copy is then not needed).
pub fn insert_item(conn: &Connection, item: &Item) -> Result<bool> {
    let inserted = conn.execute(
        &format!(
            "INSERT OR IGNORE INTO items ({ITEM_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)"
        ),
        params![
            item.id,
            item.project_id,
            item.file_name,
            item.original_name,
            item.sha256,
            item.width,
            item.height,
            item.orientation,
            item.has_location as i64,
            item.decode_error,
            item.caption,
            item.caption_source,
            item.caption_suggestion,
            item.included as i64,
            item.category,
            item.crop.as_ref().map(|c| serde_json::to_string(c).unwrap_or_default()),
            item.added_at,
        ],
    )?;
    Ok(inserted == 1)
}

pub fn has_item_hash(conn: &Connection, project_id: &str, sha256: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT original_name FROM items WHERE project_id = ?1 AND sha256 = ?2",
            params![project_id, sha256],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn list_items(conn: &Connection, project_id: &str) -> Result<Vec<Item>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ITEM_COLS} FROM items WHERE project_id = ?1 ORDER BY added_at, id"
    ))?;
    let rows = stmt.query_map(params![project_id], item_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn get_item(conn: &Connection, id: &str) -> Result<Item> {
    conn.query_row(
        &format!("SELECT {ITEM_COLS} FROM items WHERE id = ?1"),
        params![id],
        item_row,
    )
    .optional()?
    .ok_or_else(|| Error::msg("photo not found"))
}

/// The changes a caller can make to a photo. Absent fields stay as they are.
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ItemPatch {
    pub caption: Option<String>,
    pub caption_source: Option<String>,
    /// `Some(None)` clears the suggestion.
    #[serde(default, with = "double_option")]
    pub caption_suggestion: Option<Option<String>>,
    pub included: Option<bool>,
    pub category: Option<String>,
    #[serde(default, with = "double_option")]
    pub crop: Option<Option<Crop>>,
}

mod double_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

pub const CATEGORIES: [&str; 4] = ["", "face", "upper-body", "full-body"];

pub fn patch_item(conn: &Connection, id: &str, patch: &ItemPatch) -> Result<Item> {
    let mut item = get_item(conn, id)?;
    if let Some(caption) = &patch.caption {
        if caption.chars().count() > 2000 {
            return Err(Error::msg("A caption can be at most 2000 characters."));
        }
        item.caption = caption.clone();
    }
    if let Some(source) = &patch.caption_source {
        if !["", "manual", "assistant"].contains(&source.as_str()) {
            return Err(Error::msg("unknown caption source"));
        }
        item.caption_source = source.clone();
    }
    if let Some(suggestion) = &patch.caption_suggestion {
        item.caption_suggestion = suggestion.clone();
    }
    if let Some(included) = patch.included {
        item.included = included;
    }
    if let Some(category) = &patch.category {
        if !CATEGORIES.contains(&category.as_str()) {
            return Err(Error::msg("unknown category"));
        }
        item.category = category.clone();
    }
    if let Some(crop) = &patch.crop {
        if let Some(c) = crop {
            let valid = [c.x, c.y, c.width, c.height].iter().all(|v| v.is_finite())
                && c.x >= 0.0
                && c.y >= 0.0
                && c.width > 0.01
                && c.height > 0.01
                && c.x + c.width <= 1.0 + 1e-9
                && c.y + c.height <= 1.0 + 1e-9;
            if !valid {
                return Err(Error::msg("The crop must lie inside the photo."));
            }
        }
        item.crop = crop.clone();
    }
    conn.execute(
        "UPDATE items SET caption = ?2, caption_source = ?3, caption_suggestion = ?4, included = ?5,
             category = ?6, crop = ?7 WHERE id = ?1",
        params![
            item.id,
            item.caption,
            item.caption_source,
            item.caption_suggestion,
            item.included as i64,
            item.category,
            item.crop.as_ref().map(|c| serde_json::to_string(c).unwrap_or_default()),
        ],
    )?;
    Ok(item)
}

pub fn delete_item(conn: &Connection, id: &str) -> Result<Option<String>> {
    let file = conn
        .query_row(
            "SELECT file_name FROM items WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    conn.execute("DELETE FROM items WHERE id = ?1", params![id])?;
    Ok(file)
}

const RUN_COLS: &str =
    "id, project_id, created_at, host_id, host_label, snapshot, dataset_hash, remote_dir, state,
    remote, connection, connection_error, checked_at, updated_at";

fn run_row(row: &Row) -> rusqlite::Result<Run> {
    let remote: Option<String> = row.get(9)?;
    Ok(Run {
        id: row.get(0)?,
        project_id: row.get(1)?,
        created_at: row.get(2)?,
        host_id: row.get(3)?,
        host_label: row.get(4)?,
        snapshot: json_col(row, 5)?,
        dataset_hash: row.get(6)?,
        remote_dir: row.get(7)?,
        state: row.get(8)?,
        remote: remote.and_then(|r| serde_json::from_str(&r).ok()),
        connection: row.get(10)?,
        connection_error: row.get(11)?,
        checked_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

pub fn insert_run(conn: &Connection, run: &Run) -> Result<()> {
    conn.execute(
        &format!("INSERT INTO runs ({RUN_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"),
        params![
            run.id,
            run.project_id,
            run.created_at,
            run.host_id,
            run.host_label,
            run.snapshot.to_string(),
            run.dataset_hash,
            run.remote_dir,
            run.state,
            run.remote.as_ref().map(Value::to_string),
            run.connection,
            run.connection_error,
            run.checked_at,
            run.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get_run(conn: &Connection, id: &str) -> Result<Run> {
    conn.query_row(
        &format!("SELECT {RUN_COLS} FROM runs WHERE id = ?1"),
        params![id],
        run_row,
    )
    .optional()?
    .ok_or_else(|| Error::msg("run not found"))
}

pub fn list_runs(conn: &Connection, project_id: &str) -> Result<Vec<Run>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLS} FROM runs WHERE project_id = ?1 ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map(params![project_id], run_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Records what the host reported. The snapshot is never part of this.
pub fn set_run_state(
    conn: &Connection,
    id: &str,
    state: &str,
    remote: Option<&Value>,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE runs SET state = ?2, remote = COALESCE(?3, remote), connection = 'ok', connection_error = NULL,
             checked_at = ?4, updated_at = ?4 WHERE id = ?1",
        params![id, state, remote.map(Value::to_string), now],
    )?;
    Ok(())
}

/// The app's own states before a run reaches its host (uploading).
pub fn set_local_state(conn: &Connection, id: &str, state: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE runs SET state = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, state, now],
    )?;
    Ok(())
}

/// Records a failed check. The run's state stays as last seen: a lost
/// connection says nothing about the training.
pub fn set_run_unreachable(conn: &Connection, id: &str, error: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE runs SET connection = 'lost', connection_error = ?2, checked_at = ?3 WHERE id = ?1",
        params![id, error, now],
    )?;
    Ok(())
}

pub fn delete_run(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM runs WHERE id = ?1", params![id])?;
    Ok(())
}

const ARTIFACT_COLS: &str =
    "id, project_id, run_id, step, family, base_model, trainer, trigger_token, dataset_hash,
    file_name, size, sha256, manifest, installs, created_at";

fn artifact_row(row: &Row) -> rusqlite::Result<Artifact> {
    Ok(Artifact {
        id: row.get(0)?,
        project_id: row.get(1)?,
        run_id: row.get(2)?,
        step: row.get(3)?,
        family: row.get(4)?,
        base_model: row.get(5)?,
        trainer: row.get(6)?,
        trigger_token: row.get(7)?,
        dataset_hash: row.get(8)?,
        file_name: row.get(9)?,
        size: row.get(10)?,
        sha256: row.get(11)?,
        manifest: json_col(row, 12)?,
        installs: json_col(row, 13)?,
        created_at: row.get(14)?,
    })
}

pub fn insert_artifact(conn: &Connection, a: &Artifact) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO artifacts ({ARTIFACT_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"
        ),
        params![
            a.id,
            a.project_id,
            a.run_id,
            a.step,
            a.family,
            a.base_model,
            a.trainer,
            a.trigger_token,
            a.dataset_hash,
            a.file_name,
            a.size,
            a.sha256,
            a.manifest.to_string(),
            a.installs.to_string(),
            a.created_at,
        ],
    )
    .map_err(|err| unique_error(err, "This checkpoint is already registered."))?;
    Ok(())
}

pub fn list_artifacts(conn: &Connection, project_id: Option<&str>) -> Result<Vec<Artifact>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ARTIFACT_COLS} FROM artifacts WHERE (?1 IS NULL OR project_id = ?1) ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map(params![project_id], artifact_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn get_artifact(conn: &Connection, id: &str) -> Result<Artifact> {
    conn.query_row(
        &format!("SELECT {ARTIFACT_COLS} FROM artifacts WHERE id = ?1"),
        params![id],
        artifact_row,
    )
    .optional()?
    .ok_or_else(|| Error::msg("LoRA not found"))
}

pub fn set_artifact_installs(conn: &Connection, id: &str, installs: &Value) -> Result<()> {
    conn.execute(
        "UPDATE artifacts SET installs = ?2 WHERE id = ?1",
        params![id, installs.to_string()],
    )?;
    Ok(())
}

pub fn delete_artifact(conn: &Connection, id: &str) -> Result<Option<String>> {
    let file = conn
        .query_row(
            "SELECT file_name FROM artifacts WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    conn.execute("DELETE FROM artifacts WHERE id = ?1", params![id])?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        open(&conn).unwrap();
        conn
    }

    pub fn project(id: &str, token: &str) -> Project {
        Project {
            id: id.into(),
            name: "Me".into(),
            objective: "identity".into(),
            trigger_token: token.into(),
            trainer: "diffusers-qwenimage21".into(),
            family: "qwen-image-2.1".into(),
            base_model: "Qwen/Qwen-Image-2.1".into(),
            config: json!({"rank": 16}),
            created_at: 1,
            updated_at: 1,
        }
    }

    fn item(id: &str, project: &str, sha: &str) -> Item {
        Item {
            id: id.into(),
            project_id: project.into(),
            file_name: format!("{id}.jpg"),
            original_name: "IMG_1.jpg".into(),
            sha256: sha.into(),
            width: Some(10),
            height: Some(20),
            orientation: 6,
            has_location: true,
            decode_error: None,
            caption: String::new(),
            caption_source: String::new(),
            caption_suggestion: None,
            included: true,
            category: String::new(),
            crop: None,
            added_at: 1,
        }
    }

    #[test]
    fn projects_persist_and_tokens_are_unique() {
        let conn = db();
        insert_project(&conn, &project("p1", "ohwx")).unwrap();
        let err = insert_project(&conn, &project("p2", "ohwx")).unwrap_err();
        assert!(err.to_string().contains("trigger token"), "{err}");
        let mut p = get_project(&conn, "p1").unwrap();
        assert_eq!(p.config, json!({"rank": 16}));
        p.config = json!({"rank": 32});
        p.updated_at = 5;
        update_project(&conn, &p).unwrap();
        assert_eq!(list_projects(&conn).unwrap()[0].config, json!({"rank": 32}));
    }

    #[test]
    fn exact_duplicates_are_skipped() {
        let conn = db();
        insert_project(&conn, &project("p1", "ohwx")).unwrap();
        assert!(insert_item(&conn, &item("a", "p1", "h1")).unwrap());
        assert!(!insert_item(&conn, &item("b", "p1", "h1")).unwrap());
        assert_eq!(
            has_item_hash(&conn, "p1", "h1").unwrap().as_deref(),
            Some("IMG_1.jpg")
        );
        assert_eq!(list_items(&conn, "p1").unwrap().len(), 1);
    }

    #[test]
    fn patches_validate_and_keep_other_fields() {
        let conn = db();
        insert_project(&conn, &project("p1", "ohwx")).unwrap();
        insert_item(&conn, &item("a", "p1", "h1")).unwrap();
        let patch: ItemPatch = serde_json::from_value(
            json!({"caption": "ohwx person, red coat", "captionSource": "manual"}),
        )
        .unwrap();
        let got = patch_item(&conn, "a", &patch).unwrap();
        assert_eq!(got.caption, "ohwx person, red coat");
        assert!(got.included);

        let patch: ItemPatch =
            serde_json::from_value(json!({"captionSuggestion": "s", "included": false})).unwrap();
        let got = patch_item(&conn, "a", &patch).unwrap();
        assert_eq!(got.caption, "ohwx person, red coat");
        assert_eq!(got.caption_suggestion.as_deref(), Some("s"));
        assert!(!got.included);

        let patch: ItemPatch = serde_json::from_value(json!({"captionSuggestion": null})).unwrap();
        assert_eq!(
            patch_item(&conn, "a", &patch).unwrap().caption_suggestion,
            None
        );

        let bad: ItemPatch =
            serde_json::from_value(json!({"crop": {"x": 0.5, "y": 0, "width": 0.6, "height": 1}}))
                .unwrap();
        assert!(patch_item(&conn, "a", &bad).is_err());
        let bad: ItemPatch = serde_json::from_value(json!({"category": "feet"})).unwrap();
        assert!(patch_item(&conn, "a", &bad).is_err());
    }

    #[test]
    fn run_snapshots_cannot_change() {
        let conn = db();
        insert_project(&conn, &project("p1", "ohwx")).unwrap();
        let run = Run {
            id: "r1".into(),
            project_id: "p1".into(),
            created_at: 1,
            host_id: "h".into(),
            host_label: "Pod".into(),
            snapshot: json!({"items": [{"caption": "before"}]}),
            dataset_hash: "d1".into(),
            remote_dir: "/workspace/x".into(),
            state: "draft".into(),
            remote: None,
            connection: "unchecked".into(),
            connection_error: None,
            checked_at: None,
            updated_at: 1,
        };
        insert_run(&conn, &run).unwrap();
        // Editing the project's photos afterwards leaves the run alone.
        insert_item(&conn, &item("a", "p1", "h1")).unwrap();
        patch_item(
            &conn,
            "a",
            &serde_json::from_value(json!({"caption": "after"})).unwrap(),
        )
        .unwrap();
        assert_eq!(
            get_run(&conn, "r1").unwrap().snapshot,
            json!({"items": [{"caption": "before"}]})
        );

        let err = conn
            .execute("UPDATE runs SET snapshot = '{}' WHERE id = 'r1'", [])
            .unwrap_err();
        assert!(err.to_string().contains("cannot be changed"), "{err}");
        assert!(
            conn.execute("UPDATE runs SET dataset_hash = 'x' WHERE id = 'r1'", [])
                .is_err()
        );

        set_run_state(&conn, "r1", "training", Some(&json!({"step": 3})), 2).unwrap();
        set_run_unreachable(&conn, "r1", "timed out", 3).unwrap();
        let got = get_run(&conn, "r1").unwrap();
        assert_eq!(got.state, "training");
        assert_eq!(got.connection, "lost");
        assert_eq!(got.remote, Some(json!({"step": 3})));
    }

    #[test]
    fn artifacts_register_once_per_checkpoint() {
        let conn = db();
        insert_project(&conn, &project("p1", "ohwx")).unwrap();
        let a = Artifact {
            id: "a1".into(),
            project_id: "p1".into(),
            run_id: "r1".into(),
            step: 400,
            family: "qwen-image-2.1".into(),
            base_model: "Qwen/Qwen-Image-2.1".into(),
            trainer: "diffusers-qwenimage21".into(),
            trigger_token: "ohwx".into(),
            dataset_hash: "d1".into(),
            file_name: "x.safetensors".into(),
            size: 3,
            sha256: "abc".into(),
            manifest: json!({}),
            installs: json!([]),
            created_at: 1,
        };
        insert_artifact(&conn, &a).unwrap();
        assert!(
            insert_artifact(
                &conn,
                &Artifact {
                    id: "a2".into(),
                    ..a.clone()
                }
            )
            .is_err()
        );
        assert_eq!(list_artifacts(&conn, None).unwrap().len(), 1);
        assert_eq!(list_artifacts(&conn, Some("other")).unwrap().len(), 0);
    }
}
