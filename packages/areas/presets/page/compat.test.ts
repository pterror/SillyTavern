import { createClient } from '@st/page/client';
import { afterEach, expect, test } from 'vite-plus/test';
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
