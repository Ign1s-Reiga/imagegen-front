//! Local gallery: image files on disk plus a SQLite index of generations.
//!
//! Saving is two-step so image bytes travel over raw IPC instead of JSON:
//! `gallery_write_image` writes one file, then `gallery_commit` records the
//! generation and all of its images in a single transaction.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, State,
    ipc::{InvokeBody, Request},
};

use crate::error::{Error, Result};

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS generations (
    id              TEXT PRIMARY KEY,
    created_at      INTEGER NOT NULL,
    provider        TEXT NOT NULL,
    connection_name TEXT NOT NULL,
    model           TEXT,
    mode            TEXT NOT NULL,
    prompt          TEXT NOT NULL,
    negative_prompt TEXT,
    params          TEXT NOT NULL,
    duration_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations (created_at DESC);

CREATE TABLE IF NOT EXISTS images (
    id            TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES generations (id) ON DELETE CASCADE,
    idx           INTEGER NOT NULL,
    file_name     TEXT NOT NULL,
    mime          TEXT NOT NULL,
    width         INTEGER,
    height        INTEGER,
    seed          INTEGER,
    favorite      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_images_generation_id ON images (generation_id);
"#;

pub struct Gallery {
    conn: Mutex<Connection>,
    images_dir: PathBuf,
}

impl Gallery {
    pub fn open(app: &AppHandle) -> Result<Self> {
        let data_dir = app.path().app_data_dir()?;
        let images_dir = data_dir.join("images");
        fs::create_dir_all(&images_dir)?;
        let conn = Connection::open(data_dir.join("gallery.sqlite3"))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            images_dir,
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn path_of(&self, file_name: &str) -> PathBuf {
        self.images_dir.join(file_name)
    }

    fn remove_files<'a>(&self, file_names: impl IntoIterator<Item = &'a String>) {
        for name in file_names {
            if let Err(err) = fs::remove_file(self.path_of(name)) {
                log::warn!("failed to remove {name}: {err}");
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenFile {
    file_name: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewImage {
    id: String,
    file_name: String,
    mime: String,
    width: Option<i64>,
    height: Option<i64>,
    seed: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewGeneration {
    id: String,
    created_at: i64,
    provider: String,
    connection_name: String,
    model: Option<String>,
    mode: String,
    prompt: String,
    negative_prompt: Option<String>,
    params: serde_json::Value,
    duration_ms: Option<i64>,
    images: Vec<NewImage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRecord {
    id: String,
    generation_id: String,
    index: i64,
    file_name: String,
    path: String,
    mime: String,
    width: Option<i64>,
    height: Option<i64>,
    seed: Option<i64>,
    favorite: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationRecord {
    id: String,
    created_at: i64,
    provider: String,
    connection_name: String,
    model: Option<String>,
    mode: String,
    prompt: String,
    negative_prompt: Option<String>,
    params: serde_json::Value,
    duration_ms: Option<i64>,
    images: Vec<ImageRecord>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    #[serde(default)]
    offset: i64,
    limit: Option<i64>,
    search: Option<String>,
    #[serde(default)]
    favorites_only: bool,
}

fn sanitize_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        "gif" => "gif",
        _ => "png",
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Writes one image. The raw request body is the file content; the
/// `x-ext` header picks the extension.
#[tauri::command]
pub async fn gallery_write_image(
    request: Request<'_>,
    gallery: State<'_, Gallery>,
) -> Result<WrittenFile> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::msg("expected raw image bytes"));
    };
    let ext = request
        .headers()
        .get("x-ext")
        .and_then(|value| value.to_str().ok())
        .map(sanitize_ext)
        .unwrap_or("png");
    let file_name = format!("{}.{ext}", uuid::Uuid::new_v4());
    let path = gallery.path_of(&file_name);
    fs::write(&path, bytes)?;
    Ok(WrittenFile {
        file_name,
        path: path_string(&path),
    })
}

#[tauri::command]
pub async fn gallery_commit(generation: NewGeneration, gallery: State<'_, Gallery>) -> Result<()> {
    for image in &generation.images {
        // File names come back from gallery_write_image; refuse anything that
        // could point outside the images directory.
        if image.file_name.contains(['/', '\\']) || image.file_name.contains("..") {
            return Err(Error::msg(format!(
                "invalid file name: {}",
                image.file_name
            )));
        }
    }

    let mut conn = gallery.conn();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO generations
            (id, created_at, provider, connection_name, model, mode, prompt, negative_prompt, params, duration_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            generation.id,
            generation.created_at,
            generation.provider,
            generation.connection_name,
            generation.model,
            generation.mode,
            generation.prompt,
            generation.negative_prompt,
            serde_json::to_string(&generation.params)?,
            generation.duration_ms,
        ],
    )?;
    for (index, image) in generation.images.iter().enumerate() {
        tx.execute(
            "INSERT INTO images (id, generation_id, idx, file_name, mime, width, height, seed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                image.id,
                generation.id,
                index as i64,
                image.file_name,
                image.mime,
                image.width,
                image.height,
                image.seed,
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub async fn gallery_list(
    query: Option<ListQuery>,
    gallery: State<'_, Gallery>,
) -> Result<Vec<GenerationRecord>> {
    let query = query.unwrap_or_default();
    let limit = query.limit.unwrap_or(60).clamp(1, 500);
    let search = query
        .search
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());

    let conn = gallery.conn();
    let mut gen_stmt = conn.prepare(
        "SELECT id, created_at, provider, connection_name, model, mode, prompt, negative_prompt, params, duration_ms
         FROM generations g
         WHERE (?1 IS NULL OR g.prompt LIKE '%' || ?1 || '%' ESCAPE '\\')
           AND (?2 = 0 OR EXISTS (SELECT 1 FROM images i WHERE i.generation_id = g.id AND i.favorite = 1))
         ORDER BY created_at DESC
         LIMIT ?3 OFFSET ?4",
    )?;
    let mut img_stmt = conn.prepare(
        "SELECT id, idx, file_name, mime, width, height, seed, favorite
         FROM images WHERE generation_id = ?1 ORDER BY idx",
    )?;

    let escaped = search.map(|s| {
        s.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    });
    let rows = gen_stmt.query_map(
        params![
            escaped,
            query.favorites_only as i64,
            limit,
            query.offset.max(0)
        ],
        |row| {
            let params_json: String = row.get(8)?;
            Ok(GenerationRecord {
                id: row.get(0)?,
                created_at: row.get(1)?,
                provider: row.get(2)?,
                connection_name: row.get(3)?,
                model: row.get(4)?,
                mode: row.get(5)?,
                prompt: row.get(6)?,
                negative_prompt: row.get(7)?,
                params: serde_json::from_str(&params_json).unwrap_or(serde_json::Value::Null),
                duration_ms: row.get(9)?,
                images: Vec::new(),
            })
        },
    )?;

    let mut generations = Vec::new();
    for row in rows {
        let mut generation = row?;
        let images = img_stmt.query_map(params![generation.id], |row| {
            let file_name: String = row.get(2)?;
            Ok(ImageRecord {
                id: row.get(0)?,
                generation_id: generation.id.clone(),
                index: row.get(1)?,
                path: path_string(&gallery.path_of(&file_name)),
                file_name,
                mime: row.get(3)?,
                width: row.get(4)?,
                height: row.get(5)?,
                seed: row.get(6)?,
                favorite: row.get::<_, i64>(7)? != 0,
            })
        })?;
        generation.images = images.collect::<rusqlite::Result<_>>()?;
        generations.push(generation);
    }
    Ok(generations)
}

#[tauri::command]
pub async fn gallery_delete_generation(id: String, gallery: State<'_, Gallery>) -> Result<()> {
    let files = {
        let mut conn = gallery.conn();
        let tx = conn.transaction()?;
        let files = tx
            .prepare("SELECT file_name FROM images WHERE generation_id = ?1")?
            .query_map(params![id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        tx.execute("DELETE FROM generations WHERE id = ?1", params![id])?;
        tx.commit()?;
        files
    };
    gallery.remove_files(&files);
    Ok(())
}

#[tauri::command]
pub async fn gallery_delete_image(id: String, gallery: State<'_, Gallery>) -> Result<()> {
    let file = {
        let mut conn = gallery.conn();
        let tx = conn.transaction()?;
        let found: Option<(String, String)> = tx
            .query_row(
                "SELECT file_name, generation_id FROM images WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map(Some)
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                err => Err(err),
            })?;
        let Some((file_name, generation_id)) = found else {
            return Ok(());
        };
        tx.execute("DELETE FROM images WHERE id = ?1", params![id])?;
        // Drop the generation once its last image is gone.
        tx.execute(
            "DELETE FROM generations WHERE id = ?1
               AND NOT EXISTS (SELECT 1 FROM images WHERE generation_id = ?1)",
            params![generation_id],
        )?;
        tx.commit()?;
        file_name
    };
    gallery.remove_files([&file]);
    Ok(())
}

#[tauri::command]
pub async fn gallery_set_favorite(
    id: String,
    favorite: bool,
    gallery: State<'_, Gallery>,
) -> Result<()> {
    gallery.conn().execute(
        "UPDATE images SET favorite = ?2 WHERE id = ?1",
        params![id, favorite as i64],
    )?;
    Ok(())
}

fn image_file_name(conn: &Connection, id: &str) -> Result<String> {
    conn.query_row(
        "SELECT file_name FROM images WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .map_err(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => Error::msg(format!("image {id} not found")),
        err => err.into(),
    })
}

/// Returns the raw bytes of a stored image (used to feed it back as an input).
#[tauri::command]
pub async fn gallery_read_image(
    id: String,
    gallery: State<'_, Gallery>,
) -> Result<tauri::ipc::Response> {
    let file_name = image_file_name(&gallery.conn(), &id)?;
    let bytes = fs::read(gallery.path_of(&file_name))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Copies a stored image to a path the user picked in a save dialog.
#[tauri::command]
pub async fn gallery_export_image(
    id: String,
    destination: String,
    gallery: State<'_, Gallery>,
) -> Result<()> {
    let file_name = image_file_name(&gallery.conn(), &id)?;
    fs::copy(gallery.path_of(&file_name), destination)?;
    Ok(())
}

#[tauri::command]
pub fn gallery_dir(gallery: State<'_, Gallery>) -> String {
    path_string(&gallery.images_dir)
}
