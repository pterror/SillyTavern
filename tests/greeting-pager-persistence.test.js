import { describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'espree';
import { pagerSelection, selectedGreetingIndex } from '../public/scripts/greeting-pager-selection.js';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const names = new Set(['applyGreetingOpSuccess', 'endGreetingPagerEdit', 'dropUncommittedPagerSlot', 'setGreetingPagerGreetings', 'keepShownGreeting', 'navigateGreetingPager']);
const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true }).body
    .filter(node => node.type === 'FunctionDeclaration' && names.has(node.id.name))
    .map(node => source.slice(...node.range)).join('\n');

function pager() {
    const context = vm.createContext({
        greetingPagerState: { owner: 'a.png', index: 2, greetings: ['First', 'Second', 'New'], ids: [0, 1, undefined], hashes: [10, 20], defaults: [true, false, false], committed: [true, true, false] },
        greetingPagerEdit: null,
        shownGreetings: new Map([['a.png', { id: 1 }]]),
        menu_type: 'character_edit',
        renderGreetingPager: jest.fn(), clearSameGreeting: jest.fn(),
        pagerSelection, selectedGreetingIndex,
        nextGreetingShownOrder: () => 1,
        getRequestHeaders: () => ({}),
        fetch: jest.fn().mockResolvedValue({ ok: true }),
        $: () => ({ val: () => '' }),
        greetingSaveRuns: new Map([['a.png', {}]]),
        applyGreetingsModelToCharacter: jest.fn(),
        takeOpenings: jest.fn().mockResolvedValue(undefined),
        openingsOwnerOf: () => null,
        refreshOpeningActions: jest.fn(),
        chatElement: { children: () => null },
    });
    vm.runInContext(functions, context);
    return context;
}

describe('remembering greeting pager changes', () => {
    test('confirming a new greeting remembers its newly assigned id after the pending card arrives', () => {
        const p = pager();
        p.greetingPagerEdit = { position: 2, id: 7, committed: true, pending: { owner: 'a.png', card: { greetings: ['First', 'Second', 'New'], ids: [0, 1, 7], hashes: [10, 20, 70], defaultIndex: 0 } } };
        p.endGreetingPagerEdit();
        expect(p.greetingPagerState.index).toBe(2);
        expect(JSON.parse(p.fetch.mock.calls[0][1].body)).toMatchObject({ avatar_url: 'a.png', greeting_id: 7, expected_hash: 70 });
        expect(p.shownGreetings.get('a.png')).toEqual({ id: 7 });
    });

    test('cancelling an empty new slot remembers the greeting it returns to', () => {
        const p = pager();
        p.shownGreetings.set('a.png', { id: 0 });
        p.greetingPagerEdit = { position: 2, committed: false, pending: null };
        p.endGreetingPagerEdit();
        expect(p.greetingPagerState.index).toBe(1);
        expect(JSON.parse(p.fetch.mock.calls[0][1].body).greeting_id).toBe(1);
    });

    test('an unsaved slot sends no selection, and an unchanged saved selection is not sent again', () => {
        const p = pager();
        p.keepShownGreeting();
        expect(p.fetch).not.toHaveBeenCalled();
        p.greetingPagerState.index = 0;
        p.keepShownGreeting();
        p.keepShownGreeting();
        expect(p.fetch).toHaveBeenCalledTimes(1);
    });

    test('deleting the shown greeting remembers the replacement shown by the pager', async () => {
        const p = pager();
        p.greetingPagerState.ids[2] = 7;
        p.shownGreetings.set('a.png', { id: 7 });
        await p.applyGreetingOpSuccess({ avatar: 'a.png' }, { greetings: ['First', 'Second'], ids: [0, 1], hashes: [10, 20], defaultPosition: 0 });
        expect(p.greetingPagerState.index).toBe(1);
        expect(JSON.parse(p.fetch.mock.calls[0][1].body).greeting_id).toBe(1);
    });
});
