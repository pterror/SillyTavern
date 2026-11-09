import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

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
export const SELECTION_VIEW = 'worldbuilding.selection';
export const BULK_JOBS_VIEW = 'worldbuilding.bulkJobs';
export const KEY_SHARERS_VIEW = 'worldbuilding.keySharers';

export const READS_PER_REQUEST = 24_000;
// A card reads its title, text, keys, names and relations, and per relation the kind's name and the target's
// label (its title, keys, names and, with neither a title nor a name, its text): 10 with one relation.
export const READS_PER_CARD = 10;
export const READS_PER_LOOP_CHECK_VISIT = 2;
// An entry checked for a mention reads its place (in the world's order, or in the index's list for a name), whether it
// is in the world, and its text's head and record.
export const READS_PER_MENTION_CHECK = 4;
export const MAX_CARDS_PER_READ = READS_PER_REQUEST / READS_PER_CARD;
export const LOOP_CHECK_VISITS_PER_WRITE = READS_PER_REQUEST / READS_PER_LOOP_CHECK_VISIT;
export const MENTION_CHECKS_PER_REQUEST = READS_PER_REQUEST / READS_PER_MENTION_CHECK;
// Looking for the names an entry's text writes reads one key per seek of the names index, per entry listed under a name
// found and per name checked one by one, and two (its case and whole-word flags) per entry it names.
export const TEXT_LINK_READS_PER_REQUEST = READS_PER_REQUEST;
export const FOUND_PER_QUERY = 20;
export const MENTIONS_PER_PAGE = 20;
export const MENTION_PAGES_AT_MOST = MAX_CARDS_PER_READ / MENTIONS_PER_PAGE;
export const KEY_SHARERS_SHOWN = 20;
export const SELECTION_COUNTED_UP_TO = 1000;
export const PICKED_AT_MOST = MAX_CARDS_PER_READ;
export const LOOPS_SHOWN = 3;
export const ENTRIES_NAMED_PER_LOOP = 3;

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

export type Named = { thing: string; text: string; shownAs: 'name' | 'title' | 'opening' };

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
    title: string | null;
    text: string;
    textCut: boolean;
    keys: string[];
    names: string[];
    relations: RelationOnCard[];
    groupingKindRelationsTargetingThis: number;
    alreadyOpenAbove: boolean;
    region: RegionCell[];
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

export type OverviewView = {
    book: string | null;
    groupBy: string | null;
    topLevelCount: number;
    firstRank: number;
    entries: ((EntryCell | PlaceOfDeletedEntryCell) & { topLevelRank: number })[];
    stepLanding: StepLanding | null;
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
// the request's MENTION_CHECKS_PER_REQUEST with more to look through, not because it filled or the world ended.
export type MentionsPage = {
    cursor: string | null;
    entries: { from: Named; sentence: Sentence }[];
    next: string | null;
    lookedThrough: number;
    stoppedForBound: boolean;
};

// The run of pages the page asked for: the first at the cursor asked from, each next the page after the one before.
// One read looks through at most MENTION_CHECKS_PER_REQUEST entries in all, so the run ends at a page that stopped for
// it.
export type MentionedIn = { pages: MentionsPage[] };

// Where the entry's text names another entry: `from` and `to` are UTF-16 offsets into `text`, in order, never overlapping.
// `linksComplete` is false when the read stopped at TEXT_LINK_READS_PER_REQUEST before it had looked for every name, so
// words it hadn't reached may be names it doesn't link.
export type TextLink = { entry: string; from: number; to: number };

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
    label: Named;
    title: string | null;
    keys: KeyOfEntry[];
    text: string;
    links: TextLink[];
    linksComplete: boolean;
    relations: RelationOnCard[];
    placement: Placement;
    placementDiffersFromDefaults: boolean;
    tokens: number | null;
    mentionedIn: MentionedIn;
};

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

// The other entries of the open entry's world that have `key` among their keys, the first KEY_SHARERS_SHOWN of them.
export type KeySharersView = (EntryAt & { key: string; entries: Named[]; more: boolean }) | { book: null };

export type World = { id: string; name: string; entries: number; usedInEveryChat: boolean };

export type WorldsView = { worlds: World[] };

// `entries`: live entries with a key that has their title's words and isn't a name; `example` is the first of them, null
// only while a job runs and none is left; `marked`: entries the offer has marked and Undo would take back.
export type NamesOffer = {
    entries: number;
    example: Named | null;
    running: 'marking' | 'undoing' | null;
    marked: number;
};

export type WorldView = (World & { namesOffer: NamesOffer | null }) | { id: null };

export type ExportedWorld = { fileName: string; json: string };

export type Depth = 'directly' | 'anyDepth';

export type Chip = { kind: string; target: string; depth: Depth };

export type ShownChip = { kind: string; kindName: string | null; target: Named; targetDeleted: boolean; depth: Depth };

export type ResultsPage = { cursor: string | null; entries: EntryCell[]; next: string | null };

// `generation` counts the filters set, so the page tells a new filter from the one it shows; `pages` are the run the page
// asked for, as MentionedIn's are.
export type ResultsView =
    | { book: string; generation: number; filter: { query: string; chips: ShownChip[] }; pages: ResultsPage[] }
    | { book: null };

export type FoundView = { book: string; query: string; entries: Named[]; next: string | null } | { book: null };

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
    | { set: Partial<Placement> }
    | { moveTo: RelationTo }
    | { alsoPutIn: RelationTo };

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
const RANGE_REFUSAL = 'A range runs from a rank to a later one.';
export const READ_REFUSAL = `A read draws at most ${MAX_CARDS_PER_READ} cards: fewer top-level entries, levels, columns or rows.`;

const betweenMembers = { after: v.nullable(entityId), before: v.nullable(entityId) };
const relationNamed = { book: entityId, entry: entityId, kind: kindId, target: entityId };

const entryNamed = { book: entityId, entry: entityId };
const worldName = v.pipe(v.string(), v.trim(), v.minLength(1, 'A world needs a name.'));
const shownOverview = v.pipe(
    v.object({ ...rangeFields, layout }),
    v.check(rangeRunsForward, RANGE_REFUSAL),
    v.check(
        <T extends Range & { layout: OverviewLayout }>(read: T) =>
            readFitsTheBudget(read.endRank - read.firstRank, read.layout),
        READ_REFUSAL,
    ),
);
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
const placementChange = v.pipe(
    v.partial(v.strictObject(placementFields)),
    v.check((fields: object) => Object.keys(fields).length > 0, 'Name at least one field.'),
);
const relationTo = v.object({ kind: kindId, target: entityId });
const bulkAction = v.union([
    v.strictObject({ delete: v.literal(true) }),
    v.strictObject({ set: placementChange }),
    v.strictObject({ moveTo: relationTo }),
    v.strictObject({ alsoPutIn: relationTo }),
]);

export const actions = {
    'worldbuilding.openOverview': v.pipe(
        v.object({
            book: v.nullable(entityId),
            groupBy: v.nullable(kindId),
            ...rangeFields,
            layout,
            around: v.nullable(occurrenceKey),
        }),
        v.check(rangeRunsForward, RANGE_REFUSAL),
        v.check(
            <T extends Range & { layout: OverviewLayout }>(read: T) =>
                readFitsTheBudget(read.endRank - read.firstRank, read.layout),
            READ_REFUSAL,
        ),
        v.check(
            <T extends { book: string | null; groupBy: string | null; around: string | null }>(open: T) =>
                open.book !== null || (open.groupBy === null && open.around === null),
            "A world's kinds and occurrences are named only with the world.",
        ),
    ),
    'worldbuilding.showRange': v.pipe(v.object(rangeFields), v.check(rangeRunsForward, RANGE_REFUSAL)),
    'worldbuilding.stepOverview': v.union([
        v.object({ from: v.nullable(occurrenceKey), by: v.pipe(v.number(), v.integer()) }),
        v.object({ from: occurrenceKey, to: v.picklist(['parent', 'firstChild']) }),
    ]),
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
    'worldbuilding.setEntryText': v.object({ ...entryNamed, text: v.string() }),
    'worldbuilding.setEntryTitle': v.object({ ...entryNamed, title: v.string() }),
    'worldbuilding.addKey': v.object({ ...entryNamed, key: keyText, as: keyAs }),
    'worldbuilding.setKeyAs': v.object({ ...entryNamed, key: keyText, as: keyAs }),
    'worldbuilding.removeKey': v.object({ ...entryNamed, key: keyText }),
    'worldbuilding.showKeySharers': v.object({ ...entryNamed, key: keyText }),
    'worldbuilding.setPlacement': v.object({ ...entryNamed, fields: placementChange }),
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
    'worldbuilding.openWorlds': v.object({}),
    'worldbuilding.createWorld': v.object({ name: worldName, ...opensWorld }),
    'worldbuilding.renameWorld': v.object({ book: entityId, name: worldName }),
    'worldbuilding.duplicateWorld': v.object({ book: entityId, ...opensWorld }),
    'worldbuilding.deleteWorld': v.object({ book: entityId }),
    'worldbuilding.importWorld': v.object(opensWorld),
    'worldbuilding.exportWorld': v.object({ book: entityId }),
    'worldbuilding.setUsedInEveryChat': v.object({ book: entityId, used: v.boolean() }),
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
} satisfies ActionSchemas;
