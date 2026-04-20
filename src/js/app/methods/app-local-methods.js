import { settingsManager } from '../../settings.js';
import { audioPlayer } from '../../audio-player.js';
import { invoke } from '../../tauri-compat.js';
import {
    extractCompletedSentences,
    localTextHasTerminalBoundary,
    localTextLooksIncomplete,
    normalizeLocalTranscriptForDedupe,
    shouldSuppressLocalProvisionalPreview,
} from '../../local-transcript-utils.js';

export const appLocalMethods = {
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
},

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
    },

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
},

    async _startLocalMode(settings) {
        console.log('[App] Starting Faster-Whisper realtime local mode...');
        this._updateStatus('connecting');

        // New local run/session marker.
        // Local pipeline utterance IDs can restart from low numbers on each Start,
        // while the transcript UI is intentionally preserved across Stop.
        // Without a session prefix, groupIds can collide and overwrite older rows.
        this.localSessionId = (Number(this.localSessionId) || 0) + 1;

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
},

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
},

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
},

    _extractCompletedSentences(text, language) {
        return extractCompletedSentences(text, language);
},

    _normalizeLocalTranscriptForDedupe(text, language) {
        return normalizeLocalTranscriptForDedupe(text, language);
},

    _pruneLocalCommittedGroups(now = Date.now()) {
        const dedupeWindowMs = 15000;
        this.localRecentCommittedGroups = this.localRecentCommittedGroups
            .filter(item => (now - item.at) <= dedupeWindowMs)
            .slice(-24);
},

    _getLocalSegmentByGroupId(groupId) {
        return this.transcriptUI?.segments?.find(seg => seg.groupId === groupId) || null;
},

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
},

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
                    // Keep prior untranslated row intact. Replacing the older group
                    // with a newer superset makes users feel the earlier STT row
                    // disappeared before translation arrived.
                    continue;
                }
            }
        }

        return { skip: false, normalized };
},

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
},

    _localTextHasTerminalBoundary(text) {
        return localTextHasTerminalBoundary(text);
},

    _localTextLooksIncomplete(text, language) {
        return localTextLooksIncomplete(text, language);
},

    _clearLocalCarryOverTimeout() {
        if (this.localCarryOverTimeout) {
            clearTimeout(this.localCarryOverTimeout);
            this.localCarryOverTimeout = null;
        }
},

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
},

    _ensureLocalSentenceTrackingState(state) {
        if (!state.sentenceCandidates) {
            state.sentenceCandidates = new Map();
        }
        return state;
},

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
},

    _shouldSuppressLocalProvisionalPreview(text, revision, language) {
        return shouldSuppressLocalProvisionalPreview(text, revision, language);
},

    _handleLocalTranscriptChunk({ utteranceId, revision, text, language, speaker, confidence, isFinal }) {
        const sessionId = Number(this.localSessionId) || 0;
        const baseId = `fw-${sessionId}-${utteranceId || Date.now()}`;
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
        const tailGroupId = carryOverGroupId || `${baseId}-tail`;
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
            // If the current tail groupId is re-used for a committed sentence (common with carry-over),
            // do NOT delete it later during tail cleanup.
            if (sentenceGroupId === tailGroupId) {
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
},

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
},

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
},

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
},

    _normalizeLocalModel(model) {
        return model === 'large-v3' ? 'large-v3' : 'turbo';
},

    _buildLocalPipelineConfig(settings, promptConfig) {
        return {
            sourceLang: settings.source_language || 'auto',
            targetLang: settings.target_language || 'vi',
            localModel: this._normalizeLocalModel(settings.local_model || 'turbo'),
            initialPrompt: promptConfig?.initialPrompt || null,
            hotwords: Array.isArray(promptConfig?.hotwords) ? [...promptConfig.hotwords] : [],
        };
},

    _canReuseLocalPipeline(nextConfig) {
        if (!this.localPipelineReady || this.localPipelineClosed || !this.localPipelineConfig) {
            return false;
        }
        return JSON.stringify(this.localPipelineConfig) === JSON.stringify(nextConfig);
},

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
    },


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
    },
};
