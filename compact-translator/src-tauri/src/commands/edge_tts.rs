/// Edge TTS — proxy WebSocket through Rust to avoid browser header limitations.
/// The Edge service is fragile: long input, unsupported control characters, or
/// slightly malformed frame parsing can cause the server to reset the socket.

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

const BASE_URL: &str = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION: &str = "134.0.3124.66";
const CHROMIUM_MAJOR_VERSION: &str = "134";
const WIN_EPOCH: i64 = 11644473600;
const MAX_EDGE_TEXT_BYTES: usize = 4096;

/// Generate the Sec-MS-GEC token value (DRM).
/// Based on upstream edge-tts logic.
fn generate_sec_ms_gec() -> String {
    let now = chrono::Utc::now().timestamp();
    let mut ticks = now + WIN_EPOCH;
    ticks -= ticks % 300;
    let str_to_hash = format!("{}{TRUSTED_CLIENT_TOKEN}", ticks * 10_000_000);
    let mut hasher = Sha256::new();
    hasher.update(str_to_hash.as_bytes());
    hex::encode_upper(hasher.finalize())
}

fn generate_muid() -> String {
    let bytes: [u8; 16] = rand::random();
    hex::encode_upper(bytes)
}

fn edge_timestamp() -> String {
    chrono::Utc::now()
        .format("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)")
        .to_string()
}

fn sanitize_text(input: &str) -> String {
    input
        .chars()
        .map(|ch| {
            let code = ch as u32;
            if (0..=8).contains(&code) || (11..=12).contains(&code) || (14..=31).contains(&code) {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn find_safe_split(mut bytes: &[u8], limit: usize) -> usize {
    if bytes.len() <= limit {
        return bytes.len();
    }

    bytes = &bytes[..limit];

    if let Some(pos) = bytes.iter().rposition(|&b| b == b'\n' || b == b' ') {
        return pos;
    }

    let mut split_at = bytes.len();
    while split_at > 0 {
        if std::str::from_utf8(&bytes[..split_at]).is_ok() {
            break;
        }
        split_at -= 1;
    }

    while split_at > 0 {
        if let Some(amp_idx) = bytes[..split_at].iter().rposition(|&b| b == b'&') {
            let tail = &bytes[amp_idx..split_at];
            if tail.contains(&b';') {
                break;
            }
            split_at = amp_idx;
        } else {
            break;
        }
    }

    split_at
}

fn split_escaped_text(input: &str, limit: usize) -> Result<Vec<String>, String> {
    let bytes = input.as_bytes();
    let mut parts = Vec::new();
    let mut start = 0usize;

    while start < bytes.len() {
        let remaining = &bytes[start..];
        if remaining.len() <= limit {
            let chunk = std::str::from_utf8(remaining)
                .map_err(|e| format!("Invalid UTF-8 in text chunk: {e}"))?
                .trim();
            if !chunk.is_empty() {
                parts.push(chunk.to_string());
            }
            break;
        }

        let split_rel = find_safe_split(remaining, limit);
        if split_rel == 0 {
            return Err("Text cannot be split safely for Edge TTS request".into());
        }

        let chunk = std::str::from_utf8(&remaining[..split_rel])
            .map_err(|e| format!("Invalid UTF-8 in text chunk: {e}"))?
            .trim();
        if !chunk.is_empty() {
            parts.push(chunk.to_string());
        }
        start += split_rel;
    }

    if parts.is_empty() {
        return Err("Empty text".into());
    }

    Ok(parts)
}

fn parse_header_map(input: &str) -> HashMap<&str, &str> {
    input
        .split("\r\n")
        .filter_map(|line| line.split_once(':').map(|(k, v)| (k.trim(), v.trim())))
        .collect()
}

fn build_ssml(voice: &str, rate: i32, escaped_text: &str) -> String {
    let rate_str = if rate >= 0 {
        format!("+{rate}%")
    } else {
        format!("{rate}%")
    };

    format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>\
         <voice name='{voice}'>\
         <prosody pitch='+0Hz' rate='{rate_str}' volume='+0%'>{escaped_text}</prosody>\
         </voice></speak>"
    )
}

async fn synthesize_chunk(text: &str, voice: &str, rate: i32) -> Result<Vec<u8>, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let connection_id = Uuid::new_v4().to_string().replace('-', "");
    let url = format!(
        "{BASE_URL}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&ConnectionId={connection_id}&Sec-MS-GEC={}&Sec-MS-GEC-Version=1-{CHROMIUM_FULL_VERSION}",
        generate_sec_ms_gec()
    );

    let mut request = url
        .into_client_request()
        .map_err(|e| format!("Failed to build request: {e}"))?;

    let headers = request.headers_mut();
    headers.insert("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold".parse().unwrap());
    headers.insert("Pragma", "no-cache".parse().unwrap());
    headers.insert("Cache-Control", "no-cache".parse().unwrap());
    headers.insert("Accept-Encoding", "gzip, deflate, br, zstd".parse().unwrap());
    headers.insert("Accept-Language", "en-US,en;q=0.9".parse().unwrap());
    headers.insert("Sec-WebSocket-Version", "13".parse().unwrap());
    headers.insert(
        "User-Agent",
        format!(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/{CHROMIUM_MAJOR_VERSION}.0.0.0"
        )
        .parse()
        .unwrap(),
    );
    headers.insert("Cookie", format!("muid={};", generate_muid()).parse().unwrap());

    let (ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("WebSocket connect failed: {e}"))?;

    let (mut write, mut read) = ws.split();

    let config_msg = format!(
        "X-Timestamp:{}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}}}}}",
        edge_timestamp()
    );
    write
        .send(Message::Text(config_msg.into()))
        .await
        .map_err(|e| format!("Send config failed: {e}"))?;

    let ssml_msg = format!(
        "X-RequestId:{}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{}Z\r\nPath:ssml\r\n\r\n{}",
        Uuid::new_v4().to_string().replace('-', ""),
        edge_timestamp(),
        build_ssml(voice, rate, text)
    );
    write
        .send(Message::Text(ssml_msg.into()))
        .await
        .map_err(|e| format!("Send SSML failed: {e}"))?;

    let mut audio_data = Vec::new();
    while let Some(msg_result) = read.next().await {
        match msg_result {
            Ok(Message::Text(text_frame)) => {
                let frame: &str = text_frame.as_ref();
                let header_end = frame.find("\r\n\r\n").unwrap_or(frame.len());
                let headers = parse_header_map(&frame[..header_end]);
                match headers.get("Path").copied() {
                    Some("turn.end") => break,
                    Some("turn.start") | Some("response") | Some("audio.metadata") => {}
                    Some(path) => {
                        return Err(format!("Unexpected Edge TTS text frame path: {path}"));
                    }
                    None => {}
                }
            }
            Ok(Message::Binary(data)) => {
                if data.len() < 2 {
                    return Err("Edge TTS binary frame missing header length".into());
                }

                let header_len = u16::from_be_bytes([data[0], data[1]]) as usize;
                if data.len() < 2 + header_len {
                    return Err("Edge TTS binary frame truncated".into());
                }

                let header_bytes = &data[2..2 + header_len];
                let header_text = std::str::from_utf8(header_bytes)
                    .map_err(|e| format!("Invalid Edge TTS binary header UTF-8: {e}"))?;
                let headers = parse_header_map(header_text);
                let payload = &data[2 + header_len..];

                match headers.get("Path").copied() {
                    Some("audio") => {
                        match headers.get("Content-Type").copied() {
                            Some("audio/mpeg") => {
                                if payload.is_empty() {
                                    return Err("Edge TTS audio frame missing payload".into());
                                }
                                audio_data.extend_from_slice(payload);
                            }
                            None if payload.is_empty() => {}
                            None => {
                                return Err("Edge TTS audio frame missing content type".into());
                            }
                            Some(content_type) => {
                                return Err(format!("Unexpected Edge TTS audio content type: {content_type}"));
                            }
                        }
                    }
                    Some(path) => {
                        return Err(format!("Unexpected Edge TTS binary frame path: {path}"));
                    }
                    None => {
                        return Err("Edge TTS binary frame missing Path header".into());
                    }
                }
            }
            Ok(Message::Close(frame)) => {
                let reason = frame
                    .map(|value| format!("code={} reason={}", value.code, value.reason))
                    .unwrap_or_else(|| "no close frame details".to_string());
                return Err(format!("Edge TTS socket closed unexpectedly: {reason}"));
            }
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
            Ok(other) => {
                return Err(format!("Unexpected Edge TTS WebSocket message: {other:?}"));
            }
            Err(e) => {
                return Err(format!("WebSocket error: {e}"));
            }
        }
    }

    let _ = write.send(Message::Close(None)).await;

    if audio_data.is_empty() {
        return Err("No audio received from Edge TTS".into());
    }

    Ok(audio_data)
}

#[tauri::command]
pub async fn edge_tts_speak(text: String, voice: String, rate: i32) -> Result<String, String> {
    let sanitized = sanitize_text(&text);
    if sanitized.is_empty() {
        return Err("Empty text".into());
    }

    let escaped = escape_xml(&sanitized);
    let chunks = split_escaped_text(&escaped, MAX_EDGE_TEXT_BYTES)?;

    let mut audio = Vec::new();
    for chunk in chunks {
        let chunk_audio = synthesize_chunk(&chunk, &voice, rate).await?;
        audio.extend_from_slice(&chunk_audio);
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(audio))
}
