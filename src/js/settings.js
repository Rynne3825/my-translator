/**
 * Settings Manager — handles loading/saving settings via Tauri IPC
 */

const { invoke } = window.__TAURI__.core;

const normalizeSupportedSettings = (settings = {}) => {
  const normalized = { ...settings };

  normalized.translation_mode = normalized.translation_mode === 'deepgram'
    ? 'deepgram'
    : 'local';
  normalized.translation_type = normalized.translation_type === 'two_way'
    ? 'two_way'
    : 'one_way';
  normalized.language_a = normalized.language_a || 'vi';
  normalized.language_b = normalized.language_b || 'en';
  normalized.deepgram_fast_mode = normalized.deepgram_fast_mode === true;
  normalized.tts_provider = 'edge';
  normalized.view_mode = normalized.view_mode === 'single'
    ? 'single'
    : 'dual';

  return normalized;
};

// Default settings shape
const DEFAULT_SETTINGS = {
  deepgram_api_key: '',
  source_language: 'vi',
  target_language: 'en',
  audio_source: 'system',
  overlay_opacity: 0.85,
  view_mode: 'dual',
  font_size: 16,
  max_lines: 5,
  show_original: true,
  translation_mode: 'deepgram',
  translation_type: 'one_way',
  language_a: 'vi',
  language_b: 'en',
  deepgram_fast_mode: false,
  language_hints_strict: false,
  endpoint_delay: 1500,
  local_model: 'turbo',
  translation_model: 'marian',
  custom_context: null,
  tts_enabled: false,
  tts_provider: 'edge',
  edge_tts_voice: 'vi-VN-HoaiMyNeural',
  edge_tts_speed: 50,
  tts_auto_read: true,
};

class SettingsManager {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this._listeners = [];
  }

  /**
   * Load settings from Rust backend
   */
  async load() {
    try {
      const settings = await invoke('get_settings');
      this.settings = normalizeSupportedSettings({ ...DEFAULT_SETTINGS, ...settings });
    } catch (err) {
      console.error('Failed to load settings:', err);
      this.settings = normalizeSupportedSettings({ ...DEFAULT_SETTINGS });
    }
    this._notify();
    return this.settings;
  }

  /**
   * Save settings to Rust backend
   */
  async save(newSettings) {
    try {
      const merged = normalizeSupportedSettings({ ...this.settings, ...newSettings });
      await invoke('save_settings', { newSettings: merged });
      this.settings = merged;
      this._notify();
      return true;
    } catch (err) {
      console.error('Failed to save settings:', err);
      throw err;
    }
  }

  /**
   * Get current settings (cached)
   */
  get() {
    return { ...this.settings };
  }

  /**
   * Subscribe to settings changes
   */
  onChange(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter(l => l !== callback);
    };
  }

  _notify() {
    const settings = this.get();
    this._listeners.forEach(cb => cb(settings));
  }
}

// Singleton
export const settingsManager = new SettingsManager();
