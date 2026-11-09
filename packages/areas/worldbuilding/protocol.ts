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

export const READS_PER_REQUEST = 24_000;
// A card reads its title, text, keys, names and relations, and per relation the kind's name and the target's
// label (its title, keys, names and, with neither a title nor a name, its text): 10 with one relation.
export const READS_PER_CARD = 10;
export const READS_PER_LOOP_CHECK_VISIT = 2;
export const MAX_CARDS_PER_READ = READS_PER_REQUEST / READS_PER_CARD;
export const LOOP_CHECK_VISITS_PER_WRITE = READS_PER_REQUEST / READS_PER_LOOP_CHECK_VISIT;

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

export type LoopsLeftByJobsView = { book: string | null; unreachedLoops: UnreachedLoop[] };

export type ChangedRelation = { book: string; entry: string; kind: string; target: string };

export type EntryAt = { book: string; entry: string };

export type LastChangeView = {
    createdKind: { book: string; kind: string } | null;
    changedRelation: ChangedRelation | null;
    createdEntry: EntryAt | null;
    deletedEntry: (EntryAt & { label: Named }) | null;
    movedEntry: (EntryAt & { toBook: string; newEntry: string }) | null;
    unreachedLoops: UnreachedLoop[];
};

export type KeyOfEntry = { text: string; isName: boolean; alsoBringsUp: number };

export type Sentence = { before: string; mention: string; after: string };

export type MentionedIn = { entries: { from: Named; sentence: Sentence }[]; next: string | null };

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

export type World = { id: string; name: string; entries: number; usedInEveryChat: boolean };

export type WorldsView = { worlds: World[] };

export type WorldView = World | { id: null };

export type ExportedWorld = { fileName: string; json: string };

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
    'worldbuilding.openEntry': v.object({ ...entryNamed, pointingAt: pointingAtShown }),
    'worldbuilding.showPointingAtRange': v.pipe(
        v.object({ kind: kindId, ...rangeFields }),
        v.check(rangeRunsForward, RANGE_REFUSAL),
    ),
    'worldbuilding.stepPointingAt': v.union([
        v.object({ kind: kindId, from: v.nullable(pointingAtOccurrenceKey), by: v.pipe(v.number(), v.integer()) }),
        v.object({ kind: kindId, from: pointingAtOccurrenceKey, to: v.picklist(['parent', 'firstChild']) }),
    ]),
    'worldbuilding.closeEntry': v.object({}),
    'worldbuilding.showMoreMentions': v.object({ cursor: v.pipe(v.string(), v.minLength(1)) }),
    'worldbuilding.setEntryText': v.object({ ...entryNamed, text: v.string() }),
    'worldbuilding.setEntryTitle': v.object({ ...entryNamed, title: v.string() }),
    'worldbuilding.addKey': v.object({ ...entryNamed, key: keyText, as: keyAs }),
    'worldbuilding.setKeyAs': v.object({ ...entryNamed, key: keyText, as: keyAs }),
    'worldbuilding.removeKey': v.object({ ...entryNamed, key: keyText }),
    'worldbuilding.setPlacement': v.object({
        ...entryNamed,
        fields: v.pipe(
            v.partial(v.strictObject(placementFields)),
            v.check((fields: object) => Object.keys(fields).length > 0, 'Name at least one field.'),
        ),
    }),
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
} satisfies ActionSchemas;
