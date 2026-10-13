import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The upstream-compatible migration of group files (src/endpoints/groups.js migrateGroupChatsMetadataFormat) works on
// the old group JSON and chat files only; it never reads or writes the store.

/** @type {typeof import('../src/endpoints/groups.js')} */
let groups;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    groups = await import('../src/endpoints/groups.js');
});

const tmpDirs = [];

afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-metadata-format-test-'));
    tmpDirs.push(root);
    const directories = {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'group chats'),
        backups: path.join(root, 'backups'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats, directories.backups]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return directories;
}

function makeMessage(mes, name = 'Alice', isUser = false) {
    return { name, is_user: isUser, mes, send_date: `date-${mes}`, extra: {}, swipes: [mes], swipe_id: 0 };
}

/**
 * Writes a group in the pre-metadata-migration shape: chat metadata lives on the group JSON
 * (`chat_metadata` for the current chat, `past_metadata` for the others), and each chat file is
 * messages only - no header line.
 */
function writeOldFormatGroup(directories, { groupId, chatId, messages, chatMetadata }) {
    const group = {
        id: groupId,
        name: 'Old Group',
        members: ['alice.png'],
        chat_id: chatId,
        chats: [chatId],
        chat_metadata: chatMetadata,
        past_metadata: {},
    };
    fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify(group, null, 4));
    fs.writeFileSync(
        path.join(directories.groupChats, `${chatId}.jsonl`),
        messages.map(m => JSON.stringify(m)).join('\n') + '\n',
    );
}

function readGroup(directories, groupId) {
    return JSON.parse(fs.readFileSync(path.join(directories.groups, `${groupId}.json`), 'utf8'));
}

function writeChatFile(directories, name, lines) {
    fs.writeFileSync(path.join(directories.groupChats, `${name}.jsonl`), lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}

/** Every file under a directory with its bytes, to prove a run wrote nothing. */
function snapshot(dir) {
    const out = {};
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const full = path.join(entry.parentPath ?? entry.path, entry.name);
        out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
    return out;
}

describe('metadata migration never strips metadata it did not land', () => {
    test('metadata for a missing chat file, or a chat not in the list, stays in the group JSON; landed metadata is removed', async () => {
        const directories = makeDirectories();
        writeOldFormatGroup(directories, {
            groupId: 'gk',
            chatId: 'chat-missing',
            messages: [],
            chatMetadata: { note_prompt: 'nowhere to go' },
        });
        fs.rmSync(path.join(directories.groupChats, 'chat-missing.jsonl'));
        const group = readGroup(directories, 'gk');
        group.chats.push('chat-here');
        group.past_metadata = { 'chat-here': { note_prompt: 'lands' }, 'chat-orphan': { note_prompt: 'orphan' } };
        fs.writeFileSync(path.join(directories.groups, 'gk.json'), JSON.stringify(group, null, 4));
        writeChatFile(directories, 'chat-here', [makeMessage('here')]);

        await groups.migrateGroupChatsMetadataFormat([directories]);

        const after = readGroup(directories, 'gk');
        expect(after.chat_metadata).toEqual({ note_prompt: 'nowhere to go' });
        expect(after.past_metadata).toEqual({ 'chat-orphan': { note_prompt: 'orphan' } });
        const firstLine = JSON.parse(fs.readFileSync(path.join(directories.groupChats, 'chat-here.jsonl'), 'utf8').split('\n')[0]);
        expect(firstLine.chat_metadata).toEqual({ note_prompt: 'lands' });
        const backup = JSON.parse(fs.readFileSync(path.join(directories.backups, '_group_metadata_update', 'gk.json'), 'utf8'));
        expect(backup.past_metadata['chat-here']).toEqual({ note_prompt: 'lands' });

        // Nothing left that can land: a second run writes nothing.
        const before = snapshot(directories.root);
        await groups.migrateGroupChatsMetadataFormat([directories]);
        expect(snapshot(directories.root)).toEqual(before);
    });

    test('a chat file renamed away (to .pre-migration) keeps its metadata in the group JSON', async () => {
        const directories = makeDirectories();
        writeOldFormatGroup(directories, {
            groupId: 'gr',
            chatId: 'chat-r',
            messages: [makeMessage('r1'), makeMessage('r2')],
            chatMetadata: { note_prompt: 'still here' },
        });
        const chatFile = path.join(directories.groupChats, 'chat-r.jsonl');
        fs.renameSync(chatFile, `${chatFile}.pre-migration`);

        await groups.migrateGroupChatsMetadataFormat([directories]);

        expect(readGroup(directories, 'gr').chat_metadata).toEqual({ note_prompt: 'still here' });
    });

    test('a headerless chat file with a malformed line keeps every line when the header is added', async () => {
        const directories = makeDirectories();
        writeOldFormatGroup(directories, {
            groupId: 'gb',
            chatId: 'chat-b',
            messages: [],
            chatMetadata: { note_prompt: 'm' },
        });
        const original = [JSON.stringify(makeMessage('one')), '{broken', JSON.stringify(makeMessage('two'))].join('\n') + '\n';
        fs.writeFileSync(path.join(directories.groupChats, 'chat-b.jsonl'), original);

        await groups.migrateGroupChatsMetadataFormat([directories]);

        const raw = fs.readFileSync(path.join(directories.groupChats, 'chat-b.jsonl'), 'utf8');
        const [headerLine, ...rest] = raw.split('\n');
        expect(JSON.parse(headerLine).chat_metadata).toEqual({ note_prompt: 'm' });
        expect(rest.join('\n')).toBe(original);
    });
});
