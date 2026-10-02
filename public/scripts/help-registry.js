/**
 * What the help panel shows: help topics and hotkeys. Built-in help registers through these same functions, so
 * extensions' entries sit next to the built-in ones. A leaf module, so anything can import it.
 */

/**
 * @typedef {object} HelpTopic
 * @property {string} id Unique id; `/help <id>` opens it.
 * @property {string} title Shown in the topic list.
 * @property {string[]} [aliases] More names `/help <name>` accepts, matched ignoring case.
 * @property {number} [order] Place in the topic list, lowest first. Built-ins use 10–50.
 * @property {(container: HTMLElement, query: string) => (number | void | Promise<number | void>)} render Draws the
 * topic into `container`. With a non-empty `query` it draws only what matches and returns how many things matched.
 */

/**
 * @typedef {object} Hotkey
 * @property {string} label What it does, in plain words.
 * @property {string} category Heading it's listed under.
 * @property {string[]} [keys] Key combinations, written like `Ctrl+Enter`; each one does it.
 * @property {string[]} [mouse] Mouse actions, written like `Ctrl+click on a Quick Reply button`.
 * @property {() => boolean} [when] Whether it works right now. When it returns false the hotkey is shown greyed out.
 */

/** @type {Map<string, HelpTopic>} */
const topics = new Map();
/** @type {Hotkey[]} */
const hotkeys = [];

/**
 * Adds a help topic, or replaces the one with the same id.
 * @param {HelpTopic} topic
 */
export function registerHelpTopic(topic) {
    if (!topic || typeof topic.id !== 'string' || !topic.id || typeof topic.render !== 'function') {
        throw new TypeError('A help topic needs an id and a render function.');
    }
    topics.set(topic.id, { aliases: [], order: 100, ...topic, title: topic.title || topic.id });
}

/** @returns {HelpTopic[]} Every topic, in list order. */
export function getHelpTopics() {
    return [...topics.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/**
 * @param {string} name A topic id or alias, any case.
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
 * Adds a hotkey to the Hotkeys topic and the hold-Ctrl list. It only describes a key; handling it is up to the caller.
 * @param {Hotkey} hotkey
 */
export function registerHotkey(hotkey) {
    if (!hotkey || typeof hotkey.label !== 'string' || !(hotkey.keys?.length || hotkey.mouse?.length)) {
        throw new TypeError('A hotkey needs a label and at least one key or mouse action.');
    }
    hotkeys.push({ category: 'Other', keys: [], mouse: [], ...hotkey });
}

/** @returns {Hotkey[]} Every registered hotkey, in registration order. */
export function getHotkeys() {
    return [...hotkeys];
}
