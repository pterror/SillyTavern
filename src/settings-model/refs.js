import { TYPE } from '../library-codes.js';
import { bookKey } from '../world-info-keys.js';
import { PRESET_PART_LISTS } from './sampler-presets.js';

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

/** Each type's values that are refs: field → the type it names. */
export const REF_VALUES = Object.freeze({
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
