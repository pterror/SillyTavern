import { expect, test } from 'vite-plus/test';
import * as v from 'valibot';
import { VIEW, actions } from './protocol.ts';
import type { ShownView } from './protocol.ts';
import { usageStatsArea } from './server.ts';
import type { Ports, Stored } from './server.ts';
import type { ActionContext, User } from '@st/server-ui';

const stored = (over: Partial<Stored> = {}): Stored => ({
    userMsgs: 3,
    charMsgs: 5,
    userWords: 30,
    charWords: 80,
    swipes: 2,
    genMs: 9000,
    genUnknown: 1,
    firstUserAt: 1000,
    ...over,
});

function stand() {
    const asked: string[] = [];
    const ports: Ports = {
        totals: async () => {
            asked.push('totals');
            return stored();
        },
        character: async (_user, avatar) => {
            asked.push(avatar);
            return avatar === 'rex.png' ? stored({ userMsgs: 1, charMsgs: 1, swipes: 0 }) : stored({ userMsgs: 0 });
        },
        oldStatsFile: async () => 'stats.pre-derived.json',
    };
    const { area, showing } = usageStatsArea(ports);
    const user: User = { handle: 'u', directories: { root: '/u' } };
    const context = (session: string): ActionContext => ({
        user,
        session,
        chat: null,
        upload: null,
    });
    const act = (type: string, payload: unknown, session = 's') => area.actions[type]!(context(session), payload);
    const read = async (session = 's') => (await area.views[VIEW]!(context(session))) as ShownView;
    return { area, showing, act, read, asked };
}

test('the totals are shown with the old stats file, replies counted once however many alternatives', async () => {
    const { act, read } = stand();
    expect(await act('usageStats.show', { of: 'all' })).toEqual({ changed: [VIEW], opensViews: [VIEW] });
    expect(await read()).toEqual({
        of: 'all',
        counts: {
            firstChat: 1000,
            generationMs: 9000,
            repliesWithoutTime: 1,
            userMessages: 3,
            characterMessages: 3,
            userWords: 30,
            characterWords: 80,
            swipes: 2,
        },
        oldStatsFile: 'stats.pre-derived.json',
    });
});

test("a character's stats are read by its avatar, and nothing else is read", async () => {
    const { act, read, asked } = stand();
    await act('usageStats.show', { of: 'character', avatar: 'rex.png' });
    const view = await read();
    expect(view).toMatchObject({
        of: 'character',
        avatar: 'rex.png',
        counts: { userMessages: 1, characterMessages: 1 },
    });
    expect(asked).toEqual(['rex.png']);
});

test('what is shown is per tab, and closing or leaving shows nothing', async () => {
    const { area, act, read, showing } = stand();
    expect(await read()).toEqual({ of: null });
    await act('usageStats.show', { of: 'all' }, 'a');
    await act('usageStats.show', { of: 'character', avatar: 'cara.png' }, 'b');
    expect((await read('a')).of).toBe('all');
    expect((await read('b')).of).toBe('character');
    expect(showing('/u')).toBe(true);
    expect(showing('/other')).toBe(false);
    expect(await act('usageStats.close', {}, 'a')).toEqual({ changed: [VIEW] });
    expect(await read('a')).toEqual({ of: null });
    area.gone('b');
    expect(await read('b')).toEqual({ of: null });
    expect(showing('/u')).toBe(false);
});

test('a show names what it shows', () => {
    const show = actions['usageStats.show'];
    expect(v.safeParse(show, { of: 'all' }).success).toBe(true);
    expect(v.safeParse(show, { of: 'character', avatar: 'rex.png' }).success).toBe(true);
    expect(v.safeParse(show, { of: 'character', avatar: '' }).success).toBe(false);
    expect(v.safeParse(show, { of: 'character' }).success).toBe(false);
    expect(v.safeParse(show, {}).success).toBe(false);
});

test('a read answers the stats a show of the same would show, for a caller with no tab, holding nothing for it', async () => {
    const { area, showing } = stand();
    const user: User = { handle: 'u', directories: { root: '/u' } };
    const read = area.reads['usageStats.read']!;
    expect(v.safeParse(read.schema, { of: 'all' }).success).toBe(true);
    expect(v.safeParse(read.schema, { of: 'character' }).success).toBe(false);
    expect(await read.run({ user }, { of: 'all' })).toMatchObject({
        of: 'all',
        counts: { userMessages: 3, characterMessages: 3 },
        oldStatsFile: 'stats.pre-derived.json',
    });
    expect(await read.run({ user }, { of: 'character', avatar: 'rex.png' })).toMatchObject({
        of: 'character',
        avatar: 'rex.png',
        counts: { userMessages: 1 },
    });
    expect(showing('/u')).toBe(false);
});
