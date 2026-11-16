import { getRequestHeaders } from './request-headers.js';
import { serverHasNewerBuild } from './asset-url.js';

/**
 * What became of asking the server to move the chat to another alternative. `refused` is the server's `reason` for a
 * refusal it explains (409), 'outdated' when the server serves a newer page than this one and didn't take the request,
 * or 'error' when it failed otherwise.
 * @typedef {{ answer: any } | { refused: string } | { unreachable: true }} SwitchAnswer
 */

/**
 * @param {string} path
 * @param {object} body
 * @returns {Promise<SwitchAnswer>}
 */
export async function askSwitch(path, body) {
    /** @type {Response} */
    let response;
    try {
        response = await fetch(path, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    } catch (error) {
        console.warn(`[switch] ${path} could not be reached:`, error);
        return { unreachable: true };
    }
    const answer = await response.json().catch(() => null);
    if (response.ok && answer !== null) return { answer };
    console.warn(`[switch] ${path} responded ${response.status}:`, answer);
    if (response.status === 409 && typeof answer?.reason === 'string') return { refused: answer.reason };
    if (response.status >= 400 && response.status < 500 && await serverHasNewerBuild()) return { refused: 'outdated' };
    return { refused: 'error' };
}
