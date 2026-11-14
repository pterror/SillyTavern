import type { EntryFacts, Placement } from '../protocol.ts';
import { LOGICS, WHERES } from './Placement.tsx';
import { fill } from './words.ts';

const IN_CHAT: Placement['position'] = 4;

export const goesWords = (facts: Pick<EntryFacts, 'position' | 'depth'>, t: (text: string) => string): string => {
    if (facts.position === IN_CHAT) return fill(t('At depth ${0}'), String(facts.depth));
    const where = WHERES.find((one) => one.position === facts.position);
    return where ? t(where.words) : t('Outlet');
};

// The keys that only bring the entry up: those that are not its names.
export const triggersOf = (keys: string[], names: string[]): string[] => keys.filter((key) => !names.includes(key));

// The words that bring the entry up, as its card shows them: its keys, then its secondary keys with their logic.
export const triggerWords = (keys: string[], facts: EntryFacts, t: (text: string) => string): string => {
    if (facts.comesIn === 'always') return t('Constant');
    const first = keys.length === 0 ? t('No keys') : keys.join(', ');
    if (facts.keysecondary.length === 0) return first;
    const logic = LOGICS.find((one) => one.value === facts.selectiveLogic)?.words ?? '';
    return `${first} + ${t(logic).toLowerCase()} ${facts.keysecondary.join(', ')}`;
};

// The change that switches the entry on or off: off is upstream's `disable`.
export const switched = (facts: EntryFacts): Partial<Placement> => ({ disable: facts.comesIn !== 'never' });
