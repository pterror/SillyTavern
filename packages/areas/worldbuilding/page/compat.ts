import { createEffect, createMemo, createRoot, createSignal, on } from 'solid-js';
import type { ActionResult, Client } from '@st/page/client';
import { WORLDS_VIEW } from '../protocol.ts';
import type { NavigationTarget, World, WorldsView } from '../protocol.ts';
import { chatCards } from './ChatCard.tsx';

// What the old page asks the worldbuilding page to show. `character` is the character's entity id.
export type Target = NavigationTarget | { import: File };

// `notify`: the app's toast; with `action`, a button on it that runs `run`.
export type OldPage = {
    showPane(): void;
    notify(words: string, action?: { label: string; run: () => void }): void;
};

export function worldbuildingCompat(client: Client, old: OldPage) {
    const [shown, setShown] = createSignal(false);
    const [started, setStarted] = createSignal(false);
    const [target, setTarget] = createSignal<Target | null>(null);
    const worldsView = client.view<WorldsView>(WORLDS_VIEW);
    const worlds = (): World[] | null => worldsView()?.worlds ?? null;
    const go = (next: Target) => {
        setTarget(next);
        setStarted(true);
    };
    const cards = chatCards(client, (at) => go({ kind: 'at', ...at }));
    return {
        shown,
        started,
        target,
        targetOpened: (next: Target, result: ActionResult) => {
            if (target() !== next) return;
            setTarget(null);
            if (result.ok) old.showPane();
        },
        paneShown(open: boolean) {
            setShown(open);
            if (open) setStarted(true);
        },
        openWorld: (world: string) => {
            go({ kind: 'named', world, uid: null });
        },
        openEntry: (world: string, uid: number) => {
            go({ kind: 'named', world, uid });
        },
        // An entry by its world's and its own ids.
        openEntryAt: (book: string, entry: string) => {
            go({ kind: 'at', book, entry });
        },
        peek: cards.peek,
        // On a phone: the card comes up from the bottom, with Open.
        tap: cards.tap,
        unpeek: cards.unpeek,
        ChatCard: cards.Drawn,
        openCharacterBook: (character: string) => {
            go({ kind: 'character', character });
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
