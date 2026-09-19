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
