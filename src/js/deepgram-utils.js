export function normalizeLanguageCode(code) {
    const value = String(code || '').trim().toLowerCase();
    if (!value) {
        return '';
    }
    if (value === 'auto' || value === 'multi') {
        return value;
    }
    return value.split(/[-_]/)[0];
}

export function isDeepgramMultilingualSupportedLanguage(code) {
    return new Set(['en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl'])
        .has(normalizeLanguageCode(code));
}

export function isDeepgramTwoWayMode(settings = {}) {
    return (settings.translation_mode || 'local') === 'deepgram'
        && (settings.translation_type || 'one_way') === 'two_way';
}

export function isDeepgramStrictSentencePair(sourceLanguage) {
    return ['ko', 'ja'].includes(sourceLanguage || '');
}

export function isDeepgramContinuousPair(sourceLanguage, targetLanguage) {
    if (!sourceLanguage || !targetLanguage) {
        return false;
    }
    const supported = ['vi', 'en'];
    return supported.includes(sourceLanguage) && supported.includes(targetLanguage);
}

export function deepgramTextHasExplicitSentenceBoundary(text) {
    const value = (text || '').trim();
    if (!value) {
        return false;
    }
    return /[.!?…。！？]$/.test(value);
}

export function deepgramTextHasSentenceBoundary(text, language) {
    const value = (text || '').trim();
    if (!value) {
        return false;
    }
    if (deepgramTextHasExplicitSentenceBoundary(value)) {
        return true;
    }
    const compact = value.replace(/\s+/g, '');
    if (language && ['ko', 'ja'].includes(language) && compact.length >= 10) {
        return true;
    }
    return false;
}

export function deepgramTextIsLongEnough(text, language) {
    const value = (text || '').trim();
    if (!value) {
        return false;
    }
    const compactLength = value.replace(/\s+/g, '').length;
    const wordCount = value.split(/\s+/).filter(Boolean).length;
    if (language === 'zh') {
        return compactLength >= 6;
    }
    if (language && ['ko', 'ja'].includes(language)) {
        return compactLength >= 8;
    }
    return compactLength >= 8 || wordCount >= 2;
}

export function getDeepgramRecommendedEndpointDelay(sourceLanguage, settings = {}) {
    if (isDeepgramStrictSentencePair(sourceLanguage)) {
        return 900;
    }
    if ((sourceLanguage || '') === 'zh') {
        return 600;
    }
    return 250;
}

export function resolveDeepgramEndpointDelay(settings = {}) {
    const sourceLanguage = settings?.source_language || 'auto';
    const recommended = getDeepgramRecommendedEndpointDelay(sourceLanguage, settings);
    const configured = Number(settings?.endpoint_delay);
    if (Number.isFinite(configured) && configured > 0) {
        return Math.max(10, configured);
    }
    return recommended;
}

export function resolveDeepgramDirection(sourceLanguage, settings = {}) {
    const normalizedSource = normalizeLanguageCode(
        sourceLanguage || settings.source_language || 'auto',
    ) || 'auto';

    if (!isDeepgramTwoWayMode(settings)) {
        return {
            sourceLanguage: normalizedSource,
            targetLanguage: normalizeLanguageCode(settings.target_language || 'vi') || 'vi',
            twoWay: false,
        };
    }

    const langA = normalizeLanguageCode(settings.language_a || 'vi') || 'vi';
    const langB = normalizeLanguageCode(settings.language_b || 'en') || 'en';

    if (langA === langB) {
        return {
            sourceLanguage: normalizedSource,
            targetLanguage: normalizeLanguageCode(settings.target_language || 'vi') || 'vi',
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

export function mergeDeepgramGroupText(existingText, nextText) {
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
        if (compactIncoming.startsWith(compactCurrent)) {
            return incoming;
        }
        if (compactCurrent.startsWith(compactIncoming)) {
            return current;
        }
    }

    const currentWords = current.split(/\s+/);
    const incomingWords = incoming.split(/\s+/);
    const maxOverlap = Math.min(currentWords.length, incomingWords.length, 12);
    for (let size = maxOverlap; size > 0; size -= 1) {
        const currentSuffix = currentWords.slice(-size).join(' ').trim();
        const incomingPrefix = incomingWords.slice(0, size).join(' ').trim();
        if (currentSuffix && incomingPrefix && currentSuffix === incomingPrefix) {
            return [...currentWords, ...incomingWords.slice(size)].join(' ').replace(/\s+/g, ' ').trim();
        }
    }

    return `${current} ${incoming}`.replace(/\s+/g, ' ').trim();
}
