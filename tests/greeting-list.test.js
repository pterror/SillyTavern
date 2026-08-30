import { describe, test, expect } from '@jest/globals';
import { applyGreetingsModelToCard, cardToGreetingsModel } from '../src/greeting-list.js';
import { readFromV2 } from '../src/character-card-normalize.js';

// A card carries its default greeting twice: the v1 `first_mes` field and the v2 `data.first_mes`
// one. readFromV2() reconciles them on every read by taking v2 and overwriting v1 with it, so a write
// that updates only v1 does not half-save an edit - it discards it. The write returns ok, the
// client's in-memory copy is right for the rest of the session, and the next read from disk hands
// back the old text.
//
// applyGreetingsModelToCard() is the single write path behind all six /api/characters/greetings/*
// operations, and it updated v1 and `data.alternate_greetings` while leaving `data.first_mes`
// untouched. In use that looked like the greeting editor reverting an edit, with the stale copy also
// turning up as a duplicate greeting in the chat log.
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

        // What every reader of a card actually gets. Before both copies were written, this handed back
        // the pre-edit text.
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
