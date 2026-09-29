import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/content-manager.js')} */
let contentManager;
/** @type {typeof import('../src/users.js')} */
let users;
/** @type {typeof import('../src/metadata-migration-coordinator.js').MIGRATION_PASSES} */
let MIGRATION_PASSES;
/** @type {string} */
let dataRoot;

const ST_DEFAULT_ID = '1345561466591';

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    contentManager = await import('../src/endpoints/content-manager.js');
    users = await import('../src/users.js');
    ({ MIGRATION_PASSES } = await import('../src/metadata-migration-coordinator.js'));
});

beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-settings-template-test-'));
    globalThis.DATA_ROOT = dataRoot;
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('the default settings template on a fresh install', () => {
    test('shows "ST Default" on Seraphina, as upstream does, and seeds none of the six default tags', async () => {
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const directories = users.getUserDirectories(`fresh-${path.basename(dataRoot)}`);

        // Server startup order: content seeding, the boot chain, then the migration worker's passes.
        await contentManager.checkForNewContent([directories]);
        await Promise.all(await metadataDb.initializeMetadataStores([directories]));
        for (const name of MIGRATION_PASSES) {
            await /** @type {any} */ (metadataDb)[name](directories);
        }

        const definitions = await metadataDb.getTagDefinitions(directories);
        expect(definitions.map(tag => tag.id)).toEqual([ST_DEFAULT_ID]);
        expect(definitions[0]).toMatchObject({ id: ST_DEFAULT_ID, name: 'ST Default', color: 'rgba(108, 32, 32, 1)' });
        expect(await metadataDb.getCharacterTagIds(directories, 'default_Seraphina.png')).toEqual([ST_DEFAULT_ID]);
    });
});
