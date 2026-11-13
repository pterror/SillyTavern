import { expect, test } from 'vite-plus/test';
import type { CardView, HoverCard } from '../protocol.ts';
import { cardsFor, quotedList } from './HoverCard.tsx';

test('what brought an entry up is said as its keys in quotes, the last joined by "and"', () => {
    expect(quotedList(['Ilse'], 'and')).toBe('“Ilse”');
    expect(quotedList(['Ilse', 'ledger'], 'and')).toBe('“Ilse” and “ledger”');
    expect(quotedList(['a', 'b', 'c'], 'and')).toBe('“a”, “b” and “c”');
});

test("a card is shown only for the request it answers, so a word pointed at never shows another word's card", () => {
    const card: HoverCard = {
        book: '1',
        entry: '7',
        label: { thing: '7', text: 'Ilse', shownAs: 'name' },
        picture: null,
        relations: [],
        moreRelations: 0,
        text: '',
        textCut: false,
        broughtUpBy: null,
    };
    const asked = { entries: [{ book: '1', entry: '7' }], reply: 'r' };
    const view: CardView = { asked, cards: [card] };
    expect(cardsFor(view, { entries: [{ book: '1', entry: '7' }], reply: 'r' })).toEqual([card]);
    expect(cardsFor(view, { entries: [{ book: '1', entry: '7' }], reply: null })).toBeNull();
    expect(cardsFor(view, { entries: [{ book: '1', entry: '8' }], reply: 'r' })).toBeNull();
    expect(cardsFor({ asked: null, cards: [] }, asked)).toBeNull();
    expect(cardsFor(undefined, asked)).toBeNull();
});
