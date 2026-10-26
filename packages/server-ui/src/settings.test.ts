import type { ChatOwner } from '@st/protocol';
import { LEVELS, LIMITS } from '@st/protocol/settings';
import type { Level, LevelRange, SettingsView } from '@st/protocol/settings';
import { expect, test } from 'vite-plus/test';
import { settingsArea } from './settings.ts';
import type { Ports } from './settings.ts';
import type { ActionContext, User } from './index.ts';

const user: User = { handle: 'u', directories: { root: '/u' } };

/** A cascade in memory: each level's values by path; a range shows the closest level's, and says which. */
function world() {
    const levels: Record<Level, Record<string, unknown>> = {
        default: {
            main_api: 'openai',
            'oai_settings.chat_completion_source': 'openai',
            'oai_settings.temp_openai': 1,
            'power_user.max_context_unlocked': false,
        },
        preset: {},
        user: {},
        group: {},
        character: {},
    };
    const writes: { owner: ChatOwner | null; range: LevelRange; path: string; value: unknown }[] = [];
    const nest = (flat: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const [path, value] of Object.entries(flat)) {
            const keys = path.split('.');
            let at = out;
            for (const key of keys.slice(0, -1)) at = (at[key] ??= {}) as Record<string, unknown>;
            at[keys.at(-1)!] = value;
        }
        return out;
    };
    const ports: Ports = {
        async view(_user, _owner, range) {
            const shown = LEVELS.slice(LEVELS.indexOf(range.from), LEVELS.indexOf(range.to) + 1);
            const flat: Record<string, unknown> = {};
            const sources: Record<string, string> = {};
            for (const level of shown) {
                for (const [path, value] of Object.entries(levels[level])) {
                    flat[path] = value;
                    if (level !== 'default') sources[path] = level;
                }
            }
            return { settings: nest(flat), sources };
        },
        async writeAt(_user, owner, range, path, value) {
            writes.push({ owner, range, path, value });
            if (value === undefined) delete levels[range.to][path];
            else levels[range.to][path] = value;
        },
        ownerOf: async (_user, chat) => ({ avatar: `${chat.tree}.png` }),
    };
    const area = settingsArea(ports);
    const context = (session = 's1', chat: { tree: string } | null = { tree: 'cara' }): ActionContext => ({
        user,
        session,
        chat,
        upload: null,
    });
    const view = (session?: string) => area.views['settings']!(context(session)) as Promise<SettingsView>;
    const act = (type: string, payload: unknown, session?: string) => area.actions[type]!(context(session), payload);
    return { levels, writes, view, act };
}

test("the view: each field's value over the range, the level it comes from, and the API that decides what shows", async () => {
    const w = world();
    w.levels.user['oai_settings.temp_openai'] = 1.4;
    const view = await w.view();
    expect(view.values['oai_settings.temp_openai']).toBe(1.4);
    expect(view.sources['oai_settings.temp_openai']).toBe('user');
    expect(view.range).toEqual({ from: 'default', to: 'user' });
    expect(view.context).toEqual({ avatar: 'cara.png' });
    expect(view.api).toEqual({ main: 'openai', source: 'openai', textgen: '' });
});

test("counts are the whole chat's, so a level the range leaves out still shows what it sets", async () => {
    const w = world();
    w.levels.character['oai_settings.temp_openai'] = 0.3;
    const view = await w.view();
    expect(view.values['oai_settings.temp_openai']).toBe(1);
    expect(view.counts.character).toBe(1);
});

test("a set goes to the range's top level, for the tab's chat; the range is the tab's", async () => {
    const w = world();
    expect(await w.act('settings.range', { from: 'default', to: 'character' })).toEqual({ changed: ['settings'] });
    await w.act('settings.set', { path: 'oai_settings.temp_openai', value: 0.7 });
    expect(w.writes.at(-1)).toEqual({
        owner: { avatar: 'cara.png' },
        range: { from: 'default', to: 'character' },
        path: 'oai_settings.temp_openai',
        value: 0.7,
    });
    // Another tab's range is its own.
    expect((await w.view('s2')).range).toEqual({ from: 'default', to: 'user' });
    expect((await w.view('s1')).sources['oai_settings.temp_openai']).toBe('character');
});

test("a value its field can't have is refused and nothing is written", async () => {
    const w = world();
    expect(await w.act('settings.set', { path: 'oai_settings.temp_openai', value: 'hot' })).toMatchObject({
        refused: expect.any(String),
    });
    expect(await w.act('settings.set', { path: 'oai_settings.temp_openai', value: 99 })).toMatchObject({
        refused: expect.stringMatching(/at most/),
    });
    expect(await w.act('settings.set', { path: 'oai_settings.names_behavior', value: 7 })).toMatchObject({
        refused: expect.any(String),
    });
    expect(await w.act('settings.set', { path: 'nowhere.at_all', value: 1 })).toMatchObject({
        refused: expect.any(String),
    });
    expect(w.writes).toEqual([]);
});

test('a context size past the locked limit is refused until the user unlocks it', async () => {
    const w = world();
    const big = LIMITS.context.locked.max + 64;
    expect(await w.act('settings.set', { path: 'max_context', value: big })).toMatchObject({
        refused: expect.any(String),
    });
    w.levels.user['power_user.max_context_unlocked'] = true;
    expect(await w.act('settings.set', { path: 'max_context', value: big })).toEqual({ changed: ['settings'] });
    expect((await w.view()).ranges['max_context']).toEqual(LIMITS.context.unlocked);
});

test("unset takes a value away at the top level; the defaults can't be", async () => {
    const w = world();
    w.levels.user['oai_settings.temp_openai'] = 1.4;
    await w.act('settings.unset', { path: 'oai_settings.temp_openai' });
    expect((await w.view()).values['oai_settings.temp_openai']).toBe(1);
    await w.act('settings.range', { from: 'default', to: 'default' });
    expect(await w.act('settings.unset', { path: 'oai_settings.temp_openai' })).toMatchObject({
        refused: expect.any(String),
    });
});

test('a range goes from farther to closer', async () => {
    const w = world();
    expect(await w.act('settings.range', { from: 'character', to: 'user' })).toMatchObject({
        refused: expect.any(String),
    });
});
