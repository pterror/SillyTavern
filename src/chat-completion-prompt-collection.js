import { substituteParams } from './macro-substitution.js';

/**
 * @typedef {object} PromptOrderEntry
 * @property {string} identifier
 * @property {boolean} enabled
 * @typedef {object} PromptOrderList
 * @property {string|number} character_id
 * @property {PromptOrderEntry[]} order
 * @typedef {object} RawPrompt
 * @property {string} [identifier]
 * @property {string} [role]
 * @property {string} [content]
 * @property {string} [name]
 * @property {boolean} [system_prompt]
 * @property {string|number} [position]
 * @property {number} [injection_depth]
 * @property {number} [injection_position]
 * @property {number} [injection_order]
 * @property {boolean} [forbid_overrides]
 * @property {boolean} [extension]
 * @property {string[]} [injection_trigger]
 */

const DEFAULT_ORDER = 100;

/** @enum {number} */
export const INJECTION_POSITION = {
    RELATIVE: 0,
    ABSOLUTE: 1,
};

export class Prompt {
    /** @type {boolean} */
    enabled;

    /** @type {string} */
    identifier;

    /** @type {string} */
    role;

    /** @type {string} */
    content;

    /** @type {string} */
    name;

    /** @type {boolean} */
    system_prompt;

    /** @type {string|number} */
    position;

    /** @type {number} */
    injection_position;

    /** @type {number} */
    injection_depth;

    /** @type {number} */
    injection_order;

    /** @type {boolean} */
    forbid_overrides;

    /** @type {boolean} */
    extension;

    /** @type {string[]} */
    injection_trigger;

    /**
     * @param {RawPrompt} [param0]
     */
    constructor({ identifier, role, content, name, system_prompt, position, injection_depth, injection_position, forbid_overrides, extension, injection_order, injection_trigger } = {}) {
        this.identifier = identifier;
        this.role = role;
        this.content = content;
        this.name = name;
        this.system_prompt = system_prompt;
        this.position = position;
        this.injection_depth = injection_depth;
        this.injection_position = injection_position;
        this.forbid_overrides = forbid_overrides;
        this.extension = extension ?? false;
        this.injection_order = injection_order ?? DEFAULT_ORDER;
        this.injection_trigger = injection_trigger ?? [];
    }
}

export class PromptCollection {
    /** @type {Prompt[]} */
    collection = [];

    /** @type {string[]} */
    overriddenPrompts = [];

    /**
     * @param {...Prompt} prompts
     */
    constructor(...prompts) {
        this.add(...prompts);
    }

    /**
     * @param {...Prompt} prompts
     * @throws
     */
    checkPromptInstance(...prompts) {
        for (let prompt of prompts) {
            if (!(prompt instanceof Prompt)) {
                throw new Error('Only Prompt instances can be added to PromptCollection');
            }
        }
    }

    /**
     * @param {...Prompt} prompts
     */
    add(...prompts) {
        this.checkPromptInstance(...prompts);
        this.collection.push(...prompts);
    }

    /**
     * @param {Prompt} prompt
     * @param {number} position
     */
    set(prompt, position) {
        this.checkPromptInstance(prompt);
        this.collection[position] = prompt;
    }

    /**
     * @param {string} identifier
     * @returns {Prompt|undefined}
     */
    get(identifier) {
        return this.collection.find(prompt => prompt.identifier === identifier);
    }

    /**
     * @param {string} identifier
     * @returns {number}
     */
    index(identifier) {
        return this.collection.findIndex(prompt => prompt.identifier === identifier);
    }

    /**
     * @param {string} identifier
     * @returns {boolean}
     */
    has(identifier) {
        return this.index(identifier) !== -1;
    }

    /**
     * @param {Prompt} prompt
     * @param {number} position
     */
    override(prompt, position) {
        this.set(prompt, position);
        this.overriddenPrompts.push(prompt.identifier);
    }
}

/**
 * @param {PromptOrderList[]} promptOrder
 * @param {string|number} characterId
 * @returns {PromptOrderEntry[]}
 */
export function getPromptOrderForCharacter(promptOrder, characterId) {
    if (!characterId) return [];

    const entry = promptOrder.find(list => String(list.character_id) === String(characterId));
    return entry ? (entry.order ?? []) : [];
}

/**
 * @param {RawPrompt[]} prompts
 * @param {string} identifier
 * @returns {RawPrompt|null}
 */
export function getPromptById(prompts, identifier) {
    return prompts.find(item => item && item.identifier === identifier) ?? null;
}

/**
 * @param {PromptOrderList[]} promptOrder
 * @param {string|number} characterId
 * @param {string} identifier
 * @returns {PromptOrderEntry|null}
 */
export function getPromptOrderEntry(promptOrder, characterId, identifier) {
    return getPromptOrderForCharacter(promptOrder, characterId).find(entry => entry.identifier === identifier) ?? null;
}

/**
 * @param {PromptOrderList[]} promptOrder
 * @param {string|number} characterId
 * @param {string} identifier
 * @returns {boolean}
 */
export function isPromptDisabledForCharacter(promptOrder, characterId, identifier) {
    const entry = getPromptOrderEntry(promptOrder, characterId, identifier);
    if (entry) return !entry.enabled;
    return false;
}

/**
 * @param {RawPrompt|Prompt|null|undefined} prompt
 * @param {string} generationType
 * @returns {boolean}
 */
export function shouldTrigger(prompt, generationType) {
    if (!Array.isArray(prompt?.injection_trigger)) return true;
    if (!prompt.injection_trigger.length) return true;
    return prompt.injection_trigger.includes(generationType);
}

/**
 * @param {RawPrompt} prompt
 * @param {object} [options]
 * @param {string} [options.original]
 * @param {string[]} [options.groupMemberNames]
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [options.macroContext]
 * @returns {Prompt}
 */
export function preparePrompt(prompt, { original = null, groupMemberNames = [], macroContext = {} } = {}) {
    const preparedPrompt = new Prompt(prompt);

    if (typeof original === 'string') {
        if (groupMemberNames.length > 0) preparedPrompt.content = substituteParams(prompt.content ?? '', { ...macroContext, original, group: groupMemberNames.join(', ') });
        else preparedPrompt.content = substituteParams(prompt.content, { ...macroContext, original });
    } else {
        if (groupMemberNames.length > 0) preparedPrompt.content = substituteParams(prompt.content ?? '', { ...macroContext, group: groupMemberNames.join(', ') });
        else preparedPrompt.content = substituteParams(prompt.content, macroContext);
    }

    return preparedPrompt;
}

/**
 * @param {object} params
 * @param {RawPrompt[]} params.prompts
 * @param {PromptOrderList[]} params.promptOrder
 * @param {string|number} params.characterId
 * @param {string} [params.generationType]
 * @param {string[]} [params.groupMemberNames]
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [params.macroContext]
 * @returns {PromptCollection}
 */
export function getPromptCollection({ prompts, promptOrder, characterId, generationType, groupMemberNames = [], macroContext = {} }) {
    generationType = String(generationType || 'normal').toLowerCase().trim();
    const promptCollection = new PromptCollection();
    const order = getPromptOrderForCharacter(promptOrder, characterId);

    order.forEach(entry => {
        const prompt = getPromptById(prompts, entry.identifier);
        const allowedTrigger = entry.enabled && shouldTrigger(prompt, generationType);

        if (!prompt) {
            return;
        }

        if (allowedTrigger) {
            promptCollection.add(preparePrompt(prompt, { groupMemberNames, macroContext }));
        } else if (entry.identifier === 'main') {
            const replacementPrompt = structuredClone(prompt);
            replacementPrompt.content = '';
            promptCollection.add(preparePrompt(replacementPrompt, { groupMemberNames, macroContext }));
        }
    });

    return promptCollection;
}
