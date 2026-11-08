// Module hooks (node:module register) that load the repository's modules as they are in a tree: `data` is
// { toplevel, tree }. Modules outside the repository, node_modules among them, load as usual.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stagedFiles } from './staged-files.mjs';

/** @type {ReturnType<typeof stagedFiles>} */
let files;

/** @param {{ toplevel: string, tree: string }} data */
export function initialize(data) {
    files = stagedFiles(data.toplevel, data.tree);
}

/** @param {string} file */
function formatOf(file) {
    if (file.endsWith('.mjs')) return 'module';
    if (file.endsWith('.cjs')) return 'commonjs';
    if (file.endsWith('.json')) return 'json';
    for (let directory = path.dirname(file); files.covers(directory); directory = path.dirname(directory)) {
        const manifest = files.text(path.join(directory, 'package.json'));
        if (manifest !== undefined) return JSON.parse(manifest).type === 'module' ? 'module' : 'commonjs';
        if (directory === files.toplevel) break;
    }
    return 'commonjs';
}

/** @param {string} file */
function notStaged(file) {
    return Object.assign(new Error(`Cannot find module '${file}': it isn't in the tree being checked`), { code: 'ERR_MODULE_NOT_FOUND' });
}

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {Function} next
 */
export async function resolve(specifier, context, next) {
    if (context.parentURL?.startsWith('file:') && /^(\.{1,2}\/|\/|file:)/.test(specifier)) {
        const url = new URL(specifier, context.parentURL);
        const file = fileURLToPath(url);
        if (files.covers(file)) {
            if (!files.isFile(file)) throw notStaged(file);
            return { url: url.href, format: formatOf(file), shortCircuit: true };
        }
    }
    return next(specifier, context);
}

/**
 * @param {string} url
 * @param {{ format?: string }} context
 * @param {Function} next
 */
export async function load(url, context, next) {
    if (url.startsWith('file:')) {
        const file = fileURLToPath(url);
        if (files.covers(file)) {
            const source = files.bytes(file);
            if (!source) throw notStaged(file);
            return { format: context.format ?? formatOf(file), source, shortCircuit: true };
        }
    }
    return next(url, context);
}
