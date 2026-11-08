// The files of a git tree as seen at their paths in the work tree, read without checking the tree out. A file's text
// comes from the work tree when it hashes to the tree's blob, else from git. A path under node_modules through a link
// to a directory of the repository (a workspace package, @st/ui -> packages/ui) is that directory's path. Paths
// outside the repository, and in node_modules otherwise, aren't the tree's: `covers` is false for them.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} toplevel The work tree's root
 * @param {string} tree
 */
export function stagedFiles(toplevel, tree) {
    const format = execFileSync('git', ['rev-parse', '--show-object-format'], { cwd: toplevel, encoding: 'utf8' }).trim();
    /** @type {Map<string, string>} */
    const blobs = new Map();
    /** @type {Map<string, { files: string[], directories: string[] }>} */
    const directories = new Map([[toplevel, { files: [], directories: [] }]]);
    const listing = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', tree], { cwd: toplevel, encoding: 'utf8', maxBuffer: 1 << 30 });
    for (const record of listing.split('\0')) {
        if (!record) continue;
        const tab = record.indexOf('\t');
        const [, type, blob] = record.slice(0, tab).split(' ');
        if (type !== 'blob') continue;
        const file = path.join(toplevel, record.slice(tab + 1));
        blobs.set(file, blob);
        let child = file;
        let parent = path.dirname(file);
        let isFile = true;
        for (;;) {
            let entries = directories.get(parent);
            const known = Boolean(entries);
            if (!entries) {
                entries = { files: [], directories: [] };
                directories.set(parent, entries);
            }
            (isFile ? entries.files : entries.directories).push(path.basename(child));
            if (known || parent === toplevel) break;
            isFile = false;
            child = parent;
            parent = path.dirname(parent);
        }
    }

    /** @type {Map<string, string | null>} */
    const links = new Map();
    const modulesSegment = `${path.sep}node_modules${path.sep}`;
    /**
     * @param {string} file An absolute path
     * @returns {string}
     */
    const mapped = (file) => {
        const at = (file + path.sep).indexOf(modulesSegment, toplevel.length - 1);
        if (!file.startsWith(toplevel + path.sep) || at === -1) return file;
        const rest = file.slice(at + modulesSegment.length).split(path.sep);
        const length = rest[0].startsWith('@') ? 2 : 1;
        if (rest.length < length) return file;
        const packageDirectory = file.slice(0, at + modulesSegment.length) + rest.slice(0, length).join(path.sep);
        if (!links.has(packageDirectory)) {
            let target = null;
            try {
                if (fs.lstatSync(packageDirectory).isSymbolicLink()) {
                    target = path.resolve(path.dirname(packageDirectory), fs.readlinkSync(packageDirectory));
                    if (!target.startsWith(toplevel + path.sep) || target.includes(modulesSegment)) target = null;
                }
            } catch {
                target = null;
            }
            links.set(packageDirectory, target);
        }
        const target = links.get(packageDirectory);
        return target ? mapped(path.join(target, ...rest.slice(length))) : file;
    };

    /** @param {string} file */
    const covers = (file) => {
        const resolved = mapped(path.resolve(file));
        return (resolved === toplevel || resolved.startsWith(toplevel + path.sep)) && !(resolved + path.sep).includes(modulesSegment);
    };

    /** @type {Map<string, Buffer>} */
    const read = new Map();
    /** @param {Buffer} bytes */
    const blobOf = (bytes) => crypto.createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    /**
     * @param {string} file
     * @returns {Buffer | undefined}
     */
    const bytes = (file) => {
        const resolved = mapped(path.resolve(file));
        const blob = blobs.get(resolved);
        if (!blob) return undefined;
        let found = read.get(resolved);
        if (!found) {
            try {
                found = fs.readFileSync(resolved);
            } catch {
                found = undefined;
            }
            if (!found || blobOf(found) !== blob) found = execFileSync('git', ['cat-file', 'blob', blob], { cwd: toplevel, maxBuffer: 1 << 30 });
            read.set(resolved, found);
        }
        return found;
    };

    return {
        toplevel,
        covers,
        mapped: (/** @type {string} */ file) => mapped(path.resolve(file)),
        /** @param {string} file */
        isFile: (file) => blobs.has(mapped(path.resolve(file))),
        /** @param {string} file */
        isDirectory: (file) => directories.has(mapped(path.resolve(file))),
        /** @param {string} file */
        exists: (file) => blobs.has(mapped(path.resolve(file))) || directories.has(mapped(path.resolve(file))),
        /**
         * @param {string} directory
         * @returns {{ files: string[], directories: string[] }} The names in it
         */
        entries: (directory) => directories.get(mapped(path.resolve(directory))) ?? { files: [], directories: [] },
        /**
         * @param {string} directory
         * @returns {string[]}
         */
        under: (directory) => {
            const prefix = mapped(path.resolve(directory)) + path.sep;
            return [...blobs.keys()].filter(file => file.startsWith(prefix));
        },
        bytes,
        text: (/** @type {string} */ file) => bytes(file)?.toString('utf8'),
    };
}

/**
 * A TypeScript System whose files under the repository are the tree's.
 * @param {any} ts
 * @param {ReturnType<typeof stagedFiles>} files
 */
export function stagedSystem(ts, files) {
    const { sys } = ts;
    const entries = (/** @type {string} */ directory) => {
        if (files.covers(directory)) return files.entries(directory);
        try {
            const found = { files: /** @type {string[]} */ ([]), directories: /** @type {string[]} */ ([]) };
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                (entry.isDirectory() || (entry.isSymbolicLink() && sys.directoryExists(path.join(directory, entry.name))) ? found.directories : found.files).push(entry.name);
            }
            return found;
        } catch {
            return { files: [], directories: [] };
        }
    };
    const realpath = (/** @type {string} */ file) => (files.covers(file) ? files.mapped(file) : sys.realpath(file));
    return {
        ...sys,
        getCurrentDirectory: () => files.toplevel,
        fileExists: (/** @type {string} */ file) => (files.covers(file) ? files.isFile(file) : sys.fileExists(file)),
        directoryExists: (/** @type {string} */ directory) => (files.covers(directory) ? files.isDirectory(directory) : sys.directoryExists(directory)),
        readFile: (/** @type {string} */ file) => (files.covers(file) ? files.text(file) : sys.readFile(file)),
        getDirectories: (/** @type {string} */ directory) => entries(directory).directories,
        readDirectory: (/** @type {string} */ directory, /** @type {string[]} */ extensions, /** @type {string[]} */ excludes, /** @type {string[]} */ includes, /** @type {number} */ depth) =>
            ts.matchFiles(directory, extensions, excludes, includes, sys.useCaseSensitiveFileNames, files.toplevel, depth, entries, realpath),
        realpath,
        watchFile: undefined,
        watchDirectory: undefined,
    };
}
