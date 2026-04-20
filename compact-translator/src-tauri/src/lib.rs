mod audio;
mod commands;
mod settings;

use audio::microphone::MicCapture;
use audio::SystemAudioCapture;
use commands::audio::AudioState;
use commands::deepgram::DeepgramState;
use settings::{Settings, SettingsState};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock};

static STARTUP_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static STARTUP_LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn startup_log_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("com.personal.compacttranslator");
    path.push("logs");
    path.push("startup.log");
    path
}

fn append_startup_log(message: &str) {
    let lock = STARTUP_LOG_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().ok();

    let path = STARTUP_LOG_PATH
        .get_or_init(startup_log_path)
        .to_path_buf();

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            file,
            "[{}] {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            message
        );
    }
}

fn init_startup_logging() {
    let _ = STARTUP_LOG_PATH.set(startup_log_path());
    append_startup_log("===== compact-translator startup =====");
    append_startup_log(&format!("pid={}", std::process::id()));

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        append_startup_log(&format!("panic: {}", panic_info));
        default_hook(panic_info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_startup_logging();
    append_startup_log("run() entered");

    let heartbeat_running = Arc::new(AtomicBool::new(true));
    let heartbeat_flag = heartbeat_running.clone();
    std::thread::spawn(move || {
        for tick in 1..=15 {
            if !heartbeat_flag.load(Ordering::SeqCst) {
                break;
            }
            append_startup_log(&format!("heartbeat tick={}", tick));
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });

    let initial_settings = Settings::load();
    append_startup_log("settings loaded");

    append_startup_log("building tauri app");
    let result = tauri::Builder::default()
        .setup(|app| {
            append_startup_log(&format!(
                "setup ok: app_name={} version={}",
                app.package_info().name,
                app.package_info().version
            ));
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                append_startup_log(&format!("window close requested: {}", window.label()));
            }
            tauri::WindowEvent::Destroyed => {
                append_startup_log(&format!("window destroyed: {}", window.label()));
            }
            _ => {}
        })
        .manage(SettingsState(Mutex::new(initial_settings)))
        .manage(AudioState {
            system_audio: Mutex::new(SystemAudioCapture::new()),
            microphone: Mutex::new(MicCapture::new()),
            active_receiver: Mutex::new(None),
        })
        .manage(DeepgramState::new())
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::audio::start_capture,
            commands::audio::stop_capture,
            commands::audio::check_permissions,
            commands::deepgram::create_deepgram_token,
            commands::deepgram::start_deepgram_stream,
            commands::deepgram::start_capture_to_deepgram,
            commands::deepgram::send_audio_to_deepgram,
            commands::deepgram::stop_deepgram_stream,
            commands::azure_speech::azure_translate_text,
            commands::azure_speech::azure_tts_speak,
            commands::edge_tts::edge_tts_speak,
            commands::transcript::save_transcript,
            commands::transcript::open_transcript_dir,
            commands::transcript::list_transcripts,
            commands::transcript::get_transcript,
            commands::transcript::delete_transcript,
        ]);

    append_startup_log("calling tauri run()");
    let result = result
        .run(tauri::generate_context!());

    heartbeat_running.store(false, Ordering::SeqCst);

    if let Err(err) = result {
        append_startup_log(&format!("tauri run error: {}", err));
        panic!("error while running tauri application: {}", err);
    }

    append_startup_log("run() returned Ok");
}
