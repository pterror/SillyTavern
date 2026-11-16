import { expect, test } from 'vite-plus/test';
import { VIEW } from './protocol.ts';
import type { ListView, Message, Of } from './protocol.ts';
import { PAGE, TIPS_PAGE, recentHistoryArea } from './server.ts';
import type { Listed, Ports } from './server.ts';
import type { ActionContext, User } from '@st/server-ui';

const message = (n: number): Message => ({ nodeId: `n${n}`, text: `m${n}`, name: 'Ivy', role: 'assistant', date: n });

const listed = (n: number, tips = 0): Listed => ({
    id: tips === 0 ? `at:${n}` : `group:${n}`,
    group: tips === 0 ? null : `g${n}`,
    chat: { owner: { avatar: 'ivy.png' }, name: 'Ivy - 1' },
    message: message(n),
    split: tips === 0 ? null : { number: 3 },
    tips,
});

function stand(total: number, groupTips = 0) {
    const asked: { of: Of; before: string | null }[] = [];
    const all = Array.from({ length: total }, (_, i) => listed(i, i === 1 ? groupTips : 0));
    const ports: Ports = {
        entries: async (context, of, before, limit) => {
            asked.push({ of, before });
            if (of === 'chat' && context.chat === null) return null;
            const from = before === null ? 0 : Number(before);
            const to = Math.min(all.length, from + limit);
            return { entries: all.slice(from, to), next: to < all.length ? String(to) : null };
        },
        tips: async (_context, group, before, limit) => {
            const from = before === null ? 0 : Number(before);
            const count = groupTips;
            const to = Math.min(count, from + limit);
            const tips = Array.from({ length: to - from }, (_, i) =>
                from + i === 0 ? message(1) : message(1000 + from + i),
            );
            expect(group).toBe('g1');
            return { tips, next: to < count ? String(to) : null };
        },
    };
    const { area, showing } = recentHistoryArea(ports);
    const user: User = { handle: 'u', directories: { root: '/u' } };
    const context = (chat: boolean): ActionContext => ({
        user,
        session: 's',
        chat: chat ? { tree: '7' } : null,
        upload: null,
    });
    const act = (type: string, payload: unknown, chat = true) => area.actions[type]!(context(chat), payload);
    const read = async (chat = true): Promise<ListView[]> => {
        const parts: ListView[] = [];
        for await (const part of area.views[VIEW]!(context(chat)) as AsyncIterable<ListView>) parts.push(part);
        return parts;
    };
    const last = async (chat = true) => (await read(chat)).at(-1)!;
    return { act, read, last, asked, showing };
}

test('a page of entries is read at a time, in order, each more reading the next one', async () => {
    const { act, last, asked } = stand(PAGE * 2 + 5);
    expect(await act('recentHistory.open', { of: 'all' })).toEqual({ changed: [VIEW], opensViews: [VIEW] });
    const first = await last();
    expect(first.entries.map((e) => e.message.nodeId)).toEqual(Array.from({ length: PAGE }, (_, i) => `n${i}`));
    expect([first.of, first.more]).toEqual(['all', true]);
    await act('recentHistory.more', {});
    await act('recentHistory.more', {});
    asked.length = 0;
    const whole = await last();
    expect(whole.entries).toHaveLength(PAGE * 2 + 5);
    expect(whole.more).toBe(false);
    expect(asked).toEqual([
        { of: 'all', before: null },
        { of: 'all', before: String(PAGE) },
        { of: 'all', before: String(PAGE * 2) },
    ]);
});

test('the pages read come a part each, the first before the rest are read', async () => {
    const { act, read } = stand(PAGE * 3);
    await act('recentHistory.open', { of: 'all' });
    await act('recentHistory.more', {});
    await act('recentHistory.more', {});
    const parts = await read();
    expect(parts.map((p) => p.entries.length)).toEqual([PAGE, PAGE * 2, PAGE * 3]);
});

test('a group folds its other places, and expanded reads them a page at a time, without the one it shows', async () => {
    const { act, last } = stand(3, TIPS_PAGE + 4);
    await act('recentHistory.open', { of: 'chat' });
    const folded = (await last()).entries[1]!;
    expect([folded.others, folded.tips, folded.split]).toEqual([TIPS_PAGE + 3, null, { number: 3 }]);
    expect((await last()).entries[0]!.split).toBeNull();
    await act('recentHistory.expand', { id: 'group:1', open: true });
    const open = (await last()).entries[1]!.tips!;
    expect(open.messages.map((m) => m.nodeId)).toEqual(Array.from({ length: TIPS_PAGE - 1 }, (_, i) => `n${1001 + i}`));
    expect(open.more).toBe(true);
    await act('recentHistory.moreTips', { id: 'group:1' });
    const all = (await last()).entries[1]!.tips!;
    expect([all.messages.length, all.more]).toEqual([TIPS_PAGE + 3, false]);
    await act('recentHistory.expand', { id: 'group:1', open: false });
    expect((await last()).entries[1]!.tips).toBeNull();
    expect('refused' in (await act('recentHistory.moreTips', { id: 'group:1' }))).toBe(true);
});

test("one chat's history with no chat open reads nothing; closed it shows nothing and the tab no longer shows it", async () => {
    const { act, last, showing } = stand(4);
    expect(showing('/u')).toBe(false);
    await act('recentHistory.open', { of: 'chat' }, false);
    expect(showing('/u')).toBe(true);
    expect(await last(false)).toEqual({ of: 'chat', entries: [], more: false, chatOpen: false });
    await act('recentHistory.close', {});
    expect(await last()).toEqual({ of: null, entries: [], more: false, chatOpen: true });
    expect(showing('/u')).toBe(false);
    expect('refused' in (await act('recentHistory.more', {}))).toBe(true);
});
