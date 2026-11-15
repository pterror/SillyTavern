import { expect, test } from 'vite-plus/test';
import { PANEL_VIEW } from './protocol.ts';
import { helpArea, topicNamed } from './server.ts';
import type { ActionContext, User, ViewContext } from '@st/server-ui';

const user: User = { handle: 'u', directories: { root: '/u' } };
const tab = (session: string): ActionContext => ({ user, session, chat: null, upload: null });

function stand() {
    const area = helpArea();
    const run = (type: string, context: ActionContext, payload: unknown) => {
        const action = area.actions[type];
        if (!action) throw new Error(`no ${type}`);
        return action(context, payload);
    };
    const read = (key: string, context: ViewContext) => {
        const reader = area.views[key];
        if (!reader) throw new Error(`no ${key}`);
        return reader(context) as Promise<unknown>;
    };
    return { area, run, read };
}

test('every name /help takes opens its topic, whatever its case, and any other name the overview', () => {
    const cases: Record<string, string> = {
        slash: 'slash',
        commands: 'slash',
        slashes: 'slash',
        'slash commands': 'slash',
        '1': 'slash',
        format: 'format',
        formatting: 'format',
        formats: 'format',
        'chat formatting': 'format',
        '2': 'format',
        hotkeys: 'hotkeys',
        hotkey: 'hotkeys',
        '3': 'hotkeys',
        macros: 'macros',
        macro: 'macros',
        '4': 'macros',
        help: 'overview',
        overview: 'overview',
        ' SLASH ': 'slash',
        nonsense: 'overview',
        '': 'overview',
    };
    for (const [name, topic] of Object.entries(cases)) expect(topicNamed(name), name).toBe(topic);
});

test('help is closed until opened, and open in the tab that opened it only', async () => {
    const { run, read } = stand();
    expect(await read(PANEL_VIEW, tab('a'))).toEqual({ open: false });
    const opened = await run('help.open', tab('a'), { name: 'macro' });
    expect(opened).toEqual({ changed: [], opensViews: [PANEL_VIEW] });
    expect(await read(PANEL_VIEW, tab('a'))).toEqual({ open: true, topic: 'macros' });
    expect(await read(PANEL_VIEW, tab('b'))).toEqual({ open: false });
});

test('showing a topic or opening again shows that topic', async () => {
    const { run, read } = stand();
    await run('help.open', tab('a'), { name: 'format' });
    expect(await run('help.show', tab('a'), { topic: 'hotkeys' })).toEqual({ changed: [PANEL_VIEW] });
    expect(await read(PANEL_VIEW, tab('a'))).toEqual({ open: true, topic: 'hotkeys' });
    await run('help.open', tab('a'), { name: '' });
    expect(await read(PANEL_VIEW, tab('a'))).toEqual({ open: true, topic: 'overview' });
});

test('a closed panel takes no topic, and its answer carries it closed', async () => {
    const { run, read } = stand();
    expect(await run('help.show', tab('a'), { topic: 'slash' })).toEqual({
        refused: 'Help is not open.',
        changed: [PANEL_VIEW],
    });
    await run('help.open', tab('a'), { name: 'slash' });
    expect(await run('help.close', tab('a'), {})).toEqual({ changed: [PANEL_VIEW] });
    expect(await read(PANEL_VIEW, tab('a'))).toEqual({ open: false });
});

test('however many tabs open help, each keeps its panel until it closes it or is gone', async () => {
    const { run, read } = stand();
    const sessions = Array.from({ length: 100 }, (_, i) => `t${i}`);
    for (const session of sessions) await run('help.open', tab(session), { name: 'slash' });
    for (const session of sessions)
        expect(await read(PANEL_VIEW, tab(session))).toEqual({ open: true, topic: 'slash' });
});

test("a tab that's gone keeps no panel", async () => {
    const { area, run, read } = stand();
    await run('help.open', tab('a'), { name: 'slash' });
    area.gone('a');
    expect(await read(PANEL_VIEW, tab('a'))).toEqual({ open: false });
});
