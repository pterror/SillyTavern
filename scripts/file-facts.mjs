import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Facts derived from one file's text alone, stored under a hash of the text. `version` must name everything else the
 * facts depend on (the deriving code, the parser's version).
 * @template T
 * @param {string} directory
 * @param {string} version
 * @returns {{ factsOf: (file: string, source: string, compute: (source: string) => T) => T, prune: () => void }}
 */
export function fileFacts(directory, version) {
    const root = path.join(directory, crypto.createHash('sha256').update(version).digest('hex').slice(0, 16));
    fs.mkdirSync(root, { recursive: true });
    for (const other of fs.readdirSync(directory)) {
        if (path.join(directory, other) !== root) fs.rmSync(path.join(directory, other), { recursive: true, force: true });
    }
    const stored = new Set(fs.readdirSync(root));
    const used = new Set();
    return {
        factsOf(file, source, compute) {
            const key = crypto.createHash('sha256').update(path.extname(file)).update('\0').update(source).digest('hex');
            used.add(key);
            if (stored.has(key)) return JSON.parse(fs.readFileSync(path.join(root, key), 'utf8'));
            const facts = compute(source);
            const temporary = path.join(root, `${key}.${process.pid}`);
            fs.writeFileSync(temporary, JSON.stringify(facts));
            fs.renameSync(temporary, path.join(root, key));
            stored.add(key);
            return facts;
        },
        prune() {
            for (const key of stored) if (!used.has(key)) fs.rmSync(path.join(root, key), { force: true });
        },
    };
}

/**
 * @template T
 * @returns {{ factsOf: (file: string, source: string, compute: (source: string) => T) => T, prune: () => void }}
 */
export function uncachedFacts() {
    return { factsOf: (file, source, compute) => compute(source), prune() {} };
}

/**
 * Where a script reads the repository's files: the work tree by default, or the tree a commit records.
 * @typedef {object} Files
 * @property {(directory: string) => string[]} list Every file under the directory, as absolute paths
 * @property {(file: string) => string} read
 * @property {(file: string) => boolean} exists A file or a directory
 */

/**
 * @param {string[]} argv
 * @returns {{ cache: string | null, rest: string[] }}
 */
export function cacheArgument(argv) {
    const at = argv.indexOf('--cache');
    if (at === -1) return { cache: null, rest: argv };
    return { cache: argv[at + 1], rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}
