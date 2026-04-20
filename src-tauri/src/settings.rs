use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Translation term: source → target mapping for translation context
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranslationTerm {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct GeneralContextItem {
    pub key: String,
    pub value: String,
}

/// Custom context for transcription/translation hints
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CustomContext {
    pub domain: Option<String>,
    pub general: Vec<GeneralContextItem>,
    pub terms: Vec<String>,
    pub text: Option<String>,
    pub translation_terms: Vec<TranslationTerm>,
}

/// App settings — persisted to JSON
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// Deepgram API key
    pub deepgram_api_key: String,
    /// Source language: "auto" or ISO 639-1 code
    pub source_language: String,
    /// Target language: ISO 639-1 code
    pub target_language: String,
    /// Audio source: "system" | "microphone" | "both"
    pub audio_source: String,
    /// Overlay opacity: 0.0 - 1.0
    pub overlay_opacity: f64,
    /// Transcript layout mode: "dual" | "single"
    pub view_mode: String,
    /// Theme mode: "dark" | "light" | "system"
    pub theme_mode: String,
    /// Accent preset key
    pub accent_preset: String,
    /// UI locale: "vi" | "en"
    pub ui_locale: String,
    /// Font size in px
    pub font_size: u32,
    /// Max transcript lines to display
    pub max_lines: u32,
    /// Whether to show original text alongside translation
    pub show_original: bool,
    /// Translation mode: "deepgram" | "local"
    pub translation_mode: String,
    /// Translation type: "one_way" | "two_way"
    pub translation_type: String,
    /// Language A for two-way translation
    pub language_a: String,
    /// Language B for two-way translation
    pub language_b: String,
    /// Strict language hints mode
    pub language_hints_strict: bool,
    /// Endpoint delay in milliseconds
    pub endpoint_delay: u32,
    /// Local Faster-Whisper model: "turbo" | "large-v3"
    pub local_model: String,
    /// Translation model used by offline translator / Deepgram fallback
    pub translation_model: String,
    /// Azure Translator API key 1
    pub azure_translator_key1: String,
    /// Azure Translator API key 2
    pub azure_translator_key2: String,
    /// Azure Translator region
    pub azure_translator_region: String,
    /// Azure Translator endpoint
    pub azure_translator_endpoint: String,
    /// Azure Speech Service key
    pub azure_speech_key: String,
    /// Azure Speech Service region
    pub azure_speech_region: String,
    /// Optional custom context for better transcription
    pub custom_context: Option<CustomContext>,
    /// Whether TTS narration is enabled
    pub tts_enabled: bool,
    /// TTS provider: "edge"
    pub tts_provider: String,
    /// Edge TTS voice name
    pub edge_tts_voice: String,
    /// Edge TTS speed percentage
    pub edge_tts_speed: i32,
    /// Auto-read new translations aloud
    pub tts_auto_read: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            deepgram_api_key: String::new(),
            source_language: "auto".to_string(),
            target_language: "vi".to_string(),
            audio_source: "system".to_string(),
            overlay_opacity: 0.85,
            view_mode: "dual".to_string(),
            theme_mode: "dark".to_string(),
            accent_preset: "violet-neon".to_string(),
            ui_locale: "vi".to_string(),
            font_size: 16,
            max_lines: 5,
            show_original: true,
            translation_mode: "local".to_string(),
            translation_type: "one_way".to_string(),
            language_a: "vi".to_string(),
            language_b: "en".to_string(),
            language_hints_strict: false,
            endpoint_delay: 3000,
            local_model: "turbo".to_string(),
            translation_model: "marian".to_string(),
            azure_translator_key1: String::new(),
            azure_translator_key2: String::new(),
            azure_translator_region: "eastasia".to_string(),
            azure_translator_endpoint: "https://api.cognitive.microsofttranslator.com".to_string(),
            azure_speech_key: String::new(),
            azure_speech_region: "eastasia".to_string(),
            custom_context: None,
            tts_enabled: false,
            tts_provider: "edge".to_string(),
            edge_tts_voice: "vi-VN-HoaiMyNeural".to_string(),
            edge_tts_speed: 50,
            tts_auto_read: true,
        }
    }
}

/// Get the settings file path
/// ~/Library/Application Support/com.personal.translator/settings.json
fn settings_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("com.personal.translator");
    path.push("settings.json");
    path
}

impl Settings {
    /// Load settings from disk, or return defaults
    pub fn load() -> Self {
        let path = settings_path();
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        }
    }

    /// Save settings to disk
    pub fn save(&self) -> Result<(), String> {
        let path = settings_path();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
        }

        let json =
            serde_json::to_string_pretty(self).map_err(|e| format!("Failed to serialize: {}", e))?;

        fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))?;

        Ok(())
    }
}

/// Thread-safe settings state managed by Tauri
pub struct SettingsState(pub Mutex<Settings>);
