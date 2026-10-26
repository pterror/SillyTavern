import { createEffect, createMemo, createRoot, on } from 'solid-js';
import { FIELDS, SERVER_FAMILIES, VIEW } from '@st/protocol/settings';
import type { SettingsView } from '@st/protocol/settings';
import type { Client } from '../../client.ts';

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
