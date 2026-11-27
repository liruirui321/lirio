mod commands;
#[cfg(target_os = "macos")]
mod command_key;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            command_key::install(app);
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            Ok(())
        })
        .manage(commands::transcribe::AsrState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::project::get_app_data_dir,
            commands::project::get_storage_info,
            commands::project::set_storage_dir,
            commands::project::reset_storage_dir,
            commands::project::open_storage_dir,
            commands::project::inspect_audio_file,
            commands::project::read_audio_file_bytes,
            commands::transcribe::transcribe_audio,
            commands::transcribe::cancel_transcription,
            commands::history::submission_record,
            commands::history::submission_list,
            commands::library::library_list,
            commands::library::library_open,
            commands::library::library_add,
            commands::library::library_delete,
            commands::library::library_save_progress,
            commands::corpus::corpus_fetch_audio,
            commands::speak::speak_transcribe,
            commands::speak::speak_chat_remote,
            commands::speak::speak_chat_local,
            commands::speak::speak_tts,
            commands::speak::podcast_download_latest,
            commands::speak::open_mic_settings,
            commands::state::app_state_load,
            commands::state::app_state_save,
            commands::net::lirio_direct_request,
            commands::net::lirio_direct_chat_stream,
            commands::net::diagnose_environment,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
