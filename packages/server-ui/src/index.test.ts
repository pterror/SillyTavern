import type { AddressInfo } from 'node:net';
import express from 'express';
import * as v from 'valibot';
import type { ActionAnswer, ViewPush } from '@st/protocol';
import { afterAll, expect, test } from 'vite-plus/test';
import { createUi, defineArea, patch } from './index.ts';
import type { User } from './index.ts';

const alice: User = { handle: 'alice', directories: { root: '/users/alice' } };
const bob: User = { handle: 'bob', directories: { root: '/users/bob' } };

const counts = new Map<string, number>();
let release = () => {};
let slowRelease = () => {};
let slowHeld = Promise.resolve();
let held = Promise.resolve();
let lateReads = 0;
let lateRelease = () => {};
let lateHeld = Promise.resolve();
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
function hold() {
    held = new Promise((resolve) => {
        release = () => resolve();
    });
}
const area = defineArea({
    schemas: {
        'count.add': v.object({ by: v.pipe(v.number(), v.minValue(1)) }),
        'count.refuse': v.object({}),
        'count.fail': v.object({}),
        'parts.touch': v.object({}),
        'both.touch': v.object({}),
        'count.show': v.object({}),
        'own.touch': v.object({}),
        'own.unchanged': v.object({}),
    },
    views: {
        count: async ({ user, chat }) => ({ count: counts.get(user.handle) ?? 0, chat: chat?.tree ?? null }),
        parts: async function* () {
            yield { part: 1 };
            await held;
            yield { part: 2 };
            yield patch({ more: 3 });
        },
        late: async () => {
            const read = ++lateReads;
            if (read === 1) await lateHeld;
            return { read };
        },
        patched: async function* () {
            yield patch({ kept: 1 });
            yield patch({ more: 2 });
        },
        slow: async function* () {
            yield { slow: 1 };
            await slowHeld;
            yield { slow: 2 };
        },
    },
    actions: {
        'count.add': async ({ user }, { by }) => {
            counts.set(user.handle, (counts.get(user.handle) ?? 0) + by);
            return { changed: ['count'] };
        },
        'count.refuse': async () => ({ refused: 'not now' }),
        'parts.touch': async () => ({ changed: ['parts'] }),
        'both.touch': async () => ({ changed: ['slow', 'parts'] }),
        'count.show': async () => ({ changed: [], opensViews: ['count'] }),
        'own.touch': async () => ({ changed: ['late', 'count'], own: ['count'] }),
        'own.unchanged': async () => ({ changed: ['count'], own: ['late'] }),
        'count.fail': async ({ user }) => {
            counts.set(user.handle, (counts.get(user.handle) ?? 0) + 100);
            throw new Error('failed after writing');
        },
    },
    readSchemas: { 'count.read': v.object({ plus: v.number() }) },
    reads: {
        'count.read': async ({ user }, { plus }) => {
            if (plus < 0) throw new Error('no');
            return { count: (counts.get(user.handle) ?? 0) + plus };
        },
    },
    followChat: ['count'],
});
const ui = createUi([area], {
    userOf: (request) => (request.get('X-User') === 'bob' ? bob : alice),
    chatOf: async (_user, owner) => ('avatar' in owner ? { tree: `c:${owner.avatar}` } : { tree: `g:${owner.group}` }),
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/api/ui/action', ui.router);
app.use('/api/ui/read', ui.readRouter);
const server = app.listen(0);
afterAll(() => void server.close());
const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const sessions = {
    a1: '00000000-0000-4000-8000-000000000001',
    a2: '00000000-0000-4000-8000-000000000002',
    b1: '00000000-0000-4000-8000-000000000003',
};

async function send(session: string, type: string, payload: unknown, user = 'alice') {
    const response = await fetch(`${origin()}/api/ui/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ST-Session': session, 'X-User': user },
        body: JSON.stringify({ type, payload }),
    });
    const [first = ''] = (await response.text()).split('\n');
    return { status: response.status, answer: JSON.parse(first) as ActionAnswer };
}

const pushes = { a1: [] as ViewPush[], a2: [] as ViewPush[], b1: [] as ViewPush[] };
ui.attach(alice, sessions.a1, (push) => pushes.a1.push(push));
ui.attach(alice, sessions.a2, (push) => pushes.a2.push(push));
ui.attach(bob, sessions.b1, (push) => pushes.b1.push(push));

test("opening a view answers it; an action answers the views it changed to its own tab and pushes them to the user's other tabs showing them", async () => {
    const opened = await send(sessions.a1, 'view.open', { key: 'count' });
    expect(opened.answer).toMatchObject({ ok: true, views: [{ key: 'count', value: { count: 0 } }] });
    await send(sessions.a2, 'view.open', { key: 'count' });
    await send(sessions.b1, 'view.open', { key: 'count' }, 'bob');

    const added = await send(sessions.a1, 'count.add', { by: 2 });
    expect(added.answer).toMatchObject({ ok: true, views: [{ key: 'count', value: { count: 2 } }] });
    await settled();
    expect(pushes.a1).toEqual([]);
    expect(pushes.a2).toMatchObject([{ type: 'views', views: [{ key: 'count', value: { count: 2 } }] }]);
    expect(pushes.b1).toEqual([]);
});

test('an action that opens a view answers it in the same request, and the view is then pushed like any other', async () => {
    const fresh = '00000000-0000-4000-8000-000000000009';
    const heard: ViewPush[] = [];
    const stop = ui.attach(bob, fresh, (push) => heard.push(push));
    expect((await send(fresh, 'count.add', { by: 1 }, 'bob')).answer).toEqual({ ok: true, views: [] });
    const shown = await send(fresh, 'count.show', {}, 'bob');
    expect(shown.answer).toMatchObject({ ok: true, views: [{ key: 'count', value: { count: 1 } }] });
    await send(sessions.b1, 'count.add', { by: 1 }, 'bob');
    await settled();
    expect(heard).toMatchObject([{ type: 'views', views: [{ key: 'count', value: { count: 2 } }] }]);
    stop();
    pushes.b1.length = 0;
});

test('a later view always has a higher version', async () => {
    const first = await send(sessions.a1, 'count.add', { by: 1 });
    const second = await send(sessions.a1, 'count.add', { by: 1 });
    const version = (r: typeof first) => r.answer.views[0]?.version ?? 0;
    expect(version(second)).toBeGreaterThan(version(first));
});

test('a payload its schema refuses is not run', async () => {
    const before = counts.get('alice');
    const bad = await send(sessions.a1, 'count.add', { by: 0 });
    expect(bad.status).toBe(400);
    expect(bad.answer.ok).toBe(false);
    expect(counts.get('alice')).toBe(before);
    expect((await send(sessions.a1, 'no.such', {})).status).toBe(400);
});

test('a refusal is answered with its reason', async () => {
    expect((await send(sessions.a1, 'count.refuse', {})).answer).toEqual({ ok: false, error: 'not now', views: [] });
});

test('a tab switching chats is answered the views that follow the chat, and nothing is pushed', async () => {
    pushes.a1.length = 0;
    pushes.a2.length = 0;
    expect(await ui.showChat(alice, sessions.a1, { tree: '7' })).toMatchObject([
        { key: 'count', value: { chat: '7' } },
    ]);
    expect(await ui.showChat(alice, sessions.a1, { tree: '7' })).toEqual([]);
    expect(pushes.a1).toEqual([]);
    expect(pushes.a2).toEqual([]);
});

test('a closed view is no longer answered or pushed', async () => {
    await send(sessions.a2, 'view.close', { key: 'count' });
    pushes.a2.length = 0;
    await send(sessions.a1, 'count.add', { by: 1 });
    expect(pushes.a2).toEqual([]);
});

test('no session, no action', async () => {
    const response = await fetch(`${origin()}/api/ui/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'count.add', payload: { by: 1 } }),
    });
    expect(response.status).toBe(400);
});

test('closing the chat answers the views that follow it, read with no chat', async () => {
    await send(sessions.a1, 'view.open', { key: 'count' });
    const closed = await send(sessions.a1, 'chat.close', {});
    expect(closed.answer).toMatchObject({ ok: true, views: [{ key: 'count', value: { chat: null } }] });
});

test('a chat moved under a tab is pushed to that tab only', async () => {
    await ui.showChat(alice, sessions.a1, { tree: '8' });
    await send(sessions.a2, 'view.open', { key: 'count' });
    await ui.showChat(alice, sessions.a2, { tree: '9' });
    pushes.a1.length = 0;
    pushes.a2.length = 0;
    await ui.chatMoved(alice, sessions.a1);
    expect(pushes.a1).toMatchObject([{ views: [{ key: 'count', value: { chat: '8' } }] }]);
    expect(pushes.a2).toEqual([]);
});

test('views changed for one tab are pushed to that tab only, if it shows them', async () => {
    await send(sessions.a1, 'view.open', { key: 'count' });
    await send(sessions.a2, 'view.open', { key: 'count' });
    pushes.a1.length = 0;
    pushes.a2.length = 0;
    await ui.changedFor(alice, sessions.a2, ['count']);
    expect(pushes.a1).toEqual([]);
    expect(pushes.a2).toMatchObject([{ views: [{ key: 'count' }] }]);
    await send(sessions.a2, 'view.close', { key: 'count' });
    pushes.a2.length = 0;
    await ui.changedFor(alice, sessions.a2, ['count']);
    expect(pushes.a2).toEqual([]);
});

test('a tab says which chat it shows (after its stream reconnects), and is answered its views for it', async () => {
    await send(sessions.a1, 'view.open', { key: 'count' });
    const shown = await send(sessions.a1, 'chat.show', { avatar: 'cara.png' });
    expect(shown.answer).toMatchObject({ ok: true, views: [{ key: 'count', value: { chat: 'c:cara.png' } }] });
    expect((await send(sessions.a1, 'chat.show', { nobody: 1 })).status).toBe(400);
});

test('a malformed payload is refused, not a crash', async () => {
    const response = await fetch(`${origin()}/api/ui/action`, {
        method: 'POST',
        headers: { 'X-ST-Session': sessions.a1 },
        body: new URLSearchParams({ type: 'count.add', payload: 'not json' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, views: [] });
});

test("an action that fails partway answers its failure, then its area's views as they are now, each a part of its own", async () => {
    await send(sessions.a1, 'view.open', { key: 'count' });
    const response = await fetch(`${origin()}/api/ui/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ST-Session': sessions.a1, 'X-User': 'alice' },
        body: JSON.stringify({ type: 'count.fail', payload: {} }),
    });
    expect(response.status).toBe(500);
    const [first, ...later] = (await response.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { views: { key: string; value: unknown }[] });
    expect(first).toEqual({ ok: false, error: 'internal', views: [] });
    expect(later.flatMap((line) => line.views)).toContainEqual(
        expect.objectContaining({ key: 'count', value: expect.objectContaining({ count: counts.get('alice') }) }),
    );
});

test("an action's own views are its answer; the rest follow on the same answer, each a later part, and only then are the user's other tabs pushed", async () => {
    for (const session of [sessions.a1, sessions.a2]) {
        await send(session, 'view.open', { key: 'count' });
        await send(session, 'view.open', { key: 'late' });
    }
    lateReads = 0;
    lateHeld = new Promise<void>((resolve) => {
        lateRelease = resolve;
    });
    pushes.a2.length = 0;
    const response = await fetch(`${origin()}/api/ui/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ST-Session': sessions.a1, 'X-User': 'alice' },
        body: JSON.stringify({ type: 'own.touch', payload: {} }),
    });
    expect(response.headers.get('Content-Type')).toContain('application/x-ndjson');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('\n')) text += decoder.decode((await reader.read()).value, { stream: true });
    const first = JSON.parse(text.slice(0, text.indexOf('\n'))) as ActionAnswer;
    expect(first.views.map((view) => view.key)).toEqual(['count']);
    await settled();
    expect(pushes.a2).toEqual([]);

    const newer = await send(sessions.a1, 'view.open', { key: 'late' });
    expect(newer.answer.views[0]).toMatchObject({ key: 'late', value: { read: 2 } });
    lateRelease();
    for (let next = await reader.read(); !next.done; next = await reader.read())
        text += decoder.decode(next.value, { stream: true });
    const lines = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { views: { key: string; version: number; value: unknown }[] });
    expect(lines).toHaveLength(2);
    const late = lines[1]!.views[0]!;
    expect(late).toMatchObject({ key: 'late', value: { read: 1 } });
    expect(late.version).toBeGreaterThan(first.views[0]!.version);
    expect(late.version).toBeLessThan(newer.answer.views[0]!.version);

    await settled();
    expect(pushes.a2.map((push) => push.views.map((view) => view.key))).toEqual([['count'], ['late']]);
});

test('an action calling its own a view it did not change fails', async () => {
    expect((await send(sessions.a1, 'own.unchanged', {})).status).toBe(500);
});

test('a view read in parts: its first part is answered at once, the rest follow on the same answer (NDJSON), each newer; other tabs get each by push', async () => {
    await send(sessions.a2, 'view.open', { key: 'parts' });
    hold();
    const response = await fetch(`${origin()}/api/ui/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ST-Session': sessions.a1, 'X-User': 'alice' },
        body: JSON.stringify({ type: 'view.open', payload: { key: 'parts' } }),
    });
    expect(response.headers.get('Content-Type')).toContain('application/x-ndjson');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('\n')) text += decoder.decode((await reader.read()).value, { stream: true });
    const first = JSON.parse(text.slice(0, text.indexOf('\n'))) as ActionAnswer;
    expect(first).toMatchObject({ ok: true, views: [{ key: 'parts', value: { part: 1 } }] });
    pushes.a2.length = 0;
    release();
    for (let next = await reader.read(); !next.done; next = await reader.read())
        text += decoder.decode(next.value, { stream: true });
    const lines = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { views: { version: number; value: unknown }[] });
    expect(lines).toHaveLength(3);
    expect(lines[1]!.views[0]!.value).toEqual({ part: 2 });
    expect(lines[2]!.views[0]).toMatchObject({ patch: { more: 3 } });
    expect(lines[2]!.views[0]!.version).toBeGreaterThan(lines[1]!.views[0]!.version);
    expect(lines[1]!.views[0]!.version).toBeGreaterThan(first.views[0]!.version);

    hold();
    pushes.a2.length = 0;
    const touched = send(sessions.a1, 'parts.touch', {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await touched;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pushes.a2.map((p) => p.views[0])).toMatchObject([
        { value: { part: 1 } },
        { value: { part: 2 } },
        { patch: { more: 3 } },
    ]);
});

test('a read whose first part is a patch answers a patch, so the page keeps what it holds', async () => {
    const { answer } = await send(sessions.a1, 'view.open', { key: 'patched' });
    expect(answer.views[0]).toMatchObject({ key: 'patched', patch: { kept: 1 } });
    expect(answer.views[0]).not.toHaveProperty('value');
});

test("one view's later parts don't wait for another's", async () => {
    await send(sessions.a1, 'view.open', { key: 'slow' });
    slowHeld = new Promise<void>((resolve) => {
        slowRelease = resolve;
    });
    const response = await fetch(`${origin()}/api/ui/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ST-Session': sessions.a1, 'X-User': 'alice' },
        body: JSON.stringify({ type: 'both.touch', payload: {} }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"more":3')) {
        text += decoder.decode((await reader.read()).value, { stream: true });
    }
    expect(text).not.toContain('"slow":2');
    slowRelease();
    for (let next = await reader.read(); !next.done; next = await reader.read())
        text += decoder.decode(next.value, { stream: true });
    expect(text).toContain('"slow":2');
});

test('a tab whose last stream closed is gone: its areas are told', async () => {
    const gone: string[] = [];
    const told = createUi(
        [defineArea({ schemas: {}, views: {}, actions: {}, gone: (session) => void gone.push(session) })],
        {
            userOf: () => alice,
            chatOf: async () => null,
        },
    );
    const first = told.attach(alice, sessions.a1, () => {});
    const second = told.attach(alice, sessions.a1, () => {});
    first();
    expect(gone).toEqual([]);
    second();
    expect(gone).toEqual([sessions.a1]);
});

test("a session taken over by another user is a new tab: the old one's areas are told it's gone", () => {
    const gone: string[] = [];
    const told = createUi(
        [defineArea({ schemas: {}, views: {}, actions: {}, gone: (session) => void gone.push(session) })],
        { userOf: () => alice, chatOf: async () => null },
    );
    told.attach(alice, sessions.a1, () => {});
    told.attach(alice, sessions.a1, () => {});
    expect(gone).toEqual([]);
    const stop = told.attach(bob, sessions.a1, () => {});
    expect(gone).toEqual([sessions.a1]);
    stop();
    expect(gone).toEqual([sessions.a1, sessions.a1]);
});

test("a read answers from the user's data alone, with no tab: it opens no view and pushes nothing", async () => {
    const read = async (body: unknown, user = 'alice') => {
        const response = await fetch(`${origin()}/api/ui/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-User': user },
            body: JSON.stringify(body),
        });
        return { status: response.status, answer: (await response.json()) as unknown };
    };
    const before = { a1: pushes.a1.length, a2: pushes.a2.length, b1: pushes.b1.length };
    counts.set('bob', 5);
    expect(await read({ type: 'count.read', payload: { plus: 1 } }, 'bob')).toEqual({
        status: 200,
        answer: { ok: true, value: { count: 6 } },
    });
    expect(await read({ type: 'count.read', payload: { plus: 'x' } })).toMatchObject({
        status: 400,
        answer: { ok: false },
    });
    expect(await read({ type: 'count.add', payload: { by: 1 } })).toEqual({
        status: 400,
        answer: { ok: false, error: 'no read count.add' },
    });
    expect(await read({ type: 'count.read', payload: { plus: -1 } })).toEqual({
        status: 500,
        answer: { ok: false, error: 'internal' },
    });
    await settled();
    expect({ a1: pushes.a1.length, a2: pushes.a2.length, b1: pushes.b1.length }).toEqual(before);
});
