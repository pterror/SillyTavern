/**
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isChatHeaderEntry(entry) {
    return typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        && !Object.hasOwn(entry, 'mes')
        && ['chat_metadata', 'user_name', 'character_name'].some(key => Object.hasOwn(entry, key));
}

/**
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
