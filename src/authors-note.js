/**
 * Server-side port of public/scripts/authors-note.js's setFloatingPrompt() - the function that
 * resolves the current Author's Note extension-prompt slot from: how many user messages have been
 * sent so far, an "insert every N messages" interval, and an optional per-character note override.
 *
 * The client reads the note text via `$('#extension_floating_prompt').val()`, but that DOM field is
 * not independent state - the client's own loadSettings() (same file) proves it's always just a
 * mirror of `chat_metadata['note_prompt']`, seeded from `extension_settings.note.default` on first
 * use. So the real input ported here is `chatMetadata['note_prompt']` (and its sibling
 * `metadata_keys` entries), not a DOM read - the same "this looked client-only but is actually just
 * a plain value" situation as several macros in src/macro-substitution.js.
 *
 * Like src/world-info/*.js and src/macro-substitution.js, this takes every piece of context
 * explicitly instead of reading globals or resolving a character itself - the caller resolves
 * `avatar` (via public/scripts/utils.js's getCharaFilename()) and `hasCharacterOrGroup` from its own
 * request context and passes them in as plain facts.
 */

// Mirrored from public/script.js (extension_prompt_types/extension_prompt_roles/MAX_INJECTION_DEPTH)
// - only the subset this module needs. Same mirroring pattern as
// src/instruct-template-format.js's local copy of extension_prompt_types.
const extension_prompt_types = {
    NONE: -1,
};

const extension_prompt_roles = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

const MAX_INJECTION_DEPTH = 10000;

/** @enum {number} Mirrors public/scripts/authors-note.js's metadata_keys mapping */
export const metadata_keys = {
    prompt: 'note_prompt',
    interval: 'note_interval',
    depth: 'note_depth',
    position: 'note_position',
    role: 'note_role',
};

/** @enum {number} Mirrors public/scripts/authors-note.js's chara_note_position */
export const chara_note_position = {
    replace: 0,
    before: 1,
    after: 2,
};

/**
 * @typedef {object} AuthorsNoteCharaOverride
 * @property {string} name Character note-filename this override applies to (matches getCharaFilename())
 * @property {string} prompt Override note text
 * @property {boolean} useChara Whether this override is actually enabled
 * @property {number} [position] One of chara_note_position - defaults to `replace` when absent
 */

/**
 * @typedef {object} AuthorsNoteSettings Mirrors extension_settings.note
 * @property {string} [default] Fallback note text when chatMetadata lacks note_prompt
 * @property {number} [defaultDepth] Fallback depth (client default: 4)
 * @property {number} [defaultInterval] Fallback interval (client default: 1)
 * @property {number} [defaultPosition] Fallback position (client default: 1)
 * @property {number} [defaultRole] Fallback role (client default: extension_prompt_roles.SYSTEM)
 * @property {boolean} [allowWIScan] Whether the note text should be scanned for world info
 * @property {AuthorsNoteCharaOverride[]} [chara] Per-character overrides
 */

/**
 * @typedef {object} ResolveAuthorsNoteParams
 * @property {object} chatMetadata Plain chat_metadata object - only metadata_keys entries are read
 * @property {AuthorsNoteSettings} noteSettings Equivalent of extension_settings.note
 * @property {{is_user?: boolean}[]} chat Chat messages - only `.is_user` is used, to count user turns
 * @property {string|null} [avatar] Character's note-filename (getCharaFilename() result), for chara-override lookup
 * @property {boolean} hasCharacterOrGroup Whether a character or group is currently selected (getContext().groupId or characterId !== undefined)
 */

/**
 * @typedef {object} ResolvedAuthorsNote
 * @property {true} disabled Set only on the two "note disabled entirely" early-return cases (no
 *  character/group selected, or note_interval <= 0). When true, none of the other fields are set -
 *  this is the caller's cue to call setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, MAX_INJECTION_DEPTH)
 *  exactly like the client does, instead of the position/depth/scan/role variant.
 */

/**
 * @typedef {object} EnabledAuthorsNote
 * @property {false} [disabled]
 * @property {string} value Resolved note text - '' when the note isn't due to insert this turn (messagesTillInsertion != 0)
 * @property {boolean} shouldAddPrompt Whether the note is due to be inserted this turn (mirrors the client's shouldWIAddPrompt)
 * @property {number} messagesTillInsertion 0 when due this turn, otherwise the number of user messages until it is
 * @property {number} position One of extension_prompt_types positions, from chatMetadata/noteSettings
 * @property {number} depth Injection depth, from chatMetadata/noteSettings
 * @property {boolean} scan Whether the note should be scanned for world info (noteSettings.allowWIScan)
 * @property {number} role One of extension_prompt_roles, from chatMetadata/noteSettings
 */

const DEFAULT_DEPTH = 4;
const DEFAULT_POSITION = 1;
const DEFAULT_INTERVAL = 1;
const DEFAULT_ROLE = extension_prompt_roles.SYSTEM;

/**
 * Resolves the Author's Note extension-prompt slot, equivalent to what the client's
 * setFloatingPrompt() would pass to setExtensionPrompt(MODULE_NAME, value, position, depth, scan, role).
 *
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

    // take the count of messages
    let lastMessageNumber = Array.isArray(chat) && chat.length ? chat.filter(m => m.is_user).length : 0;

    // interval 1 should be inserted no matter what
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

        // Only replace with the chara note if the user checked the box
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
