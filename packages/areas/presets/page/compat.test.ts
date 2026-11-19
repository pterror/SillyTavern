import { createClient } from '@st/page/client';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { FAMILIES, VIEW } from '../protocol.ts';
import type { PresetsView } from '../protocol.ts';
import { presetsCompat } from './compat.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

test('the legacy boundary receives independent plain snapshots, once per server version and in order', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, views: [] }))) as typeof fetch;
    const client = createClient({ headers: () => ({}) });
    const seen: PresetsView[] = [];
    const compat = presetsCompat(client, {
        sync: async (view) => {
            // This throws on a proxy and demonstrates that legacy mutation cannot write into the server view.
            seen.push(structuredClone(view));
            view.openai.presets[0]!.data['temperature'] = 99;
        },
        prepareImport: (_family, data) => data,
    });
    const value = Object.fromEntries(
        FAMILIES.map((family) => [
            family,
            {
                selected: 'A',
                presets: [{ name: 'A', data: { temperature: 1 } }],
            },
        ]),
    ) as unknown as PresetsView;
    value.settingsHashes = {};
    client.receive({ type: 'views', views: [{ key: VIEW, version: 1, value }] });
    await compat.settled();
    expect(seen).toHaveLength(1);
    expect(client.view<PresetsView>(VIEW)()?.openai.presets[0]?.data['temperature']).toBe(1);
    const next = structuredClone(value);
    next.openai.selected = 'B';
    client.receive({ type: 'views', views: [{ key: VIEW, version: 2, value: next }] });
    client.receive({ type: 'views', views: [{ key: VIEW, version: 1, value }] });
    await compat.settled();
    expect(seen.map((view) => view.openai.selected)).toEqual(['A', 'B']);
});

test('settled waits for views queued while an asynchronous backend application is running', async () => {
    const client = createClient({ headers: () => ({}) });
    let first!: () => void;
    let second!: () => void;
    const applied: string[] = [];
    const compat = presetsCompat(client, {
        sync: async (view) => {
            applied.push(view.openai.selected);
            await new Promise<void>((resolve) => {
                if (view.openai.selected === 'A') first = resolve;
                else second = resolve;
            });
        },
        prepareImport: (_family, data) => data,
    });
    const value = Object.fromEntries(
        FAMILIES.map((family) => [family, { selected: 'A', presets: [] }]),
    ) as unknown as PresetsView;
    value.settingsHashes = {};
    client.receive({ type: 'views', views: [{ key: VIEW, version: 1, value }] });
    await vi.waitFor(() => expect(applied).toEqual(['A']));
    let done = false;
    const waiting = compat.settled().then(() => {
        done = true;
    });
    const next = structuredClone(value);
    next.openai.selected = 'B';
    client.receive({ type: 'views', views: [{ key: VIEW, version: 2, value: next }] });
    first();
    await vi.waitFor(() => expect(applied).toEqual(['A', 'B']));
    expect(done).toBe(false);
    second();
    await waiting;
    expect(done).toBe(true);
});
