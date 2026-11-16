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

const { scopeMacroValues, sentMacroValues } = await import('./message-macros.js');

const owner = { avatar: 'a.png', groupId: null };

test('the macros of the texts sent are answered by speaker, each filled in once, none put in a message', async () => {
    asked.length = 0;
    const messages = [
        { name: 'You', is_user: true, mes: 'Hi {{char}}', extra: {} },
        { name: 'Ann', is_user: false, mes: 'Hello {{user}} {{random::a::b}}', extra: { reasoning: 'Think of {{user}}' } },
        { name: 'Ann', is_user: false, mes: 'And {{char}}', extra: {} },
    ];
    const answered = await sentMacroValues(/** @type {any} */ ({}), owner, { messages });
    assert.deepEqual(answered, [
        { speaker: null, values: { '{{char}}': '{{char}}@card', '{{charCreatorNotes}}': '{{charCreatorNotes}}@card' } },
        { speaker: 'Ann', values: { '{{user}}': '{{user}}@Ann', '{{random::a::b}}': null, '{{persona}}': '{{persona}}@Ann', '{{char}}': '{{char}}@Ann', '{{charCreatorNotes}}': '{{charCreatorNotes}}@Ann' } },
    ]);
    assert.deepEqual(asked.map(each => each.owner.name2), [null, 'Ann']);
    assert.equal(messages.some(message => 'macro_values' in message.extra), false);
});

test('texts with no macros ask for nothing', async () => {
    asked.length = 0;
    assert.equal(await sentMacroValues(/** @type {any} */ ({}), owner, { messages: [{ name: 'Ann', mes: 'plain', extra: {} }], alternatives: [{ name: 'Ann', mes: 'also plain' }] }), undefined);
    assert.equal(asked.length, 0);
});

test('alternatives and a message\'s other swipes are answered for their own speaker', async () => {
    const alternatives = [{ name: 'Bo', is_user: false, mes: '{{time}}', extra: {} }];
    const messages = [{ name: 'Ann', is_user: false, mes: 'x', swipes: ['x', 'at {{time}}'], swipe_info: [{ extra: {} }, { name: 'Cy', extra: {} }], extra: {} }];
    assert.deepEqual(await sentMacroValues(/** @type {any} */ ({}), owner, { messages, alternatives }), [
        { speaker: 'Cy', values: { '{{time}}': '{{time}}@Cy' } },
        { speaker: 'Bo', values: { '{{time}}': '{{time}}@Bo' } },
    ]);
});

test('the chat box\'s text is only known when sent', async () => {
    assert.deepEqual(await scopeMacroValues(/** @type {any} */ ({}), owner, [{ texts: ['{{input}}'], speaker: null }]), [{ speaker: null, values: { '{{input}}': null } }]);
});
