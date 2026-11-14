import type { EntryFacts, Placement } from '../protocol.ts';
import { LOGICS, WHERES } from './Placement.tsx';
import { fill } from './words.ts';

const IN_CHAT: Placement['position'] = 4;

const capitalized = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

export const goesWords = (facts: Pick<EntryFacts, 'position' | 'depth'>, t: (text: string) => string): string => {
    if (facts.position === IN_CHAT) return fill(t('Into the chat, ${0} up'), String(facts.depth));
    const where = WHERES.find((one) => one.position === facts.position);
    return where ? capitalized(t(where.words)) : t('Into an outlet');
};

// The words that bring the entry up, as its card shows them: its keys, then its secondary keys with their logic.
export const triggerWords = (keys: string[], facts: EntryFacts, t: (text: string) => string): string => {
    if (facts.comesIn === 'always') return t('Always');
    const first = keys.length === 0 ? t('no keys') : keys.join(', ');
    if (facts.keysecondary.length === 0) return first;
    const logic = LOGICS.find((one) => one.value === facts.selectiveLogic)?.words ?? '';
    return `${first} + ${t(logic)} ${facts.keysecondary.join(', ')}`;
};

// The change that switches the entry on or off: off is upstream's `disable`.
export const switched = (facts: EntryFacts): Partial<Placement> => ({ disable: facts.comesIn !== 'never' });
