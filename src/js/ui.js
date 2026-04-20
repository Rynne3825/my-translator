import { transcriptRenderMethods } from './transcript-renderer.js';

export class TranscriptUI {
    constructor(container) {
        this.container = container;
        this.contentEl = null;
        this.singleListEl = null;
        this.dualListEl = null;
        this.statusEl = null;
        this.maxChars = 1200;
        this.fontSize = 16;
        this.viewMode = 'single';
        this.segments = [];
        this.pendingTranslations = new Map();
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.provisionalPendingClear = false;
        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.lastConfidence = null;

        // Typed translation state for crossfade effect
        this._segTransTypewriters = new Map(); // segKey -> { phase, originalDisplayed, translationDisplayed, target, queue, timerId }
        this._elementAnimations = new WeakMap();
        this.typewriterTickMs = 10;
        this.typewriterStepLarge = 5;
        this.typewriterStepMedium = 3;
        this.typewriterLargeThreshold = 24;
        this.typewriterMediumThreshold = 10;
    }

    configure({ maxLines, showOriginal, fontSize, fontColor, viewMode }) {
        if (maxLines !== undefined) this.maxChars = maxLines * 160;
        if (fontSize !== undefined) {
            this.fontSize = fontSize;
            this.container.style.setProperty('--transcript-font-size', `${fontSize}px`);
        }
        if (fontColor !== undefined) {
            this.fontColor = fontColor;
            this.container.style.setProperty('--transcript-font-color', fontColor);
        }
        if (viewMode !== undefined) {
            this.viewMode = viewMode;
            const overlay = document.getElementById('overlay-view');
            if (overlay) {
                overlay.classList.toggle('dual-view', viewMode === 'dual');
            }
        }
        this._render();
    }

    addOriginal(text, speaker, language) {
        this._removeListening();
        this.segments.push({
            original: text,
            translation: null,
            status: 'original',
            speaker: speaker || null,
            language: language || null,
            confidence: this.lastConfidence,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            groupId: null,
        });
        if (speaker) this.currentSpeaker = speaker;
        if (language) this.currentLanguage = language;
        this._cleanupStaleOriginals();
        this._render();
    }

    addTranslation(text, options = {}) {
        const groupId = options?.groupId || null;
        const seg = groupId
            ? this.segments.find((s) => s.groupId === groupId)
            : this.segments.find((s) => s.status === 'original');
        if (seg) {
            const nextTranslation = text || '';
            const nextStatus = 'translated';
            if (seg.translation === nextTranslation && seg.status === nextStatus) {
                return;
            }
            seg.translation = nextTranslation;
            seg.status = nextStatus;
            seg.updatedAt = Date.now();
        } else {
            if (groupId) {
                const existingPending = this.pendingTranslations.get(groupId);
                if (existingPending?.text === text) {
                    return;
                }
                this.pendingTranslations.set(groupId, {
                    text,
                    updatedAt: Date.now(),
                });
                return;
            }
            this.segments.push({
                original: '',
                translation: text,
                status: 'translated',
                speaker: null,
                language: null,
                confidence: this.lastConfidence,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                groupId,
            });
        }
        this._render();
    }

    upsertTranslationGroup(groupId, text, speaker, language, options) {
        this.addTranslation(text, { groupId });
    }

    upsertOriginalGroup(groupId, text, speaker, language, options = {}) {
        this._removeListening();
        const { changed } = this._upsertOriginalGroupRecord(groupId, text, speaker, language, options);
        if (speaker) this.currentSpeaker = speaker;
        if (language) this.currentLanguage = language;
        this._cleanupStaleOriginals();
        if (changed) {
            this._render();
        }
    }

    commitProvisionalGroup(groupId, text, speaker, language, options = {}) {
        this._removeListening();
        this._resetProvisionalState();
        this._upsertOriginalGroupRecord(groupId, text, speaker, language, options);

        if (speaker) this.currentSpeaker = speaker;
        if (language) this.currentLanguage = language;
        this._cleanupStaleOriginals();
        this._render();
    }

    removeGroup(groupId) {
        if (!groupId) return;
        this.pendingTranslations.delete(groupId);
        const idx = this.segments.findIndex((seg) => seg.groupId === groupId);
        if (idx === -1) return;
        this.segments.splice(idx, 1);
        this._clearTypewritersByPrefix(`group-${groupId}:`);
        this._render();
    }

    setProvisional(text, speaker, language) {
        this._removeListening();
        this.provisionalText = text || '';
        this.provisionalSpeaker = speaker || null;
        this.provisionalLanguage = language || null;
        this.provisionalPendingClear = false;
        this._refreshProvisionalLayer();
    }

    clearProvisional() {
        this._resetProvisionalState();
        this._refreshProvisionalLayer();
    }

    hasContent() {
        return this.segments.length > 0 || this.provisionalText || !!this.container.querySelector('.listening-indicator');
    }

    showPlaceholder() {
        this.container.innerHTML = `
      <div class="transcript-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
        <p>Press ▶ to start translating</p>
        <p class="shortcut-hint">⌘ Enter</p>
      </div>
    `;
        this.segments = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.lastConfidence = null;
        this.pendingTranslations.clear();
        this._resetProvisionalState();
        this._clearAllSegTypewriters();
        this.contentEl = null;
        this.singleListEl = null;
        this.dualListEl = null;
        this.statusEl = null;
    }

    showListening() {
        this.container.querySelectorAll('.listening-indicator').forEach((el) => el.remove());
        const placeholder = this.container.querySelector('.transcript-placeholder');
        if (placeholder) placeholder.remove();
        this._ensureContentRoot();
        const indicator = document.createElement('div');
        indicator.className = 'listening-indicator';
        indicator.innerHTML = `
            <div class="listening-waves">
                <span></span><span></span><span></span><span></span><span></span>
            </div>
            <p>Listening...</p>
        `;
        this.contentEl.appendChild(indicator);
    }

    showStatusMessage(message) {
        this._ensureContentRoot();
        if (!this.statusEl) {
            this.statusEl = document.createElement('div');
            this.statusEl.className = 'pipeline-status';
            this.contentEl.prepend(this.statusEl);
        }
        this.statusEl.textContent = message;
    }

    removeStatusMessage() {
        if (this.statusEl) {
            this.statusEl.remove();
            this.statusEl = null;
        }
    }

    getPlainText() {
        const lines = [];
        for (const seg of this.segments) {
            if (seg.original) lines.push(seg.original);
            if (seg.translation) lines.push(seg.translation);
            if (seg.original || seg.translation) lines.push('');
        }
        if (this.provisionalText) {
            lines.push(this.provisionalText);
        }
        return lines.join('\n').trim();
    }

    getFormattedContent(metadata = {}) {
        if (this.segments.length === 0) return null;
        const lines = [];
        lines.push('---');
        lines.push(`date: ${new Date().toISOString()}`);
        if (metadata.model) lines.push(`model: ${metadata.model}`);
        if (metadata.sourceLang) lines.push(`source_language: ${metadata.sourceLang}`);
        if (metadata.targetLang) lines.push(`target_language: ${metadata.targetLang}`);
        if (metadata.duration) lines.push(`recording_duration: ${metadata.duration}`);
        if (metadata.audioSource) lines.push(`audio_source: ${metadata.audioSource}`);
        lines.push(`segments: ${this.segments.length}`);
        lines.push('---');
        lines.push('');
        for (const seg of this.segments) {
            if (seg.original) lines.push(`> ${seg.original}`);
            if (seg.translation) lines.push(seg.translation);
            lines.push('');
        }
        return lines.join('\n').trim();
    }

    hasSegments() {
        return this.segments.length > 0;
    }

    clear() {
        this.container.innerHTML = '';
        this.segments = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.lastConfidence = null;
        this.pendingTranslations.clear();
        this._resetProvisionalState();
        this._clearAllSegTypewriters();
        this.contentEl = null;
        this.singleListEl = null;
        this.dualListEl = null;
        this.statusEl = null;
    }

    setLocale(locale) {
        this.currentLocale = locale;
    }

    _t(key) {
        return key;
    }

    setConfidence(confidence) {
        this.lastConfidence = confidence;
    }

    _ensureContentRoot() {
        if (!this.contentEl) {
            this.container.innerHTML = '';
            this.contentEl = document.createElement('div');
            this.contentEl.className = 'transcript-flow';
            this.container.appendChild(this.contentEl);
        }
    }

    _upsertOriginalGroupRecord(groupId, text, speaker, language, options = {}) {
        const existing = this.segments.find((seg) => seg.groupId === groupId);
        let changed = false;
        if (existing) {
            const nextOriginal = text;
            const nextStatus = existing.translation ? 'translated' : 'original';
            const nextSpeaker = speaker || existing.speaker || null;
            const nextLanguage = language || existing.language || null;
            const nextConfidence = options.confidence ?? existing.confidence ?? this.lastConfidence;

            changed = (
                existing.original !== nextOriginal
                || existing.status !== nextStatus
                || existing.speaker !== nextSpeaker
                || existing.language !== nextLanguage
                || existing.confidence !== nextConfidence
            );

            if (changed) {
                existing.original = nextOriginal;
                existing.status = nextStatus;
                existing.speaker = nextSpeaker;
                existing.language = nextLanguage;
                existing.confidence = nextConfidence;
                existing.updatedAt = Date.now();
            }
        } else {
            this.segments.push({
                original: text,
                translation: null,
                status: 'original',
                speaker: speaker || null,
                language: language || null,
                confidence: options.confidence ?? this.lastConfidence,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                groupId,
            });
            changed = true;
        }
        const target = this.segments.find((seg) => seg.groupId === groupId);
        const pendingTranslation = groupId ? this.pendingTranslations.get(groupId) : null;
        if (
            target
            && pendingTranslation?.text?.trim()
            && (target.translation !== pendingTranslation.text || target.status !== 'translated')
        ) {
            target.translation = pendingTranslation.text;
            target.status = 'translated';
            target.updatedAt = pendingTranslation.updatedAt || Date.now();
            this.pendingTranslations.delete(groupId);
            changed = true;
        } else if (
            target
            && pendingTranslation?.text?.trim()
            && target.translation === pendingTranslation.text
            && target.status === 'translated'
        ) {
            this.pendingTranslations.delete(groupId);
        }
        return { segment: target || null, changed };
    }

    _ensureSingleRoot() {
        this._ensureContentRoot();
        if (!this.singleListEl || !this.singleListEl.isConnected) {
            this.contentEl.className = 'transcript-flow transcript-flow-single';
            this.contentEl.querySelectorAll('.transcript-list, .transcript-dual-list').forEach((el) => el.remove());
            this.singleListEl = document.createElement('div');
            this.singleListEl.className = 'transcript-list';
            this.contentEl.appendChild(this.singleListEl);
            this.dualListEl = null;
        }
    }

    _ensureDualRoot() {
        this._ensureContentRoot();
        if (!this.dualListEl || !this.dualListEl.isConnected) {
            this.contentEl.className = 'transcript-flow transcript-flow-dual';
            this.contentEl.querySelectorAll('.transcript-list, .transcript-dual-list').forEach((el) => el.remove());
            this.dualListEl = document.createElement('div');
            this.dualListEl.className = 'transcript-dual-list';
            this.contentEl.appendChild(this.dualListEl);
            this.singleListEl = null;
        }
    }

    _removeListening() {
        const indicator = this.container.querySelector('.listening-indicator');
        if (indicator) indicator.remove();
    }

    _render() {
        this._trimSegments();
        if (this.viewMode === 'dual') {
            this._renderDual();
        } else {
            this._renderSingle();
        }
    }

    _renderSingle() {
        this._ensureSingleRoot();
        const scrollHost = this.container.parentElement || this.container;
        const scrollState = this._getScrollState(scrollHost);
        const desiredKeys = [];
        let lastLang = null;

        this.segments.forEach((seg, index) => {
            const key = this._segmentKey(seg, index);
            desiredKeys.push(key);
            const node = this._ensureSegmentNode(this.singleListEl, key, 'seg-item');
            const showLanguage = !!(seg.language && seg.language !== lastLang);
            this._renderSingleSegmentNode(node, seg, { showSpeaker: false, showLanguage }, key);
            lastLang = seg.language || lastLang;
        });

        this._pruneNodes(this.singleListEl, '.seg-item', desiredKeys);
        this._syncSingleProvisionalNode(null, lastLang);
        this._restoreScroll(scrollHost, scrollState);
    }

    _renderDual() {
        this._ensureDualRoot();
        const scrollHost = this.container.parentElement || this.container;
        const scrollState = this._getScrollState(scrollHost);
        const desiredKeys = [];
        let lastLang = null;

        this.segments.forEach((seg, index) => {
            const key = this._segmentKey(seg, index);
            desiredKeys.push(key);
            const showLanguage = !!(seg.language && seg.language !== lastLang);
            const rowNode = this._ensureSegmentNode(this.dualListEl, key, 'seg-dual-row');
            this._syncMetaNode(rowNode, '', 'speaker-label');
            this._syncMetaNode(rowNode, showLanguage ? this._langEmoji(seg.language) : '', 'lang-badge');
            const sourceNode = this._ensureChild(rowNode, 'div', 'seg-cell seg-cell-source');
            const targetNode = this._ensureChild(rowNode, 'div', 'seg-cell seg-cell-target');
            this._renderDualSourceNode(sourceNode, seg, key);
            this._renderDualTargetNode(targetNode, seg, key);
            lastLang = seg.language || lastLang;
        });

        this._pruneNodes(this.dualListEl, '.seg-dual-row', desiredKeys);
        this._syncDualProvisionalNode(null, lastLang);
        this._restoreScroll(scrollHost, scrollState);
    }

    _getDisplayedOriginal(seg, key) {
        return seg.original || '';
    }

    _isSegTyping(key) {
        return false;
    }

    _renderSingleSegmentNode(node, seg, flags, key) {
        node.classList.toggle('translated', seg.status === 'translated' && !!seg.translation);
        node.classList.toggle('pending', seg.status !== 'translated' || !seg.translation);
        this._syncMetaNode(node, '', 'speaker-label');
        this._syncMetaNode(node, flags.showLanguage ? this._langEmoji(seg.language) : '', 'lang-badge');

        let block = node.querySelector('.seg-block');
        if (!block) {
            block = document.createElement('div');
            block.className = 'seg-block';
            node.appendChild(block);
        }

        const displayedOriginal = this._getDisplayedOriginal(seg, key);

        if (seg.status === 'translated' && seg.translation) {
            this._clearTypewritersByPrefix(`${key}:`);
            block.classList.remove('provisional-live');
            const original = this._ensureChild(block, 'div', 'seg-original-final');
            const translated = this._ensureChild(block, 'div', 'seg-translated');
            this._setText(original, seg.original || '');
            this._setText(translated, seg.translation);
            this._toggleClassByConfidence(translated, seg.confidence);
            this._animateOnTextChange(translated, seg.translation, 'translation-appear');
            block.querySelectorAll('.seg-original.pending, .seg-provisional, .typewriter-caret').forEach((el) => el.remove());
        } else {
            block.classList.remove('translation-appear');
            block.querySelectorAll('.seg-original-final, .seg-translated').forEach((el) => el.remove());
            const original = this._ensureChild(block, 'div', 'seg-original pending');
            this._setTypewriterText(original, displayedOriginal, `${key}:single-source`, { showCaret: true });
            this._toggleClassByConfidence(original, seg.confidence);
        }
    }

    _renderDualSourceNode(node, seg, key) {
        node.style.display = '';
        this._syncMetaNode(node, '', 'speaker-label');
        this._syncMetaNode(node, '', 'lang-badge');
        const displayedOriginal = this._getDisplayedOriginal(seg, key);
        const isTranslated = seg.status === 'translated' && !!seg.translation;
        const textEl = this._ensureChild(node, 'div', isTranslated ? 'seg-text' : 'seg-text pending');
        textEl.className = isTranslated ? 'seg-text' : 'seg-text pending';
        if (isTranslated) {
            this._clearTypewriter(`${key}:source`);
            this._setText(textEl, displayedOriginal);
            textEl.querySelectorAll('.typewriter-caret').forEach((c) => c.remove());
        } else {
            this._setTypewriterText(textEl, displayedOriginal, `${key}:source`, { showCaret: true });
        }
        this._toggleClassByConfidence(textEl, seg.confidence);
    }

    _renderDualTargetNode(node, seg, key) {
        if (seg.status === 'translated' && seg.translation) {
            this._clearTypewriter(`${key}:target`);
            const textEl = this._ensureChild(node, 'div', 'seg-text seg-translated');
            textEl.className = 'seg-text seg-translated';

            node.querySelectorAll('.seg-text.seg-pending-translation').forEach(el => el.remove());

            this._setText(textEl, seg.translation);
            this._toggleClassByConfidence(textEl, seg.confidence);
            this._animateOnTextChange(textEl, seg.translation, 'translation-appear');
        } else if (seg.status === 'original' && seg.original) {
            node.querySelectorAll('.seg-text.seg-translated').forEach(el => el.remove());
            this._renderPendingTranslation(node, seg.original, `${key}:target`);
        } else {
            this._clearTypewriter(`${key}:target`);
            node.querySelectorAll('.seg-text').forEach((el) => el.remove());
        }
    }

    _syncSingleProvisionalNode(lastSpeaker, lastLang) {
        const shouldShow = !!this.provisionalText;
        let node = this.singleListEl.querySelector('.provisional-item');
        if (!shouldShow) {
            this._clearTypewriter('provisional:single:source');
            if (node) node.remove();
            return;
        }
        if (!node) {
            node = document.createElement('div');
            node.className = 'provisional-item seg-item seg-enter';
            this.singleListEl.appendChild(node);
            this._scheduleClassCleanup(node, 'seg-enter', 320);
        }
        const showLanguage = !!(this.provisionalLanguage && this.provisionalLanguage !== lastLang);
        this._syncMetaNode(node, '', 'speaker-label');
        this._syncMetaNode(node, showLanguage ? this._langEmoji(this.provisionalLanguage) : '', 'lang-badge');
        let block = node.querySelector('.seg-block');
        if (!block) {
            block = document.createElement('div');
            block.className = 'seg-block provisional-live';
            node.appendChild(block);
        }
        block.classList.add('provisional-live');
        block.querySelectorAll('.seg-original-final, .seg-translated').forEach((el) => el.remove());
        const provisional = this._ensureChild(block, 'div', 'seg-provisional');
        this._setProvisionalText(provisional, this.provisionalText, 'provisional:single:source');
    }

    _syncDualProvisionalNode(lastSpeaker, lastLang) {
        const shouldShow = !!this.provisionalText;
        let rowNode = this.dualListEl.querySelector('.provisional-item');
        if (!shouldShow) {
            this._clearTypewriter('provisional:dual:source');
            this._clearTypewriter('provisional:dual:target');
            if (rowNode) rowNode.remove();
            return;
        }
        if (!rowNode) {
            rowNode = document.createElement('div');
            rowNode.className = 'provisional-item seg-dual-row seg-enter';
            this.dualListEl.appendChild(rowNode);
            this._scheduleClassCleanup(rowNode, 'seg-enter', 320);
        }
        const sourceNode = this._ensureChild(rowNode, 'div', 'seg-cell seg-cell-source');
        const targetNode = this._ensureChild(rowNode, 'div', 'seg-cell seg-cell-target');
        const showLanguage = !!(this.provisionalLanguage && this.provisionalLanguage !== lastLang);
        this._syncMetaNode(rowNode, '', 'speaker-label');
        this._syncMetaNode(rowNode, showLanguage ? this._langEmoji(this.provisionalLanguage) : '', 'lang-badge');

        const sourceText = this._ensureChild(sourceNode, 'div', 'seg-text pending seg-provisional');
        sourceText.className = 'seg-text pending seg-provisional';
        this._setProvisionalText(sourceText, this.provisionalText, 'provisional:dual:source');

        this._renderPendingTranslation(targetNode, this.provisionalText, 'provisional:dual:target');
    }

    _ensureSegmentNode(parent, key, className) {
        let node = parent.querySelector(`[data-seg-key="${key}"]`);
        if (!node) {
            node = document.createElement('div');
            node.dataset.segKey = key;
            node.className = `${className} seg-enter`;
            parent.appendChild(node);
            this._scheduleClassCleanup(node, 'seg-enter', 320);
        }
        return node;
    }

    _pruneNodes(parent, selector, desiredKeys) {
        parent.querySelectorAll(selector).forEach((node) => {
            if (!desiredKeys.includes(node.dataset.segKey)) {
                if (node.dataset.segKey) {
                    this._clearTypewritersByPrefix(`${node.dataset.segKey}:`);
                }
                node.remove();
            }
        });
    }

    _syncMetaNode(parent, text, className) {
        let el = parent.querySelector(`:scope > .${className}`);
        if (!text) {
            if (el) el.remove();
            return;
        }
        if (!el) {
            el = document.createElement('div');
            el.className = className;
            parent.prepend(el);
        }
        this._setText(el, text);
    }

    _ensureChild(parent, tagName, className) {
        let el = parent.querySelector(`:scope > .${className.split(' ').join('.')}`);
        if (!el) {
            el = document.createElement(tagName);
            el.className = className;
            parent.appendChild(el);
        }
        return el;
    }

    _setText(el, text) {
        const next = text || '';
        if (el.dataset.renderedText !== next) {
            el.textContent = next;
            el.dataset.renderedText = next;
        }
    }

    _syncTypewriterDom(el, renderedText, showCaret) {
        const next = renderedText || '';
        let textNode = el.querySelector(':scope > .seg-live-text');
        if (!textNode) {
            textNode = document.createElement('span');
            textNode.className = 'seg-live-text';
            el.appendChild(textNode);
        }
        if (textNode.dataset.renderedText !== next) {
            textNode.textContent = next;
            textNode.dataset.renderedText = next;
        }
        el.dataset.renderedText = next;
        if (showCaret) {
            this._ensureCaret(el);
        } else {
            el.querySelectorAll(':scope > .typewriter-caret').forEach((caret) => caret.remove());
        }
    }

    _setTypewriterText(el, text, key, options = {}) {
        const next = text || '';
        const showCaret = options.showCaret !== false;
        if (!key) {
            this._syncTypewriterDom(el, next, showCaret);
            return;
        }

        let tw = this._segTransTypewriters.get(key);
        if (!tw) {
            tw = {
                rendered: '',
                target: '',
                timerId: null,
                element: null,
            };
            this._segTransTypewriters.set(key, tw);
        }

        tw.element = el;
        tw.target = next;

        if (tw.rendered === next) {
            this._syncTypewriterDom(el, tw.rendered, showCaret);
            return;
        }

        if (!next.startsWith(tw.rendered)) {
            if (tw.timerId) {
                window.clearTimeout(tw.timerId);
                tw.timerId = null;
            }
            tw.rendered = next;
            this._syncTypewriterDom(el, tw.rendered, showCaret);
            return;
        }

        this._syncTypewriterDom(el, tw.rendered, showCaret);
        if (tw.timerId) {
            return;
        }

        const tick = () => {
            const state = this._segTransTypewriters.get(key);
            if (!state) {
                return;
            }
            if (!state.element || !state.element.isConnected) {
                this._clearTypewriter(key);
                return;
            }
            if (!state.target.startsWith(state.rendered)) {
                state.rendered = state.target;
                this._syncTypewriterDom(state.element, state.rendered, showCaret);
                state.timerId = null;
                return;
            }
            if (state.rendered === state.target) {
                state.timerId = null;
                this._syncTypewriterDom(state.element, state.rendered, showCaret);
                return;
            }
            const remain = state.target.length - state.rendered.length;
            const step = remain > this.typewriterLargeThreshold
                ? this.typewriterStepLarge
                : remain > this.typewriterMediumThreshold
                    ? this.typewriterStepMedium
                    : 1;
            state.rendered = state.target.slice(0, state.rendered.length + step);
            this._syncTypewriterDom(state.element, state.rendered, showCaret);
            state.timerId = window.setTimeout(tick, this.typewriterTickMs);
        };

        tw.timerId = window.setTimeout(tick, this.typewriterTickMs);
    }

    _setLiveText(el, text, showCaret = true) {
        const next = text || '';
        this._syncTypewriterDom(el, next, showCaret);
    }

    _setProvisionalText(el, text, key = '') {
        const next = text || '';
        this._setTypewriterText(el, next, key, { showCaret: true });
    }

    _ensureCaret(el) {
        let caret = el.querySelector(':scope > .typewriter-caret');
        if (!caret) {
            caret = document.createElement('span');
            caret.className = 'typewriter-caret';
            caret.textContent = '|';
            el.appendChild(caret);
        }
    }

    _renderPendingTranslation(node, mirrorText = '', key = '') {
        const pendingEl = this._ensureChild(node, 'div', 'seg-text seg-pending-translation');
        pendingEl.className = 'seg-text seg-pending-translation';
        const pendingText = (mirrorText || '').trim();
        if (!pendingText) {
            if (key) this._clearTypewriter(key);
            this._setText(pendingEl, '...');
            pendingEl.querySelectorAll('.typewriter-caret').forEach((caret) => caret.remove());
            return;
        }
        this._setTypewriterText(pendingEl, pendingText, key, { showCaret: true });
    }

    _toggleClassByConfidence(el, confidence) {
        el.classList.toggle('low-confidence', confidence !== null && confidence < 0.7);
    }

    _animateOnTextChange(el, nextText, animationClass) {
        if (el.dataset.animatedText === nextText) return;
        el.dataset.animatedText = nextText;
        this._playElementAnimation(el, animationClass);
    }

    _animateOnStateChange(el, nextState, animationClass) {
        if (el.dataset.animatedState === nextState) return;
        el.dataset.animatedState = nextState;
        this._playElementAnimation(el, animationClass);
    }

    _playElementAnimation(el, animationClass) {
        if (!el?.isConnected) {
            return;
        }

        const existingAnimation = this._elementAnimations.get(el);
        if (existingAnimation) {
            try {
                existingAnimation.cancel();
            } catch (_) {}
            this._elementAnimations.delete(el);
        }

        const animation = this._createElementAnimation(el, animationClass);
        if (animation) {
            this._elementAnimations.set(el, animation);
            const clear = () => {
                if (this._elementAnimations.get(el) === animation) {
                    this._elementAnimations.delete(el);
                }
            };
            animation.onfinish = clear;
            animation.oncancel = clear;
            return;
        }

        this._restartAnimationFallback(el, animationClass);
    }

    _createElementAnimation(el, animationClass) {
        if (typeof el.animate !== 'function') {
            return null;
        }

        if (animationClass === 'translation-appear') {
            return el.animate(
                [
                    { opacity: 0, transform: 'translateX(-12px)', filter: 'blur(4px)' },
                    { opacity: 1, transform: 'translateX(0)', filter: 'blur(0)' },
                ],
                {
                    duration: 400,
                    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                    fill: 'both',
                },
            );
        }

        if (animationClass === 'segment-settle') {
            return el.animate(
                [
                    {
                        boxShadow: '0 0 0 rgba(var(--accent-rgb), 0)',
                        borderColor: 'rgba(var(--accent-rgb), 0.16)',
                    },
                    {
                        boxShadow: '0 0 0 1px rgba(var(--accent-rgb), 0.18), 0 0 28px rgba(var(--accent-rgb), 0.12)',
                        borderColor: 'rgba(var(--accent-rgb), 0.32)',
                        offset: 0.45,
                    },
                    {
                        boxShadow: '0 0 0 rgba(var(--accent-rgb), 0)',
                        borderColor: 'var(--border)',
                    },
                ],
                {
                    duration: 500,
                    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                    fill: 'both',
                },
            );
        }

        return null;
    }

    _restartAnimationFallback(el, animationClass) {
        const token = `${Date.now()}:${Math.random()}`;
        const tokenKey = `fallbackAnimationToken${animationClass}`;
        const cleanupDelayMs = animationClass === 'segment-settle' ? 520 : 360;
        el.dataset[tokenKey] = token;
        el.classList.remove(animationClass);
        window.requestAnimationFrame(() => {
            if (!el?.isConnected || el.dataset[tokenKey] !== token) {
                return;
            }
            el.classList.add(animationClass);
            this._scheduleClassCleanup(el, animationClass, cleanupDelayMs);
        });
    }

    _scheduleClassCleanup(el, className, delayMs) {
        window.setTimeout(() => {
            if (el?.isConnected) el.classList.remove(className);
        }, delayMs);
    }

    _clearAllSegTypewriters() {
        for (const [, tw] of this._segTransTypewriters) {
            if (tw.timerId) window.clearTimeout(tw.timerId);
        }
        this._segTransTypewriters.clear();
    }

    _clearTypewriter(key) {
        if (!key) return;
        const tw = this._segTransTypewriters.get(key);
        if (!tw) return;
        if (tw.timerId) {
            window.clearTimeout(tw.timerId);
        }
        this._segTransTypewriters.delete(key);
    }

    _clearTypewritersByPrefix(prefix) {
        if (!prefix) return;
        const keys = [];
        for (const key of this._segTransTypewriters.keys()) {
            if (key.startsWith(prefix)) keys.push(key);
        }
        keys.forEach((key) => this._clearTypewriter(key));
    }

    _syncProvisionalOnly() {
        if (this.viewMode === 'dual' && this.dualListEl) {
            this._syncDualProvisionalNode(this.provisionalSpeaker, this.provisionalLanguage);
            this._smartScroll(this.container.parentElement || this.container);
            return;
        }
        if (this.singleListEl) {
            this._syncSingleProvisionalNode(this.provisionalSpeaker, this.provisionalLanguage);
            this._smartScroll(this.container.parentElement || this.container);
        }
    }

    _refreshProvisionalLayer() {
        if (!this.contentEl) {
            this._render();
            return;
        }
        if (this.viewMode === 'dual') {
            if (!this.dualListEl || !this.dualListEl.isConnected) {
                this._render();
                return;
            }
        } else if (!this.singleListEl || !this.singleListEl.isConnected) {
            this._render();
            return;
        }
        this._syncProvisionalOnly();
    }

    _resetProvisionalState() {
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.provisionalPendingClear = false;
        this._clearTypewritersByPrefix('provisional:');
    }

    _findHeldSegmentIndex() {
        if (!this.provisionalText) {
            return -1;
        }
        if (!this.provisionalPendingClear) {
            return -1;
        }
        const activeText = this.provisionalText;
        for (let index = this.segments.length - 1; index >= 0; index -= 1) {
            const seg = this.segments[index];
            if (!seg?.original) continue;
            if (seg.original !== activeText) continue;
            if (seg.status !== 'original') continue;
            return index;
        }
        return -1;
    }

    _getScrollState(el) {
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        return {
            distanceFromBottom,
            shouldStickBottom: distanceFromBottom < 120 || !!this.provisionalText,
        };
    }

    _restoreScroll(el, state) {
        if (state.shouldStickBottom) {
            el.scrollTop = el.scrollHeight;
        } else {
            el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - state.distanceFromBottom);
        }
    }

    _smartScroll(el) {
        const isNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
        if (isNearBottom) {
            el.scrollTop = el.scrollHeight;
        }
    }

    _trimSegments() {
        let totalLen = 0;
        for (const seg of this.segments) {
            totalLen += (seg.translation || seg.original || '').length;
        }
        // Prefer trimming already-translated rows first.
        // If translation is slow, dropping pending originals makes users feel
        // like STT text "disappears" before it gets translated.
        // Keep at least one segment visible.
        while (totalLen > this.maxChars && this.segments.length > 1) {
            let removeIdx = -1;
            for (let i = 0; i < this.segments.length; i += 1) {
                const seg = this.segments[i];
                const isTranslated = seg?.status === 'translated' || !!(seg?.translation && String(seg.translation).trim());
                if (isTranslated) {
                    removeIdx = i;
                    break;
                }
            }
            if (removeIdx === -1) {
                removeIdx = 0;
            }
            const removed = this.segments.splice(removeIdx, 1)[0];
            totalLen -= (removed?.translation || removed?.original || '').length;
        }
    }

    _cleanupStaleOriginals() {
        const now = Date.now();
        const staleMs = 60000;
        const maxPending = 12;
        // Only clean up *ungrouped* original rows.
        // Grouped rows (have groupId) represent real STT segments and should
        // not be dropped just because translation is queued/slow.
        this.segments = this.segments.filter((seg) => {
            if (seg?.groupId) return true;
            const lastTouchedAt = seg?.updatedAt || seg?.createdAt || now;
            return !(seg?.status === 'original' && (now - lastTouchedAt) > staleMs);
        });

        const pendingUngrouped = this.segments.filter((s) => s?.status === 'original' && !s?.groupId);
        while (pendingUngrouped.length > maxPending) {
            const oldest = pendingUngrouped.shift();
            const idx = this.segments.indexOf(oldest);
            if (idx !== -1) this.segments.splice(idx, 1);
        }
    }

    _segmentKey(seg, index) {
        return seg.groupId ? `group-${seg.groupId}` : `idx-${index}`;
    }

    _langEmoji(langCode) {
        const flags = {
            en: '🇬🇧',
            ja: '🇯🇵',
            ko: '🇰🇷',
            zh: '🇨🇳',
            vi: '🇻🇳',
            fr: '🇫🇷',
            de: '🇩🇪',
            es: '🇪🇸',
            th: '🇹🇭',
            id: '🇮🇩',
            pt: '🇵🇹',
            ru: '🇷🇺',
            ar: '🇸🇦',
            hi: '🇮🇳',
            it: '🇮🇹',
            nl: '🇳🇱',
            pl: '🇵🇱',
            tr: '🇹🇷',
            sv: '🇸🇪',
            da: '🇩🇰',
            no: '🇳🇴',
            fi: '🇫🇮',
            el: '🇬🇷',
            cs: '🇨🇿',
            ro: '🇷🇴',
            hu: '🇭🇺',
            uk: '🇺🇦',
            he: '🇮🇱',
            ms: '🇲🇾',
            tl: '🇵🇭',
            bn: '🇧🇩',
            ta: '🇱🇰',
        };
        const flag = flags[langCode] || '🌐';
        return `${flag} ${String(langCode || '').toUpperCase()}`;
    }
}

Object.assign(TranscriptUI.prototype, transcriptRenderMethods);
