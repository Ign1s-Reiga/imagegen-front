mod error;
mod files;
mod gallery;
mod secrets;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.manage(gallery::Gallery::open(app.handle())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            gallery::gallery_write_image,
            gallery::gallery_commit,
            gallery::gallery_list,
            gallery::gallery_delete_generation,
            gallery::gallery_delete_image,
            gallery::gallery_set_favorite,
            gallery::gallery_read_image,
            gallery::gallery_export_image,
            gallery::gallery_dir,
            files::save_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
