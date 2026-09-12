import { MacroParser } from './MacroParser.js';
import { MacroCstWalker } from './MacroCstWalker.js';
import { MacroRegistry, MacroValueType } from './MacroRegistry.js';
import { logMacroGeneralError, logMacroInternalError, logMacroRuntimeWarning, logMacroSyntaxWarning } from './MacroDiagnostics.js';
import { ELSE_MARKER } from '../definitions/core-macros.js';

/** @typedef {import('./MacroCstWalker.js').MacroCall} MacroCall */
/** @typedef {import('./MacroEnv.types.js').MacroEnv} MacroEnv */
/** @typedef {import('./MacroRegistry.js').MacroDefinitionOptions} MacroDefinitionOptions */
/** @typedef {import('./MacroRegistry.js').MacroDefinition} MacroDefinition */

/**
 * A processor function that transforms text before or after macro evaluation.
 *
 * @callback MacroProcessor
 * @param {string} text - The text to process.
 * @param {MacroEnv} env - The macro environment.
 * @returns {string} The processed text.
 */

/**
 * @typedef {Object} RegisteredProcessor
 * @property {MacroProcessor} handler - The processor function.
 * @property {number} priority - Execution priority (lower = earlier).
 * @property {string} source - Identifier for debugging/tracking.
 */

/**
 * The singleton instance of the MacroEngine.
 *
 * @type {MacroEngine}
 */
let instance;
export { instance as MacroEngine };

class MacroEngine {
    /** @type {MacroEngine} */ static #instance;
    /** @type {MacroEngine} */ static get instance() { return MacroEngine.#instance ?? (MacroEngine.#instance = new MacroEngine()); }

    /** @type {RegisteredProcessor[]} */
    #preProcessors = [];
    /** @type {RegisteredProcessor[]} */
    #postProcessors = [];

    constructor() {
        this.#registerCorePreProcessors();
        this.#registerCorePostProcessors();
    }

    /**
     * Registers a pre-processor to run before macro evaluation.
     *
     * @param {MacroProcessor} handler - The processor function.
     * @param {Object} [options] - Configuration options.
     * @param {number} [options.priority=100] - Execution priority (lower = earlier).
     * @param {string} [options.source='unknown'] - Identifier for debugging.
     */
    addPreProcessor(handler, { priority = 100, source = 'unknown' } = {}) {
        this.#preProcessors.push({ handler, priority, source });
        this.#preProcessors.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Removes a previously registered pre-processor.
     *
     * @param {MacroProcessor} handler - The processor function to remove.
     * @returns {boolean} True if the processor was found and removed.
     */
    removePreProcessor(handler) {
        const index = this.#preProcessors.findIndex(p => p.handler === handler);
        if (index !== -1) {
            this.#preProcessors.splice(index, 1);
            return true;
        }
        return false;
    }

    /**
     * Registers a post-processor to run after macro evaluation.
     *
     * @param {MacroProcessor} handler - The processor function.
     * @param {Object} [options] - Configuration options.
     * @param {number} [options.priority=100] - Execution priority (lower = earlier).
     * @param {string} [options.source='unknown'] - Identifier for debugging.
     */
    addPostProcessor(handler, { priority = 100, source = 'unknown' } = {}) {
        this.#postProcessors.push({ handler, priority, source });
        this.#postProcessors.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Removes a previously registered post-processor.
     *
     * @param {MacroProcessor} handler - The processor function to remove.
     * @returns {boolean} True if the processor was found and removed.
     */
    removePostProcessor(handler) {
        const index = this.#postProcessors.findIndex(p => p.handler === handler);
        if (index !== -1) {
            this.#postProcessors.splice(index, 1);
            return true;
        }
        return false;
    }

    /**
     * Evaluates a string containing macros and resolves them.
     *
     * @param {string} input - The input string to evaluate.
     * @param {MacroEnv} env - The environment to pass to the macro handler.
     * @param {Object} [options={}] - Optional evaluation settings.
     * @param {number} [options.contextOffset=0] - Base offset from the original top-level document.
     *        Used when evaluating nested content (via resolve() in handlers) to preserve global
     *        positioning for macros like {{pick}} that seed on position.
     * @returns {string} The resolved string.
     */
    evaluate(input, env, { contextOffset = 0 } = {}) {
        if (!input) {
            return '';
        }
        const safeEnv = Object.freeze({ ...env });

        const preProcessed = this.#runPreProcessors(input, safeEnv);

        const { cst, lexingErrors, parserErrors } = MacroParser.parseDocument(preProcessed);

        if (lexingErrors && lexingErrors.length > 0) {
            logMacroSyntaxWarning({ phase: 'lexing', input, errors: lexingErrors });
        }
        if (parserErrors && parserErrors.length > 0) {
            logMacroSyntaxWarning({ phase: 'parsing', input, errors: parserErrors });
        }

        if (!cst || typeof cst !== 'object' || !cst.children) {
            logMacroGeneralError({ message: 'Macro parser produced an invalid CST. Returning original input.', error: { input, lexingErrors, parserErrors } });
            return input;
        }

        let evaluated;
        try {
            evaluated = MacroCstWalker.evaluateDocument({
                text: preProcessed,
                contextOffset,
                cst,
                env: safeEnv,
                resolveMacro: this.#resolveMacro.bind(this),
                trimContent: this.trimScopedContent.bind(this),
            });
        } catch (error) {
            logMacroGeneralError({ message: 'Macro evaluation failed. Returning original input.', error: { input, error } });
            return input;
        }

        const result = this.#runPostProcessors(evaluated, safeEnv);

        return result;
    }

    /**
     * Resolves a macro call.
     *
     * @param {MacroCall} call - The macro call to resolve.
     * @returns {string} The resolved macro.
     */
    #resolveMacro(call) {
        const { name, env } = call;

        const raw = `{{${call.rawInner}}}`;
        if (!name) return raw;

        // Dynamic macros take priority over any registered macro of the same name; keys are lowercased for case-insensitive lookup.
        /** @type {MacroDefinition|null} */
        let defOverride = null;
        const nameLower = name.toLowerCase();
        if (Object.hasOwn(env.dynamicMacros, nameLower)) {
            const impl = env.dynamicMacros[nameLower];

            // Dynamic macros: a plain string, a handler function (legacy), or a full MacroDefinitionOptions object.
            const looksLikeOptions = impl && typeof impl === 'object' &&
                'handler' in impl && typeof impl.handler === 'function';

            if (looksLikeOptions) {
                try {
                    const options = /** @type {MacroDefinitionOptions} */ (impl);
                    defOverride = MacroRegistry.buildMacroDefFromOptions(name, options);
                } catch (error) {
                    logMacroRuntimeWarning({ message: `Dynamic macro "${name}" has invalid options: ${error.message}`, call });
                }
            } else if (['string', 'number', 'boolean', 'function'].includes((typeof impl))) {
                if (['number', 'boolean'].includes(typeof impl)) {
                    logMacroRuntimeWarning({ message: `Dynamic macro "${name}" uses unsupported number/boolean format.`, call });
                }
                defOverride = MacroRegistry.buildMacroDefFromOptions(name, {
                    handler: typeof impl === 'function' ? impl : () => String(impl ?? ''),
                    category: 'dynamic',
                    description: 'Dynamic macro',
                    returnType: MacroValueType.STRING,
                });
            } else {
                logMacroRuntimeWarning({ message: `Dynamic macro "${name}" is not defined correctly (must be string, a handler function, or a macro def options object with handler property).`, call });
            }
        }

        if (!defOverride && !MacroRegistry.hasMacro(name)) {
            return raw; // Unknown macro: nested macros inside rawInner are already resolved.
        }

        try {
            const result = MacroRegistry.executeMacro(call, { defOverride });

            try {
                return call.env.functions.postProcess(result);
            } catch (error) {
                logMacroInternalError({ message: `Macro "${name}" postProcess function failed.`, call, error });
                return result;
            }
        } catch (error) {
            const isRuntimeError = !!(error && (error.name === 'MacroRuntimeError' || error.isMacroRuntimeError));
            if (isRuntimeError) {
                logMacroRuntimeWarning({ message: (error.message || `Macro "${name}" execution failed.`), call, error });
            } else {
                logMacroInternalError({ message: `Macro "${name}" internal execution error.`, call, error });
            }
            return raw;
        }
    }

    /**
     * Runs pre-processors on the input text, before the engine processes the input.
     *
     * @param {string} text - The input text to process.
     * @param {MacroEnv} env - The environment to pass to the macro handler.
     * @returns {string} The processed text.
     */
    #runPreProcessors(text, env) {
        let result = text;
        for (const { handler } of this.#preProcessors) {
            result = handler(result, env);
        }
        return result;
    }

    /**
     * Runs post-processors on the input text, after the engine finished processing the input.
     *
     * @param {string} text - The input text to process.
     * @param {MacroEnv} env - The environment to pass to the macro handler.
     * @returns {string} The processed text.
     */
    #runPostProcessors(text, env) {
        let result = text;
        for (const { handler } of this.#postProcessors) {
            result = handler(result, env);
        }
        return result;
    }

    /**
     * Registers the core pre/post processors that handle legacy syntax and cleanup.
     */
    #registerCorePreProcessors() {
        // Priority 0-50 is reserved for core pre-processors.

        // {{time_UTC-10}} isn't parsed by the new macro syntax, so rewrite it to {{time::UTC-10}} first.
        this.addPreProcessor(
            text => text.replace(/{{time_(UTC[+-]\d+)}}/gi, (_match, utcOffset) => `{{time::${utcOffset}}}`),
            { priority: 10, source: 'core:legacy-time-syntax' },
        );

        // Legacy non-curly markers (<USER>, <BOT>, <GROUP>, ...) rewritten into their macro equivalents.
        this.addPreProcessor(
            text => text
                .replace(/<USER>/gi, '{{user}}')
                .replace(/<BOT>/gi, '{{char}}')
                .replace(/<CHAR>/gi, '{{char}}')
                .replace(/<GROUP>/gi, '{{group}}')
                .replace(/<CHARIFNOTGROUP>/gi, '{{charIfNotGroup}}'),
            { priority: 20, source: 'core:legacy-markers' },
        );
    }

    /**
     * Registers the core post-processors that handle legacy syntax and cleanup.
     */
    #registerCorePostProcessors() {
        // Priority 0-50 is reserved for core post-processors.

        // \{\{ doesn't match the MacroStart token, so escaped braces pass through unprocessed and are unescaped here.
        this.addPostProcessor(
            text => text.replace(/\\([{}])/g, '$1'),
            { priority: 10, source: 'core:unescape-braces' },
        );

        // {{trim}} reaches outside its own macro boundaries, which the engine can't support, so it's handled via regex instead.
        this.addPostProcessor(
            text => text.replace(/(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, ''),
            { priority: 20, source: 'core:legacy-trim' },
        );

        // Clean up any leftover ELSE_MARKER left behind by processing.
        this.addPostProcessor(
            text => text.replaceAll(ELSE_MARKER, ''),
            { priority: 30, source: 'core:cleanup-else-marker' },
        );
    }

    /**
    * Normalizes macro results into a string.
    * This mirrors the behavior of the legacy macro system in a simplified way.
    *
    * @param {any} value
    * @returns {string}
    */
    normalizeMacroResult(value) {
        if (value === null || value === undefined) {
            return '';
        }
        if (value instanceof Date) {
            return value.toISOString();
        }
        if (typeof value === 'object' || Array.isArray(value)) {
            try {
                return JSON.stringify(value);
            } catch (_error) {
                return String(value);
            }
        }

        return String(value);
    }

    /**
     * Dedents scoped macro content to the indentation of its first non-empty line, e.g. so a `{{if}}` body indented for readability doesn't carry that indentation into the output.
     * @param {string} content - The content to trim
     * @param {Object} options - Configuration options
     * @param {boolean} [options.trimIndent=true] - Whether to also dedent consistent indentation
     * @returns {string} The trimmed content
     */
    trimScopedContent(content, { trimIndent = true } = {}) {
        if (!content) return '';

        if (!trimIndent) {
            return content.trim();
        }

        const lines = content.split('\n');

        let baseIndent = 0;
        for (const line of lines) {
            if (line.trim() !== '') {
                const match = line.match(/^[ \t]*/);
                baseIndent = match ? match[0].length : 0;
                break;
            }
        }

        if (baseIndent === 0) {
            return content.trim();
        }

        const dedentedLines = lines.map(line => {
            const match = line.match(/^[ \t]*/);
            const lineIndent = match ? match[0].length : 0;
            if (lineIndent >= baseIndent) {
                return line.slice(baseIndent);
            }
            return line.trimStart();
        });

        return dedentedLines.join('\n').trim();
    }
}

instance = MacroEngine.instance;
