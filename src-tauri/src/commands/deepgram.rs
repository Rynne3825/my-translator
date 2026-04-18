use crate::commands::audio::{start_capture_receiver, stop_capture_inner, AudioForwarder, AudioState};
use crate::settings::SettingsState;
use futures_util::{SinkExt, StreamExt};
use http::header::AUTHORIZATION;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

pub struct DeepgramState {
    pub session: Mutex<Option<DeepgramSession>>,
}

pub struct DeepgramSession {
    id: u64,
    sender: mpsc::UnboundedSender<DeepgramCommand>,
    thread: JoinHandle<()>,
}

enum DeepgramCommand {
    Audio(Vec<u8>),
    Stop,
}

#[derive(Deserialize)]
pub struct SelfTestRequest {
    source_lang: Option<String>,
    target_lang: Option<String>,
    translation_model: Option<String>,
}

#[derive(Deserialize)]
struct TokenGrantResponse {
    access_token: String,
}

static NEXT_DEEPGRAM_SESSION_ID: AtomicU64 = AtomicU64::new(1);

fn deepgram_language(source_lang: &str) -> Option<String> {
    let normalized = source_lang.trim().to_lowercase();
    match normalized.as_str() {
        "" | "auto" => Some("multi".to_string()),
        "zh" => Some("zh".to_string()),
        code => Some(code.to_string()),
    }
}

fn stop_deepgram_stream_inner(state: &DeepgramState) {
    if let Ok(mut slot) = state.session.lock() {
        if let Some(session) = slot.take() {
            deepgram_log(&format!("stopping session={}", session.id));
            let _ = session.sender.send(DeepgramCommand::Stop);
            std::thread::spawn(move || {
                let _ = session.thread.join();
            });
        }
    }
}

fn build_deepgram_url(source_lang: &str, endpoint_delay: u32, fast_mode: bool) -> Result<String, String> {
    let mut url = reqwest::Url::parse("wss://api.deepgram.com/v1/listen")
        .map_err(|e| format!("Failed to build Deepgram URL: {}", e))?;

    let resolved_endpoint_delay = endpoint_delay.max(10);

    {
        let mut query = url.query_pairs_mut();
        query.append_pair("model", "nova-3");
        query.append_pair("encoding", "linear16");
        query.append_pair("sample_rate", "16000");
        query.append_pair("channels", "1");
        query.append_pair("interim_results", "true");
        query.append_pair("smart_format", "true");
        query.append_pair("diarize", if fast_mode { "false" } else { "true" });
        query.append_pair("endpointing", &resolved_endpoint_delay.to_string());
        query.append_pair("punctuate", "true");
        // NOTE:
        // `vad_events` / `utterance_end_ms` caused intermittent HTTP 400 on the
        // current Deepgram realtime endpoint with `nova-3` in this app flow.
        // Keep Fast Mode stable by only disabling diarization and relying on
        // endpointing + frontend commit logic for low-latency behavior.
        if let Some(lang) = deepgram_language(source_lang) {
            query.append_pair("language", &lang);
        }
    }

    Ok(url.to_string())
}

fn speaker_from_words(words: &[Value]) -> Option<i64> {
    words.iter()
        .find_map(|word| word.get("speaker").and_then(|v| v.as_i64()))
}

fn average_confidence(words: &[Value], fallback: Option<f64>) -> Option<f64> {
    let mut sum = 0.0;
    let mut count = 0.0;
    for word in words {
        if let Some(confidence) = word.get("confidence").and_then(|v| v.as_f64()) {
            sum += confidence;
            count += 1.0;
        }
    }

    if count > 0.0 {
        Some(sum / count)
    } else {
        fallback
    }
}

fn detected_language(alternative: &Value, source_lang: &str) -> Value {
    if source_lang != "auto" {
        return json!(source_lang);
    }

    if let Some(lang) = alternative.get("detected_language").and_then(|v| v.as_str()) {
        return json!(lang);
    }
    if let Some(lang) = alternative
        .get("languages")
        .and_then(|v| v.as_array())
        .and_then(|langs| langs.first())
        .and_then(|v| v.as_str())
    {
        return json!(lang);
    }
    Value::Null
}

fn emit_result(channel: &Channel<String>, payload: Value) {
    let _ = channel.send(payload.to_string());
}

fn preview_text(text: &str) -> String {
    let collapsed = text.replace('\r', " ").replace('\n', " ");
    let mut chars = collapsed.chars();
    let preview: String = chars.by_ref().take(120).collect();
    if chars.next().is_some() {
        format!("{}...", preview)
    } else {
        preview
    }
}

fn app_local_dir() -> PathBuf {
    let mut path = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    path.push("My Translator");
    path
}

fn deepgram_log_path() -> PathBuf {
    app_local_dir().join("deepgram.log")
}

fn deepgram_log(message: &str) {
    let dir = app_local_dir();
    let _ = fs::create_dir_all(&dir);
    let path = deepgram_log_path();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(file, "[{}] {}", now, message);
    }
}

#[tauri::command]
pub fn append_deepgram_log(message: String) -> Result<(), String> {
    deepgram_log(&message);
    Ok(())
}

fn local_env_dir() -> PathBuf {
    app_local_dir().join("local-env")
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

fn map_deepgram_auth_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "Timed out contacting Deepgram auth service. Check your firewall, proxy, VPN, or antivirus network filtering.".to_string()
    } else if error.is_connect() {
        format!("Could not connect to Deepgram auth service: {}", error)
    } else {
        format!("Failed to contact Deepgram auth service: {}", error)
    }
}

#[cfg(target_os = "windows")]
async fn create_deepgram_token_via_powershell(api_key: &str) -> Result<String, String> {
    let api_key = api_key.to_string();
    let output = tokio::task::spawn_blocking(move || {
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "$headers = @{ Authorization = ('Token ' + $env:DEEPGRAM_API_KEY); 'Content-Type' = 'application/json' }; \
                 $body = '{\"comment\":\"my-translator\",\"ttl_seconds\":30}'; \
                 Invoke-RestMethod -Method Post -Uri 'https://api.deepgram.com/v1/auth/grant' -Headers $headers -Body $body | ConvertTo-Json -Compress",
            ])
            .env("DEEPGRAM_API_KEY", api_key)
            .output()
    })
    .await
    .map_err(|e| format!("Failed to join PowerShell auth task: {}", e))?
    .map_err(|e| format!("Failed to start PowerShell Deepgram auth fallback: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(format!(
            "PowerShell Deepgram auth fallback failed. stdout: {} stderr: {}",
            stdout, stderr
        ));
    }

    let stdout = String::from_utf8(output.stdout)
        .map_err(|e| format!("PowerShell auth output was not valid UTF-8: {}", e))?;
    let token: TokenGrantResponse = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse PowerShell Deepgram token response: {}", e))?;
    Ok(token.access_token)
}

async fn create_deepgram_token_inner(api_key: &str) -> Result<String, String> {
    eprintln!("[deepgram] requesting temporary token");
    deepgram_log("requesting temporary token");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build Deepgram auth client: {}", e))?;

    let response = match client
        .post("https://api.deepgram.com/v1/auth/grant")
        .header("Authorization", format!("Token {}", api_key))
        .json(&json!({
            "comment": "my-translator",
            "ttl_seconds": 30
        }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            eprintln!("[deepgram] auth request failed: {:?}", error);
            deepgram_log(&format!("auth request failed: {:?}", error));
            #[cfg(target_os = "windows")]
            if error.is_timeout() {
                eprintln!("[deepgram] retrying auth via PowerShell fallback");
                deepgram_log("retrying auth via PowerShell fallback");
                match create_deepgram_token_via_powershell(api_key).await {
                    Ok(token) => {
                        eprintln!("[deepgram] temporary token created successfully via PowerShell fallback");
                        deepgram_log("temporary token created successfully via PowerShell fallback");
                        return Ok(token);
                    }
                    Err(fallback_error) => {
                        eprintln!("[deepgram] PowerShell fallback failed: {}", fallback_error);
                        deepgram_log(&format!("PowerShell fallback failed: {}", fallback_error));
                    }
                }
            }
            return Err(map_deepgram_auth_error(&error));
        }
    };

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        eprintln!("[deepgram] auth request returned {}: {}", status, body);
        deepgram_log(&format!("auth request returned {}: {}", status, body));
        let message = match status.as_u16() {
            401 | 403 => "Deepgram API key is invalid or unauthorized.".to_string(),
            429 => "Deepgram rate limit reached while creating a token.".to_string(),
            _ => format!("Deepgram token request failed ({}): {}", status, body),
        };
        return Err(message);
    }

    let token: TokenGrantResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse Deepgram token response: {}", e))?;
    eprintln!("[deepgram] temporary token created successfully");
    deepgram_log("temporary token created successfully");
    Ok(token.access_token)
}

#[tauri::command]
pub async fn create_deepgram_token(
    state: tauri::State<'_, SettingsState>,
) -> Result<String, String> {
    let api_key = {
        let settings = state.0.lock().map_err(|e| e.to_string())?;
        settings.deepgram_api_key.clone()
    };
    if api_key.trim().is_empty() {
        return Err("Deepgram API key is required. Add it in Settings.".to_string());
    }
    create_deepgram_token_inner(&api_key).await
}

#[tauri::command]
pub async fn start_deepgram_stream(
    source_lang: String,
    endpoint_delay: Option<u32>,
    fast_mode: Option<bool>,
    channel: Channel<String>,
    state: tauri::State<'_, DeepgramState>,
    settings: tauri::State<'_, SettingsState>,
) -> Result<(), String> {
    stop_deepgram_stream_inner(&state);

    let api_key = {
        let settings = settings.0.lock().map_err(|e| e.to_string())?;
        if settings.deepgram_api_key.trim().is_empty() {
            return Err("Deepgram API key is required. Add it in Settings.".to_string());
        }
        settings.deepgram_api_key.clone()
    };

    let token = create_deepgram_token_inner(&api_key).await?;
    let resolved_endpoint_delay = endpoint_delay.unwrap_or(3000);
    let resolved_fast_mode = fast_mode.unwrap_or(false);
    let url = build_deepgram_url(&source_lang, resolved_endpoint_delay, resolved_fast_mode)?;
    let session_id = NEXT_DEEPGRAM_SESSION_ID.fetch_add(1, Ordering::SeqCst);
    eprintln!("[deepgram] opening websocket {}", url);
    deepgram_log(&format!(
        "session={} starting source_lang={} endpoint_delay={} fast_mode={} opening websocket {}",
        session_id, source_lang, resolved_endpoint_delay, resolved_fast_mode, url
    ));
    let (sender, mut receiver) = mpsc::unbounded_channel::<DeepgramCommand>();
    let channel_clone = channel.clone();

    let thread = std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(err) => {
                emit_result(
                    &channel_clone,
                    json!({"type":"error","message": format!("Failed to initialize Deepgram runtime: {}", err)}),
                );
                return;
            }
        };

        runtime.block_on(async move {
            let mut request = match url.clone().into_client_request() {
                Ok(request) => request,
                Err(err) => {
                    emit_result(
                        &channel_clone,
                        json!({"type":"error","message": format!("Failed to build Deepgram request: {}", err)}),
                    );
                    return;
                }
            };

            let auth_header = match format!("Bearer {}", token).parse() {
                Ok(value) => value,
                Err(err) => {
                    emit_result(
                        &channel_clone,
                        json!({"type":"error","message": format!("Failed to encode Deepgram auth header: {}", err)}),
                    );
                    return;
                }
            };
            request.headers_mut().insert(AUTHORIZATION, auth_header);

            let connect_result = tokio::time::timeout(
                Duration::from_secs(15),
                connect_async(request),
            )
            .await;

            let (ws_stream, _) = match connect_result {
                Ok(Ok(result)) => result,
                Ok(Err(err)) => {
                    eprintln!("[deepgram] websocket connect failed: {:?}", err);
                    deepgram_log(&format!("websocket connect failed: {:?}", err));
                    emit_result(
                        &channel_clone,
                        json!({"type":"error","message": format!("Failed to connect to Deepgram: {}", err)}),
                    );
                    return;
                }
                Err(_) => {
                    eprintln!("[deepgram] websocket connect timed out");
                    deepgram_log("websocket connect timed out");
                    emit_result(
                        &channel_clone,
                        json!({"type":"error","message":"Timed out while opening Deepgram WebSocket. Check firewall, proxy, VPN, or antivirus network filtering."}),
                    );
                    return;
                }
            };

            let connected_at = Instant::now();
            let mut result_seq: u64 = 0;
            eprintln!("[deepgram] websocket connected");
            deepgram_log(&format!("session={} websocket connected", session_id));
            emit_result(&channel_clone, json!({"type":"ready"}));
            let (mut write, mut read) = ws_stream.split();
            let mut keepalive = tokio::time::interval(Duration::from_secs(8));

            loop {
                tokio::select! {
                    command = receiver.recv() => {
                        match command {
                            Some(DeepgramCommand::Audio(bytes)) => {
                                if let Err(err) = write.send(Message::Binary(bytes.into())).await {
                                    deepgram_log(&format!("session={} audio send failed: {}", session_id, err));
                                    emit_result(&channel_clone, json!({"type":"error","message": format!("Deepgram audio send failed: {}", err)}));
                                    break;
                                }
                            }
                            Some(DeepgramCommand::Stop) | None => {
                                deepgram_log(&format!("session={} received stop command", session_id));
                                let _ = write.send(Message::Close(None)).await;
                                break;
                            }
                        }
                    }
                    message = read.next() => {
                        match message {
                            Some(Ok(Message::Text(text))) => {
                                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                                    let message_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                    if message_type == "Results" {
                                        let alternative = value
                                            .get("channel")
                                            .and_then(|v| v.get("alternatives"))
                                            .and_then(|v| v.as_array())
                                            .and_then(|alts| alts.first())
                                            .cloned()
                                            .unwrap_or_else(|| json!({}));

                                        let transcript = alternative
                                            .get("transcript")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .trim()
                                            .to_string();
                                        if transcript.is_empty() {
                                            continue;
                                        }

                                        let words = alternative
                                            .get("words")
                                            .and_then(|v| v.as_array())
                                            .cloned()
                                            .unwrap_or_default();
                                        // In fast mode diarization is disabled, so ignore speaker tags
                                        // even if the payload still includes unstable speaker fields.
                                        let speaker = if resolved_fast_mode {
                                            None
                                        } else {
                                            speaker_from_words(&words)
                                        };
                                        let confidence = average_confidence(
                                            &words,
                                            alternative.get("confidence").and_then(|v| v.as_f64()),
                                        );
                                        let is_final = value.get("is_final").and_then(|v| v.as_bool()).unwrap_or(false);
                                        let speech_final = value.get("speech_final").and_then(|v| v.as_bool()).unwrap_or(false);
                                        let start_s = value.get("start").and_then(|v| v.as_f64());
                                        let duration_s = value.get("duration").and_then(|v| v.as_f64());
                                        let wall_ms = connected_at.elapsed().as_millis() as u64;
                                        result_seq += 1;
                                        let utterance_id = start_s
                                            .map(|start| {
                                                let start_cs = (start * 100.0).round() as i64;
                                                match speaker {
                                                    Some(s) => format!("spk{}-{}", s, start_cs),
                                                    None => format!("start-{}", start_cs),
                                                }
                                            })
                                            .unwrap_or_else(|| format!("seq-{}", result_seq));
                                        if is_final || result_seq <= 3 || result_seq % 10 == 0 {
                                            deepgram_log(&format!(
                                                "session={} result_seq={} type={} speech_final={} wall_ms={} start_s={:?} duration_s={:?} text={}",
                                                session_id,
                                                result_seq,
                                                if is_final { "final" } else { "interim" },
                                                speech_final,
                                                wall_ms,
                                                start_s,
                                                duration_s,
                                                preview_text(&transcript)
                                            ));
                                        }

                                        let language = detected_language(&alternative, &source_lang);
                                        emit_result(&channel_clone, json!({
                                            "type": if is_final { "original" } else { "provisional" },
                                            "text": transcript,
                                            "speaker": speaker,
                                            "language": language,
                                            "confidence": confidence,
                                            "speech_final": speech_final,
                                            "utterance_id": utterance_id,
                                            "timing": {
                                                "wall_ms": wall_ms,
                                                "start_s": start_s,
                                                "duration_s": duration_s,
                                            }
                                        }));
                                    } else if message_type == "UtteranceEnd" {
                                        deepgram_log(&format!("session={} utterance_end", session_id));
                                        emit_result(&channel_clone, json!({"type":"provisional","text":"","speech_final":true}));
                                    } else if message_type == "Metadata" {
                                        continue;
                                    } else if let Some(error_message) = value.get("err_msg").and_then(|v| v.as_str()) {
                                        deepgram_log(&format!("session={} stream error payload: {}", session_id, error_message));
                                        emit_result(&channel_clone, json!({"type":"error","message": error_message}));
                                    }
                                }
                            }
                            Some(Ok(Message::Close(frame))) => {
                                deepgram_log(&format!("session={} websocket close frame={:?}", session_id, frame));
                                break;
                            }
                            Some(Ok(_)) => {}
                            Some(Err(err)) => {
                                deepgram_log(&format!("session={} stream error: {}", session_id, err));
                                emit_result(&channel_clone, json!({"type":"error","message": format!("Deepgram stream error: {}", err)}));
                                break;
                            }
                            None => {
                                deepgram_log(&format!("session={} websocket read ended", session_id));
                                break;
                            }
                        }
                    }
                    _ = keepalive.tick() => {
                        let _ = write.send(Message::Text(r#"{"type":"KeepAlive"}"#.into())).await;
                    }
                }
            }

            deepgram_log(&format!("session={} done", session_id));
            emit_result(&channel_clone, json!({"type":"done"}));
        });
    });

    let mut slot = state.session.lock().map_err(|e| e.to_string())?;
    *slot = Some(DeepgramSession { id: session_id, sender, thread });
    Ok(())
}

#[tauri::command]
pub fn start_capture_to_deepgram(
    source: String,
    audio_state: tauri::State<'_, AudioState>,
    state: tauri::State<'_, DeepgramState>,
) -> Result<(), String> {
    stop_capture_inner(&audio_state);

    let receiver = start_capture_receiver(source.as_str(), &audio_state)?;
    let (session_id, sender) = {
        let slot = state.session.lock().map_err(|e| e.to_string())?;
        let session = slot
            .as_ref()
            .ok_or_else(|| "Deepgram stream is not running.".to_string())?;
        (session.id, session.sender.clone())
    };
    deepgram_log(&format!("session={} start_capture_to_deepgram source={}", session_id, source));

    let stop_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();
    std::thread::spawn(move || {
        let mut forwarded_batches: u64 = 0;
        let mut forwarded_bytes: usize = 0;

        loop {
            if stop_flag_clone.load(std::sync::atomic::Ordering::SeqCst) {
                deepgram_log(&format!(
                    "session={} audio forwarder stopping batches={} bytes={}",
                    session_id, forwarded_batches, forwarded_bytes
                ));
                break;
            }

            match receiver.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(data) => {
                    let byte_len = data.len();
                    if sender.send(DeepgramCommand::Audio(data)).is_err() {
                        deepgram_log(&format!("session={} audio forwarder could not send; session channel closed", session_id));
                        break;
                    }
                    forwarded_batches += 1;
                    forwarded_bytes += byte_len;
                    if forwarded_batches <= 3 || forwarded_batches % 100 == 0 {
                        deepgram_log(&format!(
                            "session={} audio_forward batch={} bytes={} total_bytes={}",
                            session_id, forwarded_batches, byte_len, forwarded_bytes
                        ));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    deepgram_log(&format!("session={} audio receiver disconnected", session_id));
                    break;
                }
            }
        }
        deepgram_log(&format!(
            "session={} audio forwarder thread ended batches={} bytes={}",
            session_id, forwarded_batches, forwarded_bytes
        ));
    });

    let forwarder = AudioForwarder::new(stop_flag);
    let mut active = audio_state
        .active_receiver
        .lock()
        .map_err(|e| e.to_string())?;
    *active = Some(forwarder);
    Ok(())
}

#[tauri::command]
pub fn send_audio_to_deepgram(
    data: Vec<u8>,
    state: tauri::State<'_, DeepgramState>,
) -> Result<(), String> {
    let slot = state.session.lock().map_err(|e| e.to_string())?;
    let session = slot
        .as_ref()
        .ok_or_else(|| "Deepgram stream is not running.".to_string())?;
    session
        .sender
        .send(DeepgramCommand::Audio(data))
        .map_err(|_| "Deepgram stream is closed.".to_string())
}

#[tauri::command]
pub fn stop_deepgram_stream(state: tauri::State<'_, DeepgramState>) -> Result<(), String> {
    stop_deepgram_stream_inner(&state);
    Ok(())
}

fn translator_self_test_inner(
    source_lang: &str,
    target_lang: &str,
    translation_model: &str,
) -> Result<Value, String> {
    let env_dir = local_env_dir();
    let marker = setup_marker_path(&env_dir);
    let python = venv_python_path(&env_dir);
    if !marker.exists() || !python.exists() {
        return Ok(json!({
            "ok": false,
            "step": "translator",
            "message": "Whisper Local setup is required before Deepgram translation can be tested."
        }));
    }

    let script_path = resolve_script("translate/text_translate.py")?;
    let mut child = Command::new(&python)
        .arg(&script_path)
        .env("MY_TRANSLATOR_ENV_DIR", env_dir.to_string_lossy().to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start text translator self-test: {}", e))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture translator stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture translator stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture translator stderr".to_string())?;

    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            deepgram_log(&format!("translator self-test stderr: {}", line));
        }
    });

    let mut stdout_reader = BufReader::new(stdout);
    let mut ready_line = String::new();
    stdout_reader
        .read_line(&mut ready_line)
        .map_err(|e| format!("Failed to read translator ready message: {}", e))?;

    let ready_payload: serde_json::Value = serde_json::from_str(ready_line.trim())
        .map_err(|e| format!("Translator self-test emitted invalid ready message: {}", e))?;
    if ready_payload.get("type").and_then(|v| v.as_str()) != Some("ready") {
        return Err("Text translator failed to initialize during self-test.".to_string());
    }

    let prepare_request = json!({
        "prepare": true,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "translation_model": translation_model,
    });
    writeln!(stdin, "{}", prepare_request)
        .map_err(|e| format!("Failed to write translator self-test request: {}", e))?;
    stdin
        .flush()
        .map_err(|e| format!("Failed to flush translator self-test stdin: {}", e))?;

    let mut prepare_line = String::new();
    stdout_reader
        .read_line(&mut prepare_line)
        .map_err(|e| format!("Failed to read translator self-test prepare response: {}", e))?;
    let prepare_response: serde_json::Value = serde_json::from_str(prepare_line.trim())
        .map_err(|e| format!("Invalid translator self-test prepare response: {}", e))?;
    if prepare_response.get("type").and_then(|v| v.as_str()) == Some("error") {
        let message = prepare_response
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown translation prepare error");
        let _ = child.kill();
        let _ = child.wait();
        return Ok(json!({
            "ok": false,
            "step": "translator",
            "message": message
        }));
    }

    let request = json!({
        "text": "hello world",
        "source_lang": source_lang,
        "target_lang": target_lang,
        "translation_model": translation_model,
    });
    writeln!(stdin, "{}", request)
        .map_err(|e| format!("Failed to write translator self-test request: {}", e))?;
    stdin
        .flush()
        .map_err(|e| format!("Failed to flush translator self-test stdin: {}", e))?;

    let mut response_line = String::new();
    stdout_reader
        .read_line(&mut response_line)
        .map_err(|e| format!("Failed to read translator self-test response: {}", e))?;

    let _ = child.kill();
    let _ = child.wait();

    if response_line.trim().is_empty() {
        return Err("Text translator self-test returned an empty response.".to_string());
    }

    let response: serde_json::Value = serde_json::from_str(response_line.trim())
        .map_err(|e| format!("Invalid translator self-test response: {}", e))?;
    if response.get("type").and_then(|v| v.as_str()) == Some("error") {
        let message = response
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown translation error");
        return Ok(json!({
            "ok": false,
            "step": "translator",
            "message": message
        }));
    }

    Ok(json!({
        "ok": true,
        "step": "translator",
        "translated": response.get("translated").and_then(|v| v.as_str()).unwrap_or_default(),
        "engine": response.get("engine").and_then(|v| v.as_str()).unwrap_or_default(),
        "model": response.get("model").and_then(|v| v.as_str()).unwrap_or_default(),
    }))
}

#[tauri::command]
pub async fn deepgram_self_test(
    request: Option<SelfTestRequest>,
    settings: tauri::State<'_, SettingsState>,
) -> Result<String, String> {
    let (api_key, source_lang, target_lang, translation_model) = {
        let settings = settings.0.lock().map_err(|e| e.to_string())?;
        let req = request.unwrap_or(SelfTestRequest {
            source_lang: None,
            target_lang: None,
            translation_model: None,
        });
        (
            settings.deepgram_api_key.clone(),
            req.source_lang.unwrap_or_else(|| settings.source_language.clone()),
            req.target_lang.unwrap_or_else(|| settings.target_language.clone()),
            req.translation_model.unwrap_or_else(|| settings.translation_model.clone()),
        )
    };

    if api_key.trim().is_empty() {
        return Err("Deepgram API key is required. Add it in Settings.".to_string());
    }

    let effective_source = if source_lang == "auto" { "en".to_string() } else { source_lang };
    deepgram_log("starting self-test");

    let token = create_deepgram_token_inner(&api_key).await?;
    let url = build_deepgram_url(&effective_source, 3000, false)?;
    deepgram_log(&format!("self-test websocket {}", url));

    let mut request = url
        .clone()
        .into_client_request()
        .map_err(|e| format!("Failed to build Deepgram self-test request: {}", e))?;
    let auth_header = format!("Bearer {}", token)
        .parse()
        .map_err(|e| format!("Failed to encode Deepgram self-test auth header: {}", e))?;
    request.headers_mut().insert(AUTHORIZATION, auth_header);

    let websocket_result = match tokio::time::timeout(Duration::from_secs(15), connect_async(request)).await {
        Ok(Ok((ws_stream, _))) => {
            deepgram_log("self-test websocket connected");
            let (mut write, _) = ws_stream.split();
            let _ = write.send(Message::Close(None)).await;
            json!({"ok": true, "step": "websocket"})
        }
        Ok(Err(err)) => {
            deepgram_log(&format!("self-test websocket failed: {}", err));
            json!({"ok": false, "step": "websocket", "message": err.to_string()})
        }
        Err(_) => {
            deepgram_log("self-test websocket timed out");
            json!({"ok": false, "step": "websocket", "message": "Timed out while opening Deepgram WebSocket."})
        }
    };

    let translator_result = if effective_source == target_lang {
        json!({"ok": true, "step": "translator", "skipped": true})
    } else {
        tokio::task::spawn_blocking(move || {
            translator_self_test_inner(&effective_source, &target_lang, &translation_model)
        })
            .await
            .map_err(|e| format!("Failed to join translator self-test task: {}", e))??
    };

    let ok = websocket_result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false)
        && translator_result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);

    Ok(json!({
        "ok": ok,
        "auth": {"ok": true},
        "websocket": websocket_result,
        "translator": translator_result,
        "log_path": deepgram_log_path().to_string_lossy().to_string()
    }).to_string())
}
