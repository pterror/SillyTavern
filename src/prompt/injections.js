import { inject_ids, persona_description_positions } from '../../public/scripts/constants.js';

/** @enum {number} */
export const extension_prompt_types = {
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
};

/** @enum {number} */
export const extension_prompt_roles = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

/** @type {readonly ('system'|'user'|'assistant')[]} */
export const ROLE_NAMES = ['system', 'user', 'assistant'];

/**
 * @typedef {object} PageInjection
 * @property {string} value
 * @property {number} position
 * @property {number} depth
 * @property {boolean} scan
 * @property {number} role
 */

/** @typedef {Record<string, PageInjection>} PageInjections */

/**
 * @typedef {import('./model.js').Section} Section
 */

/**
 * @typedef {object} PositionedEntry
 * @property {string} key
 * @property {number} position
 * @property {number} depth
 * @property {number} role
 * @property {Section} root
 * @property {Section[]} children
 */

/**
 * @param {number} role
 * @returns {'system'|'user'|'assistant'}
 */
export function roleName(role) {
    return ROLE_NAMES[Number(role)] ?? 'system';
}

/**
 * @typedef {object} PositionedEntriesInput
 * @property {PageInjections} [pageInjections]
 * @property {ReturnType<typeof import('../authors-note.js').resolveAuthorsNote>} authorsNote
 * @property {string[]} [anBefore]
 * @property {string[]} [anAfter]
 * @property {string} [personaDescription]
 * @property {number} [personaDescriptionPosition]
 * @property {number} [personaDescriptionDepth]
 * @property {number} [personaDescriptionRole]
 * @property {{ depth?: number, role: number, entries: string[] }[]} [worldInfoDepth]
 * @property {Section|null} [storyStringAtDepth]
 * @property {number} [storyStringDepth]
 * @property {number} [storyStringRole]
 * @property {{ text: string, depth: number, role: number }[]} [groupDepthPrompts]
 * @property {{ text: string, depth: number, role: number } | null} [characterDepthPrompt]
 * @property {(text: string) => string} substitute
 */

/**
 * @param {PositionedEntriesInput} input
 * @returns {PositionedEntry[]}
 */
export function positionedEntries({
    pageInjections = {}, authorsNote, anBefore = [], anAfter = [],
    personaDescription = '', personaDescriptionPosition, personaDescriptionDepth, personaDescriptionRole,
    worldInfoDepth = [], storyStringAtDepth = null, storyStringDepth = 1, storyStringRole = extension_prompt_roles.SYSTEM,
    groupDepthPrompts = [], characterDepthPrompt = null, substitute,
}) {
    /** @type {Map<string, PositionedEntry>} */
    const entries = new Map();
    /**
     * @param {string} key
     * @param {number} position
     * @param {number} depth
     * @param {number} role
     * @param {Omit<Section, 'id'>} root
     * @param {Section[]} [children]
     */
    const set = (key, position, depth, role, root, children = []) => {
        entries.set(key, { key, position: Number(position), depth: Number(depth), role: Number(role ?? extension_prompt_roles.SYSTEM), root: { ...root, id: `inject:${key}` }, children });
    };

    for (const [key, entry] of Object.entries(pageInjections)) {
        if (!entry.value) continue;
        set(key, entry.position, entry.depth, entry.role, { text: substitute(entry.value), part: 'extensions' });
    }

    const personaInNote = Boolean(personaDescription) && (personaDescriptionPosition === persona_description_positions.TOP_AN || personaDescriptionPosition === persona_description_positions.BOTTOM_AN);
    const noteSent = authorsNote.disabled === false && authorsNote.shouldAddPrompt
        && Boolean(authorsNote.value || anBefore.length || anAfter.length || personaInNote);
    if (noteSent) {
        const noteId = `inject:${inject_ids.AUTHORS_NOTE}`;

        /** @type {Section[]} */
        const children = [
            ...anBefore.map((text, i) => ({ id: `${noteId}:top:${i}`, parent: noteId, at: { first: /** @type {true} */ (true) }, order: i, text: substitute(text), part: 'world_info' })),
            ...anAfter.map((text, i) => ({ id: `${noteId}:bottom:${i}`, parent: noteId, order: i, text: substitute(text), part: 'world_info' })),
        ];
        if (personaDescription && personaDescriptionPosition === persona_description_positions.TOP_AN) {
            children.push({ id: `${noteId}:persona`, parent: noteId, at: { first: true }, order: -1, text: substitute(personaDescription), part: 'persona' });
        }
        if (personaDescription && personaDescriptionPosition === persona_description_positions.BOTTOM_AN) {
            children.push({ id: `${noteId}:persona`, parent: noteId, order: anAfter.length, text: substitute(personaDescription), part: 'persona' });
        }
        set(inject_ids.AUTHORS_NOTE, authorsNote.position, authorsNote.depth, authorsNote.role,
            { text: substitute(authorsNote.value), join: '\n', part: 'authors_note' }, children);
    }

    if (personaDescription && personaDescriptionPosition === persona_description_positions.AT_DEPTH) {
        set(inject_ids.PERSONA_DESCRIPTION, extension_prompt_types.IN_CHAT, Number(personaDescriptionDepth), Number(personaDescriptionRole),
            { text: substitute(personaDescription), part: 'persona' });
    }

    for (const lore of worldInfoDepth) {
        const key = inject_ids.CUSTOM_WI_DEPTH_ROLE(lore.depth, lore.role);
        const id = `inject:${key}`;
        set(key, extension_prompt_types.IN_CHAT, Number(lore.depth), lore.role, { join: '\n', part: 'world_info' },
            lore.entries.map((text, i) => ({ id: `${id}:${i}`, parent: id, order: i, text: substitute(text), part: 'world_info' })));
    }

    if (storyStringAtDepth) {
        entries.set(inject_ids.STORY_STRING, {
            key: inject_ids.STORY_STRING, position: extension_prompt_types.IN_CHAT, depth: Number(storyStringDepth ?? 1),
            role: Number(storyStringRole ?? extension_prompt_roles.SYSTEM),
            root: { ...storyStringAtDepth, id: `inject:${inject_ids.STORY_STRING}` }, children: [],
        });
    }

    if (groupDepthPrompts.length > 0) {
        groupDepthPrompts.forEach((prompt, index) => {
            set(inject_ids.DEPTH_PROMPT_INDEX(index), extension_prompt_types.IN_CHAT, prompt.depth, prompt.role, { text: substitute(prompt.text), part: 'injections' });
        });
    } else if (characterDepthPrompt?.text) {
        set(inject_ids.DEPTH_PROMPT, extension_prompt_types.IN_CHAT, characterDepthPrompt.depth, characterDepthPrompt.role, { text: substitute(characterDepthPrompt.text), part: 'injections' });
    }

    return [...entries.values()];
}

/**
 * @param {PositionedEntry} entry
 * @param {string} parent
 * @param {import('./model.js').Position} [at]
 * @param {number} [order]
 * @returns {Section[]}
 */
export function placeEntry(entry, parent, at = { last: true }, order = 0) {
    return [{ ...entry.root, parent, at, order }, ...entry.children];
}
