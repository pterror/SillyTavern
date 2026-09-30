// Hands the server's `stored` entries (the node each message it stored landed at, under the ref the page
// sent for it) to chat-store.js's adoptStored(). A module with no imports of its own, so the request
// senders that read an answer can report into it without importing chat-store.js.

/** @type {(stored: unknown) => void} */
let adopter = () => {};

/**
 * @param {(stored: unknown) => void} adopt
 */
export function setStoredAdopter(adopt) {
    adopter = adopt;
}

/**
 * @param {unknown} stored An answer's `stored` list.
 */
export function reportStored(stored) {
    adopter(stored);
}

/**
 * Reports the `X-ST-Stored` header an error answer carries after the server stored a message.
 * @param {Response} response
 */
export function reportStoredHeader(response) {
    const header = response.headers.get('X-ST-Stored');
    if (!header) return;
    try {
        adopter(JSON.parse(header));
    } catch (error) {
        console.error('Unreadable X-ST-Stored header:', header, error);
        toastr.warning('The server stored your message, but its answer could not be read. Reload the chat before sending again, or the message may be saved twice.');
    }
}
