import { describe, test, expect } from '@jest/globals';
import { applyGreetingsModelToCard, cardToGreetingsModel } from '../src/greeting-list.js';
import { readFromV2 } from '../src/character-card-normalize.js';

const cardWith = (firstMes, alternates) => ({
    name: 'Test',
    first_mes: firstMes,
    data: { name: 'Test', first_mes: firstMes, alternate_greetings: [...alternates] },
});

describe('applyGreetingsModelToCard', () => {
    test('writes the default greeting to both spec copies', () => {
        const card = cardWith('old default', ['alt one']);
        applyGreetingsModelToCard(card, { greetings: ['new default', 'alt one'], defaultIndex: 0 });

        expect(card.first_mes).toBe('new default');
        expect(card.data.first_mes).toBe('new default');
    });

    test('an edit survives the read that reconciles the two copies', () => {
        const card = cardWith('old default', ['alt one', 'alt two']);
        applyGreetingsModelToCard(card, { greetings: ['edited default', 'alt one', 'alt two'], defaultIndex: 0 });

        readFromV2(card);
        expect(card.first_mes).toBe('edited default');
        expect(cardToGreetingsModel(card).greetings).toEqual(['edited default', 'alt one', 'alt two']);
    });

    test('a greeting promoted to default lands in both copies and leaves the alternates', () => {
        const card = cardWith('was default', ['promote me']);
        applyGreetingsModelToCard(card, { greetings: ['was default', 'promote me'], defaultIndex: 1 });

        expect(card.first_mes).toBe('promote me');
        expect(card.data.first_mes).toBe('promote me');
        expect(card.data.alternate_greetings).toEqual(['was default']);
    });

    test('clearing the default empties both copies rather than only one', () => {
        const card = cardWith('was default', ['alt one']);
        applyGreetingsModelToCard(card, { greetings: ['was default', 'alt one'], defaultIndex: null });

        expect(card.first_mes).toBe('');
        expect(card.data.first_mes).toBe('');
        expect(card.data.alternate_greetings).toEqual(['was default', 'alt one']);
    });
});
