import { expect, test } from 'vite-plus/test';
import type { ActionContext } from '@st/server-ui';
import { presetsArea } from './server.ts';
import type { Ports } from './server.ts';
import { FAMILIES } from './protocol.ts';
import type { Catalog, PresetsView } from './protocol.ts';

function world() {
    const catalogs = Object.fromEntries(
        FAMILIES.map((family) => [
            family,
            {
                selected: 'A',
                presets: [
                    { name: 'A', data: { temperature: 1 } },
                    { name: 'B', data: { temperature: 2 } },
                ],
            },
        ]),
    ) as unknown as PresetsView;
    let fail = false;
    let bound = false;
    const selections: string[] = [];
    const ports: Ports = {
        binding: async () => bound,
        bind: async (_user, enabled) => {
            bound = enabled;
        },
        settingsHashes: async () => ({}),
        list: async (_user, family) => structuredClone(catalogs[family]),
        select: async (_user, family, name) => {
            catalogs[family].selected = name;
            selections.push(name);
        },
        current: async () => ({ temperature: 0.4 }),
        save: async (_user, family, preset) => {
            if (fail) return null;
            catalogs[family].presets = [
                ...catalogs[family].presets.filter((item) => item.name !== preset.name),
                preset,
            ];
            return preset.name;
        },
        rename: async (_user, family, name, to) => {
            if (catalogs[family].presets.some((preset) => preset.name === to)) return null;
            catalogs[family].presets.find((preset) => preset.name === name)!.name = to;
            return to;
        },
        remove: async (_user, family, name) => {
            if (fail) return false;
            catalogs[family].presets = catalogs[family].presets.filter((preset) => preset.name !== name);
            return true;
        },
        defaults: async (_user, _family, name) => (name === 'A' ? { temperature: 1 } : null),
        order: async (_user, family, names) => {
            const catalog: Catalog = catalogs[family];
            catalog.presets = names.map((name) => catalog.presets.find((preset) => preset.name === name)!);
        },
    };
    const area = presetsArea(ports);
    const context: ActionContext = {
        user: { handle: 'u', directories: { root: '/u' } },
        session: 's',
        chat: null,
        upload: null,
    };
    const act = (type: string, payload: Record<string, unknown>) =>
        area.actions[type]!(context, { family: 'openai', ...payload });
    return {
        catalogs,
        selections,
        binding: () => bound,
        act,
        fail: () => {
            fail = true;
        },
    };
}

test('selecting an absent preset is refused without changing the current selection', async () => {
    const w = world();
    expect(await w.act('presets.select', { name: 'gone' })).toHaveProperty('refused');
    expect(w.selections).toEqual([]);
});

test('connection binding changes the user-wide preset option without selecting a preset', async () => {
    const w = world();
    await w.act('presets.bindConnection', { enabled: true });
    expect(w.binding()).toBe(true);
    expect(w.selections).toEqual([]);
    await w.act('presets.bindConnection', { enabled: false });
    expect(w.binding()).toBe(false);
});

test('save captures current server settings, and a failed write does not switch presets', async () => {
    const w = world();
    await w.act('presets.save', { name: 'Mine' });
    expect(w.catalogs.openai.presets.find((preset) => preset.name === 'Mine')?.data).toEqual({ temperature: 0.4 });
    w.fail();
    expect(await w.act('presets.save', { name: 'Lost' })).toHaveProperty('refused');
    expect(w.catalogs.openai.selected).toBe('Mine');
});

test('import refuses an unexpected collision rather than overwriting a preset from another tab', async () => {
    const w = world();
    expect(await w.act('presets.import', { name: 'A', data: { temperature: 5 }, overwrite: false })).toHaveProperty(
        'refused',
    );
    expect(w.catalogs.openai.presets[0]?.data).toEqual({ temperature: 1 });
});

test('failed deletion leaves the selection intact; deleting the last preset clears it', async () => {
    const w = world();
    w.fail();
    expect(await w.act('presets.delete', { name: 'A' })).toHaveProperty('refused');
    expect(w.catalogs.openai.selected).toBe('A');
    const next = world();
    await next.act('presets.delete', { name: 'B' });
    await next.act('presets.delete', { name: 'A' });
    expect(next.catalogs.openai.selected).toBe('');
});

test('rename keeps selection attached to the preset, and refuses a taken name', async () => {
    const w = world();
    expect(await w.act('presets.rename', { name: 'A', to: 'B' })).toHaveProperty('refused');
    await w.act('presets.rename', { name: 'A', to: 'Renamed' });
    expect(w.catalogs.openai.selected).toBe('Renamed');
});

test('restoring a custom preset reloads it; restoring a shipped preset writes its defaults', async () => {
    const w = world();
    await w.act('presets.restore', { name: 'B' });
    expect(w.selections).toEqual(['B']);
    await w.act('presets.restore', { name: 'A' });
    expect(w.catalogs.openai.presets.find((preset) => preset.name === 'A')?.data).toEqual({ temperature: 1 });
});

test('reordering requires exactly the current names and never silently drops a newly created preset', async () => {
    const w = world();
    for (const names of [['A'], ['A', 'A'], ['A', 'gone']])
        expect(await w.act('presets.order', { names })).toHaveProperty('refused');
    await w.act('presets.order', { names: ['B', 'A'] });
    expect(w.catalogs.openai.presets.map((preset) => preset.name)).toEqual(['B', 'A']);
});
