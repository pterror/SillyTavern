/**
 * @typedef {object} TokenizerState
 * @property {string} api
 * @property {string} [type]
 * @property {string} [url]
 * @property {string} [model]
 * @property {string} [source]
 * @property {number} [tokenizerSetting]
 * @property {string[]} [hordeModels]
 * @property {number} [explicitTokenizer]
 */

/**
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
 * @param {import('express').Request} request
 * @returns {TokenizerState|null|undefined}
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
