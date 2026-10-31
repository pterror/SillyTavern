import assert from 'node:assert/strict';
import { resolveAuthorsNote, metadata_keys, chara_note_position } from './authors-note.js';

const baseNoteSettings = {
    default: '',
    defaultDepth: 4,
    defaultInterval: 1,
    defaultPosition: 1,
    defaultRole: 0,
    allowWIScan: false,
    chara: [],
};

function userMessages(count) {
    return Array.from({ length: count }, () => ({ is_user: true }));
}

assert.deepEqual(resolveAuthorsNote({
    chatMetadata: {},
    noteSettings: baseNoteSettings,
    chat: userMessages(5),
    avatar: null,
    hasCharacterOrGroup: false,
}), { disabled: true });

assert.deepEqual(resolveAuthorsNote({
    chatMetadata: { [metadata_keys.interval]: 0, [metadata_keys.prompt]: 'hello' },
    noteSettings: baseNoteSettings,
    chat: userMessages(5),
    avatar: null,
    hasCharacterOrGroup: true,
}), { disabled: true }, 'interval 0');

assert.deepEqual(resolveAuthorsNote({
    chatMetadata: { [metadata_keys.interval]: -3, [metadata_keys.prompt]: 'hello' },
    noteSettings: baseNoteSettings,
    chat: userMessages(5),
    avatar: null,
    hasCharacterOrGroup: true,
}), { disabled: true }, 'interval negative');

for (const count of [0, 1, 2, 7]) {
    const result = resolveAuthorsNote({
        chatMetadata: { [metadata_keys.interval]: 1, [metadata_keys.prompt]: 'note text' },
        noteSettings: baseNoteSettings,
        chat: userMessages(count),
        avatar: null,
        hasCharacterOrGroup: true,
    });
    assert.equal(result.disabled, false, `count=${count}`);
    assert.equal(result.shouldAddPrompt, true, `count=${count}`);
    assert.equal(result.messagesTillInsertion, 0, `count=${count}`);
    assert.equal(result.value, 'note text', `count=${count}`);
}

{
    const result = resolveAuthorsNote({
        chatMetadata: { [metadata_keys.interval]: 5, [metadata_keys.prompt]: 'note text' },
        noteSettings: baseNoteSettings,
        chat: userMessages(2),
        avatar: null,
        hasCharacterOrGroup: true,
    });
    assert.equal(result.disabled, false);
    assert.equal(result.shouldAddPrompt, false);
    assert.equal(result.messagesTillInsertion, 3);
    assert.equal(result.value, '');
}

{
    const dueExactly = resolveAuthorsNote({
        chatMetadata: { [metadata_keys.interval]: 5, [metadata_keys.prompt]: 'note text' },
        noteSettings: baseNoteSettings,
        chat: userMessages(5),
        avatar: null,
        hasCharacterOrGroup: true,
    });
    assert.equal(dueExactly.shouldAddPrompt, true);
    assert.equal(dueExactly.messagesTillInsertion, 0);
    assert.equal(dueExactly.value, 'note text');

    const dueAtMultiple = resolveAuthorsNote({
        chatMetadata: { [metadata_keys.interval]: 5, [metadata_keys.prompt]: 'note text' },
        noteSettings: baseNoteSettings,
        chat: userMessages(10),
        avatar: null,
        hasCharacterOrGroup: true,
    });
    assert.equal(dueAtMultiple.shouldAddPrompt, true);
    assert.equal(dueAtMultiple.messagesTillInsertion, 0);

    const notDueAtMultiplePlusOne = resolveAuthorsNote({
        chatMetadata: { [metadata_keys.interval]: 5, [metadata_keys.prompt]: 'note text' },
        noteSettings: baseNoteSettings,
        chat: userMessages(11),
        avatar: null,
        hasCharacterOrGroup: true,
    });
    assert.equal(notDueAtMultiplePlusOne.shouldAddPrompt, false);
    assert.equal(notDueAtMultiplePlusOne.messagesTillInsertion, 1);
    assert.equal(notDueAtMultiplePlusOne.value, '');
}

assert.equal(resolveAuthorsNote({
    chatMetadata: { [metadata_keys.interval]: 1, [metadata_keys.prompt]: 'default note' },
    noteSettings: {
        ...baseNoteSettings,
        chara: [{ name: 'chara1', prompt: 'chara note', useChara: true, position: chara_note_position.replace }],
    },
    chat: userMessages(1),
    avatar: 'chara1',
    hasCharacterOrGroup: true,
}).value, 'chara note', 'chara override replace');

assert.equal(resolveAuthorsNote({
    chatMetadata: { [metadata_keys.interval]: 1, [metadata_keys.prompt]: 'default note' },
    noteSettings: {
        ...baseNoteSettings,
        chara: [{ name: 'chara1', prompt: 'chara note', useChara: true, position: chara_note_position.before }],
    },
    chat: userMessages(1),
    avatar: 'chara1',
    hasCharacterOrGroup: true,
}).value, 'chara note\ndefault note', 'chara override before');

assert.equal(resolveAuthorsNote({
    chatMetadata: { [metadata_keys.interval]: 1, [metadata_keys.prompt]: 'default note' },
    noteSettings: {
        ...baseNoteSettings,
        chara: [{ name: 'chara1', prompt: 'chara note', useChara: true, position: chara_note_position.after }],
    },
    chat: userMessages(1),
    avatar: 'chara1',
    hasCharacterOrGroup: true,
}).value, 'default note\nchara note', 'chara override after');

assert.equal(resolveAuthorsNote({
    chatMetadata: { [metadata_keys.interval]: 1, [metadata_keys.prompt]: 'default note' },
    noteSettings: {
        ...baseNoteSettings,
        chara: [{ name: 'chara1', prompt: 'chara note', useChara: false, position: chara_note_position.replace }],
    },
    chat: userMessages(1),
    avatar: 'chara1',
    hasCharacterOrGroup: true,
}).value, 'default note', 'chara override ignored (useChara false)');

assert.equal(resolveAuthorsNote({
    chatMetadata: { [metadata_keys.interval]: 1, [metadata_keys.prompt]: 'default note' },
    noteSettings: {
        ...baseNoteSettings,
        chara: [{ name: 'someone-else', prompt: 'chara note', useChara: true, position: chara_note_position.replace }],
    },
    chat: userMessages(1),
    avatar: 'chara1',
    hasCharacterOrGroup: true,
}).value, 'default note', 'chara override ignored (no match)');

{
    const result = resolveAuthorsNote({
        chatMetadata: {},
        noteSettings: {
            default: 'fallback note',
            defaultDepth: 7,
            defaultInterval: 1,
            defaultPosition: 2,
            defaultRole: 1,
            allowWIScan: true,
            chara: [],
        },
        chat: userMessages(1),
        avatar: null,
        hasCharacterOrGroup: true,
    });
    assert.equal(result.disabled, false);
    assert.equal(result.value, 'fallback note');
    assert.equal(result.depth, 7);
    assert.equal(result.position, 2);
    assert.equal(result.role, 1);
    assert.equal(result.scan, true);
}

{
    const result = resolveAuthorsNote({
        chatMetadata: {},
        noteSettings: {},
        chat: userMessages(1),
        avatar: null,
        hasCharacterOrGroup: true,
    });
    assert.equal(result.disabled, false);
    assert.equal(result.value, '');
    assert.equal(result.depth, 4);
    assert.equal(result.position, 1);
    assert.equal(result.role, 0);
    assert.equal(result.scan, false);
}

console.log('authors-note.test.js: all assertions passed');
