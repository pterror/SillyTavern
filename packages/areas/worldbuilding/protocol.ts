import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';
import type { Looks, Named } from '@st/protocol/looks';
import { READS_OF_LOOKS_BESIDES_THINGS } from '@st/looks/protocol';

export const OVERVIEW_VIEW = 'worldbuilding.overview';
export const RELATION_KINDS_VIEW = 'worldbuilding.relationKinds';
export const LAST_CHANGE_VIEW = 'worldbuilding.lastChange';
export const LOOPS_LEFT_BY_JOBS_VIEW = 'worldbuilding.loopsLeftByJobs';
export const ENTRY_VIEW = 'worldbuilding.entry';
export const WORLDS_VIEW = 'worldbuilding.worlds';
export const WORLD_VIEW = 'worldbuilding.world';
export const POINTING_AT_VIEW = 'worldbuilding.pointingAt';
export const RESULTS_VIEW = 'worldbuilding.results';
export const FOUND_VIEW = 'worldbuilding.found';
export const CHARACTERS_FOUND_VIEW = 'worldbuilding.charactersFound';
export const SELECTION_VIEW = 'worldbuilding.selection';
export const BULK_JOBS_VIEW = 'worldbuilding.bulkJobs';
export const KEY_SHARERS_VIEW = 'worldbuilding.keySharers';
export const KEY_SUGGESTIONS_VIEW = 'worldbuilding.keySuggestions';
export const CARD_VIEW = 'worldbuilding.card';
export const VIEWS_VIEW = 'worldbuilding.views';
export const AXES_VIEW = 'worldbuilding.axes';

export const FOUND_PER_QUERY = 20;
export const CHARACTERS_FOUND_PER_QUERY = 20;
// Characters and tags an entry's filter names that its page labels; past them it says how many more.
export const FILTER_ITEMS_SHOWN = 50;
// One `/world` command's worlds, set used in every chat or not in one request.
export const WORLDS_CHANGED_AT_MOST = 1000;
export const MENTIONS_PER_PAGE = 20;
export const KEY_SHARERS_SHOWN = 20;
// One read of the keys that start with what is typed: a key read each.
export const KEY_SUGGESTIONS_SHOWN = 8;
export const SELECTION_COUNTED_UP_TO = 1000;
// A board's or grid's columns and rows each, and the cards a cell draws first and adds each time more are asked for.
export const AXIS_ITEMS_AT_MOST = 6;
export const CELL_CARDS_PER_PAGE = 6;
export const CELL_COUNTED_UP_TO = 1000;
// The region heads a cell draws above each entry in it (engine/src/store/world_cells.rs, HEADS_ABOVE): a cell draws at
// most this many cards more than its entries for each of them.
export const CELL_HEADS_ABOVE = 2;
export const LOOPS_SHOWN = 3;
// The hover card's relations and the characters of its text's opening.
export const CARD_RELATIONS_SHOWN = 6;
export const CARD_TEXT_CHARACTERS = 300;
// The entries one hover card shows: a word can bring up several.
export const CARD_ENTRIES_AT_MOST = 8;
export const ENTRIES_NAMED_PER_LOOP = 3;

// One part of an answer: 200 ms at an assumed 8 µs a read (docs/design/worldbuilding-store.md, One request's budget).
export const READS_PER_REQUEST = 24_000;
// A job's step, and a write's chunk, changes at most this many entries, relations or sources.
export const RELATION_CHANGES_PER_STEP = 1000;
// A card reads its title, text, keys, names and relations, and per relation the kind's name and the target's
// label (its title, keys, names and, with neither a title nor a name, its text): 10 with one relation.
export const READS_PER_CARD = 10;
// A drawn name's look reads the thing's own look; the theme, its world's and the shared looks are read once per view.
export const READS_PER_LOOK = 1;
// A drawn card's own name and its relation's target, each in its look.
export const READS_PER_DRAWN_CARD = READS_PER_CARD + 2 * READS_PER_LOOK;
// A label reads the entry's title, keys, names and, with neither a title nor a name, its text; and its look.
export const READS_PER_LABEL = 4 + READS_PER_LOOK;
export const READS_PER_LOOP_CHECK_VISIT = 2;
// An entry checked for a mention reads its place (in the world's order, or in the index's list for a name), whether it
// is in the world, and its text's head and record; one that mentions the entry, its label and its picture too.
export const READS_PER_PICTURE = 1;
export const READS_PER_MENTION_CHECK = 4 + READS_PER_LABEL + READS_PER_PICTURE;
// The reads bounded by a count of labels: the key's sharers, the loops of the last change and of the jobs (each loop
// its entry, its target and the entries it names), and the world header's example; and the targets found, each read
// as a card with its picture.
export const READS_OF_COUNTED_LABELS =
    (KEY_SHARERS_SHOWN + 2 * LOOPS_SHOWN * (2 + ENTRIES_NAMED_PER_LOOP) + 1) * READS_PER_LABEL +
    FOUND_PER_QUERY * (READS_PER_DRAWN_CARD + READS_PER_PICTURE);
// An answer's first part holds the action's own work and the views it names its own; every other view is a later part
// of its own. So a part holds at most one view's bounded reads and one action's work, besides the counted labels.
// The action's work: a write's loop check walks up from each source it changed (at most a step's) and, sharing one
// visited set, about one ancestor of each; a step crossing top-level entries, or the results' walk, gets as much.
export const LOOP_CHECK_VISITS_PER_WRITE = 2 * RELATION_CHANGES_PER_STEP;
export const READS_OF_ACTION = LOOP_CHECK_VISITS_PER_WRITE * READS_PER_LOOP_CHECK_VISIT;
export const STEP_CARDS_AT_MOST = Math.floor(READS_OF_ACTION / READS_PER_CARD);
// A walk of a chip's region (the results, a selection's count, a bulk chunk with no words) reads a key a step.
export const WALK_STEPS_PER_READ = READS_OF_ACTION;
// One view's bounded reads: the rest of a part.
// The views of a part that draw names (the overview, the world, the worlds, the entry, what points at it, the last
// change) each read the looks besides their things' own once.
export const READS_OF_LOOKS_PER_PART = 6 * READS_OF_LOOKS_BESIDES_THINGS;
export const READS_PER_VIEW = READS_PER_REQUEST - READS_OF_COUNTED_LABELS - READS_OF_ACTION - READS_OF_LOOKS_PER_PART;
export const MAX_CARDS_PER_READ = Math.floor(READS_PER_VIEW / READS_PER_DRAWN_CARD);
// The entry view reads the names its text writes and what mentions it, in halves. Looking for the names reads one key
// per seek of the names index, per entry listed under a name found and per name checked one by one, and two (its case
// and whole-word flags) per entry it names, whose look and picture are one more each.
const READS_PER_LINKED_ENTRY = READS_PER_LOOK + READS_PER_PICTURE;
export const TEXT_LINK_READS_PER_READ = Math.floor(READS_PER_VIEW / 2 / (1 + READS_PER_LINKED_ENTRY / 2));
export const READS_OF_TEXT_LINKS =
    TEXT_LINK_READS_PER_READ + Math.ceil(TEXT_LINK_READS_PER_READ / 2) * READS_PER_LINKED_ENTRY;
// An old answer that carries a chat's messages (its open, a reply, an edit, a swipe, messages shown later) looks through
// them for the names of the entries of the chat's worlds, newest first, in one part's budget, besides the looks of the
// chat's speakers and of the entries named: a read as the entry's text does, and for every two (an entry named) its
// look and where it opens.
export const READS_PER_CHAT_LINKED_ENTRY = READS_PER_LOOK + 1;
export const CHAT_TEXT_LINK_READS_PER_ANSWER = Math.floor(
    (READS_PER_REQUEST - 2 * READS_OF_LOOKS_BESIDES_THINGS) / (1 + READS_PER_CHAT_LINKED_ENTRY / 2),
);
export const MENTION_CHECKS_PER_READ = Math.floor((READS_PER_VIEW - READS_OF_TEXT_LINKS) / READS_PER_MENTION_CHECK);
export const MENTION_PAGES_AT_MOST = Math.floor(MAX_CARDS_PER_READ / MENTIONS_PER_PAGE);
export const PICKED_AT_MOST = MAX_CARDS_PER_READ;
// The selection's count checks each picked entry it leaves out (one read each), then walks.
export const SELECTION_WALK_STEPS = READS_PER_VIEW - PICKED_AT_MOST;

// A world's fields as its search index numbers them, and the labels its search syntax gives them.
export const WORLD_FIELD = Object.freeze({
    key: 0,
    group: 1,
    title: 2,
    secondary: 3,
    text: 4,
    uid: 5,
    automationId: 6,
});

export const WORLD_LABELS = Object.freeze({
    key: [WORLD_FIELD.key],
    keys: [WORLD_FIELD.key],
    title: [WORLD_FIELD.title],
    text: [WORLD_FIELD.text],
    group: [WORLD_FIELD.group],
    secondary: [WORLD_FIELD.secondary],
});

export type { Named };

// Every view of the area carries the looks of the names it draws.
export type Drawn<T> = T & { looks: Looks };

export type RelationOnCard = {
    kind: string;
    kindName: string | null;
    targetKey: string | null;
    targetEntry: string;
    target: Named | null;
    targetDeleted: boolean;
    inUse: boolean;
    weak: boolean;
};

export type EntryCell = {
    cell: 'entry';
    occurrence: string;
    entry: string;
    entryKey: string;
    label: Named;
    // The URL of the entry's picture.
    picture: string | null;
    title: string | null;
    text: string;
    textCut: boolean;
    keys: string[];
    names: string[];
    relations: RelationOnCard[];
    groupingKindRelationsTargetingThis: number;
    alreadyOpenAbove: boolean;
    region: RegionCell[];
    facts?: EntryFacts;
};

export type PlaceOfDeletedEntryCell = {
    cell: 'placeOfDeletedEntry';
    occurrence: string;
    entryKey: null;
    groupingKindRelationsTargetingThis: number;
    alreadyOpenAbove: boolean;
    region: RegionCell[];
};

export type NotShownTile = {
    cell: 'notShownTile';
    occurrence: string;
    groupingKindRelationsTargetingRegionEntryNotShown: number;
};

export type RegionCell = EntryCell | PlaceOfDeletedEntryCell | NotShownTile;

export type StepLanding = { occurrence: string; topLevelRank: number };

export type RegionLayout = { columns: number; rows: number };

export type OverviewLayout = { regionsByNestingLevel: RegionLayout[]; cardTextCharacters: number };

export type OverviewCell = (EntryCell | PlaceOfDeletedEntryCell) & { topLevelRank: number };

// One read's worth of top-level entries: page `k` holds the ranks from `k * pageSize`.
export type OverviewPage = { firstRank: number; entries: OverviewCell[] };

// The top-level entries the tab has read, from the first: `pageCount` pages of `pageSize`, read in parts, each page a
// part of its own. A page past `pageCount` is null or missing.
export type OverviewView = {
    book: string | null;
    groupBy: string | null;
    topLevelCount: number;
    pageSize: number;
    pageCount: number;
    pages: Record<string, OverviewPage | null>;
};

export type RelationKind = { id: string; name: string; mergingInto: string | null };

export type RelationKindsView = { book: string | null; kinds: RelationKind[] };

export type UnreachedLoop = { entry: string; kind: string; entries: string[] };

// `entry`'s relation of `kind` to `target` is the one its loop check walked first; `entries` are the first
// ENTRIES_NAMED_PER_LOOP the loop holds, `moreEntries` how many more it does.
export type ShownLoop = {
    entry: Named;
    kind: string;
    kindName: string | null;
    target: Named | null;
    entries: Named[];
    moreEntries: number;
};

export type ShownLoops = { unreachedLoops: ShownLoop[]; moreUnreachedLoops: number };

export type LoopsLeftByJobsView = { book: string | null } & ShownLoops;

export type ChangedRelation = { book: string; entry: string; kind: string; target: string };

export type EntryAt = { book: string; entry: string };

export type LastChangeView = {
    createdKind: { book: string; kind: string } | null;
    changedRelation: ChangedRelation | null;
    createdEntry: EntryAt | null;
    deletedEntry: (EntryAt & { label: Named }) | null;
    movedEntry: (EntryAt & { toBook: string; newEntry: string }) | null;
    markedTitleKeys: { book: string } | null;
} & ShownLoops;

export type KeyOfEntry = { text: string; isName: boolean; alsoBringsUp: number };

export type Sentence = { before: string; mention: string; after: string };

// A page read at `cursor` (null: the first), and the cursor of the page after it (null: the last). `lookedThrough`
// counts the entries looked through from the first page to this one's end; `stoppedForBound` says the page ended at
// the read's MENTION_CHECKS_PER_READ with more to look through, not because it filled or the world ended.
export type MentionsPage = {
    cursor: string | null;
    entries: { from: Named; picture: string | null; sentence: Sentence }[];
    next: string | null;
    lookedThrough: number;
    stoppedForBound: boolean;
};

// The run of pages the page asked for: the first at the cursor asked from, each next the page after the one before.
// One read looks through at most MENTION_CHECKS_PER_READ entries in all, so the run ends at a page that stopped for
// it.
export type MentionedIn = { pages: MentionsPage[] };

// Where the entry's text names another entry: `from` and `to` are UTF-16 offsets into `text`, in order, never overlapping.
// `linksComplete` is false when the read stopped at TEXT_LINK_READS_PER_READ before it had looked for every name, so
// words it hadn't reached may be names it doesn't link. `picture` is the linked entry's own picture.
export type TextLink = { entry: string; from: number; to: number; picture: string | null };

export const TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'] as const;

const wholeNumber = v.pipe(v.number(), v.integer());
const atLeastZero = v.pipe(wholeNumber, v.minValue(0));
const finiteNumber = v.pipe(v.number(), v.finite());

export const placementFields = {
    keysecondary: v.array(v.string()),
    constant: v.boolean(),
    vectorized: v.boolean(),
    selective: v.boolean(),
    selectiveLogic: v.picklist([0, 1, 2, 3]),
    addMemo: v.boolean(),
    order: finiteNumber,
    position: v.picklist([0, 1, 2, 3, 4, 5, 6, 7]),
    disable: v.boolean(),
    ignoreBudget: v.boolean(),
    excludeRecursion: v.boolean(),
    preventRecursion: v.boolean(),
    matchPersonaDescription: v.boolean(),
    matchCharacterDescription: v.boolean(),
    matchCharacterPersonality: v.boolean(),
    matchCharacterDepthPrompt: v.boolean(),
    matchScenario: v.boolean(),
    matchCreatorNotes: v.boolean(),
    delayUntilRecursion: v.union([v.boolean(), atLeastZero]),
    probability: v.pipe(finiteNumber, v.minValue(0), v.maxValue(100)),
    useProbability: v.boolean(),
    depth: v.pipe(atLeastZero, v.maxValue(1000)),
    outletName: v.string(),
    group: v.string(),
    groupOverride: v.boolean(),
    groupWeight: v.pipe(wholeNumber, v.minValue(1), v.maxValue(10_000)),
    scanDepth: v.nullable(v.pipe(atLeastZero, v.maxValue(1000))),
    caseSensitive: v.nullable(v.boolean()),
    matchWholeWords: v.nullable(v.boolean()),
    useGroupScoring: v.nullable(v.boolean()),
    automationId: v.string(),
    role: v.picklist([0, 1, 2]),
    sticky: v.nullable(atLeastZero),
    cooldown: v.nullable(atLeastZero),
    delay: v.nullable(atLeastZero),
    triggers: v.array(v.picklist(TRIGGERS)),
    characterFilter: v.object({ isExclude: v.boolean(), names: v.array(v.string()), tags: v.array(v.string()) }),
};

export type Placement = v.InferOutput<v.ObjectSchema<typeof placementFields, undefined>>;

export type OpenEntryView = EntryAt & {
    deleted: false;
    entryKey: string;
    version: EntryVersion;
    label: Named;
    picture: string | null;
    title: string | null;
    keys: KeyOfEntry[];
    text: string;
    links: TextLink[];
    linksComplete: boolean;
    relations: RelationOnCard[];
    placement: Placement;
    placementDiffersFromDefaults: boolean;
    tokens: number | null;
    characterFilter: CharacterFilterShown;
    mentionedIn: MentionedIn;
};

// Upstream's filter names a character by its avatar file's name without the extension (`key`) and a tag by its key;
// `named`/`name` is null for one this user has no character or tag for.
export type FilteredCharacter = { key: string; named: Named | null; picture: string | null };
export type FilteredTag = { key: string; name: string | null };
export type CharacterFilterShown = {
    exclude: boolean;
    characters: FilteredCharacter[];
    tags: FilteredTag[];
    more: number;
};

export type CharactersFoundView =
    | { query: string; characters: FilteredCharacter[]; tags: { key: string; name: string }[] }
    | { query: null };

export type FilterItem = { character: string } | { tag: string };

export type DeletedEntryView = EntryAt & { deleted: true; label: Named | null };

export type PointingAtSection = {
    kind: string;
    kindName: string | null;
    count: number;
    firstRank: number;
    entries: (EntryCell & { topLevelRank: number })[];
    stepLanding: StepLanding | null;
};

export type PointingAtView = (EntryAt & { sections: PointingAtSection[] }) | { book: null };

export type PointingAtShown = { endRank: number; layout: OverviewLayout };

export type EntryView = OpenEntryView | DeletedEntryView | { book: null };

// The world's keys that start with `typed`, in byte order, the first KEY_SUGGESTIONS_SHOWN of them, each with the number
// of keys of the world with that text.
export type KeySuggestionsView =
    | { book: string; typed: string; suggestions: { text: string; keys: number }[] }
    | { book: null };

// The other entries of the open entry's world that have `key` among their keys, the first KEY_SHARERS_SHOWN of them.
export type KeySharersView = (EntryAt & { key: string; entries: Named[]; more: boolean }) | { book: null };

// `picture`: the URL of the world's picture.
export type World = { id: string; name: string; entries: number; usedInEveryChat: boolean; picture: string | null };

export type WorldsView = { worlds: World[] };

// `entries`: live entries with a key that has their title's words and isn't a name; `example` is the first of them, null
// only while a job runs and none is left; `marked`: entries the offer has marked and Undo would take back.
export type NamesOffer = {
    entries: number;
    example: Named | null;
    running: 'marking' | 'undoing' | null;
    marked: number;
};

// `usedInThisChat`: a reply in the tab's chat reads the world. `cameWith`: the character whose own lorebook the world is
// (its card carries it); such a world is not among the worlds listed and is opened by its character.
export type OpenWorldView = World & {
    namesOffer: NamesOffer | null;
    description: string;
    usedInThisChat: boolean;
    cameWith: Named | null;
};

export type WorldView = OpenWorldView | { id: null };

// What pointing at an entry's name shows: the first CARD_RELATIONS_SHOWN of its relations, and its text's first
// CARD_TEXT_CHARACTERS characters. `broughtUpBy`: the keys that brought it into the reply the card was asked about, in
// the order activation found them; null when no reply was named or the entry didn't come up for it.
export type HoverCard = EntryAt & {
    label: Named;
    picture: string | null;
    relations: RelationOnCard[];
    moreRelations: number;
    text: string;
    textCut: boolean;
    broughtUpBy: string[] | null;
};

export type CardAsked = { entries: EntryAt[]; reply: string | null };

// The cards of the entries `asked` names that are still there, in its order; `asked` null: none was asked for.
export type CardView = { asked: CardAsked | null; cards: HoverCard[] };

export type ExportedWorld = { fileName: string; json: string };

export type Depth = 'directly' | 'anyDepth';

export type Chip = { kind: string; target: string; depth: Depth };

// What a drawn card or row shows of how the entry comes into the prompt. `comesIn`: upstream's `constant` and `disable`;
// `chance` is null when it comes in every time; `tokens` is null unless the view's rows show it.
// An entry's version: an edit names the one it was made against.
export type EntryVersion = string;

// An edit that can't merge with what another tab changed since its version: the version the entry now is, and each
// field both changed (its path in the entry, as `content` or `characterFilter.isExclude`), with both sides' values. For
// a text field, `merged` holds both texts laid together and `diff` runs from mine to theirs, word by word.
export type EntryConflict = {
    book: string;
    entry: string;
    version: EntryVersion;
    fields: ConflictField[];
};
export type ConflictField = {
    field: string;
    mine: unknown;
    theirs: unknown;
    merged: string | null;
    diff: DiffRun[] | null;
};
export type DiffRun = { text: string; in: 'both' | 'mine' | 'theirs' };
export type ConflictAnswer = { conflict: EntryConflict };

export type EntryFacts = {
    version: EntryVersion;
    comesIn: 'always' | 'broughtUp' | 'never';
    keysecondary: string[];
    selectiveLogic: Placement['selectiveLogic'];
    position: Placement['position'];
    depth: number;
    order: number;
    chance: number | null;
    tokens: number | null;
};

export const ROW_FIELDS = ['relations', 'names', 'triggers', 'comesIn', 'goes', 'order', 'chance', 'tokens'] as const;
export type RowField = (typeof ROW_FIELDS)[number];

// One column or row of a board or grid: the entries with a relation of `kind` to a target, with any, or with none.
export type AxisItem = { kind: string; is: { target: string; depth: Depth } | 'any' | 'none' };

// How a view lists the world's entries: in the world's own order, or by a field (each field's ties by order, highest
// first, then uid). A field's sort reads the world ungrouped.
export const SORTS = ['world', 'title', 'depth', 'order', 'uid', 'probability', 'priority'] as const;
export type SortBy = (typeof SORTS)[number];
export type ViewSort = { by: SortBy; descending: boolean };
export const WORLD_SORT: ViewSort = { by: 'world', descending: false };

// A saved view. Targets are entity ids. The world file carries the author's views with targets as entries' keys (uids).
export type SavedView = {
    id: string;
    name: string;
    groupBy: string | null;
    sort: ViewSort;
    drawing: 'cards' | 'rows';
    fields: RowField[];
    query: string;
    chips: Chip[];
    columns: AxisItem[];
    rows: AxisItem[];
};

export type ViewShape = 'cards' | 'rows' | 'board' | 'grid';

export const shapeOf = (view: Pick<SavedView, 'drawing' | 'columns' | 'rows'>): ViewShape =>
    view.columns.length > 0 && view.rows.length > 0
        ? 'grid'
        : view.columns.length > 0 || view.rows.length > 0
          ? 'board'
          : view.drawing;

// A card in a board's or grid's cell, in the regions of the grouping relation's targets: a head drawn only for
// where its members are is not `inCell`.
export type CellCard = Omit<EntryCell, 'region'> & { inCell: boolean; region: CellCard[] };

// `count` stops at CELL_COUNTED_UP_TO, or where one request's reads end; `capped` says there may be more. `drops`: the
// item is a relation to one entry, so a card dropped in its column or row gets that relation.
export type AxisHeader = {
    item: AxisItem;
    kindName: string | null;
    target: Named | null;
    targetDeleted: boolean;
    count: number;
    capped: boolean;
    drops: boolean;
};

// `column` and `row` index the view's columns and rows, null when the view has none on that axis.
export type AxisCell = {
    column: number | null;
    row: number | null;
    entries: CellCard[];
    count: number;
    capped: boolean;
    more: boolean;
};

export type AxesView = { book: string; columns: AxisHeader[]; rows: AxisHeader[]; cells: AxisCell[] } | { book: null };

// `own`: the reader's own view; `changed`: the reader keeps a changed copy of the world's view.
export type ViewTab = { id: string; name: string; shape: ViewShape; own: boolean; changed: boolean };

// `shown`: the current view as the tab draws it, `unsaved` saying it differs from what is saved for the reader.
export type ViewsView =
    | { book: string; tabs: ViewTab[]; current: string | null; shown: SavedView | null; unsaved: boolean }
    | { book: null };

export type ShownChip = { kind: string; kindName: string | null; target: Named; targetDeleted: boolean; depth: Depth };

export type ResultsPage = { cursor: string | null; entries: EntryCell[]; next: string | null };

// `generation` counts the filters set, so the page tells a new filter from the one it shows; `pages` are the run the page
// asked for, as MentionedIn's are.
export type ResultsView =
    | { book: string; generation: number; filter: { query: string; chips: ShownChip[] }; pages: ResultsPage[] }
    | { book: null };

// An entry a search for a target found: its label, picture and relations, so the page can say where it sits.
export type FoundEntry = { label: Named; picture: string | null; relations: RelationOnCard[] };

export type FoundView = { book: string; query: string; entries: FoundEntry[]; next: string | null } | { book: null };

// `none`: the entries in `except` are selected; `matching`: what the shown filter (else the whole world) matches is,
// but those in `except`. `matching` counts the selected up to SELECTION_COUNTED_UP_TO, `matchingCapped` saying there may
// be more; it is null under `none`.
export type SelectionView =
    | {
          book: string;
          base: 'none' | 'matching';
          except: string[];
          matching: number | null;
          matchingCapped: boolean;
      }
    | { book: null };

export type RelationTo = { kind: string; target: string };

export type BulkAction =
    | { delete: true }
    | { set: Partial<Omit<Placement, 'characterFilter'>> }
    | { moveTo: RelationTo }
    | { alsoPutIn: RelationTo }
    | { moveToWorld: string }
    | { copyToWorld: string }
    | { fillTitles: true };

export type BulkJob = { job: string; action: BulkAction; target: Named | null; done: number };

export type BulkJobsView = { book: string; jobs: BulkJob[] } | { book: null };

export function cardsPerTopLevelEntry(levels: RegionLayout[]): number {
    let cards = 1;
    let atLevel = 1;
    for (const { columns, rows } of levels) {
        atLevel *= columns * rows;
        cards += atLevel;
        if (cards > MAX_CARDS_PER_READ) return Infinity;
    }
    return cards;
}

export function readFitsTheBudget(topLevelEntries: number, layout: OverviewLayout): boolean {
    if (topLevelEntries === 0) return true;
    return topLevelEntries * cardsPerTopLevelEntry(layout.regionsByNestingLevel) <= MAX_CARDS_PER_READ;
}

// How many top-level entries one read draws under `layout`, each with its regions as full as the layout lets them be.
export function topLevelPerRead(layout: OverviewLayout): number {
    return Math.max(1, Math.floor(MAX_CARDS_PER_READ / cardsPerTopLevelEntry(layout.regionsByNestingLevel)));
}

export function stepFitsTheBudget(topLevelEntriesCrossed: number, layout: OverviewLayout): boolean {
    return topLevelEntriesCrossed * cardsPerTopLevelEntry(layout.regionsByNestingLevel) <= STEP_CARDS_AT_MOST;
}

const entityId = v.pipe(v.string(), v.regex(/^\d+$/));
const kindId = v.pipe(v.string(), v.regex(/^[1-9]\d{0,15}$/));
const occurrenceKey = v.pipe(v.string(), v.regex(/^\d+(\/\d+)*(\/\+)?$/));
const pointingAtOccurrenceKey = v.pipe(v.string(), v.regex(/^\d+@\d+(\/\d+)+(\/\+)?$/));
const topLevelRank = v.pipe(v.number(), v.integer(), v.minValue(0));
const positiveWholeNumber = v.pipe(v.number(), v.integer(), v.minValue(1));
const kindName = v.pipe(v.string(), v.trim(), v.minLength(1));
const loopCheckLimit = v.pipe(positiveWholeNumber, v.maxValue(LOOP_CHECK_VISITS_PER_WRITE));

const layout = v.object({
    regionsByNestingLevel: v.array(v.object({ columns: positiveWholeNumber, rows: positiveWholeNumber })),
    cardTextCharacters: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const rangeFields = { firstRank: topLevelRank, endRank: topLevelRank };
type Range = { firstRank: number; endRank: number };
const rangeRunsForward = <T extends Range>(range: T) => range.endRank >= range.firstRank;
const RANGE_REFUSAL = 'The range must end after it starts.';
export const READ_REFUSAL = `Too many cards (max ${MAX_CARDS_PER_READ}). Show fewer entries, levels, columns or rows.`;

const betweenMembers = { after: v.nullable(entityId), before: v.nullable(entityId) };
const relationNamed = { book: entityId, entry: entityId, kind: kindId, target: entityId };

const entryNamed = { book: entityId, entry: entityId };
// `version`: the entry's version the edit was made against.
const entryVersion = v.pipe(v.string(), v.regex(/^\d{1,20}$/));
const editedEntry = { ...entryNamed, version: entryVersion };
const worldName = v.pipe(v.string(), v.trim(), v.minLength(1, 'Enter a world name.'));
const fitsOneEntry = <T extends { layout: OverviewLayout }>(read: T) => readFitsTheBudget(1, read.layout);
// `ahead`: how many top-level entries the page wants read to begin with, as many as fill some screens of it.
const shownOverview = v.pipe(v.object({ layout, ahead: positiveWholeNumber }), v.check(fitsOneEntry, READ_REFUSAL));
const opensWorld = { overview: shownOverview };
const pointingAtShown = v.pipe(
    v.object({ endRank: topLevelRank, layout }),
    v.check(
        <T extends { endRank: number; layout: OverviewLayout }>(shown: T) =>
            readFitsTheBudget(shown.endRank, shown.layout),
        READ_REFUSAL,
    ),
);
const keyText = v.pipe(v.string(), v.trim(), v.minLength(1));
const keyAs = v.picklist(['name', 'trigger']);
const cursor = v.pipe(v.string(), v.minLength(1));
const chip = v.object({ kind: kindId, target: entityId, depth: v.picklist(['directly', 'anyDepth']) });
const rowField = v.picklist(ROW_FIELDS);
const axisItem = v.object({
    kind: kindId,
    is: v.union([
        v.object({ target: entityId, depth: v.picklist(['directly', 'anyDepth']) }),
        v.picklist(['any', 'none']),
    ]),
});
const axis = v.pipe(v.array(axisItem), v.maxLength(AXIS_ITEMS_AT_MOST));
const cellAt = v.object({
    column: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
    row: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
});
const viewId = v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,40}$/));
const viewName = v.pipe(v.string(), v.trim(), v.minLength(1, 'Enter a view name.'), v.maxLength(80));
const viewChangeFields = v.partial(
    v.strictObject({
        groupBy: v.nullable(kindId),
        sort: v.strictObject({ by: v.picklist(SORTS), descending: v.boolean() }),
        drawing: v.picklist(['cards', 'rows']),
        fields: v.pipe(v.array(rowField), v.maxLength(ROW_FIELDS.length)),
        columns: axis,
        rows: axis,
    }),
);
export type ViewChange = v.InferOutput<typeof viewChangeFields>;
const viewChange = v.pipe(
    viewChangeFields,
    v.check((fields: ViewChange) => Object.keys(fields).length > 0, 'Nothing to change.'),
);
const placementChange = v.pipe(
    v.partial(v.omit(v.strictObject(placementFields), ['characterFilter'])),
    v.check((fields: object) => Object.keys(fields).length > 0, 'Nothing to change.'),
);
const relationTo = v.object({ kind: kindId, target: entityId });
const filterKey = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const filterItem = v.union([v.strictObject({ character: filterKey }), v.strictObject({ tag: filterKey })]);
const bulkAction = v.union([
    v.strictObject({ delete: v.literal(true) }),
    v.strictObject({ set: placementChange }),
    v.strictObject({ moveTo: relationTo }),
    v.strictObject({ alsoPutIn: relationTo }),
    v.strictObject({ moveToWorld: entityId }),
    v.strictObject({ copyToWorld: entityId }),
    v.strictObject({ fillTitles: v.literal(true) }),
]);

export const actions = {
    'worldbuilding.openOverview': v.pipe(
        v.object({
            book: v.nullable(entityId),
            // Left out: the world's default grouping.
            groupBy: v.optional(v.nullable(kindId)),
            layout,
            ahead: positiveWholeNumber,
            around: v.nullable(occurrenceKey),
        }),
        v.check(fitsOneEntry, READ_REFUSAL),
        v.check(
            <T extends { book: string | null; groupBy?: string | null | undefined; around: string | null }>(open: T) =>
                open.book !== null || ((open.groupBy ?? null) === null && open.around === null),
            'Open a world first.',
        ),
    ),
    // Reads the top-level entries up to `to` as well, keeping every one read; asking twice reads them once.
    'worldbuilding.showMore': v.object({ to: positiveWholeNumber }),
    'worldbuilding.showRelationKinds': v.object({ book: entityId }),
    'worldbuilding.createRelationKind': v.object({ book: entityId, name: kindName }),
    'worldbuilding.renameRelationKind': v.object({ book: entityId, kind: kindId, name: kindName }),
    'worldbuilding.deleteRelationKind': v.object({ book: entityId, kind: kindId }),
    'worldbuilding.mergeRelationKind': v.object({ book: entityId, kind: kindId, into: kindId }),
    'worldbuilding.addRelation': v.object({ ...relationNamed, ...betweenMembers, weak: v.boolean(), loopCheckLimit }),
    'worldbuilding.moveRelation': v.object({
        ...relationNamed,
        newTarget: entityId,
        ...betweenMembers,
        loopCheckLimit,
    }),
    'worldbuilding.removeRelation': v.object({ ...relationNamed, loopCheckLimit }),
    'worldbuilding.setRelationWeak': v.object({ ...relationNamed, weak: v.boolean(), loopCheckLimit }),
    'worldbuilding.openEntry': v.object({ entry: entityId, pointingAt: pointingAtShown }),
    'worldbuilding.showPointingAtRange': v.pipe(
        v.object({ kind: kindId, ...rangeFields }),
        v.check(rangeRunsForward, RANGE_REFUSAL),
    ),
    'worldbuilding.stepPointingAt': v.union([
        v.object({ kind: kindId, from: v.nullable(pointingAtOccurrenceKey), by: v.pipe(v.number(), v.integer()) }),
        v.object({ kind: kindId, from: pointingAtOccurrenceKey, to: v.picklist(['parent', 'firstChild']) }),
    ]),
    'worldbuilding.closeEntry': v.object({}),
    'worldbuilding.showMentions': v.object({
        from: v.nullable(cursor),
        pages: v.pipe(positiveWholeNumber, v.maxValue(MENTION_PAGES_AT_MOST)),
    }),
    'worldbuilding.setEntryText': v.object({ ...editedEntry, text: v.string() }),
    'worldbuilding.setEntryTitle': v.object({ ...editedEntry, title: v.string() }),
    // `version` null: keys added to an entry not read, as it is.
    'worldbuilding.addKeys': v.object({
        ...entryNamed,
        version: v.nullable(entryVersion),
        keys: v.pipe(v.array(keyText), v.minLength(1)),
        as: keyAs,
    }),
    'worldbuilding.renameKey': v.object({ ...editedEntry, key: keyText, to: keyText }),
    'worldbuilding.setKeyAs': v.object({ ...editedEntry, key: keyText, as: keyAs }),
    'worldbuilding.removeKey': v.object({ ...editedEntry, key: keyText }),
    'worldbuilding.showKeySharers': v.object({ ...entryNamed, key: keyText }),
    'worldbuilding.suggestKeys': v.object({ book: entityId, typed: v.string() }),
    'worldbuilding.setPlacement': v.object({ ...editedEntry, fields: placementChange }),
    'worldbuilding.changeCharacterFilter': v.object({
        ...editedEntry,
        change: v.union([
            v.strictObject({ exclude: v.boolean() }),
            v.strictObject({ add: filterItem }),
            v.strictObject({ remove: filterItem }),
        ]),
    }),
    'worldbuilding.findCharacters': v.object({ query: v.string() }),
    'worldbuilding.createEntry': v.object({
        book: entityId,
        after: v.nullable(entityId),
        name: v.nullable(keyText),
        relation: v.nullable(v.object({ kind: kindId, target: entityId })),
        open: v.nullable(v.object({ pointingAt: pointingAtShown })),
        loopCheckLimit,
    }),
    'worldbuilding.deleteEntry': v.object(entryNamed),
    'worldbuilding.restoreEntry': v.object(entryNamed),
    'worldbuilding.moveEntryToWorld': v.object({ ...entryNamed, toBook: entityId }),
    'worldbuilding.copyEntryToWorld': v.object({ ...entryNamed, toBook: entityId }),
    'worldbuilding.duplicateEntry': v.object({ ...entryNamed, loopCheckLimit }),
    // Moves an entry in the world's own order: right after `after`, or first when it is null.
    'worldbuilding.placeInWorldOrder': v.object({ ...entryNamed, after: v.nullable(entityId) }),
    // Renumbers every entry's order by its place in the shown view's sort (see applySortAsOrder in the server).
    'worldbuilding.applySortAsOrder': v.object({
        book: entityId,
        start: v.pipe(wholeNumber, v.minValue(0)),
        step: v.pipe(wholeNumber, v.minValue(1)),
        ascending: v.boolean(),
    }),
    'worldbuilding.openWorlds': v.object({}),
    // A world by its name, and in it the entry with upstream's `uid` when one is named.
    'worldbuilding.openNamed': v.object({
        world: v.pipe(v.string(), v.minLength(1)),
        uid: v.nullable(v.pipe(wholeNumber, v.minValue(0))),
        overview: shownOverview,
        pointingAt: pointingAtShown,
    }),
    // A world by its id, and in it that entry when one is named.
    'worldbuilding.openAt': v.object({
        book: entityId,
        entry: v.nullable(entityId),
        overview: shownOverview,
        pointingAt: pointingAtShown,
    }),
    'worldbuilding.openCharacterBook': v.object({ character: entityId, ...opensWorld }),
    // `reply`: the stored reply of the tab's chat whose activation says what brought each entry up.
    'worldbuilding.showCard': v.object({
        entries: v.pipe(v.array(v.object(entryNamed)), v.minLength(1), v.maxLength(CARD_ENTRIES_AT_MOST)),
        reply: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
    }),
    'worldbuilding.setWorldDescription': v.object({ book: entityId, description: v.string() }),
    // The upload is the picture; `entry` null: the world's own.
    'worldbuilding.setPicture': v.object({ book: entityId, entry: v.nullable(entityId) }),
    'worldbuilding.removePicture': v.object({ book: entityId, entry: v.nullable(entityId) }),
    'worldbuilding.createWorld': v.object({ name: worldName, ...opensWorld }),
    'worldbuilding.renameWorld': v.object({ book: entityId, name: worldName }),
    'worldbuilding.duplicateWorld': v.object({ book: entityId, ...opensWorld }),
    'worldbuilding.deleteWorld': v.object({ book: entityId }),
    'worldbuilding.importWorld': v.object(opensWorld),
    'worldbuilding.exportWorld': v.object({ book: entityId }),
    'worldbuilding.setUsedInEveryChat': v.object({
        changes: v.pipe(
            v.array(v.object({ book: entityId, used: v.boolean() })),
            v.minLength(1),
            v.maxLength(WORLDS_CHANGED_AT_MOST),
        ),
    }),
    'worldbuilding.markTitleKeysAsNames': v.object({ book: entityId }),
    'worldbuilding.declineNamesOffer': v.object({ book: entityId }),
    'worldbuilding.undoMarkTitleKeysAsNames': v.object({ book: entityId }),
    'worldbuilding.setFilter': v.object({
        book: entityId,
        query: v.string(),
        chips: v.array(chip),
        pageSize: v.pipe(positiveWholeNumber, v.maxValue(MAX_CARDS_PER_READ)),
    }),
    'worldbuilding.showResults': v.object({
        from: v.nullable(cursor),
        pages: v.pipe(positiveWholeNumber, v.maxValue(MAX_CARDS_PER_READ)),
    }),
    'worldbuilding.findEntries': v.object({ book: entityId, query: v.string() }),
    'worldbuilding.select': v.object({
        book: entityId,
        entries: v.pipe(v.array(entityId), v.minLength(1), v.maxLength(PICKED_AT_MOST)),
        selected: v.boolean(),
    }),
    'worldbuilding.selectAllMatching': v.object({ book: entityId }),
    'worldbuilding.selectNone': v.object({ book: entityId }),
    'worldbuilding.bulk': v.object({ book: entityId, action: bulkAction, loopCheckLimit }),
    // Shows a saved view of the shown world (null: none, as a world with no views is shown).
    'worldbuilding.showView': v.object({ book: entityId, view: v.nullable(viewId), overview: shownOverview }),
    // Changes the shown view for this tab only, until it is saved or discarded.
    'worldbuilding.changeView': v.object({ book: entityId, change: viewChange, overview: shownOverview }),
    'worldbuilding.saveView': v.object({ book: entityId }),
    'worldbuilding.discardView': v.object({ book: entityId, overview: shownOverview }),
    // Drops the reader's changed copy of the world's view.
    'worldbuilding.resetView': v.object({ book: entityId, overview: shownOverview }),
    // A view of the reader's own, starting as the shown view is drawn.
    'worldbuilding.addView': v.object({ book: entityId, overview: shownOverview }),
    // A reader's own view is renamed or deleted outright; a world's view is renamed or deleted in the world, and the
    // reader's changed copy of it goes with it.
    'worldbuilding.renameView': v.object({ book: entityId, view: viewId, name: viewName }),
    'worldbuilding.deleteView': v.object({ book: entityId, view: viewId, overview: shownOverview }),
    'worldbuilding.showMoreInCell': v.object({ book: entityId, ...cellAt.entries }),
    // A card dropped from one cell of a board or grid into another: the relations of the axes it crossed change.
    'worldbuilding.moveBetweenCells': v.object({
        book: entityId,
        entry: entityId,
        from: cellAt,
        to: cellAt,
        keepBoth: v.boolean(),
        ...betweenMembers,
        loopCheckLimit,
    }),
} satisfies ActionSchemas;
