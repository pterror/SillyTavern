// Run as its own process by e2e-global-setup.js: `node e2e-seed-store.js <dataRoot>`. Writes the synthetic old
// user (convert-to-engine.fixture.js) as the default user of the data root and converts it to the engine, so the e2e
// servers run on a store converted from old data. Exits non-zero when the conversion fails.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = process.argv[2];
if (!dataRoot) throw new Error('usage: node e2e-seed-store.js <dataRoot>');
const handle = 'default-user';

setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));
const { buildOldUser } = await import('./convert-to-engine.fixture.js');
await buildOldUser(path.join(dataRoot, handle));
(await import('../src/character-metadata-db.js')).disposeMetadataStores();
(await import('../src/message-tree-db.js')).disposeMessageTreeStores();

const engine = (await import('../engine/load.js')).loadEngine().binding;
const { getBetterSqlite3 } = await import('../src/endpoints/native-sqlite.js');
const code = await (await import('../src/migrations/convert-to-engine.js')).runConversion({
    dataRoot, handle, Database: await getBetterSqlite3(), engine: () => engine, apply: true, serverStopped: true,
    probeServer: async () => ({ running: false, lines: [] }), log: () => {}, warn: () => {},
});
process.exit(code);
