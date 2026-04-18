use base64::Engine as _;
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

use crate::settings::SettingsState;

#[tauri::command]
pub async fn azure_tts_speak(
    text: String,
    voice: String,
    rate: i32,
    key_override: Option<String>,
    region_override: Option<String>,
    settings: tauri::State<'_, SettingsState>,
) -> Result<String, String> {
    // 1. Resolve credentials
    let (fallback_key, mut fallback_region) = {
        if let Ok(settings_lock) = settings.0.lock() {
            (settings_lock.azure_speech_key.clone(), settings_lock.azure_speech_region.clone())
        } else {
            (String::new(), "eastasia".to_string())
        }
    };
    if fallback_region.trim().is_empty() {
        fallback_region = "eastasia".to_string();
    }

    let key = key_override.filter(|k| !k.trim().is_empty()).unwrap_or(fallback_key);
    let region = region_override.filter(|r| !r.trim().is_empty()).unwrap_or(fallback_region);

    if key.trim().is_empty() {
        return Err("Azure Speech API key is required. Add it in Settings.".to_string());
    }

    if text.trim().is_empty() {
        return Err("Empty text".to_string());
    }

    // 2. Format request
    let url = format!("https://{}.tts.speech.microsoft.com/cognitiveservices/v1", region);
    let rate_str = if rate >= 0 { format!("+{}%", rate) } else { format!("{}%", rate) };
    let escaped_text = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");

    let ssml = format!(
        "<speak version='1.0' xml:lang='en-US'>\
         <voice xml:lang='en-US' name='{}'>\
         <prosody rate='{}'>{}</prosody>\
         </voice></speak>",
        voice, rate_str, escaped_text
    );

    // 3. Make the API call
    let client = Client::builder().timeout(Duration::from_secs(10)).build().unwrap_or_default();
    let res = client
        .post(&url)
        .header("Ocp-Apim-Subscription-Key", key)
        .header("Content-Type", "application/ssml+xml")
        .header("X-Microsoft-OutputFormat", "audio-24khz-48kbitrate-mono-mp3")
        .header("User-Agent", "my-translator")
        .body(ssml)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let error_msg = res.text().await.unwrap_or_default();
        return Err(format!("Azure TTS HTTP error {}: {}", status, error_msg));
    }

    let audio = res.bytes().await.map_err(|e| format!("Failed to read TTS audio: {}", e))?;
    if audio.is_empty() {
        return Err("Received empty audio from Azure TTS".to_string());
    }

    // 4. Return as Base64 for the frontend AudioContext/Data URL
    Ok(base64::engine::general_purpose::STANDARD.encode(audio))
}

#[tauri::command]
pub async fn azure_stt_recognize(
    audio_b64: String,
    language: String,
    key_override: Option<String>,
    region_override: Option<String>,
    settings: tauri::State<'_, SettingsState>,
) -> Result<String, String> {
    // 1. Resolve credentials
    let (fallback_key, mut fallback_region) = {
        if let Ok(settings_lock) = settings.0.lock() {
            (settings_lock.azure_speech_key.clone(), settings_lock.azure_speech_region.clone())
        } else {
            (String::new(), "eastasia".to_string())
        }
    };
    if fallback_region.trim().is_empty() {
        fallback_region = "eastasia".to_string();
    }

    let key = key_override.filter(|k| !k.trim().is_empty()).unwrap_or(fallback_key);
    let region = region_override.filter(|k| !k.trim().is_empty()).unwrap_or(fallback_region);

    if key.trim().is_empty() {
        return Err("Azure Speech API key is required. Add it in Settings.".to_string());
    }

    // 2. Decode audio
    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(&audio_b64)
        .map_err(|e| format!("Invalid base64 audio provided: {}", e))?;

    // 3. Request
    let client = Client::builder().timeout(Duration::from_secs(15)).build().unwrap_or_default();
    let url = format!(
        "https://{}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language={}",
        region, language
    );

    let res = client
        .post(&url)
        .header("Ocp-Apim-Subscription-Key", key)
        .header("Content-Type", "audio/wav") // Or audio/ogg depending on frontend
        .header("Accept", "application/json")
        .body(audio_bytes)
        .send()
        .await
        .map_err(|e| format!("Azure STT Request failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let error_msg = res.text().await.unwrap_or_default();
        return Err(format!("Azure STT HTTP error {}: {}", status, error_msg));
    }

    let json_res: Value = res.json().await.map_err(|e| format!("Failed to parse JSON: {}", e))?;
    
    // Azure REST STT usually returns RecognitionStatus: "Success" and "DisplayText"
    let status_str = json_res.get("RecognitionStatus").and_then(|v| v.as_str()).unwrap_or("");
    if status_str != "Success" && status_str != "InitialSilenceTimeout" && status_str != "NoMatch" {
        return Err(format!("Recognition failed with status: {}", status_str));
    }

    let display_text = json_res
        .get("DisplayText")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(display_text)
}
