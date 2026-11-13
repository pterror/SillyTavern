import { createRoot, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { expect, test } from 'vite-plus/test';
import type { Client } from '@st/page/client';
import { UiProvider } from '@st/page/context';
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

function mount(refuse = false) {
    const [view, setView] = createSignal<ShownView | undefined>(undefined);
    const sent: { type: string; payload: unknown }[] = [];
    const failed: string[] = [];
    let viewsRead = 0;
    const client: Client = {
        send: async (type, payload) => {
            sent.push({ type, payload });
            if (refuse) return { ok: false, error: 'internal' };
            if (type === 'usageStats.show') {
                const of = payload as { of: 'all' } | { of: 'character'; avatar: string };
                setView(of.of === 'all' ? { of: 'all', counts, oldStatsFile: 'old.json' } : { ...of, counts });
            } else setView({ of: null });
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
                <UiProvider value={{ client, t: (text) => text }}>
                    <UsageStats
                        buttons={{ all, character }}
                        old={{ shownCharacter: () => shownCharacter, failed: (message) => failed.push(message) }}
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
        settle,
        viewsRead: () => viewsRead,
        noCharacter: () => (shownCharacter = null),
    };
}

const rows = (host: HTMLElement) =>
    [...host.querySelectorAll('.rm_stat_block')].map((row) => [
        row.querySelector('.rm_stat_name')?.textContent,
        row.querySelector('.rm_stat_value')?.textContent,
    ]);

test('the user stats are shown once the server answers, and closed once it confirms', async () => {
    const stand = mount();
    expect(stand.viewsRead()).toBe(0);
    stand.all.click();
    await stand.settle();
    expect(stand.sent).toEqual([{ type: 'usageStats.show', payload: { of: 'all' } }]);
    const dialog = stand.host.querySelector('dialog');
    expect(dialog?.open).toBe(true);
    expect(stand.host.querySelector('h3')?.textContent).toBe('User Stats');
    expect(rows(stand.host)).toEqual([
        ['Chatting Since:', 'Never'],
        ['Chat Time:', '1 Days, 1 Hours, 1 Minutes, 1 Seconds (plus 2 replies saved without their generation time)'],
        ['User Messages:', '4'],
        ['Character Messages:', '3'],
        ['User Words:', '40'],
        ['Character Words:', '90'],
        ['Swipes:', '1'],
    ]);
    expect(stand.host.querySelector('small')?.textContent).toContain('old.json');

    stand.host.querySelector<HTMLElement>('.popup-button-ok')?.click();
    await stand.settle();
    expect(stand.sent.at(-1)).toEqual({ type: 'usageStats.close', payload: {} });
    expect(dialog?.open).toBe(false);
});

test('the character stats are of the character the panel shows; with none shown nothing is sent', async () => {
    const stand = mount();
    stand.character.click();
    await stand.settle();
    expect(stand.sent).toEqual([{ type: 'usageStats.show', payload: { of: 'character', avatar: 'rex.png' } }]);
    expect(stand.host.querySelector('h3')?.textContent).toBe('Character Stats');
    expect(rows(stand.host)[0]).toEqual(['First Interaction:', 'Never']);
    expect(stand.host.querySelector('small')).toBeNull();

    stand.host.querySelector<HTMLElement>('.popup-button-close')?.click();
    await stand.settle();
    stand.noCharacter();
    stand.character.click();
    await stand.settle();
    expect(stand.sent.filter((s) => s.type === 'usageStats.show')).toHaveLength(1);
});

test('a refused show says the stats could not be loaded and shows nothing', async () => {
    const stand = mount(true);
    stand.all.click();
    await stand.settle();
    expect(stand.failed).toEqual(['Stats could not be loaded. Try reloading the page.']);
    expect(stand.host.querySelector('dialog')).toBeNull();
});

test('generation time names each unit above seconds only when it has any', () => {
    expect(generationTime(0)).toBe('0 Seconds');
    expect(generationTime(61_500)).toBe('1 Minutes, 1 Seconds');
    expect(generationTime(3_600_000)).toBe('1 Hours, 0 Seconds');
});
