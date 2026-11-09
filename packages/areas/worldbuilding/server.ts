import {
    actions,
    BULK_JOBS_VIEW,
    cardsPerTopLevelEntry,
    ENTRY_VIEW,
    FOUND_PER_QUERY,
    FOUND_VIEW,
    LAST_CHANGE_VIEW,
    LOOPS_LEFT_BY_JOBS_VIEW,
    MAX_CARDS_PER_READ,
    OVERVIEW_VIEW,
    POINTING_AT_VIEW,
    READ_REFUSAL,
    readFitsTheBudget,
    RELATION_KINDS_VIEW,
    RESULTS_VIEW,
    PICKED_AT_MOST,
    SELECTION_VIEW,
    WORLD_VIEW,
    WORLDS_VIEW,
} from './protocol.ts';
import type {
    BulkAction,
    BulkJob,
    BulkJobsView,
    Chip,
    EntryCell,
    FoundView,
    ResultsView,
    EntryView,
    ExportedWorld,
    World,
    WorldsView,
    WorldView,
    LastChangeView,
    LoopsLeftByJobsView,
    MentionedIn,
    NamesOffer,
    Named,
    OpenEntryView,
    Placement,
    OverviewLayout,
    OverviewView,
    PointingAtSection,
    PointingAtShown,
    PointingAtView,
    RelationKind,
    RelationKindsView,
    SelectionView,
    StepLanding,
    UnreachedLoop,
} from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { ActionContext, ActionResult, Upload, User, ViewContext } from '@st/server-ui';

export type Who = { user: User; session: string };

export type Grouping = { book: string; groupBy: string | null };

export type ShownOverview = Grouping & {
    firstRank: number;
    endRank: number;
    layout: OverviewLayout;
    stepLandedOn: string | null;
};

export type ShownWorld = Omit<ShownOverview, 'book' | 'stepLandedOn'> & { around: string | null };

export type OverviewStep = { from: string | null; by: number } | { from: string; to: 'parent' | 'firstChild' };

export type PointingAtRange = { kind: string; firstRank: number; endRank: number; stepLandedOn: string | null };

export type PointingAtQuery = {
    book: string;
    entry: string;
    layout: OverviewLayout;
    endRank: number;
    held: PointingAtRange[];
    maxCards: number;
};

export type RelationChange = { entry: string; kind: string; target: string } & (
    | { change: 'add'; weak: boolean; after: string | null; before: string | null }
    | { change: 'move'; newTarget: string; after: string | null; before: string | null }
    | { change: 'remove' }
    | { change: 'setWeak'; weak: boolean }
);

export type RelationChangeAnswer = { refused: string } | { unreachedLoops: UnreachedLoop[] } | 'missing';

export type EntryRead =
    | (Omit<OpenEntryView, 'book' | 'entry' | 'mentionedIn'> & { mentionedIn: MentionedIn })
    | { deleted: true }
    | null;

export type EntryEdit =
    | { change: 'text'; text: string }
    | { change: 'title'; title: string }
    | { change: 'addKey'; key: string; as: 'name' | 'trigger' }
    | { change: 'setKeyAs'; key: string; as: 'name' | 'trigger' }
    | { change: 'removeKey'; key: string }
    | { change: 'placement'; fields: Partial<Placement> };

export type EntryCreation = {
    after: string | null;
    name: string | null;
    relation: { kind: string; target: string } | null;
};

export type EntryWriteRefusal = 'missing' | 'no entry' | { refused: string };

export type NewWorld = { book: string } | { refused: string };

export type ResultsQuery = {
    book: string;
    groupBy: string | null;
    layout: OverviewLayout;
    query: string;
    chips: Chip[];
    pageSize: number;
    pages: (string | null)[];
};

export type ResultsRead = {
    chips: { kindName: string | null; target: Named | null }[];
    pages: { entries: EntryCell[]; next: string | null }[];
};

export type Found = { entries: Named[]; next: string | null };

export type NamesOfferChange = 'ok' | 'missing' | { refused: string };

// `filter` null: the whole world.
export type HeldSelection = {
    book: string;
    base: 'none' | 'matching';
    filter: { query: string; chips: Chip[] } | null;
    except: string[];
};

export type SelectionRead = Omit<Extract<SelectionView, { base: unknown }>, 'book' | 'base'>;

export type Ports = {
    readWorlds(user: User): Promise<World[]>;
    readWorld(user: User, book: string): Promise<(World & { namesOffer: NamesOffer | null }) | null>;
    openWorld(who: Who, book: string | null): Promise<string | null>;
    createWorld(who: Who, name: string): Promise<NewWorld>;
    renameWorld(who: Who, book: string, name: string): Promise<'ok' | 'missing' | { refused: string }>;
    duplicateWorld(who: Who, book: string): Promise<NewWorld | 'missing'>;
    deleteWorld(who: Who, book: string): Promise<'ok' | 'missing'>;
    importWorld(who: Who, file: Upload): Promise<NewWorld>;
    exportWorld(user: User, book: string): Promise<ExportedWorld | null>;
    setUsedInEveryChat(who: Who, book: string, used: boolean): Promise<'ok' | 'missing'>;
    markTitleKeysAsNames(who: Who, book: string): Promise<NamesOfferChange>;
    declineNamesOffer(who: Who, book: string): Promise<NamesOfferChange>;
    undoMarkTitleKeysAsNames(who: Who, book: string): Promise<NamesOfferChange>;
    readOverview(user: User, query: ShownOverview): Promise<Omit<OverviewView, 'book' | 'groupBy'> | null>;
    stepOverview(user: User, query: Grouping & { layout: OverviewLayout } & OverviewStep): Promise<StepLanding | null>;
    readPointingAt(user: User, query: PointingAtQuery): Promise<PointingAtSection[] | null>;
    stepPointingAt(
        user: User,
        query: { book: string; entry: string; kind: string; layout: OverviewLayout } & OverviewStep,
    ): Promise<StepLanding | null>;
    readRelationKinds(user: User, book: string): Promise<RelationKind[] | null>;
    labelEntries(user: User, book: string, entries: string[]): Promise<(Named | null)[]>;
    readResults(user: User, query: ResultsQuery): Promise<ResultsRead>;
    findEntries(user: User, query: { book: string; query: string; limit: number }): Promise<Found>;
    readLoopsLeftByJobs(user: User, book: string): Promise<UnreachedLoop[]>;
    readSelection(user: User, selection: HeldSelection): Promise<SelectionRead | null>;
    startBulk(
        who: Who,
        selection: HeldSelection,
        action: BulkAction,
        loopCheckLimit: number,
    ): Promise<{ unreachedLoops: UnreachedLoop[] } | 'missing' | { refused: string }>;
    readBulkJobs(user: User, book: string): Promise<BulkJob[] | null>;
    createRelationKind(who: Who, book: string, name: string): Promise<string | null>;
    renameRelationKind(who: Who, book: string, kind: string, name: string): Promise<'ok' | 'missing' | 'no kind'>;
    deleteRelationKind(
        who: Who,
        book: string,
        kind: string,
    ): Promise<'ok' | 'missing' | 'no kind' | 'in use' | 'being merged'>;
    mergeRelationKind(
        who: Who,
        book: string,
        kind: string,
        into: string,
    ): Promise<'ok' | 'missing' | 'no kind' | 'same kind' | 'being merged'>;
    changeRelation(
        who: Who,
        book: string,
        change: RelationChange,
        loopCheckLimit: number,
    ): Promise<RelationChangeAnswer>;
    readEntry(user: User, book: string, entry: string, mentionPages: string[]): Promise<EntryRead>;
    editEntry(who: Who, book: string, entry: string, edit: EntryEdit): Promise<'ok' | EntryWriteRefusal>;
    createEntry(
        who: Who,
        book: string,
        creation: EntryCreation,
        loopCheckLimit: number,
    ): Promise<{ entry: string; unreachedLoops: UnreachedLoop[] } | 'missing' | { refused: string }>;
    deleteEntry(
        who: Who,
        book: string,
        entry: string,
    ): Promise<{ label: Named; unreachedLoops: UnreachedLoop[] } | EntryWriteRefusal>;
    restoreEntry(
        who: Who,
        book: string,
        entry: string,
    ): Promise<{ unreachedLoops: UnreachedLoop[] } | EntryWriteRefusal>;
    moveEntryToWorld(
        who: Who,
        book: string,
        entry: string,
        toBook: string,
    ): Promise<{ entry: string; unreachedLoops: UnreachedLoop[] } | EntryWriteRefusal>;
};

const SESSIONS_REMEMBERED = 32;

const NO_OVERVIEW: OverviewView = {
    book: null,
    groupBy: null,
    topLevelCount: 0,
    firstRank: 0,
    entries: [],
    stepLanding: null,
};

const NOTHING_CHANGED: LastChangeView = {
    createdKind: null,
    changedRelation: null,
    createdEntry: null,
    deletedEntry: null,
    movedEntry: null,
    markedTitleKeys: null,
    unreachedLoops: [],
};

const NO_ENTRY: EntryView = { book: null };

const NOTHING_POINTED_AT: PointingAtView = { book: null };

// The views that show how many entries a world has; an action that adds or takes away an entry answers them all.
const VIEWS_COUNTING_ENTRIES = [OVERVIEW_VIEW, RESULTS_VIEW, FOUND_VIEW, WORLDS_VIEW, WORLD_VIEW, SELECTION_VIEW];

const VIEWS_OF_CARDS = [OVERVIEW_VIEW, RESULTS_VIEW, ENTRY_VIEW, POINTING_AT_VIEW, SELECTION_VIEW];

const NO_RESULTS: ResultsView = { book: null };

const NOTHING_FOUND: FoundView = { book: null };

const NO_WORLD: WorldView = { id: null };

const NOTHING_SELECTED: SelectionView = { book: null };

const NO_BULK_JOBS: BulkJobsView = { book: null };

const VIEWS_OF_A_WORLD = [
    OVERVIEW_VIEW,
    RELATION_KINDS_VIEW,
    LAST_CHANGE_VIEW,
    LOOPS_LEFT_BY_JOBS_VIEW,
    WORLD_VIEW,
    SELECTION_VIEW,
    BULK_JOBS_VIEW,
];

const NO_WORLD_SHOWN = 'No world is shown.';
const WORLD_GONE = 'That world no longer exists.';
const NO_SUCH_KIND = 'This world has no such relation kind.';
const BEING_MERGED = 'That kind is being merged, or another kind is being merged into it.';
const NO_SUCH_ENTRY = "That entry isn't in this world.";
const NO_ENTRY_OPEN = 'No entry is open.';
const NO_FILTER = 'Nothing is searched for.';
const NOT_SHOWN = "That world isn't shown.";
const NOTHING_SELECTED_REFUSAL = 'Nothing is selected.';
const TOO_MANY_PICKED = `At most ${PICKED_AT_MOST} entries are picked one at a time; select all matching instead.`;

export function rangeAround(rank: number, firstRank: number, endRank: number): { firstRank: number; endRank: number } {
    if (rank >= firstRank && rank < endRank) return { firstRank, endRank };
    const start = Math.max(0, rank - Math.floor((endRank - firstRank) / 2));
    return { firstRank: start, endRank: start + (endRank - firstRank) };
}

// `ranges` holds the sections' ranges the page asked for, the most recently asked first.
export type ShownPointingAt = PointingAtShown & { ranges: PointingAtRange[] };

export type OpenEntry = {
    book: string;
    entry: string;
    label: Named | null;
    mentionPages: string[];
    pointingAt: ShownPointingAt;
};

export type HeldChip = Chip & { label: Named };

// `pages` are the store's cursors of the pages held; the page sees each as `<generation>.<cursor>`, so a cursor of an
// earlier filter is never read under this one.
export type ShownFilter = {
    book: string;
    query: string;
    chips: HeldChip[];
    pageSize: number;
    generation: number;
    pages: (string | null)[];
};

type SessionState = {
    overview: ShownOverview | null;
    kindsOfBook: string | null;
    entry: OpenEntry | null;
    lastChange: LastChangeView;
    filter: ShownFilter | null;
    finding: { book: string; query: string } | null;
    selection: HeldSelection | null;
};

const NO_SESSION_STATE: SessionState = {
    overview: null,
    kindsOfBook: null,
    entry: null,
    lastChange: NOTHING_CHANGED,
    filter: null,
    finding: null,
    selection: null,
};

const opened = (book: string, entry: string, { endRank, layout }: PointingAtShown): OpenEntry => ({
    book,
    entry,
    label: null,
    mentionPages: [],
    pointingAt: { endRank, layout, ranges: [] },
});

const withRange = (shown: ShownPointingAt, range: PointingAtRange): ShownPointingAt => ({
    ...shown,
    ranges: [range, ...shown.ranges.filter((held) => held.kind !== range.kind)],
});

const heldRange = (shown: ShownPointingAt, kind: string): PointingAtRange =>
    shown.ranges.find((held) => held.kind === kind) ?? {
        kind,
        firstRank: 0,
        endRank: shown.endRank,
        stepLandedOn: null,
    };

export function worldbuildingArea(ports: Ports) {
    const bySession = new Map<string, SessionState>();
    let filtersSet = 0;

    const stateOf = (session: string) => bySession.get(session) ?? NO_SESSION_STATE;

    const remember = (session: string, change: Partial<SessionState>) => {
        const state = { ...stateOf(session), ...change };
        bySession.delete(session);
        bySession.set(session, state);
        for (const old of bySession.keys()) {
            if (bySession.size <= SESSIONS_REMEMBERED) break;
            bySession.delete(old);
        }
    };

    const withOverview =
        <P>(run: (context: ActionContext, overview: ShownOverview, payload: P) => Promise<ActionResult>) =>
        async (context: ActionContext, payload: P): Promise<ActionResult> => {
            const overview = stateOf(context.session).overview;
            return overview ? run(context, overview, payload) : { refused: NO_WORLD_SHOWN };
        };

    const who = (context: ActionContext): Who => ({ user: context.user, session: context.session });

    const relationChanged = async (
        context: ActionContext,
        { book, loopCheckLimit, ...change }: RelationChange & { book: string; loopCheckLimit: number },
    ): Promise<ActionResult> => {
        const answer = await ports.changeRelation(who(context), book, change, loopCheckLimit);
        if (answer === 'missing') return { refused: WORLD_GONE };
        if ('refused' in answer) return { refused: answer.refused };
        const target = change.change === 'move' ? change.newTarget : change.target;
        remember(context.session, {
            lastChange: {
                ...NOTHING_CHANGED,
                changedRelation: { book, entry: change.entry, kind: change.kind, target },
                unreachedLoops: answer.unreachedLoops,
            },
        });
        return { changed: [...VIEWS_OF_CARDS, LAST_CHANGE_VIEW] };
    };

    const refusedWrite = (refusal: EntryWriteRefusal): ActionResult => {
        if (refusal === 'missing') return { refused: WORLD_GONE };
        if (refusal === 'no entry') {
            return { refused: NO_SUCH_ENTRY, changed: [...VIEWS_OF_CARDS, FOUND_VIEW] };
        }
        return { refused: refusal.refused };
    };

    const entryEdited = async (
        context: ActionContext,
        book: string,
        entry: string,
        edit: EntryEdit,
    ): Promise<ActionResult> => {
        const done = await ports.editEntry(who(context), book, entry, edit);
        return done === 'ok' ? { changed: [...VIEWS_OF_CARDS, FOUND_VIEW] } : refusedWrite(done);
    };

    const readEntryView = async (context: ViewContext): Promise<EntryView> => {
        const shown = stateOf(context.session).entry;
        if (!shown) return NO_ENTRY;
        const read = await ports.readEntry(context.user, shown.book, shown.entry, shown.mentionPages);
        if (read === null) return NO_ENTRY;
        if (read.deleted) return { book: shown.book, entry: shown.entry, deleted: true, label: shown.label };
        const current = stateOf(context.session).entry;
        if (current?.book === shown.book && current.entry === shown.entry) {
            bySession.set(context.session, { ...stateOf(context.session), entry: { ...current, label: read.label } });
        }
        return { book: shown.book, entry: shown.entry, ...read };
    };

    const readPointingAtView = async (context: ViewContext): Promise<PointingAtView> => {
        const shown = stateOf(context.session).entry;
        if (!shown) return NOTHING_POINTED_AT;
        const { book, entry, pointingAt } = shown;
        const sections = await ports.readPointingAt(context.user, {
            book,
            entry,
            layout: pointingAt.layout,
            endRank: pointingAt.endRank,
            held: pointingAt.ranges,
            maxCards: MAX_CARDS_PER_READ,
        });
        return { book, entry, sections: sections ?? [] };
    };

    const readResultsView = async (context: ViewContext): Promise<ResultsView> => {
        const { filter: shown, overview } = stateOf(context.session);
        if (!shown || overview?.book !== shown.book) return NO_RESULTS;
        const read = await ports.readResults(context.user, {
            book: shown.book,
            groupBy: overview.groupBy,
            layout: overview.layout,
            query: shown.query,
            chips: shown.chips.map(({ kind, target, depth }) => ({ kind, target, depth })),
            pageSize: shown.pageSize,
            pages: shown.pages,
        });
        const chips = shown.chips.map((chip, at) => {
            const target = read.chips[at]?.target ?? null;
            return {
                ...chip,
                kindName: read.chips[at]?.kindName ?? null,
                label: target ?? chip.label,
                targetDeleted: !target,
            };
        });
        const shownCursor = (cursor: string | null) => (cursor === null ? null : `${shown.generation}.${cursor}`);
        const pages = shown.pages.map((cursor, at) => ({
            cursor: shownCursor(cursor),
            entries: read.pages[at]?.entries ?? [],
            next: shownCursor(read.pages[at]?.next ?? null),
        }));
        const current = stateOf(context.session);
        if (current.filter === shown) {
            const held = chips.map(({ kind, target, depth, label }) => ({ kind, target, depth, label }));
            bySession.set(context.session, { ...current, filter: { ...shown, chips: held } });
        }
        return {
            book: shown.book,
            filter: {
                query: shown.query,
                chips: chips.map(({ kind, kindName, label, targetDeleted, depth }) => ({
                    kind,
                    kindName,
                    target: label,
                    targetDeleted,
                    depth,
                })),
            },
            pages,
        };
    };

    const shownSelection = (session: string): HeldSelection | null => {
        const { selection, overview } = stateOf(session);
        return selection && selection.book === overview?.book ? selection : null;
    };

    const readSelectionView = async (context: ViewContext): Promise<SelectionView> => {
        const selection = shownSelection(context.session);
        if (!selection) return NOTHING_SELECTED;
        const read = await ports.readSelection(context.user, selection);
        return read ? { book: selection.book, base: selection.base, ...read } : NOTHING_SELECTED;
    };

    const selected = (context: ActionContext, selection: HeldSelection | null): ActionResult => {
        remember(context.session, { selection });
        return { changed: [SELECTION_VIEW] };
    };

    const readFoundView = async (context: ViewContext): Promise<FoundView> => {
        const finding = stateOf(context.session).finding;
        if (!finding) return NOTHING_FOUND;
        const found = await ports.findEntries(context.user, { ...finding, limit: FOUND_PER_QUERY });
        return { ...finding, ...found };
    };

    const namesOfferChanged = async (
        context: ActionContext,
        change: Promise<NamesOfferChange>,
        lastChange: LastChangeView | null,
    ): Promise<ActionResult> => {
        const done = await change;
        if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
        if (done !== 'ok') return { refused: done.refused, changed: [WORLD_VIEW] };
        if (lastChange === null) return { changed: [WORLD_VIEW] };
        remember(context.session, { lastChange });
        return { changed: [...VIEWS_OF_CARDS, FOUND_VIEW, WORLD_VIEW, LAST_CHANGE_VIEW] };
    };

    const withOpenEntry =
        <P>(run: (context: ActionContext, shown: OpenEntry, payload: P) => Promise<ActionResult>) =>
        async (context: ActionContext, payload: P): Promise<ActionResult> => {
            const shown = stateOf(context.session).entry;
            return shown ? run(context, shown, payload) : { refused: NO_ENTRY_OPEN };
        };

    const showWorld = async (
        context: ActionContext,
        book: string | null,
        { groupBy, firstRank, endRank, layout, around }: ShownWorld,
    ): Promise<{ changed: string[]; opensViews: string[] }> => {
        const opened = await ports.openWorld(who(context), book);
        if (opened === null) {
            remember(context.session, {
                overview: null,
                kindsOfBook: null,
                entry: null,
                lastChange: NOTHING_CHANGED,
                filter: null,
                selection: null,
            });
            return {
                changed: [
                    OVERVIEW_VIEW,
                    RESULTS_VIEW,
                    RELATION_KINDS_VIEW,
                    LAST_CHANGE_VIEW,
                    LOOPS_LEFT_BY_JOBS_VIEW,
                    ENTRY_VIEW,
                    POINTING_AT_VIEW,
                    SELECTION_VIEW,
                    BULK_JOBS_VIEW,
                ],
                opensViews: [WORLD_VIEW, WORLDS_VIEW],
            };
        }
        let overview: ShownOverview = { book: opened, groupBy, firstRank, endRank, layout, stepLandedOn: null };
        if (around !== null) {
            const landed = await ports.stepOverview(context.user, {
                book: opened,
                groupBy,
                layout,
                from: around,
                by: 0,
            });
            if (landed) {
                overview = {
                    ...overview,
                    ...rangeAround(landed.topLevelRank, firstRank, endRank),
                    stepLandedOn: landed.occurrence,
                };
            }
        }
        const { filter, selection } = stateOf(context.session);
        const filterStays = filter?.book === opened;
        remember(context.session, {
            overview,
            kindsOfBook: opened,
            lastChange: NOTHING_CHANGED,
            ...(filterStays ? {} : { filter: null }),
            ...(selection?.book === opened ? {} : { selection: null }),
        });
        return { changed: filter && !filterStays ? [RESULTS_VIEW] : [], opensViews: VIEWS_OF_A_WORLD };
    };

    const newWorldShown = async (
        context: ActionContext,
        made: NewWorld | 'missing',
        overview: Omit<ShownWorld, 'groupBy' | 'around'>,
    ): Promise<ActionResult> => {
        if (made === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
        if ('refused' in made) return { refused: made.refused };
        const shown = await showWorld(context, made.book, { ...overview, groupBy: null, around: null });
        return { ...shown, changed: [...shown.changed, WORLDS_VIEW] };
    };

    const forgetWorld = (book: string) => {
        for (const [session, state] of bySession) {
            const shows = [state.overview?.book, state.kindsOfBook, state.entry?.book, state.finding?.book];
            if (!shows.includes(book)) continue;
            bySession.set(session, {
                ...state,
                overview: state.overview?.book === book ? null : state.overview,
                kindsOfBook: state.kindsOfBook === book ? null : state.kindsOfBook,
                entry: state.entry?.book === book ? null : state.entry,
                filter: state.overview?.book === book ? null : state.filter,
                finding: state.finding?.book === book ? null : state.finding,
                selection: state.selection?.book === book ? null : state.selection,
            });
        }
    };

    return defineArea({
        schemas: actions,
        views: {
            [WORLDS_VIEW]: async (context: ViewContext): Promise<WorldsView> => ({
                worlds: await ports.readWorlds(context.user),
            }),
            [WORLD_VIEW]: async (context: ViewContext): Promise<WorldView> => {
                const book = stateOf(context.session).overview?.book;
                return (book === undefined ? null : await ports.readWorld(context.user, book)) ?? NO_WORLD;
            },
            [OVERVIEW_VIEW]: async (context: ViewContext): Promise<OverviewView> => {
                const overview = stateOf(context.session).overview;
                if (!overview) return NO_OVERVIEW;
                const read = await ports.readOverview(context.user, overview);
                return read ? { book: overview.book, groupBy: overview.groupBy, ...read } : NO_OVERVIEW;
            },
            [RELATION_KINDS_VIEW]: async (context: ViewContext): Promise<RelationKindsView> => {
                const book = stateOf(context.session).kindsOfBook;
                const kinds = book === null ? null : await ports.readRelationKinds(context.user, book);
                return kinds && book !== null ? { book, kinds } : { book: null, kinds: [] };
            },
            [ENTRY_VIEW]: readEntryView,
            [POINTING_AT_VIEW]: readPointingAtView,
            [RESULTS_VIEW]: readResultsView,
            [FOUND_VIEW]: readFoundView,
            [SELECTION_VIEW]: readSelectionView,
            [BULK_JOBS_VIEW]: async (context: ViewContext): Promise<BulkJobsView> => {
                const book = stateOf(context.session).overview?.book;
                const jobs = book === undefined ? null : await ports.readBulkJobs(context.user, book);
                return jobs && book !== undefined ? { book, jobs } : NO_BULK_JOBS;
            },
            [LAST_CHANGE_VIEW]: async (context: ViewContext): Promise<LastChangeView> =>
                stateOf(context.session).lastChange,
            [LOOPS_LEFT_BY_JOBS_VIEW]: async (context: ViewContext): Promise<LoopsLeftByJobsView> => {
                const book = stateOf(context.session).kindsOfBook;
                return book === null
                    ? { book: null, unreachedLoops: [] }
                    : { book, unreachedLoops: await ports.readLoopsLeftByJobs(context.user, book) };
            },
        },
        gone: (session) => {
            bySession.delete(session);
        },
        actions: {
            'worldbuilding.openOverview': (context, { book, ...shown }) => showWorld(context, book, shown),
            'worldbuilding.showRange': withOverview(async (context, overview, { firstRank, endRank }) => {
                if (!readFitsTheBudget(endRank - firstRank, overview.layout)) return { refused: READ_REFUSAL };
                remember(context.session, { overview: { ...overview, firstRank, endRank } });
                return { changed: [OVERVIEW_VIEW] };
            }),
            'worldbuilding.stepOverview': withOverview(async (context, overview, step) => {
                const crossed = 'by' in step ? Math.abs(step.by) + 1 : 1;
                if (crossed * cardsPerTopLevelEntry(overview.layout.regionsByNestingLevel) > MAX_CARDS_PER_READ) {
                    return { refused: READ_REFUSAL };
                }
                const { book, groupBy, layout, firstRank, endRank } = overview;
                const landed = await ports.stepOverview(context.user, { book, groupBy, layout, ...step });
                if (!landed) return { refused: 'That is no longer shown.', changed: [OVERVIEW_VIEW] };
                remember(context.session, {
                    overview: {
                        ...overview,
                        ...rangeAround(landed.topLevelRank, firstRank, endRank),
                        stepLandedOn: landed.occurrence,
                    },
                });
                return { changed: [OVERVIEW_VIEW] };
            }),
            'worldbuilding.showRelationKinds': async (context, { book }) => {
                remember(context.session, { kindsOfBook: book });
                return { changed: [], opensViews: [RELATION_KINDS_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.createRelationKind': async (context, { book, name }) => {
                const kind = await ports.createRelationKind(who(context), book, name);
                if (kind === null) return { refused: WORLD_GONE };
                remember(context.session, { lastChange: { ...NOTHING_CHANGED, createdKind: { book, kind } } });
                return { changed: [RELATION_KINDS_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.renameRelationKind': async (context, { book, kind, name }) => {
                const done = await ports.renameRelationKind(who(context), book, kind, name);
                if (done === 'missing') return { refused: WORLD_GONE };
                if (done === 'no kind') return { refused: NO_SUCH_KIND, changed: [RELATION_KINDS_VIEW] };
                return { changed: [RELATION_KINDS_VIEW, OVERVIEW_VIEW, RESULTS_VIEW, POINTING_AT_VIEW] };
            },
            'worldbuilding.deleteRelationKind': async (context, { book, kind }) => {
                const done = await ports.deleteRelationKind(who(context), book, kind);
                if (done === 'missing') return { refused: WORLD_GONE };
                if (done === 'no kind') return { refused: NO_SUCH_KIND, changed: [RELATION_KINDS_VIEW] };
                if (done === 'in use') return { refused: 'Relations of this kind still exist.' };
                if (done === 'being merged') return { refused: BEING_MERGED };
                return { changed: [RELATION_KINDS_VIEW] };
            },
            'worldbuilding.mergeRelationKind': async (context, { book, kind, into }) => {
                const done = await ports.mergeRelationKind(who(context), book, kind, into);
                if (done === 'missing') return { refused: WORLD_GONE };
                if (done === 'no kind') return { refused: NO_SUCH_KIND, changed: [RELATION_KINDS_VIEW] };
                if (done === 'same kind') return { refused: 'A kind is merged into another kind.' };
                if (done === 'being merged') return { refused: BEING_MERGED };
                return { changed: [RELATION_KINDS_VIEW, OVERVIEW_VIEW, RESULTS_VIEW, POINTING_AT_VIEW] };
            },
            'worldbuilding.addRelation': (context, relation) =>
                relationChanged(context, { change: 'add', ...relation }),
            'worldbuilding.moveRelation': (context, relation) =>
                relationChanged(context, { change: 'move', ...relation }),
            'worldbuilding.removeRelation': (context, relation) =>
                relationChanged(context, { change: 'remove', ...relation }),
            'worldbuilding.setRelationWeak': (context, relation) =>
                relationChanged(context, { change: 'setWeak', ...relation }),
            'worldbuilding.openEntry': async (context, { book, entry, pointingAt }) => {
                remember(context.session, { entry: opened(book, entry, pointingAt) });
                return { changed: [], opensViews: [ENTRY_VIEW, POINTING_AT_VIEW] };
            },
            'worldbuilding.closeEntry': async (context) => {
                remember(context.session, { entry: null });
                return { changed: [ENTRY_VIEW, POINTING_AT_VIEW] };
            },
            'worldbuilding.showPointingAtRange': withOpenEntry(async (context, shown, { kind, firstRank, endRank }) => {
                if (!readFitsTheBudget(endRank - firstRank, shown.pointingAt.layout)) return { refused: READ_REFUSAL };
                const range = { ...heldRange(shown.pointingAt, kind), firstRank, endRank };
                remember(context.session, { entry: { ...shown, pointingAt: withRange(shown.pointingAt, range) } });
                return { changed: [POINTING_AT_VIEW] };
            }),
            'worldbuilding.stepPointingAt': withOpenEntry(async (context, shown, { kind, ...step }) => {
                const { layout } = shown.pointingAt;
                const crossed = 'by' in step ? Math.abs(step.by) + 1 : 1;
                if (crossed * cardsPerTopLevelEntry(layout.regionsByNestingLevel) > MAX_CARDS_PER_READ) {
                    return { refused: READ_REFUSAL };
                }
                const { book, entry } = shown;
                const landed = await ports.stepPointingAt(context.user, { book, entry, kind, layout, ...step });
                if (!landed) return { refused: 'That is no longer shown.', changed: [POINTING_AT_VIEW] };
                const held = heldRange(shown.pointingAt, kind);
                const range = {
                    kind,
                    ...rangeAround(landed.topLevelRank, held.firstRank, held.endRank),
                    stepLandedOn: landed.occurrence,
                };
                remember(context.session, { entry: { ...shown, pointingAt: withRange(shown.pointingAt, range) } });
                return { changed: [POINTING_AT_VIEW] };
            }),
            'worldbuilding.showMoreMentions': async (context, { cursor }) => {
                const shown = stateOf(context.session).entry;
                if (!shown) return { refused: NO_ENTRY_OPEN };
                if (!shown.mentionPages.includes(cursor)) {
                    remember(context.session, { entry: { ...shown, mentionPages: [...shown.mentionPages, cursor] } });
                }
                return { changed: [ENTRY_VIEW] };
            },
            'worldbuilding.setEntryText': (context, { book, entry, text }) =>
                entryEdited(context, book, entry, { change: 'text', text }),
            'worldbuilding.setEntryTitle': (context, { book, entry, title }) =>
                entryEdited(context, book, entry, { change: 'title', title }),
            'worldbuilding.addKey': (context, { book, entry, key, as }) =>
                entryEdited(context, book, entry, { change: 'addKey', key, as }),
            'worldbuilding.setKeyAs': (context, { book, entry, key, as }) =>
                entryEdited(context, book, entry, { change: 'setKeyAs', key, as }),
            'worldbuilding.removeKey': (context, { book, entry, key }) =>
                entryEdited(context, book, entry, { change: 'removeKey', key }),
            'worldbuilding.setPlacement': (context, { book, entry, fields }) =>
                entryEdited(context, book, entry, { change: 'placement', fields }),
            'worldbuilding.createEntry': async (context, { book, after, name, relation, open, loopCheckLimit }) => {
                const made = await ports.createEntry(who(context), book, { after, name, relation }, loopCheckLimit);
                if (made === 'missing') return { refused: WORLD_GONE };
                if ('refused' in made) return { refused: made.refused };
                remember(context.session, {
                    ...(open ? { entry: opened(book, made.entry, open.pointingAt) } : {}),
                    lastChange: {
                        ...NOTHING_CHANGED,
                        createdEntry: { book, entry: made.entry },
                        unreachedLoops: made.unreachedLoops,
                    },
                });
                return open
                    ? {
                          changed: [...VIEWS_COUNTING_ENTRIES, LAST_CHANGE_VIEW],
                          opensViews: [ENTRY_VIEW, POINTING_AT_VIEW],
                      }
                    : { changed: [...VIEWS_COUNTING_ENTRIES, ENTRY_VIEW, POINTING_AT_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.deleteEntry': async (context, { book, entry }) => {
                const done = await ports.deleteEntry(who(context), book, entry);
                if (typeof done === 'string' || 'refused' in done) return refusedWrite(done);
                const shown = stateOf(context.session).entry;
                remember(context.session, {
                    ...(shown?.book === book && shown.entry === entry
                        ? { entry: { ...shown, label: done.label } }
                        : {}),
                    lastChange: {
                        ...NOTHING_CHANGED,
                        deletedEntry: { book, entry, label: done.label },
                        unreachedLoops: done.unreachedLoops,
                    },
                });
                return { changed: [...VIEWS_COUNTING_ENTRIES, ENTRY_VIEW, POINTING_AT_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.restoreEntry': async (context, { book, entry }) => {
                const done = await ports.restoreEntry(who(context), book, entry);
                if (typeof done === 'string' || 'refused' in done) return refusedWrite(done);
                remember(context.session, { lastChange: { ...NOTHING_CHANGED, unreachedLoops: done.unreachedLoops } });
                return { changed: [...VIEWS_COUNTING_ENTRIES, ENTRY_VIEW, POINTING_AT_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.moveEntryToWorld': async (context, { book, entry, toBook }) => {
                if (toBook === book) return { refused: 'The entry is in that world already.' };
                const moved = await ports.moveEntryToWorld(who(context), book, entry, toBook);
                if (typeof moved === 'string' || 'refused' in moved) return refusedWrite(moved);
                const shown = stateOf(context.session).entry;
                remember(context.session, {
                    ...(shown?.book === book && shown.entry === entry
                        ? { entry: opened(toBook, moved.entry, shown.pointingAt) }
                        : {}),
                    lastChange: {
                        ...NOTHING_CHANGED,
                        movedEntry: { book, entry, toBook, newEntry: moved.entry },
                        unreachedLoops: moved.unreachedLoops,
                    },
                });
                return { changed: [...VIEWS_COUNTING_ENTRIES, ENTRY_VIEW, POINTING_AT_VIEW, LAST_CHANGE_VIEW] };
            },
            'worldbuilding.openWorlds': async () => ({ changed: [], opensViews: [WORLDS_VIEW] }),
            'worldbuilding.createWorld': async (context, { name, overview }) =>
                newWorldShown(context, await ports.createWorld(who(context), name), overview),
            'worldbuilding.renameWorld': async (context, { book, name }) => {
                const done = await ports.renameWorld(who(context), book, name);
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                if (done !== 'ok') return { refused: done.refused };
                return { changed: [WORLDS_VIEW, WORLD_VIEW] };
            },
            'worldbuilding.duplicateWorld': async (context, { book, overview }) =>
                newWorldShown(context, await ports.duplicateWorld(who(context), book), overview),
            'worldbuilding.deleteWorld': async (context, { book }) => {
                const done = await ports.deleteWorld(who(context), book);
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                forgetWorld(book);
                return {
                    changed: [
                        OVERVIEW_VIEW,
                        RESULTS_VIEW,
                        FOUND_VIEW,
                        RELATION_KINDS_VIEW,
                        LOOPS_LEFT_BY_JOBS_VIEW,
                        ENTRY_VIEW,
                        POINTING_AT_VIEW,
                        WORLD_VIEW,
                        SELECTION_VIEW,
                        BULK_JOBS_VIEW,
                    ],
                    opensViews: [WORLDS_VIEW],
                };
            },
            'worldbuilding.importWorld': async (context, { overview }) => {
                if (!context.upload) return { refused: 'Choose a file to import.' };
                return newWorldShown(context, await ports.importWorld(who(context), context.upload), overview);
            },
            'worldbuilding.exportWorld': async (context, { book }) => {
                const exported = await ports.exportWorld(context.user, book);
                if (!exported) return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                return { changed: [], answer: exported };
            },
            'worldbuilding.setUsedInEveryChat': async (context, { book, used }) => {
                const done = await ports.setUsedInEveryChat(who(context), book, used);
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                return { changed: [WORLDS_VIEW, WORLD_VIEW] };
            },
            'worldbuilding.markTitleKeysAsNames': (context, { book }) =>
                namesOfferChanged(context, ports.markTitleKeysAsNames(who(context), book), {
                    ...NOTHING_CHANGED,
                    markedTitleKeys: { book },
                }),
            'worldbuilding.declineNamesOffer': (context, { book }) =>
                namesOfferChanged(context, ports.declineNamesOffer(who(context), book), null),
            'worldbuilding.undoMarkTitleKeysAsNames': (context, { book }) =>
                namesOfferChanged(context, ports.undoMarkTitleKeysAsNames(who(context), book), NOTHING_CHANGED),
            'worldbuilding.setFilter': withOverview(async (context, overview, { book, query, chips, pageSize }) => {
                if (overview.book !== book) return { refused: NOT_SHOWN };
                const selection = stateOf(context.session).selection;
                const dropsSelection = selection?.base === 'matching';
                const selectionChange = dropsSelection ? { selection: null } : {};
                const selectionChanged = dropsSelection ? [SELECTION_VIEW] : [];
                if (query.trim() === '' && chips.length === 0) {
                    remember(context.session, { filter: null, ...selectionChange });
                    return { changed: [RESULTS_VIEW, ...selectionChanged] };
                }
                const labels = await ports.labelEntries(
                    context.user,
                    book,
                    chips.map((chip) => chip.target),
                );
                const held: HeldChip[] = [];
                for (const [at, chip] of chips.entries()) {
                    const label = labels[at];
                    if (!label) return { refused: NO_SUCH_ENTRY };
                    held.push({ ...chip, label });
                }
                const closes = stateOf(context.session).entry !== null;
                remember(context.session, {
                    filter: { book, query, chips: held, pageSize, generation: ++filtersSet, pages: [null] },
                    entry: null,
                    ...selectionChange,
                });
                return {
                    changed: [...(closes ? [ENTRY_VIEW, POINTING_AT_VIEW] : []), ...selectionChanged],
                    opensViews: [RESULTS_VIEW],
                };
            }),
            'worldbuilding.showResults': async (context, { cursors }) => {
                const shown = stateOf(context.session).filter;
                if (!shown) return { refused: NO_FILTER, changed: [RESULTS_VIEW] };
                if (cursors.length * shown.pageSize > MAX_CARDS_PER_READ) return { refused: READ_REFUSAL };
                const ours = `${shown.generation}.`;
                if (cursors.some((cursor) => cursor !== null && !cursor.startsWith(ours))) {
                    return { refused: 'Those results are no longer shown.', changed: [RESULTS_VIEW] };
                }
                const pages = cursors.map((cursor) => (cursor === null ? null : cursor.slice(ours.length)));
                remember(context.session, { filter: { ...shown, pages } });
                return { changed: [RESULTS_VIEW] };
            },
            'worldbuilding.findEntries': async (context, { book, query }) => {
                remember(context.session, { finding: { book, query } });
                return { changed: [], opensViews: [FOUND_VIEW] };
            },
            'worldbuilding.select': withOverview(async (context, overview, { book, entries, selected: picked }) => {
                if (overview.book !== book) return { refused: NOT_SHOWN };
                const held = shownSelection(context.session) ?? { book, base: 'none', filter: null, except: [] };
                const adding = (held.base === 'none') === picked;
                const named = new Set(entries);
                const except = adding
                    ? [...held.except, ...[...named].filter((entry) => !held.except.includes(entry))]
                    : held.except.filter((entry) => !named.has(entry));
                if (except.length > PICKED_AT_MOST) return { refused: TOO_MANY_PICKED };
                return selected(context, held.base === 'none' && except.length === 0 ? null : { ...held, except });
            }),
            'worldbuilding.selectAllMatching': withOverview(async (context, overview, { book }) => {
                if (overview.book !== book) return { refused: NOT_SHOWN };
                const shown = stateOf(context.session).filter;
                const filter =
                    shown?.book === book
                        ? {
                              query: shown.query,
                              chips: shown.chips.map(({ kind, target, depth }) => ({ kind, target, depth })),
                          }
                        : null;
                return selected(context, { book, base: 'matching', filter, except: [] });
            }),
            'worldbuilding.selectNone': withOverview(async (context, overview, { book }) => {
                if (overview.book !== book) return { refused: NOT_SHOWN };
                return selected(context, null);
            }),
            'worldbuilding.bulk': withOverview(async (context, overview, { book, action, loopCheckLimit }) => {
                if (overview.book !== book) return { refused: NOT_SHOWN };
                const selection = shownSelection(context.session);
                if (!selection) return { refused: NOTHING_SELECTED_REFUSAL, changed: [SELECTION_VIEW] };
                const done = await ports.startBulk(who(context), selection, action, loopCheckLimit);
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                if ('refused' in done) return { refused: done.refused };
                remember(context.session, {
                    selection: null,
                    lastChange: { ...NOTHING_CHANGED, unreachedLoops: done.unreachedLoops },
                });
                return {
                    changed: [
                        ...new Set([...VIEWS_COUNTING_ENTRIES, ...VIEWS_OF_CARDS, BULK_JOBS_VIEW, LAST_CHANGE_VIEW]),
                    ],
                };
            }),
        },
    });
}
