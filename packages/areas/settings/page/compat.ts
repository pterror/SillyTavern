import { createEffect, createMemo, createRoot, on } from 'solid-js';
import { FIELDS, SERVER_FAMILIES, VIEW, samplerSelectOf } from '../protocol.ts';
import type { SamplerSelect, SettingsView } from '../protocol.ts';
import type { Client } from '@st/page/client';

// Upstream's settings objects (oai_settings and the rest) keep their names for old code and extensions: each field of
// them the server owns becomes an accessor over the settings view. Read, it's the view's value; written, it's sent as
// settings.set. While that's in flight a read gives what was written (old code writes, then reads at once); once the
// server answers, the view's value again, the written one or (refused) what it was.

/** The paths of the fields the server owns (the new page shows them; the old page doesn't write them). */
export const SERVER_OWNED = new Set(
    FIELDS.filter((field) => SERVER_FAMILIES.includes(field.family)).map((field) => field.path),
);

export function settingsCompat(client: Client) {
    const view = client.view<SettingsView>(VIEW);
    return {
        /**
         * Makes the server-owned fields of `object` (upstream's settings object at `prefix`, e.g. 'oai_settings')
         * accessors over the view. Until the view arrives they read what the object held.
         */
        bind(object: Record<string, unknown>, prefix: string) {
            for (const field of FIELDS) {
                if (!SERVER_OWNED.has(field.path) || !field.path.startsWith(`${prefix}.`)) continue;
                const key = field.path.slice(prefix.length + 1);
                const loaded = object[key];
                /** The last write, while its action is in flight. */
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
        /** A text generation backend's sampler select, the backend now's by default (none until the view arrives). */
        samplers: (backend?: string): SamplerSelect => {
            const current = view();
            return current ? samplerSelectOf(current, backend ?? current.api.textgen) : { manual: false, shown: [] };
        },
        /** Changes a backend's sampler select (the backend now's by default); resolves whether the server took it. */
        setSamplers: async (change: { backend?: string; manual?: boolean; shown?: string[] }) =>
            (await client.send('settings.samplers', change)).ok,
        /** A backend's sampler select (the backend now's by default) back to none. */
        resetSamplers: async (backend?: string) =>
            (await client.send('settings.samplers.reset', backend === undefined ? {} : { backend })).ok,
        /** The sampler selects the old page kept in the browser, by backend; resolves whether the server took them. */
        importSamplers: async (byBackend: Record<string, { manual: boolean; shown: string[] }>) =>
            (await client.send('settings.samplers.import', byBackend)).ok,
        /** Runs `run` whenever the sampler select or the backend changes in the view (not for the first view). */
        watchSamplers(run: () => void) {
            createRoot(() => {
                const key = createMemo(() => JSON.stringify([view()?.samplerSelects, view()?.api.textgen]));
                createEffect(on(key, () => run(), { defer: true }));
            });
        },
        /** Sets a field (as its control would); resolves whether the server took it. */
        setValue: async (path: string, value: unknown) => (await client.send('settings.set', { path, value })).ok,
        /** The context size to a model's, unlocking past the locked limit; resolves whether the server took it. */
        fitContext: async (size: number) => (await client.send('settings.fitContext', { size })).ok,
        /**
         * Keeps something of the old page (a module's variable, which can't be an accessor) at a path's value in the
         * view: now, and whenever it changes. One way: what it's set from is the view.
         */
        mirror(path: string, apply: (value: unknown) => void) {
            createRoot(() => {
                const value = createMemo(() => view()?.values[path]);
                createEffect(() => {
                    const current = value();
                    if (current !== undefined) apply(current);
                });
            });
        },
        /** Reads the view again (after an old route changed what it shows), and resolves once it's here. */
        reread: () => client.reread(VIEW),
        /** Runs `run` whenever one of these paths' values changes in the view (not for the first view). */
        watch(paths: string[], run: () => void) {
            createRoot(() => {
                // A memo per path: the effect hears a value that changed, not every new view.
                const values = paths.map((path) => createMemo(() => view()?.values[path]));
                createEffect(on(values, () => run(), { defer: true }));
            });
        },
    };
}
