mod audio;
mod commands;
mod settings;

use audio::microphone::MicCapture;
use audio::SystemAudioCapture;
use commands::audio::AudioState;
use commands::deepgram::DeepgramState;
use commands::local_pipeline::LocalPipelineState;
use commands::text_translate::TextTranslatorState;
use settings::{Settings, SettingsState};
use std::sync::{Arc, Mutex};

#[tauri::command]
fn get_platform_info() -> String {
    format!(
        r#"{{"os":"{}","arch":"{}","version":"0.3.0"}}"#,
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load settings from disk (or defaults)
    let initial_settings = Settings::load();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            Ok(())
        })
        .manage(SettingsState(Mutex::new(initial_settings)))
        .manage(AudioState {
            system_audio: Mutex::new(SystemAudioCapture::new()),
            microphone: Mutex::new(MicCapture::new()),
            active_receiver: Mutex::new(None),
        })
        .manage(LocalPipelineState {
            process: Mutex::new(None),
        })
        .manage(TextTranslatorState {
            process: Arc::new(Mutex::new(None)),
        })
        .manage(DeepgramState {
            session: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::audio::start_capture,
            commands::audio::stop_capture,
            commands::audio::check_permissions,
            commands::transcript::save_transcript,
            commands::transcript::open_transcript_dir,
            commands::transcript::open_local_data_dir,
            commands::transcript::list_transcripts,
            commands::transcript::get_transcript,
            commands::transcript::delete_transcript,
            commands::local_pipeline::start_local_pipeline,
            commands::local_pipeline::send_audio_to_pipeline,
            commands::local_pipeline::stop_local_pipeline,
            commands::local_pipeline::check_local_setup,
            commands::local_pipeline::is_local_setup_running,
            commands::local_pipeline::detect_local_python,
            commands::local_pipeline::detect_local_env_in_use,
            commands::local_pipeline::kill_blocking_local_processes,
            commands::local_pipeline::run_local_setup,
            commands::text_translate::start_text_translator,
            commands::text_translate::prepare_text_translation,
            commands::text_translate::translate_text,
            commands::text_translate::stop_text_translator,
            commands::deepgram::create_deepgram_token,
            commands::deepgram::deepgram_self_test,
            commands::deepgram::append_deepgram_log,
            commands::deepgram::start_deepgram_stream,
            commands::deepgram::start_capture_to_deepgram,
            commands::deepgram::send_audio_to_deepgram,
            commands::deepgram::stop_deepgram_stream,
            commands::edge_tts::edge_tts_speak,
            commands::azure_speech::azure_tts_speak,
            commands::azure_speech::azure_stt_recognize,
            get_platform_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
