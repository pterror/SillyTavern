import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/convert-tag-looks.mjs --data-root <data folder>\nRun it with the server stopped: it refuses while another process has a store open. It moves each tag\'s colors into its look; running it again changes nothing.';

const args = process.argv.slice(2);
const at = args.indexOf('--data-root');
const dataRoot = at === -1 ? undefined : args[at + 1];
if (!dataRoot || args.length !== 2) {
    console.error(USAGE);
    process.exit(2);
}

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(path.join(ROOT, 'default', 'config.yaml'));
const { STORE_DIR } = await import('../src/user-stores.js');

const stores = fs.readdirSync(dataRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(dataRoot, d.name, STORE_DIR)))
    .map(d => fs.realpathSync(path.join(dataRoot, d.name, STORE_DIR)));

/**
 * The processes other than this one with a file under one of `dirs` open, from Linux's /proc; null where that can't be
 * read. The store has no lock of its own, and a running server holds every store open.
 * @param {string[]} dirs
 * @returns {string[] | null}
 */
function processesHolding(dirs) {
    if (process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')) return null;
    const own = String(process.pid);
    const holding = [];
    for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid) || pid === own) continue;
        let fds;
        try {
            fds = fs.readdirSync(`/proc/${pid}/fd`);
        } catch {
            continue;
        }
        const holds = fds.some(fd => {
            try {
                const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
                return dirs.some(dir => target === dir || target.startsWith(dir + path.sep));
            } catch {
                return false;
            }
        });
        if (holds) holding.push(pid);
    }
    return holding;
}

const holding = processesHolding(stores);
if (holding === null) {
    console.error('This system can\'t be checked for a running server, so nothing was converted.');
    process.exit(1);
}
if (holding.length > 0) {
    console.error(`A store is open in process ${holding.join(', ')}: stop the server and run this again. Nothing was converted.`);
    process.exit(1);
}

const { loadEngine } = await import('../engine/load.js');
const { LibraryEngine } = await import('../src/library-engine.js');
const { convertTagColors } = await import('../src/tag-look-conversion.js');

const engine = loadEngine().binding;
let tags = 0;
let converted = 0;
let refused = 0;
for (const dir of stores) {
    const lib = await LibraryEngine.open(engine, dir);
    try {
        const done = await convertTagColors(lib);
        tags += done.tags;
        converted += done.converted;
        refused += done.refused;
    } finally {
        await lib.close();
    }
}

console.log(`Users: ${stores.length}. Tags looked at: ${tags}. Tags whose colors moved into their look: ${converted}. Colors left out as no look can hold them: ${refused}.`);
