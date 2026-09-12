import { MacroEngine } from './engine/MacroEngine.js';
import { MacroRegistry, MacroCategory, MacroValueType } from './engine/MacroRegistry.js';
import { MacroLexer } from './engine/MacroLexer.js';
import { MacroParser } from './engine/MacroParser.js';
import { MacroCstWalker } from './engine/MacroCstWalker.js';
import { MacroEnvBuilder } from './engine/MacroEnvBuilder.js';

import { registerCoreMacros } from './definitions/core-macros.js';
import { registerEnvMacros } from './definitions/env-macros.js';
import { registerStateMacros } from './definitions/state-macros.js';
import { registerChatMacros } from './definitions/chat-macros.js';
import { registerTimeMacros } from './definitions/time-macros.js';
import { registerVariableMacros } from './definitions/variable-macros.js';
import { registerInstructMacros } from './definitions/instruct-macros.js';

export { MacroCategory, MacroValueType };

/** @typedef {import('./engine/MacroRegistry.js').MacroDefinitionOptions} MacroDefinitionOptions */
/** @typedef {import('./engine/MacroRegistry.js').MacroDefinition} MacroDefinition */
/** @typedef {import('./engine/MacroRegistry.js').MacroUnnamedArgDef} MacroUnnamedArgDef */
/** @typedef {import('./engine/MacroRegistry.js').MacroListSpec} MacroListSpec */
/** @typedef {import('./engine/MacroRegistry.js').MacroHandler} MacroHandler */
/** @typedef {import('./engine/MacroRegistry.js').MacroExecutionContext} MacroExecutionContext */

/** @typedef {import('chevrotain').CstNode} CstNode */
/** @typedef {import('./engine/MacroEnv.types.js').MacroEnv} MacroEnv */
/** @typedef {import('./engine/MacroEnv.types.js').MacroEnvNames} MacroEnvNames */
/** @typedef {import('./engine/MacroEnv.types.js').MacroEnvCharacter} MacroEnvCharacter */
/** @typedef {import('./engine/MacroEnv.types.js').MacroEnvSystem} MacroEnvSystem */
/** @typedef {import('./engine/MacroEnv.types.js').MacroEnvFunctions} MacroEnvFunctions */

export const macros = {
    engine: MacroEngine,
    registry: MacroRegistry,
    envBuilder: MacroEnvBuilder,
    lexer: MacroLexer,
    parser: MacroParser,
    cstWalker: MacroCstWalker,

    category: MacroCategory,
    valueType: MacroValueType,

    register: MacroRegistry.registerMacro.bind(MacroRegistry),
    registerAlias: MacroRegistry.registerMacroAlias.bind(MacroRegistry),
};

let macrosRegistered = false;

export function initRegisterMacros() {
    if (macrosRegistered) return;
    macrosRegistered = true;

    registerCoreMacros();
    registerEnvMacros();
    registerStateMacros();
    registerChatMacros();
    registerTimeMacros();
    registerVariableMacros();
    registerInstructMacros();
}
