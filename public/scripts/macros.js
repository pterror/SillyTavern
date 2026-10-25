import { Handlebars } from '../lib.js';
import { substituteParams } from '../script.js';
import { chat } from './chat-state.js';
import { uuidv4 } from './utils.js';
import { initRegisterMacros, macros as macroSystem } from './macros/macro-system.js';
import { initMacroTooltips } from './macro-tooltip.js';

// Register any macro that you want to leave in the compiled story string
Handlebars.registerHelper('trim', () => '{{trim}}');
// Catch-all helper for any macro that is not defined for story strings
Handlebars.registerHelper('helperMissing', function () {
    const options = arguments[arguments.length - 1];
    const macroName = options.name;
    return substituteParams(`{{${macroName}}}`);
});

/**
 * @typedef {Object<string, *>} EnvObject
 * @typedef {(nonce: string) => string} MacroFunction
 */

/**
 * @typedef {Object} CustomMacro
 * @property {string} key - Macro name (key)
 * @property {string} description - Optional description of the macro
 */

/**
 * @deprecated Use macros.registry.registerMacro (from scripts/macros/macro-system.js)
 * or substituteParams({ dynamicMacros }). Kept for extensions: it registers in the macro registry.
 */
export class MacrosParser {
    static #logDeprecated(method, replacement, methodArgs = null) {
        console.warn(`[DEPRECATED] MacrosParser.${method} is deprecated and will be removed in a future version. Use ${replacement} instead. Arguments:`, (methodArgs ?? 'none'));
    }

    /**
     * Returns an iterator over all registered macros.
     * @returns {IterableIterator<CustomMacro>}
     */
    static [Symbol.iterator] = function* () {
        // Exclude hidden aliases for consistency with autocomplete behavior
        for (const def of macroSystem.registry.getAllMacros({ excludeHiddenAliases: true })) {
            yield { key: def.name, description: def.description || '' };
        }
    };

    /**
     * Access a macro by its name.
     * @param {string} key Macro name (key)
     * @returns {((nonce: string) => string)|undefined} The macro's value, as a function of the nonce
     */
    static get(key) {
        MacrosParser.#logDeprecated('get', 'macros.registry.getMacro (from scripts/macros/macro-system.js)', arguments);
        return macroSystem.registry.hasMacro(key) ? () => substituteParams(`{{${key}}}`) : undefined;
    }

    /**
     * Checks if a macro is registered.
     * @param {string} key Macro name (key)
     * @returns {boolean} True if the macro is registered, false otherwise
     */
    static has(key) {
        MacrosParser.#logDeprecated('has', 'macros.registry.hasMacro (from scripts/macros/macro-system.js)', arguments);
        return macroSystem.registry.hasMacro(key);
    }

    /**
     * Registers a global macro that can be used anywhere where substitution is allowed.
     * @param {string} key Macro name (key)
     * @param {string|MacroFunction} value A string or a function that returns a string
     * @param {string} [description] Optional description of the macro
     */
    static registerMacro(key, value, description = '') {
        MacrosParser.#logDeprecated('registerMacro', 'macros.registry.registerMacro (from scripts/macros/macro-system.js) or substituteParams({ dynamicMacros })', arguments);
        if (typeof key !== 'string') {
            throw new Error('Macro key must be a string');
        }

        // Allowing surrounding whitespace would just create more confusion...
        key = key.trim();

        if (!key) {
            throw new Error('Macro key must not be empty or whitespace only');
        }

        if (key.startsWith('{{') || key.endsWith('}}')) {
            throw new Error('Macro key must not include the surrounding braces');
        }

        if (typeof value !== 'string' && typeof value !== 'function') {
            console.warn(`Macro value for "${key}" will be converted to a string`);
            value = this.sanitizeMacroValue(value);
        }

        // Like the old MacrosParser, we explicitly allow overriding macros, and only warn
        if (macroSystem.registry.hasMacro(key)) {
            console.warn(`Macro ${key} is already registered`);
        }

        macroSystem.registry.registerMacro(key, {
            // MacrosParser macros never took arguments: only {{key}} without arguments is valid.
            category: 'legacy',
            description: typeof description === 'string' ? description : 'Automatically registered macro from MacrosParser',
            handler: () => {
                if (typeof value !== 'function') return value;
                try {
                    return value(uuidv4());
                } catch (e) {
                    console.warn(`Macro "${key}" function threw an error.`, e);
                    return '';
                }
            },
        });
    }

    /**
     * Unregisters a global macro with the given key
     *
     * @param {string} key Macro name (key)
     */
    static unregisterMacro(key) {
        MacrosParser.#logDeprecated('unregisterMacro', 'macros.registry.unregisterMacro (from scripts/macros/macro-system.js)', arguments);
        if (typeof key !== 'string') {
            throw new Error('Macro key must be a string');
        }

        // Allowing surrounding whitespace would just create more confusion...
        key = key.trim();

        if (!key) {
            throw new Error('Macro key must not be empty or whitespace only');
        }

        macroSystem.registry.unregisterMacro(key);
    }

    /**
     * @deprecated Registered macros are in the macro registry; nothing is put in the env object.
     * @param {EnvObject} _env
     * @returns {void}
     */
    static populateEnv(_env) {}

    /**
     * Performs a type-check on the macro value and returns a sanitized version of it.
     * @param {any} value Value returned by a macro
     * @returns {string} Sanitized value
     */
    static sanitizeMacroValue(value) {
        if (typeof value === 'string') {
            return value;
        }

        if (value === null || value === undefined) {
            return '';
        }

        if (value instanceof Promise) {
            console.warn('Promises are not supported as macro values');
            return '';
        }

        if (typeof value === 'function') {
            console.warn('Functions are not supported as macro values');
            return '';
        }

        if (value instanceof Date) {
            return value.toISOString();
        }

        if (typeof value === 'object') {
            return JSON.stringify(value);
        }

        return String(value);
    }
}

/**
 * Returns the ID of the last message in the chat
 *
 * Optionally can only choose specific messages, if a filter is provided.
 *
 * @param {object} param0 - Optional arguments
 * @param {boolean} [param0.exclude_swipe_in_propress=true] - Whether a message that is currently being swiped should be ignored
 * @param {function(object):boolean} [param0.filter] - A filter applied to the search, ignoring all messages that don't match the criteria. For example to only find user messages, etc.
 * @returns {number|null} The message id, or null if none was found
 */
export function getLastMessageId({ exclude_swipe_in_propress = true, filter = null } = {}) {
    for (let i = chat?.length - 1; i >= 0; i--) {
        let message = chat[i];

        // If ignoring swipes and the message is being swiped, continue
        // We can check if a message is being swiped by checking whether the current swipe id is not in the list of finished swipes yet
        if (exclude_swipe_in_propress && message.swipes && message.swipe_id >= message.swipes.length) {
            continue;
        }

        // Check if no filter is provided, or if the message passes the filter
        if (!filter || filter(message)) {
            return i;
        }
    }

    return null;
}

/**
 * Substitutes {{macro}} parameters in a string.
 * @deprecated Use substituteParams(content, { dynamicMacros, postProcessFn }).
 * @param {string} content - The string to substitute parameters in.
 * @param {EnvObject} env - Map of macro names to the values they'll be substituted with. If the param
 * values are functions, those functions will be called and their return values are used.
 * @param {(value: string, macro?: import('./macros/engine/MacroEnvBuilder.js').MacroIdentity) => string} postProcessFn - Function to run on the macro value before replacing it, given which macro it is.
 * @returns {string} The string with substituted parameters.
 */
export function evaluateMacros(content, env, postProcessFn) {
    if (!content) {
        return '';
    }
    /** @type {Record<string, import('./macros/engine/MacroEnv.types.js').DynamicMacroValue>} */
    const dynamicMacros = {};
    for (const [name, value] of Object.entries(env ?? {})) {
        dynamicMacros[name] = typeof value === 'function'
            ? () => MacrosParser.sanitizeMacroValue(value(uuidv4()))
            : MacrosParser.sanitizeMacroValue(value);
    }
    return substituteParams(content, { dynamicMacros, postProcessFn: typeof postProcessFn === 'function' ? postProcessFn : (x => x) });
}

export function initMacros() {
    initRegisterMacros();
    initMacroTooltips();
}
