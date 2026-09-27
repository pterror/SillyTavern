/**
 * @typedef {object} TokenizerState
 * @property {string} api main_api: 'textgenerationwebui', 'kobold', 'novel', 'koboldhorde' or 'openai'.
 * @property {string} [type] Textgen type, or the chat-completion source.
 * @property {string} [url] Backend URL (textgen and kobold).
 * @property {string} [model] The backend's model setting; empty asks the backend (textgen, kobold).
 * @property {string} [source] Chat-completion source.
 * @property {number} [tokenizerSetting] A `tokenizers` value; defaults to BEST_MATCH.
 * @property {string[]} [hordeModels] Selected Horde models.
 * @property {number} [explicitTokenizer] A `tokenizers` value the caller named outright
 * (`getTextTokens(id, …)`). It wins over every other rule, on every api; see
 * isExplicitTokenizer() in src/tokenizer-resolve.js.
 */

/**
 * The on-screen connection state a request sends, or null when it names no API.
 * @param {any} state
 * @returns {TokenizerState|null}
 */
export function readTokenizerState(state) {
    if (!state || typeof state !== 'object' || typeof state.api !== 'string' || !state.api) {
        return null;
    }
    const optionalString = (value) => typeof value === 'string' ? value : undefined;
    return {
        api: state.api,
        type: optionalString(state.type),
        url: optionalString(state.url),
        model: optionalString(state.model),
        source: optionalString(state.source),
        tokenizerSetting: Number.isInteger(state.tokenizerSetting) ? state.tokenizerSetting : undefined,
        hordeModels: Array.isArray(state.hordeModels) ? state.hordeModels.map(String) : undefined,
    };
}

/**
 * The chat-completion state in a request's `X-ST-Connection-State` header, which routes whose
 * query and body keep upstream's shape (`/bias`, `/openai/*`) take on the side.
 * @param {import('express').Request} request
 * @returns {TokenizerState|null|undefined} undefined without the header; null when it holds no
 * chat-completion state.
 */
export function readConnectionStateHeader(request) {
    const header = request.get('X-ST-Connection-State');
    if (header === undefined) {
        return undefined;
    }
    try {
        const state = readTokenizerState(JSON.parse(header));
        return state?.api === 'openai' ? state : null;
    } catch {
        return null;
    }
}
