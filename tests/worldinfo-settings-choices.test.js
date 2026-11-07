import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

/** @type {import('node:http').Server} */
let server;
let baseUrl = '';
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {any} */
let directories;
/** @type {typeof import('../src/settings-store.js')} */
let settingsStore;
/** @type {typeof import('../src/settings-hash.js')} */
let settingsHash;

beforeAll(async () => {
    user = await (await import('./converted-user.fixture.js')).emptyUser('st-worldinfo-choices-test-');
    directories = user.directories;
    settingsStore = await import('../src/settings-store.js');
    settingsHash = await import('../src/settings-hash.js');
    await (await import('../src/settings-document.js')).openSettingsDocument(directories, 'u');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/worldinfo', (await import('../src/endpoints/worldinfo.js')).router);
    app.use('/api/settings', (await import('../src/endpoints/settings.js')).router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await user.close();
});

/**
 * @param {string} urlPath
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function postJson(urlPath, body, headers = {}) {
    return fetch(`${baseUrl}${urlPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

/**
 * @param {string} name
 */
async function writeBook(name) {
    expect((await postJson('/api/worldinfo/create', { name, unique: false, data: { entries: { 0: { uid: 0, key: ['k'], content: name } } } })).status).toBe(200);
}

/**
 * @param {string[]} globalSelect
 * @param {Record<string, string>} lorebooks
 */
async function chooseBooks(globalSelect, lorebooks) {
    const settings = settingsStore.readAllSettings(directories);
    await settingsStore.writeAllSettings(directories, {
        ...settings,
        world_info_settings: { ...settings.world_info_settings, world_info: { globalSelect, charLore: [{ name: 'a', extraBooks: globalSelect }] } },
        power_user: { ...settings.power_user, persona_data: Object.fromEntries(Object.entries(lorebooks).map(([avatar, lorebook]) => [avatar, { name: avatar, description: '', lorebook, connections: [] }])) },
    });
}

function chosen() {
    const shown = settingsStore.readSettingsAtPaths(directories, ['world_info_settings.world_info', 'power_user.persona_data']);
    return {
        globalSelect: shown['world_info_settings.world_info'].globalSelect,
        lorebooks: Object.fromEntries(Object.entries(/** @type {Record<string, any>} */ (shown['power_user.persona_data'])).map(([avatar, p]) => [avatar, p.lorebook])),
    };
}

async function settingsVersions() {
    const { TYPE } = await import('../src/library-codes.js');
    const { lib } = user.store;
    const ids = [...await lib.ids(TYPE.user, ['u']), ...await lib.ids(TYPE.persona, ['p.png', 'q.png'])];
    return (await lib.entities(/** @type {bigint[]} */ (ids))).map(e => e?.version);
}

describe('the settings choose lorebooks by id', () => {
    test('a save keeps the names that are books and leaves the rest out', async () => {
        await writeBook('Here');
        const res = await postJson('/api/settings/save-partial', { keys: { 'world_info_settings.world_info': { globalSelect: ['Nowhere', 'Here'] } } });
        expect(res.status).toBe(200);
        const saved = await res.json();
        expect(chosen().globalSelect).toEqual(['Here']);
        expect(saved.settingsHash).toBe(settingsHash.pageSettingsHash(settingsStore.readAllSettings(directories)));
    });

    test('a rename shows the new name everywhere the book is chosen, and writes no settings', async () => {
        await writeBook('Old');
        await writeBook('Other');
        await chooseBooks(['Old', 'Other'], { 'p.png': 'Old', 'q.png': 'Other' });
        const versions = await settingsVersions();

        const result = await (await postJson('/api/worldinfo/rename', { name: 'Old', new_name: 'New' })).json();
        expect(chosen()).toEqual({ globalSelect: ['New', 'Other'], lorebooks: { 'p.png': 'New', 'q.png': 'Other' } });
        expect(result.settings).toEqual(settingsStore.readSettingsAtPaths(directories, ['world_info_settings', 'power_user.persona_data']));
        expect(result.settings_hash).toBe(settingsHash.pageSettingsHash(settingsStore.readAllSettings(directories)));
        expect(await settingsVersions()).toEqual(versions);
        const { settingsDocumentOf } = await import('../src/settings-documents.js');
        expect(settingsDocumentOf(directories)?.settingsFor({ avatar: 'nobody.png', groupId: 'nogroup' }).world_info_settings.world_info.globalSelect).toEqual(['New', 'Other']);

        await writeBook('Unchosen');
        const none = await (await postJson('/api/worldinfo/rename', { name: 'Unchosen', new_name: 'Still unchosen' })).json();
        expect(none.settings).toEqual({});
        expect(none.settings_hash).toBeUndefined();
    });

    test('an overwrite under a name of another case keeps the book chosen where it was, under the new name', async () => {
        await writeBook('Kept Choice');
        await writeBook('Beside');
        await chooseBooks(['Kept Choice', 'Beside'], { 'p.png': 'Kept Choice', 'q.png': 'Beside' });
        const result = await (await postJson('/api/worldinfo/create', { name: 'kept choice', replaces: 'Kept Choice', data: { entries: {} } })).json();
        expect(chosen()).toEqual({ globalSelect: ['kept choice', 'Beside'], lorebooks: { 'p.png': 'kept choice', 'q.png': 'Beside' } });
        expect(result.settings).toEqual(settingsStore.readSettingsAtPaths(directories, ['world_info_settings', 'power_user.persona_data']));
        expect(result.settings_hash).toBe(settingsHash.pageSettingsHash(settingsStore.readAllSettings(directories)));
    });

    test('a delete unchooses the book in the same commit, answers the settings it changed, and a save over that hash goes in', async () => {
        await writeBook('Gone');
        await writeBook('Stays');
        await chooseBooks(['Gone', 'Stays'], { 'p.png': 'Gone', 'q.png': 'Stays' });
        const result = await (await postJson('/api/worldinfo/delete', { name: 'Gone' })).json();
        expect(chosen()).toEqual({ globalSelect: ['Stays'], lorebooks: { 'p.png': '', 'q.png': 'Stays' } });
        expect(result).toEqual({
            ok: true, characters_updated: [], chats_updated: [],
            settings: settingsStore.readSettingsAtPaths(directories, ['world_info_settings', 'power_user.persona_data']),
            settings_hash: settingsHash.pageSettingsHash(settingsStore.readAllSettings(directories)),
        });
        const page = settingsStore.readAllSettings(directories);
        const save = await postJson('/api/settings/save', { ...page, swipes: !page.swipes }, { 'X-Settings-Hash': String(result.settings_hash) });
        expect(save.status).toBe(200);

        await writeBook('Gone');
        expect(chosen().globalSelect).toEqual(['Stays']);
        const { setSettingsDocument } = await import('../src/settings-documents.js');
        const { openSettingsDocument } = await import('../src/settings-document.js');
        setSettingsDocument(directories, undefined);
        await openSettingsDocument(directories, 'u');
        expect(chosen()).toEqual({ globalSelect: ['Stays'], lorebooks: { 'p.png': '', 'q.png': 'Stays' } });
    });
});
