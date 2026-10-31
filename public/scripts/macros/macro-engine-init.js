import { initMacroLexer } from './engine/MacroLexer.js';
import { initMacroParser } from './engine/MacroParser.js';
import { setMacroLibraries } from './engine/MacroLibraries.js';
import { registerCoreMacros } from './definitions/core-macros.js';
import { registerEnvMacros } from './definitions/env-macros.js';
import { registerStateMacros } from './definitions/state-macros.js';
import { registerChatMacros } from './definitions/chat-macros.js';
import { registerTimeMacros } from './definitions/time-macros.js';
import { registerVariableMacros } from './definitions/variable-macros.js';
import { registerInstructMacros } from './definitions/instruct-macros.js';

/**
 * @typedef {object} MacroEngineLibraries
 * @property {typeof import('chevrotain')} chevrotain
 * @property {typeof import('moment')} moment
 * @property {any} seedrandom
 * @property {any} droll
 * @property {(timestamp: string|number) => import('moment').Moment} timestampToMoment
 */

/**
 * @param {MacroEngineLibraries} libraries
 */
export function initMacroEngine({ chevrotain, ...libraries }) {
    setMacroLibraries(libraries);
    initMacroLexer(chevrotain);
    initMacroParser(chevrotain);
}

let registered = false;

export function registerBuiltinMacros() {
    if (registered) return;
    registered = true;
    registerCoreMacros();
    registerEnvMacros();
    registerStateMacros();
    registerChatMacros();
    registerTimeMacros();
    registerVariableMacros();
    registerInstructMacros();
}
