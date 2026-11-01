//! Saving files the webview produces (sprite exports and projects). The save
//! dialog runs here, so the webview never chooses where a file is written.

use std::fs;
use std::path::PathBuf;

use tauri::WebviewWindow;
use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_dialog::DialogExt;

use crate::error::{Error, Result};

fn header(request: &Request<'_>, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// Asks where to save, with an optional suggested name and a filter of one
/// extension (without the dot). Returns `None` when the dialog was closed.
///
/// The dialog blocks until it closes, so it runs on a blocking thread rather
/// than holding one of the async runtime's workers for that long.
pub async fn ask_save_path(
    window: &WebviewWindow,
    file_name: Option<String>,
    filter: Option<(String, String)>,
) -> Result<Option<PathBuf>> {
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = window.dialog().file().set_parent(&window);
        if let Some(name) = file_name {
            dialog = dialog.set_file_name(name);
        }
        if let Some((name, ext)) = filter {
            dialog = dialog.add_filter(name, &[ext.as_str()]);
        }
        dialog
            .blocking_save_file()
            .map(|path| path.into_path().map_err(|err| Error::msg(err.to_string())))
            .transpose()
    })
    .await
    .map_err(|err| Error::msg(err.to_string()))?
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
    let filter = header(&request, "x-filter-name").zip(header(&request, "x-filter-ext"));
    let Some(path) = ask_save_path(&window, header(&request, "x-file-name"), filter).await? else {
        return Ok(None);
    };
    fs::write(&path, bytes)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
