import {
    actions,
    BULK_JOBS_VIEW,
    ENTRY_VIEW,
    FOUND_PER_QUERY,
    FOUND_VIEW,
    KEY_SHARERS_SHOWN,
    KEY_SHARERS_VIEW,
    LAST_CHANGE_VIEW,
    LOOPS_LEFT_BY_JOBS_VIEW,
    MAX_CARDS_PER_READ,
    MENTION_CHECKS_PER_READ,
    OVERVIEW_VIEW,
    POINTING_AT_VIEW,
    READ_REFUSAL,
    readFitsTheBudget,
    RELATION_KINDS_VIEW,
    RESULTS_VIEW,
    PICKED_AT_MOST,
    SELECTION_VIEW,
    SELECTION_WALK_STEPS,
    stepFitsTheBudget,
    TEXT_LINK_READS_PER_READ,
    WALK_STEPS_PER_READ,
    WORLD_VIEW,
    WORLDS_VIEW,
    ENTRIES_NAMED_PER_LOOP,
    LOOPS_SHOWN,
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
    KeySharersView,
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
    ShownLoop,
    ShownLoops,
    StepLanding,
    UnreachedLoop,
} from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { ActionContext, ActionResult, Upload, User, ViewContext } from '@st/server-ui';
import type { Looks } from '@st/protocol/looks';

export type Who = { user: User; session: string };

export type Grouping = { book: string; groupBy: string | null };

// The page at `from` (null: the first) and the pages after it, `pages` in all.
export type PagesRun = { from: string | null; pages: number };

// The entry view's reads: the run of mention pages, looking through at most `mentionChecks` entries in all, and the
// names its text writes, looked for in at most `textLinkReads` reads.
export type EntryReadAsked = { mentions: PagesRun; mentionChecks: number; textLinkReads: number };

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
    from: string | null;
    pages: number;
    // The keys a chip's region walk reads in all the run's pages.
    walkSteps: number;
};

export type ResultsRead = {
    chips: { kindName: string | null; target: Named | null }[];
    pages: { cursor: string | null; entries: EntryCell[]; next: string | null }[];
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
    // The looks of the things a view draws, as the view is read: the session's views' things are what a look's edit
    // answers looks for.
    looksOf(context: ViewContext, view: string, things: string[]): Promise<Looks>;
    readWorlds(user: User): Promise<World[]>;
    readWorld(user: User, book: string): Promise<(World & { namesOffer: NamesOffer | null }) | null>;
    openWorld(who: Who, book: string | null): Promise<string | null>;
    createWorld(who: Who, name: string): Promise<NewWorld>;
    renameWorld(who: Who, book: string, name: string): Promise<'ok' | 'missing' | { refused: string }>;
    duplicateWorld(who: Who, book: string): Promise<NewWorld | 'missing'>;
    // `next`: the world the worlds list orders after it, else before it; null when it was the only one.
    deleteWorld(who: Who, book: string): Promise<{ next: string | null } | 'missing'>;
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
    // `walkSteps`: the keys a chips-only count's walk reads.
    readSelection(user: User, selection: HeldSelection, walkSteps: number): Promise<SelectionRead | null>;
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
    readEntry(user: User, book: string, entry: string, asked: EntryReadAsked): Promise<EntryRead>;
    readKeySharers(
        user: User,
        query: { book: string; entry: string; key: string; limit: number },
    ): Promise<{ entries: Named[]; more: boolean } | null>;
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

// `loops`: the loops the change left, in the world it changed.
type LastChange = Omit<LastChangeView, keyof ShownLoops> & {
    loops: { book: string; found: UnreachedLoop[] } | null;
};

const NOTHING_CHANGED: LastChange = {
    createdKind: null,
    changedRelation: null,
    createdEntry: null,
    deletedEntry: null,
    movedEntry: null,
    markedTitleKeys: null,
    loops: null,
};

const NO_ENTRY: EntryView = { book: null };

const NOTHING_POINTED_AT: PointingAtView = { book: null };

const NO_KEY_SHARERS: KeySharersView = { book: null };

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
    RESULTS_VIEW,
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
const RESULTS_GONE = 'Those results are no longer shown.';
const MENTIONS_GONE = 'Those mentions are no longer shown.';
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

// `mentions` is the run of pages of what mentions it the page asked for; its cursors are shown to the page as
// `<generation>.<cursor>`, the generation counting entries opened, so a cursor of another entry is never read for this one.
export type OpenEntry = {
    entry: string;
    label: Named | null;
    mentions: PagesRun & { generation: number };
    pointingAt: ShownPointingAt;
    sharersOf: string | null;
};

export type HeldChip = Chip & { label: Named };

// `run` names the pages held by the store's cursor of the first; the page sees each cursor as `<generation>.<cursor>`, so
// a cursor of an earlier filter is never read under this one.
export type ShownFilter = {
    book: string;
    query: string;
    chips: HeldChip[];
    pageSize: number;
    generation: number;
    run: PagesRun;
};

export type ShownWorldState = { overview: ShownOverview; entry: OpenEntry | null };

type SessionState = {
    world: ShownWorldState | null;
    kindsOfBook: string | null;
    lastChange: LastChange;
    filter: ShownFilter | null;
    finding: { book: string; query: string } | null;
    selection: HeldSelection | null;
};

const NO_SESSION_STATE: SessionState = {
    world: null,
    kindsOfBook: null,
    lastChange: NOTHING_CHANGED,
    filter: null,
    finding: null,
    selection: null,
};

type EntryShown = { book: string; shown: OpenEntry };

const FIRST_PAGE: PagesRun = { from: null, pages: 1 };

const tagged = (generation: number) => (cursor: string | null) => (cursor === null ? null : `${generation}.${cursor}`);

// The store's cursor of a page's `<generation>.<cursor>`, or undefined when it is another generation's.
const untagged = (generation: number, cursor: string | null): string | null | undefined => {
    if (cursor === null) return null;
    const ours = `${generation}.`;
    return cursor.startsWith(ours) ? cursor.slice(ours.length) : undefined;
};

const opened = (entry: string, { endRank, layout }: PointingAtShown, generation: number): OpenEntry => ({
    entry,
    label: null,
    mentions: { ...FIRST_PAGE, generation },
    pointingAt: { endRank, layout, ranges: [] },
    sharersOf: null,
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

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// The things a view draws by name: every label, the entries its text links, and the worlds it lists or shows.
export function thingsDrawn(view: string, value: unknown): string[] {
    const found = new Set<string>();
    const walk = (part: unknown): void => {
        if (Array.isArray(part)) {
            for (const item of part) walk(item);
            return;
        }
        if (!isObject(part)) return;
        if (typeof part['thing'] === 'string' && typeof part['shownAs'] === 'string') found.add(part['thing']);
        for (const item of Object.values(part)) walk(item);
    };
    walk(value);
    if (!isObject(value)) return [...found];
    if (view === ENTRY_VIEW && Array.isArray(value['links']))
        for (const link of value['links'])
            if (isObject(link) && typeof link['entry'] === 'string') found.add(link['entry']);
    if (view === WORLDS_VIEW && Array.isArray(value['worlds']))
        for (const world of value['worlds'])
            if (isObject(world) && typeof world['id'] === 'string') found.add(world['id']);
    if (view === WORLD_VIEW && typeof value['id'] === 'string') found.add(value['id']);
    return [...found];
}

export function worldbuildingArea(ports: Ports) {
    const bySession = new Map<string, SessionState>();
    let filtersSet = 0;
    let entriesOpened = 0;
    const openedNow = (entry: string, pointingAt: PointingAtShown) => opened(entry, pointingAt, ++entriesOpened);

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

    const overviewOf = (session: string): ShownOverview | null => stateOf(session).world?.overview ?? null;

    const entryOf = (session: string): EntryShown | null => {
        const world = stateOf(session).world;
        return world?.entry ? { book: world.overview.book, shown: world.entry } : null;
    };

    const rememberEntry = (session: string, entry: OpenEntry | null, change: Partial<SessionState> = {}) => {
        const world = stateOf(session).world;
        remember(session, { ...change, ...(world ? { world: { ...world, entry } } : {}) });
    };

    const rememberOverview = (session: string, overview: ShownOverview) => {
        const world = stateOf(session).world;
        remember(session, {
            world: { overview, entry: world?.overview.book === overview.book ? world.entry : null },
        });
    };

    const shownLoops = async (user: User, book: string | null, loops: UnreachedLoop[]): Promise<ShownLoops> => {
        if (book === null || loops.length === 0) return { unreachedLoops: [], moreUnreachedLoops: 0 };
        const shown = loops.slice(0, LOOPS_SHOWN);
        const targetOf = (loop: UnreachedLoop) => loop.entries[1] ?? null;
        const named = (loop: UnreachedLoop) => loop.entries.slice(0, ENTRIES_NAMED_PER_LOOP);
        const asked = [...new Set(shown.flatMap((loop) => [loop.entry, targetOf(loop), ...named(loop)]))].filter(
            (entry) => entry !== null,
        );
        const [labels, kinds] = await Promise.all([
            ports.labelEntries(user, book, asked),
            ports.readRelationKinds(user, book),
        ]);
        const labelOf = new Map(asked.map((entry, at) => [entry, labels[at] ?? null]));
        const unreachedLoops = shown.flatMap((loop): ShownLoop[] => {
            const entry = labelOf.get(loop.entry);
            if (!entry) return [];
            const target = targetOf(loop);
            return [
                {
                    entry,
                    kind: loop.kind,
                    kindName: kinds?.find((kind) => kind.id === loop.kind)?.name ?? null,
                    target: target === null ? null : (labelOf.get(target) ?? null),
                    entries: named(loop).flatMap((each) => labelOf.get(each) ?? []),
                    moreEntries: Math.max(0, loop.entries.length - ENTRIES_NAMED_PER_LOOP),
                },
            ];
        });
        return { unreachedLoops, moreUnreachedLoops: loops.length - shown.length };
    };

    const withOverview =
        <P>(run: (context: ActionContext, overview: ShownOverview, payload: P) => Promise<ActionResult>) =>
        async (context: ActionContext, payload: P): Promise<ActionResult> => {
            const overview = overviewOf(context.session);
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
                loops: { book, found: answer.unreachedLoops },
            },
        });
        return { changed: [...VIEWS_OF_CARDS, LAST_CHANGE_VIEW], own: [OVERVIEW_VIEW, LAST_CHANGE_VIEW] };
    };

    const refusedWrite = (refusal: EntryWriteRefusal): ActionResult => {
        if (refusal === 'missing') return { refused: WORLD_GONE };
        if (refusal === 'no entry') {
            return { refused: NO_SUCH_ENTRY, changed: [...VIEWS_OF_CARDS, FOUND_VIEW], own: [] };
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
        return done === 'ok' ? { changed: [...VIEWS_OF_CARDS, FOUND_VIEW], own: [ENTRY_VIEW] } : refusedWrite(done);
    };

    const readEntryView = async (context: ViewContext): Promise<EntryView> => {
        const open = entryOf(context.session);
        if (!open) return NO_ENTRY;
        const { book, shown } = open;
        const { generation, ...mentions } = shown.mentions;
        const read = await ports.readEntry(context.user, book, shown.entry, {
            mentions,
            mentionChecks: MENTION_CHECKS_PER_READ,
            textLinkReads: TEXT_LINK_READS_PER_READ,
        });
        if (read === null) return NO_ENTRY;
        if (read.deleted) return { book, entry: shown.entry, deleted: true, label: shown.label };
        const shownCursor = tagged(generation);
        const mentionedIn = {
            pages: read.mentionedIn.pages.map((page) => ({
                ...page,
                cursor: shownCursor(page.cursor),
                next: shownCursor(page.next),
            })),
        };
        const state = stateOf(context.session);
        const world = state.world;
        if (world?.overview.book === book && world.entry?.entry === shown.entry) {
            bySession.set(context.session, {
                ...state,
                world: { ...world, entry: { ...world.entry, label: read.label } },
            });
        }
        return { book, entry: shown.entry, ...read, mentionedIn };
    };

    const readPointingAtView = async (context: ViewContext): Promise<PointingAtView> => {
        const open = entryOf(context.session);
        if (!open) return NOTHING_POINTED_AT;
        const { book } = open;
        const { entry, pointingAt } = open.shown;
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
        const shown = stateOf(context.session).filter;
        const overview = overviewOf(context.session);
        if (!shown || overview?.book !== shown.book) return NO_RESULTS;
        const read = await ports.readResults(context.user, {
            book: shown.book,
            groupBy: overview.groupBy,
            layout: overview.layout,
            query: shown.query,
            chips: shown.chips.map(({ kind, target, depth }) => ({ kind, target, depth })),
            pageSize: shown.pageSize,
            ...shown.run,
            walkSteps: WALK_STEPS_PER_READ,
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
        const shownCursor = tagged(shown.generation);
        const pages = read.pages.map((page) => ({
            cursor: shownCursor(page.cursor),
            entries: page.entries,
            next: shownCursor(page.next),
        }));
        const current = stateOf(context.session);
        if (current.filter === shown) {
            const held = chips.map(({ kind, target, depth, label }) => ({ kind, target, depth, label }));
            bySession.set(context.session, { ...current, filter: { ...shown, chips: held } });
        }
        return {
            book: shown.book,
            generation: shown.generation,
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
        const selection = stateOf(session).selection;
        return selection && selection.book === overviewOf(session)?.book ? selection : null;
    };

    const readSelectionView = async (context: ViewContext): Promise<SelectionView> => {
        const selection = shownSelection(context.session);
        if (!selection) return NOTHING_SELECTED;
        const read = await ports.readSelection(context.user, selection, SELECTION_WALK_STEPS);
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
        lastChange: LastChange | null,
    ): Promise<ActionResult> => {
        const done = await change;
        if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
        if (done !== 'ok') return { refused: done.refused, changed: [WORLD_VIEW] };
        if (lastChange === null) return { changed: [WORLD_VIEW] };
        remember(context.session, { lastChange });
        return {
            changed: [...VIEWS_OF_CARDS, FOUND_VIEW, WORLD_VIEW, LAST_CHANGE_VIEW],
            own: [WORLD_VIEW, LAST_CHANGE_VIEW],
        };
    };

    const withOpenEntry =
        <P>(run: (context: ActionContext, open: EntryShown, payload: P) => Promise<ActionResult>) =>
        async (context: ActionContext, payload: P): Promise<ActionResult> => {
            const open = entryOf(context.session);
            return open ? run(context, open, payload) : { refused: NO_ENTRY_OPEN };
        };

    const showWorld = async (
        context: ActionContext,
        book: string | null,
        { groupBy, firstRank, endRank, layout, around }: ShownWorld,
    ): Promise<{ changed: string[]; opensViews: string[]; own: string[] }> => {
        const opened = await ports.openWorld(who(context), book);
        if (opened === null) {
            remember(context.session, {
                world: null,
                kindsOfBook: null,
                lastChange: NOTHING_CHANGED,
                filter: null,
                selection: null,
            });
            const changed = [
                OVERVIEW_VIEW,
                RESULTS_VIEW,
                RELATION_KINDS_VIEW,
                LAST_CHANGE_VIEW,
                LOOPS_LEFT_BY_JOBS_VIEW,
                ENTRY_VIEW,
                POINTING_AT_VIEW,
                SELECTION_VIEW,
                BULK_JOBS_VIEW,
            ];
            const opensViews = [WORLD_VIEW, WORLDS_VIEW];
            return { changed, opensViews, own: [...changed, ...opensViews] };
        }
        let overview: ShownOverview = { book: opened, groupBy, firstRank, endRank, layout, stepLandedOn: null };
        if (around !== null && stepFitsTheBudget(1, layout)) {
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
        const { filter, selection, world } = stateOf(context.session);
        const filterStays = filter?.book === opened;
        const entry = world?.overview.book === opened ? world.entry : null;
        remember(context.session, {
            world: { overview, entry },
            kindsOfBook: opened,
            lastChange: NOTHING_CHANGED,
            ...(filterStays ? {} : { filter: null }),
            ...(selection?.book === opened ? {} : { selection: null }),
        });
        const closes = world?.entry && !entry ? [ENTRY_VIEW, POINTING_AT_VIEW] : [];
        return { changed: closes, opensViews: VIEWS_OF_A_WORLD, own: [OVERVIEW_VIEW, WORLD_VIEW, ...closes] };
    };

    const newWorldShown = async (
        context: ActionContext,
        made: NewWorld | 'missing',
        overview: Omit<ShownWorld, 'groupBy' | 'around'>,
    ): Promise<ActionResult> => {
        if (made === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
        if ('refused' in made) return { refused: made.refused };
        const shown = await showWorld(context, made.book, { ...overview, groupBy: null, around: null });
        return { ...shown, changed: [...shown.changed, WORLDS_VIEW], own: [...new Set([...shown.own, WORLDS_VIEW])] };
    };

    const forgetWorld = (book: string) => {
        for (const [session, state] of bySession) {
            const shown = state.world?.overview.book;
            if (![shown, state.kindsOfBook, state.finding?.book].includes(book)) continue;
            bySession.set(session, {
                ...state,
                world: shown === book ? null : state.world,
                kindsOfBook: state.kindsOfBook === book ? null : state.kindsOfBook,
                filter: shown === book ? null : state.filter,
                finding: state.finding?.book === book ? null : state.finding,
                selection: state.selection?.book === book ? null : state.selection,
            });
        }
    };

    const drawn = (views: Record<string, (context: ViewContext) => Promise<object>>) =>
        Object.fromEntries(
            Object.entries(views).map(([key, read]) => [
                key,
                async (context: ViewContext) => {
                    const value = await read(context);
                    return { ...value, looks: await ports.looksOf(context, key, thingsDrawn(key, value)) };
                },
            ]),
        );

    return defineArea({
        schemas: actions,
        views: drawn({
            [WORLDS_VIEW]: async (context: ViewContext): Promise<WorldsView> => ({
                worlds: await ports.readWorlds(context.user),
            }),
            [WORLD_VIEW]: async (context: ViewContext): Promise<WorldView> => {
                const book = overviewOf(context.session)?.book;
                return (book === undefined ? null : await ports.readWorld(context.user, book)) ?? NO_WORLD;
            },
            [OVERVIEW_VIEW]: async (context: ViewContext): Promise<OverviewView> => {
                const overview = overviewOf(context.session);
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
            [KEY_SHARERS_VIEW]: async (context: ViewContext): Promise<KeySharersView> => {
                const open = entryOf(context.session);
                if (!open || open.shown.sharersOf === null) return NO_KEY_SHARERS;
                const { book } = open;
                const { entry, sharersOf: key } = open.shown;
                const read = await ports.readKeySharers(context.user, { book, entry, key, limit: KEY_SHARERS_SHOWN });
                return read ? { book, entry, key, ...read } : NO_KEY_SHARERS;
            },
            [POINTING_AT_VIEW]: readPointingAtView,
            [RESULTS_VIEW]: readResultsView,
            [FOUND_VIEW]: readFoundView,
            [SELECTION_VIEW]: readSelectionView,
            [BULK_JOBS_VIEW]: async (context: ViewContext): Promise<BulkJobsView> => {
                const book = overviewOf(context.session)?.book;
                const jobs = book === undefined ? null : await ports.readBulkJobs(context.user, book);
                return jobs && book !== undefined ? { book, jobs } : NO_BULK_JOBS;
            },
            [LAST_CHANGE_VIEW]: async (context: ViewContext): Promise<LastChangeView> => {
                const { loops, ...lastChange } = stateOf(context.session).lastChange;
                return { ...lastChange, ...(await shownLoops(context.user, loops?.book ?? null, loops?.found ?? [])) };
            },
            [LOOPS_LEFT_BY_JOBS_VIEW]: async (context: ViewContext): Promise<LoopsLeftByJobsView> => {
                const book = stateOf(context.session).kindsOfBook;
                const loops = book === null ? [] : await ports.readLoopsLeftByJobs(context.user, book);
                return { book, ...(await shownLoops(context.user, book, loops)) };
            },
        }),
        gone: (session) => {
            bySession.delete(session);
        },
        actions: {
            'worldbuilding.openOverview': (context, { book, ...shown }) => showWorld(context, book, shown),
            'worldbuilding.showRange': withOverview(async (context, overview, { firstRank, endRank }) => {
                if (!readFitsTheBudget(endRank - firstRank, overview.layout)) return { refused: READ_REFUSAL };
                rememberOverview(context.session, { ...overview, firstRank, endRank });
                return { changed: [OVERVIEW_VIEW] };
            }),
            'worldbuilding.stepOverview': withOverview(async (context, overview, step) => {
                const crossed = 'by' in step ? Math.abs(step.by) + 1 : 1;
                if (!stepFitsTheBudget(crossed, overview.layout)) return { refused: READ_REFUSAL };
                const { book, groupBy, layout, firstRank, endRank } = overview;
                const landed = await ports.stepOverview(context.user, { book, groupBy, layout, ...step });
                if (!landed) return { refused: 'That is no longer shown.', changed: [OVERVIEW_VIEW] };
                rememberOverview(context.session, {
                    ...overview,
                    ...rangeAround(landed.topLevelRank, firstRank, endRank),
                    stepLandedOn: landed.occurrence,
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
                return {
                    changed: [RELATION_KINDS_VIEW, OVERVIEW_VIEW, RESULTS_VIEW, POINTING_AT_VIEW],
                    own: [RELATION_KINDS_VIEW],
                };
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
                return {
                    changed: [RELATION_KINDS_VIEW, OVERVIEW_VIEW, RESULTS_VIEW, POINTING_AT_VIEW],
                    own: [RELATION_KINDS_VIEW],
                };
            },
            'worldbuilding.addRelation': (context, relation) =>
                relationChanged(context, { change: 'add', ...relation }),
            'worldbuilding.moveRelation': (context, relation) =>
                relationChanged(context, { change: 'move', ...relation }),
            'worldbuilding.removeRelation': (context, relation) =>
                relationChanged(context, { change: 'remove', ...relation }),
            'worldbuilding.setRelationWeak': (context, relation) =>
                relationChanged(context, { change: 'setWeak', ...relation }),
            'worldbuilding.openEntry': withOverview(async (context, _overview, { entry, pointingAt }) => {
                rememberEntry(context.session, openedNow(entry, pointingAt));
                return { changed: [], opensViews: [ENTRY_VIEW, POINTING_AT_VIEW], own: [ENTRY_VIEW] };
            }),
            'worldbuilding.closeEntry': async (context) => {
                rememberEntry(context.session, null);
                return { changed: [ENTRY_VIEW, POINTING_AT_VIEW] };
            },
            'worldbuilding.showPointingAtRange': withOpenEntry(async (context, { shown }, { kind, ...range }) => {
                const { firstRank, endRank } = range;
                if (!readFitsTheBudget(endRank - firstRank, shown.pointingAt.layout)) return { refused: READ_REFUSAL };
                const held = { ...heldRange(shown.pointingAt, kind), firstRank, endRank };
                rememberEntry(context.session, { ...shown, pointingAt: withRange(shown.pointingAt, held) });
                return { changed: [POINTING_AT_VIEW] };
            }),
            'worldbuilding.stepPointingAt': withOpenEntry(async (context, { book, shown }, { kind, ...step }) => {
                const { layout } = shown.pointingAt;
                const crossed = 'by' in step ? Math.abs(step.by) + 1 : 1;
                if (!stepFitsTheBudget(crossed, layout)) return { refused: READ_REFUSAL };
                const { entry } = shown;
                const landed = await ports.stepPointingAt(context.user, { book, entry, kind, layout, ...step });
                if (!landed) return { refused: 'That is no longer shown.', changed: [POINTING_AT_VIEW] };
                const held = heldRange(shown.pointingAt, kind);
                const range = {
                    kind,
                    ...rangeAround(landed.topLevelRank, held.firstRank, held.endRank),
                    stepLandedOn: landed.occurrence,
                };
                rememberEntry(context.session, { ...shown, pointingAt: withRange(shown.pointingAt, range) });
                return { changed: [POINTING_AT_VIEW] };
            }),
            'worldbuilding.showMentions': withOpenEntry(async (context, { shown }, { from, pages }) => {
                const { generation } = shown.mentions;
                const stored = untagged(generation, from);
                if (stored === undefined) return { refused: MENTIONS_GONE, changed: [ENTRY_VIEW] };
                rememberEntry(context.session, { ...shown, mentions: { from: stored, pages, generation } });
                return { changed: [ENTRY_VIEW] };
            }),
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
            'worldbuilding.showKeySharers': withOpenEntry(async (context, open, { book, entry, key }) => {
                if (open.book !== book || open.shown.entry !== entry) return { refused: NO_ENTRY_OPEN };
                rememberEntry(context.session, { ...open.shown, sharersOf: key });
                return { changed: [], opensViews: [KEY_SHARERS_VIEW] };
            }),
            'worldbuilding.setPlacement': (context, { book, entry, fields }) =>
                entryEdited(context, book, entry, { change: 'placement', fields }),
            'worldbuilding.createEntry': async (context, { book, after, name, relation, open, loopCheckLimit }) => {
                if (open && overviewOf(context.session)?.book !== book) return { refused: NOT_SHOWN };
                const made = await ports.createEntry(who(context), book, { after, name, relation }, loopCheckLimit);
                if (made === 'missing') return { refused: WORLD_GONE };
                if ('refused' in made) return { refused: made.refused };
                const lastChange = {
                    ...NOTHING_CHANGED,
                    createdEntry: { book, entry: made.entry },
                    loops: { book, found: made.unreachedLoops },
                };
                if (open) rememberEntry(context.session, openedNow(made.entry, open.pointingAt), { lastChange });
                else remember(context.session, { lastChange });
                return open
                    ? {
                          changed: [...VIEWS_COUNTING_ENTRIES, LAST_CHANGE_VIEW],
                          opensViews: [ENTRY_VIEW, POINTING_AT_VIEW],
                          own: [ENTRY_VIEW, LAST_CHANGE_VIEW],
                      }
                    : {
                          changed: [...VIEWS_COUNTING_ENTRIES, ENTRY_VIEW, POINTING_AT_VIEW, LAST_CHANGE_VIEW],
                          own: [OVERVIEW_VIEW, LAST_CHANGE_VIEW],
                      };
            },
            'worldbuilding.deleteEntry': async (context, { book, entry }) => {
                const done = await ports.deleteEntry(who(context), book, entry);
                if (typeof done === 'string' || 'refused' in done) return refusedWrite(done);
                const open = entryOf(context.session);
                const lastChange = {
                    ...NOTHING_CHANGED,
                    deletedEntry: { book, entry, label: done.label },
                    loops: { book, found: done.unreachedLoops },
                };
                const closes = open?.book === book && open.shown.entry === entry;
                if (closes) rememberEntry(context.session, null, { lastChange });
                else remember(context.session, { lastChange });
                return {
                    changed: [...VIEWS_COUNTING_ENTRIES, ENTRY_VIEW, POINTING_AT_VIEW, LAST_CHANGE_VIEW],
                    own: [OVERVIEW_VIEW, LAST_CHANGE_VIEW, ...(closes ? [ENTRY_VIEW, POINTING_AT_VIEW] : [])],
                };
            },
            'worldbuilding.restoreEntry': async (context, { book, entry }) => {
                const done = await ports.restoreEntry(who(context), book, entry);
                if (typeof done === 'string' || 'refused' in done) return refusedWrite(done);
                remember(context.session, {
                    lastChange: { ...NOTHING_CHANGED, loops: { book, found: done.unreachedLoops } },
                });
                const open = entryOf(context.session);
                const shown = open?.book === book && open.shown.entry === entry ? ENTRY_VIEW : OVERVIEW_VIEW;
                return {
                    changed: [...VIEWS_COUNTING_ENTRIES, ENTRY_VIEW, POINTING_AT_VIEW, LAST_CHANGE_VIEW],
                    own: [shown, LAST_CHANGE_VIEW],
                };
            },
            'worldbuilding.moveEntryToWorld': async (context, { book, entry, toBook }) => {
                if (toBook === book) return { refused: 'The entry is in that world already.' };
                const moved = await ports.moveEntryToWorld(who(context), book, entry, toBook);
                if (typeof moved === 'string' || 'refused' in moved) return refusedWrite(moved);
                const lastChange = {
                    ...NOTHING_CHANGED,
                    movedEntry: { book, entry, toBook, newEntry: moved.entry },
                    loops: { book, found: moved.unreachedLoops },
                };
                const changed = [...VIEWS_COUNTING_ENTRIES, ENTRY_VIEW, POINTING_AT_VIEW, LAST_CHANGE_VIEW];
                const open = entryOf(context.session);
                const overview = overviewOf(context.session);
                if (!overview || open?.book !== book || open.shown.entry !== entry) {
                    remember(context.session, { lastChange });
                    return { changed, own: [OVERVIEW_VIEW, LAST_CHANGE_VIEW] };
                }
                const shown = await showWorld(context, toBook, {
                    groupBy: null,
                    firstRank: 0,
                    endRank: overview.endRank - overview.firstRank,
                    layout: overview.layout,
                    around: moved.entry,
                });
                rememberEntry(context.session, openedNow(moved.entry, open.shown.pointingAt), { lastChange });
                return {
                    changed: [...new Set([...changed, ...shown.changed])].filter(
                        (view) => !shown.opensViews.includes(view),
                    ),
                    opensViews: shown.opensViews,
                    own: [WORLD_VIEW, LAST_CHANGE_VIEW],
                };
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
                const shown = overviewOf(context.session);
                const done = await ports.deleteWorld(who(context), book);
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                forgetWorld(book);
                if (shown?.book === book) {
                    const { layout, firstRank, endRank } = shown;
                    const opened = await showWorld(context, done.next, {
                        groupBy: null,
                        firstRank: 0,
                        endRank: endRank - firstRank,
                        layout,
                        around: null,
                    });
                    const changed = [RESULTS_VIEW, FOUND_VIEW, ENTRY_VIEW, POINTING_AT_VIEW, WORLDS_VIEW];
                    return {
                        changed: [...new Set([...changed, ...opened.changed])].filter(
                            (view) => !opened.opensViews.includes(view),
                        ),
                        opensViews: opened.opensViews,
                        own: [...new Set([...opened.own, WORLDS_VIEW])],
                    };
                }
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
                    own: [WORLDS_VIEW],
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
                const closes = entryOf(context.session) !== null;
                rememberEntry(context.session, null, {
                    filter: { book, query, chips: held, pageSize, generation: ++filtersSet, run: FIRST_PAGE },
                    ...selectionChange,
                });
                return {
                    changed: [...(closes ? [ENTRY_VIEW, POINTING_AT_VIEW] : []), ...selectionChanged],
                    opensViews: [RESULTS_VIEW],
                };
            }),
            'worldbuilding.showResults': async (context, { from, pages }) => {
                const shown = stateOf(context.session).filter;
                if (!shown) return { refused: NO_FILTER, changed: [RESULTS_VIEW] };
                if (pages * shown.pageSize > MAX_CARDS_PER_READ) return { refused: READ_REFUSAL };
                const stored = untagged(shown.generation, from);
                if (stored === undefined) return { refused: RESULTS_GONE, changed: [RESULTS_VIEW] };
                remember(context.session, { filter: { ...shown, run: { from: stored, pages } } });
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
                    lastChange: { ...NOTHING_CHANGED, loops: { book, found: done.unreachedLoops } },
                });
                return {
                    changed: [
                        ...new Set([...VIEWS_COUNTING_ENTRIES, ...VIEWS_OF_CARDS, BULK_JOBS_VIEW, LAST_CHANGE_VIEW]),
                    ],
                    own: [SELECTION_VIEW, BULK_JOBS_VIEW, LAST_CHANGE_VIEW],
                };
            }),
        },
    });
}
