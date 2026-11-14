import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

export const VIEW = 'usageStats.shown';

// Times are milliseconds since the epoch, durations milliseconds.
export type Counts = {
    firstChat: number | null;
    generationMs: number;
    repliesWithoutTime: number;
    userMessages: number;
    // Character replies, each counted once however many alternatives it has.
    characterMessages: number;
    userWords: number;
    characterWords: number;
    swipes: number;
};

// `all`: every chat of the user's. `oldStatsFile`: the stats file kept from before the stats were counted from
// the stored messages, by its name in the user's folder.
export type ShownView =
    | { of: null }
    | { of: 'all'; counts: Counts; oldStatsFile: string | null }
    | { of: 'character'; avatar: string; counts: Counts };

const of = v.variant('of', [
    v.object({ of: v.literal('all') }),
    v.object({ of: v.literal('character'), avatar: v.pipe(v.string(), v.minLength(1)) }),
]);

export const actions = {
    'usageStats.show': of,
    'usageStats.close': v.object({}),
} satisfies ActionSchemas;

export type Shown = v.InferOutput<typeof of>;

// For a caller that isn't a tab: the stats a show of the same would show, as a `Stats`.
export const reads = {
    'usageStats.read': of,
} satisfies ActionSchemas;

export type Stats = Exclude<ShownView, { of: null }>;
