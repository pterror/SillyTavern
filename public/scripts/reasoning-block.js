export const ReasoningType = Object.freeze({
    Model: 'model',
    Parsed: 'parsed',
    Manual: 'manual',
    Edited: 'edited',
});

const LEGACY_PLACEHOLDER = '​';

// Stored form: `reasoning: ''` is no block unless one of these types marks it as an empty block; `model` with no
// text is a hidden-reasoning model's duration, not a block.
const BLOCK_TYPES = new Set([ReasoningType.Parsed, ReasoningType.Manual, ReasoningType.Edited]);

/**
 * @param {unknown} extra
 * @returns {string | null} the block's text ('' for an empty block), or null when the message has no block
 */
export function reasoningOf(extra) {
    if (!extra || typeof extra !== 'object') return null;
    const { reasoning, reasoning_type: type } = /** @type {Record<string, unknown>} */ (extra);
    if (typeof reasoning !== 'string' || reasoning === LEGACY_PLACEHOLDER) return null;
    if (reasoning !== '') return reasoning;
    return typeof type === 'string' && BLOCK_TYPES.has(type) ? '' : null;
}

/**
 * @template {Record<string, any>} T
 * @param {T | null | undefined} extra
 * @param {string | null} reasoning the block's text, '' for an empty block, null for no block
 * @param {string} [type] the block's type; an empty block always gets a block type
 * @returns {T & { reasoning: string, reasoning_type?: string }}
 */
export function withReasoning(extra, reasoning, type = ReasoningType.Manual) {
    const next = /** @type {any} */ ({ ...(extra ?? {}) });
    if (reasoning === null) {
        next.reasoning = '';
        delete next.reasoning_type;
        return next;
    }
    next.reasoning = reasoning;
    next.reasoning_type = reasoning === '' && !BLOCK_TYPES.has(type) ? ReasoningType.Manual : type;
    return next;
}
