import { sessionHeaderValue } from './tab-session.js';

// CSRF token handed out at load time by GET /csrf-token; script.js's firstLoadInit() is the
// only writer, via setToken() below (an ESM live binding can't be reassigned from outside
// this module).
export let token;

export function setToken(value) {
    token = value;
}

export function getRequestHeaders({ omitContentType = false } = {}) {
    const headers = {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
        'X-ST-Session': sessionHeaderValue(),
    };

    if (omitContentType) {
        delete headers['Content-Type'];
    }

    return headers;
}
