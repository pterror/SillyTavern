import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';

import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';

import { initOutgoingRequests } from './outgoing-requests.js';

const original = getGlobalDispatcher();
/** @type {http.Server} */
let server;
let received = 0;
let port = 0;

before(async () => {
    server = http.createServer((_request, response) => {
        received++;
        response.end('reached');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
});

after(async () => {
    setGlobalDispatcher(original);
    await new Promise(resolve => server.close(() => resolve(undefined)));
});

/**
 * @param {Partial<import('./outgoing-requests.js').PrivateRequestFilterSettings>} filter
 */
function filterOn(filter = {}) {
    initOutgoingRequests({
        enableKeepAlive: false,
        privateRequestFilter: { listen: false, enabled: true, privateAddressWhitelist: [], logBlocked: false, logAllowed: false, allowUnresolvedHosts: false, ...filter },
        requestProxy: { enabled: false, url: '', bypass: [] },
    });
}

/**
 * @param {string} url
 * @returns {Promise<string>} The reason the request failed.
 */
async function refusal(url) {
    const error = await fetch(url).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(error, `${url} was reached`);
    return String(error.cause?.message ?? error.message);
}

test('with the filter on, global fetch never reaches a private address', async () => {
    filterOn();
    const before = received;
    assert.match(await refusal(`http://127.0.0.1:${port}/`), /Blocked request to private IP address: 127\.0\.0\.1/);
    assert.match(await refusal(`http://localhost:${port}/`), /Blocked request to private IP address/);
    assert.match(await refusal(`http://[::1]:${port}/`), /Blocked request to private IP address: ::1/);
    assert.equal(received, before, 'the private server got no request');
});

test('a whitelisted private address is reached', async () => {
    filterOn({ privateAddressWhitelist: ['127.0.0.0/8'] });
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await response.text(), 'reached');
});

test('an unresolvable host is refused unless allowed', async () => {
    filterOn();
    assert.match(await refusal('http://unresolvable.invalid/'), /Unable to resolve host: unresolvable\.invalid/);
    filterOn({ allowUnresolvedHosts: true });
    assert.doesNotMatch(await refusal('http://unresolvable.invalid/'), /Unable to resolve host/);
});

test('with the filter off, a private address is reached', async () => {
    initOutgoingRequests({
        enableKeepAlive: true,
        privateRequestFilter: { listen: false, enabled: false, privateAddressWhitelist: [], logBlocked: false, logAllowed: false, allowUnresolvedHosts: false },
        requestProxy: { enabled: false, url: '', bypass: [] },
    });
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await response.text(), 'reached');
});
