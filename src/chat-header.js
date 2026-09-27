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

/**
 * Splits a JSONL chat file into its header (null when it has none) and its messages. Refuses the
 * whole file, naming the offending lines, rather than migrating part of it.
 * @param {string} raw
 * @returns {{ header: object | null, messages: object[] } | { error: string }}
 */
export function parseChatFile(raw) {
    const entries = [];
    const badLines = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let entry;
        try {
            entry = JSON.parse(lines[i]);
        } catch {
            badLines.push(i + 1);
            continue;
        }
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            badLines.push(i + 1);
            continue;
        }
        entries.push(entry);
    }
    if (badLines.length > 0) {
        return { error: `line(s) ${badLines.join(', ')} are not valid JSON objects` };
    }

    const header = entries.length > 0 && isChatHeaderEntry(entries[0]) ? entries[0] : null;
    const messages = header ? entries.slice(1) : entries;
    if (messages.length === 0) {
        return { error: 'it has no messages, and the tree cannot hold a chat without one' };
    }
    return { header, messages };
}
