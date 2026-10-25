import {
    name2, getCharacterCardFieldsLazy, getGeneratingModel, getCurrentChatId, getMaxPromptTokens, getMaxContextTokens,
    getMaxResponseTokens, extension_prompts, parseMesExamples,
} from '../../../script.js';
import { name1 } from '../../app-selection-state.js';
import { charactersStore } from '../../character-store.js';
import { groupsStore, selected_group } from '../../../scripts/group-chats.js';
import { chat, chat_metadata } from '../../chat-state.js';
import { main_api } from '../../generation-params.js';
import { power_user } from '../../power-user.js';
import { formatInstructModeExamples } from '../../instruct-mode.js';
import { isMobile } from '../../RossAscends-mods.js';
import { findExtension } from '../../extensions.js';
import { localVariables, globalVariables } from '../../variables.js';
import { inject_ids } from '../../constants.js';
import { textgenerationwebui_banned_in_macros } from '../../textgen-settings.js';
import { eventSource, event_types } from '../../events.js';
import { logMacroGeneralError } from './MacroDiagnostics.js';
import { getStringHash } from '../../hash-utils.js';
/**
 * Constructs the MacroEnv object passed to macro handlers on the page, from the page's state. The server builds its
 * own from a request's (src/macro-substitution.js).
 */

/** The type of the last generation queued, for {{lastGenerationType}}; forgotten when the chat changes. */
let lastGenerationType = '';
eventSource.on(event_types.GENERATION_STARTED, (type, _params, isDryRun) => {
    if (!isDryRun) lastGenerationType = type || 'normal';
});
eventSource.on(event_types.CHAT_CHANGED, () => {
    lastGenerationType = '';
});

/**
 * The dialogue examples as the prompt has them: formatted for instruct mode when it is on.
 * @param {string} raw
 * @param {string} user
 * @param {string} char
 */
function formatMesExamples(raw, user, char) {
    if (!raw) return '';
    const isInstruct = !!power_user?.instruct?.enabled && main_api !== 'openai';
    const parsed = parseMesExamples(raw, isInstruct);
    if (!Array.isArray(parsed) || parsed.length === 0) return '';
    if (!isInstruct) return parsed.join('');
    const formatted = formatInstructModeExamples(parsed, user, char);
    return Array.isArray(formatted) ? formatted.join('') : '';
}

/**
 * What the macros read of the page, each read when a macro reads it.
 * @returns {import('./MacroEnv.types.js').MacroEnvState}
 */
function pageState() {
    return {
        get chat() { return chat; },
        get chatMetadata() { return chat_metadata; },
        get chatId() { return getCurrentChatId(); },
        variables: { local: localVariables, global: globalVariables },
        get input() { return /** @type {HTMLTextAreaElement} */ (document.querySelector('#send_textarea'))?.value ?? ''; },
        get firstDisplayedMessageId() {
            const mesId = Number(document.querySelector('#chat .mes')?.getAttribute('mesid'));
            return !Number.isNaN(mesId) && mesId >= 0 ? mesId : null;
        },
        get maxPromptTokens() { return getMaxPromptTokens(); },
        get maxContextTokens() { return getMaxContextTokens(); },
        get maxResponseTokens() { return getMaxResponseTokens(); },
        get mainApi() { return main_api; },
        get bannedWords() { return main_api === 'textgenerationwebui' ? textgenerationwebui_banned_in_macros : undefined; },
        outlet: key => extension_prompts[inject_ids.CUSTOM_WI_OUTLET(key)]?.value ?? '',
        get isMobile() { return isMobile(); },
        get lastGenerationType() { return lastGenerationType; },
        hasExtension: name => !!findExtension(name)?.enabled,
        get instruct() { return power_user.instruct; },
        get sysprompt() { return power_user.sysprompt; },
        get context() { return power_user.context; },
        get preferCharacterPrompt() { return !!power_user.prefer_character_prompt; },
    };
}

/** @typedef {import('./MacroEnv.types.js').MacroEnv} MacroEnv */

/**
 * @typedef {Object} MacroEnvRawContext
 * @property {string} content
 * @property {string|null} [name1Override]
 * @property {string|null} [name2Override]
 * @property {string|null} [original]
 * @property {string|null} [groupOverride]
 * @property {boolean} [replaceCharacterCard]
 * @property {Record<string, import('./MacroEnv.types.js').DynamicMacroValue>|null} [dynamicMacros]
 * @property {(value: string, macro?: MacroIdentity) => string} [postProcessFn] Run on each macro's value; given which
 * macro it is.
 */

/**
 * @typedef {object} MacroIdentity Which macro a value is from.
 * @property {string} name
 * @property {string} [category] Its category in the registry (MacroCategory), if it is registered.
 * @property {string} [source] Its text as written, `{{…}}` (macros nested in it already filled in).
 */

/**
 * @typedef {(env: MacroEnv, ctx: MacroEnvRawContext) => void} MacroEnvProvider
 */

/**
 * @enum {number} Exposed ordering buckets for providers. Callers can use envBuilder.providerOrder.* when registering providers.
 */
export const env_provider_order = {
    EARLIEST: 0,
    EARLY: 10,
    NORMAL: 50,
    LATE: 90,
    LATEST: 100,
};

/** @type {MacroEnvBuilder} */
let instance;
export { instance as MacroEnvBuilder };

class MacroEnvBuilder {
    /** @type {MacroEnvBuilder} */ static #instance;
    /** @type {MacroEnvBuilder} */ static get instance() { return MacroEnvBuilder.#instance ?? (MacroEnvBuilder.#instance = new MacroEnvBuilder()); }

    /** @type {{ fn: MacroEnvProvider, order: env_provider_order }[]} */
    #providers;

    constructor() {
        this.#providers = [];
    }

    /**
     * Registers a provider that can augment the MacroEnv with additional
     * data (for extensions, extra context, etc.).
     *
     * Should be called once during initialization.
     *
     * @param {MacroEnvProvider} provider
     * @param {env_provider_order} [order=env_provider_order.NORMAL]
     * @returns {void}
     */
    registerProvider(provider, order = env_provider_order.NORMAL) {
        if (typeof provider !== 'function') throw new Error('Provider must be a function');
        this.#providers.push({ fn: provider, order });
    }

    /**
     * Builds a MacroEnv from the raw arguments that are conceptually the
     * same as substituteParams receives, plus a bundle of global helpers.
     *
     * @param {MacroEnvRawContext} ctx
     * @returns {MacroEnv}
     */
    buildFromRawEnv(ctx) {
        /** @type {MacroEnv} */
        const env = {
            content: ctx.content,
            contentHash: getStringHash(ctx.content),
            names: { user: '', char: '', group: '', groupNotMuted: '', notChar: '' },
            character: {},
            system: { model: '' },
            functions: { postProcess: (x) => x },
            state: pageState(),
            dynamicMacros: {},
            extra: {},
        };

        if (ctx.replaceCharacterCard) {
            const fields = getCharacterCardFieldsLazy();
            if (fields) {
                const fieldMappings = /** @type {const} */ ([
                    ['charPrompt', 'system'],
                    ['charInstruction', 'jailbreak'],
                    ['description', 'description'],
                    ['personality', 'personality'],
                    ['scenario', 'scenario'],
                    ['persona', 'persona'],
                    ['mesExamplesRaw', 'mesExamples'],
                    ['mesExamples', 'mesExamples'],
                    ['version', 'version'],
                    ['charDepthPrompt', 'charDepthPrompt'],
                    ['creatorNotes', 'creatorNotes'],
                    ['firstMessage', 'firstMessage'],
                    ['alternateGreetings', 'alternateGreetings'],
                ]);
                for (const [envKey, fieldKey] of fieldMappings) {
                    Object.defineProperty(env.character, envKey, {
                        get() {
                            const value = fields[fieldKey];
                            // alternateGreetings should default to [] instead of ''
                            if (envKey === 'alternateGreetings') {
                                return Array.isArray(value) ? value : [];
                            }
                            if (envKey === 'mesExamples') {
                                return formatMesExamples(value || '', env.names.user, env.names.char);
                            }
                            return value || '';
                        },
                        enumerable: true,
                        configurable: true,
                    });
                }
            }
        }

        env.names.user = ctx.name1Override ?? name1 ?? '';
        env.names.char = ctx.name2Override ?? name2 ?? '';
        env.names.group = getGroupValue(ctx, { currentChar: env.names.char, includeMuted: true });
        env.names.groupNotMuted = getGroupValue(ctx, { currentChar: env.names.char, includeMuted: false });
        env.names.notChar = getGroupValue(ctx, { currentChar: env.names.char, filterOutChar: true, includeUser: env.names.user });

        env.system.model = getGeneratingModel();

        // env.functions.original resolves once then returns empty on subsequent calls
        if (typeof ctx.original === 'string') {
            let originalSubstituted = false;
            env.functions.original = () => {
                if (originalSubstituted) return '';
                originalSubstituted = true;
                return ctx.original;
            };
        }
        env.functions.postProcess = typeof ctx.postProcessFn === 'function' ? ctx.postProcessFn : (x) => x;

        // Keys normalized to lowercase for case-insensitive matching
        if (ctx.dynamicMacros && typeof ctx.dynamicMacros === 'object') {
            for (const [key, value] of Object.entries(ctx.dynamicMacros)) {
                env.dynamicMacros[key.toLowerCase()] = value;
            }
        }

        const orderedProviders = this.#providers.slice().sort((a, b) => a.order - b.order);
        for (const { fn } of orderedProviders) {
            try {
                fn(env, ctx);
            } catch (e) {
                // Provider errors should not break macro evaluation
                logMacroGeneralError({ message: 'MacroEnvBuilder: Provider error', error: e });
            }
        }

        return env;
    }
}

instance = MacroEnvBuilder.instance;

/**
 * @param {MacroEnvRawContext} ctx
 * @param {Object} options
 * @param {string} [options.currentChar=null]
 * @param {boolean} [options.includeMuted=false]
 * @param {boolean} [options.filterOutChar=false]
 * @param {string|null} [options.includeUser=null]
 * @returns {string}
 */
function getGroupValue(ctx, { currentChar = null, includeMuted = false, filterOutChar = false, includeUser = null }) {
    if (typeof ctx.groupOverride === 'string') {
        return ctx.groupOverride;
    }

    if (!selected_group) return filterOutChar ? (includeUser || '') : (currentChar ?? '');

    const groupEntry = groupsStore.get(selected_group);
    const members = /** @type {string[]} */ (groupEntry?.members ?? []);
    const disabledMembers = /** @type {string[]} */ (groupEntry?.disabled_members ?? []);

    const names = Array.isArray(members)
        ? members
            .filter(((id) => includeMuted ? true : !disabledMembers.includes(id)))
            .map(m => charactersStore.get(m))
            .filter(c => !!c && typeof c.name === 'string')
            .filter(c => !filterOutChar || c.name !== currentChar)
            .map(c => c.name)
            .join(', ')
        : '';

    return names;
}
