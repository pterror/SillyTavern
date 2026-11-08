import * as v from 'valibot';
import { expect, test } from 'vite-plus/test';
import {
    actions,
    cardsPerTopLevelEntry,
    LAST_CHANGE_VIEW,
    LOOP_CHECK_VISITS_PER_WRITE,
    MAX_CARDS_PER_READ,
    OVERVIEW_VIEW,
    READ_REFUSAL,
    RELATION_KINDS_VIEW,
} from './protocol.ts';
import type { EntryCell, LastChangeView, OverviewLayout, OverviewView, RelationKindsView } from './protocol.ts';
import { rangeAround, worldbuildingArea } from './server.ts';
import type { Grouping, OverviewStep, Ports, RelationChange } from './server.ts';
import type { ActionContext, ActionResult, User } from '@st/server-ui';

const user: User = { handle: 'u', directories: { root: '/u' } };

const LAYOUT: OverviewLayout = { regionsByNestingLevel: [{ columns: 3, rows: 2 }], cardTextCharacters: 300 };

const card = (occurrence: string, topLevelRank: number): EntryCell & { topLevelRank: number } => ({
    cell: 'entry',
    occurrence,
    entry: occurrence,
    entryKey: occurrence,
    title: null,
    text: '',
    textCut: false,
    keys: [],
    relations: [],
    memberCount: 0,
    alreadyOpenAbove: false,
    region: [],
    topLevelRank,
});

function world(count: number) {
    const asked: {
        overview: unknown[];
        step: (Grouping & OverviewStep)[];
        changes: { book: string; change: RelationChange; loopCheckLimit: number; session: string }[];
    } = { overview: [], step: [], changes: [] };
    const kinds = [{ id: '1', name: 'in' }];
    const ports: Ports = {
        readOverview: async (_u, q) => {
            asked.overview.push(q);
            if (q.book !== '1') return null;
            const entries = [];
            for (let r = q.firstRank; r < Math.min(q.endRank, count); r++) entries.push(card(String(r + 100), r));
            const rank = q.stepLandedOn === null ? -1 : Number(q.stepLandedOn.split('/')[0]) - 100;
            return {
                topLevelCount: count,
                firstRank: q.firstRank,
                entries,
                stepLanding:
                    rank >= 0 && rank < count ? { occurrence: q.stepLandedOn ?? '', topLevelRank: rank } : null,
            };
        },
        stepOverview: async (_u, { layout, ...q }) => {
            void layout;
            asked.step.push(q);
            if ('to' in q)
                return {
                    occurrence: q.from.includes('/') ? q.from.slice(0, q.from.lastIndexOf('/')) : q.from,
                    topLevelRank: 0,
                };
            const at = q.from === null ? (q.by > 0 ? -1 : count) : Number(q.from.split('/')[0]) - 100;
            const rank = Math.max(0, Math.min(count - 1, at + q.by));
            return count === 0 || (q.from !== null && (at < 0 || at >= count))
                ? null
                : { occurrence: String(rank + 100), topLevelRank: rank };
        },
        readRelationKinds: async (_u, book) => (book === '1' ? kinds : null),
        createRelationKind: async (_w, book, name) => {
            if (book !== '1') return null;
            kinds.push({ id: String(kinds.length + 1), name });
            return String(kinds.length);
        },
        renameRelationKind: async (_w, _b, kind, name) => {
            const found = kinds.find((existing) => existing.id === kind);
            if (!found) return 'no kind';
            found.name = name;
            return 'ok';
        },
        deleteRelationKind: async (_w, _b, kind) => {
            if (kind === '1') return 'in use';
            const at = kinds.findIndex((existing) => existing.id === kind);
            if (at === -1) return 'no kind';
            kinds.splice(at, 1);
            return 'ok';
        },
        changeRelation: async ({ session }, book, change, loopCheckLimit) => {
            asked.changes.push({ book, change, loopCheckLimit, session });
            if (change.target === '999') return { refused: "The target isn't an entry of this world." };
            return {
                unreachedLoops: change.entry === '7' ? [{ entry: '7', kind: change.kind, entries: ['7', '8'] }] : [],
            };
        },
    };
    const area = worldbuildingArea(ports);
    const context: ActionContext = { user, session: 's', chat: null, upload: null };
    const view = <T>(key: string) => area.views[key]!(context) as Promise<T>;
    const act = (type: string, payload: unknown): Promise<ActionResult> => area.actions[type]!(context, payload);
    return { view, act, asked };
}

const open = { book: '1', groupBy: '1', firstRank: 0, endRank: 20, layout: LAYOUT, around: null };

test('opening a world opens its overview, its kinds and the last change in the same answer, at the range asked for', async () => {
    const w = world(1000);
    expect(await w.view<OverviewView>(OVERVIEW_VIEW)).toEqual({
        book: null,
        groupBy: null,
        topLevelCount: 0,
        firstRank: 0,
        entries: [],
        stepLanding: null,
    });
    expect(await w.act('worldbuilding.openOverview', open)).toEqual({
        changed: [],
        opensViews: [OVERVIEW_VIEW, RELATION_KINDS_VIEW, LAST_CHANGE_VIEW],
    });
    const shown = await w.view<OverviewView>(OVERVIEW_VIEW);
    expect(shown).toMatchObject({ book: '1', groupBy: '1', topLevelCount: 1000, firstRank: 0, stepLanding: null });
    expect(shown.entries.map((i) => i.topLevelRank)).toEqual([...Array(20).keys()]);
    expect(w.asked.overview[0]).toMatchObject({ layout: LAYOUT });
    expect(await w.view<RelationKindsView>(RELATION_KINDS_VIEW)).toEqual({
        book: '1',
        kinds: [{ id: '1', name: 'in' }],
    });
    expect(w.asked.step).toEqual([]);
});

test('opening around an occurrence puts the range around its top-level entry and marks where it landed', async () => {
    const w = world(1000);
    await w.act('worldbuilding.openOverview', { ...open, around: '600/7/+' });
    expect(w.asked.step).toEqual([{ book: '1', groupBy: '1', from: '600/7/+', by: 0 }]);
    const shown = await w.view<OverviewView>(OVERVIEW_VIEW);
    expect(shown.firstRank).toBe(490);
    expect(shown.entries).toHaveLength(20);
    expect(shown.stepLanding).toEqual({ occurrence: '600', topLevelRank: 500 });
});

test('showing a range reads it; nothing is shown before a world is opened', async () => {
    const w = world(1000);
    expect(await w.act('worldbuilding.showRange', { firstRank: 40, endRank: 60 })).toEqual({
        refused: 'No world is shown.',
    });
    await w.act('worldbuilding.openOverview', { ...open, groupBy: null });
    expect(await w.act('worldbuilding.showRange', { firstRank: 40, endRank: 60 })).toEqual({
        changed: [OVERVIEW_VIEW],
    });
    const shown = await w.view<OverviewView>(OVERVIEW_VIEW);
    expect([shown.firstRank, shown.entries[0]?.topLevelRank, shown.groupBy]).toEqual([40, 40, null]);
});

test('a step lands where the store says, keeps the range when that is in it and follows it when it is not', async () => {
    const w = world(1000);
    await w.act('worldbuilding.openOverview', open);
    await w.act('worldbuilding.stepOverview', { from: '105', by: 1 });
    let shown = await w.view<OverviewView>(OVERVIEW_VIEW);
    expect([shown.firstRank, shown.stepLanding]).toEqual([0, { occurrence: '106', topLevelRank: 6 }]);
    await w.act('worldbuilding.stepOverview', { from: '106', by: 100 });
    shown = await w.view<OverviewView>(OVERVIEW_VIEW);
    expect([shown.firstRank, shown.stepLanding]).toEqual([96, { occurrence: '206', topLevelRank: 106 }]);
    await w.act('worldbuilding.stepOverview', { from: '206/3', to: 'parent' });
    expect(w.asked.step.at(-1)).toEqual({ book: '1', groupBy: '1', from: '206/3', to: 'parent' });
    expect((await w.view<OverviewView>(OVERVIEW_VIEW)).stepLanding).toEqual({ occurrence: '206', topLevelRank: 106 });
    expect(await w.act('worldbuilding.stepOverview', { from: '5000', by: 1 })).toEqual({
        refused: 'That is no longer shown.',
        changed: [OVERVIEW_VIEW],
    });
});

test("a world the store can't read shows nothing", async () => {
    const w = world(3);
    await w.act('worldbuilding.openOverview', { ...open, book: '2' });
    expect(await w.view<OverviewView>(OVERVIEW_VIEW)).toMatchObject({ book: null, entries: [] });
    expect(await w.view<RelationKindsView>(RELATION_KINDS_VIEW)).toEqual({ book: null, kinds: [] });
});

test('kind actions name their world: making one says which it made, renaming answers the kinds and the overview, an unused one is deleted', async () => {
    const w = world(3);
    expect(await w.act('worldbuilding.createRelationKind', { book: '2', name: 'In' })).toEqual({
        refused: 'That world no longer exists.',
    });
    expect(await w.act('worldbuilding.showRelationKinds', { book: '1' })).toEqual({
        changed: [],
        opensViews: [RELATION_KINDS_VIEW, LAST_CHANGE_VIEW],
    });
    expect(await w.act('worldbuilding.createRelationKind', { book: '1', name: 'In' })).toEqual({
        changed: [RELATION_KINDS_VIEW, LAST_CHANGE_VIEW],
    });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        createdKind: { book: '1', kind: '2' },
        changedRelation: null,
        unreachedLoops: [],
    });
    expect((await w.view<RelationKindsView>(RELATION_KINDS_VIEW)).kinds).toEqual([
        { id: '1', name: 'in' },
        { id: '2', name: 'In' },
    ]);
    expect(await w.act('worldbuilding.renameRelationKind', { book: '1', kind: '1', name: 'inside' })).toEqual({
        changed: [RELATION_KINDS_VIEW, OVERVIEW_VIEW],
    });
    expect(await w.act('worldbuilding.renameRelationKind', { book: '1', kind: '9', name: 'x' })).toMatchObject({
        refused: 'This world has no such relation kind.',
    });
    expect(await w.act('worldbuilding.deleteRelationKind', { book: '1', kind: '1' })).toEqual({
        refused: 'Relations of this kind still exist.',
    });
    expect(await w.act('worldbuilding.deleteRelationKind', { book: '1', kind: '2' })).toEqual({
        changed: [RELATION_KINDS_VIEW],
    });
});

test('a relation change names its world, passes the session and the loop check limit, and its answer names unreached loops', async () => {
    const w = world(3);
    const add = {
        book: '1',
        entry: '7',
        kind: '1',
        target: '8',
        after: null,
        before: null,
        weak: false,
        loopCheckLimit: 500,
    };
    expect(await w.act('worldbuilding.addRelation', add)).toEqual({ changed: [OVERVIEW_VIEW, LAST_CHANGE_VIEW] });
    expect(w.asked.changes[0]).toEqual({
        book: '1',
        change: { change: 'add', entry: '7', kind: '1', target: '8', after: null, before: null, weak: false },
        loopCheckLimit: 500,
        session: 's',
    });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        createdKind: null,
        changedRelation: { book: '1', entry: '7', kind: '1', target: '8' },
        unreachedLoops: [{ entry: '7', kind: '1', entries: ['7', '8'] }],
    });
    await w.act('worldbuilding.setRelationWeak', {
        book: '1',
        entry: '7',
        kind: '1',
        target: '8',
        weak: true,
        loopCheckLimit: 500,
    });
    await w.act('worldbuilding.moveRelation', {
        book: '1',
        entry: '3',
        kind: '1',
        target: '8',
        newTarget: '9',
        after: '4',
        before: null,
        loopCheckLimit: 10,
    });
    expect(w.asked.changes.map((c) => c.change.change)).toEqual(['add', 'setWeak', 'move']);
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        createdKind: null,
        changedRelation: { book: '1', entry: '3', kind: '1', target: '9' },
        unreachedLoops: [],
    });
    expect(
        await w.act('worldbuilding.removeRelation', {
            book: '1',
            entry: '3',
            kind: '1',
            target: '999',
            loopCheckLimit: 10,
        }),
    ).toEqual({ refused: "The target isn't an entry of this world." });
});

test('showing a range or stepping that would draw more than one read may is refused', async () => {
    const w = world(100_000);
    const wide = { regionsByNestingLevel: [{ columns: 10, rows: 10 }], cardTextCharacters: 100 };
    await w.act('worldbuilding.openOverview', { ...open, layout: wide, endRank: 10 });
    expect(await w.act('worldbuilding.showRange', { firstRank: 0, endRank: 40 })).toEqual({ refused: READ_REFUSAL });
    expect(await w.act('worldbuilding.showRange', { firstRank: 0, endRank: 39 })).toEqual({ changed: [OVERVIEW_VIEW] });
    expect(await w.act('worldbuilding.stepOverview', { from: '100', by: 39 })).toEqual({ refused: READ_REFUSAL });
});

test('the schemas bound a read by the cards it draws, and take worlds and kinds by id', () => {
    const ok = (type: keyof typeof actions, payload: unknown) => v.safeParse(actions[type], payload).success;
    expect(ok('worldbuilding.openOverview', open)).toBe(true);
    expect(ok('worldbuilding.openOverview', { ...open, endRank: Math.floor(MAX_CARDS_PER_READ / 7) })).toBe(true);
    expect(ok('worldbuilding.openOverview', { ...open, endRank: Math.floor(MAX_CARDS_PER_READ / 7) + 1 })).toBe(false);
    expect(ok('worldbuilding.openOverview', { ...open, groupBy: 'in' })).toBe(false);
    expect(ok('worldbuilding.openOverview', { ...open, around: '12/34/+' })).toBe(true);
    expect(ok('worldbuilding.openOverview', { ...open, around: '12/+/3' })).toBe(false);
    const deep = {
        regionsByNestingLevel: [
            { columns: 4, rows: 2 },
            { columns: 4, rows: 2 },
        ],
        cardTextCharacters: 100_000,
    };
    expect(cardsPerTopLevelEntry(deep.regionsByNestingLevel)).toBe(1 + 8 + 64);
    expect(ok('worldbuilding.openOverview', { ...open, layout: deep, endRank: 54 })).toBe(true);
    expect(ok('worldbuilding.openOverview', { ...open, layout: deep, endRank: 55 })).toBe(false);
    const huge = { regionsByNestingLevel: Array(30).fill({ columns: 1000, rows: 1000 }), cardTextCharacters: 0 };
    expect(ok('worldbuilding.openOverview', { ...open, layout: huge, endRank: 0 })).toBe(true);
    expect(ok('worldbuilding.openOverview', { ...open, layout: huge, endRank: 1 })).toBe(false);
    expect(
        ok('worldbuilding.openOverview', {
            ...open,
            layout: { ...LAYOUT, regionsByNestingLevel: [{ columns: 0, rows: 1 }] },
        }),
    ).toBe(false);
    expect(ok('worldbuilding.showRange', { firstRank: 30, endRank: 10 })).toBe(false);
    expect(ok('worldbuilding.stepOverview', { from: null, by: -1 })).toBe(true);
    expect(ok('worldbuilding.stepOverview', { from: null, to: 'parent' })).toBe(false);
    expect(ok('worldbuilding.stepOverview', { from: '1', to: 'sibling' })).toBe(false);
    expect(ok('worldbuilding.stepOverview', { from: '1', by: 0.5 })).toBe(false);
    expect(ok('worldbuilding.createRelationKind', { book: '1', name: '  ' })).toBe(false);
    expect(ok('worldbuilding.createRelationKind', { name: 'in' })).toBe(false);
    const add = {
        book: '1',
        entry: '7',
        kind: '1',
        target: '8',
        after: null,
        before: null,
        weak: false,
        loopCheckLimit: 500,
    };
    expect(ok('worldbuilding.addRelation', add)).toBe(true);
    expect(ok('worldbuilding.addRelation', { ...add, kind: 'in' })).toBe(false);
    expect(ok('worldbuilding.addRelation', { ...add, loopCheckLimit: 0 })).toBe(false);
    expect(ok('worldbuilding.addRelation', { ...add, loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE + 1 })).toBe(false);
    const { book: _, ...withoutWorld } = add;
    expect(ok('worldbuilding.addRelation', withoutWorld)).toBe(false);
});

test('a range follows a rank by keeping its width', () => {
    expect(rangeAround(5, 0, 20)).toEqual({ firstRank: 0, endRank: 20 });
    expect(rangeAround(20, 0, 20)).toEqual({ firstRank: 10, endRank: 30 });
    expect(rangeAround(3, 40, 60)).toEqual({ firstRank: 0, endRank: 20 });
});
