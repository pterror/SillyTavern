import { createRoot } from 'solid-js';
import { render } from 'solid-js/web';
import { expect, test, vi } from 'vite-plus/test';
import { UiProvider } from '@st/page/context';
import type { ActionResult, Client } from '@st/page/client';
import { testCommands } from '@st/page/focus-actions';
import { WORLD_VIEW, OVERVIEW_VIEW } from '../protocol.ts';
import { Worldbuilding } from './Worldbuilding.tsx';
import { worldbuildingCompat } from './compat.ts';

test('opening embedded lore before the drawer has mounted opens only the requested character book', () => {
    const sent: string[] = [];
    let request: unknown;
    const client: Client = {
        send: async (type, payload) => {
            request = payload;
            sent.push(type);
            return { ok: true };
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
                        everShown={compat.everShown()}
                        target={compat.target()}
                        onTargetTaken={compat.targetTaken}
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
                        everShown={compat.everShown()}
                        target={compat.target()}
                        onTargetTaken={compat.targetTaken}
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
        expect(sent).toEqual(['worldbuilding.navigate', 'worldbuilding.setViewport']);
        finishOpening();
        await opened;
        await Promise.resolve();
        await Promise.resolve();
        paneWidth = 1000;
        for (const resize of resizes) resize();
        expect(sent).toEqual(['worldbuilding.navigate', 'worldbuilding.setViewport', 'worldbuilding.setViewport']);
    } finally {
        dispose();
        stop();
        host.remove();
        vi.unstubAllGlobals();
    }
});
