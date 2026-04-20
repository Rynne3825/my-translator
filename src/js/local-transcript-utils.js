export function extractCompletedSentences(text) {
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

export function normalizeLocalTranscriptForDedupe(text, language) {
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

export function localTextHasTerminalBoundary(text) {
    return /[.!?。！？]\s*$/.test(String(text || '').trim());
}

export function localTextLooksIncomplete(text, language) {
    const value = String(text || '').trim();
    if (!value) {
        return false;
    }
    if (localTextHasTerminalBoundary(value)) {
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
            return true;
        }
    }
    return false;
}

export function shouldSuppressLocalProvisionalPreview(text, revision, language) {
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
