import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE = 'a lorebook whose originalData is an object with an entries list: the character card\'s own book, which "Import Card Lore" kept inside every copy it made';
const USAGE = 'Usage: node scripts/remove-card-lorebook-copies.mjs --data-root <data folder> [--remove]\nRun it with the server stopped: the store has no lock against a second process. Without --remove it only counts.';

const args = process.argv.slice(2);
const at = args.indexOf('--data-root');
const dataRoot = at === -1 ? undefined : args[at + 1];
const remove = args.includes('--remove');
if (!dataRoot || args.some((a, i) => a !== '--remove' && a !== '--data-root' && i !== at + 1)) {
    console.error(USAGE);
    process.exit(2);
}

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(path.join(ROOT, 'default', 'config.yaml'));
const { loadEngine } = await import('../engine/load.js');
const { LibraryEngine } = await import('../src/library-engine.js');
const { bookKey } = await import('../src/world-info-keys.js');

const engine = loadEngine().binding;
const users = fs.readdirSync(dataRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(dataRoot, d.name, 'store')))
    .map(d => d.name);

let scanned = 0;
let found = 0;
let removed = 0;
let unremovable = 0;
for (const handle of users) {
    const lib = await LibraryEngine.open(engine, path.join(dataRoot, handle, 'store'));
    try {
        let after;
        for (;;) {
            const page = await lib.books.cardCopyPage({ after });
            scanned += page.scanned;
            found += page.copies.length;
            if (remove) {
                for (const key of page.copies) {
                    if (bookKey(key) === key && await lib.books.delete(key)) removed++;
                    else unremovable++;
                }
            }
            if (!page.more) break;
            after = page.after;
        }
    } finally {
        await lib.close();
    }
}

console.log(`Rule: ${RULE}.`);
console.log(`Users: ${users.length}. Lorebooks scanned: ${scanned}. ${remove ? 'Copies found' : 'Would remove'}: ${found}.`);
if (remove) console.log(`Removed: ${removed}. Not removed: ${unremovable}.`);
