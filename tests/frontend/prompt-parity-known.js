/** @type {Record<string, [string, string][]>} upstream's text, and what the server sends in its place */
export const KNOWN_DIFFERENCES = {
    'tc-lorebook-positions': [
        ['A forest ranger. Outlet: \n', 'A forest ranger. Outlet: In the outlet: the river is cold.\n'],
    ],
    'cc-lorebook-positions': [
        ['A forest ranger. Outlet: ', 'A forest ranger. Outlet: In the outlet: the river is cold.'],
    ],
};

/**
 * @param {string} name
 * @param {string} golden
 * @returns {string}
 */
export function serverText(name, golden) {
    return (KNOWN_DIFFERENCES[name] ?? []).reduce((text, [upstream, server]) => {
        if (!text.includes(upstream)) throw new Error(`${name}: the known difference "${upstream}" isn't in the golden`);
        return text.replace(upstream, server);
    }, golden);
}

/**
 * @param {string} name
 * @param {{ role: string, content: string }[]} golden
 * @returns {{ role: string, content: string }[]}
 */
export function serverMessages(name, golden) {
    const pairs = KNOWN_DIFFERENCES[name] ?? [];
    const messages = structuredClone(golden);
    for (const [upstream, server] of pairs) {
        const message = messages.find(m => m.content === upstream);
        if (!message) throw new Error(`${name}: no message says "${upstream}"`);
        message.content = server;
    }
    return messages;
}
