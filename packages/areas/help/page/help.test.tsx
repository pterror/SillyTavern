import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { expect, test } from 'vite-plus/test';
import { HOTKEYS_VIEW, PANEL_VIEW } from '../protocol.ts';
import type { HotkeysView, PanelView } from '../protocol.ts';
import type { Client } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import { createCommands } from '@st/page/commands';
import { Help, Hotkeys } from './Help.tsx';
import type { Browser, OldPage } from './Help.tsx';
import { helpCompat } from './compat.ts';

const COMMANDS: Record<Browser, string[]> = { slash: ['echo', 'help', 'run'], macros: ['user', 'char'] };

function stand(
    first: PanelView = { open: false },
    markdown = false,
    browsersLoaded: Promise<void> = Promise.resolve(),
) {
    const [panel, setPanel] = createSignal<PanelView>(first);
    const [hotkeys, setHotkeys] = createSignal<HotkeysView>({ markdown });
    const sent: { type: string; payload: unknown }[] = [];
    const read: string[] = [];
    let held = false;
    let waiting: (() => void)[] = [];
    const client: Client = {
        send: async (type, payload) => {
            sent.push({ type, payload });
            if (held) await new Promise<void>((resolve) => waiting.push(resolve));
            if (type === 'help.open') setPanel({ open: true, topic: 'overview' });
            if (type === 'help.close') setPanel({ open: false });
            return { ok: true };
        },
        view: <T,>(key: string) => {
            read.push(key);
            return (key === PANEL_VIEW ? panel : key === HOTKEYS_VIEW ? hotkeys : () => undefined) as () =>
                | T
                | undefined;
        },
        receive: () => {},
        reconnected: async () => {},
        reread: async () => {},
        version: () => 1,
    };
    const layers: { content: HTMLElement; requestClose: () => void; raised: number; closed: boolean }[] = [];
    const old: OldPage = {
        layer(content, options) {
            const layer = { content, requestClose: options.requestClose, raised: 1, closed: false };
            content.classList.add(options.className);
            document.body.append(content);
            layers.push(layer);
            return {
                raise: () => void layer.raised++,
                close: () => {
                    layer.closed = true;
                    content.remove();
                },
            };
        },
        async browser(kind, into) {
            await browsersLoaded;
            const list = document.createElement('ul');
            list.className = `browser-${kind}`;
            for (const name of COMMANDS[kind]) {
                const item = document.createElement('li');
                item.textContent = name;
                list.append(item);
            }
            into.append(list);
            return {
                search: (query) => COMMANDS[kind].filter((name) => name.includes(query.trim().toLowerCase())).length,
            };
        },
    };
    const compat = helpCompat(client);
    const host = document.createElement('div');
    document.body.append(host);
    const dispose = render(
        () => (
            <UiProvider value={{ client, commands: createCommands(), t: (text) => text }}>
                <Help
                    shown={compat.shown()}
                    old={old}
                    onRaise={(raise) => compat.onRaise(raise)}
                    onClose={() => compat.close()}
                />
            </UiProvider>
        ),
        host,
    );
    const panelElement = () => document.querySelector<HTMLElement>('.helpLayer');
    const hold = () => {
        held = true;
    };
    const letGo = () => {
        held = false;
        const go = waiting;
        waiting = [];
        for (const resolve of go) resolve();
    };
    return {
        compat,
        setPanel,
        setHotkeys,
        sent,
        read,
        layers,
        panelElement,
        hold,
        letGo,
        dispose: () => {
            dispose();
            host.remove();
            for (const layer of layers) layer.content.remove();
        },
    };
}

const settle = () => new Promise((resolve) => queueMicrotask(() => queueMicrotask(() => resolve(undefined))));
const flush = async () => {
    for (let i = 0; i < 5; i++) await settle();
};

const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
};

const text = (element: Element | null | undefined) => element?.textContent ?? '';
const topics = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>('.helpTopic')].map((item) => item.dataset['topic']);

test('nothing is read or drawn until help opens; opening again raises the open panel', async () => {
    const { compat, sent, read, layers, panelElement, dispose } = stand();
    expect(panelElement()).toBeNull();
    expect(read).toEqual([]);
    expect(await compat.open('')).toBeNull();
    expect(read).toContain(PANEL_VIEW);
    expect(sent).toEqual([{ type: 'help.open', payload: { name: '' } }]);
    const root = panelElement();
    expect(root).not.toBeNull();
    expect(root?.querySelector('.helpTopic.active')?.getAttribute('data-topic')).toBe('overview');
    expect(text(root?.querySelector('.helpHeaderTitle'))).toBe('Overview');
    expect(layers).toHaveLength(1);
    const raisedBefore = layers[0]?.raised ?? 0;
    await compat.open('slash');
    expect(layers).toHaveLength(1);
    expect(layers[0]?.raised).toBeGreaterThan(raisedBefore);
    dispose();
});

test('the topic shown is the one the view names; a pick and an overview link ask for it', async () => {
    const s = stand();
    await s.compat.open('');
    const root = s.panelElement() as HTMLElement;
    expect(topics(root)).toEqual(['overview', 'slash', 'format', 'hotkeys', 'macros']);
    root.querySelector<HTMLElement>('.helpTopic[data-topic="format"]')?.click();
    expect(s.sent.at(-1)).toEqual({ type: 'help.show', payload: { topic: 'format' } });
    expect(text(root.querySelector('.helpContent'))).toContain('Choose a topic:');
    s.setPanel({ open: true, topic: 'format' });
    expect(text(root.querySelector('.helpContent'))).toContain('italics');
    expect(root.querySelector('.helpTopic.active')?.getAttribute('data-topic')).toBe('format');
    s.setPanel({ open: true, topic: 'overview' });
    [...root.querySelectorAll<HTMLAnchorElement>('.helpContent a')].find((a) => a.textContent === 'Hotkeys')?.click();
    expect(s.sent.at(-1)).toEqual({ type: 'help.show', payload: { topic: 'hotkeys' } });
    s.setPanel({ open: true, topic: 'slash' });
    await flush();
    expect(root.querySelector('.helpSection[data-topic="slash"] .browser-slash')).not.toBeNull();
    s.dispose();
});

test('the markdown hotkeys are greyed out while they are off', async () => {
    const s = stand({ open: false }, false);
    await s.compat.open('hotkeys');
    s.setPanel({ open: true, topic: 'hotkeys' });
    const root = s.panelElement() as HTMLElement;
    const item = (combo: string) =>
        [...root.querySelectorAll('.hotkeyItem')].find((li) =>
            [...li.querySelectorAll('kbd')].some((k) => k.textContent === combo),
        );
    expect(item('Ctrl+B')?.classList.contains('hotkeyInactive')).toBe(true);
    expect(item('Ctrl+Space')?.classList.contains('hotkeyInactive')).toBe(false);
    s.setHotkeys({ markdown: true });
    expect(item('Ctrl+B')?.classList.contains('hotkeyInactive')).toBe(false);
    s.dispose();
});

test('a search filters what the panel holds as it is typed, asking the server nothing, and shows the topics that match once every topic is counted', async () => {
    const s = stand();
    await s.compat.open('');
    const root = s.panelElement() as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('.helpSearch') as HTMLInputElement;
    const sentBefore = s.sent.length;
    type(input, 'autocomplete');
    await flush();
    expect(text(root.querySelector('.helpHeaderTitle'))).toBe('Search results');
    expect(topics(root)).toEqual(['hotkeys']);
    expect(text(root.querySelector('.helpTopic[data-topic="hotkeys"] .helpTopicCount'))).toBe('4');
    const section = (topic: string) => root.querySelector<HTMLElement>(`.helpSection[data-topic="${topic}"]`);
    expect(section('hotkeys')?.hidden).toBe(false);
    expect(section('macros')?.hidden).toBe(true);
    expect(section('format')?.hidden).toBe(true);
    expect(root.querySelector('.helpNoResults')).toBeNull();

    type(input, 'e');
    await flush();
    expect(topics(root)).toContain('slash');
    expect(text(root.querySelector('.helpTopic[data-topic="slash"] .helpTopicCount'))).toBe('2');

    type(input, 'zzqqxxnomatchzz');
    await flush();
    expect(topics(root)).toEqual([]);
    expect(root.querySelector('.helpNoResults')).not.toBeNull();

    type(input, 'bold');
    await flush();
    root.querySelector<HTMLElement>('.helpTopic[data-topic="format"]')?.click();
    expect(s.sent.length).toBe(sentBefore);

    type(input, '');
    expect(root.querySelector('.helpTopic.active')?.getAttribute('data-topic')).toBe('overview');
    s.dispose();
});

test('a topic shown ends the search', async () => {
    const s = stand();
    await s.compat.open('');
    const root = s.panelElement() as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('.helpSearch') as HTMLInputElement;
    type(input, 'hotkeys');
    await flush();
    [...root.querySelectorAll<HTMLAnchorElement>('.helpContent a')].find((a) => a.textContent === 'Hotkeys')?.click();
    expect(s.sent.at(-1)).toEqual({ type: 'help.show', payload: { topic: 'hotkeys' } });
    expect(input.value).toBe('');
    type(input, 'ctrl');
    s.setPanel({ open: true, topic: 'slash' });
    await flush();
    expect(input.value).toBe('');
    expect(text(root.querySelector('.helpHeaderTitle'))).not.toBe('Search results');
    s.dispose();
});

test('while every topic is being counted, the side menu keeps the topics it listed before', async () => {
    let load = () => {};
    const loaded = new Promise<void>((resolve) => (load = resolve));
    const s = stand({ open: false }, false, loaded);
    await s.compat.open('');
    const root = s.panelElement() as HTMLElement;
    type(root.querySelector<HTMLInputElement>('.helpSearch') as HTMLInputElement, 'autocomplete');
    await flush();
    expect(topics(root)).toEqual(['overview', 'slash', 'format', 'hotkeys', 'macros']);
    expect(root.querySelector('.helpTopic.active')?.getAttribute('data-topic')).toBe('overview');
    expect(root.querySelector('.helpNoResults')).toBeNull();
    load();
    await flush();
    expect(topics(root)).toEqual(['hotkeys']);
    s.dispose();
});

test('the close button closes the layer at once and tells the server afterwards; a refusal shows nothing', async () => {
    const s = stand();
    await s.compat.open('');
    const layer = s.layers[0];
    s.hold();
    layer?.requestClose();
    expect(layer?.closed).toBe(true);
    expect(s.panelElement()).toBeNull();
    expect(s.sent.at(-1)).toEqual({ type: 'help.close', payload: {} });
    s.setPanel({ open: true, topic: 'slash' });
    await flush();
    expect(s.panelElement()).toBeNull();
    s.letGo();
    await flush();
    expect(s.panelElement()).toBeNull();
    expect(await s.compat.open('')).toBeNull();
    expect(s.panelElement()).not.toBeNull();
    expect(s.layers).toHaveLength(2);
    s.dispose();
});

test('help the server says is closed closes here too', async () => {
    const s = stand();
    await s.compat.open('');
    s.setPanel({ open: false });
    expect(s.layers[0]?.closed).toBe(true);
    expect(s.sent.filter((sent) => sent.type === 'help.close')).toHaveLength(0);
    s.dispose();
});

test('the hotkeys list drawn alone shows the view it reads', () => {
    const [hotkeys] = createSignal<HotkeysView>({ markdown: true });
    const client = { view: () => hotkeys } as unknown as Client;
    const host = document.createElement('div');
    const dispose = render(
        () => (
            <UiProvider value={{ client, commands: createCommands(), t: (text) => text }}>
                <Hotkeys />
            </UiProvider>
        ),
        host,
    );
    expect(host.querySelectorAll('.hotkeyGroup').length).toBeGreaterThan(3);
    expect(host.querySelector('.hotkeyInactive')).toBeNull();
    dispose();
});
