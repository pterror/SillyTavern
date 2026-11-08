import { describe, test, expect } from '@jest/globals';
import { openingView } from '../public/scripts/opening-view.js';

const provisionalId = (speaker, mes) => `card:${speaker}|${mes}`;
const isStored = id => typeof id === 'string' && id !== '' && !id.startsWith('card:');
const isProvisional = id => typeof id === 'string' && id.startsWith('card:');

const card = mes => ({ node_id: null, mes, name: 'Rex', is_user: false, send_date: 1, extra: {} });
const stored = (node_id, mes, is_user = false) => ({ node_id, mes, name: is_user ? 'You' : 'Rex', is_user, send_date: 1, extra: {} });

/**
 * @param {object[]} storedOpenings
 * @param {object[]} cardOpenings
 * @param {number} shown
 */
function state(storedOpenings, cardOpenings, shown) {
    const all = [...storedOpenings, ...cardOpenings];
    return {
        openings: { total: all.length, stored: storedOpenings.length, offset: 0, default_index: shown, alternatives: all },
        card_openings: cardOpenings.length ? { total: all.length, stored: storedOpenings.length, offset: storedOpenings.length, alternatives: cardOpenings } : null,
    };
}

const page = (first, count = first ? 1 : 0) => ({ first, count, speaker: 'Rex', sendDate: 9, provisionalId, isStored, isProvisional });
const shownCard = (mes, swipes = [mes]) => ({
    name: 'Rex', mes, node_id: provisionalId('Rex', mes), swipes, swipe_id: swipes.indexOf(mes),
    swipe_info: swipes.map(text => ({ node_id: provisionalId('Rex', text) })),
});

describe('the first message of a character tree', () => {
    test('an empty tree gets the opening the server shows once there is one', () => {
        expect(openingView(state([], [], 0), page(undefined))).toEqual({ kind: 'keep' });
        const view = openingView(state([], [card('Hi'), card('Yo')], 1), page(undefined));
        expect(view.kind).toBe('show');
        expect(view.message).toMatchObject({ mes: 'Yo', node_id: provisionalId('Rex', 'Yo'), swipes: ['Hi', 'Yo'], swipe_id: 1 });
    });

    test('a shown card greeting with nothing after it follows an edit, an add and a default change', () => {
        const edited = openingView(state([], [card('Hi, edited')], 0), page(shownCard('Hi')));
        expect(edited).toMatchObject({ kind: 'update', shownChanged: true, updates: { mes: 'Hi, edited', swipes: ['Hi, edited'] } });

        const added = openingView(state([], [card('Hi'), card('Yo')], 0), page(shownCard('Hi')));
        expect(added).toMatchObject({ kind: 'update', shownChanged: false, updates: { mes: 'Hi', swipes: ['Hi', 'Yo'], swipe_id: 0 } });

        const otherDefault = openingView(state([], [card('Hi'), card('Yo')], 1), page(shownCard('Hi', ['Hi', 'Yo'])));
        expect(otherDefault).toMatchObject({ kind: 'update', shownChanged: true, updates: { mes: 'Yo', swipe_id: 1 } });

        expect(openingView(state([], [card('Hi')], 0), page(shownCard('Hi')))).toEqual({ kind: 'keep' });
    });

    test('the tree\'s last card greeting deleted leaves it empty', () => {
        expect(openingView(state([], [], 0), page(shownCard('Hi')))).toEqual({ kind: 'clear' });
    });

    test('a stored opening is history: only its alternatives change', () => {
        const first = { ...stored('n1', 'hello', true), swipes: ['hello'], swipe_id: 0, swipe_info: [{ node_id: 'n1' }] };
        const view = openingView(state([stored('n1', 'hello', true)], [card('Hi')], 0), page(first, 3));
        expect(view).toEqual({
            kind: 'update',
            shownChanged: false,
            updates: {
                swipes: ['hello', 'Hi'],
                swipe_id: 0,
                swipe_info: [
                    { node_id: 'n1', name: 'You', is_user: true, is_system: false, send_date: 1, extra: {} },
                    { node_id: provisionalId('Rex', 'Hi'), name: 'Rex', is_user: false, is_system: false, send_date: 1, extra: {} },
                ],
            },
        });
        expect(openingView(state([stored('n1', 'hello', true)], [], 0), page(first, 3))).toEqual({ kind: 'keep' });
        expect(openingView(state([], [], 0), page(first, 3))).toEqual({ kind: 'keep' });
    });

    test('a card greeting with messages after it on the page stays as it is', () => {
        const first = shownCard('Hi');
        expect(openingView(state([], [card('Hi, edited')], 0), page(first, 2))).toEqual({ kind: 'keep' });
        expect(openingView(state([], [], 0), page(first, 2))).toEqual({ kind: 'keep' });
        expect(openingView(state([], [card('Hi'), card('Yo')], 1), page(first, 2))).toMatchObject({ kind: 'update', shownChanged: false, updates: { swipes: ['Hi', 'Yo'], swipe_id: 0 } });
    });

    test('a message the page composed is left alone', () => {
        expect(openingView(state([], [card('Hi')], 0), page({ mes: 'typed', node_id: null }))).toEqual({ kind: 'keep' });
    });
});
