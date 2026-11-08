// usage: run-staged.mjs <tree> <module> <function> <cache>   (at the top of the work tree)
// Runs the export <function>(root, { cache, files }) of <module> (a path in the repository) as both are in <tree>,
// with `files` reading the tree, prints the lines it returns and exits 1 if there are any.

import { register } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { stagedFiles } from './staged-files.mjs';

const [tree, modulePath, name, cache] = process.argv.slice(2);
const toplevel = process.cwd();
register('./staged-modules.mjs', import.meta.url, { data: { toplevel, tree } });

const staged = stagedFiles(toplevel, tree);
const files = {
    list: (/** @type {string} */ directory) => staged.under(directory),
    read: (/** @type {string} */ file) => {
        const text = staged.text(file);
        if (text === undefined) throw new Error(`${file} isn't in the tree being checked`);
        return text;
    },
    exists: (/** @type {string} */ file) => staged.exists(file),
};

const module = await import(pathToFileURL(path.join(toplevel, modulePath)).href);
const lines = module[name](toplevel, { cache, files });
if (lines.length) {
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = 1;
}
