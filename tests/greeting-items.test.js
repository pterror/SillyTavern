import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import path from 'node:path';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('../src/greeting-list.js')} */
let greetingList;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    user = await (await import('./converted-user.fixture.js')).emptyUser('st-greeting-items-test-');
    globalThis.DATA_ROOT = user.dataRoot;
    greetingList = await import('../src/greeting-list.js');
});

afterAll(() => user.close());

/**
 * @param {string[]} greetings
 * @param {number | null} defaultIndex
 */
function cardJson(greetings, defaultIndex) {
    const card = { spec: 'chara_card_v2', spec_version: '2.0', name: 'G', data: { name: 'G', description: '', first_mes: '', alternate_greetings: [], extensions: {} } };
    greetingList.applyGreetingsModelToCard(card, { greetings, defaultIndex });
    return JSON.stringify(card);
}

/**
 * @param {string} avatar
 * @param {string[]} greetings
 * @param {number | null} defaultIndex
 * @param {import('../src/greeting-items.js').GreetingModel} [model]
 */
async function write(avatar, greetings, defaultIndex, model) {
    await user.store.lib.writeCard(user.directories, avatar, cardJson(greetings, defaultIndex), model ? { greetings: model } : {});
    return user.store.lib.greetingModel(avatar);
}

describe('a card\'s greetings in the store', () => {
    test('a new card numbers its greetings in order, the default among them', async () => {
        expect(await write('a.png', ['x', 'y', 'z'], 1)).toEqual({
            greetings: [{ id: 0, text: 'x' }, { id: 1, text: 'y' }, { id: 2, text: 'z' }], defaultId: 1, nextId: 3,
        });
        const [card] = await user.store.lib.cards(['a.png']);
        expect(greetingList.cardToGreetingsModel(card)).toEqual({ greetings: ['x', 'y', 'z'], defaultIndex: 1 });
        expect(card.data.first_mes).toBe('y');
        expect(card.data.alternate_greetings).toEqual(['x', 'z']);
    });

    test('a whole card written again keeps the id of every text it already had', async () => {
        await write('b.png', ['x', 'y', 'z'], 0);
        expect(await write('b.png', ['z', 'new', 'x'], 2)).toEqual({
            greetings: [{ id: 2, text: 'z' }, { id: 3, text: 'new' }, { id: 0, text: 'x' }], defaultId: 0, nextId: 4,
        });
    });

    test('a change by id keeps ids through an edit, a move and a new default; a deleted id is never given again', async () => {
        const start = await write('c.png', ['x', 'y', 'z'], 0);
        const [x, y, z] = start.greetings;
        const moved = { greetings: [{ ...z, text: 'z edited' }, x, y], defaultId: y.id, nextId: start.nextId };
        expect(await write('c.png', ['z edited', 'x', 'y'], 2, moved)).toEqual(moved);
        const without = { greetings: [{ ...z, text: 'z edited' }, x], defaultId: null, nextId: start.nextId };
        expect(await write('c.png', ['z edited', 'x'], null, without)).toEqual(without);
        const added = await write('c.png', ['z edited', 'x', 'w'], null);
        expect(added.greetings.map(g => g.id)).toEqual([z.id, x.id, start.nextId]);
        const [card] = await user.store.lib.cards(['c.png']);
        expect(greetingList.cardToGreetingsModel(card)).toEqual({ greetings: ['z edited', 'x', 'w'], defaultIndex: null });
    });

    test('greetings given with a write must be the card\'s', async () => {
        const start = await write('d.png', ['x'], 0);
        await expect(write('d.png', ['y'], 0, start)).rejects.toThrow('aren\'t the card\'s');
    });

    test('many moves place greetings again without losing any', async () => {
        let model = await write('e.png', ['a', 'b', 'c', 'd', 'e'], null);
        for (let round = 0; round < 30; round++) {
            const greetings = [...model.greetings];
            const [moved] = greetings.splice(round % greetings.length, 1);
            greetings.splice((round * 3) % (greetings.length + 1), 0, moved);
            const next = { ...model, greetings };
            model = await write('e.png', greetings.map(g => g.text), null, next);
            expect(model).toEqual(next);
        }
    });
});
