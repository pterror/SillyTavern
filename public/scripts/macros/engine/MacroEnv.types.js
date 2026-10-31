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
 * @property {string} [mesExamples] The dialogue examples formatted as the prompt has them (instruct mode or not).
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
 * @typedef {Object} MacroVariableScope
 * @property {(name: string, args?: { index?: string|number, key?: string }) => string|number} get
 * @property {(name: string, value: any, args?: { index?: string|number, as?: string }) => any} set
 * @property {(name: string) => string} del
 * @property {(name: string, value: any) => any} add
 * @property {(name: string) => any} inc
 * @property {(name: string) => any} dec
 * @property {(name: string) => boolean} has
 */

/**
 * @typedef {Object} MacroChatMessage
 * @property {string} [mes]
 * @property {boolean} [is_user]
 * @property {boolean} [is_system]
 * @property {string[]} [swipes]
 * @property {number} [swipe_id]
 * @property {string|number} [send_date]
 */

/**
 * @typedef {Object} MacroEnvState
 * @property {MacroChatMessage[]} [chat]
 * @property {Record<string, any>} [chatMetadata]
 * @property {string} [chatId]
 * @property {{ local: MacroVariableScope, global: MacroVariableScope }} [variables]
 * @property {string} [input]
 * @property {number|null} [firstDisplayedMessageId]
 * @property {number} [maxPromptTokens]
 * @property {number} [maxContextTokens]
 * @property {number} [maxResponseTokens]
 * @property {string} [mainApi]
 * @property {string[]} [bannedWords]
 * @property {(key: string) => string} [outlet]
 * @property {boolean} [isMobile]
 * @property {number} [utcOffset]
 * @property {string} [lastGenerationType]
 * @property {{ names: string[], disabled: string[] }} [extensions]
 * @property {Record<string, any>} [instruct]
 * @property {{ enabled?: boolean, content?: string }} [sysprompt]
 * @property {Record<string, any>} [context]
 * @property {boolean} [preferCharacterPrompt]
 */

/**
 * @typedef {Object} MacroEnvFunctions
 * @property {() => string} [original]
 * @property {(text: string, macro?: import('./MacroEnvBuilder.js').MacroIdentity) => string} postProcess
 */

/**
 * @typedef {Object} MacroEnv
 * @property {string} content - Same value as substituteParams's "content" param.
 * @property {number} contentHash - Hash of `content`, used for caching/comparison.
 * @property {MacroEnvNames} names
 * @property {MacroEnvCharacter} character
 * @property {MacroEnvSystem} system
 * @property {MacroEnvFunctions} functions
 * @property {MacroEnvState} state
 * @property {Object<string, DynamicMacroValue>} dynamicMacros
 * @property {Record<string, unknown>} extra
 */

export {};
