import { afterAll, beforeAll, expect, test } from '@jest/globals';
import path from 'node:path';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    user = await (await import('./converted-user.fixture.js')).emptyUser('st-greeting-choice-conversion-test-');
    globalThis.DATA_ROOT = user.dataRoot;
});

afterAll(() => user.close());

test('a choice remembered as a place on the card becomes the id of the greeting at that place, in the same order of recent chats', async () => {
    const { lib, chats } = user.store;
    const { convertGreetingChoices } = await import('../src/greeting-choice-conversion.js');
    const card = (/** @type {string} */ name, /** @type {string[]} */ alternates) => JSON.stringify({
        spec: 'chara_card_v2', spec_version: '2.0', name,
        data: { name, description: '', first_mes: 'First', alternate_greetings: alternates, extensions: {} },
    });
    await lib.writeCard(user.directories, 'p.png', card('P', ['Second', 'Third']));
    await lib.writeCard(user.directories, 'q.png', card('Q', ['Only other']));
    await lib.writeCard(user.directories, 'p.png', card('P', ['Third', 'Second']));
    const [p, q] = await user.store.people.trees([{ avatar: 'p.png' }, { avatar: 'q.png' }]);
    const sessions = ['0190a1b2-0000-7000-8000-0000000000a1', '0190a1b2-0000-7000-8000-0000000000a2', '0190a1b2-0000-7000-8000-0000000000a3'];
    for (const [session, tree] of [[sessions[0], p], [sessions[1], q], [sessions[2], p]]) {
        await chats.chooseCardGreeting({ tree, greetingId: null, actor: { user: 'u', session } });
    }
    const ids = await lib.store.chatRead('ids', { space: 1, keys: sessions });
    const [u] = await lib.store.chatRead('ids', { space: 2, keys: ['u'] });
    await lib.store.commit([
        { kind: 'openingChoice', session: ids[0], user: u, tree: p, index: 1 },
        { kind: 'openingChoice', session: ids[1], user: u, tree: q, index: 5 },
        { kind: 'openingChoice', session: ids[2], user: u, tree: p, index: 0 },
    ]);
    const order = async () => (await lib.store.chatRead('conversations', { limit: 10 })).map(c => c.session);
    const before = await order();

    expect(await convertGreetingChoices(lib, 'u')).toBe(3);

    const pModel = await lib.greetingModel('p.png');
    const qModel = await lib.greetingModel('q.png');
    expect(await chats.cardChoice(ids[0], p)).toBe(pModel.greetings[1].id);
    expect(pModel.greetings[1].text).toBe('Third');
    expect(await chats.cardChoice(ids[1], q)).toBe(qModel.greetings[1].id);
    expect(await chats.cardChoice(ids[2], p)).toBe(pModel.greetings[0].id);
    expect(await order()).toEqual(before);
});

test('a store from before greeting ids is refused until the conversion script has run on it, once', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const { execFileSync } = await import('node:child_process');
    const stores = await import('../src/user-stores.js');
    const { LibraryEngine } = await import('../src/library-engine.js');
    const { loadEngine } = await import('../engine/load.js');
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-greeting-choice-script-'));
    try {
        const root = path.join(dataRoot, 'u');
        const lib = await LibraryEngine.open(loadEngine().binding, path.join(root, stores.STORE_DIR));
        await lib.close();
        expect(await stores.oldFormatLine({ root })).toContain('convert-greeting-choices.mjs');
        const run = () => execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-greeting-choices.mjs'), '--data-root', dataRoot], { encoding: 'utf8' });
        expect(run()).toContain('Users: 1 (0 already converted)');
        expect(await stores.oldFormatLine({ root })).toBeNull();
        expect(run()).toContain('Users: 1 (1 already converted)');
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});
