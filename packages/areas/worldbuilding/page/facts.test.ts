import { expect, test } from 'vite-plus/test';
import type { EntryFacts } from '../protocol.ts';
import { goesWords, switched, triggerWords } from './facts.ts';

const t = (text: string) => text;

const facts = (change: Partial<EntryFacts> = {}): EntryFacts => ({
    comesIn: 'broughtUp',
    keysecondary: [],
    selectiveLogic: 0,
    position: 0,
    depth: 4,
    order: 100,
    chance: null,
    tokens: null,
    ...change,
});

test('a card says what brings its entry up: always, its keys, or its keys with the secondary ones and their logic', () => {
    expect(triggerWords(['lamp'], facts({ comesIn: 'always' }), t)).toBe('Always');
    expect(triggerWords(['lamp', 'light'], facts(), t)).toBe('lamp, light');
    expect(triggerWords([], facts(), t)).toBe('no keys');
    expect(triggerWords(['lamp'], facts({ keysecondary: ['oil'], selectiveLogic: 2 }), t)).toBe('lamp + none of oil');
    expect(triggerWords(['lamp'], facts({ keysecondary: ['oil', 'wick'], selectiveLogic: 3 }), t)).toBe(
        'lamp + all of oil, wick',
    );
});

test('where it goes reads as the sentence does, into the chat with its depth', () => {
    expect(goesWords(facts({ position: 4, depth: 2 }), t)).toBe('Into the chat, ${0} up'.replace('${0}', '2'));
    expect(goesWords(facts({ position: 1 }), t)).toBe('After character');
});

test('switching an entry turns on what is off and off what comes in, always or not', () => {
    expect(switched(facts({ comesIn: 'never' }))).toEqual({ disable: false });
    expect(switched(facts({ comesIn: 'always' }))).toEqual({ disable: true });
    expect(switched(facts())).toEqual({ disable: true });
});
