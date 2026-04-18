/**
 * App — main application controller
 * Wires together: settings, UI, Deepgram/local STT, and audio capture
 */

import { settingsManager } from './settings.js';
import { TranscriptUI } from './ui.js';
import { deepgramClient } from './deepgram.js';
import { edgeTTSRust } from './edge-tts.js';
import { audioPlayer } from './audio-player.js';
import { updater } from './updater.js';
import { applyI18n, t } from './i18n.js';

const tauriGlobal = window.__TAURI__ || {};
const tauriCore = tauriGlobal.core || {};
const tauriWindowApi = tauriGlobal.window || {};
const tauriOpener = tauriGlobal.opener || {};

const invoke = typeof tauriCore.invoke === 'function'
    ? tauriCore.invoke.bind(tauriCore)
    : async () => {
        throw new Error('Tauri core.invoke is unavailable');
    };

const getCurrentWindow = typeof tauriWindowApi.getCurrentWindow === 'function'
    ? tauriWindowApi.getCurrentWindow.bind(tauriWindowApi)
    : (typeof tauriWindowApi.getCurrent === 'function'
        ? tauriWindowApi.getCurrent.bind(tauriWindowApi)
        : null);

const createFallbackWindowHandle = () => ({
    close: async () => {},
    minimize: async () => {},
    setAlwaysOnTop: async () => {},
    scaleFactor: async () => 1,
    outerPosition: async () => ({ x: 0, y: 0 }),
    innerSize: async () => ({ width: 1200, height: 760 }),
    setSize: async () => {},
    setPosition: async () => {},
});

class App {
    constructor() {
        this.isRunning = false;
        this.isStarting = false; // Guard against re-entry
        this.runToggleInProgress = false;
        this.currentSource = 'system'; // 'system' | 'microphone' | 'both'
        this.translationMode = 'local'; // 'deepgram' | 'local'
        this.transcriptUI = null;
        this.appWindow = getCurrentWindow ? getCurrentWindow() : createFallbackWindowHandle();
        this.localPipelineChannel = null;
        this.localPipelineReady = false;
        this.localPipelineClosed = false;
        this.platformInfo = { os: 'unknown', arch: 'unknown' };
        this.isLocalSetupRunning = false;
        this.localSetupReady = false;
        this.recordingStartTime = null;
        this.deepgramTranslationQueue = Promise.resolve();
        this.deepgramRecentTranslatedTexts = [];
        this.lastDeepgramTranslatedAt = 0;
        this.deepgramLastTranslatedByGroup = new Map();
        this.deepgramLatestRevisionByGroup = new Map();
        this.deepgramPreparedTranslationKey = null;
        this.deepgramPendingGroup = null;
        this.deepgramFlushTimer = null;
        this.deepgramFlushDelayMs = 450;
        this.deepgramPreviewDelayMs = 180;
        this.deepgramGroupCounter = 0;
        this.deepgramEventStats = null;
        this.deepgramDebugSessionId = null;
        this.localTranslationQueue = Promise.resolve();
        this.localPreparedTranslationKey = null;
        this.localLatestRevisionByGroup = new Map();
        this.localLastTranslatedByGroup = new Map();
        this.localSentenceStateByUtterance = new Map();
        this.localRecentCommittedGroups = [];
        this.localCarryOver = null;
        this.localCarryOverTimeout = null;
        this.localPipelineConfig = null;
        this.localActualModel = null;
        this.ttsEnabled = false;  // TTS runtime toggle
        this.isPinned = false;    // Always-on-top state
        this.themeMode = 'dark';
        this.currentAccentPreset = 'violet-neon';
        this.currentLocale = 'vi';
        this.systemThemeMedia = window.matchMedia?.('(prefers-color-scheme: dark)') || null;
        this.activePanelTab = 'panel-stt';
        this.settingsAutosaveTimer = null;
        this.settingsAutosavePromise = Promise.resolve();
        const savedVolume = parseFloat(window.localStorage?.getItem('toolbar_tts_volume') || '0.9');
        this.toolbarTtsVolume = Number.isFinite(savedVolume)
            ? Math.min(1, Math.max(0, savedVolume))
            : 0.9;
    }

    async init() {
        window.__TB_INIT_STAGE = 'load_settings';

        // Load settings
        await settingsManager.load();

        window.__TB_INIT_STAGE = 'init_transcript_ui';
        // Init transcript UI
        const transcriptContainer = document.getElementById('transcript-content');
        this.transcriptUI = new TranscriptUI(transcriptContainer);
        this.transcriptUI.configure({ viewMode: settingsManager.get().view_mode || 'dual' });

        window.__TB_INIT_STAGE = 'check_platform';
        // Check platform — local engine is available on Apple Silicon and Windows
        await this._checkPlatformSupport();

        window.__TB_INIT_STAGE = 'apply_settings';
        // Apply saved settings to UI
        this._applySettings(settingsManager.get());

        window.__TB_INIT_STAGE = 'bind_events';
        // Bind event listeners
        this._bindEvents();

        // Mark app interactive as soon as core listeners are attached.
        window.__TB_APP_READY = true;
        window.__TB_INIT_STAGE = 'interactive';

        window.__TB_INIT_STAGE = 'refresh_local_setup';
        if (this.supportsLocalMode) {
            await this._refreshLocalSetupUI();
            const current = settingsManager.get();
            if (
                current.translation_mode === 'local'
                && !this.localSetupReady
                && !this.isLocalSetupRunning
            ) {
                try {
                    await settingsManager.save({ translation_mode: 'deepgram' });
                    this._updateModeUI('deepgram');
                    this._showToast('Đã chuyển sang Deepgram vì Local chưa setup.', 'info');
                } catch (err) {
                    console.warn('[App] Failed to switch mode fallback:', err);
                }
            }
        }

        window.__TB_INIT_STAGE = 'bind_shortcuts';
        // Bind keyboard shortcuts
        this._bindKeyboardShortcuts();

        window.__TB_INIT_STAGE = 'subscribe_settings';
        // Subscribe to settings changes
        settingsManager.onChange((settings) => this._applySettings(settings));

        window.__TB_INIT_STAGE = 'init_audio';
        // Init audio player for TTS
        audioPlayer.init();
        audioPlayer.setVolume(this.toolbarTtsVolume);

        edgeTTSRust.onAudioChunk = (base64Audio) => {
            audioPlayer.enqueue(base64Audio);
        };
        edgeTTSRust.onError = (error) => {
            console.error('[TTS]', error);
            this._showToast(error, 'error');
        };

        // Window position restore disabled — causes issues on Retina displays
        // await this._restoreWindowPosition();

        // Check for updates (non-blocking)
        this._checkForUpdates();

        await this.appWindow.setAlwaysOnTop(this.isPinned);
        const pinBtn = document.getElementById('btn-pin');
        if (pinBtn) pinBtn.classList.toggle('active', this.isPinned);

        console.log('🌐 My Translator v0.5.0 initialized');

        // ── New TranslaBuddy UI Navigation ──
        this._initNewNavigation();
        this._initToolbarEvents();
        this._initAppearanceEvents();

        if (this.systemThemeMedia?.addEventListener) {
            this.systemThemeMedia.addEventListener('change', () => {
                if (this.themeMode === 'system') {
                    this._applyAppearanceSettings(settingsManager.get());
                }
            });
        }

        window.__TB_INIT_STAGE = 'done';
    }

    _initNewNavigation() {
        // Sidebar navigation
        document.querySelectorAll('.sidebar-item[data-screen]').forEach(btn => {
            btn.addEventListener('click', () => {
                const screen = btn.dataset.screen;
                
                // Don't switch screen if currently recording
                if (this.isRunning && screen !== 'transcript') {
                    this._showToast('Stop recording to switch modules', 'error');
                    return;
                }

                document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
                const target = document.getElementById('screen-' + screen);
                if (target) {
                    target.classList.add('active');
                    if (screen === 'history') this._onHistoryTabOpen();
                }
            });
        });

        // Dock: Record button logic
        const toolbarRecord = document.getElementById('toolbar-record');
        if (toolbarRecord) {
            toolbarRecord.addEventListener('click', () => {
                const startBtn = document.getElementById('btn-start');
                if (!startBtn) return;
                if (startBtn.disabled) {
                    this._openSettingsPanel('panel-engine');
                    this._showToast('Local mode chưa setup. Mở tab Engine để thiết lập Faster-Whisper.', 'info');
                    return;
                }
                startBtn.click();
            });
        }

        const micTrigger = document.getElementById('mic-trigger');
        if (micTrigger) {
            micTrigger.addEventListener('click', () => {
                const startBtn = document.getElementById('btn-start');
                if (!startBtn) return;
                if (startBtn.disabled) {
                    this._openSettingsPanel('panel-engine');
                    this._showToast('Local mode chưa setup. Mở tab Engine để thiết lập Faster-Whisper.', 'info');
                    return;
                }
                startBtn.click();
            });
        }

        // History search implementation
        const historySearch = document.getElementById('history-search-input');
        if (historySearch) {
            historySearch.addEventListener('input', (e) => {
                this._filterHistory(e.target.value);
            });
        }
    }

    _closeHeroCustomSelects(except = null) {
        document.querySelectorAll('.hero-custom-select.open').forEach((root) => {
            if (except && root === except) return;
            root.classList.remove('open');
            const trigger = root.querySelector('.hero-select-trigger');
            if (trigger) trigger.setAttribute('aria-expanded', 'false');
        });
    }

    _syncHeroCustomSelectById(selectId) {
        const root = document.querySelector(`.hero-custom-select[data-select-id="${selectId}"]`);
        if (!root || typeof root.__syncFromNative !== 'function') return;
        root.__syncFromNative();
    }

    _initHeroCustomSelect(selectId) {
        const nativeSelect = document.getElementById(selectId);
        const root = document.querySelector(`.hero-custom-select[data-select-id="${selectId}"]`);
        if (!nativeSelect || !root) return;

        const trigger = root.querySelector('.hero-select-trigger');
        const codeEl = root.querySelector('.hero-select-trigger .hero-select-code');
        const textEl = root.querySelector('.hero-select-trigger .hero-select-text');
        const menu = root.querySelector('.hero-select-menu');
        const options = Array.from(root.querySelectorAll('.hero-select-option'));
        if (!trigger || !codeEl || !textEl || !menu || options.length === 0) return;

        const closeMenu = () => {
            root.classList.remove('open');
            trigger.setAttribute('aria-expanded', 'false');
        };

        const syncFromNative = () => {
            const selectedValue = nativeSelect.value;
            const selected = options.find((opt) => opt.dataset.value === selectedValue) || options[0];

            options.forEach((opt) => {
                opt.classList.toggle('active', opt === selected);
                opt.setAttribute('aria-selected', opt === selected ? 'true' : 'false');
            });

            codeEl.textContent = selected.dataset.code || '';
            textEl.textContent = selected.dataset.label || selected.textContent.trim();
        };

        root.__syncFromNative = syncFromNative;

        trigger.addEventListener('click', (event) => {
            event.preventDefault();
            const willOpen = !root.classList.contains('open');
            this._closeHeroCustomSelects(root);
            if (willOpen) {
                root.classList.add('open');
                trigger.setAttribute('aria-expanded', 'true');
            } else {
                closeMenu();
            }
        });

        trigger.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                trigger.click();
                return;
            }
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                if (!root.classList.contains('open')) {
                    trigger.click();
                }
                const active = root.querySelector('.hero-select-option.active') || options[0];
                active?.focus();
                return;
            }
            if (event.key === 'Escape') {
                closeMenu();
            }
        });

        menu.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeMenu();
                trigger.focus();
                return;
            }

            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const focused = document.activeElement;
                const currentIndex = options.indexOf(focused);
                const nextIndex = event.key === 'ArrowDown'
                    ? Math.min(options.length - 1, currentIndex + 1)
                    : Math.max(0, currentIndex - 1);
                options[nextIndex]?.focus();
            }
        });

        options.forEach((opt) => {
            opt.addEventListener('click', () => {
                const nextValue = opt.dataset.value;
                if (!nextValue) return;
                if (nativeSelect.value !== nextValue) {
                    nativeSelect.value = nextValue;
                    nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    syncFromNative();
                }
                closeMenu();
                trigger.focus();
            });
        });

        document.addEventListener('click', (event) => {
            if (!root.contains(event.target)) {
                closeMenu();
            }
        });

        nativeSelect.addEventListener('change', syncFromNative);
        syncFromNative();
    }

    _onHistoryTabOpen() {
        console.log('[App] History tab opened, refreshing list...');
        if (typeof this._loadHistoryList === 'function') {
            this._loadHistoryList();
        }
    }

    _filterHistory(query) {
        const items = document.querySelectorAll('.history-card:not(.empty-state):not(.featured)');
        const q = query.toLowerCase();
        items.forEach(card => {
            const text = card.textContent.toLowerCase();
            card.style.display = text.includes(q) ? '' : 'none';
        });
    }

    _initToolbarEvents() {
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
        };

        popupPairs.forEach((pair) => {
            pair.button.addEventListener('click', (event) => {
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

        const toolbarSourceLang = document.getElementById('toolbar-source-lang');
        if (toolbarSourceLang) {
            toolbarSourceLang.addEventListener('change', () => {
                const sourceLanguage = toolbarSourceLang.value;
                const panelSource = document.getElementById('select-source-lang');
                if (panelSource) panelSource.value = sourceLanguage;
                this._persistSettingsPatch({ source_language: sourceLanguage }).catch((err) => {
                    console.error('[Settings] Failed to save source language:', err);
                });
            });
        }

        const toolbarTargetLang = document.getElementById('toolbar-target-lang');
        if (toolbarTargetLang) {
            toolbarTargetLang.addEventListener('change', () => {
                const targetLanguage = toolbarTargetLang.value;
                const panelTarget = document.getElementById('select-target-lang');
                if (panelTarget) panelTarget.value = targetLanguage;
                this._persistSettingsPatch({ target_language: targetLanguage }).catch((err) => {
                    console.error('[Settings] Failed to save target language:', err);
                });
            });
        }

        const toolbarTtsEnabled = document.getElementById('toolbar-tts-enabled');
        if (toolbarTtsEnabled) {
            toolbarTtsEnabled.addEventListener('change', () => {
                const shouldEnable = toolbarTtsEnabled.checked;
                if (shouldEnable !== this.ttsEnabled) {
                    this._toggleTTS();
                } else {
                    this._syncToolbarVoiceControls(settingsManager.get());
                }
            });
        }

        const toolbarVolume = document.getElementById('toolbar-tts-volume');
        const toolbarVolumeValue = document.getElementById('toolbar-tts-volume-value');
        if (toolbarVolume && toolbarVolumeValue) {
            toolbarVolume.addEventListener('input', () => {
                const volumePercent = parseInt(toolbarVolume.value || '90', 10);
                toolbarVolumeValue.textContent = `${volumePercent}%`;
                this.toolbarTtsVolume = Math.min(1, Math.max(0, volumePercent / 100));
                audioPlayer.setVolume(this.toolbarTtsVolume);
                window.localStorage?.setItem('toolbar_tts_volume', String(this.toolbarTtsVolume));
            });
        }

        const toolbarEdgeSpeed = document.getElementById('toolbar-edge-speed');
        const toolbarEdgeSpeedValue = document.getElementById('toolbar-edge-speed-value');
        if (toolbarEdgeSpeed && toolbarEdgeSpeedValue) {
            toolbarEdgeSpeed.addEventListener('input', () => {
                const speed = parseInt(toolbarEdgeSpeed.value || '20', 10);
                toolbarEdgeSpeedValue.textContent = `${speed >= 0 ? '+' : ''}${speed}%`;
            });

            toolbarEdgeSpeed.addEventListener('change', () => {
                const speed = parseInt(toolbarEdgeSpeed.value || '20', 10);
                const panelEdgeSpeed = document.getElementById('range-edge-speed');
                const panelEdgeSpeedValue = document.getElementById('edge-speed-value');
                if (panelEdgeSpeed) panelEdgeSpeed.value = String(speed);
                if (panelEdgeSpeedValue) panelEdgeSpeedValue.textContent = `${speed >= 0 ? '+' : ''}${speed}%`;
                this._persistSettingsPatch({ edge_tts_speed: speed }).then(() => {
                    if (this.ttsEnabled) {
                        this._configureTTS(this._getActiveTTS(), settingsManager.get());
                    }
                }).catch((err) => {
                    console.error('[Settings] Failed to save edge speed:', err);
                });
            });
        }

        const toolbarEdgeVoice = document.getElementById('toolbar-edge-voice');
        if (toolbarEdgeVoice) {
            toolbarEdgeVoice.addEventListener('change', () => {
                const voice = toolbarEdgeVoice.value;
                const panelEdgeVoice = document.getElementById('select-edge-voice');
                if (panelEdgeVoice) panelEdgeVoice.value = voice;
                this._persistSettingsPatch({ edge_tts_voice: voice }).then(() => {
                    if (this.ttsEnabled) {
                        this._configureTTS(this._getActiveTTS(), settingsManager.get());
                    }
                }).catch((err) => {
                    console.error('[Settings] Failed to save edge voice:', err);
                });
            });
        }

        this._syncToolbarLanguageControls(settingsManager.get());
        this._syncToolbarVoiceControls(settingsManager.get());
    }

    _syncToolbarLanguageControls(settings) {
        const toolbarSourceLang = document.getElementById('toolbar-source-lang');
        if (toolbarSourceLang) {
            toolbarSourceLang.value = settings.source_language || 'auto';
        }

        const toolbarTargetLang = document.getElementById('toolbar-target-lang');
        if (toolbarTargetLang) {
            toolbarTargetLang.value = settings.target_language || 'vi';
        }
    }

    _syncToolbarVoiceControls(settings = settingsManager.get()) {
        const volumeSlider = document.getElementById('toolbar-tts-volume');
        const volumeValue = document.getElementById('toolbar-tts-volume-value');
        const volumePercent = Math.round(this.toolbarTtsVolume * 100);
        if (volumeSlider) volumeSlider.value = String(volumePercent);
        if (volumeValue) volumeValue.textContent = `${volumePercent}%`;

        const enabledToggle = document.getElementById('toolbar-tts-enabled');
        if (enabledToggle) enabledToggle.checked = this.ttsEnabled;

        const edgeSpeed = settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20;
        const speedSlider = document.getElementById('toolbar-edge-speed');
        const speedValue = document.getElementById('toolbar-edge-speed-value');
        if (speedSlider) speedSlider.value = String(edgeSpeed);
        if (speedValue) speedValue.textContent = `${edgeSpeed >= 0 ? '+' : ''}${edgeSpeed}%`;

        const edgeVoice = settings.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        const voiceSelect = document.getElementById('toolbar-edge-voice');
        if (voiceSelect) voiceSelect.value = edgeVoice;

        const stsToggle = document.getElementById('sts-tts-enabled');
        if (stsToggle) stsToggle.checked = this.ttsEnabled;
        const stsVoice = document.getElementById('sts-edge-voice');
        if (stsVoice) stsVoice.value = edgeVoice;
        const stsSpeed = document.getElementById('sts-edge-speed');
        const stsSpeedValue = document.getElementById('sts-edge-speed-value');
        if (stsSpeed) stsSpeed.value = String(edgeSpeed);
        if (stsSpeedValue) stsSpeedValue.textContent = `${edgeSpeed >= 0 ? '+' : ''}${edgeSpeed}%`;
        const stsVolume = document.getElementById('sts-tts-volume');
        const stsVolumeValue = document.getElementById('sts-tts-volume-value');
        if (stsVolume) stsVolume.value = String(volumePercent);
        if (stsVolumeValue) stsVolumeValue.textContent = `${volumePercent}%`;
    }

    _bindStsSettingsEvents() {
        const stsSource = document.getElementById('sts-audio-source');
        if (stsSource) {
            stsSource.addEventListener('change', () => {
                this._setSource(stsSource.value);
            });
        }

        const stsProvider = document.getElementById('sts-stt-provider');
        if (stsProvider) {
            stsProvider.addEventListener('change', () => {
                const mode = stsProvider.value === 'deepgram' ? 'deepgram' : 'local';
                const modeSelect = document.getElementById('select-translation-mode');
                if (modeSelect) modeSelect.value = mode;
                const localModel = document.getElementById('select-local-model');
                if (localModel) localModel.value = 'turbo';
                this._updateModeUI(mode);
                this._updateStsVisibility();
                const patch = { translation_mode: mode };
                if (mode === 'local') patch.local_model = 'turbo';
                this._persistSettingsPatch(patch).catch((err) => {
                    console.error('[Settings] Failed to save STT provider:', err);
                });
            });
        }

        const stsDeepgramKey = document.getElementById('sts-deepgram-key');
        if (stsDeepgramKey) {
            stsDeepgramKey.addEventListener('input', () => {
                const legacy = document.getElementById('input-deepgram-key');
                if (legacy) legacy.value = stsDeepgramKey.value;
            });
            stsDeepgramKey.addEventListener('change', () => {
                this._persistSettingsPatch({ deepgram_api_key: stsDeepgramKey.value.trim() }).catch((err) => {
                    console.error('[Settings] Failed to save Deepgram key:', err);
                });
            });
        }

        const stsMethod = document.getElementById('sts-translation-method');
        if (stsMethod) {
            stsMethod.addEventListener('change', () => {
                const method = stsMethod.value;
                const legacy = document.getElementById('select-translation-model');
                if (legacy) legacy.value = method;
                this._updateTranslationProviderUI();
                this._updateStsVisibility();
                this._persistSettingsPatch({ translation_model: method }).catch((err) => {
                    console.error('[Settings] Failed to save translation method:', err);
                });
            });
        }

        const stsSourceLang = document.getElementById('sts-source-lang');
        if (stsSourceLang) {
            stsSourceLang.addEventListener('change', () => {
                const legacy = document.getElementById('select-source-lang');
                if (legacy) legacy.value = stsSourceLang.value;
                this._syncToolbarLanguageControls({ ...settingsManager.get(), source_language: stsSourceLang.value });
                this._persistSettingsPatch({ source_language: stsSourceLang.value }).catch((err) => {
                    console.error('[Settings] Failed to save source language:', err);
                });
            });
        }

        const stsTargetLang = document.getElementById('sts-target-lang');
        if (stsTargetLang) {
            stsTargetLang.addEventListener('change', () => {
                const legacy = document.getElementById('select-target-lang');
                if (legacy) legacy.value = stsTargetLang.value;
                this._syncToolbarLanguageControls({ ...settingsManager.get(), target_language: stsTargetLang.value });
                this._persistSettingsPatch({ target_language: stsTargetLang.value }).catch((err) => {
                    console.error('[Settings] Failed to save target language:', err);
                });
            });
        }

        const syncAzureField = (stsId, legacyId, key, defaultValue = '') => {
            const stsField = document.getElementById(stsId);
            if (!stsField) return;
            stsField.addEventListener('input', () => {
                const legacy = document.getElementById(legacyId);
                if (legacy) legacy.value = stsField.value;
            });
            stsField.addEventListener('change', () => {
                const value = stsField.value.trim();
                this._persistSettingsPatch({ [key]: value || defaultValue }).catch((err) => {
                    console.error(`[Settings] Failed to save ${key}:`, err);
                });
            });
        };

        syncAzureField('sts-azure-key1', 'input-azure-key1', 'azure_translator_key1', '');
        syncAzureField('sts-azure-key2', 'input-azure-key2', 'azure_translator_key2', '');
        syncAzureField('sts-azure-region', 'input-azure-region', 'azure_translator_region', 'eastasia');
        syncAzureField('sts-azure-endpoint', 'input-azure-endpoint', 'azure_translator_endpoint', 'https://api.cognitive.microsofttranslator.com');

        const stsTtsToggle = document.getElementById('sts-tts-enabled');
        if (stsTtsToggle) {
            stsTtsToggle.addEventListener('change', () => {
                if (stsTtsToggle.checked !== this.ttsEnabled) {
                    this._toggleTTS();
                }
            });
        }

        const stsTtsProvider = document.getElementById('sts-tts-provider');
        if (stsTtsProvider) {
            stsTtsProvider.addEventListener('change', () => {
                const provider = 'edge';
                const legacy = document.getElementById('select-tts-provider');
                if (legacy) legacy.value = provider;
                this._updateTTSProviderUI(provider);
                this._persistSettingsPatch({ tts_provider: provider }).catch((err) => {
                    console.error('[Settings] Failed to save TTS provider:', err);
                });
            });
        }

        const stsVoice = document.getElementById('sts-edge-voice');
        if (stsVoice) {
            stsVoice.addEventListener('change', () => {
                const voice = stsVoice.value;
                const legacy = document.getElementById('select-edge-voice');
                if (legacy) legacy.value = voice;
                const toolbar = document.getElementById('toolbar-edge-voice');
                if (toolbar) toolbar.value = voice;
                this._persistSettingsPatch({ edge_tts_voice: voice }).then(() => {
                    if (this.ttsEnabled) this._configureTTS(this._getActiveTTS(), settingsManager.get());
                }).catch((err) => {
                    console.error('[Settings] Failed to save Edge voice:', err);
                });
            });
        }

        const stsSpeed = document.getElementById('sts-edge-speed');
        const stsSpeedValue = document.getElementById('sts-edge-speed-value');
        if (stsSpeed && stsSpeedValue) {
            stsSpeed.addEventListener('input', () => {
                const speed = parseInt(stsSpeed.value || '20', 10);
                stsSpeedValue.textContent = `${speed >= 0 ? '+' : ''}${speed}%`;
                const legacy = document.getElementById('range-edge-speed');
                const legacyLabel = document.getElementById('edge-speed-value');
                const toolbar = document.getElementById('toolbar-edge-speed');
                const toolbarLabel = document.getElementById('toolbar-edge-speed-value');
                if (legacy) legacy.value = String(speed);
                if (legacyLabel) legacyLabel.textContent = `${speed >= 0 ? '+' : ''}${speed}%`;
                if (toolbar) toolbar.value = String(speed);
                if (toolbarLabel) toolbarLabel.textContent = `${speed >= 0 ? '+' : ''}${speed}%`;
            });
            stsSpeed.addEventListener('change', () => {
                const speed = parseInt(stsSpeed.value || '20', 10);
                this._persistSettingsPatch({ edge_tts_speed: speed }).then(() => {
                    if (this.ttsEnabled) this._configureTTS(this._getActiveTTS(), settingsManager.get());
                }).catch((err) => {
                    console.error('[Settings] Failed to save Edge speed:', err);
                });
            });
        }

        const stsVolume = document.getElementById('sts-tts-volume');
        const stsVolumeValue = document.getElementById('sts-tts-volume-value');
        if (stsVolume && stsVolumeValue) {
            stsVolume.addEventListener('input', () => {
                const volumePercent = parseInt(stsVolume.value || '90', 10);
                stsVolumeValue.textContent = `${volumePercent}%`;
                this.toolbarTtsVolume = Math.min(1, Math.max(0, volumePercent / 100));
                audioPlayer.setVolume(this.toolbarTtsVolume);
                window.localStorage?.setItem('toolbar_tts_volume', String(this.toolbarTtsVolume));
                this._syncToolbarVoiceControls(settingsManager.get());
            });
        }
    }

    _updateStsVisibility() {
        const sttProvider = document.getElementById('sts-stt-provider')?.value || 'local';
        const deepgramSection = document.getElementById('sts-deepgram-key-section');
        const localNote = document.getElementById('sts-local-note');
        if (deepgramSection) deepgramSection.style.display = sttProvider === 'deepgram' ? '' : 'none';
        if (localNote) localNote.style.display = sttProvider === 'local' ? '' : 'none';

        const method = document.getElementById('sts-translation-method')?.value || 'marian';
        const azureSection = document.getElementById('sts-azure-section');
        if (azureSection) azureSection.style.display = method === 'azure' ? 'grid' : 'none';
    }

    _syncStsSettingsControls(settings = settingsManager.get()) {
        const sttProvider = settings.translation_mode === 'deepgram' ? 'deepgram' : 'local';
        const stsProvider = document.getElementById('sts-stt-provider');
        if (stsProvider) stsProvider.value = sttProvider;
        const legacyMode = document.getElementById('select-translation-mode');
        if (legacyMode) legacyMode.value = sttProvider;

        const stsSource = document.getElementById('sts-audio-source');
        if (stsSource) stsSource.value = this.currentSource || settings.audio_source || 'system';

        const stsDeepgramKey = document.getElementById('sts-deepgram-key');
        if (stsDeepgramKey) stsDeepgramKey.value = settings.deepgram_api_key || '';
        const deepgramFastMode = document.getElementById('check-deepgram-fast-mode');
        if (deepgramFastMode) deepgramFastMode.checked = settings.deepgram_fast_mode === true;

        const method = ['azure', 'marian', 'nllb_600m'].includes(settings.translation_model)
            ? settings.translation_model
            : 'marian';
        const stsMethod = document.getElementById('sts-translation-method');
        if (stsMethod) stsMethod.value = method;
        const legacyMethod = document.getElementById('select-translation-model');
        if (legacyMethod) legacyMethod.value = method;

        const stsSourceLang = document.getElementById('sts-source-lang');
        if (stsSourceLang) stsSourceLang.value = settings.source_language || 'auto';
        const stsTargetLang = document.getElementById('sts-target-lang');
        if (stsTargetLang) stsTargetLang.value = settings.target_language || 'vi';

        const stsAzureKey1 = document.getElementById('sts-azure-key1');
        if (stsAzureKey1) stsAzureKey1.value = settings.azure_translator_key1 || '';
        const stsAzureKey2 = document.getElementById('sts-azure-key2');
        if (stsAzureKey2) stsAzureKey2.value = settings.azure_translator_key2 || '';
        const stsAzureRegion = document.getElementById('sts-azure-region');
        if (stsAzureRegion) stsAzureRegion.value = settings.azure_translator_region || 'eastasia';
        const stsAzureEndpoint = document.getElementById('sts-azure-endpoint');
        if (stsAzureEndpoint) stsAzureEndpoint.value = settings.azure_translator_endpoint || 'https://api.cognitive.microsofttranslator.com';

        const stsTtsProvider = document.getElementById('sts-tts-provider');
        if (stsTtsProvider) stsTtsProvider.value = 'edge';
        const legacyTtsProvider = document.getElementById('select-tts-provider');
        if (legacyTtsProvider) legacyTtsProvider.value = 'edge';

        const stsVoice = document.getElementById('sts-edge-voice');
        if (stsVoice) stsVoice.value = settings.edge_tts_voice || 'vi-VN-HoaiMyNeural';

        const edgeSpeed = settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20;
        const stsSpeed = document.getElementById('sts-edge-speed');
        const stsSpeedValue = document.getElementById('sts-edge-speed-value');
        if (stsSpeed) stsSpeed.value = String(edgeSpeed);
        if (stsSpeedValue) stsSpeedValue.textContent = `${edgeSpeed >= 0 ? '+' : ''}${edgeSpeed}%`;

        const stsVolume = document.getElementById('sts-tts-volume');
        const stsVolumeValue = document.getElementById('sts-tts-volume-value');
        const volumePercent = Math.round(this.toolbarTtsVolume * 100);
        if (stsVolume) stsVolume.value = String(volumePercent);
        if (stsVolumeValue) stsVolumeValue.textContent = `${volumePercent}%`;

        const stsEnabled = document.getElementById('sts-tts-enabled');
        if (stsEnabled) stsEnabled.checked = this.ttsEnabled;

        this._updateStsVisibility();
    }

    _initAppearanceEvents() {
        // Appearance controls
        document.querySelectorAll('.theme-mode-btn[data-theme]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.themeMode = btn.dataset.theme;
                this._syncThemeButtons(this.themeMode);
                this._applyAppearanceSettings({ ...settingsManager.get(), theme_mode: this.themeMode });
                this._persistSettingsPatch({ theme_mode: this.themeMode }).catch((err) => {
                    console.error('[Settings] Failed to save theme mode:', err);
                });
            });
        });

        document.querySelectorAll('.accent-swatch[data-accent-preset]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.currentAccentPreset = btn.dataset.accentPreset;
                this._syncAccentButtons(this.currentAccentPreset);
                this._applyAppearanceSettings({ ...settingsManager.get(), accent_preset: this.currentAccentPreset });
                this._persistSettingsPatch({ accent_preset: this.currentAccentPreset }).catch((err) => {
                    console.error('[Settings] Failed to save accent preset:', err);
                });
            });
        });

        document.getElementById('select-ui-locale')?.addEventListener('change', (e) => {
            this.currentLocale = e.target.value;
            this._applyAppearanceSettings({ ...settingsManager.get(), ui_locale: this.currentLocale });
            this._persistSettingsPatch({ ui_locale: this.currentLocale }).catch((err) => {
                console.error('[Settings] Failed to save UI locale:', err);
            });
        });
    }

    async _checkPlatformSupport() {
        try {
            const arch = await invoke('get_platform_info');
            this.platformInfo = JSON.parse(arch);
        } catch {
            this.platformInfo = {
                os: navigator.platform.includes('Win') ? 'windows' : 'unknown',
                arch: 'unknown',
            };
        }

        this.isAppleSilicon = (this.platformInfo.os === 'macos' && this.platformInfo.arch === 'aarch64');
        this.supportsLocalMode = this.isAppleSilicon || this.platformInfo.os === 'windows';

        if (!this.supportsLocalMode) {
            const select = document.getElementById('select-translation-mode');
            const localOption = select?.querySelector('option[value="local"]');
            if (localOption) localOption.remove();

            const stsProvider = document.getElementById('sts-stt-provider');
            const stsLocalOption = stsProvider?.querySelector('option[value="local"]');
            if (stsLocalOption) stsLocalOption.remove();

            // Force deepgram mode if local is unavailable
            const settings = settingsManager.get();
            if (settings.translation_mode === 'local') {
                settings.translation_mode = 'deepgram';
                settingsManager.save(settings);
            }
        }
    }

    // ─── Event Binding ──────────────────────────────────────

    _bindEvents() {
        // Close button (overlay)
        document.getElementById('btn-close').addEventListener('click', async () => {
            if (this.transcriptUI.hasSegments()) {
                await this._saveTranscriptFile();
            }
            await this._saveWindowPosition();
            await this.stop();
            try {
                await invoke('stop_text_translator');
            } catch {}
            await this.appWindow.close();
        });

        // Minimize button
        document.getElementById('btn-minimize').addEventListener('click', async () => {
            await this._saveWindowPosition();
            await this.appWindow.minimize();
        });

        // Pin/Unpin button
        document.getElementById('btn-pin').addEventListener('click', () => {
            this._togglePin();
        });

        // View mode toggle (dual panel)
        document.getElementById('btn-view-mode')?.addEventListener('click', () => {
            this._toggleViewMode();
        });

        // Font size quick controls (now in settings, use optional chaining)
        document.getElementById('btn-font-up')?.addEventListener('click', () => this._adjustFontSize(4));
        document.getElementById('btn-font-down')?.addEventListener('click', () => this._adjustFontSize(-4));

        // Color dot controls (now in settings, use optional chaining)
        document.querySelectorAll('.color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
                dot.classList.add('active');
                const color = dot.dataset.color;
                this.transcriptUI.configure({ fontColor: color });
            });
        });

        // Start/Stop button
        document.getElementById('btn-start').addEventListener('click', async () => {
            try {
                await this._withRunToggleLock(async () => {
                    if (this.isRunning) {
                        await this.stop();
                    } else {
                        this.isStarting = true;
                        await this.start();
                    }
                });
            } catch (err) {
                console.error('[App] Start/Stop error:', err);
                this._showToast(`Error: ${err}`, 'error');
                this.isRunning = false;
                this._updateStartButton();
                this._updateStatus('error');
                this.transcriptUI.clear();
                this.transcriptUI.showPlaceholder();
            }
        });

        // Source buttons
        document.getElementById('btn-source-system').addEventListener('click', () => {
            this._setSource('system');
        });

        document.getElementById('btn-source-mic').addEventListener('click', () => {
            this._setSource('microphone');
        });
        document.getElementById('btn-source-both').addEventListener('click', () => {
            this._setSource('both');
        });

        // Clear button — save transcript file then clear
        document.getElementById('btn-clear').addEventListener('click', async () => {
            if (this.transcriptUI.hasSegments()) {
                await this._saveTranscriptFile();
            }
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            this.recordingStartTime = null;
        });

        // Copy transcript button
        document.getElementById('btn-copy').addEventListener('click', async () => {
            const text = this.transcriptUI.getPlainText();
            if (text) {
                await navigator.clipboard.writeText(text);
                this._showToast('Copied to clipboard', 'success');
            } else {
                this._showToast('Nothing to copy', 'info');
            }
        });

        // Open saved transcripts folder
        document.getElementById('btn-open-transcripts').addEventListener('click', async () => {
            try {
                await invoke('open_transcript_dir');
            } catch (err) {
                this._showToast('Failed to open folder: ' + err, 'error');
            }
        });

        // Settings panel controls (bind early to avoid dead button if toolbar init fails)
        const panelSettingsBtn = document.getElementById('btn-settings');
        const closePanel = document.getElementById('btn-close-panel');
        const appLayout = document.getElementById('app-layout');

        if (closePanel && !closePanel.dataset.boundPanelClose) {
            closePanel.dataset.boundPanelClose = '1';
            closePanel.addEventListener('click', () => {
                this._closeSettingsPanel();
            });
        }

        if (panelSettingsBtn && !panelSettingsBtn.dataset.boundPanelToggle) {
            panelSettingsBtn.dataset.boundPanelToggle = '1';
            panelSettingsBtn.addEventListener('click', () => {
                if (appLayout?.classList.contains('panel-open')) {
                    this._closeSettingsPanel();
                } else {
                    this._openSettingsPanel('panel-stt');
                }
            });
        }

        document.querySelectorAll('.panel-tab[data-panel-tab]').forEach((tab) => {
            if (tab.dataset.boundPanelTab) return;
            tab.dataset.boundPanelTab = '1';
            tab.addEventListener('click', () => {
                this._activatePanelTab(tab.dataset.panelTab);
            });
        });

        // Settings form elements
        this._bindSettingsForm();
        this._bindStsSettingsEvents();

        // Toggle API key visibility
        document.getElementById('btn-toggle-deepgram-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-deepgram-key');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Translation mode toggle
        document.getElementById('select-translation-mode').addEventListener('change', (e) => {
            this._updateModeUI(e.target.value);
        });
        document.getElementById('select-local-model')?.addEventListener('change', () => {
            if (document.getElementById('select-translation-mode')?.value === 'local') {
                this._refreshLocalSetupUI();
            }
            const selectedModel = document.getElementById('select-local-model')?.value || 'turbo';
            settingsManager.save({ local_model: selectedModel }).catch((err) => {
                console.error('[Settings] Failed to save local model:', err);
            });
        });
        document.getElementById('select-translation-model')?.addEventListener('change', () => {
            const selectedModel = document.getElementById('select-translation-model')?.value || 'marian';
            this._updateTranslationProviderUI();
            if (document.getElementById('select-translation-mode')?.value === 'local') {
                this._refreshLocalSetupUI();
            }
            settingsManager.save({ translation_model: selectedModel }).catch((err) => {
                console.error('[Settings] Failed to save translation model:', err);
            });
        });
        document.getElementById('btn-setup-local')?.addEventListener('click', async () => {
            await this._handleSetupLocalClick();
        });
        document.getElementById('btn-open-setup-log')?.addEventListener('click', async () => {
            try {
                await invoke('open_local_data_dir');
            } catch (err) {
                this._showToast(`Failed to open setup log folder: ${err}`, 'error');
            }
        });
        document.getElementById('btn-recheck-setup')?.addEventListener('click', async () => {
            await this._refreshLocalSetupUI();
            this._showToast('Đã kiểm tra lại local setup', 'success');
        });
        document.getElementById('btn-open-python-download')?.addEventListener('click', (e) => {
            e.preventDefault();
            void this._openExternalUrl('https://www.python.org/downloads/release/python-3119/');
        });
        document.getElementById('btn-kill-blocking-python')?.addEventListener('click', async () => {
            try {
                const raw = await invoke('kill_blocking_local_processes');
                const info = JSON.parse(raw);
                if (info.killed) {
                    this._showToast(`Killed Python process(es): ${info.pids.join(', ')}`, 'success');
                } else {
                    this._showToast('No blocking Python process found', 'info');
                }
            } catch (err) {
                this._showToast(`Failed to kill blocking Python processes: ${err}`, 'error');
            }
        });

        // Translation type toggle (one-way / two-way)
        document.getElementById('select-translation-type')?.addEventListener('change', (e) => {
            this._updateTranslationTypeUI(e.target.value);
        });

        document.getElementById('link-deepgram')?.addEventListener('click', (e) => {
            e.preventDefault();
            void this._openExternalUrl('https://console.deepgram.com/');
        });

        document.getElementById('btn-test-deepgram')?.addEventListener('click', async () => {
            await this._runDeepgramSelfTest();
        });

        document.getElementById('btn-open-deepgram-log')?.addEventListener('click', async () => {
            try {
                await invoke('open_local_data_dir');
            } catch (err) {
                this._showToast(`Failed to open Deepgram log folder: ${err.message || err}`, 'error');
            }
        });

        // Slider live updates
        document.getElementById('range-opacity').addEventListener('input', (e) => {
            document.getElementById('opacity-value').textContent = `${e.target.value}%`;
            this._applyTransientDisplaySettings();
            this._scheduleSettingsAutosave();
        });

        document.getElementById('range-font-size').addEventListener('input', (e) => {
            document.getElementById('font-size-value').textContent = `${e.target.value}px`;
            const note = document.getElementById('font-size-display');
            if (note) note.textContent = e.target.value;
            this._applyTransientDisplaySettings();
            this._scheduleSettingsAutosave();
        });

        document.getElementById('range-max-lines').addEventListener('input', (e) => {
            document.getElementById('max-lines-value').textContent = e.target.value;
            this._applyTransientDisplaySettings();
            this._scheduleSettingsAutosave();
        });

        document.querySelectorAll('input[name="display-view-mode"]').forEach((input) => {
            input.addEventListener('change', () => {
                this._applyTransientDisplaySettings();
                this._scheduleSettingsAutosave();
            });
        });

        document.getElementById('range-endpoint-delay')?.addEventListener('input', (e) => {
            document.getElementById('endpoint-delay-value').textContent = `${(e.target.value / 1000).toFixed(1)}s`;
            this._scheduleSettingsAutosave();
        });

        document.getElementById('select-source-lang')?.addEventListener('change', (e) => {
            const toolbarSourceLang = document.getElementById('toolbar-source-lang');
            if (toolbarSourceLang) toolbarSourceLang.value = e.target.value;
            const stsSourceLang = document.getElementById('sts-source-lang');
            if (stsSourceLang) stsSourceLang.value = e.target.value;
        });

        document.getElementById('select-target-lang')?.addEventListener('change', (e) => {
            const toolbarTargetLang = document.getElementById('toolbar-target-lang');
            if (toolbarTargetLang) toolbarTargetLang.value = e.target.value;
            const stsTargetLang = document.getElementById('sts-target-lang');
            if (stsTargetLang) stsTargetLang.value = e.target.value;
        });

        // TTS enable/disable toggle in settings — show/hide detail
        document.getElementById('check-tts-enabled')?.addEventListener('change', (e) => {
            const detail = document.getElementById('tts-settings-detail');
            if (detail) detail.style.display = e.target.checked ? '' : 'none';
        });

        // TTS provider toggle — show/hide relevant settings panels
        document.getElementById('select-tts-provider')?.addEventListener('change', (e) => {
            this._updateTTSProviderUI(e.target.value);
        });

        // TTS speed slider — show value
        document.getElementById('range-tts-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('tts-speed-value');
            if (label) label.textContent = e.target.value + 'x';
        });

        // Edge TTS speed slider
        document.getElementById('range-edge-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('edge-speed-value');
            const v = parseInt(e.target.value);
            if (label) label.textContent = (v >= 0 ? '+' : '') + v + '%';
            const toolbarSpeed = document.getElementById('toolbar-edge-speed');
            const toolbarSpeedValue = document.getElementById('toolbar-edge-speed-value');
            if (toolbarSpeed) toolbarSpeed.value = String(v);
            if (toolbarSpeedValue) toolbarSpeedValue.textContent = (v >= 0 ? '+' : '') + v + '%';
            const stsSpeed = document.getElementById('sts-edge-speed');
            const stsSpeedValue = document.getElementById('sts-edge-speed-value');
            if (stsSpeed) stsSpeed.value = String(v);
            if (stsSpeedValue) stsSpeedValue.textContent = (v >= 0 ? '+' : '') + v + '%';
            this._scheduleSettingsAutosave();
        });

        document.getElementById('select-edge-voice')?.addEventListener('change', (e) => {
            const toolbarVoice = document.getElementById('toolbar-edge-voice');
            if (toolbarVoice) toolbarVoice.value = e.target.value;
            const stsVoice = document.getElementById('sts-edge-voice');
            if (stsVoice) stsVoice.value = e.target.value;
            this._scheduleSettingsAutosave();
        });

        this._bindSettingsAutosave();

        // Add translation term row
        document.getElementById('btn-add-term')?.addEventListener('click', () => {
            this._addTermRow('', '');
        });

        // Add general context row
        document.getElementById('btn-add-general')?.addEventListener('click', () => {
            this._addGeneralRow('', '');
        });

        deepgramClient.onOriginal = (text, speaker, language, meta = {}) => {
            void this._handleDeepgramOriginal(text, speaker, language, meta);
        };

        deepgramClient.onProvisional = (text, speaker, language, meta = {}) => {
            void this._handleDeepgramProvisional(text, speaker, language, meta);
        };

        deepgramClient.onStatusChange = (status) => {
            this._updateStatus(status);
        };

        deepgramClient.onError = (error) => {
            invoke('append_deepgram_log', {
                message: `ui_error ${error}`,
            }).catch(() => {});
            this._showToast(error, 'error');
            this.transcriptUI.showStatusMessage(error);
            if (this.isRunning && this.translationMode === 'deepgram') {
                void this.stop();
            }
        };

        deepgramClient.onConfidence = (avgConfidence) => {
            this.transcriptUI.setConfidence(avgConfidence);
        };
    }

    _bindSettingsForm() {
        // These are handled in _populateSettingsForm and _saveSettingsFromForm
    }

    async _withRunToggleLock(task) {
        if (this.runToggleInProgress) {
            return false;
        }
        this.runToggleInProgress = true;
        try {
            await task();
            return true;
        } finally {
            this.runToggleInProgress = false;
            this.isStarting = false;
        }
    }

    // ─── Keyboard Shortcuts ─────────────────────────────────

    _bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ignore when typing in input fields
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            // Cmd/Ctrl + Enter: Start/Stop
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (this.runToggleInProgress) return;
                (async () => {
                    try {
                        await this._withRunToggleLock(async () => {
                            if (this.isRunning) {
                                await this.stop();
                            } else {
                                this.isStarting = true;
                                await this.start();
                            }
                        });
                    } catch (err) {
                        console.error('[App] Keyboard start/stop error:', err);
                        this._showToast(`Error: ${err}`, 'error');
                        this.isRunning = false;
                        this._updateStartButton();
                        this._updateStatus('error');
                    }
                })();
            }

            // Escape: Go back to overlay / close settings
            if (e.key === 'Escape') {
                e.preventDefault();
                const panelOpen = document.getElementById('app-layout')?.classList.contains('panel-open');
                if (panelOpen) {
                    this._showView('overlay');
                }
            }

            // Cmd/Ctrl + ,: Open settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                e.preventDefault();
                this._showView('settings');
            }

            // Cmd/Ctrl + 1: Switch to System Audio
            if ((e.metaKey || e.ctrlKey) && e.key === '1') {
                e.preventDefault();
                this._setSource('system');
            }

            // Cmd/Ctrl + 2: Switch to Microphone
            if ((e.metaKey || e.ctrlKey) && e.key === '2') {
                e.preventDefault();
                this._setSource('microphone');
            }

            // Cmd/Ctrl + 3: Switch to Both
            if ((e.metaKey || e.ctrlKey) && e.key === '3') {
                e.preventDefault();
                this._setSource('both');
            }

            // Cmd/Ctrl + T: Toggle TTS
            if ((e.metaKey || e.ctrlKey) && e.key === 't') {
                e.preventDefault();
                this._toggleTTS();
            }
        });
    }

    // ─── Views ──────────────────────────────────────────────

    _openSettingsPanel(panelTab = 'panel-stt') {
        const appLayout = document.getElementById('app-layout');
        if (appLayout) appLayout.classList.add('panel-open');
        this._activatePanelTab(panelTab);
        this._populateSettingsForm();
    }

    _closeSettingsPanel() {
        const appLayout = document.getElementById('app-layout');
        if (appLayout) appLayout.classList.remove('panel-open');
    }

    _activatePanelTab(panelTab = 'panel-stt') {
        this.activePanelTab = panelTab;
        const panelTabDescriptions = {
            'panel-stt': 'Cấu hình nguồn âm thanh và nhà cung cấp Speech-to-Text.',
            'panel-ttt': 'Chọn phương thức dịch văn bản, ngôn ngữ nguồn và ngôn ngữ đích.',
            'panel-tts': 'Thiết lập bật tắt giọng đọc, voice, tốc độ và âm lượng.',
            'panel-basic': 'Thiết lập nguồn âm thanh, ngôn ngữ và các tham số vận hành cho phiên dịch hiện tại.',
            'panel-engine': 'Quản lý engine realtime, local setup và các khóa API liên quan.',
            'panel-context': 'Bổ sung ngữ cảnh, thuật ngữ và thông tin nền để tăng độ chính xác.',
            'panel-display': 'Điều chỉnh độ nổi bật, kiểu hiển thị và giao diện tổng thể theo thời gian thực.',
        };
        document.querySelectorAll('.panel-tab').forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.panelTab === panelTab);
        });
        document.querySelectorAll('.panel-tab-content').forEach((content) => {
            content.style.display = content.id === panelTab ? 'block' : 'none';
        });
        const panelTitle = document.querySelector('.panel-header h3');
        const panelSubtitle = document.getElementById('panel-subtitle');
        const activeTab = document.querySelector(`.panel-tab[data-panel-tab="${panelTab}"]`);
        if (panelTitle && activeTab) {
            panelTitle.textContent = activeTab.textContent.trim();
        }
        if (panelSubtitle) {
            panelSubtitle.textContent = panelTabDescriptions[panelTab] || panelTabDescriptions['panel-stt'];
        }
    }

    _showView(view) {
        if (view === 'settings') {
            this._openSettingsPanel('panel-stt');
        } else {
            this._closeSettingsPanel();
        }
        const overlayView = document.getElementById('overlay-view');
        if (overlayView) overlayView.classList.remove('active');
    }

    _resolveTheme(mode) {
        if (mode === 'system') {
            return this.systemThemeMedia?.matches ? 'dark' : 'light';
        }
        return mode === 'light' ? 'light' : 'dark';
    }

    _syncThemeButtons(mode) {
        document.querySelectorAll('.theme-mode-btn[data-theme]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.theme === mode);
        });
    }

    _syncAccentButtons(preset) {
        document.querySelectorAll('.accent-swatch[data-accent-preset]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.accentPreset === preset);
        });
    }

    _applyAppearanceSettings(settings) {
        this.themeMode = settings.theme_mode || 'dark';
        this.currentAccentPreset = settings.accent_preset || 'violet-neon';
        this.currentLocale = settings.ui_locale || 'vi';

        document.documentElement.setAttribute('data-theme', this._resolveTheme(this.themeMode));
        document.documentElement.setAttribute('data-theme-mode', this.themeMode);
        document.documentElement.setAttribute('data-accent-preset', this.currentAccentPreset);

        this._syncThemeButtons(this.themeMode);
        this._syncAccentButtons(this.currentAccentPreset);

        const localeSelect = document.getElementById('select-ui-locale');
        if (localeSelect) localeSelect.value = this.currentLocale;

        applyI18n(document.body, this.currentLocale);

        if (this.transcriptUI?.setLocale) {
            this.transcriptUI.setLocale(this.currentLocale);
        }

        const btnLabel = document.getElementById('btn-start-label');
        if (btnLabel) {
            btnLabel.textContent = this.isRunning
                ? t(this.currentLocale, 'hero.button.stop')
                : t(this.currentLocale, 'hero.button.start');
        }
    }

    // ─── Settings Form ─────────────────────────────────────

    _populateSettingsForm() {
        const s = settingsManager.get();

        document.getElementById('input-deepgram-key').value = s.deepgram_api_key || '';
        const azureKey1Input = document.getElementById('input-azure-key1');
        const azureKey2Input = document.getElementById('input-azure-key2');
        const azureRegionInput = document.getElementById('input-azure-region');
        const azureEndpointInput = document.getElementById('input-azure-endpoint');
        if (azureKey1Input) azureKey1Input.value = s.azure_translator_key1 || '';
        if (azureKey2Input) azureKey2Input.value = s.azure_translator_key2 || '';
        if (azureRegionInput) azureRegionInput.value = s.azure_translator_region || 'eastasia';
        if (azureEndpointInput) azureEndpointInput.value = s.azure_translator_endpoint || 'https://api.cognitive.microsofttranslator.com';
        document.getElementById('select-source-lang').value = s.source_language || 'auto';
        document.getElementById('select-target-lang').value = s.target_language || 'vi';
        const normalizedMode = s.translation_mode === 'deepgram' ? 'deepgram' : 'local';
        document.getElementById('select-translation-mode').value = normalizedMode;
        document.getElementById('select-local-model').value = 'turbo';
        document.getElementById('select-translation-model').value = s.translation_model || 'marian';
        this._updateModeUI(normalizedMode);
        this._updateTranslationProviderUI();

        // Translation type (one-way / two-way)
        const translationType = s.translation_type || 'one_way';
        document.getElementById('select-translation-type').value = translationType;
        this._updateTranslationTypeUI(translationType);

        // Two-way language selects
        document.getElementById('select-lang-a').value = s.language_a || 'vi';
        document.getElementById('select-lang-b').value = s.language_b || 'en';

        // Strict language detection
        document.getElementById('check-deepgram-fast-mode').checked = s.deepgram_fast_mode === true;
        document.getElementById('check-strict-lang').checked = s.language_hints_strict || false;

        // Endpoint delay
        const endpointDelay = s.endpoint_delay || 3000;
        const delaySlider = document.getElementById('range-endpoint-delay');
        if (delaySlider) delaySlider.value = endpointDelay;
        const delayValue = document.getElementById('endpoint-delay-value');
        if (delayValue) delayValue.textContent = `${(endpointDelay / 1000).toFixed(1)}s`;

        // Audio source radio
        const radioValue = this.currentSource || s.audio_source || 'system';
        const radio = document.querySelector(`input[name="audio-source"][value="${radioValue}"]`);
        if (radio) radio.checked = true;

        // Display
        const opacityPercent = Math.round((s.overlay_opacity || 0.85) * 100);
        document.getElementById('range-opacity').value = opacityPercent;
        document.getElementById('opacity-value').textContent = `${opacityPercent}%`;

        document.getElementById('range-font-size').value = s.font_size || 16;
        document.getElementById('font-size-value').textContent = `${s.font_size || 16}px`;

        document.getElementById('range-max-lines').value = s.max_lines || 5;
        document.getElementById('max-lines-value').textContent = s.max_lines || 5;

        document.getElementById('check-show-original').checked = s.show_original !== false;
        document.querySelectorAll('input[name="display-view-mode"]').forEach((input) => {
            input.checked = input.value === (s.view_mode || 'dual');
        });

        // Custom context (rich format)
        const ctx = s.custom_context;
        // General context rows
        const generalList = document.getElementById('context-general-list');
        if (generalList) {
            generalList.innerHTML = '';
            const generalPairs = ctx?.general || [];
            generalPairs.forEach(g => this._addGeneralRow(g.key, g.value));
        }
        // Transcription terms
        const termsInput = document.getElementById('input-context-terms');
        if (termsInput) {
            termsInput.value = (ctx?.terms || []).join('\n');
        }
        // Background text
        const textInput = document.getElementById('input-context-text');
        if (textInput) {
            textInput.value = ctx?.text || '';
        }
        // Load translation terms as rows
        const termsList = document.getElementById('translation-terms-list');
        if (termsList) {
            termsList.innerHTML = '';
            const terms = ctx?.translation_terms || [];
            terms.forEach(t => this._addTermRow(t.source, t.target));
        }

        // TTS settings
        const edgeVoiceSelect = document.getElementById('select-edge-voice');
        if (edgeVoiceSelect) edgeVoiceSelect.value = s.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        const edgeSpeedSlider = document.getElementById('range-edge-speed');
        const edgeSpeedLabel = document.getElementById('edge-speed-value');
        const edgeSpeed = s.edge_tts_speed !== undefined ? s.edge_tts_speed : 20;
        if (edgeSpeedSlider) edgeSpeedSlider.value = edgeSpeed;
        if (edgeSpeedLabel) edgeSpeedLabel.textContent = (edgeSpeed >= 0 ? '+' : '') + edgeSpeed + '%';

        this._syncToolbarLanguageControls(s);
        this._syncToolbarVoiceControls(s);

        // TTS provider
        const providerSelect = document.getElementById('select-tts-provider');
        if (providerSelect) {
            providerSelect.value = 'edge';
            this._updateTTSProviderUI('edge');
        }

        this.themeMode = s.theme_mode || 'dark';
        this.currentAccentPreset = s.accent_preset || 'violet-neon';
        this.currentLocale = s.ui_locale || 'vi';
        this._syncThemeButtons(this.themeMode);
        this._syncAccentButtons(this.currentAccentPreset);
        const localeSelect = document.getElementById('select-ui-locale');
        if (localeSelect) localeSelect.value = this.currentLocale;
        this._syncStsSettingsControls(s);
        this._updateSaveIndicator('saved');
    }

    async _saveSettingsFromForm({ silent = false } = {}) {
        const settings = {
            deepgram_api_key: document.getElementById('input-deepgram-key')?.value.trim() || '',
            azure_translator_key1: document.getElementById('input-azure-key1')?.value.trim() || '',
            azure_translator_key2: document.getElementById('input-azure-key2')?.value.trim() || '',
            azure_translator_region: document.getElementById('input-azure-region')?.value.trim() || 'eastasia',
            azure_translator_endpoint: document.getElementById('input-azure-endpoint')?.value.trim() || 'https://api.cognitive.microsofttranslator.com',
            source_language: document.getElementById('select-source-lang').value,
            target_language: document.getElementById('select-target-lang').value,
            translation_mode: (document.getElementById('select-translation-mode')?.value === 'deepgram') ? 'deepgram' : 'local',
            local_model: 'turbo',
            translation_model: document.getElementById('select-translation-model')?.value || 'marian',
            translation_type: document.getElementById('select-translation-type')?.value || 'one_way',
            language_a: document.getElementById('select-lang-a')?.value || 'vi',
            language_b: document.getElementById('select-lang-b')?.value || 'en',
            deepgram_fast_mode: document.getElementById('check-deepgram-fast-mode')?.checked === true,
            language_hints_strict: document.getElementById('check-strict-lang')?.checked || false,
            endpoint_delay: parseInt(document.getElementById('range-endpoint-delay')?.value || 3000),
            audio_source: this.currentSource || document.querySelector('input[name="audio-source"]:checked')?.value || 'system',
            overlay_opacity: parseInt(document.getElementById('range-opacity').value) / 100,
            view_mode: document.querySelector('input[name="display-view-mode"]:checked')?.value || 'dual',
            font_size: parseInt(document.getElementById('range-font-size').value),
            max_lines: parseInt(document.getElementById('range-max-lines').value),
            show_original: document.getElementById('check-show-original').checked,
            theme_mode: this.themeMode || 'dark',
            accent_preset: this.currentAccentPreset || 'violet-neon',
            ui_locale: document.getElementById('select-ui-locale')?.value || this.currentLocale || 'vi',
            custom_context: null,
        };

        if (settings.translation_mode === 'local') {
            settings.translation_type = 'one_way';
        }

        // Parse custom context (rich format)
        // General key-value pairs
        const generalPairs = [];
        document.querySelectorAll('#context-general-list .general-row').forEach(row => {
            const key = row.querySelector('.general-key')?.value.trim();
            const value = row.querySelector('.general-value')?.value.trim();
            if (key && value) generalPairs.push({ key, value });
        });

        // Transcription terms
        const termsRaw = document.getElementById('input-context-terms')?.value.trim() || '';
        const terms = termsRaw ? termsRaw.split('\n').map(t => t.trim()).filter(t => t) : [];

        // Background text
        const contextText = document.getElementById('input-context-text')?.value.trim() || '';

        // Translation terms
        const translationTerms = [];
        document.querySelectorAll('#translation-terms-list .term-row').forEach(row => {
            const source = row.querySelector('.term-source')?.value.trim();
            const target = row.querySelector('.term-target')?.value.trim();
            if (source && target) translationTerms.push({ source, target });
        });

        if (generalPairs.length > 0 || terms.length > 0 || contextText || translationTerms.length > 0) {
            settings.custom_context = {
                general: generalPairs,
                terms: terms,
                text: contextText || null,
                translation_terms: translationTerms,
            };
        }

        // TTS settings
        settings.tts_provider = 'edge';
        settings.edge_tts_voice = document.getElementById('select-edge-voice')?.value || 'vi-VN-HoaiMyNeural';
        settings.edge_tts_speed = parseInt(document.getElementById('range-edge-speed')?.value || 20);
        settings.tts_enabled = this.ttsEnabled;

        try {
            await settingsManager.save(settings);
            this._updateSaveIndicator('saved');
            if (!silent) {
                this._showToast('Đã lưu cài đặt', 'success');
            }
            return true;
        } catch (err) {
            this._updateSaveIndicator('error');
            if (!silent) {
                this._showToast(`Failed to save: ${err}`, 'error');
            }
            throw err;
        }
    }

    // ─── Apply Settings ────────────────────────────────────

    _applySettings(settings) {
        this._applyAppearanceSettings(settings);

        // Update transcript UI
        if (this.transcriptUI) {
            this.transcriptUI.configure({
                maxLines: settings.max_lines || 5,
                showOriginal: settings.show_original !== false,
                fontSize: settings.font_size || 16,
                viewMode: settings.view_mode || 'dual',
            });
        }
        const viewModeBtn = document.getElementById('btn-view-mode');
        if (viewModeBtn) {
            viewModeBtn.classList.toggle('active', (settings.view_mode || 'dual') === 'dual');
        }

        // Do not let unrelated settings saves override the active overlay source mid-session
        if (!this.isRunning && !this.isStarting) {
            this.currentSource = settings.audio_source || this.currentSource || 'system';
        }
        const sourceRadio = document.querySelector(`input[name="audio-source"][value="${this.currentSource}"]`);
        if (sourceRadio) {
            sourceRadio.checked = true;
        }
        this._updateSourceButtons();

        const sourceLangSelect = document.getElementById('select-source-lang');
        if (sourceLangSelect) sourceLangSelect.value = settings.source_language || 'auto';
        const targetLangSelect = document.getElementById('select-target-lang');
        if (targetLangSelect) targetLangSelect.value = settings.target_language || 'vi';
        this._syncToolbarLanguageControls(settings);
        this._syncToolbarVoiceControls(settings);
        this._syncStsSettingsControls(settings);

        const nextTtsEnabled = Boolean(settings.tts_enabled);
        if (this.ttsEnabled !== nextTtsEnabled) {
            this.ttsEnabled = nextTtsEnabled;
            if (!this.ttsEnabled) {
                edgeTTSRust.disconnect();
                audioPlayer.stop();
                audioPlayer.setVolume(this.toolbarTtsVolume);
            } else if (this.isRunning) {
                const tts = this._getActiveTTS();
                this._configureTTS(tts, settings);
                tts.connect();
                void audioPlayer.resume();
            }
        }
        this._updateTTSButton();
        this._updateStartButton();
    }

    _applyTransientDisplaySettings() {
        if (!this.transcriptUI) return;
        const opacityPercent = parseInt(document.getElementById('range-opacity')?.value || '85', 10);
        const fontSize = parseInt(document.getElementById('range-font-size')?.value || '16', 10);
        const maxLines = parseInt(document.getElementById('range-max-lines')?.value || '5', 10);
        const showOriginal = document.getElementById('check-show-original')?.checked ?? true;
        const viewMode = document.querySelector('input[name="display-view-mode"]:checked')?.value || 'dual';
        const stage = document.getElementById('transcript-container');
        if (stage) {
            stage.style.opacity = String(opacityPercent / 100);
        }
        this.transcriptUI.configure({
            maxLines,
            showOriginal,
            fontSize,
            viewMode,
        });
    }

    _bindSettingsAutosave() {
        const panel = document.getElementById('right-panel');
        if (!panel) return;
        const shouldIgnore = (target) => {
            if (!target) return true;
            if (target.closest('.panel-tab, .panel-close, .icon-btn, .btn-icon-sm, .secondary-btn, .primary-btn')) return true;
            return false;
        };
        panel.addEventListener('change', (event) => {
            const target = event.target;
            if (shouldIgnore(target)) return;
            this._scheduleSettingsAutosave();
        });
        panel.addEventListener('input', (event) => {
            const target = event.target;
            if (shouldIgnore(target)) return;
            if (target.matches('textarea, input[type="text"], input[type="password"], input[type="range"]')) {
                this._scheduleSettingsAutosave();
            }
        });
    }

    _scheduleSettingsAutosave(delayMs = 220) {
        this._updateSaveIndicator('saving');
        if (this.settingsAutosaveTimer) {
            clearTimeout(this.settingsAutosaveTimer);
        }
        this.settingsAutosaveTimer = setTimeout(() => {
            this.settingsAutosaveTimer = null;
            this.settingsAutosavePromise = this.settingsAutosavePromise
                .catch(() => {})
                .then(() => this._saveSettingsFromForm({ silent: true }));
        }, delayMs);
    }

    async _persistSettingsPatch(partial) {
        this._updateSaveIndicator('saving');
        try {
            await settingsManager.save(partial);
            this._updateSaveIndicator('saved');
        } catch (err) {
            this._updateSaveIndicator('error');
            throw err;
        }
    }

    _updateSaveIndicator(state = 'saved') {
        const el = document.getElementById('settings-save-indicator');
        if (!el) return;
        el.dataset.state = state;
        if (state === 'saving') {
            el.textContent = 'Đang lưu...';
            return;
        }
        if (state === 'error') {
            el.textContent = 'Lưu thất bại';
            return;
        }
        el.textContent = 'Tự động lưu';
    }

    // ─── TTS Control ──────────────────────────────────────

    _toggleTTS() {
        const settings = { ...settingsManager.get(), tts_provider: 'edge' };

        // Block TTS in two-way mode to prevent audio feedback loop
        const translationType = document.getElementById('select-translation-type')?.value;
        if (translationType === 'two_way') {
            this._showToast('TTS is disabled in two-way mode to prevent audio loop', 'error');
            return;
        }

        this.ttsEnabled = !this.ttsEnabled;
        this._updateTTSButton();

        const tts = this._getActiveTTS();

        if (this.ttsEnabled) {
            this._configureTTS(tts, settings);
            if (this.isRunning) {
                tts.connect();
                void audioPlayer.resume();
            }
            this._showToast('TTS narration ON 🔊 (Azure / Edge TTS)', 'success');
        } else {
            tts.disconnect();
            audioPlayer.stop();
            audioPlayer.setVolume(this.toolbarTtsVolume);
            this._showToast('TTS narration OFF 🔇', 'success');
        }

        this._persistSettingsPatch({ tts_enabled: this.ttsEnabled }).catch((err) => {
            console.error('[Settings] Failed to persist TTS state:', err);
        });

        this._syncToolbarVoiceControls(settingsManager.get());
    }

    _getActiveTTS() {
        return edgeTTSRust;
    }

    _configureTTS(tts, settings) {
        tts.configure({
            voice: settings.edge_tts_voice || 'vi-VN-HoaiMyNeural',
            speed: settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20,
        });
    }

    _addTermRow(source = '', target = '') {
        const list = document.getElementById('translation-terms-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'term-row';
        row.innerHTML = `<input type="text" class="term-source" value="${source}" placeholder="Source" />` +
            `<input type="text" class="term-target" value="${target}" placeholder="Target" />` +
            `<button type="button" class="btn-remove-term" title="Remove">×</button>`;
        row.querySelector('.btn-remove-term').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    _addGeneralRow(key = '', value = '') {
        const list = document.getElementById('context-general-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'general-row';
        row.innerHTML = `<input type="text" class="general-key" value="${this._escAttr(key)}" placeholder="Key (e.g. domain)" />` +
            `<input type="text" class="general-value" value="${this._escAttr(value)}" placeholder="Value (e.g. Medical)" />` +
            `<button type="button" class="btn-remove-general" title="Remove">×</button>`;
        row.querySelector('.btn-remove-general').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    _escAttr(str) {
        return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    _updateTTSProviderUI(provider) {
        const ed = document.getElementById('tts-edge-settings');
        if (ed) ed.style.display = '';
        // Update hint text
        const hint = document.getElementById('tts-provider-hint');
        if (hint) {
            hint.textContent = 'Azure / Edge TTS: giọng tự nhiên và không cần API key riêng.';
        }

        const legacyProvider = document.getElementById('select-tts-provider');
        if (legacyProvider && legacyProvider.value !== 'edge') {
            legacyProvider.value = 'edge';
        }
        const stsProvider = document.getElementById('sts-tts-provider');
        if (stsProvider && stsProvider.value !== 'edge') {
            stsProvider.value = 'edge';
        }
    }

    _updateTranslationTypeUI(type) {
        const oneway = document.getElementById('section-oneway-langs');
        const twoway = document.getElementById('section-twoway-langs');
        const hintTwoway = document.getElementById('hint-twoway');
        const strictLang = document.getElementById('section-strict-lang');

        if (type === 'two_way') {
            if (oneway) oneway.style.display = 'none';
            if (twoway) twoway.style.display = 'grid';
            if (hintTwoway) hintTwoway.style.display = 'block';
            // Hide strict lang in two-way mode (both languages are specified)
            if (strictLang) strictLang.style.display = 'none';
            // Force-disable TTS in two-way mode to prevent audio feedback loop
            if (this.ttsEnabled) {
                this.ttsEnabled = false;
                this._getActiveTTS().disconnect();
                audioPlayer.stop();
            }
            this._updateTTSButton();
        } else {
            if (oneway) oneway.style.display = 'grid';
            if (twoway) twoway.style.display = 'none';
            if (hintTwoway) hintTwoway.style.display = 'none';
            if (strictLang) strictLang.style.display = 'flex';
            this._updateTTSButton();
        }
    }

    _updateTTSButton() {
        const btn = document.getElementById('btn-tts');
        const iconOff = document.getElementById('icon-tts-off');
        const iconOn = document.getElementById('icon-tts-on');
        const isTwoWay = document.getElementById('select-translation-type')?.value === 'two_way';

        if (btn) {
            btn.classList.toggle('active', this.ttsEnabled);
            btn.classList.toggle('disabled', isTwoWay);
            btn.title = isTwoWay ? 'TTS disabled in two-way mode' : 'Toggle TTS (Ctrl+T)';
        }
        if (iconOff) iconOff.style.display = this.ttsEnabled ? 'none' : 'block';
        if (iconOn) iconOn.style.display = this.ttsEnabled ? 'block' : 'none';
    }

    _speakIfEnabled(text) {
        if (this.ttsEnabled && text?.trim()) {
            this._getActiveTTS().speak(text);
        }
    }

    // ─── Source Control ────────────────────────────────────

    _setSource(source) {
        const wasRunning = this.isRunning;
        const labels = { system: 'System Audio', microphone: 'Microphone', both: 'System + Mic' };
        const label = labels[source] || source;
        const persistSourceSelection = async () => {
            const nextSettings = settingsManager.get();
            if (nextSettings.audio_source === source) {
                return;
            }
            try {
                await settingsManager.save({ audio_source: source });
            } catch (err) {
                console.warn('[App] Failed to persist audio source:', err);
            }
        };

        const sourceRadio = document.querySelector(`input[name="audio-source"][value="${source}"]`);
        if (sourceRadio) {
            sourceRadio.checked = true;
        }

        // If currently running, restart with new source
        if (wasRunning) {
            void this._withRunToggleLock(async () => {
                await this.stop();
                this.currentSource = source;
                this._updateSourceButtons();
                void persistSourceSelection();
                this._showToast(`Switched to ${label}`, 'success');
                this.isStarting = true;
                await this.start();
            });
        } else {
            this.currentSource = source;
            this._updateSourceButtons();
            void persistSourceSelection();
            this._showToast(`Source: ${label}`, 'success');
        }
    }

    _updateSourceButtons() {
        document.getElementById('btn-source-system').classList.toggle('active',
            this.currentSource === 'system');
        document.getElementById('btn-source-mic').classList.toggle('active',
            this.currentSource === 'microphone');
        document.getElementById('btn-source-both').classList.toggle('active',
            this.currentSource === 'both');
    }

    _updateModeUI(mode) {
        const normalizedMode = mode === 'deepgram' ? 'deepgram' : 'local';
        const isDeepgram = normalizedMode === 'deepgram';
        const isLocal = normalizedMode === 'local';

        const modeSelect = document.getElementById('select-translation-mode');
        if (modeSelect) modeSelect.value = normalizedMode;

        const localModel = document.getElementById('select-local-model');
        if (localModel) localModel.value = 'turbo';

        // Toggle hints
        const hintDeepgram = document.getElementById('hint-mode-deepgram');
        const hintLocal = document.getElementById('hint-mode-local');
        const hintLocalLimit = document.getElementById('hint-mode-local-limit');
        if (hintDeepgram) hintDeepgram.style.display = isDeepgram ? '' : 'none';
        if (hintLocal) hintLocal.style.display = isLocal ? '' : 'none';
        if (hintLocalLimit) hintLocalLimit.style.display = isLocal ? '' : 'none';

        // Toggle key/feature sections
        const sectionDeepgramKey = document.getElementById('section-deepgram-key');
        const sectionLocalSetup = document.getElementById('section-local-setup');
        const sectionLocalModel = document.getElementById('section-local-model');
        const sectionTranslationModel = document.getElementById('section-translation-model');
        const sectionAzureTranslator = document.getElementById('section-azure-translator');
        const engineBadge = document.getElementById('engine-status-badge');
        if (sectionDeepgramKey) sectionDeepgramKey.style.display = isDeepgram ? '' : 'none';
        if (sectionLocalSetup) sectionLocalSetup.style.display = isLocal ? 'flex' : 'none';
        if (sectionLocalModel) sectionLocalModel.style.display = 'none';
        if (sectionTranslationModel) sectionTranslationModel.style.display = '';
        if (sectionAzureTranslator) sectionAzureTranslator.style.display = 'none';
        if (engineBadge) engineBadge.style.display = isLocal ? 'inline-flex' : 'none';
        this._updateTranslationProviderUI();

        const translationType = document.getElementById('select-translation-type');
        if (translationType) {
            if (isDeepgram) {
                const savedType = settingsManager.get().translation_type || 'one_way';
                translationType.value = savedType;
                translationType.disabled = false;
            } else {
                translationType.value = 'one_way';
                translationType.disabled = true;
            }
            this._updateTranslationTypeUI(translationType.value);
        }

        const stsProvider = document.getElementById('sts-stt-provider');
        if (stsProvider) stsProvider.value = normalizedMode;
        this._updateStsVisibility();

        if (isLocal) {
            this._refreshLocalSetupUI();
        }
    }

    _updateTranslationProviderUI() {
        const mode = document.getElementById('select-translation-mode')?.value || settingsManager.get().translation_mode || 'local';
        const model = document.getElementById('select-translation-model')?.value || settingsManager.get().translation_model || 'marian';
        const sectionAzureTranslator = document.getElementById('section-azure-translator');
        if (sectionAzureTranslator) {
            sectionAzureTranslator.style.display = (model === 'azure' && (mode === 'local' || mode === 'deepgram')) ? '' : 'none';
        }
        const stsMethod = document.getElementById('sts-translation-method');
        if (stsMethod && stsMethod.value !== model) {
            stsMethod.value = ['azure', 'marian', 'nllb_600m'].includes(model) ? model : 'marian';
        }
        this._updateStsVisibility();
    }

    async _refreshLocalSetupUI() {
        const btn = document.getElementById('btn-setup-local');
        const status = document.getElementById('local-setup-status');
        const badge = document.getElementById('engine-status-badge');
        if (!btn || !status || !badge) return;

        let pythonDiag = null;
        try {
            const raw = await invoke('detect_local_python');
            pythonDiag = JSON.parse(raw);
        } catch {}

        if (this.isLocalSetupRunning) {
            this.localSetupReady = false;
            btn.disabled = true;
            status.textContent = 'Installing Faster-Whisper Realtime...';
            status.className = 'local-setup-status';
            badge.textContent = 'Installing';
            badge.className = 'engine-status-badge installing';
            this._updateStartButton();
            return;
        }

        try {
            const checkResult = await invoke('check_local_setup');
            const data = JSON.parse(checkResult);
            const setupRunning = Boolean(data.setup_running);
            btn.disabled = false;
            const setupVersion = Number(data.details?.version || 0);
            if (data.ready && setupVersion >= 4) {
                const selectedModel = this._normalizeLocalModel(
                    document.getElementById('select-local-model')?.value || settingsManager.get().local_model || 'turbo'
                );
                const selectedTranslationModel = document.getElementById('select-translation-model')?.value || settingsManager.get().translation_model || 'marian';
                const downloadedModels = Array.isArray(data.details?.downloaded_whisper_models)
                    ? data.details.downloaded_whisper_models
                    : (data.details?.model ? [data.details.model] : []);
                const downloadedTranslationModels = Array.isArray(data.details?.translation_models)
                    ? data.details.translation_models
                    : [];
                const translationModelMap = {
                    marian: null,
                    nllb_600m: 'facebook/nllb-200-distilled-600M',
                    azure: null,
                };
                const modelLabel = downloadedModels.length > 0
                    ? downloadedModels.join(', ')
                    : (data.details?.default_model || 'turbo');
                const hasSelectedModel = downloadedModels.includes(selectedModel);
                const selectedTranslationBackend = translationModelMap[selectedTranslationModel];
                const hasSelectedTranslationModel = !selectedTranslationBackend || downloadedTranslationModels.includes(selectedTranslationBackend);
                this.localSetupReady = hasSelectedModel;
                if (hasSelectedModel) {
                    status.textContent = hasSelectedTranslationModel
                        ? `Faster-Whisper Realtime is ready (${modelLabel})`
                        : `Faster-Whisper Realtime is ready (${modelLabel}); selected translator will download on first use or via Setup`;
                    status.className = 'local-setup-status ready';
                    btn.textContent = hasSelectedTranslationModel
                        ? 'Reinstall Faster-Whisper Realtime'
                        : `Download ${selectedTranslationModel}`;
                    badge.textContent = hasSelectedTranslationModel ? 'Ready' : 'Translator pending';
                    badge.className = 'engine-status-badge ready';
                } else {
                    status.textContent = `Model ${selectedModel} is not downloaded yet. Installed: ${modelLabel}`;
                    status.className = 'local-setup-status';
                    btn.textContent = `Download ${selectedModel}`;
                    badge.textContent = 'Model missing';
                    badge.className = 'engine-status-badge';
                }
            } else if (setupRunning) {
                this.localSetupReady = false;
                status.textContent = 'Faster-Whisper Realtime setup is still running...';
                status.className = 'local-setup-status';
                btn.textContent = 'Setup is running...';
                badge.textContent = 'Installing';
                badge.className = 'engine-status-badge installing';
            } else {
                this.localSetupReady = false;
                const unsupported = pythonDiag?.versions?.length && !pythonDiag?.supported;
                status.textContent = unsupported
                    ? `Need Python 3.11/3.12 (found: ${pythonDiag.versions.join(', ')})`
                    : (data.ready ? 'Local environment needs an upgrade' : 'Faster-Whisper Realtime is not installed yet');
                status.className = unsupported ? 'local-setup-status error' : 'local-setup-status';
                btn.textContent = data.ready ? 'Upgrade Faster-Whisper Realtime' : 'Setup Faster-Whisper Realtime';
                badge.textContent = unsupported ? 'Python needed' : 'Not installed';
                badge.className = unsupported ? 'engine-status-badge error' : 'engine-status-badge';
            }
        } catch (err) {
            this.localSetupReady = false;
            btn.disabled = false;
            btn.textContent = 'Setup Faster-Whisper Realtime';
            status.textContent = 'Could not check local setup';
            status.className = 'local-setup-status error';
            badge.textContent = 'Error';
            badge.className = 'engine-status-badge error';
        }

        this._updateStartButton();
    }

    async _handleSetupLocalClick() {
        if (this.isLocalSetupRunning) return;

        const killBtn = document.getElementById('btn-kill-blocking-python');
        if (killBtn) killBtn.style.display = 'none';

        try {
            const raw = await invoke('detect_local_env_in_use');
            const info = JSON.parse(raw);
            const processes = Array.isArray(info.processes)
                ? info.processes
                : (info.processes ? [info.processes] : []);
            if (info.in_use && processes.length > 0) {
                const pids = processes
                    .map(p => p.ProcessId || p.processid)
                    .filter(Boolean)
                    .join(', ');
                const msg = pids
                    ? `Another Python process is using local-env (PID: ${pids}). Close it first.`
                    : 'Another Python process is using local-env. Close it first.';
                if (killBtn) killBtn.style.display = '';
                this._showToast(msg, 'error');
                this.transcriptUI.showStatusMessage(msg);
                return;
            }
        } catch (err) {
            console.warn('[Local] detect_local_env_in_use failed:', err);
        }

        this.isLocalSetupRunning = true;
        await this._refreshLocalSetupUI();

        try {
            await this._runLocalSetup();
            this._showToast('Faster-Whisper Realtime setup completed', 'success');
        } catch (err) {
            this._showToast(`Faster-Whisper Realtime setup failed: ${err.message || err}`, 'error');
        } finally {
            this.isLocalSetupRunning = false;
            await this._refreshLocalSetupUI();
        }
    }

    // ─── Start/Stop ────────────────────────────────────────

    async start() {
        let settings = settingsManager.get();
        this.translationMode = settings.translation_mode === 'deepgram' ? 'deepgram' : 'local';
        console.log('[App] start() called, translation_mode:', this.translationMode, 'settings:', JSON.stringify(settings));

        if (settings.audio_source !== this.currentSource) {
            await settingsManager.save({ audio_source: this.currentSource });
            settings = settingsManager.get();
        }

        if (this.translationMode === 'local' && (!this.localSetupReady || this.isLocalSetupRunning)) {
            this._showToast('Run Setup Faster-Whisper Realtime first', 'error');
            this._openSettingsPanel('panel-stt');
            return;
        }

        if (this.translationMode === 'deepgram' && !settings.deepgram_api_key) {
            this._showToast('Deepgram API key is required. Add it in Settings.', 'error');
            this._openSettingsPanel('panel-stt');
            return;
        }

        this.isRunning = true;
        this._updateStartButton();
        if (!this.recordingStartTime) this.recordingStartTime = Date.now();

        // Clear transcript only if nothing is showing
        if (!this.transcriptUI.hasContent()) {
            this.transcriptUI.showListening();
        } else {
            this.transcriptUI.clearProvisional();
        }

        if (this.translationMode === 'local') {
            await this._startLocalMode(settings);
        } else {
            await this._startDeepgramMode(settings);
        }

        // Start TTS if enabled
        if (this.ttsEnabled) {
            const tts = this._getActiveTTS();
            this._configureTTS(tts, settings);
            tts.connect();
            audioPlayer.resume();
        }
    }

    async _startLocalMode(settings) {
        console.log('[App] Starting Faster-Whisper realtime local mode...');
        this._updateStatus('connecting');
        this.localTranslationQueue = Promise.resolve();
        this.localLatestRevisionByGroup.clear();
        this.localLastTranslatedByGroup.clear();
        this.localSentenceStateByUtterance.clear();
        this.localCarryOver = null;
        this._clearLocalCarryOverTimeout();
        this.localActualModel = null;

        // Step 0: Check audio permission FIRST (before loading models)
        try {
            await invoke('start_capture', {
                source: this.currentSource,
                channel: new window.__TAURI__.core.Channel(), // dummy channel for permission check
            });
            await invoke('stop_capture');
        } catch (err) {
            console.error('[App] Audio permission check failed:', err);
            this._showToast(`Audio permission required: ${err}`, 'error');
            this.isRunning = false;
            this._updateStartButton();
            this._updateStatus('error');
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            return;
        }

        try {
            await this._ensureLocalRealtimeSetupReady(settings);
        } catch (err) {
            console.error('[App] Local setup failed:', err);
            this._showToast(`Faster-Whisper Realtime setup failed: ${err.message || err}`, 'error');
            this.transcriptUI.showStatusMessage(`Faster-Whisper Realtime setup failed: ${err.message || err}`);
            await this.stop();
            return;
        }

        try {
            await this._ensureLocalRealtimeTranslationReady(settings, { allowAutoSource: false });
        } catch (err) {
            console.error('[App] Local translation setup failed:', err);
            this._showToast(`Local translation setup failed: ${err.message || err}`, 'error');
            this.transcriptUI.showStatusMessage(`Local translation setup failed: ${err.message || err}`);
            await this.stop();
            return;
        }

        const promptConfig = this._buildWhisperPromptConfig(settings.custom_context);
        const pipelineConfig = this._buildLocalPipelineConfig(settings, promptConfig);
        console.log('[App] Local setup check passed, starting pipeline...');

        if (this._canReuseLocalPipeline(pipelineConfig)) {
            console.log('[App] Reusing warm local pipeline');
            this._updateStatus('connected');
            this.transcriptUI.removeStatusMessage();
            this.transcriptUI.showListening();
        } else {
            try {
                this._showToast('Starting local pipeline...', 'success');

                this.localPipelineChannel = new window.__TAURI__.core.Channel();
                this.localPipelineReady = false;
                this.localPipelineClosed = false;
                this.localRecentCommittedGroups = [];
                this.localActualModel = null;

                this.localPipelineChannel.onmessage = (msg) => {
                    let data;
                    try {
                        data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                    } catch (e) {
                        console.warn('[Local] JSON parse failed:', typeof msg, msg);
                        return;
                    }
                    try {
                        this._handleLocalPipelineResult(data);
                    } catch (e) {
                        console.error('[Local] Handler error for type:', data?.type, e);
                    }
                };

                await invoke('start_local_pipeline', {
                    sourceLang: pipelineConfig.sourceLang,
                    targetLang: pipelineConfig.targetLang,
                    localModel: pipelineConfig.localModel,
                    initialPrompt: pipelineConfig.initialPrompt,
                    hotwords: pipelineConfig.hotwords,
                    channel: this.localPipelineChannel,
                });
                this.localPipelineConfig = pipelineConfig;
                console.log('[App] Local pipeline spawned');
            } catch (err) {
                console.error('Failed to start pipeline:', err);
                this.localPipelineConfig = null;
                this._showToast(`Pipeline error: ${err}`, 'error');
                await this.stop();
                return;
            }
        }

        // Step 2: Start audio capture
        try {
            const audioChannel = new window.__TAURI__.core.Channel();
            let audioChunkCount = 0;

            audioChannel.onmessage = async (pcmData) => {
                if (!this.localPipelineReady || this.localPipelineClosed) {
                    return;
                }
                audioChunkCount++;
                if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                    console.log(`[Local] Audio batch #${audioChunkCount}, size:`, pcmData?.length || 0);
                }
                try {
                    await invoke('send_audio_to_pipeline', { data: Array.from(new Uint8Array(pcmData)) });
                } catch (e) {
                    this.localPipelineClosed = true;
                    this.localPipelineReady = false;
                    console.error('[Local] send_audio_to_pipeline failed:', e);
                }
            };

            await invoke('start_capture', {
                source: this.currentSource,
                channel: audioChannel,
            });
            console.log('[App] Audio capture started');
        } catch (err) {
            console.error('Audio capture failed (pipeline still running):', err);
            this._showToast(`Audio: ${err}. Pipeline still loading...`, 'error');
        }
    }

    _handleLocalPipelineResult(data) {
        switch (data.type) {
            case 'ready':
                this.localPipelineReady = true;
                this.localPipelineClosed = false;
                this.localActualModel = data.model || data.actual_model || null;
                this._updateStatus('connected');
                this.transcriptUI.removeStatusMessage();
                this.transcriptUI.showListening();
                this._showToast(
                    this.localActualModel
                        ? `Faster-Whisper Realtime is ready (${this.localActualModel})`
                        : 'Faster-Whisper Realtime is ready',
                    'success',
                );
                break;
            case 'provisional': {
                const text = (data.text || data.original || '').trim();
                if (!text) {
                    break;
                }
                this._handleLocalTranscriptChunk({
                    utteranceId: data.utterance_id,
                    revision: Number(data.revision || Date.now()),
                    text,
                    language: data.language || null,
                    speaker: data.speaker ?? null,
                    confidence: data.confidence ?? null,
                    isFinal: false,
                });
                break;
            }
            case 'original': {
                const text = (data.text || data.original || '').trim();
                if (!text) {
                    break;
                }
                this._handleLocalTranscriptChunk({
                    utteranceId: data.utterance_id,
                    revision: Number(data.revision || Date.now()),
                    text,
                    language: data.language || null,
                    speaker: data.speaker ?? null,
                    confidence: data.confidence ?? null,
                    isFinal: true,
                });
                break;
            }
            case 'status':
                const msg = data.message || 'Loading...';
                const statusText = document.getElementById('status-text');
                if (statusText) {
                    const compact = msg.replace(/^\[pipeline\]\s*/, '');
                    statusText.textContent = compact;
                }
                if (!msg.startsWith('[pipeline]')) {
                    this.transcriptUI.showStatusMessage(msg);
                }
                break;
            case 'done':
                this.localPipelineReady = false;
                this.localPipelineClosed = true;
                this.localPipelineConfig = null;
                this._updateStatus('disconnected');
                break;
            case 'error':
                this.localPipelineReady = false;
                this.localPipelineClosed = true;
                this.localPipelineConfig = null;
                this._updateStatus('error');
                {
                    const raw = data.message || 'Local realtime pipeline error';
                    let friendly = raw;
                    if (raw.includes('Faster-Whisper Realtime is not installed yet')) {
                        friendly = 'Faster-Whisper Realtime is not installed yet. Open Start again and let setup finish.';
                    } else if (raw.includes('Offline translation package not available')) {
                        friendly = raw;
                    }
                    this._showToast(friendly, 'error');
                    this.transcriptUI.showStatusMessage(friendly);
                }
                break;
        }
    }

    async _ensureLocalRealtimeSetupReady(settings) {
        const checkResult = await invoke('check_local_setup');
        const status = JSON.parse(checkResult);
        const setupVersion = Number(status?.details?.version || 0);
        const selectedModel = this._normalizeLocalModel(settings.local_model || 'turbo');
        const downloadedModels = new Set(
            Array.isArray(status?.details?.downloaded_whisper_models)
                ? status.details.downloaded_whisper_models
                : (status?.details?.model ? [status.details.model] : [])
        );
        if (status.ready && setupVersion >= 4 && downloadedModels.has(selectedModel)) {
            return;
        }

        if (status.setup_running) {
            const message = 'Faster-Whisper Realtime setup is already running. Waiting for it to finish...';
            this._showToast(message, 'success');
            this.transcriptUI.showStatusMessage(message);
            await this._waitForLocalSetupCompletion(selectedModel);
            return;
        }

        const setupMessage = status.ready
            ? `Updating Faster-Whisper environment for model ${selectedModel}...`
            : 'Installing Faster-Whisper Realtime environment...';
        this._showToast(setupMessage, 'success');
        this.transcriptUI.showStatusMessage(setupMessage);
        await this._runLocalSetup();
    }

    _extractCompletedSentences(text, language) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized) {
            return { sentences: [], remainder: '' };
        }

        const boundaryPattern = /[.!?。！？]+/g;
        const sentences = [];
        let lastIndex = 0;
        let match;
        while ((match = boundaryPattern.exec(normalized)) !== null) {
            const endIndex = match.index + match[0].length;
            const sentence = normalized.slice(lastIndex, endIndex).trim();
            if (sentence) {
                sentences.push(sentence);
            }
            lastIndex = endIndex;
        }

        const remainder = normalized.slice(lastIndex).trim();
        return { sentences, remainder };
    }

    _normalizeLocalTranscriptForDedupe(text, language) {
        const value = String(text || '').trim();
        if (!value) {
            return '';
        }
        const compact = value
            .replace(/[\s.!?…。！？,，、:：;；'"“”‘’()[\]{}…·-]+/g, '')
            .trim();
        const looksCjk = ['ko', 'ja', 'zh'].includes(language || '')
            || /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(compact);
        return looksCjk ? compact : compact.toLowerCase();
    }

    _pruneLocalCommittedGroups(now = Date.now()) {
        const dedupeWindowMs = 15000;
        this.localRecentCommittedGroups = this.localRecentCommittedGroups
            .filter(item => (now - item.at) <= dedupeWindowMs)
            .slice(-24);
    }

    _getLocalSegmentByGroupId(groupId) {
        return this.transcriptUI?.segments?.find(seg => seg.groupId === groupId) || null;
    }

    _resolveExistingLocalSentenceGroupId(baseId, nextSentenceGroupId, sentenceText, language) {
        const tailGroupId = `${baseId}-tail`;
        const tailSegment = this._getLocalSegmentByGroupId(tailGroupId);
        if (!tailSegment || tailSegment.translation) {
            return nextSentenceGroupId;
        }

        const sentenceNormalized = this._normalizeLocalTranscriptForDedupe(sentenceText, language);
        const tailNormalized = this._normalizeLocalTranscriptForDedupe(tailSegment.original || '', language);
        if (!sentenceNormalized || !tailNormalized) {
            return nextSentenceGroupId;
        }

        if (
            sentenceNormalized === tailNormalized
            || sentenceNormalized.includes(tailNormalized)
            || tailNormalized.includes(sentenceNormalized)
        ) {
            return tailGroupId;
        }

        return nextSentenceGroupId;
    }

    _reconcileLocalCommittedText(groupId, text, language) {
        const normalized = this._normalizeLocalTranscriptForDedupe(text, language);
        if (!normalized) {
            return { skip: true };
        }

        const now = Date.now();
        this._pruneLocalCommittedGroups(now);

        const recentGroups = [...this.localRecentCommittedGroups].reverse();
        for (const entry of recentGroups) {
            if (entry.groupId === groupId) {
                continue;
            }
            if (entry.language && language && entry.language !== language) {
                continue;
            }
            const existing = entry.normalized;
            if (!existing) {
                continue;
            }
            const existingSegment = this._getLocalSegmentByGroupId(entry.groupId);

            if (existing === normalized) {
                return { skip: true };
            }

            const shorterLength = Math.min(existing.length, normalized.length);
            const longerLength = Math.max(existing.length, normalized.length);
            const overlapRatio = longerLength > 0 ? shorterLength / longerLength : 0;

            if (existing.length > normalized.length) {
                if (normalized.length >= 4 && overlapRatio >= 0.45 && existing.includes(normalized)) {
                    return { skip: true };
                }
                continue;
            }

            if (normalized.length > existing.length) {
                if (existing.length >= 4 && overlapRatio >= 0.45 && normalized.includes(existing)) {
                    if (existingSegment && !existingSegment.translation) {
                        return {
                            skip: false,
                            normalized,
                            replacementGroupId: entry.groupId,
                        };
                    }
                }
            }
        }

        return { skip: false, normalized };
    }

    _rememberLocalCommittedText(groupId, text, language, normalized = null) {
        const value = normalized || this._normalizeLocalTranscriptForDedupe(text, language);
        if (!value) {
            return;
        }
        const now = Date.now();
        this._pruneLocalCommittedGroups(now);
        this.localRecentCommittedGroups = this.localRecentCommittedGroups
            .filter(item => item.groupId !== groupId);
        this.localRecentCommittedGroups.push({
            groupId,
            language: language || null,
            normalized: value,
            at: now,
        });
    }

    _localTextHasTerminalBoundary(text) {
        return /[.!?。！？]\s*$/.test(String(text || '').trim());
    }

    _localTextLooksIncomplete(text, language) {
        const value = String(text || '').trim();
        if (!value) {
            return false;
        }
        if (this._localTextHasTerminalBoundary(value)) {
            return false;
        }
        if (/\.\.\.$|…$/.test(value)) {
            return true;
        }
        const lastToken = value.split(/\s+/).pop() || '';
        if ((language || '') === 'ko') {
            if (/(그리고|그런데|그래서|먼저|마지막으로|다음에|물이나|또는|혹은)$/.test(lastToken)) {
                return true;
            }
            if (/(은|는|이|가|을|를|에|에서|으로|로|와|과|랑|하고|도|만|이나)$/.test(lastToken)) {
                return true;
            }
            if (/(요|니다|예요|이에요|어요|아요|해요|했어요|합니다|했습니다|있어요|없어요|가요|봐요|봤어요|먹어요|좋아해요|싫어해요|재미있었어요|만들었어요|들어가요|넣어요|볶아요)$/.test(lastToken)) {
                return false;
            }
        }
        return false;
    }

    _clearLocalCarryOverTimeout() {
        if (this.localCarryOverTimeout) {
            clearTimeout(this.localCarryOverTimeout);
            this.localCarryOverTimeout = null;
        }
    }

    _scheduleLocalCarryOverFlush() {
        this._clearLocalCarryOverTimeout();
        if (!this.localCarryOver) {
            return;
        }

        this.localCarryOverTimeout = setTimeout(() => {
            const pending = this.localCarryOver;
            this.localCarryOver = null;
            this.localCarryOverTimeout = null;
            if (!pending?.text || !pending?.groupId) {
                return;
            }

            const revision = (this.localLatestRevisionByGroup.get(pending.groupId) || 0) + 1;
            this.localLatestRevisionByGroup.set(pending.groupId, revision);
            this.transcriptUI.upsertOriginalGroup(
                pending.groupId,
                pending.text,
                pending.speaker ?? null,
                pending.language || null,
                {},
            );
            this._queueLocalTranslation({
                groupId: pending.groupId,
                revision,
                text: pending.text,
                sourceLanguage: pending.language || settingsManager.get().source_language || 'auto',
                targetLanguage: settingsManager.get().target_language || 'vi',
            });
            this._rememberLocalCommittedText(
                pending.groupId,
                pending.text,
                pending.language || null,
            );
            this.transcriptUI.clearProvisional();
        }, 1800);
    }

    _ensureLocalSentenceTrackingState(state) {
        if (!state.sentenceCandidates) {
            state.sentenceCandidates = new Map();
        }
        return state;
    }

    _markLocalSentenceCandidate(state, sentenceIndex, sentenceText, language) {
        const normalized = this._normalizeLocalTranscriptForDedupe(sentenceText, language);
        if (!normalized) {
            return { normalized: '', stable: false, count: 0 };
        }

        this._ensureLocalSentenceTrackingState(state);
        const previous = state.sentenceCandidates.get(sentenceIndex);
        const nextCount = previous?.normalized === normalized ? previous.count + 1 : 1;
        state.sentenceCandidates.set(sentenceIndex, {
            normalized,
            count: nextCount,
            text: sentenceText,
            at: Date.now(),
        });
        return {
            normalized,
            stable: nextCount >= 3,
            count: nextCount,
        };
    }

    _shouldSuppressLocalProvisionalPreview(text, revision, language) {
        const value = String(text || '').trim();
        if (!value) {
            return true;
        }

        if (/^[\d\s%.,!?/\\-]+$/.test(value)) {
            return true;
        }

        if (revision <= 2 && value.length <= 4) {
            return true;
        }

        if ((language || '') === 'ko') {
            if (revision <= 3 && value.length <= 6 && !/[.!?。！？]/.test(value)) {
                return true;
            }
        }

        return false;
    }

    _handleLocalTranscriptChunk({ utteranceId, revision, text, language, speaker, confidence, isFinal }) {
        const baseId = `fw-${utteranceId || Date.now()}`;
        const state = this._ensureLocalSentenceTrackingState(
            this.localSentenceStateByUtterance.get(baseId) || { committedCount: 0 }
        );
        const effectiveLanguage = language || settingsManager.get().source_language || 'auto';
        let workingText = String(text || '').trim();
        let carryOverGroupId = null;
        if (this.localCarryOver && this.localCarryOver.language === effectiveLanguage) {
            this._clearLocalCarryOverTimeout();
            carryOverGroupId = this.localCarryOver.groupId || null;
            workingText = [this.localCarryOver.text, workingText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
            this.localCarryOver = null;
        }
        const { sentences, remainder } = this._extractCompletedSentences(workingText, effectiveLanguage);
        let tailPromotedToSentence = false;

        for (let index = state.committedCount; index < sentences.length; index += 1) {
            const sentenceText = sentences[index];
            const candidate = isFinal
                ? {
                    normalized: this._normalizeLocalTranscriptForDedupe(sentenceText, effectiveLanguage),
                    stable: true,
                }
                : this._markLocalSentenceCandidate(state, index, sentenceText, effectiveLanguage);
            if (!candidate.stable) {
                break;
            }
            const nextSentenceGroupId = `${baseId}-s${index + 1}`;
            const preferredSentenceGroupId = index === state.committedCount && carryOverGroupId
                ? carryOverGroupId
                : this._resolveExistingLocalSentenceGroupId(
                    baseId,
                    nextSentenceGroupId,
                    sentenceText,
                    effectiveLanguage,
                );
            const reconciliation = this._reconcileLocalCommittedText(
                preferredSentenceGroupId,
                sentenceText,
                effectiveLanguage,
            );
            if (reconciliation.skip) {
                state.committedCount = Math.max(state.committedCount, index + 1);
                state.sentenceCandidates.delete(index);
                continue;
            }
            const sentenceGroupId = reconciliation.replacementGroupId || preferredSentenceGroupId;
            if (sentenceGroupId === `${baseId}-tail`) {
                tailPromotedToSentence = true;
            }
            const sentenceRevision = revision * 100 + index + 1;
            this.localLatestRevisionByGroup.set(sentenceGroupId, sentenceRevision);
            this.transcriptUI.upsertOriginalGroup(
                sentenceGroupId,
                sentenceText,
                speaker,
                effectiveLanguage,
                { confidence },
            );
            this._queueLocalTranslation({
                groupId: sentenceGroupId,
                revision: sentenceRevision,
                text: sentenceText,
                sourceLanguage: effectiveLanguage,
                targetLanguage: settingsManager.get().target_language || 'vi',
            });
            this._rememberLocalCommittedText(
                sentenceGroupId,
                sentenceText,
                effectiveLanguage,
                reconciliation.normalized || candidate.normalized,
            );
            state.committedCount = Math.max(state.committedCount, index + 1);
            state.sentenceCandidates.delete(index);
        }

        const pendingSentenceText = sentences.slice(state.committedCount).join(' ').trim();
        const tailText = [pendingSentenceText, remainder].filter(Boolean).join(' ').trim();

        const tailGroupId = carryOverGroupId || `${baseId}-tail`;
        if (!isFinal) {
            if (!tailPromotedToSentence && this._getLocalSegmentByGroupId(tailGroupId)) {
                this.transcriptUI.removeGroup(tailGroupId);
            }
            if (tailText && !this._shouldSuppressLocalProvisionalPreview(tailText, revision, effectiveLanguage)) {
                this.transcriptUI.setProvisional(tailText, speaker, effectiveLanguage);
            } else {
                this.transcriptUI.clearProvisional();
            }
        } else if (tailText) {
            const reconciliation = this._reconcileLocalCommittedText(
                tailGroupId,
                tailText,
                effectiveLanguage,
            );
            if (reconciliation.skip) {
                // Do not erase the visible tail on regressing provisional updates.
            } else {
                const actualTailGroupId = reconciliation.replacementGroupId || tailGroupId;
                const tailRevision = revision * 100 + 99;
                this.localLatestRevisionByGroup.set(actualTailGroupId, tailRevision);
                this.transcriptUI.upsertOriginalGroup(
                    actualTailGroupId,
                    tailText,
                    speaker,
                    effectiveLanguage,
                    { confidence },
                );
                const shouldCarryOver = isFinal && this._localTextLooksIncomplete(tailText, effectiveLanguage);
                if (shouldCarryOver) {
                    this.localCarryOver = {
                        text: tailText,
                        groupId: actualTailGroupId,
                        language: effectiveLanguage,
                        speaker: speaker ?? null,
                    };
                    this.transcriptUI.setProvisional(tailText, speaker, effectiveLanguage);
                    this._scheduleLocalCarryOverFlush();
                } else if (isFinal) {
                    this._clearLocalCarryOverTimeout();
                    this._queueLocalTranslation({
                        groupId: actualTailGroupId,
                        revision: tailRevision,
                        text: tailText,
                        sourceLanguage: effectiveLanguage,
                        targetLanguage: settingsManager.get().target_language || 'vi',
                    });
                    this._rememberLocalCommittedText(
                        actualTailGroupId,
                        tailText,
                        effectiveLanguage,
                        reconciliation.normalized,
                    );
                    this.transcriptUI.clearProvisional();
                }
            }
        } else if (!tailPromotedToSentence && (!sentences.length || this._getLocalSegmentByGroupId(tailGroupId))) {
            this.transcriptUI.removeGroup(tailGroupId);
            this.transcriptUI.clearProvisional();
        }

        if (isFinal) {
            this.localSentenceStateByUtterance.delete(baseId);
        } else {
            this.localSentenceStateByUtterance.set(baseId, state);
        }
    }

    async _waitForLocalSetupCompletion(selectedModel) {
        const deadline = Date.now() + 1000 * 60 * 20;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            const checkResult = await invoke('check_local_setup');
            const status = JSON.parse(checkResult);
            const setupVersion = Number(status?.details?.version || 0);
            const downloadedModels = new Set(
                Array.isArray(status?.details?.downloaded_whisper_models)
                    ? status.details.downloaded_whisper_models
                    : (status?.details?.model ? [status.details.model] : [])
            );
            if (status.ready && setupVersion >= 4 && downloadedModels.has(selectedModel || 'turbo')) {
                this.transcriptUI.removeStatusMessage();
                await this._refreshLocalSetupUI();
                return;
            }
            if (!status.setup_running) {
                break;
            }
        }

        this.transcriptUI.removeStatusMessage();
        await this._refreshLocalSetupUI();
        throw new Error('Faster-Whisper Realtime setup did not complete successfully');
    }

    async _ensureLocalRealtimeTranslationReady(settings, options = {}) {
        const sourceLanguage = settings.source_language || 'auto';
        const targetLanguage = settings.target_language || 'vi';
        if (!options.allowAutoSource && sourceLanguage === 'auto') {
            return;
        }
        if (sourceLanguage === targetLanguage) {
            return;
        }

        const translationModel = settings.translation_model || 'marian';
        const prepareKey = `${sourceLanguage}:${targetLanguage}:${translationModel}`;
        if (this.localPreparedTranslationKey === prepareKey) {
            return;
        }

        this.transcriptUI.showStatusMessage(`Preparing translation ${sourceLanguage} -> ${targetLanguage}...`);
        await invoke('start_text_translator');
        await invoke('prepare_text_translation', {
            sourceLang: sourceLanguage,
            targetLang: targetLanguage,
            translationModel,
        });
        this.localPreparedTranslationKey = prepareKey;
        this.transcriptUI.removeStatusMessage();
    }

    _buildWhisperPromptConfig(customContext) {
        if (!customContext) {
            return { initialPrompt: null, hotwords: [] };
        }

        const promptParts = [];
        const hotwords = [];

        if (customContext.domain) {
            promptParts.push(`Domain: ${customContext.domain}`);
        }

        if (Array.isArray(customContext.general) && customContext.general.length > 0) {
            const generalSummary = customContext.general
                .filter(item => item?.key && item?.value)
                .slice(0, 4)
                .map(item => `${item.key}: ${item.value}`)
                .join('; ');
            if (generalSummary) {
                promptParts.push(generalSummary);
            }
        }

        const contextTerms = Array.isArray(customContext.terms)
            ? customContext.terms.map(term => String(term || '').trim()).filter(Boolean)
            : [];
        if (contextTerms.length > 0) {
            promptParts.push(`Important terms: ${contextTerms.slice(0, 20).join(', ')}`);
            hotwords.push(...contextTerms);
        }

        const translationSources = Array.isArray(customContext.translation_terms)
            ? customContext.translation_terms.map(term => term?.source?.trim()).filter(Boolean)
            : [];
        if (translationSources.length > 0) {
            promptParts.push(`Prefer exact spellings for: ${translationSources.slice(0, 20).join(', ')}`);
            hotwords.push(...translationSources);
        }

        if (customContext.text) {
            promptParts.push(String(customContext.text).trim().slice(0, 240));
        }

        const uniqueHotwords = [...new Set(hotwords)].slice(0, 24);
        const initialPrompt = promptParts
            .map(part => part.trim())
            .filter(Boolean)
            .join('. ')
            .slice(0, 420);

        return {
            initialPrompt: initialPrompt || null,
            hotwords: uniqueHotwords,
        };
    }

    _normalizeLocalModel(model) {
        return model === 'large-v3' ? 'large-v3' : 'turbo';
    }

    _buildLocalPipelineConfig(settings, promptConfig) {
        return {
            sourceLang: settings.source_language || 'auto',
            targetLang: settings.target_language || 'vi',
            localModel: this._normalizeLocalModel(settings.local_model || 'turbo'),
            initialPrompt: promptConfig?.initialPrompt || null,
            hotwords: Array.isArray(promptConfig?.hotwords) ? [...promptConfig.hotwords] : [],
        };
    }

    _canReuseLocalPipeline(nextConfig) {
        if (!this.localPipelineReady || this.localPipelineClosed || !this.localPipelineConfig) {
            return false;
        }
        return JSON.stringify(this.localPipelineConfig) === JSON.stringify(nextConfig);
    }

    _queueLocalTranslation({ groupId, revision, text, sourceLanguage, targetLanguage }) {
        const normalizedText = (text || '').trim();
        if (!normalizedText) {
            return;
        }

        const task = async () => {
            const latestRevision = this.localLatestRevisionByGroup.get(groupId) || revision;
            if (revision < latestRevision) {
                return;
            }

            const translationModel = settingsManager.get().translation_model || 'marian';
            const supportsAutoSource = translationModel === 'azure';
            const effectiveSourceLanguage = (sourceLanguage || '').trim() || settingsManager.get().source_language || 'auto';
            if (!effectiveSourceLanguage) {
                return;
            }
            if (effectiveSourceLanguage === 'auto' && !supportsAutoSource) {
                return;
            }
            if (this.localLastTranslatedByGroup.get(groupId) === normalizedText) {
                return;
            }

            if (effectiveSourceLanguage !== 'auto' && effectiveSourceLanguage === targetLanguage) {
                this.localLastTranslatedByGroup.set(groupId, normalizedText);
                this.transcriptUI.addTranslation(normalizedText, { groupId });
                return;
            }

            if (!supportsAutoSource) {
                const prepareKey = `${effectiveSourceLanguage}:${targetLanguage}:${translationModel}`;
                if (this.localPreparedTranslationKey !== prepareKey) {
                    this.transcriptUI.showStatusMessage(`Preparing translation ${effectiveSourceLanguage} -> ${targetLanguage}...`);
                    await invoke('start_text_translator');
                    await invoke('prepare_text_translation', {
                        sourceLang: effectiveSourceLanguage,
                        targetLang: targetLanguage,
                        translationModel,
                    });
                    this.localPreparedTranslationKey = prepareKey;
                    this.transcriptUI.removeStatusMessage();
                }
            }

            const revisionBeforeTranslate = this.localLatestRevisionByGroup.get(groupId) || revision;
            if (revision < revisionBeforeTranslate) {
                return;
            }

            const translationTimeoutMs = translationModel === 'azure' ? 8000 : 15000;
            const response = await Promise.race([
                invoke('translate_text', {
                    text: normalizedText,
                    sourceLang: effectiveSourceLanguage === 'auto' ? 'auto' : effectiveSourceLanguage,
                    targetLang: targetLanguage,
                    translationModel,
                }),
                new Promise((_, reject) => {
                    setTimeout(() => reject(new Error(`Translation timeout after ${translationTimeoutMs}ms`)), translationTimeoutMs);
                }),
            ]);

            const latestRevisionAfterTranslate = this.localLatestRevisionByGroup.get(groupId) || revision;
            if (revision < latestRevisionAfterTranslate) {
                return;
            }

            const translated = response?.translated || '';
            this.localLastTranslatedByGroup.set(groupId, normalizedText);
            if (translated.trim()) {
                this.transcriptUI.addTranslation(translated, { groupId });
                this._speakIfEnabled(translated);
            }
        };

        this.localTranslationQueue = this.localTranslationQueue
            .catch(() => {})
            .then(task)
            .catch((err) => {
                const message = err?.message || `${err}`;
                console.error('[Local] translate_text failed:', message);
                const activeTranslationModel = settingsManager.get().translation_model || 'marian';
                if (/timeout/i.test(message) && activeTranslationModel !== 'azure') {
                    this.localPreparedTranslationKey = null;
                    invoke('stop_text_translator').catch(() => {});
                }
                this._showToast(message, 'error');
                this.transcriptUI.showStatusMessage(message);
            });

        return this.localTranslationQueue;
    }

    async _startDeepgramMode(settings) {
        console.log('[App] Connecting to Deepgram...');
        this._updateStatus('connecting');
        this.deepgramDebugSessionId = this._newDeepgramDebugSessionId();
        await this._appendDeepgramSessionMarker(
            'START',
            `source=${this.currentSource} source_lang=${settings.source_language || 'auto'} target_lang=${settings.target_language || 'vi'} fast_mode=${settings.deepgram_fast_mode === true ? 'true' : 'false'}`,
        );
        this.deepgramPendingGroup = null;
        this._resetDeepgramEventStats();
        if (this.deepgramFlushTimer) {
            clearTimeout(this.deepgramFlushTimer);
            this.deepgramFlushTimer = null;
        }
        this.deepgramTranslationQueue = Promise.resolve();
        this.lastDeepgramTranslatedText = '';
        this.lastDeepgramTranslatedAt = 0;
        this.deepgramLastTranslatedByGroup.clear();
        this.deepgramLatestRevisionByGroup.clear();

        try {
            await invoke('start_capture', {
                source: this.currentSource,
                channel: new window.__TAURI__.core.Channel(),
            });
            await invoke('stop_capture');
        } catch (err) {
            console.error('[App] Audio permission check failed:', err);
            this._showToast(`Audio permission required: ${err}`, 'error');
            this.isRunning = false;
            this._updateStartButton();
            this._updateStatus('error');
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            return;
        }

        const effectiveEndpointDelay = this._resolveDeepgramEndpointDelay(settings);
        const deepgramFastMode = this._isDeepgramFastMode(settings);

        try {
            await this._ensureDeepgramTranslationReady(settings);
            const deepgramSourceLanguage = this._isDeepgramTwoWayMode(settings)
                ? 'auto'
                : settings.source_language;
            await invoke('append_deepgram_log', {
                message: `ui_before_connect session=${this.deepgramDebugSessionId || 'n/a'} source=${this.currentSource} settings_source_lang=${settings.source_language} deepgram_source_lang=${deepgramSourceLanguage} endpoint_delay=${effectiveEndpointDelay} fast_mode=${deepgramFastMode ? 'true' : 'false'}`,
            }).catch(() => {});
            await Promise.race([
                deepgramClient.connect({
                    sourceLanguage: deepgramSourceLanguage,
                    endpointDelay: effectiveEndpointDelay,
                    fastMode: deepgramFastMode,
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Deepgram connect timeout on frontend after 20s')), 20000)),
            ]);
        } catch (err) {
            console.error('[App] Failed to start Deepgram:', err);
            await this._appendDeepgramSessionMarker(
                'ERROR',
                `stage=connect message=${String(err?.message || err).replace(/\s+/g, ' ').slice(0, 240)}`,
            );
            this._showToast(`Deepgram error: ${err.message || err}`, 'error');
            await this.stop();
            return;
        }

        try {
            await invoke('start_capture_to_deepgram', {
                source: this.currentSource,
            });
            console.log('[App] Deepgram native audio capture started');
        } catch (err) {
            console.error('[App] Failed to start Deepgram audio capture:', err);
            await this._appendDeepgramSessionMarker(
                'ERROR',
                `stage=capture message=${String(err?.message || err).replace(/\s+/g, ' ').slice(0, 240)}`,
            );
            this._showToast(`Audio error: ${err}`, 'error');
            await this.stop();
        }
    }

    _newDeepgramDebugSessionId() {
        const now = Date.now().toString(36);
        const rand = Math.random().toString(36).slice(2, 8);
        return `dg-ui-${now}-${rand}`;
    }

    async _appendDeepgramSessionMarker(stage, details = '') {
        const session = this.deepgramDebugSessionId || 'n/a';
        const suffix = details ? ` ${details}` : '';
        await invoke('append_deepgram_log', {
            message: `=== UI_SESSION_${stage} session=${session}${suffix} ===`,
        }).catch(() => {});
    }

    async _ensureDeepgramTranslationReady(settings) {
        const targetLanguage = settings.target_language || 'vi';
        const sourceLanguage = settings.source_language || 'auto';
        const translationModel = settings.translation_model || 'marian';
        const isTwoWayMode = this._isDeepgramTwoWayMode(settings);
        const langA = this._normalizeLanguageCode(settings.language_a || 'vi');
        const langB = this._normalizeLanguageCode(settings.language_b || 'en');
        const prepareKey = isTwoWayMode
            ? `two_way:${langA}:${langB}:${translationModel}`
            : `${sourceLanguage}:${targetLanguage}:${translationModel}`;

        if (!isTwoWayMode && sourceLanguage !== 'auto' && sourceLanguage === targetLanguage) {
            return;
        }

        if (isTwoWayMode && (!langA || !langB || langA === langB)) {
            throw new Error('Two-way mode requires two different languages (A and B).');
        }

        if (isTwoWayMode) {
            const unsupported = [langA, langB].filter((lang) => !this._isDeepgramMultilingualSupportedLanguage(lang));
            if (unsupported.length > 0) {
                throw new Error(
                    `Deepgram two-way hiện không hỗ trợ auto-detect cho ngôn ngữ: ${unsupported.join(', ')}. ` +
                    'Với cặp VI <-> EN, hãy dùng one-way hoặc đổi STT/provider khác.'
                );
            }
        }

        if (this.deepgramPreparedTranslationKey === prepareKey) {
            return;
        }

        try {
            const checkResult = await invoke('check_local_setup');
            const status = JSON.parse(checkResult);
            const setupVersion = Number(status?.details?.version || 0);
            if (!status.ready || setupVersion < 4) {
                const setupMessage = status.ready
                    ? 'Updating local translation environment...'
                    : 'Installing local translation environment...';
                this._showToast(setupMessage, 'success');
                this.transcriptUI.showStatusMessage(setupMessage);
                await this._runLocalSetup();
            }
            await invoke('start_text_translator');
            if (isTwoWayMode) {
                this.transcriptUI.showStatusMessage(`Preparing translation ${langA} <-> ${langB}...`);
                await invoke('prepare_text_translation', {
                    sourceLang: langA,
                    targetLang: langB,
                    translationModel,
                });
                await invoke('prepare_text_translation', {
                    sourceLang: langB,
                    targetLang: langA,
                    translationModel,
                });
            } else {
                this.transcriptUI.showStatusMessage(`Preparing translation ${sourceLanguage} -> ${targetLanguage}...`);
                await invoke('prepare_text_translation', {
                    sourceLang: sourceLanguage,
                    targetLang: targetLanguage,
                    translationModel,
                });
            }
            this.deepgramPreparedTranslationKey = prepareKey;
            await invoke('append_deepgram_log', {
                message: isTwoWayMode
                    ? `translation_pair_ready source=${langA}/${langB} target=${langB}/${langA} translation_model=${translationModel} mode=two_way`
                    : `translation_pair_ready source=${sourceLanguage} target=${targetLanguage} translation_model=${translationModel}`,
            }).catch(() => {});
            this.transcriptUI.removeStatusMessage();
        } catch (err) {
            throw new Error(`Local translation setup failed: ${err.message || err}`);
        }
    }

    async _handleDeepgramOriginal(text, speaker, language, meta = {}) {
        const normalizedText = text?.trim();
        if (!normalizedText) {
            return;
        }
        this._recordDeepgramEvent('original', normalizedText, meta);
        const runtimeSettings = settingsManager.get();
        const effectiveLanguage = language || runtimeSettings.source_language || 'auto';
        const runtimeDirection = this._resolveDeepgramDirection(effectiveLanguage, runtimeSettings);
        const strictSentencePair = this._isDeepgramStrictSentencePair(runtimeDirection.sourceLanguage);

        await this._rolloverDeepgramPendingGroupIfNeeded(speaker, language, meta);
        const canReusePending = this.deepgramPendingGroup && this._canAppendToDeepgramGroup(speaker, language, meta);

        // Fix 1: If we can't reuse the pending group (e.g. speaker changed),
        // check if this exact text was recently translated. If so, skip entirely
        // to prevent duplicate rows caused by Deepgram speaker ID flapping.
        if (!canReusePending && this._isDeepgramRecentlyTranslated(normalizedText)) {
            return;
        }

        // When the stream splits into a new group (speaker/lang drift),
        // commit the previous pending row instead of deleting it.
        // Deleting makes users feel text "disappears" mid-stream.
        if (!canReusePending && this.deepgramPendingGroup) {
            await this._commitDeepgramPendingGroup('group_split');
        }

        const group = canReusePending
            ? this.deepgramPendingGroup
            : {
                id: `dg-${++this.deepgramGroupCounter}`,
                text: '',
                speaker: speaker ?? null,
                language: language || null,
                utteranceIds: [],
                sttWallMs: null,
                lastTranslatedSourceText: '',
                revision: 0,
            };

        group.text = strictSentencePair && canReusePending
            ? this._mergeDeepgramGroupText(group.text, normalizedText)
            : normalizedText;
        group.speaker = speaker ?? group.speaker ?? null;
        group.language = language || group.language || null;
        group.utteranceIds = [meta?.utterance_id ?? group.utteranceIds?.[0] ?? `dg-${Date.now()}`];
        group.sttWallMs = meta?.timing?.wall_ms ?? group.sttWallMs ?? null;
        group.speechFinal = Boolean(meta?.speech_final);
        group.revision = (group.revision || 0) + 1;
        this.deepgramLatestRevisionByGroup.set(group.id, group.revision);

        const groupDirection = this._resolveDeepgramDirection(
            group.language || effectiveLanguage,
            runtimeSettings,
        );
        const sourceLanguage = groupDirection.sourceLanguage;
        const targetLanguage = groupDirection.targetLanguage || runtimeSettings.target_language || 'vi';
        const decision = this._shouldTranslateDeepgramGroup(group, sourceLanguage, targetLanguage);

        if (strictSentencePair && !decision.shouldTranslate) {
            this.deepgramPendingGroup = group;
            this.transcriptUI.commitProvisionalGroup(
                group.id,
                group.text,
                group.speaker,
                group.language,
                { confidence: meta?.confidence ?? null },
            );
            return;
        }

        this.transcriptUI.commitProvisionalGroup(
            group.id,
            group.text,
            group.speaker,
            group.language,
            { confidence: meta?.confidence ?? null },
        );

        if (group.speechFinal || decision.closesGroup || strictSentencePair) {
            this.deepgramPendingGroup = null;
            if (this.deepgramFlushTimer) {
                clearTimeout(this.deepgramFlushTimer);
                this.deepgramFlushTimer = null;
            }
            await this._translateDeepgramGroup({
                ...group,
                utteranceIds: [...group.utteranceIds],
            });
            return;
        }

        this.deepgramPendingGroup = group;
        this._scheduleDeepgramGroupFlush(this.deepgramFlushDelayMs);
    }

    async _handleDeepgramProvisional(text, speaker, language, meta = {}) {
        const normalizedText = text?.trim();
        const effectiveLanguage = language || settingsManager.get().source_language || 'auto';
        const strictSentencePair = this._isDeepgramStrictSentencePair(effectiveLanguage);
        if (!normalizedText) {
            if (meta?.speech_final && this.deepgramPendingGroup) {
                this.deepgramPendingGroup = null;
            }
            this.transcriptUI.clearProvisional();
            return;
        }
        this._recordDeepgramEvent('provisional', normalizedText, meta);

        let group = this.deepgramPendingGroup;
        await this._rolloverDeepgramPendingGroupIfNeeded(speaker, language, meta);
        group = this.deepgramPendingGroup;
        if (!group || !this._canAppendToDeepgramGroup(speaker, language, meta)) {
            // Preserve old pending row on group split to avoid disappearing text.
            if (group) {
                await this._commitDeepgramPendingGroup('group_split');
            }
            group = {
                id: `dg-${++this.deepgramGroupCounter}`,
                text: '',
                speaker: speaker ?? null,
                language: language || null,
                utteranceIds: [],
                sttWallMs: null,
                lastTranslatedSourceText: '',
                revision: 0,
            };
            this.deepgramPendingGroup = group;
        }

        group.text = strictSentencePair && this.deepgramPendingGroup
            ? this._mergeDeepgramGroupText(group.text, normalizedText)
            : normalizedText;
        group.speaker = speaker ?? group.speaker ?? null;
        group.language = language || group.language || null;
        group.utteranceIds = [meta?.utterance_id ?? group.utteranceIds?.[0] ?? `dg-${Date.now()}`];
        group.sttWallMs = meta?.timing?.wall_ms ?? group.sttWallMs ?? null;
        group.speechFinal = Boolean(meta?.speech_final);
        group.revision = (group.revision || 0) + 1;
        this.deepgramLatestRevisionByGroup.set(group.id, group.revision);

        if (strictSentencePair) {
            this.transcriptUI.clearProvisional();
            this.transcriptUI.upsertOriginalGroup(
                group.id,
                group.text,
                group.speaker,
                group.language,
                { confidence: meta?.confidence ?? null },
            );
            return;
        }

        this.transcriptUI.clearProvisional();
        this.transcriptUI.upsertOriginalGroup(
            group.id,
            group.text,
            group.speaker,
            group.language,
            { confidence: meta?.confidence ?? null },
        );
    }

    _resetDeepgramEventStats() {
        this.deepgramEventStats = {
            provisionalCount: 0,
            originalCount: 0,
            lastProvisionalAt: 0,
            lastOriginalAt: 0,
            lastProvisionalText: '',
            lastOriginalText: '',
        };
    }

    _recordDeepgramEvent(kind, text, meta = {}) {
        if (!this.deepgramEventStats) {
            this._resetDeepgramEventStats();
        }
        const stats = this.deepgramEventStats;
        const now = Date.now();
        if (kind === 'provisional') {
            stats.provisionalCount += 1;
            stats.lastProvisionalAt = now;
            stats.lastProvisionalText = text;
        } else if (kind === 'original') {
            stats.originalCount += 1;
            stats.lastOriginalAt = now;
            stats.lastOriginalText = text;
        }
        invoke('append_deepgram_log', {
            message: `ui_event session=${this.deepgramDebugSessionId || 'n/a'} type=${kind} chars=${text.length} speech_final=${meta?.speech_final ? 'true' : 'false'} is_final=${meta?.is_final ? 'true' : 'false'} utterance=${meta?.utterance_id ?? 'n/a'} provisional_count=${stats.provisionalCount} original_count=${stats.originalCount}`,
        }).catch(() => {});
    }

    _getDeepgramUtteranceKey(meta = {}) {
        const id = meta?.utterance_id;
        if (id === undefined || id === null) {
            return '';
        }
        return String(id);
    }

    _canAppendToDeepgramGroup(speaker, language, meta = {}) {
        if (!this.deepgramPendingGroup) {
            return false;
        }
        if (this.deepgramPendingGroup.speaker !== (speaker ?? null)) {
            return false;
        }
        const currentLanguage = this.deepgramPendingGroup.language || null;
        const nextLanguage = language || null;
        if (currentLanguage !== nextLanguage) {
            return false;
        }
        const currentUtterance = this.deepgramPendingGroup.utteranceIds?.[0] || '';
        const nextUtterance = this._getDeepgramUtteranceKey(meta);
        if (currentUtterance && nextUtterance && currentUtterance !== nextUtterance) {
            // In fast mode Deepgram may rotate utterance IDs aggressively while the
            // speaker still continues one sentence; keep appending to avoid split duplicates.
            if (!this._isDeepgramFastMode(settingsManager.get())) {
                return false;
            }
        }
        return true;
    }

    async _rolloverDeepgramPendingGroupIfNeeded(speaker, language, meta = {}) {
        const pending = this.deepgramPendingGroup;
        if (!pending?.text?.trim()) {
            return;
        }
        const strictSentencePair = this._isDeepgramStrictSentencePair(language || pending.language || settingsManager.get().source_language || 'auto');
        const nextUtterance = this._getDeepgramUtteranceKey(meta);
        const currentUtterance = pending.utteranceIds?.[0] || '';
        const sameSpeaker = pending.speaker === (speaker ?? null);
        const sameLanguage = (pending.language || null) === (language || null);
        if (this._isDeepgramFastMode(settingsManager.get())) {
            return;
        }
        if (!sameSpeaker || !sameLanguage) {
            return;
        }
        if (!currentUtterance || !nextUtterance || currentUtterance === nextUtterance) {
            return;
        }
        await this._commitDeepgramPendingGroup('utterance_rollover');
    }

    async _commitDeepgramPendingGroup(reason = 'manual_commit') {
        const pending = this.deepgramPendingGroup;
        if (!pending?.text?.trim()) {
            this.deepgramPendingGroup = null;
            this.transcriptUI.clearProvisional();
            return;
        }
        if (this.deepgramFlushTimer) {
            clearTimeout(this.deepgramFlushTimer);
            this.deepgramFlushTimer = null;
        }
        const snapshot = {
            ...pending,
            utteranceIds: [...(pending.utteranceIds || [])],
        };
        this.deepgramPendingGroup = null;
        this.transcriptUI.commitProvisionalGroup(
            snapshot.id,
            snapshot.text,
            snapshot.speaker,
            snapshot.language,
            { confidence: snapshot.confidence ?? null },
        );
        const settings = settingsManager.get();
        const direction = this._resolveDeepgramDirection(
            snapshot.language || settings.source_language || 'auto',
            settings,
        );
        const targetLanguage = direction.targetLanguage || settings.target_language || 'vi';
        const sourceLanguage = direction.sourceLanguage;
        let decision = this._shouldTranslateDeepgramGroup(snapshot, sourceLanguage, targetLanguage);
        // On rollover/split commits, force a translation pass to avoid stranded rows
        // when segmentation changes before explicit boundary punctuation arrives.
        // In fast mode, forcing translation on split creates duplicate partial rows,
        // so only force this behavior for non-fast mode.
        const forceTranslateOnSplit = !this._isDeepgramFastMode(settings);
        if (
            (reason === 'utterance_rollover' || reason === 'group_split')
            && forceTranslateOnSplit
            && !decision.shouldTranslate
            && snapshot.text?.trim()
        ) {
            decision = {
                shouldTranslate: true,
                reason: `${reason}_force`,
                closesGroup: true,
            };
        }
        if (!decision.shouldTranslate) {
            await invoke('append_deepgram_log', {
                message: `group=${snapshot.id} commit_without_translation reason=${reason} decision=${decision.reason}`,
            }).catch(() => {});
            return;
        }
        await this._translateDeepgramGroup(snapshot, {
            ...decision,
            reason,
            closesGroup: true,
        });
    }

    _mergeDeepgramGroupText(existingText, nextText) {
        const current = (existingText || '').trim();
        const incoming = (nextText || '').trim();
        if (!current) {
            return incoming;
        }
        if (!incoming) {
            return current;
        }
        if (current === incoming || current.endsWith(incoming)) {
            return current;
        }
        if (incoming.startsWith(current)) {
            return incoming;
        }
        if (incoming.includes(current)) {
            return incoming;
        }
        if (current.includes(incoming)) {
            return current;
        }

        const compactCurrent = current.replace(/\s+/g, '');
        const compactIncoming = incoming.replace(/\s+/g, '');
        const looksCjkLike = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(current + incoming);
        if (looksCjkLike && compactCurrent && compactIncoming) {
            const normalizedCurrent = compactCurrent.replace(/[.!?…。！？]/g, '');
            const normalizedIncoming = compactIncoming.replace(/[.!?…。！？]/g, '');

            if (normalizedCurrent === normalizedIncoming) {
                return incoming.length >= current.length ? incoming : current;
            }
            if (normalizedIncoming.startsWith(normalizedCurrent)) {
                return incoming;
            }
            if (normalizedCurrent.startsWith(normalizedIncoming)) {
                return current;
            }

            const maxOverlap = Math.min(normalizedCurrent.length, normalizedIncoming.length, 32);
            for (let size = maxOverlap; size >= 2; size -= 1) {
                if (normalizedCurrent.slice(-size) === normalizedIncoming.slice(0, size)) {
                    return incoming;
                }
            }

            return incoming.length >= current.length ? incoming : current;
        }

        const currentWords = current.split(/\s+/);
        const incomingWords = incoming.split(/\s+/);
        const maxOverlap = Math.min(currentWords.length, incomingWords.length, 12);
        for (let size = maxOverlap; size > 0; size -= 1) {
            const currentTail = currentWords.slice(-size).join(' ').toLowerCase();
            const incomingHead = incomingWords.slice(0, size).join(' ').toLowerCase();
            if (currentTail === incomingHead) {
                return [...currentWords, ...incomingWords.slice(size)].join(' ').trim();
            }
        }

        return `${current} ${incoming}`.replace(/\s+/g, ' ').trim();
    }

    _scheduleDeepgramGroupFlush(delayMs) {
        if (this.deepgramFlushTimer) {
            clearTimeout(this.deepgramFlushTimer);
            this.deepgramFlushTimer = null;
        }
        const currentGroupId = this.deepgramPendingGroup?.id;
        const currentRevision = this.deepgramPendingGroup?.revision || 0;
        if (!currentGroupId) {
            return;
        }
        this.deepgramFlushTimer = setTimeout(() => {
            void this._flushDeepgramGroup(currentGroupId, currentRevision);
        }, Math.max(0, delayMs));
    }

    async _flushDeepgramGroup(groupId, expectedRevision = 0) {
        if (this.deepgramFlushTimer) {
            clearTimeout(this.deepgramFlushTimer);
            this.deepgramFlushTimer = null;
        }

        if (!this.deepgramPendingGroup || this.deepgramPendingGroup.id !== groupId) {
            return;
        }

        const group = this.deepgramPendingGroup;
        if (!group?.text?.trim()) {
            return;
        }
        if (expectedRevision && (group.revision || 0) !== expectedRevision) {
            return;
        }
        const snapshot = {
            ...group,
            utteranceIds: [...group.utteranceIds],
        };
        const runtimeSettings = settingsManager.get();
        const direction = this._resolveDeepgramDirection(
            snapshot.language || runtimeSettings.source_language || 'auto',
            runtimeSettings,
        );
        const targetLanguage = direction.targetLanguage || runtimeSettings.target_language || 'vi';
        const sourceLanguage = direction.sourceLanguage;
        const decision = this._shouldTranslateDeepgramGroup(snapshot, sourceLanguage, targetLanguage);

        if (decision.shouldTranslate && decision.closesGroup) {
            this.deepgramPendingGroup = null;
        }

        await this._translateDeepgramGroup(snapshot, decision);
    }

    _deepgramTextHasExplicitSentenceBoundary(text) {
        const value = (text || '').trim();
        if (!value) {
            return false;
        }
        return /[.!?…。！？]$/.test(value);
    }

    _deepgramTextHasSentenceBoundary(text, language) {
        const value = (text || '').trim();
        if (!value) {
            return false;
        }
        if (this._deepgramTextHasExplicitSentenceBoundary(value)) {
            return true;
        }
        const compact = value.replace(/\s+/g, '');
        if (language && ['ko', 'ja'].includes(language) && compact.length >= 10) {
            return true;
        }
        return false;
    }

    _deepgramTextIsLongEnough(text, language) {
        const value = (text || '').trim();
        if (!value) {
            return false;
        }
        const compactLength = value.replace(/\s+/g, '').length;
        const wordCount = value.split(/\s+/).filter(Boolean).length;
        if (language === 'zh') {
            return compactLength >= 4;
        }
        if (language && ['ko', 'ja'].includes(language)) {
            return compactLength >= 10;
        }
        return compactLength >= 8 || wordCount >= 2;
    }

    _isDeepgramContinuousPair(sourceLanguage, targetLanguage) {
        if (!sourceLanguage || !targetLanguage) {
            return false;
        }
        const supported = ['vi', 'en'];
        return supported.includes(sourceLanguage) && supported.includes(targetLanguage);
    }

    _isDeepgramStrictSentencePair(sourceLanguage) {
        return ['ko', 'ja'].includes(sourceLanguage || '');
    }

    _normalizeLanguageCode(code) {
        const value = String(code || '').trim().toLowerCase();
        if (!value) return '';
        if (value === 'auto' || value === 'multi') return value;
        return value.split(/[-_]/)[0];
    }

    _isDeepgramMultilingualSupportedLanguage(code) {
        return new Set(['en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl'])
            .has(this._normalizeLanguageCode(code));
    }

    _isDeepgramTwoWayMode(settings = settingsManager.get()) {
        return (settings.translation_mode || 'local') === 'deepgram'
            && (settings.translation_type || 'one_way') === 'two_way';
    }

    _resolveDeepgramDirection(sourceLanguage, settings = settingsManager.get()) {
        const normalizedSource = this._normalizeLanguageCode(
            sourceLanguage || settings.source_language || 'auto',
        ) || 'auto';

        if (!this._isDeepgramTwoWayMode(settings)) {
            return {
                sourceLanguage: normalizedSource,
                targetLanguage: this._normalizeLanguageCode(settings.target_language || 'vi') || 'vi',
                twoWay: false,
            };
        }

        const langA = this._normalizeLanguageCode(settings.language_a || 'vi') || 'vi';
        const langB = this._normalizeLanguageCode(settings.language_b || 'en') || 'en';

        if (langA === langB) {
            return {
                sourceLanguage: normalizedSource,
                targetLanguage: null,
                twoWay: true,
            };
        }

        if (normalizedSource === langA) {
            return {
                sourceLanguage: langA,
                targetLanguage: langB,
                twoWay: true,
            };
        }

        if (normalizedSource === langB) {
            return {
                sourceLanguage: langB,
                targetLanguage: langA,
                twoWay: true,
            };
        }

        return {
            sourceLanguage: normalizedSource,
            targetLanguage: null,
            twoWay: true,
        };
    }

    /**
     * Check if text was recently translated (rolling window dedup).
     * Prevents duplicate rows caused by speaker ID flapping and re-emission.
     */
    _isDeepgramRecentlyTranslated(text) {
        const normalized = (text || '').trim();
        if (!normalized) return false;
        const now = Date.now();
        const dedupeWindowMs = 8000;
        return this.deepgramRecentTranslatedTexts.some(
            entry => entry.text === normalized && (now - entry.at) <= dedupeWindowMs
        );
    }

    /**
     * Find a recently-translated group whose source text is a PREFIX of the given text.
     * This detects Deepgram utterance accumulation (e.g. "A. B." -> "A. B. C.").
     * Returns the entry if found, null otherwise.
     */
    _findDeepgramSupersetGroup(text) {
        const normalized = (text || '').trim();
        if (!normalized || normalized.length < 10) return null;
        const now = Date.now();
        const windowMs = 12000;
        // Search from most recent to oldest
        for (let i = this.deepgramRecentTranslatedTexts.length - 1; i >= 0; i--) {
            const entry = this.deepgramRecentTranslatedTexts[i];
            if ((now - entry.at) > windowMs) continue;
            if (
                entry.text !== normalized
                && normalized.startsWith(entry.text)
                && entry.groupId
            ) {
                return entry;
            }
        }
        return null;
    }

    /**
     * Add text to rolling dedup window (max 10 entries).
     */
    _addDeepgramRecentTranslatedText(text, groupId = null) {
        const normalized = (text || '').trim();
        if (!normalized) return;
        const now = Date.now();
        this.deepgramRecentTranslatedTexts.push({ text: normalized, at: now, groupId });
        // Keep only last 10 entries
        if (this.deepgramRecentTranslatedTexts.length > 10) {
            this.deepgramRecentTranslatedTexts.shift();
        }
    }

    _isDeepgramFastMode(settings = settingsManager.get()) {
        return settings?.translation_mode === 'deepgram'
            && settings?.deepgram_fast_mode === true;
    }

    _getDeepgramRecommendedEndpointDelay(sourceLanguage, settings = settingsManager.get()) {
        if (this._isDeepgramFastMode(settings)) {
            if (this._isDeepgramStrictSentencePair(sourceLanguage)) {
                return 350;
            }
            if ((sourceLanguage || '') === 'zh') {
                return 600;
            }
            return 120;
        }
        if (this._isDeepgramStrictSentencePair(sourceLanguage)) {
            return 1200;
        }
        if ((sourceLanguage || '') === 'zh') {
            return 900;
        }
        return 250;
    }

    _resolveDeepgramEndpointDelay(settings) {
        const sourceLanguage = settings?.source_language || 'auto';
        const recommended = this._getDeepgramRecommendedEndpointDelay(sourceLanguage, settings);
        const configured = Number(settings?.endpoint_delay);
        if (Number.isFinite(configured) && configured > 0) {
            return Math.max(10, Math.round(configured));
        }
        return recommended;
    }

    _shouldTranslateDeepgramGroup(group, sourceLanguage, targetLanguage) {
        const text = (group?.text || '').trim();
        if (!text) {
            return { shouldTranslate: false, reason: 'empty_text' };
        }
        if (!sourceLanguage || sourceLanguage === 'auto') {
            return { shouldTranslate: false, reason: 'source_unresolved' };
        }
        if (sourceLanguage === targetLanguage) {
            return { shouldTranslate: true, reason: 'same_language' };
        }

        const speechFinal = Boolean(group?.speechFinal);
        if (speechFinal) {
            return { shouldTranslate: true, reason: 'speech_final', closesGroup: true };
        }

        const hasExplicitBoundary = this._deepgramTextHasExplicitSentenceBoundary(text);
        const hasSentenceBoundary = this._deepgramTextHasSentenceBoundary(text, sourceLanguage);
        const isLongEnough = this._deepgramTextIsLongEnough(text, sourceLanguage);

        if (this._isDeepgramStrictSentencePair(sourceLanguage)) {
            if (hasExplicitBoundary && isLongEnough) {
                return { shouldTranslate: true, reason: 'sentence_like_strict', closesGroup: true };
            }
            // Korean/Japanese streams often come without trailing punctuation.
            // Use sentence-like heuristic so text is committed and translated
            // instead of being continuously overwritten in one pending row.
            if (hasSentenceBoundary && isLongEnough) {
                return { shouldTranslate: true, reason: 'sentence_like_strict_heuristic', closesGroup: true };
            }
            return {
                shouldTranslate: false,
                reason: `waiting_for_strict_boundary long_enough=${isLongEnough} boundary=${hasExplicitBoundary}`,
            };
        }

        if (sourceLanguage === 'zh') {
            if (hasExplicitBoundary) {
                return {
                    shouldTranslate: true,
                    reason: 'sentence_boundary_zh',
                    closesGroup: true,
                };
            }
            if (isLongEnough) {
                return {
                    shouldTranslate: true,
                    reason: 'chunk_ready_zh',
                    closesGroup: false,
                };
            }
            return {
                shouldTranslate: false,
                reason: `waiting_for_zh_chunk long_enough=${isLongEnough} boundary=${hasExplicitBoundary}`,
            };
        }

        if (this._isDeepgramContinuousPair(sourceLanguage, targetLanguage)) {
            if (hasExplicitBoundary) {
                return {
                    shouldTranslate: true,
                    reason: 'sentence_boundary',
                    closesGroup: true,
                };
            }
            return {
                shouldTranslate: false,
                reason: `waiting_for_sentence_boundary long_enough=${isLongEnough} boundary=${hasExplicitBoundary}`,
            };
        }

        if (hasSentenceBoundary && isLongEnough) {
            return { shouldTranslate: true, reason: 'sentence_like', closesGroup: true };
        }

        return {
            shouldTranslate: false,
            reason: `waiting_for_boundary long_enough=${isLongEnough} boundary=${hasSentenceBoundary}`,
        };
    }

    async _translateDeepgramGroup(group, overrideDecision = null) {
        const settings = settingsManager.get();
        const direction = this._resolveDeepgramDirection(
            group.language || settings.source_language || 'auto',
            settings,
        );
        const targetLanguage = direction.targetLanguage || settings.target_language || 'vi';
        const sourceLanguage = direction.sourceLanguage;
        const translationModel = settings.translation_model || 'marian';
        const normalizedText = group.text?.trim();
        const utteranceId = group.utteranceIds.join(',');
        const sttWallMs = group.sttWallMs ?? null;

        if (!normalizedText) {
            return;
        }
        const lastTranslatedText = this.deepgramLastTranslatedByGroup.get(group.id) || '';
        if (normalizedText === lastTranslatedText) {
            await invoke('append_deepgram_log', {
                message: `group=${group.id} skipping translation because text is duplicate for group`,
            }).catch(() => {});
            return;
        }
        if (
            sourceLanguage === 'zh'
            && !group.speechFinal
            && normalizedText.startsWith(lastTranslatedText)
            && (normalizedText.length - lastTranslatedText.length) < 4
        ) {
            await invoke('append_deepgram_log', {
                message: `group=${group.id} skipping translation because zh delta is too small`,
            }).catch(() => {});
            return;
        }
        if (!sourceLanguage || sourceLanguage === 'auto') {
            await invoke('append_deepgram_log', {
                message: `group=${group.id} skipping translation because source language is unresolved`,
            }).catch(() => {});
            return;
        }
        const decision = overrideDecision || this._shouldTranslateDeepgramGroup(group, sourceLanguage, targetLanguage);
        if (!decision.shouldTranslate) {
            await invoke('append_deepgram_log', {
                message: `group=${group.id} skipping translation because ${decision.reason}`,
            }).catch(() => {});
            return;
        }
        const superseded = this._findDeepgramSupersetGroup(normalizedText);
        if (superseded?.groupId && superseded.groupId !== group.id) {
            this.transcriptUI.removeGroup(superseded.groupId);
            this.deepgramLastTranslatedByGroup.delete(superseded.groupId);
            this.deepgramLatestRevisionByGroup.delete(superseded.groupId);
            await invoke('append_deepgram_log', {
                message: `group=${group.id} removed superseded_group=${superseded.groupId} via superset merge`,
            }).catch(() => {});
        }
        if (sourceLanguage === targetLanguage) {
            this.deepgramLastTranslatedByGroup.set(group.id, normalizedText);
            this.transcriptUI.addTranslation(normalizedText, { groupId: group.id });
            return;
        }

        const task = async () => {
            const startedRevision = group.revision || 0;
            const latestRevision = this.deepgramLatestRevisionByGroup.get(group.id) || startedRevision;
            if (startedRevision < latestRevision) {
                return;
            }
            const startedAt = performance.now();
            await invoke('append_deepgram_log', {
                message: `group=${group.id} translation_start utterances=${utteranceId} source=${sourceLanguage} target=${targetLanguage} translation_model=${translationModel} speech_final=${group.speechFinal ? 'true' : 'false'} trigger=${decision.reason} stt_wall_ms=${sttWallMs ?? 'n/a'} text=${normalizedText.slice(0, 120)}`,
            }).catch(() => {});

            try {
                const response = await invoke('translate_text', {
                    text: normalizedText,
                    sourceLang: sourceLanguage,
                    targetLang: targetLanguage,
                    translationModel,
                });
                const revisionAfterTranslate = this.deepgramLatestRevisionByGroup.get(group.id) || startedRevision;
                if (startedRevision < revisionAfterTranslate) {
                    await invoke('append_deepgram_log', {
                        message: `group=${group.id} dropping stale translation started_revision=${startedRevision} latest_revision=${revisionAfterTranslate}`,
                    }).catch(() => {});
                    return;
                }
                const translated = response?.translated || '';
                const translationMs = Math.round(performance.now() - startedAt);
                const now = Date.now();
                const strictSentencePair = this._isDeepgramStrictSentencePair(sourceLanguage);
                // Do not apply cross-group recent-text dedupe for KO/JA.
                // Repeated short phrases are common in these languages and still
                // need a translated row instead of being dropped as duplicates.
                if (!strictSentencePair && this._isDeepgramRecentlyTranslated(normalizedText)) {
                    await invoke('append_deepgram_log', {
                        message: `group=${group.id} skipping translation because text is duplicate for recent session window`,
                    }).catch(() => {});
                    this.deepgramLastTranslatedByGroup.set(group.id, normalizedText);
                    return;
                }
                this.deepgramLastTranslatedByGroup.set(group.id, normalizedText);
                this._addDeepgramRecentTranslatedText(normalizedText, group.id);
                this.lastDeepgramTranslatedAt = now;
                await invoke('append_deepgram_log', {
                    message: `group=${group.id} translation_done engine=${response?.engine || 'unknown'} model=${response?.model || 'unknown'} normalization_applied=${response?.normalization_applied ? 'true' : 'false'} normalized_text=${(response?.normalized_text || normalizedText).slice(0, 120)} translation_ms=${translationMs} total_ms=${sttWallMs !== null ? sttWallMs + translationMs : 'n/a'} translated=${translated.slice(0, 120)}`,
                }).catch(() => {});

                if (translated?.trim()) {
                    this.transcriptUI.addTranslation(translated, { groupId: group.id });
                    this._speakIfEnabled(translated);
                }
            } catch (err) {
                const message = err?.message || `${err}`;
                await invoke('append_deepgram_log', {
                    message: `group=${group.id} translation_error message=${message}`,
                }).catch(() => {});
                console.error('[Deepgram] translate_text failed:', message);
                this._showToast(message, 'error');
                this.transcriptUI.showStatusMessage(message);
            }
        };

        this.deepgramTranslationQueue = this.deepgramTranslationQueue
            .catch(() => {})
            .then(task);

        return this.deepgramTranslationQueue;
    }

    async _runDeepgramSelfTest() {
        const btn = document.getElementById('btn-test-deepgram');
        const statusEl = document.getElementById('deepgram-test-status');
        const originalText = btn?.textContent || 'Test Deepgram Connection';

        try {
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Testing...';
            }
            if (statusEl) {
                statusEl.style.display = '';
                statusEl.textContent = 'Running Deepgram self-test...';
            }

            await this._saveSettingsFromForm();
            const resultRaw = await invoke('deepgram_self_test', {
                request: {
                    sourceLang: document.getElementById('select-source-lang')?.value || 'auto',
                    targetLang: document.getElementById('select-target-lang')?.value || 'vi',
                    translationModel: document.getElementById('select-translation-model')?.value || 'marian',
                }
            });
            const result = typeof resultRaw === 'string' ? JSON.parse(resultRaw) : resultRaw;

            const wsMessage = result.websocket?.ok
                ? 'WebSocket OK'
                : `WebSocket fail: ${result.websocket?.message || 'unknown error'}`;
            const translatorMessage = result.translator?.ok
                ? (result.translator?.skipped ? 'Translator skipped' : 'Translator OK')
                : `Translator fail: ${result.translator?.message || 'unknown error'}`;
            const summary = `Auth OK | ${wsMessage} | ${translatorMessage}`;

            if (statusEl) {
                statusEl.textContent = `${summary} | Log: ${result.log_path || 'n/a'}`;
            }
            if (result.ok) {
                this._showToast('Deepgram self-test passed.', 'success');
            } else {
                this._showToast(summary, 'error');
            }
        } catch (err) {
            const message = err?.message || `${err}`;
            if (statusEl) {
                statusEl.style.display = '';
                statusEl.textContent = `Deepgram self-test failed: ${message}`;
            }
            this._showToast(`Deepgram self-test failed: ${message}`, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        }
    }

    async _runLocalSetup() {
        const modal = document.getElementById('setup-modal');
        const progressFill = document.getElementById('setup-progress-fill');
        const progressPct = document.getElementById('setup-progress-pct');
        const statusText = document.getElementById('setup-status-text');
        const cancelBtn = document.getElementById('btn-cancel-setup');
        const openLogBtn = document.getElementById('btn-open-setup-log');
        const openPythonBtn = document.getElementById('btn-open-python-download');
        const killBtn = document.getElementById('btn-kill-blocking-python');

        // Step mapping: step name → total progress weight
        const stepWeights = { check: 5, venv: 10, packages: 35, models: 50 };
        let totalProgress = 0;

        const updateStep = (stepName, icon, isActive) => {
            const stepEl = document.getElementById(`step-${stepName}`);
            if (!stepEl) return;
            stepEl.querySelector('.step-icon').textContent = icon;
            stepEl.classList.toggle('active', isActive);
            stepEl.classList.toggle('done', icon === '✅');
        };

        const updateProgress = (pct) => {
            totalProgress = Math.min(100, pct);
            progressFill.style.width = totalProgress + '%';
            progressPct.textContent = Math.round(totalProgress) + '%';
        };

        // Show modal
        modal.style.display = 'flex';
        if (openLogBtn) openLogBtn.disabled = false;
        if (openPythonBtn) openPythonBtn.style.display = '';
        if (killBtn) killBtn.style.display = 'none';

        return new Promise((resolve, reject) => {
            const channel = new window.__TAURI__.core.Channel();

            // Cancel handler
            const onCancel = () => {
                modal.style.display = 'none';
                reject(new Error('Setup cancelled'));
            };
            cancelBtn.addEventListener('click', onCancel, { once: true });

            channel.onmessage = (msg) => {
                let data;
                try {
                    data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                } catch (e) {
                    return;
                }

                switch (data.type) {
                    case 'progress':
                        statusText.textContent = data.message || 'Working...';

                        // Update step indicators
                        if (data.step) {
                            // Mark previous steps as done
                            const steps = ['check', 'venv', 'packages', 'models'];
                            const currentIdx = steps.indexOf(data.step);
                            steps.forEach((s, i) => {
                                if (i < currentIdx) updateStep(s, '✅', false);
                                else if (i === currentIdx) updateStep(s, '🔄', true);
                            });

                            if (data.done) {
                                updateStep(data.step, '✅', false);
                            }

                            // Calculate overall progress
                            let pct = 0;
                            steps.forEach((s, i) => {
                                if (i < currentIdx) pct += stepWeights[s];
                                else if (i === currentIdx) {
                                    pct += (data.progress || 0) / 100 * stepWeights[s];
                                }
                            });
                            updateProgress(pct);
                        }

                        if (data.step === 'packages' && data.message) {
                            const stepEl = document.getElementById('step-packages');
                            const textEl = stepEl?.querySelector('.step-text');
                            const match = data.message.match(/Installing ([^\s]+) \((\d+)\/(\d+)\)/);
                            if (textEl && match) {
                                textEl.textContent = `Installing package ${match[2]}/${match[3]}: ${match[1]}`;
                            }
                        }
                        break;

                    case 'complete':
                        updateProgress(100);
                        statusText.textContent = '✅ ' + (data.message || 'Setup complete!');
                        ['check', 'venv', 'packages', 'models'].forEach(s => updateStep(s, '✅', false));
                        const packagesText = document.querySelector('#step-packages .step-text');
                        if (packagesText) packagesText.textContent = 'Installing packages';

                        // Close modal after brief delay
                        setTimeout(() => {
                            modal.style.display = 'none';
                            resolve();
                        }, 1000);
                        break;

                    case 'error':
                        statusText.textContent = '❌ ' + (data.message || 'Setup failed');
                        if (openPythonBtn) {
                            const showPythonDownload = (data.message || '').includes('supports Python 3.10, 3.11, or 3.12');
                            openPythonBtn.style.display = showPythonDownload ? '' : 'none';
                        }
                        if (killBtn) {
                            const showKill = /(being used by another process|Access is denied|Failed to clear old local environment|WinError 5|WinError 32)/i
                                .test(data.message || '');
                            killBtn.style.display = showKill ? '' : 'none';
                        }
                        cancelBtn.textContent = 'Close';
                        const packagesTextErr = document.querySelector('#step-packages .step-text');
                        if (packagesTextErr) packagesTextErr.textContent = 'Installing packages';
                        cancelBtn.removeEventListener('click', onCancel);
                        cancelBtn.addEventListener('click', () => {
                            modal.style.display = 'none';
                            reject(new Error(data.message));
                        }, { once: true });
                        break;

                    case 'log':
                        console.log('[Local Setup]', data.message);
                        if (typeof data.message === 'string' && data.message.startsWith('Using Python ')) {
                            statusText.textContent = data.message;
                        }
                        break;
                }
            };

            invoke('run_local_setup', {
                channel,
                localModel: this._normalizeLocalModel(settingsManager.get().local_model || 'turbo'),
                translationModel: settingsManager.get().translation_model || 'marian',
            })
                .catch(err => {
                    const message = String(err || '');
                    if (message.includes('setup is already running')) {
                        statusText.textContent = '⏳ Faster-Whisper Realtime setup is already running...';
                        this._waitForLocalSetupCompletion(this._normalizeLocalModel(settingsManager.get().local_model || 'turbo'))
                            .then(() => {
                                modal.style.display = 'none';
                                resolve();
                            })
                            .catch(waitErr => {
                                modal.style.display = 'none';
                                reject(waitErr);
                            });
                        return;
                    }
                    statusText.textContent = '❌ ' + err;
                    if (openPythonBtn) openPythonBtn.style.display = 'none';
                    const packagesTextCatch = document.querySelector('#step-packages .step-text');
                    if (packagesTextCatch) packagesTextCatch.textContent = 'Installing packages';
                    modal.style.display = 'none';
                    reject(err);
                });
        });
    }

    async stop() {
        this.isStarting = false;
        this.isRunning = false;
        this._updateStartButton();

        // Stop audio capture
        try {
            await invoke('stop_capture');
        } catch (err) {
            console.error('Failed to stop audio capture:', err);
        }

        if (this.translationMode === 'local') {
            // Keep local pipeline warm across Start/Stop; only stop audio capture.
            this.localTranslationQueue = Promise.resolve();
            this.localLatestRevisionByGroup.clear();
            this.localLastTranslatedByGroup.clear();
            this.localSentenceStateByUtterance.clear();
            this.localRecentCommittedGroups = [];
            this.localCarryOver = null;
            this._clearLocalCarryOverTimeout();
            this.transcriptUI.removeStatusMessage();
            this._updateStatus('disconnected');
        } else if (this.translationMode === 'deepgram') {
            await this._appendDeepgramSessionMarker('END', 'reason=stop_called');
            try {
                await deepgramClient.disconnect();
            } catch (err) {
                console.error('Failed to stop Deepgram stream:', err);
            }
            this.transcriptUI.removeStatusMessage();
            this._updateStatus('disconnected');
            this.deepgramTranslationQueue = Promise.resolve();
            this.lastDeepgramTranslatedText = '';
            this.deepgramLastTranslatedByGroup.clear();
            this.deepgramLatestRevisionByGroup.clear();
            this.deepgramPendingGroup = null;
            if (this.deepgramFlushTimer) {
                clearTimeout(this.deepgramFlushTimer);
                this.deepgramFlushTimer = null;
            }
            this.deepgramDebugSessionId = null;
        }

        // Keep transcript visible — don't clear
        this.transcriptUI.clearProvisional();

        // Stop TTS
        edgeTTSRust.disconnect();

        audioPlayer.stop();

        // Auto-save on stop (safety net)
        if (this.transcriptUI.hasSegments()) {
            await this._saveTranscriptFile();
        }
    }

    _updateStartButton() {
        const btn = document.getElementById('btn-start');
        const iconPlay = document.getElementById('icon-play');
        const iconStop = document.getElementById('icon-stop');
        const mode = settingsManager.get().translation_mode || 'local';
        const localBlocked = mode === 'local' && (!this.localSetupReady || this.isLocalSetupRunning) && !this.isRunning;

        btn.classList.toggle('recording', this.isRunning);
        btn.disabled = localBlocked;
        btn.title = localBlocked ? 'Setup Faster-Whisper Realtime first' : 'Start/Stop (Space)';
        iconPlay.style.display = this.isRunning ? 'none' : 'block';
        iconStop.style.display = this.isRunning ? 'block' : 'none';

        // ── New TranslaBuddy UI state updates ──
        // Switch screens
        const homeScreen = document.getElementById('screen-home');
        const transcriptScreen = document.getElementById('screen-transcript');
        if (homeScreen && transcriptScreen) {
            homeScreen.classList.toggle('active', !this.isRunning);
            transcriptScreen.classList.toggle('active', this.isRunning);
            // Also hide history/system screens and update sidebar
            if (this.isRunning) {
                document.getElementById('screen-history')?.classList.remove('active');
                document.getElementById('screen-system')?.classList.remove('active');
            }
            document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
            const activeSidebar = document.querySelector(`.sidebar-item[data-screen="${this.isRunning ? 'home' : 'home'}"]`);
            if (activeSidebar) activeSidebar.classList.add('active');
        }

        // Update button label
        const label = document.getElementById('btn-start-label');
        if (label) label.textContent = this.isRunning
            ? t(this.currentLocale, 'hero.button.stop')
            : t(this.currentLocale, 'hero.button.start');

        // Hero orb glow (old class — harmless if element gone)
        const heroOrb = document.getElementById('hero-orb');
        if (heroOrb) heroOrb.classList.toggle('recording', this.isRunning);

        // ─── Crystal Orb v2 state sync ───
        const crystalWrapper = document.getElementById('mic-trigger');
        if (crystalWrapper) crystalWrapper.classList.toggle('recording', this.isRunning);

        // Status dot
        const statusDot = document.getElementById('status-dot');
        if (statusDot) statusDot.classList.toggle('active', this.isRunning);

        // Toolbar record button pulse
        const toolbarRecord = document.getElementById('toolbar-record');
        if (toolbarRecord) toolbarRecord.classList.toggle('recording', this.isRunning);
    }

    // ─── Transcript Persistence ───────────────────────────────

    _formatDuration(ms) {
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${min}m ${sec}s`;
    }

    async _saveTranscriptFile() {
        const duration = this.recordingStartTime
            ? this._formatDuration(Date.now() - this.recordingStartTime)
            : 'unknown';

        const sourceLang = document.getElementById('select-source-lang')?.value || 'auto';
        const targetLang = document.getElementById('select-target-lang')?.value || 'vi';

        const content = this.transcriptUI.getFormattedContent({
            model: this.translationMode === 'deepgram' ? 'Deepgram Cloud' : 'Faster-Whisper Realtime',
            sourceLang,
            targetLang,
            duration,
            audioSource: this.currentSource,
        });

        if (!content) return;

        try {
            const path = await invoke('save_transcript', { content });
            const filename = path.split('/').pop();
            this._showToast(`Saved: ${filename}`, 'success');
        } catch (err) {
            console.error('Failed to save transcript:', err);
            this._showToast('Failed to save transcript', 'error');
        }
    }

    // ─── Status ────────────────────────────────────────────

    _updateStatus(status) {
        const dot = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');

        dot.className = 'status-dot';

        switch (status) {
            case 'connecting':
                dot.classList.add('connecting');
                text.textContent = t(this.currentLocale, 'status.connecting');
                break;
            case 'connected':
                dot.classList.add('connected');
                text.textContent = t(this.currentLocale, 'status.listening');
                break;
            case 'disconnected':
                dot.classList.add('disconnected');
                text.textContent = t(this.currentLocale, 'status.ready');
                break;
            case 'error':
                dot.classList.add('error');
                text.textContent = t(this.currentLocale, 'status.error');
                break;
        }
    }

    // ─── Window Position ───────────────────────────────────

    async _saveWindowPosition() {
        try {
            const factor = await this.appWindow.scaleFactor();
            const pos = await this.appWindow.outerPosition();
            const size = await this.appWindow.innerSize();
            // Save logical coordinates (physical / scaleFactor)
            localStorage.setItem('window_state', JSON.stringify({
                x: Math.round(pos.x / factor),
                y: Math.round(pos.y / factor),
                width: Math.round(size.width / factor),
                height: Math.round(size.height / factor),
            }));
        } catch (err) {
            console.error('Failed to save window position:', err);
        }
    }

    async _restoreWindowPosition() {
        try {
            const saved = localStorage.getItem('window_state');
            if (!saved) return;

            const state = JSON.parse(saved);
            const { LogicalPosition, LogicalSize } = window.__TAURI__.window;

            // Validate — don't restore if position seems off-screen
            if (state.x < -100 || state.y < -100 || state.x > 5000 || state.y > 3000) {
                console.warn('Saved window position looks off-screen, skipping restore');
                localStorage.removeItem('window_state');
                return;
            }

            const minPreferredWidth = 980;
            const minPreferredHeight = 680;
            if (state.width && state.height && state.width >= 300 && state.height >= 100) {
                await this.appWindow.setSize(new LogicalSize(
                    Math.max(state.width, minPreferredWidth),
                    Math.max(state.height, minPreferredHeight),
                ));
            }
            if (state.x !== undefined && state.y !== undefined) {
                await this.appWindow.setPosition(new LogicalPosition(state.x, state.y));
            }
        } catch (err) {
            console.error('Failed to restore window position:', err);
            localStorage.removeItem('window_state');
        }
    }

    // ─── Pin / Unpin (Always on Top) ────────────────────

    async _togglePin() {
        this.isPinned = !this.isPinned;
        await this.appWindow.setAlwaysOnTop(this.isPinned);
        const btn = document.getElementById('btn-pin');
        if (btn) btn.classList.toggle('active', this.isPinned);
        this._showToast(this.isPinned ? 'Pinned on top' : 'Unpinned — window can go behind other apps', 'success');
    }

    // ─── Compact Mode (removed) ───────────────────

    _toggleCompact() {
        // Legacy — compact mode removed in new UI
    }

    _toggleViewMode() {
        const isDual = this.transcriptUI.viewMode === 'dual';
        const newMode = isDual ? 'single' : 'dual';
        this.transcriptUI.configure({ viewMode: newMode });
        document.querySelectorAll('input[name="display-view-mode"]').forEach((input) => {
            input.checked = input.value === newMode;
        });
        this._persistSettingsPatch({ view_mode: newMode }).catch((err) => {
            console.error('[Settings] Failed to save view mode:', err);
        });
        const btn = document.getElementById('btn-view-mode');
        if (btn) btn.classList.toggle('active', newMode === 'dual');
    }

    async _openExternalUrl(url) {
        try {
            if (typeof tauriOpener.openUrl === 'function') {
                await tauriOpener.openUrl(url);
                return;
            }
            window.open(url, '_blank', 'noopener,noreferrer');
        } catch (err) {
            console.error('[App] Failed to open external URL:', err);
            this._showToast('Không thể mở liên kết ngoài.', 'error');
        }
    }

    _adjustFontSize(delta) {
        const current = this.transcriptUI.fontSize || 16;
        const newSize = Math.max(12, Math.min(140, current + delta));
        this.transcriptUI.configure({ fontSize: newSize });

        // Update display
        const display = document.getElementById('font-size-display');
        if (display) display.textContent = newSize;

        // Sync with settings slider
        const slider = document.getElementById('range-font-size');
        if (slider) slider.value = newSize;
        const sliderVal = document.getElementById('font-size-value');
        if (sliderVal) sliderVal.textContent = `${newSize}px`;
        this._persistSettingsPatch({ font_size: newSize }).catch((err) => {
            console.error('[Settings] Failed to save font size:', err);
        });
    }

    // ─── Toast ─────────────────────────────────────────────

    async _checkForUpdates() {
        updater.onUpdateFound = (version, notes) => {
            this._onUpdateAvailable(version, notes);
        };
        updater.onError = (err) => {
            const statusText = document.getElementById('update-status-text');
            if (statusText) statusText.textContent = `⚠️ Check failed: ${err.message || err}`;
        };
        updater.onCheckComplete = (hasUpdate) => {
            const checkBtn = document.getElementById('btn-check-update');
            if (checkBtn) checkBtn.classList.remove('spinning');
            if (!hasUpdate && !this._pendingUpdateVersion) {
                const statusText = document.getElementById('update-status-text');
                if (statusText) statusText.textContent = '✅ App is up to date';
            }
        };
        // Delay check slightly so app finishes loading first
        setTimeout(() => {
            const statusText = document.getElementById('update-status-text');
            const checkBtn = document.getElementById('btn-check-update');
            if (statusText) statusText.textContent = 'Checking for updates...';
            if (checkBtn) checkBtn.classList.add('spinning');
            updater.checkForUpdates();
        }, 3000);
    }

    _onUpdateAvailable(version, notes) {
        this._pendingUpdateVersion = version;

        const badge = document.getElementById('settings-badge');
        if (badge) badge.style.display = '';
        this._showToast(`Có bản cập nhật v${version} khả dụng`, 'info');
    }

    _showToast(message, type = 'success') {
        // Remove existing toast
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // Auto-remove (longer for errors)
        const duration = type === 'error' ? 5000 : 3000;
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
}

// Initialize app once. This supports both normal module loading and delayed dynamic import.
const bootApp = () => {
    if (window.__TB_APP_BOOTED) return;
    window.__TB_APP_BOOTED = true;

    let app;
    try {
        app = new App();
    } catch (err) {
        window.__TB_INIT_STAGE = 'failed_construct';
        window.__TB_INIT_ERROR = err?.message || `${err}`;
        console.error('[App] constructor failed:', err);
        window.__TB_SHOW_RUNTIME_ERROR?.(window.__TB_INIT_ERROR);
        return;
    }

    window.__TB_APP_INSTANCE = app;
    app.init().catch((err) => {
        window.__TB_INIT_STAGE = 'failed';
        window.__TB_INIT_ERROR = err?.message || `${err}`;
        console.error('[App] init failed:', err);
        const message = err?.message || `${err}`;
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = 'toast error show';
        toast.textContent = `Init failed: ${message}`;
        document.body.appendChild(toast);
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootApp, { once: true });
} else {
    bootApp();
}
