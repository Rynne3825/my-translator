import { settingsManager } from '../../settings.js';
import { deepgramClient } from '../../deepgram.js';
import { invoke } from '../../tauri-compat.js';
import {
    deepgramTextHasExplicitSentenceBoundary,
    deepgramTextHasSentenceBoundary,
    deepgramTextIsLongEnough,
    isDeepgramContinuousPair,
    isDeepgramMultilingualSupportedLanguage,
    isDeepgramStrictSentencePair,
    isDeepgramTwoWayMode,
    mergeDeepgramGroupText,
    normalizeLanguageCode,
    resolveDeepgramDirection,
    resolveDeepgramEndpointDelay,
} from '../../deepgram-utils.js';

export const appDeepgramMethods = {
    async _startDeepgramMode(settings) {
        console.log('[App] Connecting to Deepgram...');
        this._updateStatus('connecting');

        // New Deepgram run/session marker.
        // Transcript UI is preserved across Stop, so groupIds must remain unique
        // across multiple connect cycles to avoid overwriting older rows.
        this.deepgramSessionId = (Number(this.deepgramSessionId) || 0) + 1;

        this.deepgramDebugSessionId = this._newDeepgramDebugSessionId();
        await this._appendDeepgramSessionMarker(
            'START',
            `source=${this.currentSource} source_lang=${settings.source_language || 'auto'} target_lang=${settings.target_language || 'vi'}`,
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

        try {
            await this._ensureDeepgramTranslationReady(settings);
            const deepgramSourceLanguage = this._isDeepgramTwoWayMode(settings)
                ? 'auto'
                : settings.source_language;
            await invoke('append_deepgram_log', {
                message: `ui_before_connect session=${this.deepgramDebugSessionId || 'n/a'} source=${this.currentSource} settings_source_lang=${settings.source_language} deepgram_source_lang=${deepgramSourceLanguage} endpoint_delay=${effectiveEndpointDelay}`,
            }).catch(() => {});
            await Promise.race([
                deepgramClient.connect({
                    sourceLanguage: deepgramSourceLanguage,
                    endpointDelay: effectiveEndpointDelay,
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
},

    _newDeepgramDebugSessionId() {
        const now = Date.now().toString(36);
        const rand = Math.random().toString(36).slice(2, 8);
        return `dg-ui-${now}-${rand}`;
},

    async _appendDeepgramSessionMarker(stage, details = '') {
        const session = this.deepgramDebugSessionId || 'n/a';
        const suffix = details ? ` ${details}` : '';
        await invoke('append_deepgram_log', {
            message: `=== UI_SESSION_${stage} session=${session}${suffix} ===`,
        }).catch(() => {});
},

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
},

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
        const pendingUtterance = this.deepgramPendingGroup?.utteranceIds?.[0] || '';
        const nextUtterance = this._getDeepgramUtteranceKey(meta);
        const utteranceChangedOnOriginal = Boolean(
            this.deepgramPendingGroup
            && pendingUtterance
            && nextUtterance
            && pendingUtterance !== nextUtterance
        );
        if (utteranceChangedOnOriginal) {
            await invoke('append_deepgram_log', {
                message: `group=${this.deepgramPendingGroup?.id || 'n/a'} forcing_commit reason=original_utterance_changed prev_utterance=${pendingUtterance} next_utterance=${nextUtterance}`,
            }).catch(() => {});
            await this._commitDeepgramPendingGroup('original_utterance_changed');
        }
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

        const sessionId = Number(this.deepgramSessionId) || 0;

        const group = canReusePending
            ? this.deepgramPendingGroup
            : {
                id: `dg-${sessionId}-${++this.deepgramGroupCounter}`,
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

        this.transcriptUI.commitProvisionalGroup(
            group.id,
            group.text,
            group.speaker,
            group.language,
            { confidence: meta?.confidence ?? null },
        );

        // Always finalize an "original" event as its own row.
        // Keeping it pending until later boundaries can overwrite the row with
        // the next chunk, which looks like untranslated text disappearing.
        const finalDecision = decision.shouldTranslate
            ? {
                ...decision,
                closesGroup: true,
                reason: `${decision.reason}_original_final`,
            }
            : {
                ...decision,
                shouldTranslate: true,
                closesGroup: true,
                reason: `${decision.reason}_original_force`,
            };

        if (!decision.shouldTranslate) {
            await invoke('append_deepgram_log', {
                message: `group=${group.id} forcing_translation_on_original reason=${decision.reason}`,
            }).catch(() => {});
        }

        this.deepgramPendingGroup = null;
        if (this.deepgramFlushTimer) {
            clearTimeout(this.deepgramFlushTimer);
            this.deepgramFlushTimer = null;
        }
        await this._translateDeepgramGroup({
            ...group,
            utteranceIds: [...group.utteranceIds],
        }, finalDecision);
},

    async _handleDeepgramProvisional(text, speaker, language, meta = {}) {
        const normalizedText = text?.trim();
        const effectiveLanguage = language || settingsManager.get().source_language || 'auto';
        const strictSentencePair = this._isDeepgramStrictSentencePair(effectiveLanguage);
        const sessionId = Number(this.deepgramSessionId) || 0;
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
                id: `dg-${sessionId}-${++this.deepgramGroupCounter}`,
                text: '',
                speaker: speaker ?? null,
                language: language || null,
                utteranceIds: [],
                sttWallMs: null,
                lastTranslatedSourceText: '',
                revision: 0,
                speechFinal: false,
                isFinal: false,
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
        group.isFinal = Boolean(meta?.is_final);
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
},

    _resetDeepgramEventStats() {
        this.deepgramEventStats = {
            provisionalCount: 0,
            originalCount: 0,
            lastProvisionalAt: 0,
            lastOriginalAt: 0,
            lastProvisionalText: '',
            lastOriginalText: '',
        };
},

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
},

    _getDeepgramUtteranceKey(meta = {}) {
        const id = meta?.utterance_id;
        if (id === undefined || id === null) {
            return '';
        }
        return String(id);
},

    _canAppendToDeepgramGroup(speaker, language, meta = {}) {
        if (!this.deepgramPendingGroup) {
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
            return false;
        }
        return true;
},

    async _rolloverDeepgramPendingGroupIfNeeded(speaker, language, meta = {}) {
        const pending = this.deepgramPendingGroup;
        if (!pending?.text?.trim()) {
            return;
        }
        const nextUtterance = this._getDeepgramUtteranceKey(meta);
        const currentUtterance = pending.utteranceIds?.[0] || '';
        const sameLanguage = (pending.language || null) === (language || null);
        if (!sameLanguage) {
            return;
        }
        if (!currentUtterance || !nextUtterance || currentUtterance === nextUtterance) {
            return;
        }
        await this._commitDeepgramPendingGroup('utterance_rollover');
},

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
        if (
            (reason === 'utterance_rollover' || reason === 'group_split')
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
},

    _mergeDeepgramGroupText(existingText, nextText) {
        return mergeDeepgramGroupText(existingText, nextText);
},

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
},

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
},

    _deepgramTextHasExplicitSentenceBoundary(text) {
        return deepgramTextHasExplicitSentenceBoundary(text);
},

    _deepgramTextHasSentenceBoundary(text, language) {
        return deepgramTextHasSentenceBoundary(text, language);
},

    _deepgramTextIsLongEnough(text, language) {
        return deepgramTextIsLongEnough(text, language);
},

    _isDeepgramContinuousPair(sourceLanguage, targetLanguage) {
        return isDeepgramContinuousPair(sourceLanguage, targetLanguage);
},

    _isDeepgramStrictSentencePair(sourceLanguage) {
        return isDeepgramStrictSentencePair(sourceLanguage);
},

    _normalizeLanguageCode(code) {
        return normalizeLanguageCode(code);
},

    _isDeepgramMultilingualSupportedLanguage(code) {
        return isDeepgramMultilingualSupportedLanguage(code);
},

    _isDeepgramTwoWayMode(settings = settingsManager.get()) {
        return isDeepgramTwoWayMode(settings);
},

    _resolveDeepgramDirection(sourceLanguage, settings = settingsManager.get()) {
        return resolveDeepgramDirection(sourceLanguage, settings);
    },

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
    },

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
    },

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
},

    _resolveDeepgramEndpointDelay(settings) {
        return resolveDeepgramEndpointDelay(settings);
},

    _shouldTranslateDeepgramGroup(group, sourceLanguage, targetLanguage) {
        const text = (group?.text || '').trim();
        if (!text) {
            return { shouldTranslate: false, reason: 'empty_text' };
        }
        const hasExplicitBoundary = this._deepgramTextHasExplicitSentenceBoundary(text);
        const hasSentenceBoundary = this._deepgramTextHasSentenceBoundary(text, sourceLanguage);
        const isLongEnough = this._deepgramTextIsLongEnough(text, sourceLanguage);
        const speechFinal = Boolean(group?.speechFinal);
        const isFinal = Boolean(group?.isFinal);

        if (!sourceLanguage || sourceLanguage === 'auto') {
            return { shouldTranslate: false, reason: 'source_unresolved' };
        }
        if (sourceLanguage === targetLanguage) {
            return { shouldTranslate: true, reason: 'same_language' };
        }

        if (speechFinal) {
            return { shouldTranslate: true, reason: 'speech_final', closesGroup: true };
        }
        if (isFinal && isLongEnough) {
            return { shouldTranslate: true, reason: 'deepgram_final', closesGroup: true };
        }

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
},

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
},

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
    },
};
