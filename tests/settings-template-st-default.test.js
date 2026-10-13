import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import path from 'node:path';
import { storedTagDefinitions } from './tag-store-reads.js';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/endpoints/content-manager.js')} */
let contentManager;

const ST_DEFAULT_ID = '1345561466591';

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');
    contentManager = await import('../src/endpoints/content-manager.js');
});

beforeEach(async () => {
    user = await fixture.emptyUser('st-settings-template-test-');
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(async () => {
    jest.restoreAllMocks();
    await user.close();
});

describe('the default settings template on a fresh install', () => {
    test('shows "ST Default" on Seraphina, as upstream does, and seeds none of the six default tags', async () => {
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const { directories } = user;

        // Server startup order: content seeding, then the store's resumed work (the settings tags import).
        await contentManager.checkForNewContent([directories]);
        const { resumeStoreWork } = await import('../src/user-stores.js');
        await resumeStoreWork([directories]);

        const definitions = await storedTagDefinitions(user.store.lib);
        expect(definitions.map(tag => tag.id)).toEqual([ST_DEFAULT_ID]);
        expect(definitions[0]).toMatchObject({ id: ST_DEFAULT_ID, name: 'ST Default', color: 'rgba(108, 32, 32, 1)' });
        expect((await user.store.lib.tags.tagIdsFor(['default_Seraphina.png']))['default_Seraphina.png']).toEqual([ST_DEFAULT_ID]);
    });
});
