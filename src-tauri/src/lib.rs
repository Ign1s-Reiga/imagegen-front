mod error;
mod files;
mod gallery;
mod secrets;
mod training;

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
            app.manage(training::Training::open(app.handle())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            gallery::gallery_write_image,
            gallery::gallery_commit,
            gallery::gallery_discard_images,
            gallery::gallery_list,
            gallery::gallery_delete_generation,
            gallery::gallery_delete_image,
            gallery::gallery_set_favorite,
            gallery::gallery_read_image,
            gallery::gallery_export_image,
            gallery::gallery_dir,
            files::save_file,
            training::training_projects,
            training::training_project_create,
            training::training_project_update,
            training::training_project_delete,
            training::training_dir,
            training::training_items,
            training::training_import_dialog,
            training::training_import_bytes,
            training::training_item_patch,
            training::training_item_delete,
            training::training_caption_image,
            training::training_host_test,
            training::training_host_trust,
            training::training_host_preflight,
            training::training_host_setup,
            training::training_host_setup_status,
            training::training_runs,
            training::training_run_create,
            training::training_run_upload,
            training::training_run_start,
            training::training_run_resume,
            training::training_run_status,
            training::training_run_cancel,
            training::training_run_cleanup_remote,
            training::training_run_delete,
            training::training_artifact_register,
            training::training_artifacts,
            training::training_artifact_export,
            training::training_artifact_install,
            training::training_artifact_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
