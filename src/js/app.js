import { invoke, Channel } from './tauri.js';
import { settingsManager } from './settings.js';
import { deepgramClient } from './deepgram-client.js';
import { speakText } from './tts-service.js';
import { audioPlayer } from './audio-player.js';
import { TranscriptUI } from './ui.js';

const DEEPGRAM_NOVA3_LANGUAGES = [
  { code: 'auto', name: 'Auto-detect', country: 'Automatic', flag: '🌐', tags: ['auto', 'detect', 'automatic'] },
  { code: 'multi', name: 'Multilingual', country: 'Multi language', flag: '🌍', tags: ['multi', 'multilingual'] },
  { code: 'en', name: 'English', country: 'United States', flag: '🇺🇸', tags: ['english', 'usa', 'us'] },
  { code: 'es', name: 'Spanish', country: 'Spain', flag: '🇪🇸', tags: ['spanish', 'spain'] },
  { code: 'fr', name: 'French', country: 'France', flag: '🇫🇷', tags: ['french', 'france'] },
  { code: 'de', name: 'German', country: 'Germany', flag: '🇩🇪', tags: ['german', 'germany'] },
  { code: 'hi', name: 'Hindi', country: 'India', flag: '🇮🇳', tags: ['hindi', 'india'] },
  { code: 'ru', name: 'Russian', country: 'Russia', flag: '🇷🇺', tags: ['russian', 'russia'] },
  { code: 'pt', name: 'Portuguese', country: 'Portugal', flag: '🇵🇹', tags: ['portuguese', 'portugal'] },
  { code: 'ja', name: 'Japanese', country: 'Japan', flag: '🇯🇵', tags: ['japanese', 'japan'] },
  { code: 'it', name: 'Italian', country: 'Italy', flag: '🇮🇹', tags: ['italian', 'italy'] },
  { code: 'nl', name: 'Dutch', country: 'Netherlands', flag: '🇳🇱', tags: ['dutch', 'netherlands'] },
  { code: 'vi', name: 'Vietnamese', country: 'Viet Nam', flag: '🇻🇳', tags: ['vietnamese', 'vietnam', 'viet nam'] },
  { code: 'ko', name: 'Korean', country: 'Korea', flag: '🇰🇷', tags: ['korean', 'korea'] },
  { code: 'th', name: 'Thai', country: 'Thailand', flag: '🇹🇭', tags: ['thai', 'thailand'] },
  { code: 'id', name: 'Indonesian', country: 'Indonesia', flag: '🇮🇩', tags: ['indonesian', 'indonesia'] },
  { code: 'ar', name: 'Arabic', country: 'Saudi Arabia', flag: '🇸🇦', tags: ['arabic', 'saudi', 'middle east'] },
  { code: 'ar-AE', name: 'Arabic (UAE)', country: 'United Arab Emirates', flag: '🇦🇪', tags: ['arabic', 'uae', 'emirates'] },
  { code: 'ar-SA', name: 'Arabic (Saudi Arabia)', country: 'Saudi Arabia', flag: '🇸🇦', tags: ['arabic', 'saudi arabia'] },
  { code: 'ar-QA', name: 'Arabic (Qatar)', country: 'Qatar', flag: '🇶🇦', tags: ['arabic', 'qatar'] },
  { code: 'ar-KW', name: 'Arabic (Kuwait)', country: 'Kuwait', flag: '🇰🇼', tags: ['arabic', 'kuwait'] },
  { code: 'ar-SY', name: 'Arabic (Syria)', country: 'Syria', flag: '🇸🇾', tags: ['arabic', 'syria'] },
  { code: 'ar-LB', name: 'Arabic (Lebanon)', country: 'Lebanon', flag: '🇱🇧', tags: ['arabic', 'lebanon'] },
  { code: 'ar-PS', name: 'Arabic (Palestine)', country: 'Palestine', flag: '🇵🇸', tags: ['arabic', 'palestine'] },
  { code: 'ar-JO', name: 'Arabic (Jordan)', country: 'Jordan', flag: '🇯🇴', tags: ['arabic', 'jordan'] },
  { code: 'ar-EG', name: 'Arabic (Egypt)', country: 'Egypt', flag: '🇪🇬', tags: ['arabic', 'egypt'] },
  { code: 'ar-SD', name: 'Arabic (Sudan)', country: 'Sudan', flag: '🇸🇩', tags: ['arabic', 'sudan'] },
  { code: 'ar-TD', name: 'Arabic (Chad)', country: 'Chad', flag: '🇹🇩', tags: ['arabic', 'chad'] },
  { code: 'ar-MA', name: 'Arabic (Morocco)', country: 'Morocco', flag: '🇲🇦', tags: ['arabic', 'morocco'] },
  { code: 'ar-DZ', name: 'Arabic (Algeria)', country: 'Algeria', flag: '🇩🇿', tags: ['arabic', 'algeria'] },
  { code: 'ar-TN', name: 'Arabic (Tunisia)', country: 'Tunisia', flag: '🇹🇳', tags: ['arabic', 'tunisia'] },
  { code: 'ar-IQ', name: 'Arabic (Iraq)', country: 'Iraq', flag: '🇮🇶', tags: ['arabic', 'iraq'] },
  { code: 'ar-IR', name: 'Arabic (Iran)', country: 'Iran', flag: '🇮🇷', tags: ['arabic', 'iran'] },
  { code: 'be', name: 'Belarusian', country: 'Belarus', flag: '🇧🇾', tags: ['belarusian', 'belarus'] },
  { code: 'bn', name: 'Bengali', country: 'Bangladesh', flag: '🇧🇩', tags: ['bengali', 'bangladesh'] },
  { code: 'bs', name: 'Bosnian', country: 'Bosnia and Herzegovina', flag: '🇧🇦', tags: ['bosnian', 'bosnia'] },
  { code: 'bg', name: 'Bulgarian', country: 'Bulgaria', flag: '🇧🇬', tags: ['bulgarian', 'bulgaria'] },
  { code: 'ca', name: 'Catalan', country: 'Spain', flag: '🇪🇸', tags: ['catalan', 'spain'] },
  { code: 'zh', name: 'Chinese (Mandarin)', country: 'China', flag: '🇨🇳', tags: ['chinese', 'mandarin', 'china'] },
  { code: 'zh-CN', name: 'Chinese (Simplified)', country: 'China', flag: '🇨🇳', tags: ['chinese', 'simplified', 'china'] },
  { code: 'zh-Hans', name: 'Chinese (Hans)', country: 'China', flag: '🇨🇳', tags: ['chinese', 'hans', 'simplified'] },
  { code: 'zh-HK', name: 'Chinese (Cantonese)', country: 'Hong Kong', flag: '🇭🇰', tags: ['chinese', 'cantonese', 'hong kong'] },
  { code: 'cs', name: 'Czech', country: 'Czech Republic', flag: '🇨🇿', tags: ['czech', 'czech republic'] },
  { code: 'da', name: 'Danish', country: 'Denmark', flag: '🇩🇰', tags: ['danish', 'denmark'] },
];

const LANGUAGE_META_BY_CODE = new Map(DEEPGRAM_NOVA3_LANGUAGES.map((item) => [item.code, item]));

const SOURCE_LANGUAGE_CODES = DEEPGRAM_NOVA3_LANGUAGES.map((item) => item.code);

const TARGET_LANGUAGE_CODES = [
  'vi', 'en', 'ja', 'ko', 'zh', 'zh-CN', 'zh-HK', 'fr', 'de', 'es', 'th', 'id', 'ar', 'hi',
  'ru', 'pt', 'it', 'nl', 'bn', 'bg', 'be', 'bs', 'ca', 'cs', 'da',
];

export class App {
  constructor() {
    this.isRunning = false;
    this.translationQueue = Promise.resolve();
    this.translations = [];
    this.provisionalText = '';
    this.currentSettings = null;
    this.lastTranslatedKey = '';
    this.currentSource = 'system';
    this.viewMode = window.localStorage?.getItem('compact_view_mode') === 'single' ? 'single' : 'dual';
    const savedVolume = Number.parseFloat(window.localStorage?.getItem('toolbar_tts_volume') || '0.9');
    this.toolbarTtsVolume = Number.isFinite(savedVolume)
      ? Math.min(1, Math.max(0, savedVolume))
      : 0.9;
    this.themeMode = 'dark';
    this.currentAccentPreset = 'violet-neon';
    this.currentLocale = 'vi';
    this.systemThemeMedia = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    this.historyRows = [];
    this.transcriptUI = null;
    this.languagePickers = new Map();

    const byId = (...ids) => ids.map((id) => document.getElementById(id)).find(Boolean) || null;
    const bySelector = (...selectors) => selectors.map((selector) => document.querySelector(selector)).find(Boolean) || null;

    this.el = {
      tabMain: byId('tab-main') || bySelector('.sidebar-item[data-screen="home"]'),
      tabHistory: byId('tab-history') || bySelector('.sidebar-item[data-screen="history"]'),
      tabInterface: byId('tab-interface') || bySelector('.sidebar-item[data-screen="interface"]'),
      screenMain: byId('screen-main') || byId('screen-home'),
      screenHistory: byId('screen-history'),
      screenInterface: byId('screen-interface'),
      screenTranscript: byId('screen-transcript'),
      statusDot: byId('status-dot', 'status-indicator'),
      statusText: byId('status-text'),
      recordingStatusText: byId('recording-status-text'),
      btnStart: byId('btn-start'),
      btnViewMode: byId('btn-view-mode'),
      btnSettings: byId('btn-settings'),
      btnClosePanel: byId('btn-close-panel'),
      btnSaveSettings: byId('btn-save-settings'),
      btnCopy: byId('btn-copy'),
      btnClear: byId('btn-clear'),
      btnOpenFolder: byId('btn-open-folder', 'btn-open-transcripts'),
      btnRefreshHistory: byId('btn-refresh-history'),
      transcriptContent: byId('transcript-content'),
      transcriptContainer: byId('transcript-container'),
      translationList: byId('translation-list'),
      provisional: byId('provisional'),
      historyList: byId('history-list'),
      historySearchInput: byId('history-search-input'),

      audioSource: byId('audio-source', 'sts-audio-source'),
      sourceLanguage: byId('source-language', 'sts-source-lang', 'toolbar-source-lang'),
      targetLanguage: byId('target-language', 'sts-target-lang', 'toolbar-target-lang'),
      deepgramKey: byId('deepgram-key', 'sts-deepgram-key'),
      endpointDelay: byId('endpoint-delay', 'range-endpoint-delay'),
      azureTranslatorKey1: byId('azure-translator-key1', 'sts-azure-key1'),
      azureTranslatorKey2: byId('azure-translator-key2', 'sts-azure-key2'),
      azureTranslatorRegion: byId('azure-translator-region', 'sts-azure-region'),
      azureTranslatorEndpoint: byId('azure-translator-endpoint', 'sts-azure-endpoint'),
      azureSpeechKey: byId('azure-speech-key'),
      azureSpeechRegion: byId('azure-speech-region'),
      ttsEnabled: byId('tts-enabled', 'sts-tts-enabled', 'toolbar-tts-enabled'),
      ttsProvider: byId('tts-provider', 'sts-tts-provider'),
      edgeVoice: byId('edge-voice', 'sts-edge-voice', 'toolbar-edge-voice'),
      edgeSpeed: byId('edge-speed', 'sts-edge-speed', 'toolbar-edge-speed'),
      azureVoice: byId('azure-voice'),
      azureSpeed: byId('azure-speed'),

      toolbarSourceLang: byId('toolbar-source-lang'),
      toolbarTargetLang: byId('toolbar-target-lang'),
      toolbarTtsEnabled: byId('toolbar-tts-enabled'),
      toolbarTtsVolume: byId('toolbar-tts-volume'),
      toolbarTtsVolumeValue: byId('toolbar-tts-volume-value'),
      toolbarEdgeSpeed: byId('toolbar-edge-speed'),
      toolbarEdgeSpeedValue: byId('toolbar-edge-speed-value'),
      toolbarEdgeVoice: byId('toolbar-edge-voice'),

      stsAudioSource: byId('sts-audio-source'),
      stsSourceLang: byId('sts-source-lang'),
      stsTargetLang: byId('sts-target-lang'),
      stsTtsEnabled: byId('sts-tts-enabled'),
      stsEdgeVoice: byId('sts-edge-voice'),
      stsEdgeSpeed: byId('sts-edge-speed'),
      stsEdgeSpeedValue: byId('sts-edge-speed-value'),
      stsTtsVolume: byId('sts-tts-volume'),
      stsTtsVolumeValue: byId('sts-tts-volume-value'),

      rangeOpacity: byId('range-opacity'),
      opacityValue: byId('opacity-value'),
      rangeFontSize: byId('range-font-size'),
      fontSizeValue: byId('font-size-value'),
      fontSizeDisplay: byId('font-size-display'),
      rangeMaxLines: byId('range-max-lines'),
      maxLinesValue: byId('max-lines-value'),
      checkShowOriginal: byId('check-show-original'),
      translationType: byId('select-translation-type'),
      sttProvider: byId('sts-stt-provider'),
      translationMethod: byId('sts-translation-method'),

      appLayout: byId('app-layout'),
    };

    this.displayModeInputs = Array.from(document.querySelectorAll('input[name="display-view-mode"]'));
    this.recordTriggers = Array.from(document.querySelectorAll('#mic-trigger, #toolbar-record'));
  }

  async init() {
    this.currentSettings = await settingsManager.load();
    await this._enforceFixedModeSettings();
    this.currentSource = this.currentSettings.audio_source || 'system';
    this._hydrateLanguageSelectors();

    if (this.el.transcriptContent) {
      this.transcriptUI = new TranscriptUI(this.el.transcriptContent);
    }

    audioPlayer.init();
    audioPlayer.setVolume(this.toolbarTtsVolume);

    this._applySettingsToForm(this.currentSettings);
    this._bindEvents();
    this._bindDeepgramEvents();
    this._initBottomToolbarEvents();
    this._initAppearanceEvents();
    this._initLanguagePickers();
    this._syncToolbarLanguageControls(this.currentSettings);
    this._syncToolbarVoiceControls(this.currentSettings);
    this._updateSourceButtons();
    this._applyDisplaySettings(this.currentSettings, { persist: false });
    this._applyAppearanceSettings(this.currentSettings, { persist: false });

    if (this.transcriptUI && !this.transcriptUI.hasContent()) {
      this.transcriptUI.showPlaceholder();
    }

    await this.refreshHistory();
    this._setStatus('ready', 'San sang');
  }

  async _enforceFixedModeSettings() {
    const patch = {};
    if (this.currentSettings.translation_type !== 'one_way') patch.translation_type = 'one_way';
    if (this.currentSettings.translation_mode !== 'deepgram') patch.translation_mode = 'deepgram';
    if (this.currentSettings.translation_model !== 'azure') patch.translation_model = 'azure';
    if (!this.currentSettings.theme_mode) patch.theme_mode = 'dark';
    if (!this.currentSettings.accent_preset) patch.accent_preset = 'violet-neon';
    if (!this.currentSettings.ui_locale) patch.ui_locale = 'vi';
    if (Object.keys(patch).length === 0) return;
    await this._persistSettingsPatch(patch);
  }

  _onClick(element, handler) {
    if (element) {
      element.addEventListener('click', handler);
    }
  }

  _setStartButtonState(running) {
    if (this.el.btnStart) {
      this.el.btnStart.textContent = running ? 'Stop' : 'Start';
    }
    const play = document.getElementById('icon-play');
    const stop = document.getElementById('icon-stop');
    const label = document.getElementById('btn-start-label');
    if (play) play.style.display = running ? 'none' : '';
    if (stop) stop.style.display = running ? '' : 'none';
    if (label) label.textContent = running ? 'Dung' : 'Bat dau ghi';
  }

  _bindEvents() {
    document.querySelectorAll('.sidebar-item[data-screen]').forEach((item) => {
      item.addEventListener('click', async () => {
        const screen = item.dataset.screen || 'home';
        this._showScreen(screen);
        if (screen === 'history') {
          await this.refreshHistory();
        }
      });
    });

    if (this.el.historySearchInput) {
      this.el.historySearchInput.addEventListener('input', () => {
        this._renderHistory(this.el.historySearchInput?.value || '');
      });
    }

    this._onClick(this.el.btnStart, async () => {
      if (this.isRunning) {
        await this.stop();
      } else {
        await this.start();
      }
    });

    this.recordTriggers.forEach((trigger) => {
      this._onClick(trigger, async () => {
        if (this.isRunning) {
          await this.stop();
        } else {
          await this.start();
        }
      });
    });

    this._onClick(this.el.btnSaveSettings, async () => {
      const settings = this._collectFormSettings();
      await settingsManager.save(settings);
      this.currentSettings = settings;
      this._toast('Da luu settings');
    });

    this._onClick(this.el.btnCopy, async () => {
      const text = this.transcriptUI?.getPlainText() || this.translations.map((row) => row.text).join('\n');
      await navigator.clipboard.writeText(text);
      this._toast('Da copy ban dich');
    });

    this._onClick(this.el.btnClear, () => {
      this.translations = [];
      if (this.transcriptUI) {
        this.transcriptUI.clear();
        this.transcriptUI.showPlaceholder();
      }
      if (this.el.translationList) {
        this.el.translationList.innerHTML = '';
      }
      if (this.el.provisional) {
        this.el.provisional.textContent = '';
      }
    });

    this._onClick(this.el.btnOpenFolder, async () => {
      await invoke('open_transcript_dir');
    });

    this._onClick(document.getElementById('btn-open-transcripts'), async () => {
      await invoke('open_transcript_dir');
    });

    this._onClick(this.el.btnRefreshHistory, async () => {
      await this.refreshHistory();
    });

    this._onClick(document.getElementById('history-modal-close'), () => {
      const modal = document.getElementById('history-modal');
      if (modal) modal.style.display = 'none';
    });

    this._onClick(document.getElementById('history-modal'), (event) => {
      if (event.target?.id === 'history-modal') {
        const modal = document.getElementById('history-modal');
        if (modal) modal.style.display = 'none';
      }
    });

    this._onClick(document.getElementById('history-modal-copy'), async () => {
      const content = document.getElementById('history-modal-content')?.textContent || '';
      if (!content.trim()) return;
      await navigator.clipboard.writeText(content);
      this._toast('Da copy transcript');
    });

    this._bindDisplaySettingsEvents();
  }

  _bindDisplaySettingsEvents() {
    if (this.el.rangeOpacity && this.el.opacityValue) {
      this.el.rangeOpacity.addEventListener('input', () => {
        this.el.opacityValue.textContent = `${this.el.rangeOpacity.value}%`;
        this._applyDisplaySettings({ ...this.currentSettings, overlay_opacity: Number(this.el.rangeOpacity.value) / 100 }, { persist: false });
      });
      this.el.rangeOpacity.addEventListener('change', () => {
        this._applyDisplaySettings({ ...this.currentSettings, overlay_opacity: Number(this.el.rangeOpacity.value) / 100 }, { persist: true });
      });
    }

    if (this.el.rangeFontSize && this.el.fontSizeValue) {
      this.el.rangeFontSize.addEventListener('input', () => {
        const fontSize = Number(this.el.rangeFontSize.value || 16);
        this.el.fontSizeValue.textContent = `${fontSize}px`;
        if (this.el.fontSizeDisplay) this.el.fontSizeDisplay.textContent = String(fontSize);
        this._applyDisplaySettings({ ...this.currentSettings, font_size: fontSize }, { persist: false });
      });
      this.el.rangeFontSize.addEventListener('change', () => {
        const fontSize = Number(this.el.rangeFontSize.value || 16);
        this._applyDisplaySettings({ ...this.currentSettings, font_size: fontSize }, { persist: true });
      });
    }

    if (this.el.rangeMaxLines && this.el.maxLinesValue) {
      this.el.rangeMaxLines.addEventListener('input', () => {
        const maxLines = Number(this.el.rangeMaxLines.value || 5);
        this.el.maxLinesValue.textContent = String(maxLines);
        this._applyDisplaySettings({ ...this.currentSettings, max_lines: maxLines }, { persist: false });
      });
      this.el.rangeMaxLines.addEventListener('change', () => {
        const maxLines = Number(this.el.rangeMaxLines.value || 5);
        this._applyDisplaySettings({ ...this.currentSettings, max_lines: maxLines }, { persist: true });
      });
    }

    if (this.el.checkShowOriginal) {
      this.el.checkShowOriginal.addEventListener('change', () => {
        const showOriginal = Boolean(this.el.checkShowOriginal.checked);
        this._applyDisplaySettings({ ...this.currentSettings, show_original: showOriginal }, { persist: true });
      });
    }

    this.displayModeInputs.forEach((input) => {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this._applyViewMode(input.value, { persist: true });
      });
    });
  }

  _initAppearanceEvents() {
    document.querySelectorAll('.theme-mode-btn[data-theme]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const themeMode = btn.dataset.theme || 'dark';
        this._applyAppearanceSettings({ ...(this.currentSettings || {}), theme_mode: themeMode }, { persist: true });
      });
    });

    document.querySelectorAll('.accent-swatch[data-accent-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const accentPreset = btn.dataset.accentPreset || 'violet-neon';
        this._applyAppearanceSettings({ ...(this.currentSettings || {}), accent_preset: accentPreset }, { persist: true });
      });
    });

    document.querySelectorAll('.ui-locale-select').forEach((select) => {
      select.addEventListener('change', () => {
        this._applyAppearanceSettings({ ...(this.currentSettings || {}), ui_locale: select.value || 'vi' }, { persist: true });
      });
    });

    if (this.systemThemeMedia?.addEventListener) {
      this.systemThemeMedia.addEventListener('change', () => {
        if ((this.currentSettings?.theme_mode || 'dark') === 'system') {
          this._applyAppearanceSettings(this.currentSettings || {}, { persist: false });
        }
      });
    }
  }

  _resolveTheme(themeMode) {
    if (themeMode === 'system') {
      return this.systemThemeMedia?.matches ? 'dark' : 'light';
    }
    return themeMode === 'light' ? 'light' : 'dark';
  }

  _syncThemeButtons(themeMode) {
    document.querySelectorAll('.theme-mode-btn[data-theme]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === themeMode);
    });
  }

  _syncAccentButtons(accentPreset) {
    document.querySelectorAll('.accent-swatch[data-accent-preset]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.accentPreset === accentPreset);
    });
  }

  _applyAppearanceSettings(settings, options = {}) {
    const persist = Boolean(options.persist);
    const themeMode = settings.theme_mode || 'dark';
    const accentPreset = settings.accent_preset || 'violet-neon';
    const uiLocale = settings.ui_locale || 'vi';
    const resolvedTheme = this._resolveTheme(themeMode);

    this.themeMode = themeMode;
    this.currentAccentPreset = accentPreset;
    this.currentLocale = uiLocale;

    document.documentElement.setAttribute('data-theme-mode', themeMode);
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    document.documentElement.setAttribute('data-accent-preset', accentPreset);

    this._syncThemeButtons(themeMode);
    this._syncAccentButtons(accentPreset);

    document.querySelectorAll('.ui-locale-select').forEach((select) => {
      if (select.value !== uiLocale) {
        select.value = uiLocale;
      }
    });

    this.currentSettings = {
      ...(this.currentSettings || {}),
      theme_mode: themeMode,
      accent_preset: accentPreset,
      ui_locale: uiLocale,
    };

    if (persist) {
      this._persistSettingsPatch({
        theme_mode: themeMode,
        accent_preset: accentPreset,
        ui_locale: uiLocale,
      }).catch((err) => {
        console.error('[settings] failed to save appearance settings', err);
      });
    }
  }

  async _persistSettingsPatch(patch) {
    const next = { ...(this.currentSettings || {}), ...patch };
    await settingsManager.save(next);
    this.currentSettings = next;
    return next;
  }

  _getLanguageMeta(code) {
    const normalized = String(code || '').trim();
    if (LANGUAGE_META_BY_CODE.has(normalized)) {
      return LANGUAGE_META_BY_CODE.get(normalized);
    }
    return {
      code: normalized || 'auto',
      name: normalized ? normalized.toUpperCase() : 'Unknown',
      country: 'Custom',
      flag: '🏳️',
      tags: [normalized],
    };
  }

  _hydrateLanguageSelectors() {
    const sourceFallback = this.currentSettings?.source_language || 'auto';
    const targetFallback = this.currentSettings?.target_language || 'en';

    ['sts-source-lang', 'toolbar-source-lang', 'select-source-lang'].forEach((id) => {
      const select = document.getElementById(id);
      if (!select) return;
      this._populateLanguageSelect(select, SOURCE_LANGUAGE_CODES, sourceFallback);
    });

    ['sts-target-lang', 'toolbar-target-lang', 'select-target-lang'].forEach((id) => {
      const select = document.getElementById(id);
      if (!select) return;
      this._populateLanguageSelect(select, TARGET_LANGUAGE_CODES, targetFallback);
    });
  }

  _populateLanguageSelect(select, codes, preferredValue) {
    const uniqueCodes = Array.from(new Set(codes));
    const preferred = String(preferredValue || '').trim();

    select.innerHTML = '';
    uniqueCodes.forEach((code) => {
      const meta = this._getLanguageMeta(code);
      const option = document.createElement('option');
      option.value = meta.code;
      option.textContent = `${meta.flag} ${meta.name}`;
      select.appendChild(option);
    });

    const hasPreferred = uniqueCodes.includes(preferred);
    const fallback = uniqueCodes[0] || '';
    select.value = hasPreferred ? preferred : fallback;
  }

  _initLanguagePickers() {
    ['toolbar-source-lang', 'toolbar-target-lang', 'sts-source-lang', 'sts-target-lang'].forEach((id) => {
      this._createLanguagePicker(id);
    });

    if (!this._languagePickerEscapeBound) {
      this._languagePickerEscapeBound = true;
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          this._closeLanguagePickers();
        }
      });
    }
  }

  _createLanguagePicker(selectId) {
    const select = document.getElementById(selectId);
    if (!select || select.dataset.langPickerReady === '1') {
      return;
    }

    select.dataset.langPickerReady = '1';
    select.classList.add('lang-picker-native');

    const root = document.createElement('div');
    root.className = 'lang-picker';
    root.dataset.selectId = selectId;
    root.innerHTML = `
      <button type="button" class="lang-picker-trigger" aria-haspopup="listbox" aria-expanded="false">
        <span class="lang-picker-leading">
          <span class="lang-picker-flag">🌐</span>
          <span class="lang-picker-name">Auto-detect</span>
          <span class="lang-picker-code">AUTO</span>
        </span>
        <svg class="lang-picker-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      <div class="lang-picker-menu" role="listbox">
        <div class="lang-picker-search-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input class="lang-picker-search" type="text" placeholder="Tim ngon ngu hoac quoc gia..." />
        </div>
        <div class="lang-picker-options"></div>
      </div>
    `;

    select.insertAdjacentElement('afterend', root);

    const trigger = root.querySelector('.lang-picker-trigger');
    const menu = root.querySelector('.lang-picker-menu');
    const search = root.querySelector('.lang-picker-search');
    const optionsWrap = root.querySelector('.lang-picker-options');
    const flagNode = root.querySelector('.lang-picker-flag');
    const nameNode = root.querySelector('.lang-picker-name');
    const codeNode = root.querySelector('.lang-picker-code');

    const getOptionRows = () => Array.from(select.options).map((option) => {
      const meta = this._getLanguageMeta(option.value);
      const searchBlob = [meta.name, meta.country, meta.code, ...(meta.tags || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return {
        value: option.value,
        code: meta.code,
        flag: meta.flag,
        name: meta.name,
        country: meta.country,
        searchBlob,
      };
    });

    const syncFromSelect = () => {
      const selected = this._getLanguageMeta(select.value);
      if (flagNode) flagNode.textContent = selected.flag;
      if (nameNode) nameNode.textContent = selected.name;
      if (codeNode) codeNode.textContent = selected.code.toUpperCase();

      root.querySelectorAll('.lang-picker-option').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.value === select.value);
      });
    };

    const renderOptions = (query = '') => {
      const normalized = String(query || '').trim().toLowerCase();
      const rows = getOptionRows().filter((row) => !normalized || row.searchBlob.includes(normalized));

      optionsWrap.innerHTML = '';
      if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'lang-picker-empty';
        empty.textContent = 'Khong tim thay ngon ngu phu hop.';
        optionsWrap.appendChild(empty);
        return;
      }

      rows.forEach((row) => {
        const optionBtn = document.createElement('button');
        optionBtn.type = 'button';
        optionBtn.className = 'lang-picker-option';
        optionBtn.dataset.value = row.value;
        optionBtn.innerHTML = `
          <span class="lang-picker-option-flag">${row.flag}</span>
          <span class="lang-picker-option-copy">
            <span class="lang-picker-option-name">${this._escapeHtml(row.name)}</span>
            <span class="lang-picker-option-country">${this._escapeHtml(row.country)}</span>
          </span>
          <span class="lang-picker-option-code">${this._escapeHtml(row.code.toUpperCase())}</span>
        `;
        optionBtn.classList.toggle('active', row.value === select.value);
        optionBtn.addEventListener('click', () => {
          if (select.value !== row.value) {
            select.value = row.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          syncFromSelect();
          root.classList.remove('open');
          trigger.setAttribute('aria-expanded', 'false');
        });
        optionsWrap.appendChild(optionBtn);
      });
    };

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const willOpen = !root.classList.contains('open');
      this._closeLanguagePickers(willOpen ? root : null);
      root.classList.toggle('open', willOpen);
      trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      if (willOpen) {
        renderOptions(search.value || '');
        requestAnimationFrame(() => {
          search.focus();
        });
      }
    });

    menu.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    search.addEventListener('input', () => {
      renderOptions(search.value || '');
    });

    select.addEventListener('change', () => {
      syncFromSelect();
      if (root.classList.contains('open')) {
        renderOptions(search.value || '');
      }
    });

    if (!this._languagePickerClickBound) {
      this._languagePickerClickBound = true;
      document.addEventListener('click', () => {
        this._closeLanguagePickers();
      });
    }

    root.__syncFromSelect = syncFromSelect;
    this.languagePickers.set(selectId, root);

    renderOptions('');
    syncFromSelect();
  }

  _closeLanguagePickers(except = null) {
    this.languagePickers.forEach((root) => {
      if (except && root === except) {
        return;
      }
      root.classList.remove('open');
      const trigger = root.querySelector('.lang-picker-trigger');
      if (trigger) {
        trigger.setAttribute('aria-expanded', 'false');
      }
    });
  }

  _syncLanguagePickerDisplays() {
    this.languagePickers.forEach((root) => {
      if (typeof root.__syncFromSelect === 'function') {
        root.__syncFromSelect();
      }
    });
  }

  _setLanguagePair(source, target, options = {}) {
    const persist = Boolean(options.persist);
    const sourceSelectRef = this.el.stsSourceLang || this.el.toolbarSourceLang;
    const targetSelectRef = this.el.stsTargetLang || this.el.toolbarTargetLang;

    const normalizeToSelect = (select, value, fallback) => {
      if (!select) return fallback;
      const values = new Set(Array.from(select.options).map((option) => option.value));
      if (values.has(value)) return value;
      if (values.has(fallback)) return fallback;
      return Array.from(values)[0] || fallback;
    };

    const nextSource = normalizeToSelect(sourceSelectRef, source, 'auto');
    const nextTarget = normalizeToSelect(targetSelectRef, target, 'en');

    const assign = (select, value) => {
      if (!select) return;
      if (Array.from(select.options).some((option) => option.value === value)) {
        select.value = value;
      }
    };

    assign(this.el.stsSourceLang, nextSource);
    assign(this.el.toolbarSourceLang, nextSource);
    assign(document.getElementById('select-source-lang'), nextSource);

    assign(this.el.stsTargetLang, nextTarget);
    assign(this.el.toolbarTargetLang, nextTarget);
    assign(document.getElementById('select-target-lang'), nextTarget);

    this.currentSettings = {
      ...(this.currentSettings || {}),
      source_language: nextSource,
      target_language: nextTarget,
    };

    this._syncLanguagePickerDisplays();

    if (persist) {
      this._persistSettingsPatch({
        source_language: nextSource,
        target_language: nextTarget,
      }).catch((err) => {
        console.error('[settings] failed to save language pair', err);
      });
    }
  }

  _swapSourceAndTargetLanguages() {
    const source = this.el.stsSourceLang?.value || this.el.toolbarSourceLang?.value || 'auto';
    const target = this.el.stsTargetLang?.value || this.el.toolbarTargetLang?.value || 'en';

    let nextSource = target;
    let nextTarget = source;

    if (nextTarget === 'auto' || nextTarget === 'multi') {
      nextTarget = target === 'en' ? 'vi' : 'en';
      this._toast('Nguon dang Auto/Multi, da doi dich den ve mac dinh.');
    }

    this._setLanguagePair(nextSource, nextTarget, { persist: true });
  }

  _openSettingsPanel(panelTab = 'panel-stt') {
    if (this.el.appLayout) {
      this.el.appLayout.classList.add('panel-open');
    }
    this._activatePanelTab(panelTab);
  }

  _closeSettingsPanel() {
    if (this.el.appLayout) {
      this.el.appLayout.classList.remove('panel-open');
    }
  }

  _activatePanelTab(panelTab = 'panel-stt') {
    document.querySelectorAll('.panel-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.panelTab === panelTab);
    });
    document.querySelectorAll('.panel-tab-content').forEach((content) => {
      content.style.display = content.id === panelTab ? 'block' : 'none';
    });
  }

  _initBottomToolbarEvents() {
    const toolbarSource = document.getElementById('toolbar-source');
    const sourcePopup = document.getElementById('source-popup');
    const toolbarLanguage = document.getElementById('toolbar-language');
    const languagePopup = document.getElementById('language-popup');
    const toolbarVoice = document.getElementById('btn-tts');
    const voicePopup = document.getElementById('voice-popup');

    const popupPairs = [
      { button: toolbarSource, popup: sourcePopup },
      { button: toolbarLanguage, popup: languagePopup },
      { button: toolbarVoice, popup: voicePopup },
    ].filter((pair) => pair.button && pair.popup);

    const closeToolbarPopups = () => {
      popupPairs.forEach((pair) => pair.popup.classList.remove('show'));
      this._closeLanguagePickers();
    };

    popupPairs.forEach((pair) => {
      pair.button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const willShow = !pair.popup.classList.contains('show');
        closeToolbarPopups();
        if (willShow) {
          pair.popup.classList.add('show');
        }
      });
      pair.popup.addEventListener('click', (event) => event.stopPropagation());
    });

    if (popupPairs.length > 0) {
      document.addEventListener('click', closeToolbarPopups);
    }

    this._onClick(document.getElementById('btn-source-system'), () => {
      this._setSource('system');
      closeToolbarPopups();
    });
    this._onClick(document.getElementById('btn-source-mic'), () => {
      this._setSource('microphone');
      closeToolbarPopups();
    });
    this._onClick(document.getElementById('btn-source-both'), () => {
      this._setSource('both');
      closeToolbarPopups();
    });

    if (this.el.toolbarSourceLang) {
      this.el.toolbarSourceLang.addEventListener('change', () => {
        if (this.el.stsSourceLang) {
          this.el.stsSourceLang.value = this.el.toolbarSourceLang.value;
        }
        this._syncLanguagePickerDisplays();
        this._persistSettingsPatch({ source_language: this.el.toolbarSourceLang.value }).catch((err) => {
          console.error('[settings] failed to save source language', err);
        });
      });
    }

    if (this.el.toolbarTargetLang) {
      this.el.toolbarTargetLang.addEventListener('change', () => {
        if (this.el.stsTargetLang) {
          this.el.stsTargetLang.value = this.el.toolbarTargetLang.value;
        }
        this._syncLanguagePickerDisplays();
        this._persistSettingsPatch({ target_language: this.el.toolbarTargetLang.value }).catch((err) => {
          console.error('[settings] failed to save target language', err);
        });
      });
    }

    this._onClick(document.getElementById('toolbar-swap-languages'), () => {
      this._swapSourceAndTargetLanguages();
    });

    this._onClick(document.getElementById('sts-swap-languages'), () => {
      this._swapSourceAndTargetLanguages();
    });

    this._onClick(this.el.btnViewMode, () => {
      this._toggleViewMode();
    });

    this._onClick(this.el.btnSettings, () => {
      if (this.el.appLayout?.classList.contains('panel-open')) {
        this._closeSettingsPanel();
      } else {
        this._openSettingsPanel('panel-stt');
      }
    });

    this._onClick(this.el.btnClosePanel, () => {
      this._closeSettingsPanel();
    });

    document.querySelectorAll('.panel-tab[data-panel-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        this._activatePanelTab(tab.dataset.panelTab || 'panel-stt');
        this._openSettingsPanel(tab.dataset.panelTab || 'panel-stt');
      });
    });

    if (this.el.toolbarTtsEnabled) {
      this.el.toolbarTtsEnabled.addEventListener('change', () => {
        const enabled = Boolean(this.el.toolbarTtsEnabled?.checked);
        if (this.el.stsTtsEnabled) {
          this.el.stsTtsEnabled.checked = enabled;
        }
        this._persistSettingsPatch({ tts_enabled: enabled }).catch((err) => {
          console.error('[settings] failed to save tts_enabled', err);
        });
      });
    }

    if (this.el.toolbarTtsVolume && this.el.toolbarTtsVolumeValue) {
      this.el.toolbarTtsVolume.addEventListener('input', () => {
        const volumePercent = Number.parseInt(this.el.toolbarTtsVolume.value || '90', 10);
        this.el.toolbarTtsVolumeValue.textContent = `${volumePercent}%`;
        this.toolbarTtsVolume = Math.min(1, Math.max(0, volumePercent / 100));
        audioPlayer.setVolume(this.toolbarTtsVolume);
        window.localStorage?.setItem('toolbar_tts_volume', String(this.toolbarTtsVolume));
        if (this.el.stsTtsVolume) this.el.stsTtsVolume.value = String(volumePercent);
        if (this.el.stsTtsVolumeValue) this.el.stsTtsVolumeValue.textContent = `${volumePercent}%`;
      });
    }

    if (this.el.toolbarEdgeSpeed && this.el.toolbarEdgeSpeedValue) {
      this.el.toolbarEdgeSpeed.addEventListener('input', () => {
        const speed = Number.parseInt(this.el.toolbarEdgeSpeed.value || '20', 10);
        const display = `${speed >= 0 ? '+' : ''}${speed}%`;
        this.el.toolbarEdgeSpeedValue.textContent = display;
        if (this.el.stsEdgeSpeed) this.el.stsEdgeSpeed.value = String(speed);
        if (this.el.stsEdgeSpeedValue) this.el.stsEdgeSpeedValue.textContent = display;
      });

      this.el.toolbarEdgeSpeed.addEventListener('change', () => {
        const speed = Number.parseInt(this.el.toolbarEdgeSpeed.value || '20', 10);
        this._persistSettingsPatch({ edge_tts_speed: speed }).catch((err) => {
          console.error('[settings] failed to save edge_tts_speed', err);
        });
      });
    }

    if (this.el.toolbarEdgeVoice) {
      this.el.toolbarEdgeVoice.addEventListener('change', () => {
        const voice = this.el.toolbarEdgeVoice.value;
        if (this.el.stsEdgeVoice) {
          this.el.stsEdgeVoice.value = voice;
        }
        this._persistSettingsPatch({ edge_tts_voice: voice }).catch((err) => {
          console.error('[settings] failed to save edge_tts_voice', err);
        });
      });
    }

    if (this.el.stsAudioSource) {
      this.el.stsAudioSource.addEventListener('change', () => {
        this._setSource(this.el.stsAudioSource.value || 'system');
      });
    }

    if (this.el.sttProvider) {
      this.el.sttProvider.value = 'deepgram';
      this.el.sttProvider.disabled = true;
    }

    if (this.el.translationMethod) {
      this.el.translationMethod.value = 'azure';
      this.el.translationMethod.disabled = true;
    }

    if (this.el.translationType) {
      this.el.translationType.value = 'one_way';
      this.el.translationType.disabled = true;
    }

    if (this.el.stsSourceLang) {
      this.el.stsSourceLang.addEventListener('change', () => {
        if (this.el.toolbarSourceLang) {
          this.el.toolbarSourceLang.value = this.el.stsSourceLang.value;
        }
        this._syncLanguagePickerDisplays();
        this._persistSettingsPatch({ source_language: this.el.stsSourceLang.value }).catch((err) => {
          console.error('[settings] failed to save source language', err);
        });
      });
    }

    if (this.el.stsTargetLang) {
      this.el.stsTargetLang.addEventListener('change', () => {
        if (this.el.toolbarTargetLang) {
          this.el.toolbarTargetLang.value = this.el.stsTargetLang.value;
        }
        this._syncLanguagePickerDisplays();
        this._persistSettingsPatch({ target_language: this.el.stsTargetLang.value }).catch((err) => {
          console.error('[settings] failed to save target language', err);
        });
      });
    }

    if (this.el.stsTtsEnabled) {
      this.el.stsTtsEnabled.addEventListener('change', () => {
        const enabled = Boolean(this.el.stsTtsEnabled?.checked);
        if (this.el.toolbarTtsEnabled) {
          this.el.toolbarTtsEnabled.checked = enabled;
        }
        this._persistSettingsPatch({ tts_enabled: enabled }).catch((err) => {
          console.error('[settings] failed to save tts_enabled', err);
        });
      });
    }

    if (this.el.stsEdgeVoice) {
      this.el.stsEdgeVoice.addEventListener('change', () => {
        const voice = this.el.stsEdgeVoice.value;
        if (this.el.toolbarEdgeVoice) {
          this.el.toolbarEdgeVoice.value = voice;
        }
        this._persistSettingsPatch({ edge_tts_voice: voice }).catch((err) => {
          console.error('[settings] failed to save edge_tts_voice', err);
        });
      });
    }

    if (this.el.stsEdgeSpeed && this.el.stsEdgeSpeedValue) {
      this.el.stsEdgeSpeed.addEventListener('input', () => {
        const speed = Number.parseInt(this.el.stsEdgeSpeed.value || '20', 10);
        const display = `${speed >= 0 ? '+' : ''}${speed}%`;
        this.el.stsEdgeSpeedValue.textContent = display;
        if (this.el.toolbarEdgeSpeed) this.el.toolbarEdgeSpeed.value = String(speed);
        if (this.el.toolbarEdgeSpeedValue) this.el.toolbarEdgeSpeedValue.textContent = display;
      });

      this.el.stsEdgeSpeed.addEventListener('change', () => {
        const speed = Number.parseInt(this.el.stsEdgeSpeed.value || '20', 10);
        this._persistSettingsPatch({ edge_tts_speed: speed }).catch((err) => {
          console.error('[settings] failed to save edge_tts_speed', err);
        });
      });
    }

    if (this.el.stsTtsVolume && this.el.stsTtsVolumeValue) {
      this.el.stsTtsVolume.addEventListener('input', () => {
        const volumePercent = Number.parseInt(this.el.stsTtsVolume.value || '90', 10);
        this.el.stsTtsVolumeValue.textContent = `${volumePercent}%`;
        this.toolbarTtsVolume = Math.min(1, Math.max(0, volumePercent / 100));
        audioPlayer.setVolume(this.toolbarTtsVolume);
        window.localStorage?.setItem('toolbar_tts_volume', String(this.toolbarTtsVolume));
        if (this.el.toolbarTtsVolume) this.el.toolbarTtsVolume.value = String(volumePercent);
        if (this.el.toolbarTtsVolumeValue) this.el.toolbarTtsVolumeValue.textContent = `${volumePercent}%`;
      });
    }
  }

  _syncToolbarLanguageControls(settings) {
    const source = settings?.source_language || 'auto';
    const target = settings?.target_language || 'en';
    this._setLanguagePair(source, target, { persist: false });
  }

  _syncToolbarVoiceControls(settings = this.currentSettings || {}) {
    const enabled = Boolean(settings.tts_enabled);
    const edgeSpeed = settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20;
    const edgeVoice = settings.edge_tts_voice || 'vi-VN-HoaiMyNeural';
    const volumePercent = Math.round(this.toolbarTtsVolume * 100);

    if (this.el.toolbarTtsEnabled) this.el.toolbarTtsEnabled.checked = enabled;
    if (this.el.stsTtsEnabled) this.el.stsTtsEnabled.checked = enabled;

    if (this.el.toolbarTtsVolume) this.el.toolbarTtsVolume.value = String(volumePercent);
    if (this.el.toolbarTtsVolumeValue) this.el.toolbarTtsVolumeValue.textContent = `${volumePercent}%`;
    if (this.el.stsTtsVolume) this.el.stsTtsVolume.value = String(volumePercent);
    if (this.el.stsTtsVolumeValue) this.el.stsTtsVolumeValue.textContent = `${volumePercent}%`;

    const speedDisplay = `${edgeSpeed >= 0 ? '+' : ''}${edgeSpeed}%`;
    if (this.el.toolbarEdgeSpeed) this.el.toolbarEdgeSpeed.value = String(edgeSpeed);
    if (this.el.toolbarEdgeSpeedValue) this.el.toolbarEdgeSpeedValue.textContent = speedDisplay;
    if (this.el.stsEdgeSpeed) this.el.stsEdgeSpeed.value = String(edgeSpeed);
    if (this.el.stsEdgeSpeedValue) this.el.stsEdgeSpeedValue.textContent = speedDisplay;

    if (this.el.toolbarEdgeVoice) this.el.toolbarEdgeVoice.value = edgeVoice;
    if (this.el.stsEdgeVoice) this.el.stsEdgeVoice.value = edgeVoice;
  }

  async _setSource(source) {
    if (!['system', 'microphone', 'both'].includes(source)) {
      return;
    }

    const wasRunning = this.isRunning;
    this.currentSource = source;

    if (this.el.audioSource) this.el.audioSource.value = source;
    if (this.el.stsAudioSource) this.el.stsAudioSource.value = source;

    this._updateSourceButtons();

    try {
      await this._persistSettingsPatch({ audio_source: source });
    } catch (err) {
      console.warn('[settings] failed to save audio source', err);
    }

    if (wasRunning) {
      await this.stop();
      await this.start();
    }
  }

  _updateSourceButtons() {
    const current = this.currentSource || 'system';
    const sourceButtons = [
      { id: 'btn-source-system', value: 'system' },
      { id: 'btn-source-mic', value: 'microphone' },
      { id: 'btn-source-both', value: 'both' },
    ];

    sourceButtons.forEach((entry) => {
      const button = document.getElementById(entry.id);
      if (button) {
        button.classList.toggle('active', entry.value === current);
      }
    });
  }

  _applyViewMode(mode) {
    this._applyViewMode(mode, { persist: false });
  }

  _applyViewMode(mode, options = {}) {
    const persist = Boolean(options.persist);
    const normalized = mode === 'single' ? 'single' : 'dual';
    this.viewMode = normalized;
    this.displayModeInputs.forEach((input) => {
      input.checked = input.value === normalized;
    });

    if (this.transcriptUI) {
      this.transcriptUI.configure({
        viewMode: normalized,
        fontSize: Number(this.currentSettings?.font_size || 16),
        maxLines: Number(this.currentSettings?.max_lines || 5),
        showOriginal: Boolean(this.currentSettings?.show_original ?? true),
      });
    }

    if (this.el.btnViewMode) {
      this.el.btnViewMode.classList.toggle('active', normalized === 'dual');
    }

    if (this.el.transcriptContainer) {
      this.el.transcriptContainer.classList.toggle('view-single', normalized === 'single');
    }

    window.localStorage?.setItem('compact_view_mode', normalized);

    if (persist) {
      this._persistSettingsPatch({ view_mode: normalized }).catch((err) => {
        console.error('[settings] failed to save view_mode', err);
      });
    }
  }

  _toggleViewMode() {
    this._applyViewMode(this.viewMode === 'dual' ? 'single' : 'dual', { persist: true });
  }

  _applyDisplaySettings(settings, options = {}) {
    const persist = Boolean(options.persist);
    const maxLines = Number(settings.max_lines ?? 5);
    const fontSize = Number(settings.font_size ?? 16);
    const overlayOpacity = Number(settings.overlay_opacity ?? 0.85);
    const showOriginal = Boolean(settings.show_original ?? true);
    const viewMode = (settings.view_mode === 'single' || settings.view_mode === 'dual') ? settings.view_mode : this.viewMode;

    if (this.el.rangeMaxLines) this.el.rangeMaxLines.value = String(maxLines);
    if (this.el.maxLinesValue) this.el.maxLinesValue.textContent = String(maxLines);
    if (this.el.rangeFontSize) this.el.rangeFontSize.value = String(fontSize);
    if (this.el.fontSizeValue) this.el.fontSizeValue.textContent = `${fontSize}px`;
    if (this.el.fontSizeDisplay) this.el.fontSizeDisplay.textContent = String(fontSize);
    if (this.el.rangeOpacity) this.el.rangeOpacity.value = String(Math.round(overlayOpacity * 100));
    if (this.el.opacityValue) this.el.opacityValue.textContent = `${Math.round(overlayOpacity * 100)}%`;
    if (this.el.checkShowOriginal) this.el.checkShowOriginal.checked = showOriginal;

    this.currentSettings = {
      ...(this.currentSettings || {}),
      max_lines: maxLines,
      font_size: fontSize,
      overlay_opacity: overlayOpacity,
      show_original: showOriginal,
      view_mode: viewMode,
    };

    if (this.el.transcriptContainer) {
      this.el.transcriptContainer.style.opacity = String(Math.min(1, Math.max(0.2, overlayOpacity)));
    }

    this._applyViewMode(viewMode, { persist: false });

    if (this.transcriptUI) {
      this.transcriptUI.configure({
        maxLines,
        fontSize,
        showOriginal,
        viewMode,
      });
    }

    if (persist) {
      this._persistSettingsPatch({
        max_lines: maxLines,
        font_size: fontSize,
        overlay_opacity: overlayOpacity,
        show_original: showOriginal,
        view_mode: viewMode,
      }).catch((err) => {
        console.error('[settings] failed to save display settings', err);
      });
    }
  }

  _bindDeepgramEvents() {
    deepgramClient.onStatus = (status) => {
      switch (status) {
        case 'connected':
          this._setStatus('connected', 'Deepgram connected');
          break;
        case 'connecting':
          this._setStatus('connecting', 'Dang ket noi Deepgram');
          break;
        case 'error':
          this._setStatus('error', 'Deepgram loi');
          break;
        default:
          this._setStatus('ready', 'San sang');
          break;
      }
    };

    deepgramClient.onProvisional = (text) => {
      this.provisionalText = String(text || '').trim();
      if (this.transcriptUI) {
        this.transcriptUI.setProvisional(this.provisionalText, null, this.currentSettings?.source_language || null);
      }
      if (this.el.provisional) {
        this.el.provisional.textContent = this.provisionalText;
      }
    };

    deepgramClient.onOriginal = async (text, language) => {
      const normalized = String(text || '').trim();
      if (!normalized) return;
      if (this.transcriptUI) {
        this.transcriptUI.clearProvisional();
        this.transcriptUI.addOriginal(normalized, null, language || this.currentSettings?.source_language || null);
      }
      if (this.el.provisional) {
        this.el.provisional.textContent = '';
      }

      const sourceLang = (language || this.currentSettings.source_language || 'auto').toString();
      const targetLang = this.currentSettings.target_language || 'en';
      await this._queueTranslation(normalized, sourceLang, targetLang);
    };

    deepgramClient.onError = async (message) => {
      this._toast(message || 'Deepgram loi');
      if (this.isRunning) {
        await this.stop();
      }
    };
  }

  async start() {
    const settings = this._collectFormSettings();
    await settingsManager.save(settings);
    this.currentSettings = settings;

    if (!settings.deepgram_api_key) {
      this._toast('Can Deepgram API key');
      return;
    }
    if (!settings.azure_translator_key1 && !settings.azure_translator_key2) {
      this._toast('Can Azure Translator key');
      return;
    }

    this.isRunning = true;
    this._setStartButtonState(true);
    this.lastTranslatedKey = '';
    this._showScreen('transcript');
    if (this.transcriptUI) {
      this.transcriptUI.showListening();
      this.transcriptUI.clearProvisional();
    }

    try {
      const probe = new Channel();
      await invoke('start_capture', {
        source: settings.audio_source,
        channel: probe,
      });
      await invoke('stop_capture');

      await deepgramClient.connect({
        sourceLanguage: settings.source_language,
        endpointDelay: Number(settings.endpoint_delay || 1500),
      });
      await deepgramClient.startAudioForward(settings.audio_source);
      this._setStatus('connected', 'Dang nhan transcript');
    } catch (err) {
      this._toast(`Start failed: ${err}`);
      await this.stop();
    }
  }

  async stop() {
    this.isRunning = false;
    this._setStartButtonState(false);

    try {
      await invoke('stop_capture');
    } catch {}

    await deepgramClient.disconnect();

    this.translationQueue = Promise.resolve();
    if (this.transcriptUI) {
      this.transcriptUI.clearProvisional();
    }
    if (this.el.provisional) {
      this.el.provisional.textContent = '';
    }

    if ((this.transcriptUI && this.transcriptUI.hasSegments()) || this.translations.length > 0) {
      await this._saveTranscript();
    }
  }

  async _queueTranslation(text, sourceLang, targetLang) {
    const dedupeKey = `${sourceLang}|${targetLang}|${text}`;
    if (dedupeKey === this.lastTranslatedKey) {
      return;
    }

    this.translationQueue = this.translationQueue
      .catch(() => {})
      .then(async () => {
        const response = await invoke('azure_translate_text', {
          text,
          sourceLang,
          targetLang,
        });

        const translated = (response?.translated || '').trim();
        if (!translated) return;

        this.lastTranslatedKey = dedupeKey;
        this._appendTranslation(translated, response?.engine || 'azure');
        await speakText(translated, this.currentSettings);
      })
      .catch((err) => {
        console.error('[translate]', err);
        this._toast(`Dich loi: ${err}`);
      });

    return this.translationQueue;
  }

  _appendTranslation(text, engine) {
    if (this.transcriptUI) {
      this.transcriptUI.addTranslation(text);
    }

    if (!this.el.translationList) {
      const row = {
        time: new Date().toLocaleTimeString(),
        text,
        engine,
      };
      this.translations.push(row);
      return;
    }

    const placeholder = document.querySelector('.transcript-placeholder');
    if (placeholder) {
      placeholder.remove();
    }

    const row = {
      time: new Date().toLocaleTimeString(),
      text,
      engine,
    };
    this.translations.push(row);

    const item = document.createElement('div');
    item.className = 'translation-item';
    item.innerHTML = `
      <div class="translation-meta">
        <span>${row.time}</span>
        <span>${row.engine}</span>
      </div>
      <div>${this._escapeHtml(row.text)}</div>
    `;

    this.el.translationList.appendChild(item);
    this.el.translationList.scrollTop = this.el.translationList.scrollHeight;
  }

  async _saveTranscript() {
    if (this.transcriptUI && this.transcriptUI.hasSegments()) {
      const content = this.transcriptUI.getFormattedContent({
        model: 'azure-translator-v3',
        sourceLang: this.currentSettings?.source_language,
        targetLang: this.currentSettings?.target_language,
        audioSource: this.currentSettings?.audio_source,
      });
      if (content) {
        try {
          await invoke('save_transcript', { content: `${content}\n` });
        } catch (err) {
          console.warn('[transcript] save failed', err);
        }
        return;
      }
    }

    const header = [
      '---',
      `source_language: ${this.currentSettings.source_language}`,
      `target_language: ${this.currentSettings.target_language}`,
      `audio_source: ${this.currentSettings.audio_source}`,
      `segments: ${this.translations.length}`,
      '---',
      '',
    ].join('\n');

    const body = this.translations
      .map((row) => `- [${row.time}] ${row.text}`)
      .join('\n');

    const content = `${header}${body}\n`;
    try {
      await invoke('save_transcript', { content });
    } catch (err) {
      console.warn('[transcript] save failed', err);
    }
  }

  async refreshHistory() {
    if (!this.el.historyList) {
      return;
    }

    try {
      const rows = await invoke('list_transcripts');
      this.historyRows = Array.isArray(rows) ? rows : [];
      this._renderHistory(this.el.historySearchInput?.value || '');
    } catch (err) {
      console.error('[history]', err);
      this.el.historyList.innerHTML = '<div class="history-empty">Khong tai duoc lich su.</div>';
    }
  }

  _renderHistory(query = '') {
    if (!this.el.historyList) return;

    const normalizedQuery = String(query || '').trim().toLowerCase();
    const rows = this.historyRows.filter((row) => {
      if (!normalizedQuery) return true;
      const blob = [
        row.filename,
        row.preview,
        row.source_language,
        row.target_language,
        row.recording_duration,
      ].filter(Boolean).join(' ').toLowerCase();
      return blob.includes(normalizedQuery);
    });

    this.el.historyList.innerHTML = '';
    if (rows.length === 0) {
      this.el.historyList.innerHTML = '<div class="history-empty">Chua co phien nao khop tu khoa.</div>';
      return;
    }

    const grouped = this._groupHistoryRows(rows);
    grouped.forEach((group) => {
      const section = document.createElement('section');
      section.className = 'history-group';
      const title = document.createElement('div');
      title.className = 'history-group-title';
      title.textContent = group.label;
      section.appendChild(title);

      group.items.forEach((row) => {
        section.appendChild(this._createHistoryCard(row));
      });
      this.el.historyList.appendChild(section);
    });
  }

  _groupHistoryRows(rows) {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const startWeek = startToday - (6 * 24 * 60 * 60);

    const groups = [
      { key: 'today', label: 'HOM NAY', items: [] },
      { key: 'week', label: 'TUAN NAY', items: [] },
      { key: 'older', label: 'TRUOC DO', items: [] },
    ];

    rows.forEach((row) => {
      const ts = Number(row.created_at || 0);
      if (ts >= startToday) {
        groups[0].items.push(row);
      } else if (ts >= startWeek) {
        groups[1].items.push(row);
      } else {
        groups[2].items.push(row);
      }
    });

    return groups.filter((group) => group.items.length > 0);
  }

  _createHistoryCard(row) {
    const card = document.createElement('article');
    card.className = 'history-session-card';

    const createdAt = Number(row.created_at || 0) * 1000;
    const date = createdAt > 0 ? new Date(createdAt) : new Date();
    const hhmm = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const source = this._getLanguageMeta(row.source_language || 'auto');
    const target = this._getLanguageMeta(row.target_language || 'en');
    const duration = row.recording_duration || '--';
    const sessionTitleRaw = row.filename
      ? row.filename.replace(/\.md$/i, '')
      : `Session ${this._formatSessionTimestamp(date)}`;
    const sessionTitle = sessionTitleRaw.length > 68
      ? `${sessionTitleRaw.slice(0, 68)}...`
      : sessionTitleRaw;

    const previewHtml = this._formatHistoryPreview(row.preview || '');

    card.innerHTML = `
      <div class="history-session-head">
        <div class="history-session-copy">
          <h3 class="history-session-title">${this._escapeHtml(sessionTitle)}</h3>
          <div class="history-session-sub">
            <span class="history-lang-chip">${this._escapeHtml(source.flag)} ${this._escapeHtml(source.name)}</span>
            <span class="history-lang-sep">→</span>
            <span class="history-lang-chip">${this._escapeHtml(target.flag)} ${this._escapeHtml(target.name)}</span>
            <span class="history-dot">•</span>
            <span>${this._escapeHtml(hhmm)}</span>
            <span class="history-dot">•</span>
            <span>${this._escapeHtml(duration)}</span>
          </div>
        </div>
        <div class="history-session-actions">
          <button class="history-action-btn primary" data-action="continue" type="button">▶ Tiep tuc</button>
          <button class="history-action-btn" data-action="view" type="button">Xem</button>
          <button class="history-action-btn icon-only" data-action="download" type="button" title="Tai transcript">⇩</button>
          <button class="history-action-btn icon-only danger" data-action="delete" type="button" title="Xoa">✕</button>
        </div>
      </div>
      <div class="history-preview">${previewHtml}</div>
    `;

    card.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'continue') {
        await this._resumeHistorySession(row);
      } else if (action === 'view') {
        await this._openHistoryModal(row);
      } else if (action === 'download') {
        await this._downloadHistoryTranscript(row);
      } else if (action === 'delete') {
        await this._deleteHistorySession(row);
      }
    });

    return card;
  }

  _formatSessionTimestamp(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}`;
  }

  _formatHistoryPreview(preview) {
    const lines = String(preview || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 8);

    if (lines.length === 0) {
      return '<p class="history-line">Khong co noi dung xem truoc.</p>';
    }

    const items = [];
    let pendingOriginal = null;
    lines.forEach((line) => {
      if (line.startsWith('> ')) {
        if (pendingOriginal) {
          items.push(`<p class="history-line"><span class="history-original">${this._escapeHtml(pendingOriginal)}</span></p>`);
        }
        pendingOriginal = line.slice(2).trim();
        return;
      }

      if (pendingOriginal) {
        items.push(`<p class="history-line"><span class="history-original">${this._escapeHtml(pendingOriginal)}</span><span class="history-arrow">→</span><span class="history-translation">${this._escapeHtml(line)}</span></p>`);
        pendingOriginal = null;
      } else {
        items.push(`<p class="history-line"><span class="history-translation">${this._escapeHtml(line)}</span></p>`);
      }
    });

    if (pendingOriginal) {
      items.push(`<p class="history-line"><span class="history-original">${this._escapeHtml(pendingOriginal)}</span></p>`);
    }

    return items.join('');
  }

  async _openHistoryModal(row) {
    const modal = document.getElementById('history-modal');
    const title = document.getElementById('history-modal-title');
    const content = document.getElementById('history-modal-content');
    if (!modal || !content) return;

    const full = await invoke('get_transcript', { path: row.path });
    if (title) {
      title.textContent = row.filename || 'Transcript';
    }
    content.textContent = full;
    modal.style.display = 'flex';
  }

  async _downloadHistoryTranscript(row) {
    const full = await invoke('get_transcript', { path: row.path });
    const blob = new Blob([full], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = row.filename || `transcript-${Date.now()}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async _deleteHistorySession(row) {
    const ok = window.confirm(`Xoa transcript ${row.filename || ''}?`);
    if (!ok) return;
    await invoke('delete_transcript', { path: row.path });
    await this.refreshHistory();
    this._toast('Da xoa transcript');
  }

  async _resumeHistorySession(row) {
    const full = await invoke('get_transcript', { path: row.path });
    const segments = this._parseTranscriptContent(full);

    if (this.transcriptUI) {
      this.transcriptUI.clear();
      segments.forEach((seg) => {
        if (seg.original) this.transcriptUI.addOriginal(seg.original, null, null);
        if (seg.translation) this.transcriptUI.addTranslation(seg.translation);
      });
      if (!this.transcriptUI.hasContent()) {
        this.transcriptUI.showPlaceholder();
      }
    }

    this._showScreen('transcript');
    this._toast('Da mo lai transcript');
  }

  _parseTranscriptContent(content) {
    const normalized = String(content || '').replace(/\r\n/g, '\n');
    let body = normalized;
    if (normalized.startsWith('---\n')) {
      const parts = normalized.split('\n---\n');
      if (parts.length > 1) {
        body = parts.slice(1).join('\n---\n');
      }
    }

    const segments = [];
    let pendingOriginal = null;
    body.split('\n').map((line) => line.trim()).forEach((line) => {
      if (!line) {
        if (pendingOriginal) {
          segments.push({ original: pendingOriginal, translation: null });
          pendingOriginal = null;
        }
        return;
      }

      if (line.startsWith('> ')) {
        if (pendingOriginal) {
          segments.push({ original: pendingOriginal, translation: null });
        }
        pendingOriginal = line.slice(2).trim();
        return;
      }

      if (pendingOriginal) {
        segments.push({ original: pendingOriginal, translation: line });
        pendingOriginal = null;
      } else {
        segments.push({ original: null, translation: line });
      }
    });

    if (pendingOriginal) {
      segments.push({ original: pendingOriginal, translation: null });
    }
    return segments;
  }

  _showScreen(name) {
    const isMain = name === 'main' || name === 'home';
    const isHistory = name === 'history';
    const isTranscript = name === 'transcript';
    const isInterface = name === 'interface' || name === 'system';

    if (this.el.tabMain) this.el.tabMain.classList.toggle('active', isMain || isTranscript);
    if (this.el.tabHistory) this.el.tabHistory.classList.toggle('active', isHistory);
    if (this.el.tabInterface) this.el.tabInterface.classList.toggle('active', isInterface);

    if (this.el.screenMain) this.el.screenMain.classList.toggle('active', isMain);
    if (this.el.screenHistory) this.el.screenHistory.classList.toggle('active', isHistory);
    if (this.el.screenTranscript) this.el.screenTranscript.classList.toggle('active', isTranscript);
    if (this.el.screenInterface) this.el.screenInterface.classList.toggle('active', isInterface);

    const modernScreens = ['home', 'history', 'transcript', 'interface'];
    let target = 'home';
    if (isHistory) target = 'history';
    if (isTranscript) target = 'transcript';
    if (isInterface) target = 'interface';
    modernScreens.forEach((screen) => {
      const el = document.getElementById(`screen-${screen}`);
      if (el) {
        el.classList.toggle('active', screen === target);
      }
    });

    const sidebarItems = document.querySelectorAll('.sidebar-item[data-screen]');
    sidebarItems.forEach((item) => {
      const screen = item.dataset.screen;
      const active = screen === target || (target === 'transcript' && screen === 'home');
      item.classList.toggle('active', active);
    });
  }

  _setStatus(kind, text) {
    if (this.el.statusDot) {
      const baseClass = this.el.statusDot.classList.contains('status-dot') ? 'status-dot' : 'dot';
      this.el.statusDot.className = baseClass;
      if (kind === 'connected') this.el.statusDot.classList.add('connected');
      if (kind === 'connecting') this.el.statusDot.classList.add('connecting');
      if (kind === 'error') this.el.statusDot.classList.add('error');
    }
    if (this.el.statusText) this.el.statusText.textContent = text;
    if (this.el.recordingStatusText) this.el.recordingStatusText.textContent = text;
  }

  _applySettingsToForm(settings) {
    if (this.el.translationType) {
      this.el.translationType.value = 'one_way';
      this.el.translationType.disabled = true;
    }
    if (this.el.sttProvider) {
      this.el.sttProvider.value = 'deepgram';
      this.el.sttProvider.disabled = true;
    }
    if (this.el.translationMethod) {
      this.el.translationMethod.value = 'azure';
      this.el.translationMethod.disabled = true;
    }

    this.currentSource = settings.audio_source || this.currentSource || 'system';
    if (this.el.audioSource) this.el.audioSource.value = settings.audio_source;
    if (this.el.stsAudioSource) this.el.stsAudioSource.value = this.currentSource;
    if (this.el.sourceLanguage) this.el.sourceLanguage.value = settings.source_language;
    if (this.el.targetLanguage) this.el.targetLanguage.value = settings.target_language;
    this._syncToolbarLanguageControls(settings);
    if (this.el.deepgramKey) this.el.deepgramKey.value = settings.deepgram_api_key;
    if (this.el.endpointDelay) this.el.endpointDelay.value = settings.endpoint_delay;

    if (this.el.azureTranslatorKey1) this.el.azureTranslatorKey1.value = settings.azure_translator_key1;
    if (this.el.azureTranslatorKey2) this.el.azureTranslatorKey2.value = settings.azure_translator_key2;
    if (this.el.azureTranslatorRegion) this.el.azureTranslatorRegion.value = settings.azure_translator_region;
    if (this.el.azureTranslatorEndpoint) this.el.azureTranslatorEndpoint.value = settings.azure_translator_endpoint;
    if (this.el.azureSpeechKey) this.el.azureSpeechKey.value = settings.azure_speech_key || '';
    if (this.el.azureSpeechRegion) this.el.azureSpeechRegion.value = settings.azure_speech_region || 'eastasia';

    if (this.el.ttsEnabled) this.el.ttsEnabled.checked = Boolean(settings.tts_enabled);
    if (this.el.ttsProvider) this.el.ttsProvider.value = settings.tts_provider;
    if (this.el.edgeVoice) this.el.edgeVoice.value = settings.edge_tts_voice;
    if (this.el.edgeSpeed) this.el.edgeSpeed.value = settings.edge_tts_speed;
    if (this.el.azureVoice) this.el.azureVoice.value = settings.azure_tts_voice;
    if (this.el.azureSpeed) this.el.azureSpeed.value = settings.azure_tts_speed;
    this._syncToolbarVoiceControls(settings);
    this._updateSourceButtons();
    this._applyDisplaySettings(settings, { persist: false });
    this._applyAppearanceSettings(settings, { persist: false });
  }

  _collectFormSettings() {
    const valueOf = (el, fallback = '') => (el ? String(el.value ?? '').trim() : fallback);
    const numberOf = (el, fallback) => {
      if (!el) return fallback;
      const parsed = Number(el.value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    return {
      translation_type: 'one_way',
      translation_mode: 'deepgram',
      translation_model: 'azure',
      deepgram_api_key: valueOf(this.el.deepgramKey),
      source_language: valueOf(this.el.sourceLanguage, 'auto') || 'auto',
      target_language: valueOf(this.el.targetLanguage, 'en') || 'en',
      audio_source: this.currentSource || this.el.audioSource?.value || 'system',
      endpoint_delay: numberOf(this.el.endpointDelay, 1500),
      overlay_opacity: Number(this.el.rangeOpacity?.value || 85) / 100,
      view_mode: this.viewMode,
      font_size: numberOf(this.el.rangeFontSize, 16),
      max_lines: numberOf(this.el.rangeMaxLines, 5),
      show_original: Boolean(this.el.checkShowOriginal?.checked ?? true),
      theme_mode: this.themeMode || this.currentSettings?.theme_mode || 'dark',
      accent_preset: this.currentAccentPreset || this.currentSettings?.accent_preset || 'violet-neon',
      ui_locale: this.currentLocale || this.currentSettings?.ui_locale || 'vi',
      azure_translator_key1: valueOf(this.el.azureTranslatorKey1),
      azure_translator_key2: valueOf(this.el.azureTranslatorKey2),
      azure_translator_region: valueOf(this.el.azureTranslatorRegion, 'eastasia') || 'eastasia',
      azure_translator_endpoint: valueOf(this.el.azureTranslatorEndpoint, 'https://api.cognitive.microsofttranslator.com') || 'https://api.cognitive.microsofttranslator.com',
      azure_speech_key: valueOf(this.el.azureSpeechKey),
      azure_speech_region: valueOf(this.el.azureSpeechRegion, 'eastasia') || 'eastasia',
      tts_enabled: Boolean(this.el.ttsEnabled?.checked),
      tts_provider: this.el.ttsProvider?.value || 'edge',
      edge_tts_voice: valueOf(this.el.edgeVoice, 'vi-VN-HoaiMyNeural') || 'vi-VN-HoaiMyNeural',
      edge_tts_speed: numberOf(this.el.edgeSpeed, 20),
      azure_tts_voice: valueOf(this.el.azureVoice, 'en-US-AvaMultilingualNeural') || 'en-US-AvaMultilingualNeural',
      azure_tts_speed: numberOf(this.el.azureSpeed, 0),
    };
  }

  _escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  _toast(message) {
    console.log('[toast]', message);
    if (this.el.statusText) this.el.statusText.textContent = message;
    if (this.el.recordingStatusText) this.el.recordingStatusText.textContent = message;
  }
}
