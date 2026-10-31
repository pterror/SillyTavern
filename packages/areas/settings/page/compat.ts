import { createEffect, createMemo, createRoot, on } from 'solid-js';
import { FIELDS, SERVER_FAMILIES, VIEW, samplerSelectOf } from '../protocol.ts';
import type { SamplerSelect, SettingsView } from '../protocol.ts';
import type { Client } from '@st/page/client';

export const SERVER_OWNED = new Set(
    FIELDS.filter((field) => SERVER_FAMILIES.includes(field.family)).map((field) => field.path),
);

export function settingsCompat(client: Client) {
    const view = client.view<SettingsView>(VIEW);
    return {
        bind(object: Record<string, unknown>, prefix: string) {
            for (const field of FIELDS) {
                if (!SERVER_OWNED.has(field.path) || !field.path.startsWith(`${prefix}.`)) continue;
                const key = field.path.slice(prefix.length + 1);
                const loaded = object[key];
                let pending: { value: unknown } | null = null;
                const read = () => {
                    if (pending) return pending.value;
                    const shown = view();
                    return shown ? shown.values[field.path] : loaded;
                };
                Object.defineProperty(object, key, {
                    enumerable: true,
                    configurable: true,
                    get: read,
                    set: (value: unknown) => {
                        if (Object.is(value, read())) return;
                        const write = { value };
                        pending = write;
                        void client.send('settings.set', { path: field.path, value }).then((result) => {
                            if (pending === write) pending = null;
                            if (!result.ok) console.warn(`[settings] ${field.path} not set: ${result.error}`);
                        });
                    },
                });
            }
        },
        samplers: (backend?: string): SamplerSelect => {
            const current = view();
            return current ? samplerSelectOf(current, backend ?? current.api.textgen) : { manual: false, shown: [] };
        },
        setSamplers: async (change: { backend?: string; manual?: boolean; shown?: string[] }) =>
            (await client.send('settings.samplers', change)).ok,
        resetSamplers: async (backend?: string) =>
            (await client.send('settings.samplers.reset', backend === undefined ? {} : { backend })).ok,
        importSamplers: async (byBackend: Record<string, { manual: boolean; shown: string[] }>) =>
            (await client.send('settings.samplers.import', byBackend)).ok,
        watchSamplers(run: () => void) {
            createRoot(() => {
                const key = createMemo(() => JSON.stringify([view()?.samplerSelects, view()?.api.textgen]));
                createEffect(on(key, () => run(), { defer: true }));
            });
        },
        setValue: async (path: string, value: unknown) => (await client.send('settings.set', { path, value })).ok,
        fitContext: async (size: number) => (await client.send('settings.fitContext', { size })).ok,
        mirror(path: string, apply: (value: unknown) => void) {
            createRoot(() => {
                const value = createMemo(() => view()?.values[path]);
                createEffect(() => {
                    const current = value();
                    if (current !== undefined) apply(current);
                });
            });
        },
        reread: () => client.reread(VIEW),
        watch(paths: string[], run: () => void) {
            createRoot(() => {
                const values = paths.map((path) => createMemo(() => view()?.values[path]));
                createEffect(on(values, () => run(), { defer: true }));
            });
        },
    };
}
