// A search matched against texts on the engine (the alternatives list's search): the chat search's clauses, words
// and folding, answered as the ranges matched.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadEngine } from '../engine/load.js';
import { textMatches } from './text-matches.js';

/**
 * The matched parts of each text, or null.
 * @param {(number[] | null)[]} found
 * @param {string[]} texts
 */
const parts = (found, texts) => found.map((spans, i) => spans && Array.from({ length: spans.length / 2 }, (_, k) => texts[i].slice(spans[2 * k], spans[2 * k + 1])));

for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: every word of the search, its last one a prefix, in any case and accent`, () => {
        const texts = ['A red Lighthouse.', 'A lighthouse.', 'Rouge Phare', 'Café crème'];
        assert.deepEqual(parts(textMatches(engine, 'red LIGHTH', texts), texts), [['red', 'Lighthouse'], null, null, null]);
        assert.deepEqual(parts(textMatches(engine, 'cafe', texts), texts), [null, null, null, ['Café']]);
    });

    test(`${kind}: a quoted phrase is whole words, in order`, () => {
        const texts = ['the big sister came', 'the big sisters came', 'sister big'];
        assert.deepEqual(parts(textMatches(engine, '"big sister"', texts), texts), [['big', 'sister'], null, null]);
    });

    test(`${kind}: ranges are UTF-16, past text outside the basic plane`, () => {
        const texts = ['🎉 party time'];
        const [spans] = textMatches(engine, 'party', texts);
        assert.deepEqual(spans, [3, 8]);
    });

    test(`${kind}: an empty search matches everything, with nothing marked`, () => {
        assert.deepEqual(textMatches(engine, '', ['a', 'b']), [[], []]);
    });
}
