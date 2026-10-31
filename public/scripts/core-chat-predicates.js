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
 * @param {{extra?: CoreChatMessageExtra}} [chatItem]
 * @returns {string}
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
