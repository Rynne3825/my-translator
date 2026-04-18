use serde::Serialize;
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use crate::settings::Settings;

pub struct TextTranslatorState {
    pub process: Arc<Mutex<Option<TextTranslatorProcess>>>,
}

pub(crate) struct TextTranslatorProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[derive(Debug, Serialize)]
pub struct TranslationResponse {
    pub translated: String,
    pub engine: String,
    pub model: String,
    pub normalized_text: String,
    pub normalization_applied: bool,
}

fn app_data_dir() -> PathBuf {
    let mut path = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    path.push("My Translator");
    path
}

fn local_env_dir() -> PathBuf {
    app_data_dir().join("local-env")
}

fn venv_python_path(env_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        env_dir.join("Scripts").join("python.exe")
    } else {
        env_dir.join("bin").join("python3")
    }
}

fn setup_marker_path(env_dir: &Path) -> PathBuf {
    env_dir.join(".setup_complete")
}

fn resolve_script(script_rel_path: &str) -> Result<PathBuf, String> {
    let script_basename = Path::new(script_rel_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(script_rel_path)
        .to_string();

    let mut candidates = vec![
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../scripts/{}", script_rel_path)),
        PathBuf::from(format!("scripts/{}", script_rel_path)),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../scripts/{}", script_basename)),
        PathBuf::from(format!("scripts/{}", script_basename)),
    ];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(format!("../Resources/scripts/{}", script_rel_path)));
            candidates.push(parent.join(format!("../Resources/scripts/{}", script_basename)));
        }
    }

    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| format!("Required script not found: {}", script_rel_path))
}

fn stop_text_translator_inner(process: &Arc<Mutex<Option<TextTranslatorProcess>>>) {
    if let Ok(mut proc) = process.lock() {
        if let Some(mut process) = proc.take() {
            let _ = process.stdin.flush();
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }
}

fn start_text_translator_sync(process: &Arc<Mutex<Option<TextTranslatorProcess>>>) -> Result<(), String> {
    {
        let mut slot = process.lock().map_err(|e| e.to_string())?;
        if let Some(process) = slot.as_mut() {
            match process.child.try_wait() {
                Ok(None) => {
                    return Ok(());
                }
                Ok(Some(_)) | Err(_) => {
                    let _ = process.stdin.flush();
                    let _ = process.child.kill();
                    let _ = process.child.wait();
                    *slot = None;
                }
            }
        }
    }

    let env_dir = local_env_dir();
    let marker = setup_marker_path(&env_dir);
    let python = venv_python_path(&env_dir);
    if !marker.exists() || !python.exists() {
        return Err("Local translation environment is required before translation can start.".to_string());
    }

    let script_path = resolve_script("translate/text_translate.py")?;
    let mut child = Command::new(&python)
        .arg(&script_path)
        .env("MY_TRANSLATOR_ENV_DIR", env_dir.to_string_lossy().to_string())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start text translator: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to capture translator stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture translator stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture translator stderr")?;
    let mut stdout_reader = BufReader::new(stdout);

    let mut ready_line = String::new();
    stdout_reader
        .read_line(&mut ready_line)
        .map_err(|e| format!("Failed to read translator ready message: {}", e))?;
    let ready_payload: serde_json::Value = serde_json::from_str(ready_line.trim())
        .map_err(|e| format!("Translator emitted invalid ready message: {}", e))?;
    if ready_payload.get("type").and_then(|v| v.as_str()) != Some("ready") {
        return Err("Text translator failed to initialize.".to_string());
    }

    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(line) = line {
                eprintln!("[text-translator] {}", line);
            }
        }
    });

    let translator_process = TextTranslatorProcess {
        child,
        stdin,
        stdout: stdout_reader,
    };

    let mut slot = process.lock().map_err(|e| e.to_string())?;
    *slot = Some(translator_process);
    Ok(())
}

#[tauri::command]
pub async fn start_text_translator(state: tauri::State<'_, TextTranslatorState>) -> Result<(), String> {
    let process = state.process.clone();
    tauri::async_runtime::spawn_blocking(move || start_text_translator_sync(&process))
        .await
        .map_err(|e| format!("Failed to join text translator startup: {}", e))?
}

fn translate_text_sync(
    text: String,
    source_lang: String,
    target_lang: String,
    translation_model: Option<String>,
    settings: Settings,
    process: &Arc<Mutex<Option<TextTranslatorProcess>>>,
) -> Result<TranslationResponse, String> {
    let mut guard = process.lock().map_err(|e| e.to_string())?;
    let process = guard
        .as_mut()
        .ok_or_else(|| "Text translator is not running.".to_string())?;

    let request = json!({
        "text": text,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "translation_model": translation_model.unwrap_or_else(|| "marian".to_string()),
        "azure_key1": settings.azure_translator_key1,
        "azure_key2": settings.azure_translator_key2,
        "azure_region": settings.azure_translator_region,
        "azure_endpoint": settings.azure_translator_endpoint,
    });
    writeln!(process.stdin, "{}", request)
        .map_err(|e| format!("Failed to write to text translator: {}", e))?;
    process
        .stdin
        .flush()
        .map_err(|e| format!("Failed to flush text translator stdin: {}", e))?;

    let mut line = String::new();
    process
        .stdout
        .read_line(&mut line)
        .map_err(|e| format!("Failed to read text translator response: {}", e))?;
    if line.trim().is_empty() {
        return Err("Text translator returned an empty response.".to_string());
    }

    let response: serde_json::Value =
        serde_json::from_str(line.trim()).map_err(|e| format!("Invalid translator response: {}", e))?;
    if response.get("type").and_then(|v| v.as_str()) == Some("error") {
        let message = response
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown translation error");
        return Err(message.to_string());
    }

    Ok(TranslationResponse {
        translated: response
            .get("translated")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        engine: response
            .get("engine")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        model: response
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        normalized_text: response
            .get("normalized_text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        normalization_applied: response
            .get("normalization_applied")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

#[tauri::command]
pub async fn translate_text(
    text: String,
    source_lang: String,
    target_lang: String,
    translation_model: Option<String>,
    settings_state: tauri::State<'_, crate::settings::SettingsState>,
    state: tauri::State<'_, TextTranslatorState>,
) -> Result<TranslationResponse, String> {
    let process = state.process.clone();
    let settings = settings_state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        translate_text_sync(text, source_lang, target_lang, translation_model, settings, &process)
    })
    .await
    .map_err(|e| format!("Failed to join text translation task: {}", e))?
}

fn prepare_text_translation_sync(
    source_lang: String,
    target_lang: String,
    translation_model: Option<String>,
    settings: Settings,
    process: &Arc<Mutex<Option<TextTranslatorProcess>>>,
) -> Result<(), String> {
    let mut guard = process.lock().map_err(|e| e.to_string())?;
    let process = guard
        .as_mut()
        .ok_or_else(|| "Text translator is not running.".to_string())?;

    let request = json!({
        "prepare": true,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "translation_model": translation_model.unwrap_or_else(|| "marian".to_string()),
        "azure_key1": settings.azure_translator_key1,
        "azure_key2": settings.azure_translator_key2,
        "azure_region": settings.azure_translator_region,
        "azure_endpoint": settings.azure_translator_endpoint,
    });
    writeln!(process.stdin, "{}", request)
        .map_err(|e| format!("Failed to write prepare request to text translator: {}", e))?;
    process
        .stdin
        .flush()
        .map_err(|e| format!("Failed to flush text translator stdin: {}", e))?;

    let mut line = String::new();
    process
        .stdout
        .read_line(&mut line)
        .map_err(|e| format!("Failed to read text translator prepare response: {}", e))?;
    if line.trim().is_empty() {
        return Err("Text translator prepare returned an empty response.".to_string());
    }

    let response: serde_json::Value =
        serde_json::from_str(line.trim()).map_err(|e| format!("Invalid translator prepare response: {}", e))?;
    if response.get("type").and_then(|v| v.as_str()) == Some("error") {
        let message = response
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown translation prepare error");
        return Err(message.to_string());
    }
    if response.get("type").and_then(|v| v.as_str()) != Some("prepared") {
        return Err("Text translator did not confirm preparation.".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn prepare_text_translation(
    source_lang: String,
    target_lang: String,
    translation_model: Option<String>,
    settings_state: tauri::State<'_, crate::settings::SettingsState>,
    state: tauri::State<'_, TextTranslatorState>,
) -> Result<(), String> {
    let process = state.process.clone();
    let settings = settings_state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        prepare_text_translation_sync(source_lang, target_lang, translation_model, settings, &process)
    })
    .await
    .map_err(|e| format!("Failed to join translator prepare task: {}", e))?
}

#[tauri::command]
pub async fn stop_text_translator(state: tauri::State<'_, TextTranslatorState>) -> Result<(), String> {
    let process = state.process.clone();
    tauri::async_runtime::spawn_blocking(move || {
        stop_text_translator_inner(&process);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Failed to join text translator stop task: {}", e))??;
    Ok(())
}
