import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TYPE } from '../library-codes.js';
import {
    apiOfConnectionType, connectionTypeOfApi, profileToUpstream, profilesFromUpstream,
    proxiesFromUpstream, proxiesToUpstream, serverHistoryFromUpstream, serverHistoryToUpstream,
} from './connection-catalogs.js';

const json = value => JSON.parse(JSON.stringify(value));

test('upstream\'s /api names select connection types, and a type reads back as the name /api gives', () => {
    assert.equal(connectionTypeOfApi('claude'), 'openai:claude');
    assert.equal(connectionTypeOfApi('google'), 'openai:makersuite');
    assert.equal(connectionTypeOfApi('openrouter'), 'openai:openrouter');
    assert.equal(connectionTypeOfApi('openrouter-text'), 'textgenerationwebui:openrouter');
    assert.equal(connectionTypeOfApi('kcpp'), 'textgenerationwebui:koboldcpp');
    assert.equal(connectionTypeOfApi('horde'), 'horde');
    assert.equal(connectionTypeOfApi('nope'), undefined);
    assert.equal(apiOfConnectionType('textgenerationwebui:koboldcpp'), 'koboldcpp');
    assert.equal(apiOfConnectionType('openai:openai'), 'openai');
    assert.equal(apiOfConnectionType('openai:makersuite'), 'google');
});

test('proxies by name; the selected one a ref, or a proxy of its own when it isn\'t a saved one', () => {
    const proxies = [{ name: 'None', url: '', password: '' }, { name: 'Mine', url: 'http://p', password: 'pw' }];
    const saved = proxiesFromUpstream(structuredClone(proxies), { name: 'Mine', url: 'http://p', password: 'pw' });
    assert.deepEqual(saved.proxies.map(p => [p.type, p.key]), [[TYPE.proxy, 'None'], [TYPE.proxy, 'Mine']]);
    assert.equal(saved.selected, 'Mine');
    assert.deepEqual(saved.warnings, []);
    assert.deepEqual(proxiesToUpstream(json(saved.proxies), saved.selected), { proxies, selected_proxy: proxies[1] });

    const edited = proxiesFromUpstream(structuredClone(proxies), { name: 'Mine', url: 'http://other', password: 'pw' });
    assert.equal(edited.selected, 'Mine #2');
    assert.equal(edited.warnings.length, 2);
    assert.deepEqual(proxiesToUpstream(edited.proxies, edited.selected).selected_proxy, { name: 'Mine #2', url: 'http://other', password: 'pw' });
});

test('server history: keyed by label and URL, a repeat kept beside it', () => {
    const servers = [
        { label: 'kobold', url: 'http://127.0.0.1:5001', lastConnection: 1 },
        { label: 'textgenerationwebui_llamacpp', url: 'http://127.0.0.1:8080', lastConnection: 2 },
        { label: 'kobold', url: 'http://127.0.0.1:5001', lastConnection: 3 },
        { label: 'kobold', url: 'not a url', lastConnection: 4 },
    ];
    const { servers: drafts, warnings } = serverHistoryFromUpstream(structuredClone(servers));
    assert.equal(drafts[0].key, 'kobold http://127.0.0.1:5001');
    assert.deepEqual(drafts[0].values, { lastConnection: 1 });
    assert.equal(drafts[2].key, 'kobold http://127.0.0.1:5001 #2');
    assert.equal(warnings.length, 1);
    assert.deepEqual(serverHistoryToUpstream(json(drafts)), servers);
});

test('a connection profile states its bundles by key and names its connection; it comes back as it came', () => {
    const profiles = [
        { id: 'p1', mode: 'tc', name: 'Local', api: 'llamacpp', preset: 'Universal-Light', instruct: 'ChatML', context: 'ChatML', 'instruct-state': 'true', 'api-url': 'http://127.0.0.1:8080', exclude: ['tokenizer'] },
        { id: 'p2', mode: 'cc', name: 'Claude', api: 'claude', preset: 'Default', model: 'claude-x', 'reasoning-template': 'Blank', proxy: 'None', exclude: [] },
        // An alias /api accepts, an API with no connection, a repeated id.
        { id: 'p3', mode: 'tc', name: 'Alias', api: 'kcpp' },
        { id: 'p4', mode: 'cc', name: 'None yet', api: 'deepseek' },
        { id: 'p1', mode: 'cc', name: 'Copy' },
    ];
    const connections = { 'textgenerationwebui:llamacpp': 'c-llama', 'textgenerationwebui:koboldcpp': 'c-kcpp', 'openai:claude': 'c-claude' };
    const { profiles: drafts, selected, warnings } = profilesFromUpstream({ profiles: structuredClone(profiles), selectedProfile: 'p2' }, type => connections[type]);
    assert.equal(selected, 'p2');
    assert.deepEqual(drafts.map(p => p.key), ['p1', 'p2', 'p3', 'p4', 'p1 #2']);
    assert.equal(warnings.length, 1);
    assert.deepEqual(drafts[0].values, {
        mode: 'tc', name: 'Local', connection: 'c-llama', preset: 'textgenerationwebui:Universal-Light',
        instruct: 'instruct:ChatML', context: 'context:ChatML', 'instruct-state': 'true', 'api-url': 'http://127.0.0.1:8080',
    });
    assert.deepEqual(drafts[0].lists, { 0: ['tokenizer'] });
    assert.equal(drafts[1].values['reasoning-template'], 'reasoning:Blank');
    assert.equal(drafts[2].values.api, 'kcpp');
    assert.equal(drafts[3].values.api, 'deepseek');

    const byKey = { 'c-llama': 'textgenerationwebui:llamacpp', 'c-kcpp': 'textgenerationwebui:koboldcpp', 'c-claude': 'openai:claude' };
    const connection = key => byKey[key] ? { type: TYPE.connection, key, values: { type: byKey[key] } } : undefined;
    assert.deepEqual(json(drafts).map(p => profileToUpstream(p, connection)), profiles);
});
