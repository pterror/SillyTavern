import { sessionHeaderValue } from './tab-session.js';

export let token;

export function setToken(value) {
    token = value;
}

/** @type {() => Record<string, unknown> | null} */
let macroFacts = () => null;

/**
 * @param {() => Record<string, unknown> | null} facts what the page knows that macros read, which every request
 *   carries so that messages it is answered with are filled in as the page would
 */
export function setMacroFactsHeader(facts) {
    macroFacts = facts;
}

export function getRequestHeaders({ omitContentType = false } = {}) {
    const facts = macroFacts();
    const headers = {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
        'X-ST-Session': sessionHeaderValue(),
        ...(facts ? { 'X-ST-Macro-Facts': encodeURIComponent(JSON.stringify(facts)) } : {}),
    };

    if (omitContentType) {
        delete headers['Content-Type'];
    }

    return headers;
}
