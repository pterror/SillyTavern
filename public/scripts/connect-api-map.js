/** Dependency-free API-connection-map helpers - must stay importable outside a browser DOM (e.g. under Node tests). */

/**
 * @typedef {object} ConnectApiMapEntry
 * @property {string} selected - API name (e.g. "textgenerationwebui", "openai")
 * @property {string} [type] - API type, mostly used by text completion. (e.g. "openrouter")
 * @property {string} [source] - API source, mostly used by chat completion. (e.g. "openai")
 */

/**
 * Builds the map from `/connect` alias (and every raw textgen type / chat completion source value)
 * to the API it selects. Pure function of the two enums so callers on either side of the
 * client/server boundary can each pass their own copy of `textgenTypes`/`chatCompletionSources`.
 * @param {Record<string, string>} textgenTypes Values of a TEXTGEN_TYPES-shaped enum.
 * @param {Record<string, string>} chatCompletionSources Values of a CHAT_COMPLETION_SOURCES-shaped enum.
 * @returns {Record<string, ConnectApiMapEntry>}
 */
export function buildConnectApiMap(textgenTypes, chatCompletionSources) {
    /** @type {Record<string, ConnectApiMapEntry>} */
    const result = {
        'kobold': { selected: 'kobold' },
        'horde': { selected: 'koboldhorde' },
        'novel': { selected: 'novel' },
        'koboldcpp': { selected: 'textgenerationwebui', type: textgenTypes.KOBOLDCPP },
        'kcpp': { selected: 'textgenerationwebui', type: textgenTypes.KOBOLDCPP },
        'openai': { selected: 'openai', source: chatCompletionSources.OPENAI },
        'oai': { selected: 'openai', source: chatCompletionSources.OPENAI },
        'google': { selected: 'openai', source: chatCompletionSources.MAKERSUITE },
        // OpenRouter needs chat comp and text comp differentiated
        'openrouter': { selected: 'openai', source: chatCompletionSources.OPENROUTER },
        'openrouter-text': { selected: 'textgenerationwebui', type: textgenTypes.OPENROUTER },
    };

    for (const textGenType of Object.values(textgenTypes)) {
        if (result[textGenType]) continue;
        result[textGenType] = { selected: 'textgenerationwebui', type: textGenType };
    }

    for (const chatCompletionSource of Object.values(chatCompletionSources)) {
        if (result[chatCompletionSource]) continue;
        result[chatCompletionSource] = { selected: 'openai', source: chatCompletionSource };
    }

    return result;
}

/**
 * The set of `selectedApiMap.selected` values that a connection profile is allowed to resolve to.
 * @returns {string[]}
 */
export function getConnectApiMapAllowedSelected() {
    return ['openai', 'textgenerationwebui'];
}
