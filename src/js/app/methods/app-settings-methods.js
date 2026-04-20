import { settingsManager } from '../../settings.js';
import { edgeTTSRust } from '../../edge-tts.js';
import { audioPlayer } from '../../audio-player.js';
import { applyI18n, t } from '../../i18n.js';

export const appSettingsMethods = {
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
    },

    _openSettingsPanel(panelTab = 'panel-stt') {
        const appLayout = document.getElementById('app-layout');
        if (appLayout) appLayout.classList.add('panel-open');
        this._activatePanelTab(panelTab);
        this._populateSettingsForm();
    },

    _closeSettingsPanel() {
        const appLayout = document.getElementById('app-layout');
        if (appLayout) appLayout.classList.remove('panel-open');
    },

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
    },

    _showView(view) {
        if (view === 'settings') {
            this._openSettingsPanel('panel-stt');
        } else {
            this._closeSettingsPanel();
        }
        const overlayView = document.getElementById('overlay-view');
        if (overlayView) overlayView.classList.remove('active');
    },

    _resolveTheme(mode) {
        if (mode === 'system') {
            return this.systemThemeMedia?.matches ? 'dark' : 'light';
        }
        return mode === 'light' ? 'light' : 'dark';
    },

    _syncThemeButtons(mode) {
        document.querySelectorAll('.theme-mode-btn[data-theme]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.theme === mode);
        });
    },

    _syncAccentButtons(preset) {
        document.querySelectorAll('.accent-swatch[data-accent-preset]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.accentPreset === preset);
        });
    },

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
    },

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
    },

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
    },

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
    },

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
    },

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
    },

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
    },

    async _persistSettingsPatch(partial) {
        this._updateSaveIndicator('saving');
        try {
            await settingsManager.save(partial);
            this._updateSaveIndicator('saved');
        } catch (err) {
            this._updateSaveIndicator('error');
            throw err;
        }
    },

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
    },

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
    },

    _getActiveTTS() {
        return edgeTTSRust;
    },

    _configureTTS(tts, settings) {
        tts.configure({
            voice: settings.edge_tts_voice || 'vi-VN-HoaiMyNeural',
            speed: settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20,
        });
    },

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
    },

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
    },

    _escAttr(str) {
        return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

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
    },

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
    },

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
    },

    _speakIfEnabled(text) {
        if (this.ttsEnabled && text?.trim()) {
            this._getActiveTTS().speak(text);
        }
    },
};
