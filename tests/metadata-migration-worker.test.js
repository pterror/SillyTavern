import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/metadata-migration-coordinator.js')} */
let coordinatorModule;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;

const WORKER_PATH = path.join(process.cwd(), '..', 'src', 'metadata-migration-worker.js');

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    coordinatorModule = await import('../src/metadata-migration-coordinator.js');
    cardParser = await import('../src/character-card-parser.js');
});

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-metadata-migration-worker-test-'));
    directories = /** @type {any} */ ({
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(() => {
    jest.useRealTimers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/**
 * @param {string} avatar
 * @param {string[]} tags
 */
async function writeCardFile(avatar, tags) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const name = path.parse(avatar).name;
    const data = { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags, creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } };
    const card = { name, spec: 'chara_card_v2', spec_version: '2.0', data };
    await fs.promises.writeFile(path.join(directories.characters, avatar), cardParser.write(baseImage, JSON.stringify(card)));
}

/** Whether `promise` has settled 50ms from now. */
async function isSettled(promise) {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    return settled;
}

/** Stands in for metadata-migration-worker.js: records what the coordinator posts, and lets a test post back. */
class FakeWorker extends EventEmitter {
    constructor(workerData) {
        super();
        this.workerData = workerData;
        /** @type {any[]} */
        this.posted = [];
        this.terminate = jest.fn(async () => {
            this.emit('exit', 1);
            return 1;
        });
        this.unref = jest.fn();
    }

    postMessage(msg) {
        this.posted.push(msg);
    }
}

/** @param {object} [options] */
function fakeSetup(options = {}) {
    /** @type {FakeWorker[]} */
    const workers = [];
    const onChanged = jest.fn();
    const onTagDefinitionsChanged = jest.fn(async () => {});
    const coordinator = coordinatorModule.createMetadataMigrationCoordinator({
        spawnWorker: (workerData) => {
            const worker = new FakeWorker(workerData);
            workers.push(worker);
            return worker;
        },
        waitForBootChain: async () => true,
        onChanged,
        onTagDefinitionsChanged,
        ...options,
    });
    return { coordinator, workers, onChanged, onTagDefinitionsChanged };
}

/** Lets pending promise callbacks run. */
async function flush() {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

/**
 * The real worker, with its console output captured.
 * @returns {{ spawnWorker: (workerData: object) => Worker, output: () => string }}
 */
function realWorkerWithOutput() {
    let text = '';
    return {
        spawnWorker: (workerData) => {
            const worker = new Worker(WORKER_PATH, { workerData, stdout: true });
            worker.stdout.on('data', chunk => { text += chunk; });
            return worker;
        },
        output: () => text,
    };
}

describe('the metadata migration passes run after the server listens', () => {
    test('server-main starts them in postSetupTasks, unawaited, and closes them on exit', () => {
        const source = fs.readFileSync(path.join(process.cwd(), '..', 'src', 'server-main.js'), 'utf8');
        const chainStart = source.indexOf('initUserStorage(globalThis.DATA_ROOT)');
        const listenAt = source.indexOf('new ServerStartup(app, cliArgs).start()', chainStart);
        expect(chainStart).toBeGreaterThan(-1);
        expect(listenAt).toBeGreaterThan(chainStart);

        const preSetup = source.slice(source.indexOf('async function preSetupTasks('));
        const preSetupBody = preSetup.slice(0, preSetup.indexOf('\n}\n'));
        expect(preSetupBody).not.toContain('startMetadataMigrations(');
        expect(preSetupBody).toMatch(/await disposeMetadataMigrationWorkers\(\);\s*disposeMetadataStores\(\);/);

        const postSetup = source.slice(source.indexOf('async function postSetupTasks('));
        const postSetupBody = postSetup.slice(0, postSetup.indexOf('\n}\n'));
        expect(postSetupBody).toContain('startMetadataMigrations(');
        expect(postSetupBody).not.toMatch(/await\s+startMetadataMigrations/);
    });

    test('initializeMetadataStores() no longer runs them', async () => {
        await writeCardFile('Alice.png', ['Beta']);

        await Promise.all(await metadataDb.initializeMetadataStores([directories]));

        expect(await metadataDb.characterRowExists(directories, 'Alice.png')).toBe(true);
        for (const key of [metadataDb.GROUP_NUMERIC_ID_RECOVERY_FLAG, metadataDb.GROUP_FAV_NORMALIZED_FLAG, 'tags_json_migrated', 'card_tags_backfill_completed', 'tag_ids_shallow_json_backfill_completed', 'character_fav_normalized_v1', 'character_tag_ids_normalized_v1', 'orphan_tag_rows_removed_v1', 'group_digest_tag_ids_refreshed_v1']) {
            expect(await metadataDb.getMetaValue(directories, key)).toBeNull();
        }
    });
});

describe('createMetadataMigrationCoordinator()', () => {
    test('spawns a store\'s worker only once its boot chain has finished', async () => {
        /** @type {(ok: boolean) => void} */
        let finishChain = () => {};
        const { coordinator, workers } = fakeSetup({
            waitForBootChain: () => new Promise(resolve => { finishChain = resolve; }),
        });

        const done = coordinator.start(directories);
        await flush();
        expect(workers).toHaveLength(0);

        finishChain(true);
        await flush();
        expect(workers).toHaveLength(1);
        expect(workers[0].workerData.directories).toBe(directories);
        expect(await isSettled(done)).toBe(false);

        workers[0].emit('exit', 0);
        await done;
    });

    test('never spawns a worker for a store whose boot chain failed', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const { coordinator, workers } = fakeSetup({ waitForBootChain: async () => false });

        await coordinator.start(directories);

        expect(workers).toHaveLength(0);
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });

    test('one worker per store', async () => {
        const { coordinator, workers } = fakeSetup();
        const first = coordinator.start(directories);
        const second = coordinator.start(directories);
        await flush();

        expect(workers).toHaveLength(1);
        workers[0].emit('exit', 0);
        await Promise.all([first, second]);
    });

    test('a batch that wrote change rows emits one \'change\'; one that wrote tag definitions clears the tag cache', async () => {
        const { coordinator, workers, onChanged, onTagDefinitionsChanged } = fakeSetup();
        const done = coordinator.start(directories);
        await flush();
        const worker = workers[0];

        worker.emit('message', { type: 'batch', changed: false, tagDefinitionsChanged: true });
        await flush();
        expect(onTagDefinitionsChanged).toHaveBeenCalledTimes(1);
        expect(onTagDefinitionsChanged).toHaveBeenCalledWith(directories);
        expect(onChanged).not.toHaveBeenCalled();

        worker.emit('message', { type: 'batch', changed: true, tagDefinitionsChanged: false });
        await flush();
        expect(onChanged).toHaveBeenCalledTimes(1);
        expect(onTagDefinitionsChanged).toHaveBeenCalledTimes(1);

        worker.emit('exit', 0);
        await done;
    });

    test('a batch that logged tag changes is handed to onTagChangesLogged, after the tag cache is cleared', async () => {
        /** @type {string[]} */
        const calls = [];
        const onTagChangesLogged = jest.fn(() => { calls.push('logged'); });
        const onTagDefinitionsChanged = jest.fn(async () => {
            await flush();
            calls.push('cache-cleared');
        });
        const { coordinator, workers } = fakeSetup({ onTagChangesLogged, onTagDefinitionsChanged });
        const done = coordinator.start(directories);
        await flush();

        workers[0].emit('message', { type: 'batch', changed: false, tagDefinitionsChanged: true, tagChangesLogged: true });
        await flush();
        await flush();
        expect(calls).toEqual(['cache-cleared', 'logged']);
        expect(onTagChangesLogged).toHaveBeenCalledWith(directories);

        workers[0].emit('message', { type: 'batch', changed: true, tagDefinitionsChanged: false, tagChangesLogged: false });
        await flush();
        expect(onTagChangesLogged).toHaveBeenCalledTimes(1);

        workers[0].emit('exit', 0);
        await done;
    });

    test('a batch that wrote groups version rows is handed to onGroupChangesLogged; one that did not is not', async () => {
        const onGroupChangesLogged = jest.fn();
        const { coordinator, workers } = fakeSetup({ onGroupChangesLogged });
        const done = coordinator.start(directories);
        await flush();

        workers[0].emit('message', { type: 'batch', changed: false, tagDefinitionsChanged: false, tagChangesLogged: false, groupChangesLogged: true });
        await flush();
        expect(onGroupChangesLogged).toHaveBeenCalledTimes(1);

        workers[0].emit('message', { type: 'batch', changed: true, tagDefinitionsChanged: false, tagChangesLogged: false, groupChangesLogged: false });
        await flush();
        expect(onGroupChangesLogged).toHaveBeenCalledTimes(1);

        workers[0].emit('exit', 0);
        await done;
    });

    test('the chat stats a worker queued are counted on this thread after each batch and once it has exited', async () => {
        const onChatStatsMayBeQueued = jest.fn();
        const { coordinator, workers } = fakeSetup({ onChatStatsMayBeQueued });
        const done = coordinator.start(directories);
        await flush();
        const worker = workers[0];

        worker.emit('message', { type: 'batch', changed: false, tagDefinitionsChanged: false });
        await flush();
        expect(onChatStatsMayBeQueued).toHaveBeenCalledTimes(1);
        expect(onChatStatsMayBeQueued).toHaveBeenCalledWith(directories);

        worker.emit('exit', 0);
        await done;
        expect(onChatStatsMayBeQueued).toHaveBeenCalledTimes(2);
    });

    test('a tag-move-failed message is handed to onTagMoveFailed with its payload', async () => {
        const onTagMoveFailed = jest.fn();
        const { coordinator, workers } = fakeSetup({ onTagMoveFailed });
        const done = coordinator.start(directories);
        await flush();
        const payload = { tagId: 'x', tagName: 'Ex', anchorId: 'a', anchorName: null, refusedId: 'a', reason: 'deleted' };

        workers[0].emit('message', { type: 'tag-move-failed', payload });
        await flush();
        expect(onTagMoveFailed).toHaveBeenCalledTimes(1);
        expect(onTagMoveFailed).toHaveBeenCalledWith(directories, payload);

        workers[0].emit('exit', 0);
        await done;
    });

    test('a tag-order-settled message clears the tag cache, then is handed to onTagOrderSettled', async () => {
        /** @type {string[]} */
        const calls = [];
        const onTagOrderSettled = jest.fn(() => { calls.push('settled'); });
        const onTagDefinitionsChanged = jest.fn(async () => {
            await new Promise(resolve => setImmediate(resolve));
            calls.push('cache cleared');
        });
        const { coordinator, workers } = fakeSetup({ onTagOrderSettled, onTagDefinitionsChanged });
        const done = coordinator.start(directories);
        await flush();

        workers[0].emit('message', { type: 'tag-order-settled' });
        await flush();
        expect(calls).toEqual(['cache cleared', 'settled']);
        expect(onTagOrderSettled).toHaveBeenCalledWith(directories);

        workers[0].emit('exit', 0);
        await done;
    });

    test('dispose() asks the worker to close, and terminates it if it has not exited in time', async () => {
        const { coordinator, workers } = fakeSetup();
        const done = coordinator.start(directories);
        await flush();
        const worker = workers[0];

        jest.useFakeTimers();
        const disposed = coordinator.dispose();
        expect(worker.posted).toEqual([{ type: 'close' }]);
        expect(worker.terminate).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(10000);
        await disposed;
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        await done;
    });

    test('dispose() leaves a worker that exits in time alone', async () => {
        const { coordinator, workers } = fakeSetup();
        const done = coordinator.start(directories);
        await flush();
        const worker = workers[0];

        const disposed = coordinator.dispose();
        worker.emit('exit', 0);
        await disposed;
        await done;
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    test('a store whose boot chain finishes after dispose() never gets a worker', async () => {
        /** @type {(ok: boolean) => void} */
        let finishChain = () => {};
        const { coordinator, workers } = fakeSetup({
            waitForBootChain: () => new Promise(resolve => { finishChain = resolve; }),
        });
        const done = coordinator.start(directories);
        await coordinator.dispose();
        finishChain(true);
        await done;
        expect(workers).toHaveLength(0);
    });
});

describe('metadata-migration-worker.js', () => {
    test('runs the passes in order, after the store\'s boot chain, with a boot-timing line per pass', async () => {
        await writeCardFile('Alice.png', ['Beta']);
        await Promise.all(await metadataDb.initializeMetadataStores([directories]));
        const { spawnWorker, output } = realWorkerWithOutput();

        await coordinatorModule.createMetadataMigrationCoordinator({ spawnWorker }).start(directories);

        const lines = output().split('\n');
        const started = lines
            .map(line => line.match(/^\[boot-timing\] \[metadata-migrations\] \((.*)\) (\w+): start$/))
            .filter(match => match && match[1] === directories.root)
            .map(match => match?.[2]);
        expect(started).toEqual([...coordinatorModule.MIGRATION_PASSES]);
        for (const name of coordinatorModule.MIGRATION_PASSES) {
            expect(lines.some(line => new RegExp(`^\\[boot-timing\\] \\[metadata-migrations\\] \\(.*\\) ${name}: [0-9.]+ms`).test(line))).toBe(true);
        }
        expect(await metadataDb.getMetaValue(directories, 'character_tag_ids_normalized_v1')).not.toBeNull();
    });

    test('a tag the worker creates is reused, not created again, by a later write in this process', async () => {
        await writeCardFile('Alice.png', ['Beta']);
        await writeCardFile('Carol.png', ['Beta']);
        await Promise.all(await metadataDb.initializeMetadataStores([directories]));
        // Loads this process's tag cache while no tag exists yet.
        expect((await metadataDb.seedCardTagsForSingleCharacter(directories, 'Carol.png', { onlyExisting: true })).tagIds).toEqual([]);

        await coordinatorModule.createMetadataMigrationCoordinator().start(directories);
        const { tagIds } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Carol.png');

        const betas = (await metadataDb.getTagDefinitions(directories) ?? []).filter(tag => /** @type {any} */ (tag).name === 'Beta');
        expect(betas).toHaveLength(1);
        expect(tagIds).toEqual([/** @type {any} */ (betas[0]).id]);
    });

    test('this process emits \'change\' when the worker wrote change rows, and not when it wrote none', async () => {
        await writeCardFile('Alice.png', ['Beta']);
        await Promise.all(await metadataDb.initializeMetadataStores([directories]));
        const onChange = jest.fn();
        metadataDb.characterChangeEmitter.on('change', onChange);
        try {
            await coordinatorModule.createMetadataMigrationCoordinator().start(directories);
            expect(onChange).toHaveBeenCalled();

            onChange.mockClear();
            await coordinatorModule.createMetadataMigrationCoordinator().start(directories);
            expect(onChange).not.toHaveBeenCalled();
        } finally {
            metadataDb.characterChangeEmitter.off('change', onChange);
        }
    });
});

describe('createMetadataMigrationCoordinator().request(): a pass on demand', () => {
    test('spawns a worker that runs only the requested pass, once the store\'s boot chain has finished', async () => {
        /** @type {(ok: boolean) => void} */
        let finishChain = () => {};
        const { coordinator, workers } = fakeSetup({
            waitForBootChain: () => new Promise(resolve => { finishChain = resolve; }),
        });

        const done = coordinator.request(directories, 'finishDeletedTags');
        await flush();
        expect(workers).toHaveLength(0);

        finishChain(true);
        await flush();
        expect(workers).toHaveLength(1);
        expect(workers[0].workerData.directories).toBe(directories);
        expect(workers[0].workerData.passes).toEqual(['finishDeletedTags']);
        expect(workers[0].workerData.boot).toBe(false);
        expect(await isSettled(done)).toBe(false);

        workers[0].emit('exit', 0);
        await done;
        expect(await isSettled(coordinator.idle(directories))).toBe(true);
    });

    test('requests while a run is going make exactly one more run, after it exits', async () => {
        const { coordinator, workers } = fakeSetup();
        const first = coordinator.request(directories, 'finishDeletedTags');
        await flush();
        expect(workers).toHaveLength(1);

        const second = coordinator.request(directories, 'finishDeletedTags');
        const third = coordinator.request(directories, 'finishDeletedTags');
        await flush();
        expect(workers).toHaveLength(1);
        expect(second).toBe(third);

        workers[0].emit('exit', 0);
        await first;
        await flush();
        expect(workers).toHaveLength(2);
        expect(workers[1].workerData.passes).toEqual(['finishDeletedTags']);
        expect(await isSettled(second)).toBe(false);

        workers[1].emit('exit', 0);
        await second;
        await flush();
        expect(workers).toHaveLength(2);
        expect(await isSettled(coordinator.idle(directories))).toBe(true);
    });

    test('a request after a run has finished starts a new run', async () => {
        const { coordinator, workers } = fakeSetup();
        const first = coordinator.request(directories, 'finishDeletedTags');
        await flush();
        workers[0].emit('exit', 0);
        await first;

        const second = coordinator.request(directories, 'finishDeletedTags');
        await flush();
        expect(workers).toHaveLength(2);
        workers[1].emit('exit', 0);
        await second;
    });

    test('a request while the boot run is going waits for it, then runs once', async () => {
        const { coordinator, workers } = fakeSetup();
        const boot = coordinator.start(directories);
        await flush();
        expect(workers).toHaveLength(1);
        expect(workers[0].workerData.passes).toEqual([...coordinatorModule.MIGRATION_PASSES]);
        expect(workers[0].workerData.boot).toBe(true);

        const requested = coordinator.request(directories, 'finishDeletedTags');
        await flush();
        expect(workers).toHaveLength(1);

        workers[0].emit('exit', 0);
        await boot;
        await flush();
        expect(workers).toHaveLength(2);
        expect(workers[1].workerData.passes).toEqual(['finishDeletedTags']);
        expect(workers[1].workerData.boot).toBe(false);
        workers[1].emit('exit', 0);
        await requested;
    });

    test('start() while a requested run is going runs the boot passes after it', async () => {
        const { coordinator, workers } = fakeSetup();
        const requested = coordinator.request(directories, 'finishDeletedTags');
        await flush();
        const boot = coordinator.start(directories);
        await flush();
        expect(workers).toHaveLength(1);

        workers[0].emit('exit', 0);
        await requested;
        await flush();
        expect(workers).toHaveLength(2);
        expect(workers[1].workerData.passes).toEqual([...coordinatorModule.MIGRATION_PASSES]);
        expect(workers[1].workerData.boot).toBe(true);
        workers[1].emit('exit', 0);
        await boot;
    });

    test('the requested run\'s batches clear the tag cache and emit \'change\' like the boot run\'s', async () => {
        const { coordinator, workers, onChanged, onTagDefinitionsChanged } = fakeSetup();
        const done = coordinator.request(directories, 'finishDeletedTags');
        await flush();
        workers[0].emit('message', { type: 'batch', changed: true, tagDefinitionsChanged: true });
        workers[0].emit('exit', 0);
        await done;
        expect(onTagDefinitionsChanged).toHaveBeenCalledWith(directories);
        expect(onChanged).toHaveBeenCalledTimes(1);
    });

    test('dispose() closes a requested run\'s worker, and nothing queued behind it starts', async () => {
        const { coordinator, workers } = fakeSetup();
        const first = coordinator.request(directories, 'finishDeletedTags');
        await flush();
        const second = coordinator.request(directories, 'finishDeletedTags');

        const disposed = coordinator.dispose();
        expect(workers[0].posted).toEqual([{ type: 'close' }]);
        workers[0].emit('exit', 0);
        await disposed;
        await Promise.all([first, second]);
        expect(workers).toHaveLength(1);

        await coordinator.request(directories, 'finishDeletedTags');
        expect(workers).toHaveLength(1);
    });

    test('a pass that isn\'t a migration pass is refused', async () => {
        const { coordinator, workers } = fakeSetup();
        await expect(coordinator.request(directories, 'disposeMetadataStores')).rejects.toThrow('disposeMetadataStores');
        await flush();
        expect(workers).toHaveLength(0);
    });

    test('the real worker runs only the requested pass', async () => {
        await writeCardFile('Alice.png', ['Beta']);
        await Promise.all(await metadataDb.initializeMetadataStores([directories]));
        const { spawnWorker, output } = realWorkerWithOutput();

        await coordinatorModule.createMetadataMigrationCoordinator({ spawnWorker }).request(directories, 'finishDeletedTags');

        const started = output().split('\n')
            .map(line => line.match(/\[metadata-migrations\] \((.*)\) (\w+): start$/))
            .filter(match => match && match[1] === directories.root)
            .map(match => match?.[2]);
        expect(started).toEqual(['finishDeletedTags']);
        expect(output()).not.toContain('[boot-timing]');
        expect(await metadataDb.getMetaValue(directories, 'character_tag_ids_normalized_v1')).toBeNull();
    });
});
