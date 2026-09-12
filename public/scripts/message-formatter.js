import { messageFormatting } from '../script.js';

/**
 * All stages run before DOMPurify sanitization — there is intentionally no post-sanitize stage.
 * @enum {string}
 */
export const formatting_stage = {
    BEFORE_REGEX: 'beforeRegex',
    AFTER_REGEX: 'afterRegex',
    AFTER_MARKDOWN: 'afterMarkdown',
};

/** @typedef {formatting_stage[keyof formatting_stage]} MessageFormattingStage */

/**
 * @typedef {Object} MessageFormattingBase
 * @property {string} characterName
 * @property {boolean} isSystem
 * @property {boolean} isUser
 * @property {number} messageId - Index in the chat array, or -1 for transient messages (e.g. streaming previews).
 * @property {boolean} isReasoning
 */

/** @typedef {Readonly<MessageFormattingBase & { stage: MessageFormattingStage }>} MessageFormattingContext */

/**
 * Must return synchronously; an async hook throws a TypeError at registration time. A non-string
 * return is ignored (with a console warning) and the previous text is kept.
 *
 * @callback MessageFormattingHook
 * @param {string}                    mes
 * @param {MessageFormattingContext}  ctx
 * @returns {string}
 */

/**
 * @typedef {Object} AddHookOptions
 * @property {hook_order|number} [order=hook_order.NORMAL]
 */

/** @enum {number} */
export const hook_order = {
    EARLIEST: 0,
    EARLY: 10,
    NORMAL: 50,
    LATE: 90,
    LATEST: 100,
};

/** @type {MessageFormatter} */
let instance;

// Exported under the class name so callers can write `import { MessageFormatter } from './message-formatter.js'`.
export { instance as MessageFormatter };

class MessageFormatter {
    /** @type {MessageFormatter} */
    static #instance;

    /** @returns {MessageFormatter} */
    static get instance() {
        return MessageFormatter.#instance ?? (MessageFormatter.#instance = new MessageFormatter());
    }

    /** @type {Map<MessageFormattingStage, { fn: MessageFormattingHook, order: number }[]>} */
    #hooks = new Map();

    /** @type {typeof formatting_stage} @readonly */
    stage = formatting_stage;

    /** @type {typeof hook_order} @readonly */
    order = hook_order;

    constructor() {
        this.#hooks.set(formatting_stage.BEFORE_REGEX, []);
        this.#hooks.set(formatting_stage.AFTER_REGEX, []);
        this.#hooks.set(formatting_stage.AFTER_MARKDOWN, []);
    }

    /**
     * @param {MessageFormattingHook} fn
     * @param {AddHookOptions & { stage?: MessageFormattingStage }} [options={}]
     * @throws {TypeError} If `fn` is not a function or is async.
     * @throws {RangeError} If `stage` is not a known {@link formatting_stage} value.
     */
    addHook(fn, { stage = formatting_stage.AFTER_MARKDOWN, order = hook_order.NORMAL } = {}) {
        if (typeof fn !== 'function') throw new TypeError('MessageFormatter: hook must be a function');
        if (fn.constructor?.name === 'AsyncFunction') throw new TypeError(`MessageFormatter: hook registered for stage '${stage}' must be synchronous — async functions are not supported`);
        if (!this.#hooks.has(stage)) throw new RangeError(`MessageFormatter: unknown stage '${stage}'`);
        this.#hooks.get(stage).push({ fn, order });
    }

    // Not meant to be called directly by extensions — invoked internally by messageFormatting at each pipeline point.
    runStage(stage, mes, base) {
        const bucket = this.#hooks.get(stage);
        if (!bucket?.length) return mes;
        const ctx = Object.freeze({ ...base, stage });
        const sorted = bucket.slice().sort((a, b) => a.order - b.order);
        for (const { fn } of sorted) {
            try {
                const result = fn(mes, ctx);
                if (typeof result !== 'string') {
                    console.warn(`[MessageFormatter] Hook at stage '${stage}' returned ${/** @type {unknown} */ (result) instanceof Promise ? 'a Promise (hook may be async)' : typeof result} instead of a string. The hook's return value has been ignored.`);
                } else {
                    mes = result;
                }
            } catch (e) {
                console.error(`[MessageFormatter] Hook error at stage '${stage}':`, e);
            }
        }
        return mes;
    }

    // Convenience shim over the top-level messageFormatting function, for extensions that already import getContext().
    format(mes, characterName, isSystem, isUser, messageId, sanitizerOverrides = {}, isReasoning = false) {
        return messageFormatting(mes, characterName, isSystem, isUser, messageId, sanitizerOverrides, isReasoning);
    }
}

instance = MessageFormatter.instance;
