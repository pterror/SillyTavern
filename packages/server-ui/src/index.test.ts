import type { AddressInfo } from 'node:net';
import express from 'express';
import * as v from 'valibot';
import type { ActionAnswer, ViewPush } from '@st/protocol';
import { afterAll, expect, test } from 'vite-plus/test';
import { createUi, defineArea } from './index.ts';
import type { User } from './index.ts';

const alice: User = { handle: 'alice', directories: { root: '/users/alice' } };
const bob: User = { handle: 'bob', directories: { root: '/users/bob' } };

// A counter per user, and a view of it that also says which chat the tab shows.
const counts = new Map<string, number>();
const area = defineArea({
    schemas: {
        'count.add': v.object({ by: v.pipe(v.number(), v.minValue(1)) }),
        'count.refuse': v.object({}),
        'count.fail': v.object({}),
    },
    views: {
        count: async ({ user, chat }) => ({ count: counts.get(user.handle) ?? 0, chat: chat?.tree ?? null }),
    },
    actions: {
        'count.add': async ({ user }, { by }) => {
            counts.set(user.handle, (counts.get(user.handle) ?? 0) + by);
            return { changed: ['count'] };
        },
        'count.refuse': async () => ({ refused: 'not now' }),
        'count.fail': async ({ user }) => {
            counts.set(user.handle, (counts.get(user.handle) ?? 0) + 100);
            throw new Error('failed after writing');
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
    return { status: response.status, answer: (await response.json()) as ActionAnswer };
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
    expect(pushes.a1).toEqual([]);
    expect(pushes.a2).toMatchObject([{ type: 'views', views: [{ key: 'count', value: { count: 2 } }] }]);
    expect(pushes.b1).toEqual([]);
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

test("an action that fails partway answers its area's views as they are now", async () => {
    await send(sessions.a1, 'view.open', { key: 'count' });
    const failed = await send(sessions.a1, 'count.fail', {});
    expect(failed.status).toBe(500);
    expect(failed.answer).toMatchObject({
        ok: false,
        views: [{ key: 'count', value: { count: counts.get('alice') } }],
    });
});
