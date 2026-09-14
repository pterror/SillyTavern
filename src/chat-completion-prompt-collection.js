import { substituteParams } from './macro-substitution.js';

/**
 * Server-side port of public/scripts/PromptManager.js's `Prompt`/`PromptCollection` classes plus the
 * user-configurable prompt-ORDERING mechanism (`PromptManager.getPromptCollection` and the handful of
 * lookup helpers it depends on: `getPromptOrderForCharacter`, `getPromptById`, `getPromptOrderEntry`,
 * `isPromptDisabledForActiveCharacter`, `shouldTrigger`, `preparePrompt`). This is the piece flagged by
 * earlier ports (src/chat-completion-budget.js, src/chat-completion-injection-prompts.js) as needing its
 * own investigation before `populateChatCompletion`/`populateChatHistory` can be attempted.
 *
 * Real settings shape (verified against default/content/settings.json, not re-derived):
 * - `oai_settings.prompts` is a flat array of raw prompt definitions:
 *   `[{ name, system_prompt, role, content, identifier }, ...]`.
 * - `oai_settings.prompt_order` is an array of per-character order lists:
 *   `[{ character_id, order: [{identifier, enabled}, ...] }, ...]`.
 *   `character_id: 100000` is the "dummy id" used for the global/non-per-character ordering strategy
 *   (see `PromptManager.js`'s `configuration.promptOrder.dummyId`) - it is just an ordinary entry from
 *   this module's point of view, since every lookup here only ever compares `String(character_id)`.
 *
 * DIFFERENCE FROM THE CLIENT, BY DESIGN ("caller resolves entities"): every client method below reads
 * `this.activeCharacter`/`this.serviceSettings` off the `PromptManager` instance and calls
 * `this.getActiveGroupCharacters()` (which itself reads `this.activeCharacter?.group?.members`) to
 * derive group member names. None of that ambient state exists server-side, and only `character.id` is
 * ever read off the character object anywhere in the ported logic - so every function here takes
 * `characterId`/`prompts`/`promptOrder`/`groupMemberNames` as explicit parameters instead.
 * `groupMemberNames` in particular is the ALREADY-COMPUTED list `getActiveGroupCharacters()` would have
 * produced (member filenames with their extension stripped) - this module does not resolve group
 * membership itself.
 *
 * JUDGMENT CALL - `marker` field (independently verified, not taken on faith from prior research): the
 * `Prompt` class JSDoc (PromptManager.js ~line 159-163) documents a `marker` property ("Indicates if the
 * prompt is a marker prompt"), and the class even declares a bare `marker;` field. But the constructor's
 * destructuring parameter list -
 *   `constructor({ identifier, role, content, name, system_prompt, position, injection_depth,
 *   injection_position, forbid_overrides, extension, injection_order, injection_trigger } = {})`
 * (PromptManager.js ~line 182) - does NOT include `marker` anywhere, and the constructor body never
 * references `this.marker` either. So `new Prompt({ marker: true, ... })` silently drops the `marker`
 * value; every `Prompt` instance's `.marker` is permanently `undefined` (JS class fields declared with
 * no initializer default to `undefined`, and nothing ever assigns to it later - confirmed by grepping
 * the rest of PromptManager.js for `.marker` and `this.marker`, which only appear in the JSDoc comment
 * and the empty field declaration, never in a read/write). This is genuinely dead code on the client,
 * not merely unused by this port - it is not carried over here, and `marker` is omitted from `Prompt`'s
 * fields and constructor below.
 *
 * JUDGMENT CALL - `preparePrompt`'s substituteParams context translation: the client's four-branch
 * `preparePrompt(prompt, original = null)` (PromptManager.js ~1310-1323) passes `{ original,
 * groupOverride: groupMembers.join(', ') }`-shaped option objects to the client's `substituteParams`.
 * The ALREADY-PORTED `substituteParams(content, context)` in src/macro-substitution.js has no
 * `groupOverride` context field - its `SubstituteParamsContext` typedef instead has a `group` field
 * documented as "Explicit {{group}}/{{charIfNotGroup}} value override", which is exactly what the
 * client's `groupOverride` macro option resolves to on the client (`{{group}}`/`{{charIfNotGroup}}` are
 * the only macros `groupOverride` affects - see macros.js's evaluateMacros, which reads
 * `params.groupOverride` only for those two tags). So this port translates the client's `groupOverride`
 * key to the ported module's `group` key one-for-one; `original` carries over unchanged as both sides
 * use that exact name for the exact same one-shot-then-empties-itself `{{original}}` macro semantics.
 *
 * JUDGMENT CALL - `getPromptCollection` statement order (independently re-read, not assumed):
 * `allowedTrigger` is computed BEFORE the `if (!prompt) return;` guard - reading
 * `entry.enabled && this.shouldTrigger(prompt, generationType)` when `prompt` is `undefined` is safe
 * only because `shouldTrigger` itself guards with `prompt?.injection_trigger`, never dereferencing
 * `prompt` unguarded. The missing-prompt skip (`if (!prompt) return;`, i.e. `continue` to the next
 * order entry) happens strictly before both the `if (allowedTrigger)` branch and the
 * `else if (entry.identifier === 'main')` fallback branch, so a `main` order entry with no matching
 * prompt definition is skipped entirely (no blank-content replacement is synthesized for it) - the
 * main-fallback only fires when a `main`-identified prompt DOES exist but its order entry was disabled
 * or trigger-mismatched. All of this order is preserved exactly below.
 *
 * @typedef {object} PromptOrderEntry
 * @property {string} identifier
 * @property {boolean} enabled
 *
 * @typedef {object} PromptOrderList
 * @property {string|number} character_id
 * @property {PromptOrderEntry[]} order
 *
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

/** @enum {number} Mirrors public/scripts/PromptManager.js's INJECTION_POSITION. */
export const INJECTION_POSITION = {
    RELATIVE: 0,
    ABSOLUTE: 1,
};

/**
 * Server-side port of public/scripts/PromptManager.js's `Prompt` class. Ported verbatim, minus the
 * dead `marker` field - see the module doc comment's JUDGMENT CALL above.
 */
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

/**
 * Server-side port of public/scripts/PromptManager.js's `PromptCollection` class. Ported verbatim,
 * including the exact validation error message.
 */
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
     * @throws Will throw an error if one or more instances are not of the Prompt class.
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
 * Server-side port of `PromptManager.getPromptOrderForCharacter(character)`. Takes `characterId`
 * instead of a character object since only `.id` is ever read; `!characterId` mirrors the client's
 * `!character` (both `undefined`/`null`/`0`/`''` fall through to `[]`, matching the client's falsy
 * check exactly - the client never receives a character with a falsy `.id` in practice, so this is not
 * a behavioral divergence).
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
 * Server-side port of `PromptManager.getPromptById(identifier)`.
 * @param {RawPrompt[]} prompts
 * @param {string} identifier
 * @returns {RawPrompt|null}
 */
export function getPromptById(prompts, identifier) {
    return prompts.find(item => item && item.identifier === identifier) ?? null;
}

/**
 * Server-side port of `PromptManager.getPromptOrderEntry(character, identifier)`.
 * @param {PromptOrderList[]} promptOrder
 * @param {string|number} characterId
 * @param {string} identifier
 * @returns {PromptOrderEntry|null}
 */
export function getPromptOrderEntry(promptOrder, characterId, identifier) {
    return getPromptOrderForCharacter(promptOrder, characterId).find(entry => entry.identifier === identifier) ?? null;
}

/**
 * Server-side port of `PromptManager.isPromptDisabledForActiveCharacter(identifier)`.
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
 * Server-side port of `PromptManager.shouldTrigger(prompt, generationType)`.
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
 * Server-side port of `PromptManager.preparePrompt(prompt, original = null)`. See the module doc
 * comment's JUDGMENT CALL above for the exact `groupOverride` -> `group` context-key translation.
 * @param {RawPrompt} prompt
 * @param {object} [options]
 * @param {string} [options.original] Mirrors the client's `original` parameter (only used when a string).
 * @param {string[]} [options.groupMemberNames] Mirrors the client's already-resolved `getActiveGroupCharacters()` result.
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [options.macroContext] Extra context merged into every substituteParams() call (e.g. name1/name2/characterCard) - neither the client's original method nor this port require it, but downstream callers need somewhere to plumb ambient macro context through.
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
 * Server-side port of `PromptManager.getPromptCollection(generationType)`. See the module doc
 * comment's JUDGMENT CALL above for independently-reverified statement-order details.
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
            // Some extensions require main prompt to be present for relative inserts.
            // So we make a GMO-free vegan replacement.
            const replacementPrompt = structuredClone(prompt);
            replacementPrompt.content = '';
            promptCollection.add(preparePrompt(replacementPrompt, { groupMemberNames, macroContext }));
        }
    });

    return promptCollection;
}
