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
    expect(await chats.cardChoice(ids[0], p)).toEqual({ id: pModel.greetings[1].id, epoch: 0 });
    expect(pModel.greetings[1].text).toBe('Third');
    expect(await chats.cardChoice(ids[1], q)).toEqual({ id: qModel.greetings[1].id, epoch: 0 });
    expect(await chats.cardChoice(ids[2], p)).toEqual({ id: pModel.greetings[0].id, epoch: 0 });
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
        expect(await stores.oldFormatLine({ root })).toContain('convert-greeting-duplicates.mjs');
        expect(run()).toContain('Users: 1 (1 already converted)');
        expect(execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-greeting-duplicates.mjs'), '--data-root', dataRoot], { encoding: 'utf8' })).toContain('Users: 1 (0 already converted). Greetings removed as copies of an earlier one: 0.');
        expect(await stores.oldFormatLine({ root })).toContain('convert-lorebooks-to-worldbuilding.mjs');
        expect(execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-lorebooks-to-worldbuilding.mjs'), '--data-root', dataRoot], { encoding: 'utf8' })).toContain('Users: 1 (0 already converted).');
        expect(await stores.oldFormatLine({ root })).toContain('convert-card-lorebook-copies.mjs');
        expect(execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-card-lorebook-copies.mjs'), '--data-root', dataRoot], { encoding: 'utf8' })).toContain('Users: 1 (0 already converted). Lorebooks looked at: 0.');
        expect(await stores.oldFormatLine({ root })).toContain('convert-message-order.mjs');
        expect(execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-message-order.mjs'), '--data-root', dataRoot], { encoding: 'utf8' })).toContain('Users: 1 (0 already converted). Steps of 2000 messages: 1.');
        expect(await stores.oldFormatLine({ root })).toContain('convert-greeting-links-exact.mjs');
        expect(execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-greeting-links-exact.mjs'), '--data-root', dataRoot], { encoding: 'utf8' })).toContain('Users: 1 (0 already converted). Openings that held a greeting whose text differs from theirs in whitespace, and hold it no more: 0.');
        expect(await stores.oldFormatLine({ root })).toBeNull();
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('every stored first message with a card greeting\'s exact text is linked to it, once; any other keeps where it came from, unlinked', async () => {
    const { lib } = user.store;
    const { convertOpeningLinks } = await import('../src/greeting-choice-conversion.js');
    const { hashGreetingText } = await import('../src/greeting-ops.js');
    await lib.writeCard(user.directories, 'r.png', JSON.stringify({
        spec: 'chara_card_v2', spec_version: '2.0', name: 'R',
        data: { name: 'R', description: '', first_mes: 'Hello', alternate_greetings: ['Bye'], extensions: {} },
    }));
    const [tree] = await user.store.people.trees([{ avatar: 'r.png' }]);
    const { greetings } = await lib.greetingModel('r.png');
    const old = [
        { name: 'You', is_user: true, mes: 'Hello', extra: {} },
        { name: 'R', is_user: false, mes: ' Bye ', extra: {} },
        { name: 'R', is_user: false, mes: 'Mine', extra: { greeting_id: greetings[0].id } },
    ];
    const { ChatEngine } = await import('../src/chat-engine.js');
    const { libraryPeople } = await import('../src/chat-people.js');
    const before = await ChatEngine.open(lib.store, { ...user.store.people, greetings: undefined }, await lib.nextIds());
    for (const content of old) {
        await before.appendMessages({ tree, treeSpeaker: null, after: null, contents: [content], actor: { user: 'u' } });
    }
    const links = async (/** @type {any} */ engine) => (await engine.openings(tree)).map(o => [o.message.mes, o.message.extra?.greeting_id ?? null, o.message.extra?.greeting_hash ?? null]);
    expect(await links(before)).toEqual([['Hello', null, null], [' Bye ', null, null], ['Mine', greetings[0].id, null]]);

    const after = await ChatEngine.open(lib.store, libraryPeople(lib), await lib.nextIds());
    expect(await convertOpeningLinks(lib, after, 'u')).toBe(1);
    expect(await links(after)).toEqual([[' Bye ', null, null], ['Hello', greetings[0].id, hashGreetingText('Hello')], ['Mine', greetings[0].id, null]]);
    expect(await convertOpeningLinks(lib, after, 'u')).toBe(0);
});

test('an opening that holds a greeting whose text differs from its own in whitespace holds it no more, once; the speaker and every other link stay', async () => {
    const { lib, chats } = user.store;
    const { convertTrimmedOpeningLinks } = await import('../src/greeting-choice-conversion.js');
    const { hashGreetingText } = await import('../src/greeting-ops.js');
    const { speakerIdOf } = await import('../src/chat-codec.js');
    await lib.writeCard(user.directories, 's.png', JSON.stringify({
        spec: 'chara_card_v2', spec_version: '2.0', name: 'S',
        data: { name: 'S', description: '', first_mes: 'Hello', alternate_greetings: ['Bye', 'Later'], extensions: {} },
    }));
    const [tree] = await user.store.people.trees([{ avatar: 's.png' }]);
    const [speaker] = (await user.store.people.byAvatar(['s.png'])).values();
    const { greetings } = await lib.greetingModel('s.png');
    const [hello, bye, later] = greetings.map(g => g.id);
    const actor = { user: 'u', session: '0190a1b2-0000-7000-8000-0000000000c9' };
    const open = async (/** @type {string} */ mes, /** @type {number} */ greetingId) => (await chats.appendMessages({ tree, treeSpeaker: speaker, after: null, contents: [{ name: 'S', is_user: false, mes, extra: { greeting_id: greetingId } }], actor })).node_ids[0];
    const spaced = await open(' Hello\n', hello);
    await open('Bye', bye);
    const stale = await open('Later, edited', later);
    const linkAs = async (/** @type {string} */ node, /** @type {string} */ text) => {
        const [id] = await chats.messageIds([node]);
        await lib.store.commit([{ kind: 'jsonValue', message: id, field: 'greeting_hash', json: JSON.stringify(hashGreetingText(text)) }]);
    };
    await linkAs(spaced, 'Hello');
    await linkAs(stale, 'Later, before');
    const links = async () => (await chats.openings(tree)).map(o => [o.message.mes, o.message.extra?.greeting_id ?? null, o.message.extra?.greeting_hash ?? null, o.message.name, speakerIdOf(o.stored)]);
    const listed = async () => (await chats.openingAlternatives({ tree, actor, range: { limit: 10 }, card: await chats.cardGreetings(tree) })).alternatives.map((/** @type {any} */ a) => [a.mes, a.node_id === null]);
    expect(await listed()).toEqual([[' Hello\n', false], ['Bye', false], ['Later', true], ['Later, edited', false]]);

    expect(await convertTrimmedOpeningLinks(lib, chats, 'u')).toBe(1);
    expect(await links()).toEqual(expect.arrayContaining([
        [' Hello\n', hello, null, 'S', tree],
        ['Bye', bye, hashGreetingText('Bye'), 'S', tree],
        ['Later, edited', later, hashGreetingText('Later, before'), 'S', tree],
    ]));
    expect(await listed()).toEqual([['Hello', true], [' Hello\n', false], ['Bye', false], ['Later', true], ['Later, edited', false]]);
    expect(await convertTrimmedOpeningLinks(lib, chats, 'u')).toBe(0);
});

test('a store converted by the first version of the script gets the links when it runs again, and then opens', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const { execFileSync } = await import('node:child_process');
    const stores = await import('../src/user-stores.js');
    const { LibraryEngine } = await import('../src/library-engine.js');
    const { loadEngine } = await import('../engine/load.js');
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-greeting-links-script-'));
    try {
        const root = path.join(dataRoot, 'u');
        const dir = path.join(root, stores.STORE_DIR);
        const lib = await LibraryEngine.open(loadEngine().binding, dir);
        await lib.close();
        fs.writeFileSync(path.join(dir, stores.GREETINGS_BY_ID), '');
        expect(await stores.oldFormatLine({ root })).toContain('convert-greeting-choices.mjs');
        const run = () => execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-greeting-choices.mjs'), '--data-root', dataRoot], { encoding: 'utf8' });
        expect(run()).toContain('Users: 1 (0 already converted)');
        expect(fs.existsSync(path.join(dir, stores.GREETING_LINKS))).toBe(true);
        expect(await stores.oldFormatLine({ root })).toContain('convert-greeting-duplicates.mjs');
        expect(run()).toContain('Users: 1 (1 already converted)');
        expect(execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-greeting-duplicates.mjs'), '--data-root', dataRoot], { encoding: 'utf8' })).toContain('Users: 1 (0 already converted). Greetings removed as copies of an earlier one: 0.');
        expect(await stores.oldFormatLine({ root })).toContain('convert-lorebooks-to-worldbuilding.mjs');
        expect(execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-lorebooks-to-worldbuilding.mjs'), '--data-root', dataRoot], { encoding: 'utf8' })).toContain('Users: 1 (0 already converted).');
        expect(await stores.oldFormatLine({ root })).toContain('convert-card-lorebook-copies.mjs');
        expect(execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-card-lorebook-copies.mjs'), '--data-root', dataRoot], { encoding: 'utf8' })).toContain('Users: 1 (0 already converted). Lorebooks looked at: 0.');
        expect(await stores.oldFormatLine({ root })).toContain('convert-message-order.mjs');
        expect(execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-message-order.mjs'), '--data-root', dataRoot], { encoding: 'utf8' })).toContain('Users: 1 (0 already converted). Steps of 2000 messages: 1.');
        expect(await stores.oldFormatLine({ root })).toContain('convert-greeting-links-exact.mjs');
        expect(execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-greeting-links-exact.mjs'), '--data-root', dataRoot], { encoding: 'utf8' })).toContain('Users: 1 (0 already converted). Openings that held a greeting whose text differs from theirs in whitespace, and hold it no more: 0.');
        expect(await stores.oldFormatLine({ root })).toBeNull();
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('a card stored with the same greeting twice keeps the first copy, and what named the other copy names it', async () => {
    const { lib, chats } = user.store;
    const { convertDuplicateGreetings } = await import('../src/greeting-choice-conversion.js');
    const { itemField } = await import('../src/entity-values.js');
    const { FIELD, TYPE } = await import('../src/library-codes.js');
    const { showGreeting, shownGreeting } = await import('../src/tab-views.js');
    await lib.writeCard(user.directories, 'twice.png', JSON.stringify({
        spec: 'chara_card_v2', spec_version: '2.0', name: 'Twice',
        data: { name: 'Twice', description: '', first_mes: 'Same', alternate_greetings: ['Other'], extensions: {} },
    }));
    const entity = await lib.entity(TYPE.character, 'twice.png');
    await lib.store.commit([
        { kind: 'itemPlace', entity: entity.id, list: 0, item: 7, position: 2 ** 30 },
        { kind: 'textValue', entity: entity.id, field: itemField(0, 7), text: 'Same' },
        { kind: 'jsonValue', entity: entity.id, field: FIELD.greeting_next_item, json: '8' },
    ]);
    expect((await lib.greetingModel('twice.png')).greetings.map(g => [g.id, g.text])).toEqual([[0, 'Same'], [1, 'Other'], [7, 'Same']]);
    const [tree] = await user.store.people.trees([{ avatar: 'twice.png' }]);
    const session = '0190a1b2-0000-7000-8000-0000000000b7';
    await chats.chooseCardGreeting({ tree, greetingId: 7, actor: { user: 'u', session } });
    await showGreeting(lib, session, 'twice.png', 7, 1);
    const { ChatEngine } = await import('../src/chat-engine.js');
    const unlinked = await ChatEngine.open(lib.store, { ...user.store.people, greetings: undefined }, await lib.nextIds());
    await unlinked.appendMessages({ tree, treeSpeaker: null, after: null, contents: [{ name: 'Twice', is_user: false, mes: 'Same', extra: { greeting_id: 7 } }], actor: { user: 'u' } });

    const { libraryPeople } = await import('../src/chat-people.js');
    const after = await ChatEngine.open(lib.store, libraryPeople(lib), await lib.nextIds());
    expect(await convertDuplicateGreetings(lib, after, 'u', user.directories)).toBe(1);
    const model = await lib.greetingModel('twice.png');
    expect(model.greetings.map(g => [g.id, g.text])).toEqual([[0, 'Same'], [1, 'Other']]);
    expect(model.defaultId).toBe(0);
    const [sid] = await lib.store.chatRead('ids', { space: 1, keys: [session] });
    expect(await after.cardChoice(sid, tree)).toEqual({ id: 0, epoch: model.defaultEpoch });
    expect(await shownGreeting(lib, session, 'twice.png')).toBe(0);
    expect((await after.openings(tree)).map(o => o.message.extra.greeting_id)).toEqual([0]);
    expect(await convertDuplicateGreetings(lib, after, 'u', user.directories)).toBe(0);
});
