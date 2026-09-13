import { readCardContent } from './endpoints/characters.js';
import { getGroupsByIds } from './endpoints/groups.js';
import { baseChatReplace } from './macro-substitution.js';

/**
 * Server-side port of the client's character-card-field resolution:
 * public/script.js's getCharacterCardFieldsLazy()/getCharacterCardFields(), plus
 * public/scripts/group-chats.js's getGroupCharacterCardsLazy()/getGroupCharacterCards() for the
 * "combine all group members' cards" path used when a group's generation_mode makes cards append
 * rather than use a single active character.
 *
 * Unlike the client, this takes every piece of context explicitly instead of reading globals
 * (power_user settings, chat_metadata, the resident character/group stores) - same "explicit
 * context, no globals" pattern as src/macro-substitution.js and src/world-info/*.js.
 *
 * Laziness is deliberately NOT ported: the client memoizes each field behind a getter so an
 * unused field is never computed, but a single server request resolves every field anyway, so
 * createLazyFields() (public/script.js ~line 4431) has no server-side purpose.
 *
 * Judgment call: the client's baseChatReplace() calls for individual (non-group-combined) fields
 * pass no name overrides, which makes it fall back to the client's *global* name1/name2 (the
 * current persona's and current character's display names) - see public/script.js's
 * substituteParams() JSDoc ("Uses global name1 if not provided"). This module has no such global
 * and the deliverable signature below has no name1 (persona display name) parameter, so name1 is
 * left unset for every field here; name2 is set to the resolved character's own `name` (the
 * common case in a single-character chat, where the client's global name2 already equals the
 * active character's name). For the group-combined scenario/mesExamples chat_metadata overrides
 * specifically (which aren't tied to any one member), no name override is applied at all, mirroring
 * the ambiguity already present in the client (a group has no single "current" character name).
 */

/**
 * @typedef {import('./macro-substitution.js').CharacterCardFields} CharacterCardFields
 */

/**
 * Loads and JSON-parses a character card by avatar, tolerating a missing/unreadable card the same
 * way the client's `charactersStore.get(avatar)` tolerates a resident-store miss (returns null).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<object|null>}
 */
async function loadCharacter(directories, avatar) {
    if (!avatar) return null;
    try {
        const raw = await readCardContent(directories, avatar);
        if (raw === undefined) return null;
        return JSON.parse(raw);
    } catch (error) {
        console.error(`[character-card-fields] Failed to load character "${avatar}":`, error);
        return null;
    }
}

/**
 * Combines group members' cards into `{description, personality, scenario, mesExamples}`, or
 * returns `null` when the group shouldn't produce combined cards at all (matches
 * getGroupCharacterCardsLazy()'s null-means-"fall back to the single character" contract).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} group Group object, as read from disk (group.json shape)
 * @param {string} characterAvatar Avatar of the "current" character (exempts it from disabled-member filtering)
 * @param {object} chatMetadata
 * @returns {Promise<{description: string, personality: string, scenario: string, mesExamples: string}|null>}
 */
async function computeGroupCards(directories, group, characterAvatar, chatMetadata) {
    if (!group || !group.generation_mode || !Array.isArray(group.members) || !group.members.length) {
        return null;
    }

    const APPEND_DISABLED = 2; // group_generation_mode.APPEND_DISABLED, public/scripts/group-chats.js
    const disabledMembers = Array.isArray(group.disabled_members) ? group.disabled_members : [];

    /** @type {Map<string, object|null>} */
    const memberCache = new Map();
    async function getMember(memberAvatar) {
        if (memberCache.has(memberAvatar)) return memberCache.get(memberAvatar);
        const character = await loadCharacter(directories, memberAvatar);
        memberCache.set(memberAvatar, character);
        return character;
    }

    /**
     * Runs baseChatReplace on a text, with custom <FIELDNAME> replace, mirroring group-chats.js's
     * inner customTransform().
     */
    function customTransform(value, fieldName, characterName, trim) {
        if (!value) return '';
        value = value.replace(/<FIELDNAME>/gi, fieldName);
        value = trim ? value.trim() : value;
        return baseChatReplace(value, { name2: characterName });
    }

    /** Mirrors group-chats.js's inner replaceAndPrepareForJoin(). */
    function replaceAndPrepareForJoin(value, characterName, fieldName, preprocess = null) {
        value = value?.trim() ?? '';
        if (!value) return '';
        if (typeof preprocess === 'function') {
            value = preprocess(value);
        }
        const prefix = customTransform(group.generation_mode_join_prefix, fieldName, characterName, false);
        const suffix = customTransform(group.generation_mode_join_suffix, fieldName, characterName, false);
        value = customTransform(value, fieldName, characterName, true);
        return `${prefix}${value}${suffix}`;
    }

    /** Mirrors group-chats.js's inner collectField(). */
    async function collectField(fieldName, getter, preprocess = null) {
        const values = [];
        for (const member of group.members) {
            const character = await getMember(member);
            if (!character) continue;
            if (disabledMembers.includes(member) && characterAvatar !== member && group.generation_mode !== APPEND_DISABLED) {
                continue;
            }
            values.push(replaceAndPrepareForJoin(getter(character), character.name, fieldName, preprocess));
        }
        return values.filter(x => x.length).join('\n');
    }

    const scenarioOverride = String(chatMetadata?.scenario || '');
    const mesExamplesOverride = String(chatMetadata?.mes_example || '');

    const [description, personality] = await Promise.all([
        collectField('Description', c => c.description),
        collectField('Personality', c => c.personality),
    ]);

    // The chat_metadata override wins over the collected value - same short-circuit as the client's
    // lazy `() => baseChatReplace(x?.trim()) || collectField(...)` getters.
    const scenario = baseChatReplace(scenarioOverride.trim())
        || await collectField('Scenario', c => c.scenario);
    const mesExamples = baseChatReplace(mesExamplesOverride.trim())
        || await collectField('Example Messages', c => c.mes_example, x => (!x.startsWith('<START>') ? `<START>\n${x}` : x));

    return { description, personality, scenario, mesExamples };
}

/**
 * Returns the character card fields for a character (and, when applicable, its group), as a
 * plain object shaped for `SubstituteParamsContext.characterCard` (see
 * src/macro-substitution.js's `CharacterCardFields` JSDoc typedef).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} options
 * @param {string} [options.avatar] Character avatar (filename). No character -> every field resolves empty/default.
 * @param {string} [options.groupId] Group ID. Only used when `avatar` also resolves to a real character (matches
 * the client's `useGroupCards = selected_group && character`).
 * @param {boolean} [options.preferCharacterPrompt] Mirrors `power_user.prefer_character_prompt`.
 * @param {boolean} [options.preferCharacterJailbreak] Mirrors `power_user.prefer_character_jailbreak`.
 * @param {string} [options.personaDescription] Mirrors `power_user.persona_description`.
 * @param {object} [options.chatMetadata] Mirrors the client's `chat_metadata` global.
 * @returns {Promise<CharacterCardFields>}
 */
export async function getCharacterCardFields(directories, options = {}) {
    const {
        avatar,
        groupId,
        preferCharacterPrompt = false,
        preferCharacterJailbreak = false,
        personaDescription,
        chatMetadata = {},
    } = options;

    const character = await loadCharacter(directories, avatar);
    const useGroupCards = Boolean(groupId) && Boolean(character);
    const group = useGroupCards ? (getGroupsByIds(directories, [groupId])[groupId] ?? null) : null;
    const groupCards = group ? await computeGroupCards(directories, group, avatar, chatMetadata) : null;

    const name2 = character?.name || undefined;
    const names = { name2 };

    const persona = baseChatReplace(personaDescription?.trim(), names);

    if (!character) {
        // useGroupCards requires a resolved character, so groupCards is always null here too -
        // every field falls back to its "no character" default, matching the client's guards.
        return {
            system: '',
            mesExamples: '',
            description: '',
            personality: '',
            persona,
            scenario: '',
            jailbreak: '',
            version: '',
            charDepthPrompt: '',
            creatorNotes: '',
            firstMessage: '',
            alternateGreetings: [],
        };
    }

    const systemPrompt = chatMetadata?.system_prompt || character.data?.system_prompt || '';
    const system = preferCharacterPrompt ? baseChatReplace(systemPrompt.trim(), names) : '';

    const jailbreak = preferCharacterJailbreak
        ? baseChatReplace(character.data?.post_history_instructions?.trim(), names)
        : '';

    const version = character?.data?.character_version ?? '';
    const charDepthPrompt = baseChatReplace(character.data?.extensions?.depth_prompt?.prompt?.trim(), names);
    const creatorNotes = baseChatReplace(character.data?.creator_notes?.trim(), names);

    const description = groupCards ? groupCards.description : baseChatReplace(character.description?.trim(), names);
    const personality = groupCards ? groupCards.personality : baseChatReplace(character.personality?.trim(), names);

    const scenarioText = chatMetadata?.scenario || character.scenario || '';
    const scenario = groupCards ? groupCards.scenario : baseChatReplace(scenarioText.trim(), names);

    const exampleDialog = chatMetadata?.mes_example || character.mes_example || '';
    const mesExamples = groupCards ? groupCards.mesExamples : baseChatReplace(exampleDialog.trim(), names);

    const firstMes = character.first_mes?.trim() || '';
    const firstMessage = baseChatReplace(firstMes, names);

    const altGreetings = character.data?.alternate_greetings;
    const alternateGreetings = Array.isArray(altGreetings)
        ? altGreetings.map(greeting => baseChatReplace(greeting?.trim(), names))
        : [];

    return {
        system,
        mesExamples,
        description,
        personality,
        persona,
        scenario,
        jailbreak,
        version,
        charDepthPrompt,
        creatorNotes,
        firstMessage,
        alternateGreetings,
    };
}
