import { createEffect, createRoot, createSignal, snapshot } from 'solid-js';
import type { Client } from '@st/page/client';
import { VIEW } from '../protocol.ts';
import type { Family, PresetsView } from '../protocol.ts';

export type OldPage = {
    sync(view: PresetsView, reload?: Family): Promise<void>;
    prepareImport(family: Family, data: Record<string, unknown>): Record<string, unknown>;
};

/** One explicit, plain-data boundary for the generation code which still uses mutable objects. */
export function presetsCompat(client: Client, old: OldPage) {
    const view = client.view<PresetsView>(VIEW);
    const [error, setError] = createSignal('');
    let syncing: Promise<void> = Promise.resolve();
    createRoot(() => {
        createEffect(
            () => client.version(VIEW),
            () => {
                const current = view();
                if (!current) return;
                const plain = structuredClone(snapshot(current));
                syncing = syncing
                    .then(() => old.sync(plain))
                    .then(() => {
                        setError('');
                    })
                    .catch((reason: unknown) => {
                        setError(reason instanceof Error ? reason.message : String(reason));
                    });
            },
        );
    });
    const settled = async () => {
        await syncing;
        if (error() !== '') throw new Error(error());
    };
    const send = async (type: string, payload: Record<string, unknown>) => {
        await settled();
        const result = await client.send(type, payload);
        if (!result.ok) throw new Error(result.error);
        await settled();
    };
    return {
        prepareImport: (family: Family, data: Record<string, unknown>) => old.prepareImport(family, data),
        error,
        async reload(family: Family) {
            await syncing;
            const current = view();
            if (current) await old.sync(structuredClone(snapshot(current)), family);
        },
        settled,
        select: (family: Family, name: string) => send('presets.select', { family, name }),
        save: (family: Family, name: string, data?: Record<string, unknown>, activate = true) =>
            send(
                data === undefined ? 'presets.save' : 'presets.import',
                data === undefined ? { family, name, activate } : { family, name, data, overwrite: true, activate },
            ),
        rename: (family: Family, name: string, to: string) => send('presets.rename', { family, name, to }),
        remove: (family: Family, name: string) => send('presets.delete', { family, name }),
    };
}

export type PresetsCompat = ReturnType<typeof presetsCompat>;
