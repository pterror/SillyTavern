import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

export const OVERVIEW_VIEW = 'worldbuilding.overview';
export const RELATION_KINDS_VIEW = 'worldbuilding.relationKinds';
export const LAST_CHANGE_VIEW = 'worldbuilding.lastChange';

export const MAX_TOP_LEVEL_RANGE = 200;
export const MAX_NESTING_LEVELS = 4;
export const MAX_REGION_COLUMNS = 12;
export const MAX_REGION_ROWS = 20;
export const MAX_CARD_TEXT_CHARACTERS = 2000;
export const MAX_CARDS_PER_READ = 4000;
export const MAX_LOOP_CHECK_LIMIT = 10_000;

export type RelationOnCard = {
    kind: string;
    kindName: string | null;
    targetKey: string;
    target: string | null;
    targetTitle: string | null;
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
    memberCount: number;
    alreadyOpenAbove: boolean;
    region: RegionCell[];
};

export type MoreTile = { cell: 'more'; occurrence: string; moreCount: number };

export type RegionCell = EntryCell | MoreTile;

export type StepLanding = { occurrence: string; topLevelRank: number };

export type RegionLayout = { columns: number; rows: number };

export type OverviewLayout = { regionsByNestingLevel: RegionLayout[]; cardTextCharacters: number };

export type OverviewView = {
    book: string | null;
    groupBy: string | null;
    topLevelCount: number;
    firstRank: number;
    entries: (EntryCell & { topLevelRank: number })[];
    stepLanding: StepLanding | null;
};

export type RelationKind = { id: string; name: string };

export type RelationKindsView = { book: string | null; kinds: RelationKind[] };

export type UnreachedLoop = { entry: string; kind: string; target: string; entries: string[] };

export type LastChangeView = { createdKind: string | null; unreachedLoop: UnreachedLoop | null };

export function cardsPerTopLevelEntry(levels: RegionLayout[]): number {
    let cards = 1;
    let atLevel = 1;
    for (const { columns, rows } of levels) {
        atLevel *= columns * rows;
        cards += atLevel;
    }
    return cards;
}

const entityId = v.pipe(v.string(), v.regex(/^\d+$/));
const kindId = v.pipe(v.string(), v.regex(/^[1-9]\d{0,15}$/));
const occurrenceKey = v.pipe(v.string(), v.maxLength(4000), v.regex(/^\d+(\/\d+)*(\/\+)?$/));
const topLevelRank = v.pipe(v.number(), v.integer(), v.minValue(0));
const wholeNumberUpTo = (max: number) => v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(max));
const kindName = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200));
const loopCheckLimit = wholeNumberUpTo(MAX_LOOP_CHECK_LIMIT);

const layout = v.object({
    regionsByNestingLevel: v.pipe(
        v.array(v.object({ columns: wholeNumberUpTo(MAX_REGION_COLUMNS), rows: wholeNumberUpTo(MAX_REGION_ROWS) })),
        v.maxLength(MAX_NESTING_LEVELS),
    ),
    cardTextCharacters: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_CARD_TEXT_CHARACTERS)),
});

const rangeFields = { firstRank: topLevelRank, endRank: topLevelRank };
type Range = { firstRank: number; endRank: number };
const rangeIsValid = <T extends Range>(range: T) =>
    range.endRank >= range.firstRank && range.endRank - range.firstRank <= MAX_TOP_LEVEL_RANGE;
const RANGE_REFUSAL = `A range runs from a rank to a later one, at most ${MAX_TOP_LEVEL_RANGE} apart.`;
const READ_IS_BOUNDED = `A read draws at most ${MAX_CARDS_PER_READ} cards: fewer top-level entries, levels, columns or rows.`;

const betweenMembers = { after: v.nullable(entityId), before: v.nullable(entityId) };
const relationNamed = { entry: entityId, kind: kindId, target: entityId };

export const actions = {
    'worldbuilding.openOverview': v.pipe(
        v.object({
            book: entityId,
            groupBy: v.nullable(kindId),
            ...rangeFields,
            layout,
            around: v.nullable(occurrenceKey),
        }),
        v.check(rangeIsValid, RANGE_REFUSAL),
        v.check(
            <T extends Range & { layout: OverviewLayout }>(read: T) =>
                (read.endRank - read.firstRank) * cardsPerTopLevelEntry(read.layout.regionsByNestingLevel) <=
                MAX_CARDS_PER_READ,
            READ_IS_BOUNDED,
        ),
    ),
    'worldbuilding.showRange': v.pipe(v.object(rangeFields), v.check(rangeIsValid, RANGE_REFUSAL)),
    'worldbuilding.stepOverview': v.union([
        v.object({
            from: v.nullable(occurrenceKey),
            by: v.pipe(v.number(), v.integer(), v.minValue(-1000), v.maxValue(1000)),
        }),
        v.object({ from: occurrenceKey, to: v.picklist(['parent', 'firstChild']) }),
    ]),
    'worldbuilding.createRelationKind': v.object({ name: kindName }),
    'worldbuilding.renameRelationKind': v.object({ kind: kindId, name: kindName }),
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
