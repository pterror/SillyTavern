import { extension_prompt_types, setExtensionPrompt } from './extension-prompt-table.js';
import { inject_ids, persona_description_positions } from '../public/scripts/constants.js';

/**
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
 * @property {string[]} [anBefore]
 * @property {string[]} [anAfter]
 * @property {string} [personaDescription]
 * @property {number} [personaDescriptionPosition]
 * @property {number} [personaDescriptionDepth]
 * @property {number} [personaDescriptionRole]
 */

/**
 * @param {import('./extension-prompt-table.js').ExtensionPromptTable} table
 * @param {NoteAndPersona} params
 */
export function addNoteAndPersona(table, { authorsNote, anBefore = [], anAfter = [], personaDescription = '', personaDescriptionPosition, personaDescriptionDepth, personaDescriptionRole }) {
    const noteOn = authorsNote.disabled === false;
    if (noteOn) {
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
 * @property {{ depth: number, role: number, entries: string[] }[]} [worldInfoDepthEntries]
 * @property {{ content: string, depth: number, role: number } | null} [storyStringInjection]
 * @property {{ text: string, depth: number, role: number }[]} [groupDepthPrompts]
 * @property {{ text: string, depth: number, role: number } | null} [characterDepthPrompt]
 * @property {boolean} [depthPromptScan]
 */

/**
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
