/**
 * @typedef {object} ConnectApiMapEntry
 * @property {string} selected
 * @property {string} [type]
 * @property {string} [source]
 */

/**
 * @param {Record<string, string>} textgenTypes
 * @param {Record<string, string>} chatCompletionSources
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

