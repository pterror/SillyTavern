// Run as its own process by e2e-global-setup.js: `node e2e-seed-store.js <dataRoot>`. Writes the standard test user
// (standard-user.fixture.js) as the default user of the data root, so the e2e servers run on its store.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = process.argv[2];
if (!dataRoot) throw new Error('usage: node e2e-seed-store.js <dataRoot>');
const handle = 'default-user';

setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));
const engine = (await import('../engine/load.js')).loadEngine().binding;
const stores = await import('../src/user-stores.js');
stores.setStoreEngine(() => engine);
const root = path.join(dataRoot, handle);
/** @type {any} */
const directories = { root };
for (const [k, v] of Object.entries(USER_DIRECTORY_TEMPLATE)) directories[k] = path.join(root, /** @type {string} */ (v));
for (const d of Object.values(directories)) fs.mkdirSync(d, { recursive: true });
const store = await stores.userStore(directories, handle);
await (await import('./standard-user.fixture.js')).buildStandardUser({ directories, store, handle });
await stores.closeUserStores();
