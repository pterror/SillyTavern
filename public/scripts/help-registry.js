/**
 * @typedef {object} HelpTopic
 * @property {string} id
 * @property {string} title
 * @property {string[]} [aliases]
 * @property {number} [order]
 * @property {(container: HTMLElement, query: string) => (number | void | Promise<number | void>)} render
 */

/**
 * @typedef {object} Hotkey
 * @property {string} label
 * @property {string} category
 * @property {string[]} [keys]
 * @property {string[]} [mouse]
 * @property {() => boolean} [when]
 */

/** @type {Map<string, HelpTopic>} */
const topics = new Map();
/** @type {Hotkey[]} */
const hotkeys = [];

/**
 * @param {HelpTopic} topic
 */
export function registerHelpTopic(topic) {
    if (!topic || typeof topic.id !== 'string' || !topic.id || typeof topic.render !== 'function') {
        throw new TypeError('A help topic needs an id and a render function.');
    }
    topics.set(topic.id, { aliases: [], order: 100, ...topic, title: topic.title || topic.id });
}

/** @returns {HelpTopic[]} */
export function getHelpTopics() {
    return [...topics.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/**
 * @param {string} name
 * @returns {HelpTopic | undefined}
 */
export function findHelpTopic(name) {
    const key = String(name ?? '').trim().toLowerCase();
    if (!key) return undefined;
    for (const topic of topics.values()) {
        if (topic.id.toLowerCase() === key || topic.aliases.some(alias => alias.toLowerCase() === key)) return topic;
    }
    return undefined;
}

/**
 * @param {Hotkey} hotkey
 */
export function registerHotkey(hotkey) {
    if (!hotkey || typeof hotkey.label !== 'string' || !(hotkey.keys?.length || hotkey.mouse?.length)) {
        throw new TypeError('A hotkey needs a label and at least one key or mouse action.');
    }
    hotkeys.push({ category: 'Other', keys: [], mouse: [], ...hotkey });
}

/** @returns {Hotkey[]} */
export function getHotkeys() {
    return [...hotkeys];
}
