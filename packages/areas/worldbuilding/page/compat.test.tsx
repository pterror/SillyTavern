import { createRoot } from 'solid-js';
import { render } from 'solid-js/web';
import { expect, test, vi } from 'vite-plus/test';
import { UiProvider } from '@st/page/context';
import type { ActionResult, Client } from '@st/page/client';
import { testCommands } from '@st/page/focus-actions';
import { WORLD_VIEW, OVERVIEW_VIEW } from '../protocol.ts';
import { Worldbuilding } from './Worldbuilding.tsx';
import { worldbuildingCompat } from './compat.ts';

test.each([true, false])('embedded lore loads before the drawer is revealed (success: %s)', async (ok) => {
    const sent: string[] = [];
    let request: unknown;
    const client: Client = {
        send: async (type, payload) => {
            request = payload;
            sent.push(type);
            return ok ? { ok: true } : { ok: false, error: 'Character book not found.' };
        },
        view: () => () => undefined,
        receive: () => {},
        reconnected: async () => {},
        reread: async () => {},
        version: () => 0,
    };
    const host = document.createElement('div');
    document.body.append(host);
    let dispose = () => {};
    let compat!: ReturnType<typeof worldbuildingCompat>;
    const stop = createRoot((cleanup) => {
        compat = worldbuildingCompat(client, { showPane: () => compat.paneShown(true), notify: () => {} });
        dispose = render(
            () => (
                <UiProvider value={{ client, ...testCommands(), t: (text) => text }}>
                    <Worldbuilding
                        shown={compat.shown()}
                        started={compat.started()}
                        target={compat.target()}
                        onTargetOpened={compat.targetOpened}
                        notify={() => {}}
                        activationSettings={() => null}
                    />
                </UiProvider>
            ),
            host,
        );
        return cleanup;
    });
    compat.openCharacterBook('42');
    try {
        expect(sent).toEqual(['worldbuilding.navigate']);
        expect(request).toMatchObject({ to: { kind: 'character', character: '42' } });
        expect(compat.shown()).toBe(false);
        await vi.waitFor(() => expect(compat.target()).toBeNull());
        expect(compat.shown()).toBe(ok);
    } finally {
        dispose();
        stop();
        host.remove();
    }
});

test('resizing a reopened drawer cannot reopen the old world over an embedded lore request', async () => {
    const sent: string[] = [];
    const resizes: (() => void)[] = [];
    let finishOpening = () => {};
    const opened = new Promise<ActionResult>((resolve) => {
        finishOpening = () => resolve({ ok: true });
    });
    vi.stubGlobal(
        'ResizeObserver',
        class {
            constructor(callback: () => void) {
                resizes.push(callback);
            }
            observe() {}
            disconnect() {}
            unobserve() {}
        },
    );
    const held: Record<string, unknown> = {
        [WORLD_VIEW]: {
            id: '1',
            name: 'Old world',
            description: '',
            picture: null,
            cameWith: null,
            entries: 0,
            namesOffer: null,
            usedInEveryChat: false,
            usedInThisChat: false,
        },
        [OVERVIEW_VIEW]: {
            book: '1',
            groupBy: null,
            entries: [],
            more: false,
            layout: { regionsByNestingLevel: [], cardTextCharacters: 0 },
        },
    };
    const client: Client = {
        send: (type) => {
            sent.push(type);
            return type === 'worldbuilding.navigate' ? opened : Promise.resolve({ ok: true });
        },
        view: ((key: string) => () => held[key]) as Client['view'],
        receive: () => {},
        reconnected: async () => {},
        reread: async () => {},
        version: (key) => (held[key] !== undefined ? 1 : 0),
    };
    const host = document.createElement('div');
    document.body.append(host);
    let dispose = () => {};
    let compat!: ReturnType<typeof worldbuildingCompat>;
    const stop = createRoot((cleanup) => {
        compat = worldbuildingCompat(client, { showPane: () => compat.paneShown(true), notify: () => {} });
        dispose = render(
            () => (
                <UiProvider value={{ client, ...testCommands(), t: (text) => text }}>
                    <Worldbuilding
                        shown={compat.shown()}
                        started={compat.started()}
                        target={compat.target()}
                        onTargetOpened={compat.targetOpened}
                        notify={() => {}}
                        activationSettings={() => null}
                    />
                </UiProvider>
            ),
            host,
        );
        return cleanup;
    });
    try {
        compat.paneShown(true);
        const pane = host.querySelector('.wb-pane')!;
        let paneWidth = 1000;
        Object.defineProperty(pane, 'clientWidth', { get: () => paneWidth });
        for (const resize of resizes) resize();
        compat.paneShown(false);
        paneWidth = 0;
        for (const resize of resizes) resize();
        sent.length = 0;
        compat.openCharacterBook('42');
        paneWidth = 600;
        for (const resize of resizes) resize();
        expect(resizes.length).toBeGreaterThan(0);
        expect(sent).toEqual(['worldbuilding.navigate']);
        expect(compat.shown()).toBe(false);
        finishOpening();
        await opened;
        await vi.waitFor(() => expect(compat.shown()).toBe(true));
        paneWidth = 1000;
        for (const resize of resizes) resize();
        expect(sent).toEqual(['worldbuilding.navigate', 'worldbuilding.setViewport']);
    } finally {
        dispose();
        stop();
        host.remove();
        vi.unstubAllGlobals();
    }
});
