// usage: eslint-staged.mjs all <tree>
//        eslint-staged.mjs changed <tree> <passed tree> <changes>
//        eslint-staged.mjs typed <tree> <passed tree> <changes> [<tsbuildinfo>]
//   (at the top of the work tree) <changes> is `git diff-tree -r --no-renames --name-status -z <passed> <tree>`;
//   <tsbuildinfo> is dangling-refs.mjs's, written for <tree>.
//
// Lints files of src/ and engine/ as they are in <tree>, with the tree's .eslintrc.cjs, and exits 1 on any error:
// `all` every one; `changed` those that differ from <passed>, or every one when the config or ignore file changed;
// `typed` the type-aware ones (an override with parserOptions.project) that aren't among the changed and whose types
// a change can reach. A rule that reads only its own file can fail only in a changed file; a type-aware one reads every
// module its file reaches, and a changed script or `declare global` (the global scope), a deleted module (whose
// importers aren't in the staged graph), or a changed tsconfig or package.json (module resolution) can reach every
// file. The type-aware rules get a program built over <tree>, not the work tree.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

import { stagedFiles, stagedSystem } from './staged-files.mjs';

const [mode, tree, passed, changesFile, buildInfoFile] = process.argv.slice(2);
const toplevel = process.cwd();
const require = createRequire(path.join(toplevel, 'package.json'));
const files = stagedFiles(toplevel, tree);

const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/;
const LINTED = /^(src|engine)\/.*\.js$/;
const relative = (/** @type {string} */ file) => path.relative(toplevel, file).split(path.sep).join('/');

/** @type {[string, string][]} */
const changes = [];
if (mode !== 'all') {
    const fields = fs.readFileSync(changesFile, 'utf8').split('\0');
    for (let at = 0; at + 1 < fields.length; at += 2) changes.push([fields[at], fields[at + 1]]);
}
const kept = changes.filter(([status]) => status !== 'D').map(([, file]) => file);

function stagedConfig() {
    const file = path.join(toplevel, '.eslintrc.cjs');
    const text = files.text(file);
    if (text === undefined) throw new Error('.eslintrc.cjs is not staged');
    const module = new Module(file);
    module.filename = file;
    module.paths = Module._nodeModulePaths(toplevel);
    module._compile(text, file);
    const config = module.exports;
    const ignored = files.text(path.join(toplevel, '.eslintignore'));
    if (ignored !== undefined) {
        config.ignorePatterns = [...[config.ignorePatterns ?? []].flat(), ...ignored.split('\n').filter(line => line.trim() && !line.startsWith('#'))];
    }
    return config;
}

/** @returns {boolean} */
function reachesEverything() {
    const ts = require('typescript');
    for (const [status, file] of changes) {
        if (/(^|\/)(tsconfig[^/]*\.json|package\.json)$/.test(file)) return true;
        if (!CODE.test(file)) continue;
        if (status === 'D') return true;
        const versions = [files.text(path.join(toplevel, file)) ?? ''];
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
    /** @type {string[]} */
    const names = info.fileNames.map((/** @type {string} */ name) => relative(path.resolve(base, name)));
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

/**
 * @param {any} config
 * @returns {string[] | null} The files to lint, null for every one
 */
function targets(config) {
    if (mode === 'all') return null;
    const reconfigured = changes.some(([, file]) => path.basename(file).startsWith('.eslintrc') || path.basename(file) === '.eslintignore' || file === 'package.json');
    /** @type {string[]} */
    const typeAware = [];
    let globbed = false;
    for (const override of config.overrides ?? []) {
        if (!override.parserOptions?.project) continue;
        for (const pattern of [override.files].flat()) {
            if (/[*?[\]{}!]/.test(pattern)) globbed = true;
            const file = path.posix.normalize(pattern);
            if (LINTED.test(file) && files.isFile(path.join(toplevel, file))) typeAware.push(file);
        }
    }
    if (reconfigured || globbed || config.parserOptions?.project) return mode === 'changed' ? null : [];
    const changed = kept.filter(file => LINTED.test(file));
    if (mode === 'changed') return changed;
    const unlinted = typeAware.filter(file => !changed.includes(file));
    if (!unlinted.length || !changes.some(([, file]) => CODE.test(file) || file.endsWith('.json'))) return [];
    const reached = reachesEverything() ? null : dependents();
    return unlinted.filter(file => !reached || reached.has(file));
}

/**
 * The override's project, as a program over the tree.
 * @param {string | string[]} project
 * @param {string} root
 */
function programOf(project, root) {
    const ts = require('typescript');
    const system = stagedSystem(ts, files);
    const programs = [];
    for (const config of [project].flat()) {
        const parsed = ts.getParsedCommandLineOfConfigFile(path.resolve(root, config), {}, { ...system, onUnRecoverableConfigFileDiagnostic: (/** @type {any} */ diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } });
        if (!parsed || parsed.errors.length) throw new Error(`${config} can't be read: ${parsed?.errors.map((/** @type {any} */ error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('; ')}`);
        programs.push(ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences, host: ts.createIncrementalCompilerHost(parsed.options, system) }));
    }
    return programs;
}

async function lint() {
    const nested = [...files.under(path.join(toplevel, 'src')), ...files.under(path.join(toplevel, 'engine'))].filter(file => path.basename(file).startsWith('.eslintrc'));
    if (nested.length) {
        console.log(`eslint-staged.mjs reads only the top .eslintrc.cjs, and these are staged too: ${nested.map(relative).join(', ')}`);
        return 2;
    }
    const config = stagedConfig();
    const chosen = targets(config);
    const list = chosen ?? [...files.under(path.join(toplevel, 'src')), ...files.under(path.join(toplevel, 'engine'))].map(relative).filter(file => LINTED.test(file));
    if (!list.length) return 0;

    const typed = (config.overrides ?? []).filter((/** @type {any} */ override) => override.parserOptions?.project);
    if (typed.length && list.some(file => typed.some((/** @type {any} */ override) => [override.files].flat().some((/** @type {string} */ pattern) => path.posix.normalize(pattern) === file)))) {
        for (const override of typed) {
            const { project, tsconfigRootDir, ...rest } = override.parserOptions;
            override.parserOptions = { ...rest, programs: programOf(project, tsconfigRootDir ?? toplevel) };
        }
    }
    const { ESLint } = require('eslint');
    const eslint = new ESLint({ cwd: toplevel, useEslintrc: false, baseConfig: config, ignorePath: '/dev/null', resolvePluginsRelativeTo: toplevel });
    const results = [];
    for (const file of list) {
        const absolute = path.join(toplevel, file);
        if (await eslint.isPathIgnored(absolute)) continue;
        results.push(...await eslint.lintText(files.text(absolute) ?? '', { filePath: absolute }));
    }
    const formatter = await eslint.loadFormatter('stylish');
    process.stdout.write(await formatter.format(results));
    return results.some(result => result.errorCount > 0) ? 1 : 0;
}

process.exitCode = await lint();
