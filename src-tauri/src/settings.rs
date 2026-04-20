use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub translation_type: String,
    pub translation_mode: String,
    pub translation_model: String,

    pub deepgram_api_key: String,
    pub source_language: String,
    pub target_language: String,
    pub audio_source: String,
    pub endpoint_delay: u32,

    pub overlay_opacity: f32,
    pub view_mode: String,
    pub font_size: u32,
    pub max_lines: u32,
    pub show_original: bool,
    pub theme_mode: String,
    pub accent_preset: String,
    pub ui_locale: String,

    pub azure_translator_key1: String,
    pub azure_translator_key2: String,
    pub azure_translator_region: String,
    pub azure_translator_endpoint: String,

    pub azure_speech_key: String,
    pub azure_speech_region: String,

    pub tts_enabled: bool,
    pub tts_provider: String,
    pub edge_tts_voice: String,
    pub edge_tts_speed: i32,
    pub azure_tts_voice: String,
    pub azure_tts_speed: i32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            translation_type: "one_way".to_string(),
            translation_mode: "deepgram".to_string(),
            translation_model: "azure".to_string(),

            deepgram_api_key: String::new(),
            source_language: "auto".to_string(),
            target_language: "en".to_string(),
            audio_source: "system".to_string(),
            endpoint_delay: 1500,

            overlay_opacity: 0.85,
            view_mode: "dual".to_string(),
            font_size: 16,
            max_lines: 5,
            show_original: true,
            theme_mode: "dark".to_string(),
            accent_preset: "violet-neon".to_string(),
            ui_locale: "vi".to_string(),

            azure_translator_key1: String::new(),
            azure_translator_key2: String::new(),
            azure_translator_region: "eastasia".to_string(),
            azure_translator_endpoint: "https://api.cognitive.microsofttranslator.com".to_string(),

            azure_speech_key: String::new(),
            azure_speech_region: "eastasia".to_string(),

            tts_enabled: false,
            tts_provider: "edge".to_string(),
            edge_tts_voice: "vi-VN-HoaiMyNeural".to_string(),
            edge_tts_speed: 20,
            azure_tts_voice: "en-US-AvaMultilingualNeural".to_string(),
            azure_tts_speed: 0,
        }
    }
}

fn settings_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("com.personal.compacttranslator");
    path.push("settings.json");
    path
}

impl Settings {
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

    pub fn save(&self) -> Result<(), String> {
        let path = settings_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        fs::write(path, json).map_err(|e| format!("Failed to save settings: {}", e))
    }
}

pub struct SettingsState(pub Mutex<Settings>);
