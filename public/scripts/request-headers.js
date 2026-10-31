import { sessionHeaderValue } from './tab-session.js';

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
