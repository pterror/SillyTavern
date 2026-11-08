import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

export const OVERVIEW_VIEW = 'worldbuilding.overview';
export const RELATION_KINDS_VIEW = 'worldbuilding.relationKinds';
export const LAST_CHANGE_VIEW = 'worldbuilding.lastChange';
export const LOOPS_LEFT_BY_JOBS_VIEW = 'worldbuilding.loopsLeftByJobs';

export const READS_PER_REQUEST = 24_000;
export const READS_PER_CARD = 6;
export const READS_PER_LOOP_CHECK_VISIT = 2;
export const MAX_CARDS_PER_READ = READS_PER_REQUEST / READS_PER_CARD;
export const LOOP_CHECK_VISITS_PER_WRITE = READS_PER_REQUEST / READS_PER_LOOP_CHECK_VISIT;

export type RelationOnCard = {
    kind: string;
    kindName: string | null;
    targetKey: string | null;
    target: string;
    targetTitle: string | null;
    targetDeleted: boolean;
    inUse: boolean;
    weak: boolean;
};

export type EntryCell = {
    cell: 'entry';
    occurrence: string;
    entry: string;
    entryKey: string;
    title: string | null;
    text: string;
    textCut: boolean;
    keys: string[];
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

export type LastChangeView = {
    createdKind: { book: string; kind: string } | null;
    changedRelation: ChangedRelation | null;
    unreachedLoops: UnreachedLoop[];
};

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

export const actions = {
    'worldbuilding.openOverview': v.pipe(
        v.object({
            book: entityId,
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
} satisfies ActionSchemas;
