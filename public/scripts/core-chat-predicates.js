/**
 * Dependency-free chat-message checks shared between the client Generate() pipeline
 * (public/scripts/generation.js) and its server-side port (src/core-chat-build.js) - must stay
 * importable outside a browser DOM (e.g. under Node), same constraint as ./hash-utils.js.
 */

/**
 * @param {{is_system?: boolean}} [chatItem]
 * @returns {boolean}
 */
export function isSystemChatItem(chatItem) {
    return chatItem?.is_system === true;
}

/**
 * @typedef {object} CoreChatMessageExtraMedia
 * @property {string} [title]
 * @property {boolean} [append_title]
 */

/**
 * @typedef {object} CoreChatMessageExtra
 * @property {boolean} [append_title]
 * @property {string} [title]
 * @property {CoreChatMessageExtraMedia[]} [media]
 */

/**
 * Collects `extra.title` (if `extra.append_title` and `extra.title` is a non-empty string) and
 * each `extra.media[].title` (same condition, per media item), in that order, and joins them into
 * the `\n\n`-prefixed suffix Generate() appends to a message's resolved text.
 *
 * @param {{extra?: CoreChatMessageExtra}} [chatItem]
 * @returns {string} The suffix, or `''` if there are no titles to append.
 */
export function collectMessageTitles(chatItem) {
    const titles = [];
    if (chatItem?.extra?.append_title === true && chatItem.extra.title != null && chatItem.extra.title !== '') {
        titles.push(chatItem.extra.title);
    }
    if (Array.isArray(chatItem?.extra?.media)) {
        for (const mediaItem of chatItem.extra.media) {
            if (mediaItem?.title != null && mediaItem.title !== '' && mediaItem?.append_title === true) {
                titles.push(mediaItem.title);
            }
        }
    }
    if (titles.length > 0) {
        return `\n\n${titles.join('\n\n')}`;
    }
    return '';
}
