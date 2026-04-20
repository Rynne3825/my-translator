import { invoke } from './tauri.js';

const DEFAULT_SETTINGS = {
  translation_type: 'one_way',
  translation_mode: 'deepgram',
  translation_model: 'azure',
  deepgram_api_key: '',
  source_language: 'auto',
  target_language: 'en',
  audio_source: 'system',
  endpoint_delay: 1500,
  overlay_opacity: 0.85,
  view_mode: 'dual',
  font_size: 16,
  max_lines: 5,
  show_original: true,
  theme_mode: 'dark',
  accent_preset: 'violet-neon',
  ui_locale: 'vi',
  azure_translator_key1: '',
  azure_translator_key2: '',
  azure_translator_region: 'eastasia',
  azure_translator_endpoint: 'https://api.cognitive.microsofttranslator.com',
  azure_speech_key: '',
  azure_speech_region: 'eastasia',
  tts_enabled: false,
  tts_provider: 'edge',
  edge_tts_voice: 'vi-VN-HoaiMyNeural',
  edge_tts_speed: 20,
  azure_tts_voice: 'en-US-AvaMultilingualNeural',
  azure_tts_speed: 0,
};

export class SettingsManager {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
  }

  async load() {
    try {
      const value = await invoke('get_settings');
      this.settings = { ...DEFAULT_SETTINGS, ...value };
    } catch (err) {
      console.warn('[settings] load failed', err);
      this.settings = { ...DEFAULT_SETTINGS };
    }
    return { ...this.settings };
  }

  async save(next) {
    this.settings = { ...this.settings, ...next };
    await invoke('save_settings', { newSettings: this.settings });
    return { ...this.settings };
  }

  get() {
    return { ...this.settings };
  }
}

export const settingsManager = new SettingsManager();
