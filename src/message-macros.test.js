import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

/** @type {{ owner: any, macros: string[] }[]} */
const asked = [];
mock.module('./endpoints/macros.js', {
    namedExports: {
        macroValuesIn: async (/** @type {any} */ _directories, /** @type {any} */ owner, /** @type {string[]} */ macros) => {
            asked.push({ owner, macros });
            return macros.map(source => (source.includes('random') ? null : `${source}@${owner.name2 ?? 'card'}`));
        },
    },
});

const { fillSentMacros, macroValuesOf, shownMacroValues } = await import('./message-macros.js');

const owner = { avatar: 'a.png', groupId: null };

test('the macros a message draws are filled in once for each speaker, and put in its extra', async () => {
    asked.length = 0;
    const messages = [
        { name: 'You', is_user: true, mes: 'Hi {{char}}', extra: {} },
        { name: 'Ann', is_user: false, mes: 'Hello {{user}} {{random::a::b}}', extra: { reasoning: 'Think of {{user}}' } },
        { name: 'Ann', is_user: false, mes: 'No macros', extra: { macro_values: { stale: 'x' } } },
    ];
    await fillSentMacros(/** @type {any} */ ({}), owner, { messages });
    assert.deepEqual(messages[0].extra.macro_values, { '{{char}}': '{{char}}@card', '{{charCreatorNotes}}': '{{charCreatorNotes}}@card' });
    assert.deepEqual(messages[1].extra.macro_values, { '{{user}}': '{{user}}@Ann', '{{random::a::b}}': null, '{{persona}}': '{{persona}}@Ann' });
    assert.equal('macro_values' in messages[2].extra, false);
    assert.deepEqual(asked.map(each => each.owner.name2), [null, 'Ann']);
});

test('a message with no macros asks for nothing', async () => {
    asked.length = 0;
    await fillSentMacros(/** @type {any} */ ({}), owner, { messages: [{ name: 'Ann', mes: 'plain', extra: {} }], alternatives: [{ name: 'Ann', mes: 'also plain' }] });
    assert.equal(asked.length, 0);
});

test('alternatives and a message\'s other swipes are filled in with their own speaker', async () => {
    const alternatives = [{ name: 'Bo', is_user: false, mes: '{{time}}', extra: {} }];
    const messages = [{ name: 'Ann', is_user: false, mes: 'x', swipes: ['x', 'at {{time}}'], swipe_info: [{ extra: {} }, { name: 'Cy', extra: {} }], extra: {} }];
    await fillSentMacros(/** @type {any} */ ({}), owner, { messages, alternatives });
    assert.deepEqual(alternatives[0].extra.macro_values, { '{{time}}': '{{time}}@Bo' });
    assert.deepEqual(messages[0].swipe_info[1].extra.macro_values, { '{{time}}': '{{time}}@Cy' });
});

test('the macros the page says it shows are answered by node', async () => {
    const values = await shownMacroValues(/** @type {any} */ ({}), owner, [
        { node: 'n1', speaker: null, sources: ['{{user}}'] },
        { node: 'n2', speaker: 'Ann', sources: ['{{char}}'] },
        { node: 3, sources: ['{{char}}'] },
    ]);
    assert.deepEqual(values, {
        n1: { '{{user}}': '{{user}}@card', '{{persona}}': '{{persona}}@card' },
        n2: { '{{char}}': '{{char}}@Ann', '{{charCreatorNotes}}': '{{charCreatorNotes}}@Ann' },
    });
    assert.equal(await shownMacroValues(/** @type {any} */ ({}), owner, 'nothing'), undefined);
});

test('the chat box\'s text is only known when sent', async () => {
    assert.deepEqual(await macroValuesOf(/** @type {any} */ ({}), owner, [{ texts: ['{{input}}'], speaker: null }]), [{ '{{input}}': null }]);
});

test('texts are answered in order', async () => {
    assert.deepEqual(await macroValuesOf(/** @type {any} */ ({}), owner, [{ texts: ['{{a}}'], speaker: 'X' }, { texts: ['none'], speaker: 'X' }]), [{ '{{a}}': '{{a}}@X' }, {}]);
});
