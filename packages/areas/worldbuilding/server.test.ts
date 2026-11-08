import * as v from 'valibot';
import { expect, test } from 'vite-plus/test';
import { actions, OVERVIEW_VIEW } from './protocol.ts';
import type { Card, OverviewView } from './protocol.ts';
import { around, worldbuildingArea } from './server.ts';
import type { Grouping, Ports, Step } from './server.ts';
import type { ActionContext, ActionResult, User } from '@st/server-ui';

const user: User = { handle: 'u', directories: { root: '/u' } };

const card = (key: string, rank: number): Card & { rank: number } => ({
    kind: 'entry',
    key,
    entry: key,
    uid: key,
    title: null,
    text: '',
    cut: false,
    keys: [],
    relations: [],
    members: 0,
    repeat: false,
    children: [],
    rank,
});

function world(count: number) {
    const asked: { overview: unknown[]; move: (Grouping & Step)[] } = { overview: [], move: [] };
    const ports: Ports = {
        overview: async (_u, q) => {
            asked.overview.push(q);
            if (q.book !== '1') return null;
            const items = [];
            for (let r = q.from; r < Math.min(q.to, count); r++) items.push(card(String(r + 100), r));
            const rank = q.active === null ? -1 : Number(q.active.split('/')[0]) - 100;
            return {
                count,
                from: q.from,
                items,
                active: rank >= 0 && rank < count ? { key: q.active ?? '', rank } : null,
            };
        },
        move: async (_u, q) => {
            asked.move.push(q);
            if ('to' in q)
                return { key: q.from.includes('/') ? q.from.slice(0, q.from.lastIndexOf('/')) : q.from, rank: 0 };
            const at = q.from === null ? (q.by > 0 ? -1 : count) : Number(q.from.split('/')[0]) - 100;
            const rank = Math.max(0, Math.min(count - 1, at + q.by));
            return count === 0 || (q.from !== null && (at < 0 || at >= count))
                ? null
                : { key: String(rank + 100), rank };
        },
    };
    const area = worldbuildingArea(ports);
    const context: ActionContext = { user, session: 's', chat: null, upload: null };
    const view = () => area.views[OVERVIEW_VIEW]!(context) as Promise<OverviewView>;
    const act = (type: string, payload: unknown): Promise<ActionResult> => area.actions[type]!(context, payload);
    return { view, act, asked };
}

test('opening a world opens its overview in the same answer, at the window asked for', async () => {
    const w = world(1000);
    expect(await w.view()).toEqual({ book: null, relation: null, count: 0, from: 0, items: [], active: null });
    expect(await w.act('worldbuilding.open', { book: '1', relation: 'in', from: 0, to: 20, around: null })).toEqual({
        changed: [],
        opens: [OVERVIEW_VIEW],
    });
    const shown = await w.view();
    expect(shown).toMatchObject({ book: '1', relation: 'in', count: 1000, from: 0, active: null });
    expect(shown.items.map((i) => i.rank)).toEqual([...Array(20).keys()]);
    expect(w.asked.move).toEqual([]);
});

test('opening around an occurrence puts the window around its top-level entry and marks where it landed', async () => {
    const w = world(1000);
    await w.act('worldbuilding.open', { book: '1', relation: 'in', from: 0, to: 20, around: '600/7/+' });
    expect(w.asked.move).toEqual([{ book: '1', relation: 'in', from: '600/7/+', by: 0 }]);
    const shown = await w.view();
    expect(shown.from).toBe(490);
    expect(shown.items).toHaveLength(20);
    expect(shown.active).toEqual({ key: '600', rank: 500 });
});

test('scrolling reads the next window; nothing is shown before a world is opened', async () => {
    const w = world(1000);
    expect(await w.act('worldbuilding.window', { from: 40, to: 60 })).toEqual({ refused: 'No world is shown.' });
    await w.act('worldbuilding.open', { book: '1', relation: null, from: 0, to: 20, around: null });
    expect(await w.act('worldbuilding.window', { from: 40, to: 60 })).toEqual({ changed: [OVERVIEW_VIEW] });
    const shown = await w.view();
    expect([shown.from, shown.items[0]?.rank, shown.relation]).toEqual([40, 40, null]);
});

test('a move lands where the store says, keeps the window when that is in it and follows it when it is not', async () => {
    const w = world(1000);
    await w.act('worldbuilding.open', { book: '1', relation: 'in', from: 0, to: 20, around: null });
    await w.act('worldbuilding.move', { from: '105', by: 1 });
    let shown = await w.view();
    expect([shown.from, shown.active]).toEqual([0, { key: '106', rank: 6 }]);
    await w.act('worldbuilding.move', { from: '106', by: 100 });
    shown = await w.view();
    expect([shown.from, shown.active]).toEqual([96, { key: '206', rank: 106 }]);
    await w.act('worldbuilding.move', { from: '206/3', to: 'parent' });
    expect(w.asked.move.at(-1)).toEqual({ book: '1', relation: 'in', from: '206/3', to: 'parent' });
    expect((await w.view()).active).toEqual({ key: '206', rank: 106 });
    expect(await w.act('worldbuilding.move', { from: '5000', by: 1 })).toEqual({
        refused: 'That is no longer shown.',
        changed: [OVERVIEW_VIEW],
    });
});

test("a world the store can't read shows nothing", async () => {
    const w = world(3);
    await w.act('worldbuilding.open', { book: '2', relation: 'in', from: 0, to: 20, around: null });
    expect(await w.view()).toEqual({ book: null, relation: null, count: 0, from: 0, items: [], active: null });
});

test('the schemas refuse a window that runs backwards or past 200, and a key that is no occurrence', () => {
    const ok = (type: keyof typeof actions, payload: unknown) => v.safeParse(actions[type], payload).success;
    const open = { book: '1', relation: 'in', from: 0, to: 20, around: null };
    expect(ok('worldbuilding.open', open)).toBe(true);
    expect(ok('worldbuilding.open', { ...open, to: 201 })).toBe(false);
    expect(ok('worldbuilding.open', { ...open, relation: '' })).toBe(false);
    expect(ok('worldbuilding.open', { ...open, around: '12/34/+' })).toBe(true);
    expect(ok('worldbuilding.open', { ...open, around: '12/+/3' })).toBe(false);
    expect(ok('worldbuilding.window', { from: 30, to: 10 })).toBe(false);
    expect(ok('worldbuilding.move', { from: null, by: -1 })).toBe(true);
    expect(ok('worldbuilding.move', { from: null, to: 'parent' })).toBe(false);
    expect(ok('worldbuilding.move', { from: '1', to: 'sibling' })).toBe(false);
    expect(ok('worldbuilding.move', { from: '1', by: 0.5 })).toBe(false);
});

test('a window follows a rank by keeping its width', () => {
    expect(around(5, 0, 20)).toEqual({ from: 0, to: 20 });
    expect(around(20, 0, 20)).toEqual({ from: 10, to: 30 });
    expect(around(3, 40, 60)).toEqual({ from: 0, to: 20 });
});
