import { TYPE } from '../library-codes.js';
import { bookKey } from '../world-info-keys.js';
import { PRESET_PART_LISTS } from './sampler-presets.js';
import { CAPABILITY_SLOTS } from './capabilities.js';

/**
 * What the store needs to know of each settings entity type beyond its values (the settings model §1): which lists
 * hold parts, and which values and list items are refs to other entities. A ref is stored as the entity's id
 * (decimal text), so a rename follows it; the modules name it by key, translated at the store.
 */

/** Each type's lists that hold parts (each item an entity of its own): list number → the parts' type. */
export const PART_LISTS = Object.freeze({
    [TYPE.samplerPreset]: Object.freeze({
        [PRESET_PART_LISTS.bias]: TYPE.biasEntry, [PRESET_PART_LISTS.prompts]: TYPE.chatPrompt, [PRESET_PART_LISTS.orders]: TYPE.chatPromptOrder,
    }),
    [TYPE.biasList]: Object.freeze({ 0: TYPE.biasEntry }),
    [TYPE.quickReplySet]: Object.freeze({ 0: TYPE.quickReply }),
});

/** The user record's ordered lists (an entity has lists 0-7): each a list of refs. */
export const USER_LISTS = Object.freeze({
    regexScripts: 0, regexPresets: 1, proxies: 2, dataBank: 3, quickReplySets: 4, quickReplyHidden: 5,
    // The characters and groups whose statements (STATEMENT_PREFIX values) the user made.
    characters: 6, groups: 7,
});

/** The bundle groups' types: a bundle statement names an entity of it. */
export const BUNDLE_TYPES = Object.freeze({
    'preset.openai': TYPE.samplerPreset, 'preset.textgenerationwebui': TYPE.samplerPreset, 'preset.novel': TYPE.samplerPreset,
    'preset.kobold': TYPE.samplerPreset, 'template.instruct': TYPE.template, 'template.context': TYPE.template,
    'template.sysprompt': TYPE.template, 'template.reasoning': TYPE.template, 'theme': TYPE.theme,
});

/** Types a ref never makes a placeholder of: a name naming none is dropped, warned (a placeholder would be a card). */
export const NO_PLACEHOLDER = Object.freeze(new Set([TYPE.character, TYPE.group]));

/** Each type's values that are refs: field → the type it names. */
export const REF_VALUES = Object.freeze({
    [TYPE.user]: Object.freeze({
        ...Object.fromEntries(Object.entries(BUNDLE_TYPES).map(([group, type]) => [`b:${group}`, type])),
        's:textGeneration': TYPE.connection, 's:remembered.openai': TYPE.connection, 's:remembered.textgenerationwebui': TYPE.connection,
        ...Object.fromEntries(CAPABILITY_SLOTS.map(slot => [`s:capability.${slot}`, TYPE.connection])),
        's:proxy': TYPE.proxy, 's:profile': TYPE.connectionProfile, 's:persona': TYPE.persona, 's:regexPreset': TYPE.regexPreset,
    }),
    [TYPE.samplerPreset]: Object.freeze({ connection: TYPE.connection }),
    [TYPE.connectionProfile]: Object.freeze({
        connection: TYPE.connection, proxy: TYPE.proxy, 'regex-preset': TYPE.regexPreset, preset: TYPE.samplerPreset,
        instruct: TYPE.template, context: TYPE.template, sysprompt: TYPE.template, 'reasoning-template': TYPE.template,
    }),
    [TYPE.modelTemplateBinding]: Object.freeze({ instruct: TYPE.template, context: TYPE.template }),
    [TYPE.persona]: Object.freeze({ lorebook: TYPE.book }),
});

/** Each type's text lists whose items are refs: list number → the type they name. */
export const REF_LISTS = Object.freeze({
    [TYPE.user]: Object.freeze({
        [USER_LISTS.regexScripts]: TYPE.regexScript, [USER_LISTS.regexPresets]: TYPE.regexPreset, [USER_LISTS.proxies]: TYPE.proxy,
        [USER_LISTS.dataBank]: TYPE.dataBankFile, [USER_LISTS.quickReplySets]: TYPE.quickReplySet, [USER_LISTS.quickReplyHidden]: TYPE.quickReplySet,
        [USER_LISTS.characters]: TYPE.character, [USER_LISTS.groups]: TYPE.group,
    }),
    [TYPE.regexPreset]: Object.freeze({ 0: TYPE.regexScript, 1: TYPE.regexScript, 2: TYPE.regexScript }),
    [TYPE.quickReply]: Object.freeze({ 0: TYPE.quickReplySet, 1: TYPE.quickReplySet }),
});

/**
 * The key a ref's name finds an entity of `type` by: a book's is the stem of its file name (bookKey), any other's
 * the name itself.
 * @param {number} type
 * @param {string} name
 */
export function refKey(type, name) {
    return type === TYPE.book ? bookKey(name) : name;
}
