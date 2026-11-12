import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/convert-message-order.mjs --data-root <data folder>\nRun it once, with the server stopped (the store has no lock against a second process), before the server runs this engine. A store it has converted is marked and skipped after.';

const args = process.argv.slice(2);
const at = args.indexOf('--data-root');
const dataRoot = at === -1 ? undefined : args[at + 1];
if (!dataRoot || args.length !== 2) {
    console.error(USAGE);
    process.exit(2);
}

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(path.join(ROOT, 'default', 'config.yaml'));
const { loadEngine } = await import('../engine/load.js');
const { LibraryEngine } = await import('../src/library-engine.js');
const { MESSAGE_ORDER, STORE_DIR } = await import('../src/user-stores.js');
const { ChatEngine } = await import('../src/chat-engine.js');
const { libraryPeople } = await import('../src/chat-people.js');

const STEP = 2000;
const TREES = 1000;

const engine = loadEngine().binding;
const users = fs.readdirSync(dataRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(dataRoot, d.name, STORE_DIR)))
    .map(d => d.name);

let skipped = 0;
let steps = 0;
let grouped = 0;
for (const handle of users) {
    const dir = path.join(dataRoot, handle, STORE_DIR);
    const marker = path.join(dir, MESSAGE_ORDER);
    if (fs.existsSync(marker)) {
        skipped++;
        continue;
    }
    const lib = await LibraryEngine.open(engine, dir);
    try {
        let more = true;
        while (more) {
            more = await lib.store.messageOrderConversionStep(STEP);
            steps++;
        }
        const chats = await ChatEngine.open(lib.store, libraryPeople(lib), await lib.nextIds());
        let after = null;
        do {
            const page = await lib.store.chatRead('ungroupedTrees', { ...(after === null ? {} : { after }), limit: TREES });
            for (const tree of page.trees) grouped += await chats.groupOpenings({ tree, actor: { user: handle } });
            after = page.next;
        } while (after !== null);
    } finally {
        await lib.close();
    }
    fs.writeFileSync(marker, '');
}

console.log(`Users: ${users.length} (${skipped} already converted). Steps of ${STEP} messages: ${steps}. Openings put in their greeting's group: ${grouped}. Every message's alternatives, and every chat's openings, keep the order they had, in lists of their own.`);
