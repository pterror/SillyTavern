import { extension_prompt_types, setExtensionPrompt } from './extension-prompt-table.js';
import { inject_ids, persona_description_positions } from '../public/scripts/constants.js';

/**
 * What a prompt has injected besides its own parts, as the page's `extension_prompts` holds it while it builds one
 * (public/script.js's Generate()): what the page's extensions inject, the author's note, the persona's description
 * around it or in the chat, and what goes in the chat at a depth (lorebook entries, the story string, the character's
 * note). Both the text completion and the chat completion builders fill their table here, under the page's keys.
 */

/**
 * The page's extensions' injections (src/page-injections.js), as the page's table holds them before its build adds to
 * it.
 * @param {import('./extension-prompt-table.js').ExtensionPromptTable} table
 * @param {import('./extension-prompt-table.js').ExtensionPromptTable} [pageInjections]
 */
export function addPageInjections(table, pageInjections = {}) {
    for (const [key, entry] of Object.entries(pageInjections)) {
        setExtensionPrompt(table, key, entry.value, entry.position, entry.depth, entry.scan, entry.role);
    }
}

/**
 * @typedef {object} NoteAndPersona
 * @property {ReturnType<typeof import('./authors-note.js').resolveAuthorsNote>} authorsNote
 * @property {string[]} [anBefore] Lorebook entries at the top of the note.
 * @property {string[]} [anAfter] Lorebook entries at the bottom of the note.
 * @property {string} [personaDescription]
 * @property {number} [personaDescriptionPosition] One of persona_description_positions.
 * @property {number} [personaDescriptionDepth]
 * @property {number} [personaDescriptionRole]
 */

/**
 * The author's note, with the lorebook entries at its top and bottom when it goes in this turn (public/scripts/
 * world-info.js's checkWorldInfo()); then the persona's description where its persona puts it besides the story string
 * (public/script.js's addPersonaDescriptionExtensionPrompt()): joined to the note when the note goes in, or in the chat
 * at its depth.
 * @param {import('./extension-prompt-table.js').ExtensionPromptTable} table
 * @param {NoteAndPersona} params
 */
export function addNoteAndPersona(table, { authorsNote, anBefore = [], anAfter = [], personaDescription = '', personaDescriptionPosition, personaDescriptionDepth, personaDescriptionRole }) {
    const noteOn = authorsNote.disabled === false;
    if (noteOn) {
        // At most one line break stripped from each end, as the page's regex does.
        const noteValue = authorsNote.shouldAddPrompt
            ? `${anBefore.join('\n')}\n${authorsNote.value}\n${anAfter.join('\n')}`.replace(/(^\n)|(\n$)/g, '')
            : authorsNote.value;
        setExtensionPrompt(table, inject_ids.AUTHORS_NOTE, noteValue, authorsNote.position, authorsNote.depth, false, authorsNote.role);
    }

    if (!personaDescription || personaDescriptionPosition === persona_description_positions.NONE) return;
    const aroundNote = personaDescriptionPosition === persona_description_positions.TOP_AN || personaDescriptionPosition === persona_description_positions.BOTTOM_AN;
    if (aroundNote && noteOn && authorsNote.shouldAddPrompt) {
        const note = table[inject_ids.AUTHORS_NOTE]?.value ?? '';
        setExtensionPrompt(
            table, inject_ids.AUTHORS_NOTE,
            personaDescriptionPosition === persona_description_positions.TOP_AN ? `${personaDescription}\n${note}` : `${note}\n${personaDescription}`,
            authorsNote.position, authorsNote.depth, false, authorsNote.role,
        );
    }
    if (personaDescriptionPosition === persona_description_positions.AT_DEPTH) {
        setExtensionPrompt(table, inject_ids.PERSONA_DESCRIPTION, personaDescription, extension_prompt_types.IN_CHAT, personaDescriptionDepth, true, personaDescriptionRole);
    }
}

/**
 * @typedef {object} DepthInjections
 * @property {{ depth: number, role: number, entries: string[] }[]} [worldInfoDepthEntries] Lorebook entries at a depth.
 * @property {{ content: string, depth: number, role: number } | null} [storyStringInjection] The story string, when it
 *   goes in the chat.
 * @property {{ text: string, depth: number, role: number }[]} [groupDepthPrompts] Each group member's note, in a group.
 * @property {{ text: string, depth: number, role: number } | null} [characterDepthPrompt] The character's note, outside one.
 * @property {boolean} [depthPromptScan] Whether a character's note is scanned for lorebook keys.
 */

/**
 * What goes in the chat at a depth (public/script.js's Generate()): the lorebook entries at their depths, the story
 * string when it goes in the chat, and the character's note (each member's, in a group).
 * @param {import('./extension-prompt-table.js').ExtensionPromptTable} table
 * @param {DepthInjections} params
 */
export function addDepthInjections(table, { worldInfoDepthEntries = [], storyStringInjection = null, groupDepthPrompts = [], characterDepthPrompt = null, depthPromptScan = false }) {
    for (const entry of worldInfoDepthEntries) {
        setExtensionPrompt(table, inject_ids.CUSTOM_WI_DEPTH_ROLE(entry.depth, entry.role), entry.entries.join('\n'), extension_prompt_types.IN_CHAT, entry.depth, false, entry.role);
    }
    if (storyStringInjection) {
        setExtensionPrompt(table, inject_ids.STORY_STRING, storyStringInjection.content, extension_prompt_types.IN_CHAT, storyStringInjection.depth, false, storyStringInjection.role);
    }
    if (groupDepthPrompts.length > 0) {
        groupDepthPrompts.forEach((prompt, index) => {
            setExtensionPrompt(table, inject_ids.DEPTH_PROMPT_INDEX(index), prompt.text, extension_prompt_types.IN_CHAT, prompt.depth, depthPromptScan, prompt.role);
        });
    } else if (characterDepthPrompt?.text) {
        setExtensionPrompt(table, inject_ids.DEPTH_PROMPT, characterDepthPrompt.text, extension_prompt_types.IN_CHAT, characterDepthPrompt.depth, depthPromptScan, characterDepthPrompt.role);
    }
}
