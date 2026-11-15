import { defaultStrings } from '@pterror/interact-keybinds/strings';
import { expect, test } from 'vite-plus/test';
import { keyStrings } from '../src/key-strings.ts';

const marked = keyStrings((text) => `«${text}»`);

test('the strings keybinds shows are each translated, with none left out', () => {
    expect(Object.keys(marked).sort()).toEqual(Object.keys(defaultStrings).sort());
    for (const [name, value] of Object.entries(marked)) {
        if (typeof value === 'string') expect(value, name).toMatch(/^«.+»$/);
    }
});

test('the strings that hold a value take it into the translation', () => {
    expect(marked.alreadyBound('Save')).toBe('«Already bound to "Save".»');
    expect(marked.stepsSoFar('G')).toBe('«G then…»');
    expect(marked.add('Key')).toBe('+ Key');
});
