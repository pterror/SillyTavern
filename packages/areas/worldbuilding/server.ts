import {
    actions,
    BULK_JOBS_VIEW,
    CARD_RELATIONS_SHOWN,
    CARD_TEXT_CHARACTERS,
    CARD_VIEW,
    ENTRY_VIEW,
    CHARACTERS_FOUND_PER_QUERY,
    CHARACTERS_FOUND_VIEW,
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
    topLevelPerRead,
    TEXT_LINK_READS_PER_READ,
    WALK_STEPS_PER_READ,
    WORLD_VIEW,
    WORLDS_VIEW,
    VIEWS_VIEW,
    AXES_VIEW,
    CELL_CARDS_PER_PAGE,
    CELL_COUNTED_UP_TO,
    CELL_HEADS_ABOVE,
    shapeOf,
    ENTRIES_NAMED_PER_LOOP,
    LOOPS_SHOWN,
} from './protocol.ts';
import type {
    AxesView,
    AxisCell,
    AxisHeader,
    AxisItem,
    CellCard,
    BulkAction,
    BulkJob,
    BulkJobsView,
    CardAsked,
    CardView,
    Chip,
    EntryCell,
    HoverCard,
    FoundEntry,
    CharactersFoundView,
    FilterItem,
    FoundView,
    ResultsView,
    EntryView,
    ExportedWorld,
    KeySharersView,
    World,
    WorldsView,
    WorldView,
    OpenWorldView,
    LastChangeView,
    LoopsLeftByJobsView,
    MentionedIn,
    Named,
    OpenEntryView,
    Placement,
    OverviewCell,
    OverviewLayout,
    OverviewPage,
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
    EntryAt,
    UnreachedLoop,
    RegionCell,
    EntryFacts,
    SavedView,
    ViewsView,
} from './protocol.ts';
import { defineArea, patch, patchOf } from '@st/server-ui';
import type { ActionContext, ActionResult, Upload, User, ViewContext } from '@st/server-ui';
import type { Looks } from '@st/protocol/looks';

export type Who = { user: User; session: string };

export type Grouping = { book: string; groupBy: string | null };

// The page at `from` (null: the first) and the pages after it, `pages` in all.
export type PagesRun = { from: string | null; pages: number };

// The entry view's reads: the run of mention pages, looking through at most `mentionChecks` entries in all, and the
// names its text writes, looked for in at most `textLinkReads` reads.
export type EntryReadAsked = { mentions: PagesRun; mentionChecks: number; textLinkReads: number };

// The top-level entries the tab has read, from the first to `endRank`, streamed a read's worth (topLevelPerRead) a part.
export type ShownOverview = Grouping & { endRank: number; layout: OverviewLayout };

export type OverviewRead = Grouping & { firstRank: number; endRank: number; layout: OverviewLayout };

export type OverviewRangeRead = { topLevelCount: number; firstRank: number; entries: OverviewCell[] };

// `groupBy` undefined: the world's default grouping, its first relation kind (none when it has none). `around`: an
// occurrence whose top-level entry the read reaches.
export type ShownWorld = {
    layout: OverviewLayout;
    ahead: number;
    groupBy?: string | null | undefined;
    around: string | null;
};

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
    | { change: 'placement'; fields: Partial<Omit<Placement, 'characterFilter'>> }
    | { change: 'characterFilter'; filter: { exclude: boolean } | { add: FilterItem } | { remove: FilterItem } };

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

export type Found = { entries: FoundEntry[]; next: string | null };

export type NamesOfferChange = 'ok' | 'missing' | { refused: string };

// `filter` null: the whole world.
export type HeldSelection = {
    book: string;
    base: 'none' | 'matching';
    filter: { query: string; chips: Chip[] } | null;
    except: string[];
};

export type SelectionRead = Omit<Extract<SelectionView, { base: unknown }>, 'book' | 'base'>;

// The reader's layer over a world's views: changed copies of the world's, by id, and views of the reader's own.
export type CellsQuery = {
    book: string;
    groupBy: string | null;
    layout: OverviewLayout;
    query: string;
    chips: Chip[];
    cells: { items: AxisItem[]; limit: number }[];
    countUpTo: number;
    walkSteps: number;
};

export type CellRead = { entries: CellCard[]; count: number; capped: boolean; more: boolean };

export type ReaderViews = { changed: Record<string, SavedView>; own: SavedView[] };

export type StoredViews = { world: SavedView[]; reader: ReaderViews };

export type Ports = {
    readViews(user: User, book: string): Promise<StoredViews | null>;
    writeReaderViews(who: Who, book: string, reader: ReaderViews): Promise<'ok' | 'missing'>;
    // Renames or deletes the world's view `id`, and writes the reader's layer, in one write.
    changeWorldView(
        who: Who,
        book: string,
        id: string,
        change: { name: string } | { deleted: true },
        reader: ReaderViews,
    ): Promise<'ok' | 'missing' | 'no view'>;
    // What rows show of each entry, in the order asked; null for one that isn't a live entry of the world.
    // `tokens`: also count each entry's tokens.
    readFacts(user: User, book: string, entries: string[], tokens: boolean): Promise<(EntryFacts | null)[]>;
    // Each cell's entries (its first `limit`) and count: those passing the filter and every one of its items.
    readCells(user: User, query: CellsQuery): Promise<CellRead[]>;
    // The looks of the things a view draws, as the view is read: the session's views' things are what a look's edit
    // answers looks for.
    // `adding`: the things are drawn besides those the view's earlier parts drew.
    looksOf(context: ViewContext, view: string, things: string[], options?: { adding?: boolean }): Promise<Looks>;
    readWorlds(user: User): Promise<World[]>;
    readWorld(user: User, book: string): Promise<Omit<OpenWorldView, 'usedInThisChat'> | null>;
    // Whether a reply in the tab's chat reads the world; false with no chat.
    chatReadsWorld(context: ViewContext, book: string): Promise<boolean>;
    // The character's own lorebook, null when it has none.
    characterBook(user: User, character: string): Promise<string | null>;
    worldNamed(user: User, name: string): Promise<string | null>;
    entryOfUid(user: User, book: string, uid: number): Promise<string | null>;
    setWorldDescription(who: Who, book: string, description: string): Promise<'ok' | 'missing'>;
    // `entry` null: the world's own picture; `file` null removes it.
    setPicture(
        who: Who,
        book: string,
        entry: string | null,
        file: Upload | null,
    ): Promise<'ok' | 'missing' | 'no entry' | { refused: string }>;
    // At most `relations` of its relations and the first `textCharacters` characters of its text.
    readCard(
        user: User,
        book: string,
        entry: string,
        shown: { relations: number; textCharacters: number },
    ): Promise<Omit<HoverCard, 'book' | 'entry' | 'broughtUpBy'> | null>;
    // For each entry, the keys that brought it into `reply`, a stored reply of the tab's chat; null where it didn't come
    // up for it, or the reply isn't one.
    broughtUpBy(context: ViewContext, reply: string, entries: EntryAt[]): Promise<(string[] | null)[]>;
    entryIn(user: User, book: string, entry: string): Promise<boolean>;
    openWorld(who: Who, book: string | null): Promise<string | null>;
    createWorld(who: Who, name: string): Promise<NewWorld>;
    renameWorld(who: Who, book: string, name: string): Promise<'ok' | 'missing' | { refused: string }>;
    duplicateWorld(who: Who, book: string): Promise<NewWorld | 'missing'>;
    // `next`: the world the worlds list orders after it, else before it; null when it was the only one.
    deleteWorld(who: Who, book: string): Promise<{ next: string | null } | 'missing' | { refused: string }>;
    importWorld(who: Who, file: Upload): Promise<NewWorld>;
    exportWorld(user: User, book: string): Promise<ExportedWorld | null | { refused: string }>;
    // All of `changes` in one write, or none of them.
    setUsedInEveryChat(
        who: Who,
        changes: { book: string; used: boolean }[],
    ): Promise<'ok' | 'missing' | { refused: string }>;
    markTitleKeysAsNames(who: Who, book: string): Promise<NamesOfferChange>;
    declineNamesOffer(who: Who, book: string): Promise<NamesOfferChange>;
    undoMarkTitleKeysAsNames(who: Who, book: string): Promise<NamesOfferChange>;
    readOverview(user: User, query: OverviewRead): Promise<OverviewRangeRead | null>;
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
    // The user's characters and tags whose names have the words, for an entry's character filter.
    findCharacters(
        user: User,
        query: { query: string; limit: number },
    ): Promise<Omit<Extract<CharactersFoundView, { characters: unknown }>, 'query'>>;
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
    // `changes` are of one entry, made in turn and written together: all of them, or none when one is refused.
    changeRelations(
        who: Who,
        book: string,
        changes: RelationChange[],
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

const NO_OVERVIEW: OverviewView = { book: null, groupBy: null, topLevelCount: 0, pageSize: 0, pageCount: 0, pages: {} };

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

const VIEWS_OF_CARDS = [OVERVIEW_VIEW, RESULTS_VIEW, ENTRY_VIEW, POINTING_AT_VIEW, SELECTION_VIEW, AXES_VIEW];

const NO_RESULTS: ResultsView = { book: null };

const NOTHING_FOUND: FoundView = { book: null };

const NO_WORLD: WorldView = { id: null };

const NO_CARD: CardView = { asked: null, cards: [] };

const NOTHING_SELECTED: SelectionView = { book: null };

const NO_BULK_JOBS: BulkJobsView = { book: null };

const VIEWS_OF_A_WORLD = [
    OVERVIEW_VIEW,
    VIEWS_VIEW,
    AXES_VIEW,
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
const NO_CHARACTER_BOOK = 'This character has no lorebook of its own.';
const NO_FILTER = 'Nothing is searched for.';
const RESULTS_GONE = 'Those results are no longer shown.';
const MENTIONS_GONE = 'Those mentions are no longer shown.';
const NOT_SHOWN = "That world isn't shown.";
const NOTHING_SELECTED_REFUSAL = 'Nothing is selected.';
const TOO_MANY_PICKED = `At most ${PICKED_AT_MOST} entries are picked one at a time; select all matching instead.`;

// Grouped by nothing, a top-level entry draws no region, so a page holds a read's worth of plain cards.
const drawnLayout = ({ groupBy, layout }: Grouping & { layout: OverviewLayout }): OverviewLayout =>
    groupBy === null ? { ...layout, regionsByNestingLevel: [] } : layout;

export const pageSizeOf = (overview: Grouping & { layout: OverviewLayout }): number =>
    topLevelPerRead(drawnLayout(overview));

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

// The view a tab shows of a world: `id` null when the world has no views; `draft` the tab's unsaved change of it.
type ShownViewState = { book: string; id: string | null; draft: SavedView | null };

// How many pages of CELL_CARDS_PER_PAGE each cell of the shown board or grid draws, by `cellKey`; none: one.
type CellPages = { book: string; view: string | null; pages: Record<string, number> };

type SessionState = {
    view: ShownViewState | null;
    // The overview the tab's last read of it sent, and how many pages: a later read of the same one patches those and
    // nulls the pages it no longer has.
    overviewSent: { key: string; count: number } | null;
    cellPages: CellPages | null;
    world: ShownWorldState | null;
    card: CardAsked | null;
    kindsOfBook: string | null;
    lastChange: LastChange;
    filter: ShownFilter | null;
    finding: { book: string; query: string } | null;
    findingCharacters: string | null;
    selection: HeldSelection | null;
};

const NO_SESSION_STATE: SessionState = {
    view: null,
    overviewSent: null,
    cellPages: null,
    world: null,
    card: null,
    kindsOfBook: null,
    lastChange: NOTHING_CHANGED,
    filter: null,
    finding: null,
    findingCharacters: null,
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

// The tabs of a world's views: the world's, each as the reader changed it, then the reader's own.
export const tabsOf = (stored: StoredViews): SavedView[] => [
    ...stored.world.map((view) => stored.reader.changed[view.id] ?? view),
    ...stored.reader.own,
];

const sameView = (one: SavedView, other: SavedView): boolean => JSON.stringify(one) === JSON.stringify(other);

const NO_VIEWS: ViewsView = { book: null };
const NO_AXES: AxesView = { book: null };
const NOT_A_CELL = 'The shown view has no such cell.';
const NO_DROP_HERE = 'That cell isn’t made by a relation to one entry, so a card can’t be dropped there.';

const cellKey = (column: number | null, row: number | null) => `${column ?? '-'}:${row ?? '-'}`;

// The cells a view with axes draws: one per column and row, or per item of its one axis.
export const cellsOf = (columns: number, rows: number): { column: number | null; row: number | null }[] => {
    if (columns === 0 && rows === 0) return [];
    const across: (number | null)[] = columns === 0 ? [null] : [...Array(columns).keys()];
    const down: (number | null)[] = rows === 0 ? [null] : [...Array(rows).keys()];
    return down.flatMap((row) => across.map((column) => ({ column, row })));
};

const directTarget = (item: AxisItem): string | null =>
    typeof item.is === 'object' && item.is.depth === 'directly' ? item.is.target : null;
const NO_VIEW_SHOWN = 'No view is shown.';
const NO_SUCH_VIEW = 'This world has no such view.';
const NOT_THE_WORLDS_VIEW = 'This view is your own, so there is nothing of the world’s to go back to.';
const NEW_VIEW_NAME = 'New view';
const RESULTS_PAGE_SIZE = 40;

// Every entry cell of a read, regions included, for what rows add to them.
const entryCellsOf = (cells: readonly RegionCell[]): EntryCell[] =>
    cells.flatMap((cell) =>
        cell.cell === 'entry'
            ? [cell, ...entryCellsOf(cell.region)]
            : cell.cell === 'placeOfDeletedEntry'
              ? entryCellsOf(cell.region)
              : [],
    );

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

    // The view the tab shows of its world, as saved for the reader and as the tab changed it.
    const viewShown = async (user: User, session: string) => {
        const state = stateOf(session).view;
        if (!state || state.id === null) return null;
        const stored = await ports.readViews(user, state.book);
        if (!stored) return null;
        const saved = tabsOf(stored).find((tab) => tab.id === state.id);
        if (!saved) return null;
        return { state, stored, saved, shown: state.draft ?? saved };
    };

    // The shown view's rows show each entry's tokens.
    const rowsShowTokens = async (user: User, session: string): Promise<boolean> => {
        const shown = (await viewShown(user, session))?.shown;
        return shown?.drawing === 'rows' && shown.fields.includes('tokens');
    };

    const withFacts = async (
        context: ViewContext,
        book: string,
        cells: { entry: string; facts?: EntryFacts }[],
    ): Promise<void> => {
        if (cells.length === 0) return;
        const facts = await ports.readFacts(
            context.user,
            book,
            cells.map((cell) => cell.entry),
            await rowsShowTokens(context.user, context.session),
        );
        cells.forEach((cell, at) => {
            const fact = facts[at];
            if (fact) cell.facts = fact;
        });
    };

    // Shows `view` (null: the world's without views) as the tab's, its grouping, and its filter.
    const showViewOf = async (
        context: ActionContext,
        book: string,
        id: string | null,
        draft: SavedView | null,
        view: SavedView | null,
        overview: { layout: OverviewLayout; ahead: number },
    ): Promise<ActionResult> => {
        remember(context.session, { view: { book, id, draft }, cellPages: null });
        const shown = await showWorld(context, book, {
            ...overview,
            groupBy: view ? view.groupBy : (overviewOf(context.session)?.groupBy ?? null),
            around: null,
        });
        remember(context.session, { view: { book, id, draft } });
        const filterChanged = await setFilterOf(context, book, view?.query ?? '', view?.chips ?? [], null);
        if ('refused' in filterChanged) return filterChanged;
        return {
            changed: [...shown.changed, ...filterChanged.changed, VIEWS_VIEW, AXES_VIEW],
            opensViews: [...shown.opensViews, ...(filterChanged.opensViews ?? [])],
            own: [...new Set([...shown.own, VIEWS_VIEW, AXES_VIEW])],
        };
    };

    // Sets the tab's filter; `pageSize` null keeps the one it has.
    const setFilterOf = async (
        context: ActionContext,
        book: string,
        query: string,
        chips: Chip[],
        pageSize: number | null,
    ): Promise<{ changed: string[]; opensViews?: string[] } | { refused: string }> => {
        const { selection, filter } = stateOf(context.session);
        const dropsSelection = selection?.base === 'matching';
        const selectionChange = dropsSelection ? { selection: null } : {};
        const selectionChanged = dropsSelection ? [SELECTION_VIEW] : [];
        if (query.trim() === '' && chips.length === 0) {
            remember(context.session, { filter: null, ...selectionChange });
            return { changed: [RESULTS_VIEW, AXES_VIEW, ...selectionChanged] };
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
        const size = pageSize ?? filter?.pageSize ?? RESULTS_PAGE_SIZE;
        rememberEntry(context.session, null, {
            filter: { book, query, chips: held, pageSize: size, generation: ++filtersSet, run: FIRST_PAGE },
            ...selectionChange,
        });
        return {
            changed: [...(closes ? [ENTRY_VIEW, POINTING_AT_VIEW] : []), AXES_VIEW, ...selectionChanged],
            opensViews: [RESULTS_VIEW],
        };
    };

    const relationChanged = async (
        context: ActionContext,
        { book, loopCheckLimit, ...change }: RelationChange & { book: string; loopCheckLimit: number },
    ): Promise<ActionResult> => {
        const answer = await ports.changeRelations(who(context), book, [change], loopCheckLimit);
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
        if (read.deleted === true) return { book, entry: shown.entry, deleted: true, label: shown.label };
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
        await withFacts(
            context,
            book,
            (sections ?? []).flatMap((section) => entryCellsOf(section.entries)),
        );
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
        await withFacts(
            context,
            shown.book,
            read.pages.flatMap((page) => entryCellsOf(page.entries)),
        );
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

    // A board's or grid's headers and cells, each under the tab's filter: headers count only, cells draw their first
    // pages. One request's walk is shared out among them.
    const readAxesView = async (context: ViewContext): Promise<AxesView> => {
        const shown = await viewShown(context.user, context.session);
        const overview = overviewOf(context.session);
        if (!shown || !overview || overview.book !== shown.state.book) return NO_AXES;
        const { columns, rows } = shown.shown;
        if (columns.length === 0 && rows.length === 0) return NO_AXES;
        const book = shown.state.book;
        const filter = stateOf(context.session).filter;
        const filtered = filter?.book === book ? filter : null;
        const pages = stateOf(context.session).cellPages;
        const pagesOf = (column: number | null, row: number | null) =>
            pages && pages.book === book && pages.view === shown.state.id
                ? (pages.pages[cellKey(column, row)] ?? 1)
                : 1;
        const cells = cellsOf(columns.length, rows.length);
        const cardsAtMost = Math.floor(MAX_CARDS_PER_READ / ((1 + CELL_HEADS_ABOVE) * Math.max(1, cells.length)));
        const asked = [
            ...[...columns, ...rows].map((item) => ({ items: [item], limit: 0 })),
            ...cells.map(({ column, row }) => ({
                items: [
                    ...(column === null ? [] : [columns[column] as AxisItem]),
                    ...(row === null ? [] : [rows[row] as AxisItem]),
                ],
                limit: Math.min(cardsAtMost, pagesOf(column, row) * CELL_CARDS_PER_PAGE),
            })),
        ];
        const [read, kinds, labels] = await Promise.all([
            ports.readCells(context.user, {
                book,
                groupBy: overview.groupBy,
                layout: overview.layout,
                query: filtered?.query ?? '',
                chips: (filtered?.chips ?? []).map(({ kind, target, depth }) => ({ kind, target, depth })),
                cells: asked,
                countUpTo: CELL_COUNTED_UP_TO,
                walkSteps: Math.max(1, Math.floor(WALK_STEPS_PER_READ / asked.length)),
            }),
            ports.readRelationKinds(context.user, book),
            ports.labelEntries(
                context.user,
                book,
                [...columns, ...rows].flatMap((item) => (typeof item.is === 'object' ? [item.is.target] : [])),
            ),
        ]);
        let labelAt = 0;
        const header = (item: AxisItem, at: number): AxisHeader => {
            const target = typeof item.is === 'object' ? (labels[labelAt++] ?? null) : null;
            const counted = read[at];
            return {
                item,
                kindName: kinds?.find((kind) => kind.id === item.kind)?.name ?? null,
                target,
                targetDeleted: typeof item.is === 'object' && target === null,
                count: counted?.count ?? 0,
                capped: counted?.capped ?? false,
                drops: directTarget(item) !== null && target !== null,
            };
        };
        const headers = [...columns, ...rows].map(header);
        const drawn: AxisCell[] = cells.map(({ column, row }, at) => {
            const cell = read[headers.length + at];
            return {
                column,
                row,
                entries: cell?.entries ?? [],
                count: cell?.count ?? 0,
                capped: cell?.capped ?? false,
                more: cell?.more ?? false,
            };
        });
        const cardsOf = (cards: CellCard[]): CellCard[] => cards.flatMap((card) => [card, ...cardsOf(card.region)]);
        await withFacts(
            context,
            book,
            drawn.flatMap((cell) => cardsOf(cell.entries)),
        );
        return { book, columns: headers.slice(0, columns.length), rows: headers.slice(columns.length), cells: drawn };
    };

    // Each page a part. A read of what the tab already holds (the same world, grouping and page size) patches it, so
    // what is drawn stays while the parts come; the first read of another sets it.
    const readOverviewView = async function* (context: ViewContext): AsyncIterable<unknown> {
        const overview = overviewOf(context.session);
        if (!overview) {
            remember(context.session, { overviewSent: null });
            yield NO_OVERVIEW;
            return;
        }
        const { book, groupBy, endRank } = overview;
        const pageSize = pageSizeOf(overview);
        const page = async (at: number): Promise<OverviewRangeRead | null> => {
            const read = await ports.readOverview(context.user, {
                book,
                groupBy,
                firstRank: at * pageSize,
                endRank: Math.min(endRank, (at + 1) * pageSize),
                layout: drawnLayout(overview),
            });
            if (read) await withFacts(context, book, entryCellsOf(read.entries));
            return read;
        };
        const first = await page(0);
        if (!first) {
            remember(context.session, { overviewSent: null });
            yield NO_OVERVIEW;
            return;
        }
        const pageCount = Math.max(1, Math.ceil(Math.min(endRank, first.topLevelCount) / pageSize));
        const key = `${book}/${groupBy}/${pageSize}`;
        const sent = stateOf(context.session).overviewSent;
        const held = sent?.key === key ? sent.count : null;
        remember(context.session, { overviewSent: { key, count: pageCount } });
        const pages: Record<string, OverviewPage | null> = {
            0: { firstRank: first.firstRank, entries: first.entries },
        };
        if (held !== null) for (let gone = pageCount; gone < held; gone++) pages[gone] = null;
        const head = { book, groupBy, topLevelCount: first.topLevelCount, pageSize, pageCount, pages };
        yield held !== null ? patch(head) : head;
        for (let at = 1; at < pageCount; at++) {
            const read = await page(at);
            if (!read) return;
            yield patch({
                topLevelCount: read.topLevelCount,
                pages: { [at]: { firstRank: read.firstRank, entries: read.entries } },
            });
        }
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

    const readCharactersFoundView = async (context: ViewContext): Promise<CharactersFoundView> => {
        const query = stateOf(context.session).findingCharacters;
        if (query === null) return { query: null };
        return { query, ...(await ports.findCharacters(context.user, { query, limit: CHARACTERS_FOUND_PER_QUERY })) };
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
        { groupBy, layout, ahead, around }: ShownWorld,
        keepsEntry = true,
    ): Promise<{ changed: string[]; opensViews: string[]; own: string[] }> => {
        const opened = await ports.openWorld(who(context), book);
        if (opened === null) {
            remember(context.session, {
                view: null,
                world: null,
                kindsOfBook: null,
                lastChange: NOTHING_CHANGED,
                filter: null,
                selection: null,
            });
            const changed = [
                OVERVIEW_VIEW,
                VIEWS_VIEW,
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
        const held = stateOf(context.session).view;
        const views = await ports.readViews(context.user, opened);
        const tabs = views ? tabsOf(views) : [];
        const viewId =
            held?.book === opened && (held.id === null ? tabs.length === 0 : tabs.some((tab) => tab.id === held.id))
                ? held.id
                : (tabs[0]?.id ?? null);
        const draft = held?.book === opened && held.id === viewId ? held.draft : null;
        const view = draft ?? tabs.find((tab) => tab.id === viewId) ?? null;
        const grouping =
            groupBy !== undefined
                ? groupBy
                : view
                  ? view.groupBy
                  : ((await ports.readRelationKinds(context.user, opened))?.find((kind) => kind.mergingInto === null)
                        ?.id ?? null);
        const viewState: ShownViewState = {
            book: opened,
            id: viewId,
            draft: view && groupBy !== undefined && groupBy !== view.groupBy ? { ...view, groupBy } : draft,
        };
        const overview: ShownOverview = { book: opened, groupBy: grouping, endRank: ahead, layout };
        if (around !== null && stepFitsTheBudget(1, layout)) {
            const landed = await ports.stepOverview(context.user, {
                book: opened,
                groupBy: grouping,
                layout,
                from: around,
                by: 0,
            });
            if (landed) overview.endRank = Math.max(ahead, landed.topLevelRank + 1);
        }
        const { filter, selection, world } = stateOf(context.session);
        const filterStays = filter?.book === opened;
        const entry = keepsEntry && world?.overview.book === opened ? world.entry : null;
        remember(context.session, {
            view: viewState,
            world: { overview, entry },
            kindsOfBook: opened,
            lastChange: NOTHING_CHANGED,
            ...(filterStays ? {} : { filter: null }),
            ...(selection?.book === opened ? {} : { selection: null }),
        });
        const closes = world?.entry && !entry ? [ENTRY_VIEW, POINTING_AT_VIEW] : [];
        return {
            changed: closes,
            opensViews: VIEWS_OF_A_WORLD,
            own: [OVERVIEW_VIEW, WORLD_VIEW, VIEWS_VIEW, ...closes],
        };
    };

    // Shows `book` and, when one is named, opens `entry` in it, keeping the grouping the tab shows that world by.
    const openAt = async (
        context: ActionContext,
        book: string,
        entry: string | null,
        overview: { layout: OverviewLayout; ahead: number },
        pointingAt: PointingAtShown,
    ): Promise<ActionResult> => {
        const held = overviewOf(context.session);
        const groupBy = held?.book === book ? held.groupBy : undefined;
        const shown = await showWorld(context, book, { ...overview, groupBy, around: entry }, false);
        if (entry === null) return shown;
        rememberEntry(context.session, openedNow(entry, pointingAt));
        const entryViews = [ENTRY_VIEW, POINTING_AT_VIEW];
        return {
            changed: shown.changed.filter((view) => !entryViews.includes(view)),
            opensViews: [...shown.opensViews, ...entryViews],
            own: [WORLD_VIEW, ENTRY_VIEW],
        };
    };

    const newWorldShown = async (
        context: ActionContext,
        made: NewWorld | 'missing',
        overview: { layout: OverviewLayout; ahead: number },
    ): Promise<ActionResult> => {
        if (made === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
        if ('refused' in made) return { refused: made.refused };
        const shown = await showWorld(context, made.book, { ...overview, around: null });
        return { ...shown, changed: [...shown.changed, WORLDS_VIEW], own: [...new Set([...shown.own, WORLDS_VIEW])] };
    };

    const forgetWorld = (book: string) => {
        for (const [session, state] of bySession) {
            const shown = state.world?.overview.book;
            const cardShows = state.card?.entries.some((at) => at.book === book) === true;
            if (![shown, state.kindsOfBook, state.finding?.book].includes(book) && !cardShows) continue;
            bySession.set(session, {
                ...state,
                card: cardShows ? null : state.card,
                world: shown === book ? null : state.world,
                kindsOfBook: state.kindsOfBook === book ? null : state.kindsOfBook,
                filter: shown === book ? null : state.filter,
                finding: state.finding?.book === book ? null : state.finding,
                selection: state.selection?.book === book ? null : state.selection,
            });
        }
    };

    const pictureChanged = (
        done: 'ok' | 'missing' | 'no entry' | { refused: string },
        entry: string | null,
    ): ActionResult => {
        if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
        if (done === 'no entry') return refusedWrite(done);
        if (done !== 'ok') return { refused: done.refused };
        return entry === null
            ? { changed: [WORLD_VIEW, WORLDS_VIEW], own: [WORLD_VIEW] }
            : { changed: [...VIEWS_OF_CARDS, CARD_VIEW], own: [ENTRY_VIEW] };
    };

    const drawn = (
        views: Record<string, (context: ViewContext) => Promise<object> | AsyncIterable<unknown>>,
    ): Record<string, (context: ViewContext) => Promise<object> | AsyncIterable<unknown>> =>
        Object.fromEntries(
            Object.entries(views).map(([key, read]) => [
                key,
                (context: ViewContext) => {
                    const value = read(context);
                    if (!(Symbol.asyncIterator in value))
                        return value.then(async (whole) => ({
                            ...whole,
                            looks: await ports.looksOf(context, key, thingsDrawn(key, whole)),
                        }));
                    return (async function* () {
                        let first = true;
                        for await (const part of value) {
                            const patched = patchOf(part);
                            const carried = (patched ? patched.value : part) as object;
                            const looks = await ports.looksOf(context, key, thingsDrawn(key, carried), {
                                adding: !first,
                            });
                            first = false;
                            yield patched ? patch({ ...carried, looks }) : { ...carried, looks };
                        }
                    })();
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
                if (book === undefined) return NO_WORLD;
                const [world, usedInThisChat] = await Promise.all([
                    ports.readWorld(context.user, book),
                    ports.chatReadsWorld(context, book),
                ]);
                return world ? { ...world, usedInThisChat } : NO_WORLD;
            },
            [CARD_VIEW]: async (context: ViewContext): Promise<CardView> => {
                const asked = stateOf(context.session).card;
                if (asked === null) return NO_CARD;
                const shown = { relations: CARD_RELATIONS_SHOWN, textCharacters: CARD_TEXT_CHARACTERS };
                const [reads, why] = await Promise.all([
                    Promise.all(asked.entries.map((at) => ports.readCard(context.user, at.book, at.entry, shown))),
                    asked.reply === null
                        ? asked.entries.map(() => null)
                        : ports.broughtUpBy(context, asked.reply, asked.entries),
                ]);
                const cards = asked.entries.flatMap((at, i): HoverCard[] => {
                    const read = reads[i];
                    return read ? [{ ...at, ...read, broughtUpBy: why[i] ?? null }] : [];
                });
                return { asked, cards };
            },
            [OVERVIEW_VIEW]: readOverviewView,
            [VIEWS_VIEW]: async (context: ViewContext): Promise<ViewsView> => {
                const state = stateOf(context.session).view;
                if (!state) return NO_VIEWS;
                const stored = await ports.readViews(context.user, state.book);
                if (!stored) return NO_VIEWS;
                const ownIds = new Set(stored.reader.own.map((view) => view.id));
                const tabs = tabsOf(stored).map((view) => ({
                    id: view.id,
                    name: view.name,
                    shape: shapeOf(view.id === state.id && state.draft ? state.draft : view),
                    own: ownIds.has(view.id),
                    changed: stored.reader.changed[view.id] !== undefined,
                }));
                const saved = tabsOf(stored).find((view) => view.id === state.id) ?? null;
                const shown = state.draft ?? saved;
                return {
                    book: state.book,
                    tabs,
                    current: saved ? state.id : null,
                    shown,
                    unsaved: saved !== null && state.draft !== null && !sameView(state.draft, saved),
                };
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
            [AXES_VIEW]: readAxesView,
            [FOUND_VIEW]: readFoundView,
            [CHARACTERS_FOUND_VIEW]: readCharactersFoundView,
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
        followChat: [WORLD_VIEW],
        gone: (session) => {
            bySession.delete(session);
        },
        actions: {
            'worldbuilding.openOverview': (context, { book, ...shown }) => showWorld(context, book, shown),
            'worldbuilding.showMore': withOverview(async (context, overview, { to }) => {
                if (to <= overview.endRank) return { changed: [] };
                rememberOverview(context.session, { ...overview, endRank: to });
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
                    layout: overview.layout,
                    ahead: overview.endRank,
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
            'worldbuilding.openNamed': async (context, { world, uid, overview, pointingAt }) => {
                const book = await ports.worldNamed(context.user, world);
                if (book === null) return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                const entry = uid === null ? null : await ports.entryOfUid(context.user, book, uid);
                if (uid !== null && entry === null) return { refused: NO_SUCH_ENTRY };
                return openAt(context, book, entry, overview, pointingAt);
            },
            'worldbuilding.openAt': async (context, { book, entry, overview, pointingAt }) => {
                if (entry !== null && !(await ports.entryIn(context.user, book, entry)))
                    return { refused: NO_SUCH_ENTRY };
                return openAt(context, book, entry, overview, pointingAt);
            },
            'worldbuilding.openCharacterBook': async (context, { character, overview }) => {
                const book = await ports.characterBook(context.user, character);
                if (book === null) return { refused: NO_CHARACTER_BOOK };
                const held = overviewOf(context.session);
                const groupBy = held?.book === book ? held.groupBy : undefined;
                return showWorld(context, book, { ...overview, groupBy, around: null }, false);
            },
            'worldbuilding.showCard': async (context, { entries, reply }) => {
                remember(context.session, { card: { entries, reply } });
                return { changed: [], opensViews: [CARD_VIEW] };
            },
            'worldbuilding.setWorldDescription': async (context, { book, description }) => {
                const done = await ports.setWorldDescription(who(context), book, description);
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                return { changed: [WORLD_VIEW] };
            },
            'worldbuilding.setPicture': async (context, { book, entry }) => {
                if (!context.upload) return { refused: 'Choose a picture.' };
                return pictureChanged(await ports.setPicture(who(context), book, entry, context.upload), entry);
            },
            'worldbuilding.removePicture': async (context, { book, entry }) =>
                pictureChanged(await ports.setPicture(who(context), book, entry, null), entry),
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
                if ('refused' in done) return { refused: done.refused };
                forgetWorld(book);
                if (shown?.book === book) {
                    const opened = await showWorld(context, done.next, {
                        layout: shown.layout,
                        ahead: shown.endRank,
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
                if ('refused' in exported) return { refused: exported.refused };
                return { changed: [], answer: exported };
            },
            'worldbuilding.setUsedInEveryChat': async (context, { changes }) => {
                const done = await ports.setUsedInEveryChat(who(context), changes);
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                if (done !== 'ok') return { refused: done.refused };
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
                return setFilterOf(context, book, query, chips, pageSize);
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
            'worldbuilding.changeCharacterFilter': (context, { book, entry, change }) =>
                entryEdited(context, book, entry, { change: 'characterFilter', filter: change }),
            'worldbuilding.findCharacters': async (context, { query }) => {
                remember(context.session, { findingCharacters: query });
                return { changed: [], opensViews: [CHARACTERS_FOUND_VIEW] };
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
            'worldbuilding.showView': async (context, { book, view, overview }) => {
                const stored = await ports.readViews(context.user, book);
                if (!stored) return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                const tabs = tabsOf(stored);
                const chosen = view === null ? null : tabs.find((tab) => tab.id === view);
                if (chosen === undefined) return { refused: NO_SUCH_VIEW, changed: [VIEWS_VIEW] };
                if (chosen === null && tabs.length > 0) return { refused: NO_SUCH_VIEW, changed: [VIEWS_VIEW] };
                return showViewOf(context, book, view, null, chosen, overview);
            },
            'worldbuilding.changeView': async (context, { book, change, overview }) => {
                const shown = await viewShown(context.user, context.session);
                if (!shown || shown.state.book !== book) return { refused: NO_VIEW_SHOWN, changed: [VIEWS_VIEW] };
                const draft: SavedView = {
                    ...shown.shown,
                    ...(change.groupBy === undefined ? {} : { groupBy: change.groupBy }),
                    ...(change.drawing === undefined ? {} : { drawing: change.drawing }),
                    ...(change.fields === undefined ? {} : { fields: change.fields }),
                    ...(change.columns === undefined ? {} : { columns: change.columns }),
                    ...(change.rows === undefined ? {} : { rows: change.rows }),
                };
                if (change.groupBy === undefined) {
                    const axesChanged = change.columns !== undefined || change.rows !== undefined;
                    remember(context.session, {
                        view: { ...shown.state, draft },
                        ...(axesChanged ? { cellPages: null } : {}),
                    });
                    return { changed: [VIEWS_VIEW, OVERVIEW_VIEW, RESULTS_VIEW, AXES_VIEW] };
                }
                return showViewOf(context, book, shown.state.id, draft, draft, overview);
            },
            'worldbuilding.saveView': async (context, { book }) => {
                const shown = await viewShown(context.user, context.session);
                if (!shown || shown.state.book !== book) return { refused: NO_VIEW_SHOWN, changed: [VIEWS_VIEW] };
                if (!shown.state.draft) return { changed: [VIEWS_VIEW] };
                const { reader } = shown.stored;
                const own = reader.own.some((view) => view.id === shown.state.id);
                const next = own
                    ? { ...reader, own: reader.own.map((view) => (view.id === shown.state.id ? shown.shown : view)) }
                    : { ...reader, changed: { ...reader.changed, [shown.saved.id]: shown.shown } };
                const done = await ports.writeReaderViews(who(context), book, next);
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                remember(context.session, { view: { ...shown.state, draft: null } });
                return { changed: [VIEWS_VIEW] };
            },
            'worldbuilding.discardView': async (context, { book, overview }) => {
                const shown = await viewShown(context.user, context.session);
                if (!shown || shown.state.book !== book) return { refused: NO_VIEW_SHOWN, changed: [VIEWS_VIEW] };
                return showViewOf(context, book, shown.state.id, null, shown.saved, overview);
            },
            'worldbuilding.resetView': async (context, { book, overview }) => {
                const shown = await viewShown(context.user, context.session);
                if (!shown || shown.state.book !== book) return { refused: NO_VIEW_SHOWN, changed: [VIEWS_VIEW] };
                const { reader, world } = shown.stored;
                const worlds = world.find((view) => view.id === shown.state.id);
                if (!worlds) return { refused: NOT_THE_WORLDS_VIEW };
                const { [shown.saved.id]: _dropped, ...changed } = reader.changed;
                const done = await ports.writeReaderViews(who(context), book, { ...reader, changed });
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                return showViewOf(context, book, shown.state.id, null, worlds, overview);
            },
            'worldbuilding.addView': async (context, { book, overview }) => {
                const stored = await ports.readViews(context.user, book);
                if (!stored) return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                const shown = await viewShown(context.user, context.session);
                const ids = new Set(tabsOf(stored).map((view) => view.id));
                let n = stored.reader.own.length + 1;
                while (ids.has(`own-${n}`)) n++;
                const groupBy = overviewOf(context.session)?.groupBy ?? null;
                const made: SavedView = {
                    ...(shown?.state.book === book
                        ? shown.shown
                        : { groupBy, drawing: 'cards', fields: [], query: '', chips: [], columns: [], rows: [] }),
                    id: `own-${n}`,
                    name: NEW_VIEW_NAME,
                };
                const done = await ports.writeReaderViews(who(context), book, {
                    ...stored.reader,
                    own: [...stored.reader.own, made],
                });
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                return showViewOf(context, book, made.id, null, made, overview);
            },
            'worldbuilding.renameView': async (context, { book, view, name }) => {
                const stored = await ports.readViews(context.user, book);
                if (!stored) return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                const { reader } = stored;
                const renamed = <T extends { name: string }>(held: T): T => ({ ...held, name });
                const done = reader.own.some((own) => own.id === view)
                    ? await ports.writeReaderViews(who(context), book, {
                          ...reader,
                          own: reader.own.map((own) => (own.id === view ? renamed(own) : own)),
                      })
                    : await ports.changeWorldView(
                          who(context),
                          book,
                          view,
                          { name },
                          {
                              ...reader,
                              changed: Object.fromEntries(
                                  Object.entries(reader.changed).map(([id, held]) => [
                                      id,
                                      id === view ? renamed(held) : held,
                                  ]),
                              ),
                          },
                      );
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                if (done === 'no view') return { refused: NO_SUCH_VIEW, changed: [VIEWS_VIEW] };
                const state = stateOf(context.session).view;
                if (state?.book === book && state.id === view && state.draft)
                    remember(context.session, { view: { ...state, draft: renamed(state.draft) } });
                return { changed: [VIEWS_VIEW] };
            },
            'worldbuilding.deleteView': async (context, { book, view, overview }) => {
                const stored = await ports.readViews(context.user, book);
                if (!stored) return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                const { reader } = stored;
                const own = reader.own.some((held) => held.id === view);
                const { [view]: _dropped, ...changed } = reader.changed;
                const done = own
                    ? await ports.writeReaderViews(who(context), book, {
                          ...reader,
                          own: reader.own.filter((held) => held.id !== view),
                      })
                    : await ports.changeWorldView(who(context), book, view, { deleted: true }, { ...reader, changed });
                if (done === 'missing') return { refused: WORLD_GONE, changed: [WORLDS_VIEW] };
                if (done === 'no view') return { refused: NO_SUCH_VIEW, changed: [VIEWS_VIEW] };
                const state = stateOf(context.session).view;
                if (state?.book !== book || state.id !== view) return { changed: [VIEWS_VIEW] };
                const left = await ports.readViews(context.user, book);
                const next = left ? (tabsOf(left)[0] ?? null) : null;
                return showViewOf(context, book, next?.id ?? null, null, next, overview);
            },
            'worldbuilding.showMoreInCell': async (context, { book, column, row }) => {
                const shown = await viewShown(context.user, context.session);
                if (!shown || shown.state.book !== book) return { refused: NO_VIEW_SHOWN, changed: [VIEWS_VIEW] };
                const { columns, rows } = shown.shown;
                if (!cellsOf(columns.length, rows.length).some((cell) => cell.column === column && cell.row === row))
                    return { refused: NOT_A_CELL, changed: [AXES_VIEW] };
                const held = stateOf(context.session).cellPages;
                const pages = held && held.book === book && held.view === shown.state.id ? held.pages : {};
                const key = cellKey(column, row);
                remember(context.session, {
                    cellPages: { book, view: shown.state.id, pages: { ...pages, [key]: (pages[key] ?? 1) + 1 } },
                });
                return { changed: [AXES_VIEW] };
            },
            'worldbuilding.moveBetweenCells': async (
                context,
                { book, entry, from, to, keepBoth, after, before, loopCheckLimit },
            ) => {
                const shown = await viewShown(context.user, context.session);
                if (!shown || shown.state.book !== book) return { refused: NO_VIEW_SHOWN, changed: [VIEWS_VIEW] };
                const { columns, rows } = shown.shown;
                const cells = cellsOf(columns.length, rows.length);
                const isCell = (at: { column: number | null; row: number | null }) =>
                    cells.some((cell) => cell.column === at.column && cell.row === at.row);
                if (!isCell(from) || !isCell(to)) return { refused: NOT_A_CELL, changed: [AXES_VIEW] };
                const slot = { after, before };
                const changes: RelationChange[] = [];
                const crossed = [
                    { axis: columns, from: from.column, to: to.column, slot },
                    { axis: rows, from: from.row, to: to.row, slot: { after: null, before: null } },
                ];
                for (const crossing of crossed) {
                    if (crossing.from === null || crossing.to === null) continue;
                    const was = crossing.axis[crossing.from] as AxisItem;
                    const now = crossing.axis[crossing.to] as AxisItem;
                    const target = directTarget(now);
                    const source = directTarget(was);
                    if (crossing.from === crossing.to) {
                        if (target !== null && changes.length === 0 && crossing.slot === slot)
                            changes.push({
                                change: 'move',
                                entry,
                                kind: now.kind,
                                target,
                                newTarget: target,
                                ...slot,
                            });
                        continue;
                    }
                    if (target === null) return { refused: NO_DROP_HERE };
                    if (source !== null && was.kind === now.kind && !keepBoth)
                        changes.push({
                            change: 'move',
                            entry,
                            kind: now.kind,
                            target: source,
                            newTarget: target,
                            ...crossing.slot,
                        });
                    else {
                        changes.push({ change: 'add', entry, kind: now.kind, target, weak: false, ...crossing.slot });
                        if (source !== null && !keepBoth)
                            changes.push({ change: 'remove', entry, kind: was.kind, target: source });
                    }
                }
                const moving = changes.filter(
                    (change) => change.change !== 'move' || change.target !== change.newTarget,
                );
                const applied = moving.length > 0 ? moving : changes;
                const last = applied.at(-1);
                if (!last) return { changed: [] };
                const answer = await ports.changeRelations(who(context), book, applied, loopCheckLimit);
                if (answer === 'missing') return { refused: WORLD_GONE };
                if ('refused' in answer) return { refused: answer.refused, changed: [...VIEWS_OF_CARDS] };
                const target = last.change === 'move' ? last.newTarget : last.target;
                remember(context.session, {
                    lastChange: {
                        ...NOTHING_CHANGED,
                        changedRelation: { book, entry, kind: last.kind, target },
                        loops: { book, found: answer.unreachedLoops },
                    },
                });
                return { changed: [...VIEWS_OF_CARDS, LAST_CHANGE_VIEW], own: [AXES_VIEW, LAST_CHANGE_VIEW] };
            },
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
