/** @typedef {import('./MacroCstWalker.js').MacroCall} MacroCall */
/** @typedef {import('./MacroRegistry.js').MacroDefinition} MacroDefinition */
/** @typedef {import('chevrotain').ILexingError} ILexingError */
/** @typedef {import('chevrotain').IRecognitionException} IRecognitionException */

import { t } from '/scripts/i18n.js';
import { Popup, POPUP_RESULT } from '/scripts/popup.js';
import { power_user } from '/scripts/power-user.js';
import { accountStorage } from '/scripts/util/AccountStorage.js';
import { SimpleMutex } from '/scripts/util/SimpleMutex.js';

/**
 * @typedef {Object} MacroErrorContext
 * @property {string} [macroName]
 * @property {MacroCall} [call]
 * @property {MacroDefinition} [def]
 */

/** @typedef {MacroErrorContext & { message: string }} MacroRuntimeErrorOptions */

/** @typedef {MacroErrorContext & { message: string, error?: any }} MacroLogOptions */


// Mutex prevents the popup from showing more than once under parallel, unawaited calls.
export const onboardingExperimentalMacroEngineMutex = new SimpleMutex(onboardingExperimentalMacroEngineUnsafe);

export const onboardingExperimentalMacroEngine = onboardingExperimentalMacroEngineMutex.update.bind(onboardingExperimentalMacroEngineMutex);

async function onboardingExperimentalMacroEngineUnsafe(feature = null) {
    if (power_user.experimental_macro_engine) return;

    const shown = accountStorage.getItem('slash_command_experimental_engine_warning_shown');
    if (shown === 'true') return;

    const result = await Popup.show.confirm(t`Experimental Macro Engine`, `
        <p>${t`You are using experimental macro features that require the new macro engine.`}</p>
        ${feature ? `<div class="info-block hint">
                <span>${t`Recognized Feature: `}<strong>${feature}</strong></span>
            </div>` : ''}
        <p>${t`For more information on the new macro engine, visit the <br />${`<a href="https://docs.sillytavern.app/usage/core-concepts/macros/">${t`Macro Documentation`}</a>`}.`}</p>
        <p>${t`You can enable the engine any time under:<br />${t`User Settings`} → ${t`Experimental Macro Engine`}`}</p>
        <p>${t`Would you like to enable it now?`}</p>`);
    if (result == POPUP_RESULT.AFFIRMATIVE) {
        power_user.experimental_macro_engine = true;
        $('#experimental_macro_engine').prop('checked', power_user.experimental_macro_engine).trigger('input');
    }

    accountStorage.setItem('slash_command_experimental_engine_warning_shown', 'true');
}

/**
 * Caught by MacroEngine and logged as a runtime warning, leaving the macro raw in the evaluated text.
 * @param {MacroRuntimeErrorOptions} options
 */
export function createMacroRuntimeError({ message, call, def, macroName }) {
    const inferredName = inferMacroName(call, def, macroName);

    const error = new Error(message);
    error.name = 'MacroRuntimeError';
    // @ts-ignore - custom tagging for downstream classification
    error.isMacroRuntimeError = true;
    // @ts-ignore - helpful metadata for debugging
    error.macroName = inferredName;
    // @ts-ignore - best-effort location information
    error.macroRange = call && call.range ? call.range : null;
    // @ts-ignore - attach raw call/definition for convenience
    if (call) error.macroCall = call;
    // @ts-ignore
    if (def) error.macroDefinition = def;

    return error;
}

/**
 * For issues in how a macro was written in the text (e.g. invalid arguments), not engine bugs.
 * @param {MacroLogOptions} options
 */
export function logMacroRuntimeWarning({ message, call, def, macroName, error }) {
    const payload = buildMacroPayload({ call, def, macroName, error });
    console.warn('[Macro] Warning:', message, payload);
}

/**
 * For macro definition or engine bugs, surfaced as red console errors.
 * @param {MacroLogOptions} options
 */
export function logMacroInternalError({ message, call, macroName, error }) {
    const payload = buildMacroPayload({ call, def: undefined, macroName, error });
    console.error('[Macro] Error:', message, payload);
}

/** @param {{ message: string, macroName?: string, error?: any }} options */
export function logMacroRegisterWarning({ message, macroName, error = undefined }) {
    const payload = buildMacroPayload({ macroName, error });
    console.warn('[Macro] Warning:', message, payload);
}

/** @param {{ message: string, macroName?: string, error?: any }} options */
export function logMacroRegisterError({ message, macroName, error = undefined }) {
    const payload = buildMacroPayload({ macroName, error });
    console.error('[Macro] Registration Error:', message, payload);
}

/** @param {{ message: string, error?: any }} options */
export function logMacroGeneralError({ message, error }) {
    console.error('[Macro] Error:', message, error);
}

/** @param {{ phase: 'lexing', input: string, errors: ILexingError[] }|{ phase: 'parsing', input: string, errors: IRecognitionException[] }} options */
export function logMacroSyntaxWarning({ phase, input, errors }) {
    if (!errors || errors.length === 0) {
        return;
    }

    /** @type {{ message: string, line: number|null, column: number|null, length: number|null }[]} */
    const issues = errors.map((err) => {
        const hasOwnLine = typeof err.line === 'number';
        const hasOwnColumn = typeof err.column === 'number';

        const token = /** @type {{ startLine?: number, startColumn?: number, startOffset?: number, endOffset?: number }|undefined} */ (err.token);

        const line = hasOwnLine ? err.line : (token && typeof token.startLine === 'number' ? token.startLine : null);
        const column = hasOwnColumn ? err.column : (token && typeof token.startColumn === 'number' ? token.startColumn : null);

        /** @type {number|null} */
        let length = null;
        if (typeof err.length === 'number') {
            length = err.length;
        } else if (token && typeof token.startOffset === 'number' && typeof token.endOffset === 'number') {
            length = token.endOffset - token.startOffset + 1;
        }

        return {
            message: err.message,
            line,
            column,
            length,
        };
    });

    const label = phase === 'lexing' ? 'Lexing' : 'Parsing';

    /** @type {Record<string, any>} */
    const payload = {
        phase,
        count: issues.length,
        issues,
        input,
    };

    console.warn('[Macro] Warning:', `${label} errors detected`, payload);
}

/** @param {MacroErrorContext & { error?: any }} ctx */
function buildMacroPayload({ call, def, macroName, error }) {
    const inferredName = inferMacroName(call, def, macroName);

    /** @type {Record<string, any>} */
    const payload = {
        macroName: inferredName,
    };

    if (call && call.range) payload.range = call.range;
    if (call && typeof call.rawInner === 'string') payload.raw = call.rawInner;
    if (call) payload.call = call;
    if (def) payload.def = def;
    if (error) payload.error = error;

    return payload;
}

function inferMacroName(call, def, explicit) {
    if (typeof explicit === 'string' && explicit.trim()) {
        return explicit.trim();
    }
    if (call && typeof call.name === 'string' && call.name.trim()) {
        return call.name.trim();
    }
    if (def && typeof def.name === 'string' && def.name.trim()) {
        return def.name.trim();
    }
    return 'unknown';
}
