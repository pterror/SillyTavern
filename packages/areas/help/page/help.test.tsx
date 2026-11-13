import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { expect, test } from 'vite-plus/test';
import { HOTKEYS_VIEW, PANEL_VIEW } from '../protocol.ts';
import type { HotkeysView, PanelView } from '../protocol.ts';
import type { Client } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import { Help, Hotkeys } from './Help.tsx';
import type { Browser, OldPage } from './Help.tsx';
import { helpCompat } from './compat.ts';

const COMMANDS: Record<Browser, string[]> = { slash: ['echo', 'help', 'run'], macros: ['user', 'char'] };

function stand(first: PanelView = { open: false }, markdown = false) {
    const [panel, setPanel] = createSignal<PanelView>(first);
    const [hotkeys, setHotkeys] = createSignal<HotkeysView>({ markdown });
    const sent: { type: string; payload: unknown }[] = [];
    let release: (() => void) | null = null;
    const client: Client = {
        send: async (type, payload) => {
            sent.push({ type, payload });
            if (type === 'help.open') setPanel({ open: true, topic: 'overview', query: '' });
            if (type === 'help.close') setPanel({ open: false });
            if (release === null) return { ok: true };
            await new Promise<void>((resolve) => (release = resolve));
            return { ok: true };
        },
        view: <T,>(key: string) =>
            (key === PANEL_VIEW ? panel : key === HOTKEYS_VIEW ? hotkeys : () => undefined) as () => T | undefined,
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
            <UiProvider value={{ client, t: (text) => text }}>
                <Help reading={compat.reading()} old={old} onRaise={(raise) => compat.onRaise(raise)} />
            </UiProvider>
        ),
        host,
    );
    const panelElement = () => document.querySelector<HTMLElement>('.helpLayer');
    const hold = () => {
        release = () => {};
    };
    const letGo = () => {
        const go = release;
        release = null;
        go?.();
    };
    return {
        compat,
        setPanel,
        setHotkeys,
        sent,
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

const text = (element: Element | null | undefined) => element?.textContent ?? '';
const topics = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>('.helpTopic')].map((item) => item.dataset['topic']);

test('nothing is read or drawn until help opens; opening again raises the open panel', async () => {
    const { compat, sent, layers, panelElement, dispose } = stand();
    expect(panelElement()).toBeNull();
    expect(await compat.open('')).toBeNull();
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
    expect(text(root.querySelector('.helpContent'))).toContain('Hello there!');
    s.setPanel({ open: true, topic: 'format', query: '' });
    expect(text(root.querySelector('.helpContent'))).toContain('italics');
    expect(root.querySelector('.helpTopic.active')?.getAttribute('data-topic')).toBe('format');
    s.setPanel({ open: true, topic: 'overview', query: '' });
    [...root.querySelectorAll<HTMLAnchorElement>('.helpContent a')].find((a) => a.textContent === 'Hotkeys')?.click();
    expect(s.sent.at(-1)).toEqual({ type: 'help.show', payload: { topic: 'hotkeys' } });
    s.setPanel({ open: true, topic: 'slash', query: '' });
    await flush();
    expect(root.querySelector('.helpSection[data-topic="slash"] .browser-slash')).not.toBeNull();
    s.dispose();
});

test('the markdown hotkeys are greyed out while they are off', async () => {
    const s = stand({ open: false }, false);
    await s.compat.open('hotkeys');
    s.setPanel({ open: true, topic: 'hotkeys', query: '' });
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

test('a search sends what is typed and shows, once every topic is counted, the topics that match', async () => {
    const s = stand();
    await s.compat.open('');
    const root = s.panelElement() as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('.helpSearch') as HTMLInputElement;
    input.value = 'strikethrough';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(s.sent.at(-1)).toEqual({ type: 'help.search', payload: { query: 'strikethrough' } });
    s.setPanel({ open: true, topic: 'overview', query: 'strikethrough' });
    await flush();
    expect(text(root.querySelector('.helpHeaderTitle'))).toBe('Search results');
    expect(topics(root)).toEqual(['hotkeys']);
    expect(text(root.querySelector('.helpTopic[data-topic="hotkeys"] .helpTopicCount'))).toBe('1');
    const section = (topic: string) => root.querySelector<HTMLElement>(`.helpSection[data-topic="${topic}"]`);
    expect(section('hotkeys')?.hidden).toBe(false);
    expect(section('macros')?.hidden).toBe(true);
    expect(section('format')?.hidden).toBe(true);
    expect(root.querySelector('.helpNoResults')).toBeNull();

    s.setPanel({ open: true, topic: 'overview', query: 'e' });
    await flush();
    expect(topics(root)).toContain('slash');
    expect(text(root.querySelector('.helpTopic[data-topic="slash"] .helpTopicCount'))).toBe('2');

    s.setPanel({ open: true, topic: 'overview', query: 'zzqqxxnomatchzz' });
    await flush();
    expect(topics(root)).toEqual([]);
    expect(root.querySelector('.helpNoResults')).not.toBeNull();

    const before = s.sent.length;
    s.setPanel({ open: true, topic: 'overview', query: 'bold' });
    await flush();
    root.querySelector<HTMLElement>('.helpTopic[data-topic="format"]')?.click();
    expect(s.sent.length).toBe(before);

    s.setPanel({ open: true, topic: 'overview', query: '' });
    expect(root.querySelector('.helpTopic.active')?.getAttribute('data-topic')).toBe('overview');
    s.dispose();
});

test("the search box isn't overwritten by an earlier answer while what's typed is still being sent", async () => {
    const s = stand();
    await s.compat.open('');
    const root = s.panelElement() as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('.helpSearch') as HTMLInputElement;
    s.hold();
    input.value = 'ab';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    s.setPanel({ open: true, topic: 'overview', query: 'a' });
    expect(input.value).toBe('ab');
    s.setPanel({ open: true, topic: 'overview', query: 'ab' });
    s.letGo();
    await flush();
    expect(input.value).toBe('ab');
    s.setPanel({ open: true, topic: 'slash', query: '' });
    await flush();
    expect(input.value).toBe('');
    s.dispose();
});

test('the close button asks the server, and the layer goes when the view says help is closed', async () => {
    const s = stand();
    await s.compat.open('');
    const layer = s.layers[0];
    layer?.requestClose();
    expect(s.sent.at(-1)).toEqual({ type: 'help.close', payload: {} });
    await flush();
    expect(layer?.closed).toBe(true);
    expect(s.panelElement()).toBeNull();
    s.dispose();
});

test('the hotkeys list drawn alone shows the view it reads', () => {
    const [hotkeys] = createSignal<HotkeysView>({ markdown: true });
    const client = { view: () => hotkeys } as unknown as Client;
    const host = document.createElement('div');
    const dispose = render(
        () => (
            <UiProvider value={{ client, t: (text) => text }}>
                <Hotkeys />
            </UiProvider>
        ),
        host,
    );
    expect(host.querySelectorAll('.hotkeyGroup').length).toBeGreaterThan(3);
    expect(host.querySelector('.hotkeyInactive')).toBeNull();
    dispose();
});
