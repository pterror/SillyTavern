import { describe, test, expect, jest, beforeAll } from '@jest/globals';

// The {{original}} macro (public/scripts/macros/definitions/env-macros.js) and the
// engine that drives it (public/scripts/macros/engine/*) reach transitively into
// script.js, group-chats.js, utils.js, and a handful of other browser-flavored
// modules. None of that is relevant to the bug under test, so it's stubbed out here
// and only the real macro engine + env-macros module are exercised.

jest.unstable_mockModule('../public/script.js', () => ({
    chat: [],
    chat_metadata: {},
    main_api: 'openai',
    getMaxPromptTokens: () => 4096,
    getMaxContextTokens: () => 4096,
    getMaxResponseTokens: () => 512,
    extension_prompts: {},
    getCurrentChatId: () => undefined,
    name1: 'User',
    name2: 'Character',
    charactersStore: { get: () => undefined },
    getCharacterCardFieldsLazy: () => null,
    getGeneratingModel: () => '',
    parseMesExamples: () => [],
}));

jest.unstable_mockModule('../public/lib.js', async () => {
    const chevrotain = await import('chevrotain');
    return {
        chevrotain,
        seedrandom: () => () => 0.5,
        droll: { roll: () => ({ total: 0 }) },
    };
});

const utilsMockFactory = async () => {
    const { getStringHash } = await import('../public/scripts/hash-utils.js');
    return {
        getStringHash,
        isTrueBoolean: (arg) => ['on', 'true', '1'].includes(arg?.trim()?.toLowerCase()),
        isFalseBoolean: (arg) => ['off', 'false', '0'].includes(arg?.trim()?.toLowerCase()),
    };
};

// utils.js is imported both by relative path (MacroRegistry.js, core-macros.js) and by
// the absolute in-app path (MacroEnvBuilder.js, MacroCstWalker.js). The jest config maps
// the "/scripts/..." form back to the same file on disk, so mocking the relative path
// here covers both.
jest.unstable_mockModule('../public/scripts/utils.js', utilsMockFactory);

jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    textgenerationwebui_banned_in_macros: [],
}));

jest.unstable_mockModule('../public/scripts/constants.js', () => ({
    inject_ids: {},
}));

jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    isMobile: () => false,
}));

jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: {},
}));

jest.unstable_mockModule('../public/scripts/instruct-mode.js', () => ({
    formatInstructModeExamples: () => [],
}));

jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    groupsStore: { get: () => undefined },
    selected_group: null,
}));

jest.unstable_mockModule('../public/scripts/macros/engine/MacroDiagnostics.js', () => ({
    logMacroGeneralError: jest.fn(),
    logMacroInternalError: jest.fn(),
    logMacroRuntimeWarning: jest.fn(),
    logMacroSyntaxWarning: jest.fn(),
    logMacroRegisterError: jest.fn(),
    logMacroRegisterWarning: jest.fn(),
    createMacroRuntimeError: ({ message }) => {
        const error = new Error(message);
        error.name = 'MacroRuntimeError';
        error.isMacroRuntimeError = true;
        return error;
    },
}));

/** @type {import('../public/scripts/macros/engine/MacroEngine.js').MacroEngine} */
let MacroEngine;
/** @type {import('../public/scripts/macros/engine/MacroEnvBuilder.js').MacroEnvBuilder} */
let MacroEnvBuilder;
let registerEnvMacros;
let diagnostics;

beforeAll(async () => {
    ({ MacroEngine } = await import('../public/scripts/macros/engine/MacroEngine.js'));
    ({ MacroEnvBuilder } = await import('../public/scripts/macros/engine/MacroEnvBuilder.js'));
    ({ registerEnvMacros } = await import('../public/scripts/macros/definitions/env-macros.js'));
    diagnostics = await import('../public/scripts/macros/engine/MacroDiagnostics.js');
    registerEnvMacros();
});

function buildEnv(ctx = {}) {
    return MacroEnvBuilder.buildFromRawEnv({
        content: '{{original}}',
        replaceCharacterCard: false,
        dynamicMacros: {},
        postProcessFn: (x) => x,
        ...ctx,
    });
}

describe('{{original}} macro', () => {
    test('resolves to the provided original text when one is supplied', () => {
        const env = buildEnv({ original: 'hello from the original message' });
        const result = MacroEngine.evaluate('{{original}}', env);

        expect(result).toBe('hello from the original message');
        expect(diagnostics.logMacroInternalError).not.toHaveBeenCalled();
    });

    test('resolves to an empty string, instead of throwing, when no original text is in context', () => {
        // This is the RA_CountCharTokens path (RossAscends-mods.js) -> substituteParams(value)
        // (script.js) with no `original` option: ctx.original stays undefined, so
        // MacroEnvBuilder never defines env.functions.original. Evaluating {{original}}
        // used to call `undefined()` and throw a TypeError, logged by MacroDiagnostics as
        // "Macro \"original\" internal execution error." and left as unresolved "{{original}}"
        // literal text in the output.
        const env = buildEnv();
        const result = MacroEngine.evaluate('{{original}}', env);

        expect(result).toBe('');
        expect(diagnostics.logMacroInternalError).not.toHaveBeenCalled();
    });
});
