import type { CountsView, ListView, MatchesView, Target } from './protocol.ts';
import { expect, test } from 'vite-plus/test';
import { FIRST_PART, SEARCH_STEP, alternativesArea, itemsOf } from './server.ts';
import type { Alternative, GreetingChange, Listed, Ports } from './server.ts';
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

const said = (text: string, nodeId: string): Alternative => ({
    id: nodeId,
    nodeId,
    greeting: null,
    text,
    name: 'Cara',
    isUser: false,
    isSystem: false,
    date: null,
});

/** an alternative that is greeting `id` of `avatar`'s card: stored as `nodeId`, or not stored */
const greetingAlt = (text: string, avatar: string, id: number, nodeId: string | null = null): Alternative => ({
    ...said(text, nodeId ?? `card:${id}:${avatar}`),
    nodeId,
    greeting: { avatar, id },
});

const cardOf = (
    avatar: string,
    greetings: string[],
    defaultPosition: number | null = 0,
    ids = greetings.map((_, k) => k),
) => ({
    avatar,
    ids,
    greetings,
    defaultPosition,
});

function world(listed: (target: Target) => Listed | null, stored: Record<string, number> = {}) {
    const state = {
        stored: { ...stored },
        counted: [] as string[][],
        ops: [] as [string, GreetingChange][],
        moves: [] as [string, { after: string } | { first: true }][],
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
        greeting: async (_u, avatar, op) => {
            if (state.refuse !== null) return { ok: false, reason: state.refuse };
            state.ops.push([avatar, op]);
            return { ok: true, opening: null };
        },
        move: async (_c, nodeId, place) => {
            if (state.refuse !== null) return { ok: false, reason: state.refuse };
            state.moves.push([nodeId, place]);
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
    cards: [],
    addsTo: null,
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
        cards: [],
        addsTo: null,
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

test('an opening list: an opening that is a card greeting carries its card place, by its id and character', async () => {
    const w = world(() => ({
        alternatives: [
            greetingAlt('Hello there.', 'cara.png', 4, 'n0'),
            said('Hello there.\n', 'n1'),
            said('Edited in chat', 'n2'),
            greetingAlt('Second greeting', 'cara.png', 2),
        ],
        current: 0,
        cards: [cardOf('cara.png', ['Hello there.', 'Second greeting'], 0, [4, 2])],
        addsTo: 'cara.png',
        openings: null,
    }));
    await w.act('alternatives.open', { target: { opening: true }, tokenizer });
    const view = await w.list();
    expect(view.items.map((i) => [i.id, i.card])).toEqual([
        ['n0', { avatar: 'cara.png', id: 4, position: 0, hash: hash('Hello there.') }],
        ['n1', null],
        ['n2', null],
        ['card:2:cara.png', { avatar: 'cara.png', id: 2, position: 1, hash: hash('Second greeting') }],
    ]);
    expect(view.cards).toEqual([
        {
            avatar: 'cara.png',
            ids: [4, 2],
            greetings: ['Hello there.', 'Second greeting'],
            hashes: [hash('Hello there.'), hash('Second greeting')],
            defaultPosition: 0,
        },
    ]);
    expect(view.addsTo).toBe('cara.png');
});

test("a group's opening list: each greeting is on its member's card, the same id on two cards two places", async () => {
    const w = world(() => ({
        alternatives: [
            greetingAlt('Hi', 'ann.png', 0),
            greetingAlt('Hi', 'bo.png', 0),
            greetingAlt('Yo', 'bo.png', 1, 'n0'),
        ],
        current: 0,
        cards: [cardOf('ann.png', ['Hi']), cardOf('bo.png', ['Hi', 'Yo'], 1)],
        addsTo: null,
        openings: null,
    }));
    await w.act('alternatives.open', { target: { opening: true }, tokenizer });
    const view = await w.list();
    expect(view.items.map((i) => [i.id, i.card?.avatar, i.card?.position])).toEqual([
        ['card:0:ann.png', 'ann.png', 0],
        ['card:0:bo.png', 'bo.png', 0],
        ['n0', 'bo.png', 1],
    ]);
    expect(view.cards.map((c) => [c.avatar, c.defaultPosition])).toEqual([
        ['ann.png', 0],
        ['bo.png', 1],
    ]);
    expect(view.addsTo).toBeNull();
});

test("a card with an empty greeting: the positions after it are still each id's", () => {
    const items = itemsOf(
        {
            alternatives: [greetingAlt('B', 'a', 9)],
            current: 0,
            cards: [cardOf('a', ['A', '', 'B'], 0, [3, 5, 9])],
            addsTo: 'a',
            openings: null,
        },
        hash,
    );
    expect(items[0]!.card).toEqual({ avatar: 'a', id: 9, position: 2, hash: hash('B') });
});

test("a greetings list is the card's, in card order; with a chat offering it open each says where it is among the openings", async () => {
    const card = cardOf('cara.png', ['A', 'B', 'C'], 1, [0, 1, 2]);
    const w = world(() => ({
        alternatives: card.greetings.map((text, k) => greetingAlt(text, 'cara.png', k)),
        current: 1,
        cards: [card],
        addsTo: 'cara.png',
        openings: [
            null,
            { avatar: 'cara.png', id: 2 },
            { avatar: 'other.png', id: 1 },
            { avatar: 'cara.png', id: 0 },
            { avatar: 'cara.png', id: 1 },
        ],
    }));
    await w.act('alternatives.open', { target: { greetings: 'cara.png' }, tokenizer });
    const view = await w.list();
    expect(view.items.map((i) => [i.id, i.card?.position, i.opening])).toEqual([
        ['card:0:cara.png', 0, 3],
        ['card:1:cara.png', 1, 4],
        ['card:2:cara.png', 2, 1],
    ]);
    expect(view.chatOpen).toBe(true);
    expect(view.current).toBe(1);
});

test('with no chat of the character open, no greeting can be shown in one', async () => {
    const w = world(() => ({
        alternatives: [greetingAlt('A', 'cara.png', 0)],
        current: 0,
        cards: [cardOf('cara.png', ['A'])],
        addsTo: 'cara.png',
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
        alternatives: greetings.map((text, k) => greetingAlt(text, 'cara.png', k)),
        current: greetings.length > 0 ? 0 : null,
        cards: [cardOf('cara.png', greetings, greetings.length > 0 ? 0 : null)],
        addsTo: 'cara.png',
        openings: null,
    }));

test('greeting operations go to the card they name; an edit to empty text removes the greeting', async () => {
    const w = greetingsWorld(['A', 'B']);
    await w.act('alternatives.open', { target: { greetings: 'cara.png' }, tokenizer });
    await w.list();
    expect(
        await w.act('alternatives.greeting', {
            op: 'edit',
            avatar: 'cara.png',
            id: 1,
            hash: hash('B'),
            text: 'B2',
        }),
    ).toEqual({
        changed: ['alternatives.list', 'alternatives.counts', 'alternatives.matches'],
        answer: { opening: null },
    });
    await w.act('alternatives.greeting', {
        op: 'edit',
        avatar: 'cara.png',
        id: 1,
        hash: hash('B2'),
        text: ' \n',
    });
    await w.act('alternatives.greeting', {
        op: 'move',
        avatar: 'cara.png',
        id: 1,
        hash: hash('B'),
        side: 'before',
        target: 0,
        targetHash: hash('A'),
    });
    expect(w.state.ops).toEqual([
        ['cara.png', { op: 'edit', id: 1, hash: hash('B'), text: 'B2' }],
        ['cara.png', { op: 'delete', id: 1, hash: hash('B2') }],
        ['cara.png', { op: 'move', id: 1, hash: hash('B'), side: 'before', target: 0, targetHash: hash('A') }],
    ]);
});

test("an opening list's greeting operations go to the open chat's character's card", async () => {
    const w = world(() => ({
        alternatives: [greetingAlt('A', 'cara.png', 0, 'n0')],
        current: 0,
        cards: [cardOf('cara.png', ['A'])],
        addsTo: 'cara.png',
        openings: null,
    }));
    await w.act('alternatives.open', { target: { opening: true }, tokenizer });
    await w.list();
    await w.act('alternatives.greeting', { op: 'add', avatar: 'cara.png', text: 'New' });
    expect(w.state.ops).toEqual([['cara.png', { op: 'add', text: 'New' }]]);
});

test("a group's opening list changes each member's card by its greetings, adds to none, and touches no other card", async () => {
    const w = world(() => ({
        alternatives: [greetingAlt('Hi', 'ann.png', 0), greetingAlt('Yo', 'bo.png', 0)],
        current: 0,
        cards: [cardOf('ann.png', ['Hi']), cardOf('bo.png', ['Yo'])],
        addsTo: null,
        openings: null,
    }));
    await w.act('alternatives.open', { target: { opening: true }, tokenizer });
    await w.list();
    await w.act('alternatives.greeting', { op: 'edit', avatar: 'bo.png', id: 0, hash: hash('Yo'), text: 'Yo2' });
    await w.act('alternatives.greeting', { op: 'default', avatar: 'ann.png', id: 0, hash: hash('Hi') });
    expect(await w.act('alternatives.greeting', { op: 'add', avatar: 'ann.png', text: 'x' })).toMatchObject({
        refused: expect.any(String),
    });
    expect(
        await w.act('alternatives.greeting', { op: 'delete', avatar: 'cara.png', id: 0, hash: hash('Hi') }),
    ).toMatchObject({ refused: expect.any(String) });
    expect(w.state.ops).toEqual([
        ['bo.png', { op: 'edit', id: 0, hash: hash('Yo'), text: 'Yo2' }],
        ['ann.png', { op: 'default', id: 0, hash: hash('Hi') }],
    ]);
});

test("a message's alternatives have no card: greeting operations are refused", async () => {
    const w = world(() => swipes(['a']));
    await w.act('alternatives.open', { target: { message: 'n0' }, tokenizer });
    await w.list();
    expect(await w.act('alternatives.greeting', { op: 'add', avatar: 'cara.png', text: 'x' })).toMatchObject({
        refused: expect.any(String),
    });
    expect(w.state.ops).toEqual([]);
});

test('a refused operation says why, and the views are read again', async () => {
    const w = greetingsWorld(['A']);
    await w.act('alternatives.open', { target: { greetings: 'cara.png' }, tokenizer });
    await w.list();
    w.state.refuse = 'expected_hash does not match';
    expect(await w.act('alternatives.greeting', { op: 'delete', avatar: 'cara.png', id: 0, hash: 1 })).toEqual({
        refused: 'expected_hash does not match',
        changed: ['alternatives.list', 'alternatives.counts', 'alternatives.matches'],
    });
});

test("a greeting change is one change to the card, answered with the character tree's openings", async () => {
    const w = greetingsWorld([]);
    await w.act('alternatives.open', { target: { greetings: 'cara.png' }, tokenizer });
    await w.list();
    expect(await w.act('alternatives.greeting', { op: 'add', avatar: 'cara.png', text: 'Hi' })).toEqual({
        changed: ['alternatives.list', 'alternatives.counts', 'alternatives.matches'],
        answer: { opening: null },
    });
    expect(w.state.ops).toEqual([['cara.png', { op: 'add', text: 'Hi' }]]);
});

test('a greeting is known by its id, wherever it moves and whatever its text; the same text twice is two', () => {
    const listed = (greetings: [number, string][]): Listed => ({
        alternatives: greetings.map(([id, text]) => greetingAlt(text, 'a', id)),
        current: 0,
        cards: [
            cardOf(
                'a',
                greetings.map(([, text]) => text),
                0,
                greetings.map(([id]) => id),
            ),
        ],
        addsTo: 'a',
        openings: null,
    });
    const ids = (greetings: [number, string][]) => itemsOf(listed(greetings), hash).map((i) => i.id);
    expect(
        ids([
            [0, 'Hello'],
            [1, 'Goodbye!'],
        ]),
    ).toEqual(['card:0:a', 'card:1:a']);
    expect(
        ids([
            [1, 'Goodbye!'],
            [0, 'Hello, edited'],
        ]),
    ).toEqual(['card:1:a', 'card:0:a']);
    expect(
        ids([
            [0, 'Hello'],
            [1, 'Hello'],
        ]),
    ).toEqual(['card:0:a', 'card:1:a']);
});

test('itemsOf: a stored opening is no card greeting unless the engine named it one, whatever its text', () => {
    const items = itemsOf(
        {
            alternatives: [said('Same', 'n0'), greetingAlt('Same', 'a', 2, 'n1')],
            current: 0,
            cards: [cardOf('a', ['Other', 'Same'], 0, [1, 2])],
            addsTo: 'a',
            openings: null,
        },
        hash,
    );
    expect(items.map((i) => i.card?.position ?? null)).toEqual([null, 1]);
});

test('itemsOf: a greeting gone from its card has no card place', () => {
    const items = itemsOf(
        {
            alternatives: [greetingAlt('Hi', 'a', 7)],
            current: 0,
            cards: [cardOf('a', ['Hi'], 0, [1])],
            addsTo: 'a',
            openings: null,
        },
        hash,
    );
    expect(items[0]!.card).toBeNull();
});

test("a message's alternative moves among them: before one is after the one above it, or first; the answer says where the current one is now", async () => {
    const w = world(() => swipes(['one', 'two', 'three', 'four'], 1));
    await w.act('alternatives.open', { target: { message: 'n1' }, tokenizer });
    await w.list();
    expect(await w.act('alternatives.move', { nodeId: 'n3', side: 'after', target: 'n0' })).toMatchObject({
        answer: { current: 2 },
    });
    expect(await w.act('alternatives.move', { nodeId: 'n2', side: 'before', target: 'n1' })).toMatchObject({
        answer: { current: 2 },
    });
    expect(await w.act('alternatives.move', { nodeId: 'n1', side: 'before', target: 'n0' })).toMatchObject({
        answer: { current: 0 },
    });
    expect(w.state.moves).toEqual([
        ['n3', { after: 'n0' }],
        ['n2', { after: 'n0' }],
        ['n1', { first: true }],
    ]);
    expect(await w.act('alternatives.move', { nodeId: 'n1', side: 'after', target: 'n9' })).toMatchObject({
        refused: expect.any(String),
    });
});

test("openings and greetings don't move this way: only a message's alternatives do", async () => {
    const w = world(() => swipes(['one', 'two']));
    await w.act('alternatives.open', { target: { opening: true }, tokenizer });
    expect(await w.act('alternatives.move', { nodeId: 'n1', side: 'before', target: 'n0' })).toMatchObject({
        refused: expect.any(String),
    });
    expect(w.state.moves).toEqual([]);
});
