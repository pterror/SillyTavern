import { readSettingsFor } from './settings-reads.js';
import { countWithConnection } from './connection-counts.js';

/**
 * @typedef {object} ShownTextCounts
 * @property {number} persona The chosen persona's description.
 * @property {number} note_default The author's note new chats start with.
 * @property {number|null} note_chara The open character's own note; null when it has none.
 * @property {number} [chat_note] The open chat's author's note.
 * @property {object|null} tokenizer
 * @property {object[]} [warnings]
 */

/**
 * The counts of the texts the page shows a count beside, as the chosen connection counts them.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./settings-reads.js').SettingsContext} settingsContext
 * @param {{ chatNote?: string }} [chat] The open chat's author's note, when the action is in a chat.
 * @returns {Promise<ShownTextCounts|null>}
 */
export async function shownTextCounts(directories, settingsContext, { chatNote } = {}) {
    const {
        user_avatar: userAvatar, active_character: activeCharacter, power_user: powerUser = {}, extension_settings: extensionSettings = {},
    } = readSettingsFor(directories, settingsContext, ['user_avatar', 'active_character', 'power_user', 'extension_settings']);
    const note = extensionSettings.note ?? {};
    const avatar = settingsContext.avatar ?? (typeof activeCharacter === 'string' ? activeCharacter : null);
    const charaName = avatar ? avatar.replace(/\.[^/.]+$/, '') : null;
    const charaNote = charaName && Array.isArray(note.chara) ? note.chara.find((/** @type {any} */ entry) => entry?.name === charaName) : undefined;
    const texts = [
        String(powerUser.persona_data?.[userAvatar]?.description ?? ''),
        String(note.default ?? ''),
        String(charaNote?.prompt ?? ''),
        String(chatNote ?? ''),
    ];
    const counted = await countWithConnection(directories, settingsContext, texts);
    if (!counted) return null;
    const [persona, noteDefault, noteChara, chatNoteCount] = counted.counts;
    return {
        persona, note_default: noteDefault, note_chara: charaNote ? noteChara : null,
        ...(typeof chatNote === 'string' ? { chat_note: chatNoteCount } : {}),
        tokenizer: counted.tokenizer, ...(counted.warnings ? { warnings: counted.warnings } : {}),
    };
}
