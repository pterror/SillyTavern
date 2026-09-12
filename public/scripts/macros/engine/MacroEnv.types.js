/** Typedefs only (no runtime code) so this can be imported for types without creating runtime dependencies. */

/** @typedef {import('./MacroRegistry.js').MacroHandler} MacroHandler */
/** @typedef {import('./MacroRegistry.js').MacroDefinitionOptions} MacroDefinitionOptions */

/** @typedef {string | MacroHandler | MacroDefinitionOptions} DynamicMacroValue */

/**
 * @typedef {Object} MacroEnvNames
 * @property {string} user
 * @property {string} char
 * @property {string} group
 * @property {string} groupNotMuted
 * @property {string} notChar
 */

/**
 * @typedef {Object} MacroEnvCharacter
 * @property {string} [description]
 * @property {string} [personality]
 * @property {string} [scenario]
 * @property {string} [persona]
 * @property {string} [charPrompt]
 * @property {string} [charInstruction]
 * @property {string} [mesExamplesRaw]
 * @property {string} [charDepthPrompt]
 * @property {string} [creatorNotes]
 * @property {string} [version]
 * @property {string} [firstMessage]
 * @property {string[]} [alternateGreetings]
 */

/**
 * @typedef {Object} MacroEnvSystem
 * @property {string} model
 */

/**
 * @typedef {Object} MacroEnvFunctions
 * @property {() => string} [original]
 * @property {(text: string) => string} postProcess
 */

/**
 * @typedef {Object} MacroEnv
 * @property {string} content - Same value as substituteParams's "content" param.
 * @property {number} contentHash - Hash of `content`, used for caching/comparison.
 * @property {MacroEnvNames} names
 * @property {MacroEnvCharacter} character
 * @property {MacroEnvSystem} system
 * @property {MacroEnvFunctions} functions
 * @property {Object<string, DynamicMacroValue>} dynamicMacros
 * @property {Record<string, unknown>} extra
 */

export {};
