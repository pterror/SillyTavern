import { expect, test } from 'vite-plus/test';
import { searchClauses, searchTokens, typedToken } from './search.ts';

const LABELS = { title: [2], text: [4] };

test('labelled words name their fields, a minus leaves them out, quotes keep words together, other words stay words', () => {
    expect(searchClauses('lamp title:lamp -text:"old oil" when:now', LABELS)).toEqual([
        { text: 'lamp', negate: false, quoted: false },
        { text: 'lamp', negate: false, quoted: false, fields: [2] },
        { text: 'old oil', negate: true, quoted: true, fields: [4] },
        { text: 'when:now', negate: false, quoted: false },
    ]);
    expect(searchClauses('"open quote', LABELS)).toEqual([{ text: 'open quote', negate: false, quoted: false }]);
    expect(searchClauses('  title:  ""', LABELS)).toEqual([{ text: 'title:', negate: false, quoted: false }]);
});

test('a token typed back reads as the same token', () => {
    for (const token of searchTokens('lamp TITLE:lamp -text:"old oil" "two words"', LABELS)) {
        expect(searchTokens(typedToken(token), LABELS)).toEqual([token]);
    }
    expect(typedToken({ label: 'title', text: 'old oil', negate: true, quoted: false })).toBe('-title:"old oil"');
});
