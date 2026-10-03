import { describe, test, expect, jest, beforeAll, afterAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';
const { openWasmDatabase } = realSqliteEngine;

const { Database: WasmDatabase } = NodeSqlite3Wasm;

// A native sqlite build is not guaranteed in every test environment; wasm is.
jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    ...realSqliteEngine,
    getSqliteEngine: jest.fn(async () => ({
        kind: 'wasm',
        openDatabase: (dbPath, options) => openWasmDatabase(WasmDatabase, dbPath, options),
    })),
    openNativeDatabase: jest.fn(),
}));

// Lets a test hold migrateGroupChatsMetadataFormat() at its chat-file write, after it has read the group JSON and before it
// writes it back - the window a concurrent group save would fall into.
// Mocked at the copy src/ resolves (the repo root's node_modules), not tests/node_modules' own.
const srcRequire = createRequire(new URL('../src/endpoints/groups.js', import.meta.url));
const writeFileAtomicPath = srcRequire.resolve('write-file-atomic');
const realWriteFileAtomic = srcRequire('write-file-atomic');
/** @type {{ reached: () => void, released: Promise<void> } | null} */
let chatWriteGate = null;
jest.unstable_mockModule(writeFileAtomicPath, () => ({
    default: async (...args) => {
        const gate = chatWriteGate;
        if (gate) {
            chatWriteGate = null;
            gate.reached();
            await gate.released;
        }
        return realWriteFileAtomic(...args);
    },
    sync: realWriteFileAtomic.sync,
}));

/** Arms the gate; resolves `reached` when the migration arrives at it, and `release()` lets it go on. */
function armChatWriteGate() {
    /** @type {() => void} */
    let release = () => {};
    /** @type {Promise<void>} */
    let reached;
    const released = new Promise(resolve => { release = () => resolve(undefined); });
    reached = new Promise(resolve => {
        chatWriteGate = { reached: () => resolve(undefined), released };
    });
    return { reached, release };
}

/** @type {typeof import('../src/message-tree-db.js')} */
let treeDb;
/** @type {typeof import('../src/endpoints/groups.js')} */
let groups;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('node:http').Server} */
let server;
let baseUrl = '';
/** @type {any} */
let requestDirectories = null;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    treeDb = await import('../src/message-tree-db.js');
    groups = await import('../src/endpoints/groups.js');
    metadataDb = await import('../src/character-metadata-db.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories: requestDirectories, profile: { handle: `test-user-${path.basename(requestDirectories.root)}` } };
        next();
    });
    app.use('/api/groups', groups.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Creating both stores' schemas on the wasm engine takes about a second; done once here and copied into each
    // test's fresh directory, so no test's time depends on how loaded the machine is.
    const template = makeDirectories();
    await metadataDb.ensureSchemaMigrated(template);
    await treeDb.getMessageTreeDb(template);
    treeDb.disposeMessageTreeStores();
    metadataDb.disposeMetadataStores();
    templateDbFiles = fs.readdirSync(template.root)
        .filter(name => name.endsWith('.sqlite'))
        .map(name => ({ name, bytes: fs.readFileSync(path.join(template.root, name)) }));
    fs.rmSync(template.root, { recursive: true, force: true });
    tmpDirs.splice(tmpDirs.indexOf(template.root), 1);
});

/** @type {{ name: string, bytes: Buffer }[]} */
let templateDbFiles = [];

afterAll(() => new Promise(resolve => server.close(resolve)));

const tmpDirs = [];

afterEach(() => {
    chatWriteGate = null;
    requestDirectories = null;
    treeDb.disposeMessageTreeStores();
    metadataDb.disposeMetadataStores();
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
    for (const file of templateDbFiles) {
        fs.writeFileSync(path.join(root, file.name), file.bytes);
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

async function postJson(urlPath, body) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
}

/** Whether `promise` has settled 50ms from now. */
async function isSettled(promise) {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    return settled;
}

describe('group writes during the metadata migration', () => {
    test('a group save racing it is not lost', async () => {
        const directories = makeDirectories();
        requestDirectories = directories;
        writeOldFormatGroup(directories, {
            groupId: 'g-race',
            chatId: 'chat-race',
            messages: [makeMessage('r-first'), makeMessage('r-second')],
            chatMetadata: { note_prompt: 'race meta' },
        });

        const gate = armChatWriteGate();
        const pass = groups.migrateGroupChatsMetadataFormat([directories]);
        await gate.reached;

        const save = postJson('/api/groups/save-partial', { id: 'g-race', props: { name: 'Renamed mid-migration' } });
        // The save waits for the group's lock, which the migration holds until its step for this group is done.
        expect(await isSettled(save)).toBe(false);
        gate.release();
        await Promise.all([pass, save]);

        const after = readGroup(directories, 'g-race');
        expect(after.name).toBe('Renamed mid-migration');
        expect(Object.hasOwn(after, 'chat_metadata')).toBe(false);
        const [headerLine] = fs.readFileSync(path.join(directories.groupChats, 'chat-race.jsonl'), 'utf8').split('\n');
        expect(JSON.parse(headerLine).chat_metadata).toEqual({ note_prompt: 'race meta' });
    });
});
