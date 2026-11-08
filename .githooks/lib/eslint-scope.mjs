// usage: eslint-scope.mjs changed <snapshot tree> <passed tree> <changes>
//        eslint-scope.mjs typed <snapshot tree> <passed tree> <changes> [<tsbuildinfo>]
//   <changes> is `git diff-tree -r --no-renames --name-status -z <passed> <staged>`; <tsbuildinfo> is
//   dangling-refs.mjs's, written for the staged tree over the files the type-aware rules see.
//
// Prints, NUL-separated, the files of src/ and engine/ that eslint has to lint for the staged tree to pass given that
// `passed` did, or `--all`: `changed` the changed files, `typed` the type-aware files (an override with
// parserOptions.project) that aren't among them and whose types a change can reach. A rule that reads only its own
// file can fail only in a changed file; a type-aware one reads every module its file reaches, and a changed script or
// `declare global` (the global scope), a deleted module (whose importers aren't in the staged graph), or a changed
// tsconfig or package.json (module resolution) can reach every file.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const [mode, tree, passed, changesFile, buildInfoFile] = process.argv.slice(2);

const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/;
const LINTED = /^(src|engine)\/.*\.js$/;

/** @type {[string, string][]} */
const changes = [];
const fields = fs.readFileSync(changesFile, 'utf8').split('\0');
for (let at = 0; at + 1 < fields.length; at += 2) changes.push([fields[at], fields[at + 1]]);
const kept = changes.filter(([status]) => status !== 'D').map(([, file]) => file);
const require = createRequire(path.join(tree, 'package.json'));

/** @returns {boolean} */
function reachesEverything() {
    const ts = require('typescript');
    for (const [status, file] of changes) {
        if (/(^|\/)(tsconfig[^/]*\.json|package\.json)$/.test(file)) return true;
        if (!CODE.test(file)) continue;
        if (status === 'D') return true;
        const versions = [fs.readFileSync(path.join(tree, file), 'utf8')];
        if (status !== 'A') versions.push(execFileSync('git', ['cat-file', 'blob', `${passed}:${file}`], { encoding: 'utf8', maxBuffer: 1 << 28 }));
        for (const text of versions) {
            if (/\bdeclare\s+global\b/.test(text) || !ts.isExternalModule(ts.createSourceFile(file, text, ts.ScriptTarget.Latest))) return true;
        }
    }
    return false;
}

/** @returns {Set<string> | null} The files that reach a changed one, or null when the graph can't be read */
function dependents() {
    if (!buildInfoFile) return null;
    let info;
    try {
        info = JSON.parse(fs.readFileSync(buildInfoFile, 'utf8'));
    } catch {
        return null;
    }
    if (info.version !== require('typescript').version || !Array.isArray(info.fileNames) || !Array.isArray(info.fileIdsList) || !Array.isArray(info.referencedMap)) return null;
    const base = path.dirname(buildInfoFile);
    const root = fs.realpathSync(tree);
    /** @type {string[]} */
    const names = info.fileNames.map((/** @type {string} */ name) => path.relative(root, path.resolve(base, name)).split(path.sep).join('/'));
    const ids = new Map(names.map((name, index) => [name, index + 1]));
    /** @type {Map<number, number[]>} */
    const importers = new Map();
    for (const [file, list] of info.referencedMap) {
        for (const reached of info.fileIdsList[list - 1] ?? []) {
            if (!importers.has(reached)) importers.set(reached, []);
            importers.get(reached).push(file);
        }
    }
    const seen = new Set(kept.map(file => ids.get(file)).filter(id => id !== undefined));
    const pending = [...seen];
    while (pending.length) {
        for (const importer of importers.get(pending.pop()) ?? []) {
            if (!seen.has(importer)) {
                seen.add(importer);
                pending.push(importer);
            }
        }
    }
    return new Set([...seen].map(id => names[id - 1]));
}

/** @returns {string} */
function scope() {
    const reconfigured = changes.some(([, file]) => path.basename(file).startsWith('.eslintrc') || path.basename(file) === '.eslintignore' || file === 'package.json');
    const config = require(path.join(tree, '.eslintrc.cjs'));
    /** @type {string[]} */
    const typeAware = [];
    for (const override of config.overrides ?? []) {
        if (!override.parserOptions?.project) continue;
        for (const pattern of [override.files].flat()) {
            if (/[*?[\]{}!]/.test(pattern)) return mode === 'changed' ? '--all' : '';
            const file = path.posix.normalize(pattern);
            if (LINTED.test(file) && fs.existsSync(path.join(tree, file))) typeAware.push(file);
        }
    }
    if (reconfigured || config.parserOptions?.project) return mode === 'changed' ? '--all' : '';
    const changed = kept.filter(file => LINTED.test(file));
    if (mode === 'changed') return changed.join('\0');

    const unlinted = typeAware.filter(file => !changed.includes(file));
    if (!unlinted.length || !changes.some(([, file]) => CODE.test(file) || file.endsWith('.json'))) return '';
    const reached = reachesEverything() ? null : dependents();
    return unlinted.filter(file => !reached || reached.has(file)).join('\0');
}

process.stdout.write(scope());
