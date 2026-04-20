use crate::commands::audio::{start_capture_receiver, stop_capture_inner, AudioForwarder, AudioState};
use crate::settings::SettingsState;
use futures_util::{SinkExt, StreamExt};
use http::header::AUTHORIZATION;
use serde_json::{json, Value};
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
    session: Mutex<Option<DeepgramSession>>,
}

impl DeepgramState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }
}

struct DeepgramSession {
    id: u64,
    sender: mpsc::UnboundedSender<DeepgramCommand>,
    thread: JoinHandle<()>,
}

enum DeepgramCommand {
    Audio(Vec<u8>),
    Stop,
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

fn deepgram_language(source_lang: &str) -> Option<String> {
    let normalized = source_lang.trim().to_lowercase();
    match normalized.as_str() {
        "" | "auto" => Some("multi".to_string()),
        "zh" => Some("zh".to_string()),
        code => Some(code.to_string()),
    }
}

fn build_deepgram_url(source_lang: &str, endpoint_delay: u32) -> Result<String, String> {
    let mut url = reqwest::Url::parse("wss://api.deepgram.com/v1/listen")
        .map_err(|e| format!("Failed to build Deepgram URL: {}", e))?;

    let resolved_delay = endpoint_delay.max(10);
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("model", "nova-3");
        query.append_pair("encoding", "linear16");
        query.append_pair("sample_rate", "16000");
        query.append_pair("channels", "1");
        query.append_pair("interim_results", "true");
        query.append_pair("smart_format", "true");
        query.append_pair("diarize", "false");
        query.append_pair("endpointing", &resolved_delay.to_string());
        query.append_pair("punctuate", "true");
        if let Some(lang) = deepgram_language(source_lang) {
            query.append_pair("language", &lang);
        }
    }

    Ok(url.to_string())
}

fn emit_result(channel: &Channel<String>, payload: Value) {
    let _ = channel.send(payload.to_string());
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

fn stop_deepgram_stream_inner(state: &DeepgramState) {
    if let Ok(mut slot) = state.session.lock() {
        if let Some(session) = slot.take() {
            let _ = session.sender.send(DeepgramCommand::Stop);
            std::thread::spawn(move || {
                let _ = session.thread.join();
            });
        }
    }
}

async fn create_deepgram_token_inner(api_key: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build Deepgram auth client: {}", e))?;

    let response = client
        .post("https://api.deepgram.com/v1/auth/grant")
        .header("Authorization", format!("Token {}", api_key))
        .json(&json!({
            "comment": "compact-translator",
            "ttl_seconds": 60
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to contact Deepgram auth service: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let message = match status.as_u16() {
            401 | 403 => "Deepgram API key is invalid or unauthorized.".to_string(),
            429 => "Deepgram rate limit reached while creating a token.".to_string(),
            _ => format!("Deepgram token request failed ({}): {}", status, body),
        };
        return Err(message);
    }

    let value: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse Deepgram token response: {}", e))?;
    value
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .ok_or_else(|| "Deepgram auth response missing access token".to_string())
}

#[tauri::command]
pub async fn create_deepgram_token(
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<String, String> {
    let api_key = {
        let settings = settings_state.0.lock().map_err(|e| e.to_string())?;
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
    channel: Channel<String>,
    state: tauri::State<'_, DeepgramState>,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<(), String> {
    stop_deepgram_stream_inner(&state);

    let api_key = {
        let settings = settings_state.0.lock().map_err(|e| e.to_string())?;
        if settings.deepgram_api_key.trim().is_empty() {
            return Err("Deepgram API key is required. Add it in Settings.".to_string());
        }
        settings.deepgram_api_key.clone()
    };

    let token = create_deepgram_token_inner(&api_key).await?;
    let resolved_delay = endpoint_delay.unwrap_or(1500);
    let url = build_deepgram_url(&source_lang, resolved_delay)?;

    let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst);
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

            let connect_result =
                tokio::time::timeout(Duration::from_secs(15), connect_async(request)).await;

            let (ws_stream, _) = match connect_result {
                Ok(Ok(result)) => result,
                Ok(Err(err)) => {
                    emit_result(
                        &channel_clone,
                        json!({"type":"error","message": format!("Failed to connect to Deepgram: {}", err)}),
                    );
                    return;
                }
                Err(_) => {
                    emit_result(
                        &channel_clone,
                        json!({"type":"error","message":"Timed out while opening Deepgram WebSocket."}),
                    );
                    return;
                }
            };

            emit_result(&channel_clone, json!({"type":"ready"}));
            let connected_at = Instant::now();
            let (mut write, mut read) = ws_stream.split();
            let mut keepalive = tokio::time::interval(Duration::from_secs(8));
            let mut seq: u64 = 0;

            loop {
                tokio::select! {
                    command = receiver.recv() => {
                        match command {
                            Some(DeepgramCommand::Audio(bytes)) => {
                                if let Err(err) = write.send(Message::Binary(bytes.into())).await {
                                    emit_result(&channel_clone, json!({"type":"error","message": format!("Deepgram audio send failed: {}", err)}));
                                    break;
                                }
                            }
                            Some(DeepgramCommand::Stop) | None => {
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

                                        let confidence = average_confidence(
                                            &words,
                                            alternative.get("confidence").and_then(|v| v.as_f64()),
                                        );
                                        let is_final = value.get("is_final").and_then(|v| v.as_bool()).unwrap_or(false);
                                        let speech_final = value.get("speech_final").and_then(|v| v.as_bool()).unwrap_or(false);
                                        let start_s = value.get("start").and_then(|v| v.as_f64());
                                        let duration_s = value.get("duration").and_then(|v| v.as_f64());
                                        let wall_ms = connected_at.elapsed().as_millis() as u64;
                                        seq += 1;
                                        let utterance_id = start_s
                                            .map(|start| format!("start-{}", (start * 100.0).round() as i64))
                                            .unwrap_or_else(|| format!("seq-{}", seq));
                                        let language = detected_language(&alternative, &source_lang);

                                        emit_result(&channel_clone, json!({
                                            "type": if is_final { "original" } else { "provisional" },
                                            "text": transcript,
                                            "speaker": Value::Null,
                                            "language": language,
                                            "confidence": confidence,
                                            "speech_final": speech_final,
                                            "utterance_id": utterance_id,
                                            "timing": {
                                                "wall_ms": wall_ms,
                                                "start_s": start_s,
                                                "duration_s": duration_s
                                            }
                                        }));
                                    } else if message_type == "UtteranceEnd" {
                                        emit_result(
                                            &channel_clone,
                                            json!({"type":"provisional","text":"","speech_final":true}),
                                        );
                                    } else if let Some(error_message) = value.get("err_msg").and_then(|v| v.as_str()) {
                                        emit_result(
                                            &channel_clone,
                                            json!({"type":"error","message": error_message}),
                                        );
                                    }
                                }
                            }
                            Some(Ok(Message::Close(_))) => break,
                            Some(Ok(_)) => {}
                            Some(Err(err)) => {
                                emit_result(&channel_clone, json!({"type":"error","message": format!("Deepgram stream error: {}", err)}));
                                break;
                            }
                            None => break,
                        }
                    }
                    _ = keepalive.tick() => {
                        let _ = write.send(Message::Text(r#"{"type":"KeepAlive"}"#.into())).await;
                    }
                }
            }

            emit_result(&channel_clone, json!({"type":"done"}));
        });
    });

    let mut slot = state.session.lock().map_err(|e| e.to_string())?;
    *slot = Some(DeepgramSession {
        id: session_id,
        sender,
        thread,
    });

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

    let stop_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();

    std::thread::spawn(move || {
        let _session = session_id;
        loop {
            if stop_flag_clone.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }

            match receiver.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(data) => {
                    if sender.send(DeepgramCommand::Audio(data)).is_err() {
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
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
