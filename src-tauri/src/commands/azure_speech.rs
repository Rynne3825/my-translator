use base64::Engine as _;
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use uuid::Uuid;

use crate::settings::SettingsState;

#[derive(Debug, Serialize)]
pub struct TranslateResponse {
    pub translated: String,
    pub engine: String,
    pub model: String,
}

fn normalize_lang(code: &str) -> String {
    let normalized = code.trim().to_lowercase().replace('_', "-");
    normalized.split('-').next().unwrap_or("").to_string()
}

fn azure_lang_code(code: &str) -> String {
    let base = normalize_lang(code);
    match base.as_str() {
        "zh" => "zh-Hans".to_string(),
        _ => base,
    }
}

fn build_translate_url(endpoint: &str, source: &str, target: &str) -> Result<String, String> {
    let source_lang = normalize_lang(source);
    let base = endpoint.trim().trim_end_matches('/');
    let mut url = if base.contains("cognitiveservices.azure.com") && !base.ends_with("microsofttranslator.com") {
        reqwest::Url::parse(&format!("{}/translator/text/v3.0/translate", base))
            .map_err(|e| format!("Invalid Azure endpoint: {}", e))?
    } else {
        reqwest::Url::parse(&format!("{}/translate", base))
            .map_err(|e| format!("Invalid Azure endpoint: {}", e))?
    };

    {
        let mut q = url.query_pairs_mut();
        q.append_pair("api-version", "3.0");
        q.append_pair("to", &azure_lang_code(target));
        if !source_lang.is_empty() && source_lang != "auto" {
            q.append_pair("from", &azure_lang_code(&source_lang));
        }
    }

    Ok(url.to_string())
}

#[tauri::command]
pub async fn azure_translate_text(
    text: String,
    source_lang: String,
    target_lang: String,
    settings: tauri::State<'_, SettingsState>,
) -> Result<TranslateResponse, String> {
    let value = text.trim().to_string();
    if value.is_empty() {
        return Ok(TranslateResponse {
            translated: String::new(),
            engine: "identity".to_string(),
            model: "identity".to_string(),
        });
    }

    let (key1, key2, mut region, mut endpoint) = {
        let lock = settings.0.lock().map_err(|e| e.to_string())?;
        (
            lock.azure_translator_key1.clone(),
            lock.azure_translator_key2.clone(),
            lock.azure_translator_region.clone(),
            lock.azure_translator_endpoint.clone(),
        )
    };

    if region.trim().is_empty() {
        region = "eastasia".to_string();
    }
    if endpoint.trim().is_empty() {
        endpoint = "https://api.cognitive.microsofttranslator.com".to_string();
    }

    let source = normalize_lang(&source_lang);
    let target = normalize_lang(&target_lang);
    if target.is_empty() {
        return Err("Target language is required".to_string());
    }

    if !source.is_empty() && source != "auto" && source == target {
        return Ok(TranslateResponse {
            translated: value,
            engine: "identity".to_string(),
            model: "identity".to_string(),
        });
    }

    let keys = vec![key1, key2]
        .into_iter()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .collect::<Vec<_>>();

    if keys.is_empty() {
        return Err("Azure Translator API key is required".to_string());
    }

    let url = build_translate_url(&endpoint, &source, &target)?;
    let body = serde_json::json!([{ "text": value }]);

    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("Failed to build translator client: {}", e))?;

    let mut last_error = String::from("Unknown Azure Translator error");

    for key in keys {
        let response = client
            .post(&url)
            .header("Content-Type", "application/json; charset=utf-8")
            .header("Ocp-Apim-Subscription-Key", key)
            .header("Ocp-Apim-Subscription-Region", &region)
            .header("X-ClientTraceId", Uuid::new_v4().to_string())
            .json(&body)
            .send()
            .await;

        match response {
            Ok(res) => {
                if !res.status().is_success() {
                    let status = res.status();
                    let msg = res.text().await.unwrap_or_default();
                    last_error = format!("Azure Translator HTTP {}: {}", status, msg);
                    continue;
                }

                let payload: Value = res
                    .json()
                    .await
                    .map_err(|e| format!("Invalid Azure Translator response: {}", e))?;

                let translated = payload
                    .get(0)
                    .and_then(|v| v.get("translations"))
                    .and_then(|v| v.get(0))
                    .and_then(|v| v.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();

                return Ok(TranslateResponse {
                    translated,
                    engine: "azure".to_string(),
                    model: "azure-translator-v3".to_string(),
                });
            }
            Err(err) => {
                last_error = format!("Azure Translator request failed: {}", err);
            }
        }
    }

    Err(last_error)
}

#[tauri::command]
pub async fn azure_tts_speak(
    text: String,
    voice: String,
    rate: i32,
    key_override: Option<String>,
    region_override: Option<String>,
    settings: tauri::State<'_, SettingsState>,
) -> Result<String, String> {
    let (fallback_key, mut fallback_region) = {
        if let Ok(settings_lock) = settings.0.lock() {
            (
                settings_lock.azure_speech_key.clone(),
                settings_lock.azure_speech_region.clone(),
            )
        } else {
            (String::new(), "eastasia".to_string())
        }
    };
    if fallback_region.trim().is_empty() {
        fallback_region = "eastasia".to_string();
    }

    let key = key_override
        .filter(|k| !k.trim().is_empty())
        .unwrap_or(fallback_key);
    let region = region_override
        .filter(|r| !r.trim().is_empty())
        .unwrap_or(fallback_region);

    if key.trim().is_empty() {
        return Err("Azure Speech API key is required. Add it in Settings.".to_string());
    }

    if text.trim().is_empty() {
        return Err("Empty text".to_string());
    }

    let url = format!("https://{}.tts.speech.microsoft.com/cognitiveservices/v1", region);
    let rate_str = if rate >= 0 {
        format!("+{}%", rate)
    } else {
        format!("{}%", rate)
    };
    let escaped_text = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");

    let ssml = format!(
        "<speak version='1.0' xml:lang='en-US'>\
         <voice xml:lang='en-US' name='{}'>\
         <prosody rate='{}'>{}</prosody>\
         </voice></speak>",
        voice, rate_str, escaped_text
    );

    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build Azure TTS client: {}", e))?;

    let res = client
        .post(&url)
        .header("Ocp-Apim-Subscription-Key", key)
        .header("Content-Type", "application/ssml+xml")
        .header("X-Microsoft-OutputFormat", "audio-24khz-48kbitrate-mono-mp3")
        .header("User-Agent", "compact-translator")
        .body(ssml)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let error_msg = res.text().await.unwrap_or_default();
        return Err(format!("Azure TTS HTTP error {}: {}", status, error_msg));
    }

    let audio = res
        .bytes()
        .await
        .map_err(|e| format!("Failed to read TTS audio: {}", e))?;
    if audio.is_empty() {
        return Err("Received empty audio from Azure TTS".to_string());
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(audio))
}
