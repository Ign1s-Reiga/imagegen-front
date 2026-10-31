//! Saving files the webview produces (sprite exports and projects). The save
//! dialog runs here, so the webview never chooses where a file is written.

use std::fs;

use tauri::WebviewWindow;
use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_dialog::DialogExt;

use crate::error::{Error, Result};

fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}

/// Asks where to save, then writes the raw request body there. Headers:
/// `x-file-name` (suggested name), `x-filter-name` and `x-filter-ext` (one
/// extension, without the dot). Returns the chosen path, or `None` when the
/// dialog was closed.
#[tauri::command]
pub async fn save_file(window: WebviewWindow, request: Request<'_>) -> Result<Option<String>> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::msg("expected raw file bytes"));
    };
    let mut dialog = window.dialog().file().set_parent(&window);
    if let Some(name) = header(&request, "x-file-name") {
        dialog = dialog.set_file_name(name);
    }
    if let (Some(name), Some(ext)) = (
        header(&request, "x-filter-name"),
        header(&request, "x-filter-ext"),
    ) {
        dialog = dialog.add_filter(name, &[ext]);
    }
    let Some(path) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|err| Error::msg(err.to_string()))?;
    fs::write(&path, bytes)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
