import { createEffect, createMemo, createRoot, createSignal, on } from 'solid-js';
import type { Client } from '@st/page/client';
import { WORLDS_VIEW } from '../protocol.ts';
import type { World, WorldsView } from '../protocol.ts';

// What the old page asks the worldbuilding page to show. `character` is the character's entity id.
export type Target = { world: string; uid: number | null } | { character: string } | { import: File };

export type OldPage = { showPane(): void };

export function worldbuildingCompat(client: Client, old: OldPage) {
    const [shown, setShown] = createSignal(false);
    const [everShown, setEverShown] = createSignal(false);
    const [target, setTarget] = createSignal<Target | null>(null);
    const worldsView = client.view<WorldsView>(WORLDS_VIEW);
    const worlds = (): World[] | null => worldsView()?.worlds ?? null;
    const go = (next: Target) => {
        setTarget(next);
        old.showPane();
    };
    return {
        shown,
        everShown,
        target,
        targetTaken: () => setTarget(null),
        paneShown(open: boolean) {
            setShown(open);
            if (open) setEverShown(true);
        },
        openWorld: (world: string) => {
            go({ world, uid: null });
        },
        openEntry: (world: string, uid: number) => {
            go({ world, uid });
        },
        openCharacterBook: (character: string) => {
            go({ character });
        },
        importWorld: (file: File) => {
            go({ import: file });
        },
        // Null until the server's first answer is here.
        worlds,
        // Runs `run` whenever a world is made, renamed, deleted or its use in every chat changes.
        watchWorlds(run: () => void) {
            createRoot(() => {
                const key = createMemo(() =>
                    JSON.stringify(worlds()?.map(({ id, name, usedInEveryChat }) => [id, name, usedInEveryChat])),
                );
                createEffect(on(key, () => run(), { defer: true }));
            });
        },
        // `changes` are written together; null when they were, else why not.
        async setUsedInEveryChat(changes: { book: string; used: boolean }[]): Promise<string | null> {
            const answered = await client.send('worldbuilding.setUsedInEveryChat', { changes });
            return answered.ok ? null : answered.error;
        },
    };
}

export type WorldbuildingCompat = ReturnType<typeof worldbuildingCompat>;
