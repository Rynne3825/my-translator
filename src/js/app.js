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
import { t } from './i18n.js';
import { createInitialAppState } from './app-state.js';
import { appDeepgramMethods } from './app/methods/app-deepgram-methods.js';
import { appLocalMethods } from './app/methods/app-local-methods.js';
import { appSettingsMethods } from './app/methods/app-settings-methods.js';
import { createFallbackWindowHandle, getCurrentWindow, invoke } from './tauri-compat.js';

export class App {
    constructor() {
        this.appWindow = getCurrentWindow ? getCurrentWindow() : createFallbackWindowHandle();
        Object.assign(this, createInitialAppState());
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

Object.assign(App.prototype, appSettingsMethods);
Object.assign(App.prototype, appLocalMethods);
Object.assign(App.prototype, appDeepgramMethods);

