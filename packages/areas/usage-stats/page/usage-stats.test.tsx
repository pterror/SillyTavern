import { flush as flushSync } from 'solid-js';
import { createRoot, createSignal } from 'solid-js';
import { render } from '@solidjs/web';
import { expect, test } from 'vite-plus/test';
import type { Client } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import { testCommands } from '@st/page/focus-actions';
import type { Counts, ShownView } from '../protocol.ts';
import { UsageStats, generationTime } from './UsageStats.tsx';

const counts: Counts = {
    firstChat: null,
    generationMs: 90_061_000,
    repliesWithoutTime: 2,
    userMessages: 4,
    characterMessages: 3,
    userWords: 40,
    characterWords: 90,
    swipes: 1,
};

// A close is answered only when the test calls `answerClose`, so what the page shows before the answer can be seen;
// `push` stands for a view the server pushes meanwhile.
function mount(refuse = false) {
    const [view, setView] = createSignal<ShownView | undefined>(undefined);
    const sent: { type: string; payload: unknown }[] = [];
    const failed: string[] = [];
    let viewsRead = 0;
    const closes: ((ok: boolean) => void)[] = [];
    // How many dialogs were open and not closing at each dialogsChanged call.
    const layers: number[] = [];
    const client: Client = {
        send: async (type, payload) => {
            sent.push({ type, payload });
            if (type === 'usageStats.close') {
                return new Promise((resolve) => {
                    closes.push((ok) => {
                        if (!ok) {
                            resolve({ ok: false, error: "The server can't be reached." });
                            return;
                        }
                        setView({ of: null });
                        flushSync();
                        resolve({ ok: true });
                    });
                });
            }
            if (refuse) return { ok: false, error: 'internal' };
            const of = payload as { of: 'all' } | { of: 'character'; avatar: string };
            setView(of.of === 'all' ? { of: 'all', counts, oldStatsFile: 'old.json' } : { ...of, counts });
            flushSync();
            return { ok: true };
        },
        view: <T,>() => {
            viewsRead++;
            return view as unknown as () => T | undefined;
        },
        receive: () => {},
        reconnected: async () => {},
        reread: async () => {},
        version: () => 0,
    };
    const all = document.createElement('div');
    const character = document.createElement('i');
    const host = document.createElement('div');
    document.body.append(all, character, host);
    let shownCharacter: string | null = 'rex.png';
    createRoot(() =>
        render(
            () => (
                <UiProvider value={{ client, ...testCommands(), t: (text) => text }}>
                    <UsageStats
                        buttons={{ all, character }}
                        old={{
                            shownCharacter: () => shownCharacter,
                            failed: (message) => failed.push(message),
                            dialogsChanged: () =>
                                layers.push(document.querySelectorAll('dialog[open]:not([closing])').length),
                        }}
                    />
                </UiProvider>
            ),
            host,
        ),
    );
    const settle = async () => {
        for (let i = 0; i < 4; i++) await Promise.resolve();
    };
    return {
        all,
        character,
        host,
        sent,
        failed,
        layers,
        settle,
        answerClose: async (ok: boolean) => {
            closes.shift()?.(ok);
            await settle();
        },
        push: (next: ShownView) => setView(next),
        viewsRead: () => viewsRead,
        noCharacter: () => (shownCharacter = null),
    };
}

const rows = (host: HTMLElement) =>
    [...host.querySelectorAll('.rm_stat_block')].map((row) => [
        row.querySelector('.rm_stat_name')?.textContent,
        row.querySelector('.rm_stat_value')?.textContent,
    ]);

test('the user stats are shown once the server answers, and closed at once, the server told afterwards', async () => {
    const stand = mount();
    expect(stand.viewsRead()).toBe(0);
    stand.all.click();
    flushSync();
    await stand.settle();
    expect(stand.sent).toEqual([{ type: 'usageStats.show', payload: { of: 'all' } }]);
    const dialog = stand.host.querySelector('dialog');
    expect(dialog?.open).toBe(true);
    expect(stand.layers.at(-1)).toBe(1);
    expect(stand.host.querySelector('h3')?.textContent).toBe('User Stats');
    expect(rows(stand.host)).toEqual([
        ['Chatting Since:', 'Never'],
        ['Chat Time:', '1 day, 1 hour, 1 minute, 1 second (+2 replies without generation time)'],
        ['User Messages:', '4'],
        ['Character Messages:', '3'],
        ['User Words:', '40'],
        ['Character Words:', '90'],
        ['Swipes:', '1'],
    ]);
    expect(stand.host.querySelector('small')?.textContent).toContain('old.json');

    stand.host.querySelector<HTMLElement>('.popup-button-ok')?.click();
    flushSync();
    expect(dialog?.open).toBe(false);
    expect(stand.host.querySelector('dialog')).toBeNull();
    expect(stand.layers.at(-1)).toBe(0);
    expect(stand.sent.at(-1)).toEqual({ type: 'usageStats.close', payload: {} });
    stand.push({ of: 'all', counts: { ...counts, userMessages: 5 }, oldStatsFile: null });
    await stand.answerClose(true);
    expect(stand.host.querySelector('dialog')).toBeNull();
    expect(stand.sent.filter((s) => s.type === 'usageStats.close')).toHaveLength(1);
    expect(stand.failed).toEqual([]);
});

test('a close the server refuses shows no error, and the stats stay closed', async () => {
    const stand = mount();
    stand.all.click();
    flushSync();
    await stand.settle();
    const dialog = stand.host.querySelector('dialog');
    dialog?.dispatchEvent(new Event('cancel', { cancelable: true }));
    flushSync();
    expect(dialog?.open).toBe(false);
    expect(stand.sent.at(-1)).toEqual({ type: 'usageStats.close', payload: {} });
    await stand.answerClose(false);
    expect(stand.host.querySelector('dialog')).toBeNull();
    expect(stand.failed).toEqual([]);
});

test('stats the server says are closed close here too, and no close is sent', async () => {
    const stand = mount();
    stand.all.click();
    flushSync();
    await stand.settle();
    stand.push({ of: null });
    await stand.settle();
    expect(stand.host.querySelector('dialog')).toBeNull();
    expect(stand.layers.at(-1)).toBe(0);
    expect(stand.sent.filter((s) => s.type === 'usageStats.close')).toHaveLength(0);
});

test('the character stats are of the character the panel shows; with none shown nothing is sent', async () => {
    const stand = mount();
    stand.character.click();
    flushSync();
    await stand.settle();
    expect(stand.sent).toEqual([{ type: 'usageStats.show', payload: { of: 'character', avatar: 'rex.png' } }]);
    expect(stand.host.querySelector('h3')?.textContent).toBe('Character Stats');
    expect(rows(stand.host)[0]).toEqual(['First Interaction:', 'Never']);
    expect(stand.host.querySelector('small')).toBeNull();

    stand.host.querySelector<HTMLElement>('.popup-button-close')?.click();
    flushSync();
    expect(stand.host.querySelector('dialog')).toBeNull();
    expect(stand.sent.at(-1)).toEqual({ type: 'usageStats.close', payload: {} });
    await stand.answerClose(true);
    stand.noCharacter();
    stand.character.click();
    flushSync();
    await stand.settle();
    expect(stand.sent.filter((s) => s.type === 'usageStats.show')).toHaveLength(1);
});

test('a refused show says the stats could not be loaded and shows nothing', async () => {
    const stand = mount(true);
    stand.all.click();
    flushSync();
    await stand.settle();
    expect(stand.failed).toEqual(['Couldn’t load stats. Reload the page.']);
    expect(stand.host.querySelector('dialog')).toBeNull();
});

test('generation time names each unit above seconds only when it has any', () => {
    const same = (text: string) => text;
    expect(generationTime(0, same)).toBe('0 seconds');
    expect(generationTime(61_500, same)).toBe('1 minute, 1 second');
    expect(generationTime(3_600_000, same)).toBe('1 hour, 0 seconds');
    expect(generationTime(183_925_000, same)).toBe('2 days, 3 hours, 5 minutes, 25 seconds');
});
