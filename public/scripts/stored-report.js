/** @type {(stored: unknown) => void} */
let adopter = () => {};

/**
 * @param {(stored: unknown) => void} adopt
 */
export function setStoredAdopter(adopt) {
    adopter = adopt;
}

/**
 * @param {unknown} stored
 */
export function reportStored(stored) {
    adopter(stored);
}

/**
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
