const extension_prompt_types = {
    NONE: -1,
};

const extension_prompt_roles = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

const MAX_INJECTION_DEPTH = 10000;

/** @enum {number} */
export const metadata_keys = {
    prompt: 'note_prompt',
    interval: 'note_interval',
    depth: 'note_depth',
    position: 'note_position',
    role: 'note_role',
};

/** @enum {number} */
export const chara_note_position = {
    replace: 0,
    before: 1,
    after: 2,
};

/**
 * @typedef {object} AuthorsNoteCharaOverride
 * @property {string} name
 * @property {string} prompt
 * @property {boolean} useChara
 * @property {number} [position]
 */

/**
 * @typedef {object} AuthorsNoteSettings
 * @property {string} [default]
 * @property {number} [defaultDepth]
 * @property {number} [defaultInterval]
 * @property {number} [defaultPosition]
 * @property {number} [defaultRole]
 * @property {boolean} [allowWIScan]
 * @property {AuthorsNoteCharaOverride[]} [chara]
 */

/**
 * @typedef {object} ResolveAuthorsNoteParams
 * @property {object} chatMetadata
 * @property {AuthorsNoteSettings} noteSettings
 * @property {{is_user?: boolean}[]} chat
 * @property {string|null} [avatar]
 * @property {boolean} hasCharacterOrGroup
 */

/**
 * @typedef {object} ResolvedAuthorsNote
 * @property {true} disabled
 */

/**
 * @typedef {object} EnabledAuthorsNote
 * @property {false} [disabled]
 * @property {string} value
 * @property {boolean} shouldAddPrompt
 * @property {number} messagesTillInsertion
 * @property {number} position
 * @property {number} depth
 * @property {boolean} scan
 * @property {number} role
 */

const DEFAULT_DEPTH = 4;
const DEFAULT_POSITION = 1;
const DEFAULT_INTERVAL = 1;
const DEFAULT_ROLE = extension_prompt_roles.SYSTEM;

/**
 * @param {ResolveAuthorsNoteParams} params
 * @returns {ResolvedAuthorsNote|EnabledAuthorsNote}
 */
export function resolveAuthorsNote({ chatMetadata, noteSettings, chat, avatar, hasCharacterOrGroup }) {
    if (!hasCharacterOrGroup) {
        return { disabled: true };
    }

    const interval = chatMetadata[metadata_keys.interval] ?? noteSettings.defaultInterval ?? DEFAULT_INTERVAL;
    const position = chatMetadata[metadata_keys.position] ?? noteSettings.defaultPosition ?? DEFAULT_POSITION;
    const depth = chatMetadata[metadata_keys.depth] ?? noteSettings.defaultDepth ?? DEFAULT_DEPTH;
    const role = chatMetadata[metadata_keys.role] ?? noteSettings.defaultRole ?? DEFAULT_ROLE;
    const basePrompt = chatMetadata[metadata_keys.prompt] ?? noteSettings.default ?? '';

    let lastMessageNumber = Array.isArray(chat) && chat.length ? chat.filter(m => m.is_user).length : 0;

    if (interval === 1) {
        lastMessageNumber = 1;
    }

    if (lastMessageNumber <= 0 || interval <= 0) {
        return { disabled: true };
    }

    const messagesTillInsertion = lastMessageNumber >= interval
        ? (lastMessageNumber % interval)
        : (interval - lastMessageNumber);
    const shouldAddPrompt = messagesTillInsertion == 0;

    let prompt = shouldAddPrompt ? basePrompt : '';
    if (shouldAddPrompt && noteSettings.chara && avatar !== undefined && avatar !== null) {
        const charaNote = noteSettings.chara.find((e) => e.name === avatar);

        if (charaNote && charaNote.useChara) {
            switch (charaNote.position) {
                case chara_note_position.before:
                    prompt = charaNote.prompt + '\n' + prompt;
                    break;
                case chara_note_position.after:
                    prompt = prompt + '\n' + charaNote.prompt;
                    break;
                default:
                    prompt = charaNote.prompt;
                    break;
            }
        }
    }

    return {
        disabled: false,
        value: String(prompt),
        shouldAddPrompt,
        messagesTillInsertion,
        position,
        depth,
        scan: Boolean(noteSettings.allowWIScan),
        role,
    };
}

export { extension_prompt_types, extension_prompt_roles, MAX_INJECTION_DEPTH };
