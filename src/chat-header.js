/**
 * Whether a parsed chat-file line is the file's header rather than a message. Group chat files written
 * before the group metadata-format migration (migrateGroupChatsMetadataFormat) have no header line, so
 * their first line is already the chat's first message. A message always carries `mes`; a header never
 * does, and carries at least one of the header fields.
 * @param {unknown} entry A parsed JSONL line
 * @returns {boolean}
 */
export function isChatHeaderEntry(entry) {
    return typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        && !Object.hasOwn(entry, 'mes')
        && ['chat_metadata', 'user_name', 'character_name'].some(key => Object.hasOwn(entry, key));
}
