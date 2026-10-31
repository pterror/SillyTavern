import type { CountsView, GreetingOp, ListView, MatchesView, Target } from './protocol.ts';
import { expect, test } from 'vite-plus/test';
import { FIRST_PART, SEARCH_STEP, alternativesArea, itemsOf } from './server.ts';
import type { Alternative, Listed, Ports } from './server.ts';
import { patchOf } from '@st/server-ui';
import type { ActionContext, ActionResult, User } from '@st/server-ui';

function merged(held: unknown, change: unknown): unknown {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && !Array.isArray(value);
    if (!isRecord(held) || !isRecord(change)) return change;
    const out: Record<string, unknown> = { ...held };
    for (const [key, value] of Object.entries(change)) out[key] = merged(held[key], value);
    return out;
}

const user: User = { handle: 'u', directories: { root: '/u' } };
const tokenizer = { api: 'textgenerationwebui' };

const hash = (text: string) => text.length * 31 + (text.length > 0 ? text.charCodeAt(0) : 0);

const said = (text: string, nodeId: string | null = null): Alternative => ({
    nodeId,
    text,
    name: 'Cara',
    isUser: false,
    isSystem: false,
    date: null,
});

function world(listed: (target: Target) => Listed | null, stored: Record<string, number> = {}) {
    const state = {
        stored: { ...stored },
        counted: [] as string[][],
        ops: [] as GreetingOp[],
        refuse: null as string | null,
        hold: null as Promise<void> | null,
    };
    const ports: Ports = {
        list: async (_c, target) => listed(target),
        hash,
        counts: {
            stored: async (_u, _t, texts) => texts.map((text) => state.stored[text] ?? null),
            count: async (_u, _t, texts, each) => {
                state.counted.push(texts);
                for (const [i, text] of texts.entries()) {
                    await state.hold;
                    if (!each(i, text.includes('uncountable') ? null : text.split(' ').length)) return;
                }
            },
        },
        match: (query, texts) =>
            texts.map((text) => {
                const at = text.toLowerCase().indexOf(query.toLowerCase());
                return at < 0 ? null : [at, at + query.length];
            }),
        greeting: async (_u, _a, op) => {
            if (state.refuse !== null) return { ok: false, reason: state.refuse };
            state.ops.push(op);
            return { ok: true };
        },
    };
    const area = alternativesArea(ports);
    const context: ActionContext = { user, session: 's', chat: { tree: '1' }, upload: null };
    const act = (type: string, payload: unknown): Promise<ActionResult> => area.actions[type]!(context, payload);
    const listParts = async () => {
        const parts: ListView[] = [];
        for await (const part of area.views['alternatives.list']!(context) as AsyncIterable<ListView>) parts.push(part);
        return parts;
    };
    const list = async () => (await listParts()).at(-1)!;
    const parts = (key: string) => (area.views[key]!(context) as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    const whole = async <T>(key: string): Promise<T> => {
        let value: unknown;
        for await (const part of area.views[key]!(context) as AsyncIterable<unknown>) {
            const patched = patchOf(part);
            value = patched ? merged(value, patched.value) : part;
        }
        return value as T;
    };
    const counts = () => whole<CountsView>('alternatives.counts');
    const matches = () => whole<MatchesView>('alternatives.matches');
    const gone = () => {
        area.gone(context.session);
    };
    return { state, act, list, listParts, parts, counts, matches, gone };
}

const swipes = (texts: string[], current = 0): Listed => ({
    alternatives: texts.map((text, i) => said(text, `n${i}`)),
    current,
    card: null,
    openings: null,
});

test("a message's alternatives are its swipes in order, each by its node, the current one marked", async () => {
    const w = world(() => swipes(['one', 'two', 'three'], 1));
    await w.act('alternatives.open', { target: { message: 'n1' }, tokenizer });
    const view = await w.list();
    expect(view.target).toEqual({ message: 'n1' });
    expect(view.items.map((i) => [i.id, i.text, i.card])).toEqual([
        ['n0', 'one', null],
        ['n1', 'two', null],
        ['n2', 'three', null],
    ]);
    expect(view.current).toBe(1);
});

test('a long list comes in parts: the rows around the current one first, then more and more, then all', async () => {
    const texts = Array.from({ length: 1000 }, (_, i) => `t${i}`);
    const w = world(() => swipes(texts, 600));
    await w.act('alternatives.open', { target: { message: 'n600' }, tokenizer });
    const parts = await w.listParts();
    expect(parts.map((p) => p.items.length)).toEqual([FIRST_PART, FIRST_PART * 4, FIRST_PART * 16, 1000]);
    expect(parts.map((p) => p.complete)).toEqual([false, false, false, true]);
    expect(parts.every((p) => p.total === 1000)).toBe(true);
    expect(parts[0]!.items.map((i) => i.index)).toEqual(Array.from({ length: FIRST_PART }, (_, i) => 580 + i));
    for (const [n, part] of parts.slice(1).entries()) {
        const ids = new Set(part.items.map((i) => i.id));
        expect(parts[n]!.items.every((i) => ids.has(i.id))).toBe(true);
    }
    const end = world(() => swipes(texts.slice(0, 200), 199));
    await end.act('alternatives.open', { target: { message: 'n199' }, tokenizer });
    expect((await end.listParts())[0]!.items.at(-1)!.index).toBe(199);
    const short = world(() => swipes(['a', 'b']));
    await short.act('alternatives.open', { target: { message: 'n0' }, tokenizer });
    expect(await short.listParts()).toHaveLength(1);
});

test('nothing open: every view is empty, and a search is refused', async () => {
    const w = world(() => swipes(['one']));
    expect(await w.list()).toEqual({
        target: null,
        items: [],
        total: 0,
        complete: true,
        current: null,
        card: null,
        chatOpen: false,
    });
    expect(await w.counts()).toEqual({ counts: {} });
    expect(await w.matches()).toEqual({ query: '', matches: null, checked: 0, total: 0 });
    expect(await w.act('alternatives.search', { query: 'x' })).toMatchObject({ refused: expect.any(String) });
});

test("a target that isn't there lists nothing but says what was asked for", async () => {
    const w = world(() => null);
    await w.act('alternatives.open', { target: { message: 'gone' }, tokenizer });
    expect(await w.list()).toMatchObject({ target: { message: 'gone' }, items: [], current: null });
});

test('an opening list: stored openings carry the card position of the greeting with their text, card-only ones theirs', async () => {
    const w = world(() => ({
        alternatives: [said('Hello there.\n', 'n0'), said('Edited in chat', 'n1'), said('Second greeting')],
        current: 0,
        card: { avatar: 'cara.png', greetings: ['Hello there.', 'Second greeting'], defaultPosition: 0 },
        openings: null,
    }));
    await w.act('alternatives.open', { target: { opening: true }, tokenizer });
    const view = await w.list();
    expect(view.items.map((i) => [i.id, i.card?.position ?? null])).toEqual([
        ['n0', 0],
        ['n1', null],
        [`card:${hash('Second greeting')}`, 1],
    ]);
    expect(view.items[2]!.card?.hash).toBe(hash('Second greeting'));
    expect(view.card).toEqual({
        avatar: 'cara.png',
        greetings: ['Hello there.', 'Second greeting'],
        hashes: [hash('Hello there.'), hash('Second greeting')],
        defaultPosition: 0,
    });
});

test("a greetings list is the card's, in card order; with the character's chat open each says where it is among the openings", async () => {
    const card = { avatar: 'cara.png', greetings: ['A', 'B', 'C'], defaultPosition: 1 };
    const w = world(() => ({
        alternatives: card.greetings.map((text) => said(text)),
        current: 1,
        card,
        openings: ['stored one', 'C', 'A', 'B'],
    }));
    await w.act('alternatives.open', { target: { greetings: 'cara.png' }, tokenizer });
    const view = await w.list();
    expect(view.items.map((i) => [i.id, i.card?.position, i.opening])).toEqual([
        [`card:${hash('A')}`, 0, 2],
        [`card:${hash('B')}`, 1, 3],
        [`card:${hash('C')}`, 2, 1],
    ]);
    expect(view.chatOpen).toBe(true);
    expect(view.current).toBe(1);
});

test('with no chat of the character open, no greeting can be shown in one', async () => {
    const w = world(() => ({
        alternatives: [said('A')],
        current: 0,
        card: { avatar: 'cara.png', greetings: ['A'], defaultPosition: 0 },
        openings: null,
    }));
    await w.act('alternatives.open', { target: { greetings: 'cara.png' }, tokenizer });
    const view = await w.list();
    expect(view.chatOpen).toBe(false);
    expect(view.items[0]!.opening).toBeNull();
});

test('counts: what the store has comes at once; each miss follows as soon as it is counted, once', async () => {
    const w = world(() => swipes(['a b', 'c d e', 'f']), { 'a b': 2 });
    let release = () => {};
    w.state.hold = new Promise((resolve) => (release = resolve));
    await w.act('alternatives.open', { target: { message: 'n0' }, tokenizer });
    await w.list();
    const counts = w.parts('alternatives.counts');
    expect((await counts.next()).value).toEqual({ counts: { n0: 2 } });
    const again = w.parts('alternatives.counts');
    expect((await again.next()).value).toEqual({ counts: { n0: 2 } });
    release();
    const patches: unknown[] = [];
    for (let next = await counts.next(); next.done !== true; next = await counts.next())
        patches.push(patchOf(next.value)?.value);
    expect(patches.reduce((all, part) => merged(all, part), { counts: {} })).toEqual({ counts: { n1: 3, n2: 1 } });
    expect(patches.every((part) => Object.keys((part as { counts: object }).counts).length > 0)).toBe(true);
    expect(w.state.counted).toEqual([['c d e', 'f']]);
    expect(await w.counts()).toEqual({ counts: { n0: 2, n1: 3, n2: 1 } });
});

test("a text that can't be counted isn't asked for again, and has no count", async () => {
    const w = world(() => swipes(['uncountable']));
    await w.act('alternatives.open', { target: { message: 'n0' }, tokenizer });
    await w.list();
    expect(await w.counts()).toEqual({ counts: {} });
    expect(await w.counts()).toEqual({ counts: {} });
    expect(w.state.counted).toEqual([['uncountable']]);
});

test('closing stops the counting: what is left is not counted', async () => {
    const w = world(() => swipes(['a', 'b', 'c']));
    let release = () => {};
    w.state.hold = new Promise((resolve) => (release = resolve));
    await w.act('alternatives.open', { target: { message: 'n0' }, tokenizer });
    await w.list();
    const counts = w.parts('alternatives.counts');
    await counts.next();
    await w.act('alternatives.close', {});
    release();
    const told: unknown[] = [];
    for (let next = await counts.next(); next.done !== true; next = await counts.next()) told.push(next.value);
    expect(told.length).toBeLessThanOrEqual(1);
});

test('a tab gone: its look goes', async () => {
    const w = world(() => swipes(['a']));
    await w.act('alternatives.open', { target: { message: 'n0' }, tokenizer });
    w.gone();
    expect((await w.list()).target).toBeNull();
});

test('misses are counted nearest the current one first', async () => {
    const w = world(() => swipes(['a', 'b', 'c', 'd', 'e'], 3));
    await w.act('alternatives.open', { target: { message: 'n3' }, tokenizer });
    await w.list();
    await w.counts();
    expect(w.state.counted[0]!.slice(0, 3)).toEqual(['d', 'c', 'e']);
});

test('with no tokenizer nothing is counted', async () => {
    const w = world(() => swipes(['a']));
    await w.act('alternatives.open', { target: { message: 'n0' }, tokenizer: null });
    await w.list();
    expect((await w.counts()).counts).toEqual({});
    expect(w.state.counted).toEqual([]);
});

test('search: the matching items by id with their ranges; an empty query is no search; opening again clears it', async () => {
    const w = world(() => swipes(['The big sister', 'nothing', 'BIG']));
    await w.act('alternatives.open', { target: { message: 'n0' }, tokenizer });
    await w.list();
    expect(await w.act('alternatives.search', { query: 'big' })).toEqual({ changed: ['alternatives.matches'] });
    expect(await w.matches()).toEqual({
        query: 'big',
        matches: { n0: [4, 7], n2: [0, 3] },
        checked: 3,
        total: 3,
    });
    await w.act('alternatives.search', { query: '  ' });
    expect((await w.matches()).matches).toBeNull();
    await w.act('alternatives.search', { query: 'big' });
    await w.act('alternatives.open', { target: { message: 'n0' }, tokenizer });
    expect(await w.matches()).toEqual({ query: '', matches: null, checked: 0, total: 0 });
});

test('a search over many sends what each step found as it finds it, with how far it is; a newer search stops it', async () => {
    const texts = Array.from({ length: SEARCH_STEP * 2 + 10 }, (_, i) => (i % 100 === 0 ? `big ${i}` : `small ${i}`));
    const w = world(() => swipes(texts));
    await w.act('alternatives.open', { target: { message: 'n0' }, tokenizer });
    await w.list();
    await w.act('alternatives.search', { query: 'big' });
    const found = w.parts('alternatives.matches');
    expect((await found.next()).value).toEqual({
        query: 'big',
        total: texts.length,
        checked: SEARCH_STEP,
        matches: { n0: [0, 3], n100: [0, 3] },
    });
    const next = patchOf((await found.next()).value)?.value as { checked: number; matches: Record<string, number[]> };
    expect(next.checked).toBeGreaterThanOrEqual(SEARCH_STEP * 2);
    expect(next.matches).toMatchObject({ n200: [0, 3], n300: [0, 3] });
    expect((await w.matches()).checked).toBe(texts.length);
    expect(Object.keys((await w.matches()).matches!)).toEqual(['n0', 'n100', 'n200', 'n300', 'n400']);
    const old = w.parts('alternatives.matches');
    await old.next();
    await w.act('alternatives.search', { query: 'small' });
    expect((await old.next()).done).toBe(true);
});

test('closing forgets the look: the views are empty again', async () => {
    const w = world(() => swipes(['a']));
    await w.act('alternatives.open', { target: { message: 'n0' }, tokenizer });
    expect((await w.list()).items).toHaveLength(1);
    await w.act('alternatives.close', {});
    expect((await w.list()).target).toBeNull();
});

const greetingsWorld = (greetings: string[]) =>
    world(() => ({
        alternatives: greetings.map((text) => said(text)),
        current: greetings.length > 0 ? 0 : null,
        card: { avatar: 'cara.png', greetings, defaultPosition: greetings.length > 0 ? 0 : null },
        openings: null,
    }));

test("greeting operations go to the target's card; an edit to empty text removes the greeting", async () => {
    const w = greetingsWorld(['A', 'B']);
    await w.act('alternatives.open', { target: { greetings: 'cara.png' }, tokenizer });
    await w.list();
    expect(await w.act('alternatives.greeting', { op: 'edit', position: 1, hash: hash('B'), text: 'B2' })).toEqual({
        changed: ['alternatives.list', 'alternatives.counts', 'alternatives.matches'],
    });
    await w.act('alternatives.greeting', { op: 'edit', position: 1, hash: hash('B2'), text: ' \n' });
    await w.act('alternatives.greeting', {
        op: 'move',
        position: 1,
        hash: hash('B'),
        side: 'before',
        target: 0,
        targetHash: hash('A'),
    });
    expect(w.state.ops).toEqual([
        { op: 'edit', position: 1, hash: hash('B'), text: 'B2' },
        { op: 'delete', position: 1, hash: hash('B2') },
        { op: 'move', position: 1, hash: hash('B'), side: 'before', target: 0, targetHash: hash('A') },
    ]);
});

test("an opening list's greeting operations go to the open chat's character's card", async () => {
    const w = world(() => ({
        alternatives: [said('A', 'n0')],
        current: 0,
        card: { avatar: 'cara.png', greetings: ['A'], defaultPosition: 0 },
        openings: null,
    }));
    await w.act('alternatives.open', { target: { opening: true }, tokenizer });
    await w.list();
    await w.act('alternatives.greeting', { op: 'add', text: 'New' });
    expect(w.state.ops).toEqual([{ op: 'add', text: 'New' }]);
});

test("a message's alternatives have no card: greeting operations are refused", async () => {
    const w = world(() => swipes(['a']));
    await w.act('alternatives.open', { target: { message: 'n0' }, tokenizer });
    await w.list();
    expect(await w.act('alternatives.greeting', { op: 'add', text: 'x' })).toMatchObject({
        refused: expect.any(String),
    });
    expect(w.state.ops).toEqual([]);
});

test('a refused operation says why, and the views are read again', async () => {
    const w = greetingsWorld(['A']);
    await w.act('alternatives.open', { target: { greetings: 'cara.png' }, tokenizer });
    await w.list();
    w.state.refuse = 'expected_hash does not match';
    expect(await w.act('alternatives.greeting', { op: 'delete', position: 0, hash: 1 })).toEqual({
        refused: 'expected_hash does not match',
        changed: ['alternatives.list', 'alternatives.counts', 'alternatives.matches'],
    });
});

test("a character's first greeting becomes its default", async () => {
    const w = greetingsWorld([]);
    await w.act('alternatives.open', { target: { greetings: 'cara.png' }, tokenizer });
    await w.list();
    await w.act('alternatives.greeting', { op: 'add', text: 'Hi' });
    expect(w.state.ops).toEqual([
        { op: 'add', text: 'Hi' },
        { op: 'default', position: 0, hash: hash('Hi') },
    ]);
});

test('a greeting is known by its text, wherever it moves; the same text twice is told apart', () => {
    const listed = (greetings: string[]): Listed => ({
        alternatives: greetings.map((text) => said(text)),
        current: 0,
        card: { avatar: 'a', greetings, defaultPosition: 0 },
        openings: null,
    });
    const ids = (greetings: string[]) => itemsOf(listed(greetings), { greetings: 'a' }, hash).map((i) => i.id);
    const [a, b] = ids(['Hello', 'Goodbye!']);
    expect(ids(['Goodbye!', 'Hello'])).toEqual([b, a]);
    expect(ids(['Hello', 'Hello'])).toEqual([a, `${a}:1`]);
});

test('itemsOf: a card greeting appears at its first position when the card has its text twice', () => {
    const items = itemsOf(
        {
            alternatives: [said('Same', 'n0')],
            current: 0,
            card: { avatar: 'a', greetings: ['Other', 'Same', 'Same'], defaultPosition: 0 },
            openings: null,
        },
        { opening: true },
        hash,
    );
    expect(items[0]!.card).toEqual({ position: 1, hash: hash('Same') });
});
