import { actions, reads, VIEW } from './protocol.ts';
import type { Counts, Shown, ShownView, Stats } from './protocol.ts';
import { defineArea } from '@st/server-ui';
import type { User, ViewContext } from '@st/server-ui';

// As the store counts them: `charMsgs` counts every alternative of a reply, `swipes` the alternatives past the first
// of each; times are milliseconds since the epoch, `genMs` milliseconds.
export type Stored = {
    userMsgs: number;
    charMsgs: number;
    userWords: number;
    charWords: number;
    swipes: number;
    genMs: number;
    genUnknown: number;
    firstUserAt: number | null;
};

export type Ports = {
    totals(user: User): Promise<Stored>;
    // A character that isn't stored has no messages.
    character(user: User, avatar: string): Promise<Stored>;
    oldStatsFile(user: User): Promise<string | null>;
};

export const countsOf = (stored: Stored): Counts => ({
    firstChat: stored.firstUserAt,
    generationMs: stored.genMs,
    repliesWithoutTime: stored.genUnknown,
    userMessages: stored.userMsgs,
    characterMessages: stored.charMsgs - stored.swipes,
    userWords: stored.userWords,
    characterWords: stored.charWords,
    swipes: stored.swipes,
});

export function usageStatsArea(ports: Ports) {
    // By session, until its tab is gone; `root`: the user's, to know whose writes change it.
    const shown = new Map<string, { root: string; of: Shown }>();

    const statsOf = async (user: User, of: Shown): Promise<Stats> => {
        if (of.of === 'character') {
            return { of: 'character', avatar: of.avatar, counts: countsOf(await ports.character(user, of.avatar)) };
        }
        const [totals, oldStatsFile] = await Promise.all([ports.totals(user), ports.oldStatsFile(user)]);
        return { of: 'all', counts: countsOf(totals), oldStatsFile };
    };

    const read = async ({ user, session }: ViewContext): Promise<ShownView> => {
        const held = shown.get(session);
        return held ? statsOf(user, held.of) : { of: null };
    };

    const area = defineArea({
        schemas: actions,
        views: { [VIEW]: read },
        readSchemas: reads,
        reads: {
            'usageStats.read': async ({ user }, of) => statsOf(user, of),
        },
        gone: (session) => {
            shown.delete(session);
        },
        actions: {
            'usageStats.show': async ({ user, session }, of) => {
                shown.set(session, { root: user.directories.root, of });
                return { changed: [VIEW], opensViews: [VIEW] };
            },
            'usageStats.close': async ({ session }) => {
                shown.delete(session);
                return { changed: [VIEW] };
            },
        },
    });

    return {
        area,
        showing: (root: string): boolean => [...shown.values()].some((held) => held.root === root),
    };
}
