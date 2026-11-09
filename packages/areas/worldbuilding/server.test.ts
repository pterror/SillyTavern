import * as v from 'valibot';
import { expect, test } from 'vite-plus/test';
import {
    actions,
    cardsPerTopLevelEntry,
    ENTRY_VIEW,
    LAST_CHANGE_VIEW,
    LOOP_CHECK_VISITS_PER_WRITE,
    LOOPS_LEFT_BY_JOBS_VIEW,
    MAX_CARDS_PER_READ,
    OVERVIEW_VIEW,
    placementFields,
    READ_REFUSAL,
    RELATION_KINDS_VIEW,
} from './protocol.ts';
import type {
    EntryCell,
    EntryView,
    LastChangeView,
    Named,
    OpenEntryView,
    LoopsLeftByJobsView,
    OverviewLayout,
    OverviewView,
    RelationKindsView,
} from './protocol.ts';
import { rangeAround, worldbuildingArea } from './server.ts';
import type { EntryCreation, EntryEdit, EntryRead, Grouping, OverviewStep, Ports, RelationChange } from './server.ts';
import type { ActionContext, ActionResult, User } from '@st/server-ui';

const user: User = { handle: 'u', directories: { root: '/u' } };

const NOTHING_CHANGED: LastChangeView = {
    createdKind: null,
    changedRelation: null,
    createdEntry: null,
    deletedEntry: null,
    movedEntry: null,
    unreachedLoops: [],
};

const named = (thing: string, text: string): Named => ({ thing, text, shownAs: 'name' });

const PLACEMENT = v.parse(v.object(placementFields), {
    keysecondary: [],
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: false,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
    characterFilter: { isExclude: false, names: [], tags: [] },
});

const LAYOUT: OverviewLayout = { regionsByNestingLevel: [{ columns: 3, rows: 2 }], cardTextCharacters: 300 };

const card = (occurrence: string, topLevelRank: number): EntryCell & { topLevelRank: number } => ({
    cell: 'entry',
    occurrence,
    entry: occurrence,
    entryKey: occurrence,
    label: { thing: occurrence, text: '', shownAs: 'opening' },
    title: null,
    text: '',
    textCut: false,
    keys: [],
    names: [],
    relations: [],
    groupingKindRelationsTargetingThis: 0,
    alreadyOpenAbove: false,
    region: [],
    topLevelRank,
});

function world(count: number) {
    const asked: {
        overview: unknown[];
        step: (Grouping & OverviewStep)[];
        changes: { book: string; change: RelationChange; loopCheckLimit: number; session: string }[];
        edits: { book: string; entry: string; edit: EntryEdit; session: string }[];
        created: { book: string; creation: EntryCreation; loopCheckLimit: number }[];
        entryReads: { book: string; entry: string; mentionPages: string[] }[];
        deleted: string[];
        restored: string[];
        moved: { entry: string; toBook: string }[];
    } = {
        overview: [],
        step: [],
        changes: [],
        edits: [],
        created: [],
        entryReads: [],
        deleted: [],
        restored: [],
        moved: [],
    };
    const entries = new Map<string, { text: string; deleted: boolean }>([
        ['7', { text: 'Ilse keeps the lamp.', deleted: false }],
        ['8', { text: 'The Lantern House', deleted: false }],
    ]);
    let nextEntry = 50;
    const entryRead = (entry: string, mentionPages: string[]): EntryRead => {
        const found = entries.get(entry);
        if (!found) return null;
        if (found.deleted) return { deleted: true };
        return {
            deleted: false,
            entryKey: entry,
            label: named(entry, `name ${entry}`),
            title: null,
            keys: [{ text: `name ${entry}`, isName: true, alsoBringsUp: 0 }],
            text: found.text,
            relations: [],
            placement: PLACEMENT,
            placementDiffersFromDefaults: false,
            tokens: found.text.length,
            mentionedIn: {
                entries: [
                    { from: named('8', 'name 8'), sentence: { before: '', mention: 'Ilse', after: ' keeps.' } },
                    ...mentionPages.map((cursor) => ({
                        from: named(cursor, `name ${cursor}`),
                        sentence: { before: 'Then ', mention: 'Ilse', after: '.' },
                    })),
                ],
                next: mentionPages.length < 2 ? `p${mentionPages.length + 1}` : null,
            },
        };
    };
    const kinds: { id: string; name: string; mergingInto: string | null }[] = [
        { id: '1', name: 'in', mergingInto: null },
    ];
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
        readLoopsLeftByJobs: async (_u, book) => (book === '1' ? [{ entry: '7', kind: '1', entries: ['7', '8'] }] : []),
        createRelationKind: async (_w, book, name) => {
            if (book !== '1') return null;
            kinds.push({ id: String(kinds.length + 1), name, mergingInto: null });
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
        mergeRelationKind: async (_w, _b, kind, into) => {
            if (kind === into) return 'same kind';
            const merged = kinds.find((existing) => existing.id === kind);
            if (!merged || !kinds.some((existing) => existing.id === into)) return 'no kind';
            if (merged.mergingInto !== null) return 'being merged';
            merged.mergingInto = into;
            return 'ok';
        },
        readEntry: async (_u, book, entry, mentionPages) => {
            asked.entryReads.push({ book, entry, mentionPages });
            return book === '1' ? entryRead(entry, mentionPages) : null;
        },
        editEntry: async ({ session }, book, entry, edit) => {
            asked.edits.push({ book, entry, edit, session });
            if (book !== '1') return 'missing';
            const found = entries.get(entry);
            if (!found || found.deleted) return 'no entry';
            if (edit.change === 'setKeyAs' && edit.key !== `name ${entry}`)
                return { refused: 'That entry has no such key.' };
            if (edit.change === 'text') found.text = edit.text;
            return 'ok';
        },
        createEntry: async (_w, book, creation, loopCheckLimit) => {
            asked.created.push({ book, creation, loopCheckLimit });
            if (book !== '1') return 'missing';
            if (creation.relation?.target === '999') return { refused: "The target isn't an entry of this world." };
            const entry = String(nextEntry++);
            entries.set(entry, { text: '', deleted: false });
            return {
                entry,
                unreachedLoops: creation.relation ? [{ entry, kind: creation.relation.kind, entries: [entry] }] : [],
            };
        },
        deleteEntry: async (_w, book, entry) => {
            asked.deleted.push(entry);
            if (book !== '1') return 'missing';
            const found = entries.get(entry);
            if (!found || found.deleted) return 'no entry';
            found.deleted = true;
            return { label: named(entry, `name ${entry}`), unreachedLoops: [] };
        },
        restoreEntry: async (_w, book, entry) => {
            asked.restored.push(entry);
            const found = entries.get(entry);
            if (book !== '1') return 'missing';
            if (found?.deleted !== true) return 'no entry';
            found.deleted = false;
            return { unreachedLoops: [{ entry, kind: '1', entries: [entry, '8'] }] };
        },
        moveEntryToWorld: async (_w, book, entry, toBook) => {
            asked.moved.push({ entry, toBook });
            if (toBook === '3') return { refused: 'The world to move it to no longer exists.' };
            if (book !== '1' || !entries.has(entry)) return 'no entry';
            entries.delete(entry);
            return { entry: '90', unreachedLoops: [] };
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
    const parsed = (type: string, payload: unknown) =>
        v.parse(actions[type as keyof typeof actions] as v.GenericSchema, payload);
    const act = (type: string, payload: unknown): Promise<ActionResult> =>
        area.actions[type]!(context, parsed(type, payload));
    const other = (type: string, payload: unknown): Promise<ActionResult> =>
        area.actions[type]!({ ...context, session: 't' }, parsed(type, payload));
    return { view, act, other, asked };
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
        opensViews: [OVERVIEW_VIEW, RELATION_KINDS_VIEW, LAST_CHANGE_VIEW, LOOPS_LEFT_BY_JOBS_VIEW],
    });
    expect(await w.view<LoopsLeftByJobsView>(LOOPS_LEFT_BY_JOBS_VIEW)).toEqual({
        book: '1',
        unreachedLoops: [{ entry: '7', kind: '1', entries: ['7', '8'] }],
    });
    const shown = await w.view<OverviewView>(OVERVIEW_VIEW);
    expect(shown).toMatchObject({ book: '1', groupBy: '1', topLevelCount: 1000, firstRank: 0, stepLanding: null });
    expect(shown.entries.map((i) => i.topLevelRank)).toEqual([...Array(20).keys()]);
    expect(w.asked.overview[0]).toMatchObject({ layout: LAYOUT });
    expect(await w.view<RelationKindsView>(RELATION_KINDS_VIEW)).toEqual({
        book: '1',
        kinds: [{ id: '1', name: 'in', mergingInto: null }],
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
        ...NOTHING_CHANGED,
        createdKind: { book: '1', kind: '2' },
    });
    expect((await w.view<RelationKindsView>(RELATION_KINDS_VIEW)).kinds).toEqual([
        { id: '1', name: 'in', mergingInto: null },
        { id: '2', name: 'In', mergingInto: null },
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
    expect(await w.act('worldbuilding.mergeRelationKind', { book: '1', kind: '2', into: '2' })).toEqual({
        refused: 'A kind is merged into another kind.',
    });
    expect(await w.act('worldbuilding.mergeRelationKind', { book: '1', kind: '2', into: '1' })).toEqual({
        changed: [RELATION_KINDS_VIEW, OVERVIEW_VIEW],
    });
    expect((await w.view<RelationKindsView>(RELATION_KINDS_VIEW)).kinds[1]).toEqual({
        id: '2',
        name: 'In',
        mergingInto: '1',
    });
    expect(await w.act('worldbuilding.mergeRelationKind', { book: '1', kind: '2', into: '1' })).toEqual({
        refused: 'That kind is being merged, or another kind is being merged into it.',
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
    expect(await w.act('worldbuilding.addRelation', add)).toEqual({
        changed: [OVERVIEW_VIEW, ENTRY_VIEW, LAST_CHANGE_VIEW],
    });
    expect(w.asked.changes[0]).toEqual({
        book: '1',
        change: { change: 'add', entry: '7', kind: '1', target: '8', after: null, before: null, weak: false },
        loopCheckLimit: 500,
        session: 's',
    });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        ...NOTHING_CHANGED,
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
        ...NOTHING_CHANGED,
        changedRelation: { book: '1', entry: '3', kind: '1', target: '9' },
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
    const fits = Math.floor(MAX_CARDS_PER_READ / 101);
    expect(await w.act('worldbuilding.showRange', { firstRank: 0, endRank: fits + 1 })).toEqual({
        refused: READ_REFUSAL,
    });
    expect(await w.act('worldbuilding.showRange', { firstRank: 0, endRank: fits })).toEqual({
        changed: [OVERVIEW_VIEW],
    });
    expect(await w.act('worldbuilding.stepOverview', { from: '100', by: fits })).toEqual({ refused: READ_REFUSAL });
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
    expect(
        ok('worldbuilding.openOverview', { ...open, layout: deep, endRank: Math.floor(MAX_CARDS_PER_READ / 73) }),
    ).toBe(true);
    expect(
        ok('worldbuilding.openOverview', { ...open, layout: deep, endRank: Math.floor(MAX_CARDS_PER_READ / 73) + 1 }),
    ).toBe(false);
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

const entryOpen = (view: EntryView): OpenEntryView => {
    if (view.book === null || view.deleted) throw new Error(`no open entry: ${JSON.stringify(view)}`);
    return view;
};

test('opening an entry opens its view: the entry, its keys, placement, tokens and the first page of what mentions it; more pages append; closing it shows none', async () => {
    const w = world(3);
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({ book: null });
    expect(await w.act('worldbuilding.openEntry', { book: '1', entry: '7' })).toEqual({
        changed: [],
        opensViews: [ENTRY_VIEW],
    });
    const shown = entryOpen(await w.view<EntryView>(ENTRY_VIEW));
    expect(shown).toMatchObject({ book: '1', entry: '7', deleted: false, label: named('7', 'name 7'), tokens: 20 });
    expect(shown.mentionedIn.entries.map((m) => m.from.thing)).toEqual(['8']);
    expect(shown.mentionedIn.next).toBe('p1');
    expect(await w.act('worldbuilding.showMoreMentions', { cursor: 'p1' })).toEqual({ changed: [ENTRY_VIEW] });
    await w.act('worldbuilding.showMoreMentions', { cursor: 'p1' });
    await w.act('worldbuilding.showMoreMentions', { cursor: 'p2' });
    const more = entryOpen(await w.view<EntryView>(ENTRY_VIEW));
    expect(more.mentionedIn.entries.map((m) => m.from.thing)).toEqual(['8', 'p1', 'p2']);
    expect(more.mentionedIn.next).toBeNull();
    expect(w.asked.entryReads.at(-1)).toEqual({ book: '1', entry: '7', mentionPages: ['p1', 'p2'] });
    await w.act('worldbuilding.openEntry', { book: '1', entry: '8' });
    expect(w.asked.entryReads.length).toBe(2);
    expect(entryOpen(await w.view<EntryView>(ENTRY_VIEW)).mentionedIn.entries).toHaveLength(1);
    expect(await w.act('worldbuilding.closeEntry', {})).toEqual({ changed: [ENTRY_VIEW] });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({ book: null });
    expect(await w.act('worldbuilding.showMoreMentions', { cursor: 'p1' })).toEqual({ refused: 'No entry is open.' });
    await w.act('worldbuilding.openEntry', { book: '1', entry: '404' });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({ book: null });
});

test('an edit names its world and entry, passes the session, answers the entry and the overview, and says why it is refused', async () => {
    const w = world(3);
    await w.act('worldbuilding.openEntry', { book: '1', entry: '7' });
    const both = { changed: [OVERVIEW_VIEW, ENTRY_VIEW] };
    expect(await w.act('worldbuilding.setEntryText', { book: '1', entry: '7', text: 'Ilse left.' })).toEqual(both);
    expect(entryOpen(await w.view<EntryView>(ENTRY_VIEW)).text).toBe('Ilse left.');
    expect(await w.act('worldbuilding.setEntryTitle', { book: '1', entry: '7', title: '' })).toEqual(both);
    expect(await w.act('worldbuilding.addKey', { book: '1', entry: '8', key: ' lamp ', as: 'trigger' })).toEqual(both);
    expect(await w.act('worldbuilding.setKeyAs', { book: '1', entry: '7', key: 'name 7', as: 'trigger' })).toEqual(
        both,
    );
    expect(await w.act('worldbuilding.setKeyAs', { book: '1', entry: '7', key: 'x', as: 'name' })).toEqual({
        refused: 'That entry has no such key.',
    });
    expect(await w.act('worldbuilding.removeKey', { book: '1', entry: '7', key: 'name 7' })).toEqual(both);
    expect(await w.act('worldbuilding.setPlacement', { book: '1', entry: '7', fields: { depth: 2, role: 1 } })).toEqual(
        both,
    );
    expect(await w.act('worldbuilding.setEntryText', { book: '1', entry: '404', text: '' })).toEqual({
        refused: "That entry isn't in this world.",
        changed: [OVERVIEW_VIEW, ENTRY_VIEW],
    });
    expect(await w.act('worldbuilding.setEntryText', { book: '2', entry: '7', text: '' })).toEqual({
        refused: 'That world no longer exists.',
    });
    expect(w.asked.edits.map(({ edit }) => edit)).toEqual([
        { change: 'text', text: 'Ilse left.' },
        { change: 'title', title: '' },
        { change: 'addKey', key: 'lamp', as: 'trigger' },
        { change: 'setKeyAs', key: 'name 7', as: 'trigger' },
        { change: 'setKeyAs', key: 'x', as: 'name' },
        { change: 'removeKey', key: 'name 7' },
        { change: 'placement', fields: { depth: 2, role: 1 } },
        { change: 'text', text: '' },
        { change: 'text', text: '' },
    ]);
    expect(w.asked.edits[0]).toMatchObject({ book: '1', entry: '7', session: 's' });
});

test('making an entry places it, opens it when asked and says what it made and which loops it left; a refused one changes nothing', async () => {
    const w = world(3);
    const make = { book: '1', after: '7', name: 'Saltmarrow', relation: null, open: true, loopCheckLimit: 300 };
    expect(await w.act('worldbuilding.createEntry', make)).toEqual({
        changed: [OVERVIEW_VIEW, LAST_CHANGE_VIEW],
        opensViews: [ENTRY_VIEW],
    });
    expect(w.asked.created[0]).toEqual({
        book: '1',
        creation: { after: '7', name: 'Saltmarrow', relation: null },
        loopCheckLimit: 300,
    });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toMatchObject({ book: '1', entry: '50' });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        ...NOTHING_CHANGED,
        createdEntry: { book: '1', entry: '50' },
    });
    const related = { ...make, after: null, name: null, relation: { kind: '1', target: '8' }, open: false };
    expect(await w.act('worldbuilding.createEntry', related)).toEqual({
        changed: [OVERVIEW_VIEW, ENTRY_VIEW, LAST_CHANGE_VIEW],
    });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toMatchObject({ entry: '50' });
    expect((await w.view<LastChangeView>(LAST_CHANGE_VIEW)).unreachedLoops).toEqual([
        { entry: '51', kind: '1', entries: ['51'] },
    ]);
    expect(await w.act('worldbuilding.createEntry', { ...related, relation: { kind: '1', target: '999' } })).toEqual({
        refused: "The target isn't an entry of this world.",
    });
    expect(await w.act('worldbuilding.createEntry', { ...make, book: '2' })).toEqual({
        refused: 'That world no longer exists.',
    });
});

test('deleting the open entry shows it deleted under its label and offers it back; restoring shows it again with the loops it left', async () => {
    const w = world(3);
    await w.act('worldbuilding.openEntry', { book: '1', entry: '7' });
    const all = { changed: [OVERVIEW_VIEW, ENTRY_VIEW, LAST_CHANGE_VIEW] };
    expect(await w.act('worldbuilding.deleteEntry', { book: '1', entry: '7' })).toEqual(all);
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({
        book: '1',
        entry: '7',
        deleted: true,
        label: named('7', 'name 7'),
    });
    expect((await w.view<LastChangeView>(LAST_CHANGE_VIEW)).deletedEntry).toEqual({
        book: '1',
        entry: '7',
        label: named('7', 'name 7'),
    });
    expect(await w.act('worldbuilding.deleteEntry', { book: '1', entry: '7' })).toEqual({
        refused: "That entry isn't in this world.",
        changed: [OVERVIEW_VIEW, ENTRY_VIEW],
    });
    expect(await w.act('worldbuilding.restoreEntry', { book: '1', entry: '7' })).toEqual(all);
    expect(entryOpen(await w.view<EntryView>(ENTRY_VIEW)).entry).toBe('7');
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        ...NOTHING_CHANGED,
        unreachedLoops: [{ entry: '7', kind: '1', entries: ['7', '8'] }],
    });
    expect(await w.act('worldbuilding.restoreEntry', { book: '1', entry: '7' })).toMatchObject({
        refused: "That entry isn't in this world.",
    });
});

test('an entry deleted elsewhere shows deleted under the label it was last shown with', async () => {
    const w = world(3);
    await w.act('worldbuilding.openEntry', { book: '1', entry: '8' });
    await w.view<EntryView>(ENTRY_VIEW);
    await w.other('worldbuilding.deleteEntry', { book: '1', entry: '8' });
    expect(await w.view<EntryView>(ENTRY_VIEW)).toEqual({
        book: '1',
        entry: '8',
        deleted: true,
        label: named('8', 'name 8'),
    });
});

test('moving the open entry to another world follows it there; the same world or a missing one is refused', async () => {
    const w = world(3);
    await w.act('worldbuilding.openEntry', { book: '1', entry: '7' });
    expect(await w.act('worldbuilding.moveEntryToWorld', { book: '1', entry: '7', toBook: '1' })).toEqual({
        refused: 'The entry is in that world already.',
    });
    expect(await w.act('worldbuilding.moveEntryToWorld', { book: '1', entry: '7', toBook: '3' })).toEqual({
        refused: 'The world to move it to no longer exists.',
    });
    expect(await w.act('worldbuilding.moveEntryToWorld', { book: '1', entry: '7', toBook: '2' })).toEqual({
        changed: [OVERVIEW_VIEW, ENTRY_VIEW, LAST_CHANGE_VIEW],
    });
    expect(await w.view<LastChangeView>(LAST_CHANGE_VIEW)).toEqual({
        ...NOTHING_CHANGED,
        movedEntry: { book: '1', entry: '7', toBook: '2', newEntry: '90' },
    });
    expect(w.asked.entryReads).toEqual([]);
    await w.view<EntryView>(ENTRY_VIEW);
    expect(w.asked.entryReads).toEqual([{ book: '2', entry: '90', mentionPages: [] }]);
});

test('the entry schemas take worlds and entries by id, keys trimmed and not empty, and placement fields each by its own type and range', () => {
    const ok = (type: keyof typeof actions, payload: unknown) => v.safeParse(actions[type], payload).success;
    const at = { book: '1', entry: '7' };
    expect(ok('worldbuilding.openEntry', at)).toBe(true);
    expect(ok('worldbuilding.openEntry', { book: '1', entry: 'seven' })).toBe(false);
    expect(ok('worldbuilding.addKey', { ...at, key: '  ', as: 'name' })).toBe(false);
    expect(ok('worldbuilding.addKey', { ...at, key: 'Ilse', as: 'title' })).toBe(false);
    expect(ok('worldbuilding.setKeyAs', { ...at, key: 'Ilse', as: 'trigger' })).toBe(true);
    expect(ok('worldbuilding.setEntryTitle', { ...at, title: '' })).toBe(true);
    const placing = (fields: unknown) => ok('worldbuilding.setPlacement', { ...at, fields });
    expect(placing(PLACEMENT)).toBe(true);
    expect(placing({})).toBe(false);
    expect(placing({ probability: 101 })).toBe(false);
    expect(placing({ probability: 12.5 })).toBe(true);
    expect(placing({ depth: -1 })).toBe(false);
    expect(placing({ depth: 1001 })).toBe(false);
    expect(placing({ position: 8 })).toBe(false);
    expect(placing({ role: 2, selectiveLogic: 3 })).toBe(true);
    expect(placing({ groupWeight: 0 })).toBe(false);
    expect(placing({ scanDepth: null, sticky: 3, delay: null })).toBe(true);
    expect(placing({ sticky: 1.5 })).toBe(false);
    expect(placing({ delayUntilRecursion: true })).toBe(true);
    expect(placing({ delayUntilRecursion: 2 })).toBe(true);
    expect(placing({ triggers: ['normal', 'swipe'] })).toBe(true);
    expect(placing({ triggers: ['dream'] })).toBe(false);
    expect(placing({ characterFilter: { isExclude: true, names: ['a.png'], tags: [] } })).toBe(true);
    expect(placing({ key: ['Ilse'] })).toBe(false);
    expect(placing({ content: 'x' })).toBe(false);
    const make = { book: '1', after: null, name: null, relation: null, open: true, loopCheckLimit: 10 };
    expect(ok('worldbuilding.createEntry', make)).toBe(true);
    expect(ok('worldbuilding.createEntry', { ...make, name: ' ' })).toBe(false);
    expect(ok('worldbuilding.createEntry', { ...make, relation: { kind: 'in', target: '8' } })).toBe(false);
    expect(ok('worldbuilding.createEntry', { ...make, loopCheckLimit: 0 })).toBe(false);
    expect(ok('worldbuilding.moveEntryToWorld', { ...at, toBook: '2' })).toBe(true);
    expect(ok('worldbuilding.showMoreMentions', { cursor: '' })).toBe(false);
});
