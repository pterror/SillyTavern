import { createRoot } from 'solid-js';
import { afterEach, expect, test } from 'vite-plus/test';
import { createClient } from '../src/client.ts';

type Sent = { type: string; payload: unknown };
const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

function server(answer: (sent: Sent) => unknown) {
    const sent: Sent[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Sent;
        sent.push(body);
        return new Response(JSON.stringify(answer(body)));
    }) as typeof fetch;
    return sent;
}

const frame = (version: number, value: unknown) => ({ key: 'k', version, value });

test('a view keeps the newest version, whichever arrives last', async () => {
    server(() => ({ ok: true, views: [frame(5, 'five')] }));
    const client = createClient({ headers: () => ({}) });
    const view = createRoot(() => client.view<string>('k'));
    await client.send('x', {});
    expect(view()).toBe('five');
    client.receive({ type: 'views', views: [frame(3, 'three')] });
    expect(view()).toBe('five');
    client.receive({ type: 'views', views: [frame(7, 'seven')] });
    expect(view()).toBe('seven');
});

test('after a reconnect it says its chat first, then opens its views, and takes whatever version comes', async () => {
    const sent = server((body) =>
        body.type === 'view.open' ? { ok: true, views: [frame(1, 'fresh')] } : { ok: true, views: [] },
    );
    const client = createClient({ headers: () => ({}) });
    const view = createRoot(() => client.view<string>('k'));
    client.receive({ type: 'views', views: [frame(1_000_000, 'before the restart')] });
    sent.length = 0;
    await client.reconnected({ avatar: 'cara.png' });
    expect(sent.map((s) => s.type)).toEqual(['chat.show', 'view.open']);
    expect(sent[0]?.payload).toEqual({ avatar: 'cara.png' });
    expect(view()).toBe('fresh');
});

test("a server that can't be reached, or answers no answer, is a refusal, not an exception", async () => {
    globalThis.fetch = (async () => {
        throw new TypeError('network');
    }) as typeof fetch;
    const client = createClient({ headers: () => ({}) });
    expect(await client.send('x', {})).toEqual({ ok: false, error: "The server can't be reached." });
    server(() => ({ nonsense: true }));
    expect(await client.send('x', {})).toMatchObject({ ok: false });
});

test("a refusal's views are still taken", async () => {
    server(() => ({ ok: false, error: 'no', views: [frame(9, 'as it is')] }));
    const client = createClient({ headers: () => ({}) });
    const view = createRoot(() => client.view<string>('k'));
    expect(await client.send('x', {})).toEqual({ ok: false, error: 'no' });
    expect(view()).toBe('as it is');
});

test('an answer in parts (NDJSON): the first part is the answer, each later one is applied as it comes; a patch merges into what is held', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    globalThis.fetch = (async () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            async start(controller) {
                const line = (value: unknown) => {
                    controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
                };
                line({ ok: true, views: [frame(10, { counts: { a: 1 }, done: false })] });
                await held;
                line({ views: [{ key: 'k', version: 11, patch: { counts: { b: 2 } } }] });
                line({ views: [{ key: 'k', version: 9, patch: { counts: { c: 3 } } }] });
                line({ views: [{ key: 'k', version: 12, patch: { done: true } }] });
                controller.close();
            },
        });
        return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
    }) as typeof fetch;
    const client = createClient({ headers: () => ({}) });
    const view = createRoot(() => client.view<{ counts: Record<string, number>; done: boolean }>('k'));
    expect(await client.send('x', {})).toEqual({ ok: true });
    expect(view()).toEqual({ counts: { a: 1 }, done: false });
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view()).toEqual({ counts: { a: 1, b: 2 }, done: true });
    expect(client.version('k')).toBe(12);
});
