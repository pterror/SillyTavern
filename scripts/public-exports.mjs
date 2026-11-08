import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as espree from 'espree';

import { cacheArgument, fileFacts, uncachedFacts } from './file-facts.mjs';

/** Exports kept although nothing imports them: a module of JSDoc typedefs needs one to be a module. */
const KEPT = new Set(['public/scripts/char-data.js\tdefault']);

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'lib', '.git', 'data', 'dist', 'backups', '.claude']);

/**
 * The work tree's files that git tracks, so what isn't the repository's (an installed extension) isn't read.
 * @type {import('./file-facts.mjs').Files}
 */
const workTree = {
    list(dir) {
        if (!fs.existsSync(dir)) return [];
        const listed = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 });
        return listed.split('\0').filter(Boolean).map(file => path.join(dir, file)).filter(file => fs.existsSync(file));
    },
    read: file => fs.readFileSync(file, 'utf8'),
    exists: file => fs.existsSync(file),
};

/**
 * The .js and .mjs files under `dir`.
 * @param {string} dir
 * @param {import('./file-facts.mjs').Files} [files]
 * @returns {string[]}
 */
export function jsFiles(dir, files = workTree) {
    return files.list(dir)
        .filter(file => /\.m?js$/.test(file) && !path.dirname(path.relative(dir, file)).split(path.sep).some(part => SKIPPED_DIRECTORIES.has(part)));
}

/**
 * @param {any} node
 * @param {(node: any, parent: any) => void} visit
 * @param {any} [parent]
 */
function walk(node, visit, parent = null) {
    if (!node || typeof node.type !== 'string') return;
    visit(node, parent);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const child of value) walk(child, visit, node);
        } else if (value && typeof value.type === 'string') {
            walk(value, visit, node);
        }
    }
}

/**
 * Whether an identifier bound to an imported module is only named here, not used as a value: the binding itself,
 * the object of a member access, or a property key.
 * @param {any} node
 * @param {any} parent
 */
function isBindingSite(node, parent) {
    if (!parent) return false;
    if (parent.type === 'MemberExpression') return parent.object === node || (parent.property === node && !parent.computed);
    if (parent.type === 'VariableDeclarator') return parent.id === node;
    if (parent.type === 'AssignmentExpression') return parent.left === node;
    if (parent.type === 'Property') return parent.key === node && !parent.computed && parent.value !== node;
    return false;
}

/**
 * @typedef {object} ModuleFacts
 * @property {string[]} names The names it exports
 * @property {[string, string][]} uses Each specifier it imports from with a name it uses of it, `*` for all of them
 * @property {string[]} reexportsAll The specifiers of its `export * from`
 */

/**
 * @param {string} source
 * @returns {ModuleFacts | null} Null for a file that doesn't parse as a module
 */
function moduleFacts(source) {
    let ast;
    try {
        ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    } catch {
        return null;
    }
    /** @type {Set<string>} */
    const names = new Set();
    /** @type {[string, string][]} */
    const uses = [];
    /** @type {string[]} */
    const reexportsAll = [];
    const use = (/** @type {string|null} */ specifier, /** @type {string} */ name) => {
        if (specifier !== null) uses.push([specifier, name]);
    };
    for (const node of /** @type {any[]} */ (ast.body)) {
        if (node.type === 'ExportNamedDeclaration') {
            if (node.declaration?.id) names.add(node.declaration.id.name);
            for (const declarator of node.declaration?.declarations ?? []) {
                if (declarator.id.type === 'Identifier') names.add(declarator.id.name);
            }
            for (const specifier of node.specifiers) {
                names.add(specifier.exported.name ?? specifier.exported.value);
                if (node.source) use(node.source.value, specifier.local.name ?? specifier.local.value);
            }
        } else if (node.type === 'ExportDefaultDeclaration') {
            names.add('default');
        } else if (node.type === 'ExportAllDeclaration') {
            if (node.exported) {
                names.add(node.exported.name ?? node.exported.value);
                use(node.source.value, '*');
            } else {
                reexportsAll.push(node.source.value);
            }
        } else if (node.type === 'ImportDeclaration') {
            for (const specifier of node.specifiers) {
                if (specifier.type === 'ImportNamespaceSpecifier') use(node.source.value, '*');
                else if (specifier.type === 'ImportDefaultSpecifier') use(node.source.value, 'default');
                else use(node.source.value, specifier.imported.name ?? specifier.imported.value);
            }
        }
    }

    const specifierOf = (/** @type {any} */ expression) => {
        const call = expression?.type === 'AwaitExpression' ? expression.argument : expression;
        if (call?.type !== 'ImportExpression') return null;
        if (call.source.type === 'Literal') return { call, specifier: String(call.source.value) };
        if (call.source.type === 'TemplateLiteral') return { call, specifier: call.source.quasis[0].value.cooked };
        return null;
    };
    const placed = new Set();
    /** @type {Map<string, string>} */
    const bindings = new Map();
    walk(ast, (node) => {
        if (node.type === 'VariableDeclarator') {
            const found = specifierOf(node.init);
            if (!found) return;
            if (node.id.type === 'ObjectPattern' && node.id.properties.every((/** @type {any} */ p) => p.type === 'Property' && p.key.type === 'Identifier')) {
                placed.add(found.call);
                for (const property of node.id.properties) use(found.specifier, property.key.name);
            } else if (node.id.type === 'Identifier') {
                placed.add(found.call);
                bindings.set(node.id.name, found.specifier);
            }
        } else if (node.type === 'AssignmentExpression') {
            const found = specifierOf(node.right);
            if (!found) return;
            if (node.left.type === 'ObjectPattern' && node.left.properties.every((/** @type {any} */ p) => p.type === 'Property' && p.key.type === 'Identifier')) {
                placed.add(found.call);
                for (const property of node.left.properties) use(found.specifier, property.key.name);
            } else if (node.left.type === 'Identifier') {
                placed.add(found.call);
                bindings.set(node.left.name, found.specifier);
            }
        } else if (node.type === 'MemberExpression' && !node.computed) {
            const found = specifierOf(node.object);
            if (found) {
                placed.add(found.call);
                use(found.specifier, node.property.name === 'then' ? '*' : node.property.name);
            }
        }
    });
    walk(ast, (node, parent) => {
        if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && bindings.has(node.object.name)) {
            use(bindings.get(node.object.name), node.computed ? '*' : node.property.name);
        } else if (node.type === 'Identifier' && bindings.has(node.name) && !isBindingSite(node, parent)) {
            use(bindings.get(node.name), '*');
        } else if (node.type === 'ImportExpression' && !placed.has(node)) {
            const found = specifierOf(node);
            if (found) use(found.specifier, '*');
        }
    });
    return { names: [...names], uses, reexportsAll };
}

/**
 * @param {string} root Repository root
 * @param {{ cache?: string|null, files?: import('./file-facts.mjs').Files }} [options] `cache`: a directory to keep each
 *   file's facts in between runs
 */
function analyze(root, { cache = null, files: source = workTree } = {}) {
    const publicDirectory = path.join(root, 'public');
    const files = [...jsFiles(publicDirectory, source), ...jsFiles(path.join(root, 'src'), source), ...jsFiles(path.join(root, 'tests'), source)];
    const facts = cache ? fileFacts(cache, `${source.read(fileURLToPath(import.meta.url))}\0${espree.version}`) : uncachedFacts();

    /**
     * @param {string} from
     * @param {string} specifier
     * @returns {string|null}
     */
    const resolve = (from, specifier) => {
        let target;
        if (specifier.startsWith('/')) {
            target = path.join(publicDirectory, specifier);
        } else if (specifier.startsWith('.')) {
            target = path.resolve(path.dirname(from), specifier);
            if (from.startsWith(path.join(root, 'tests', 'frontend')) && !source.exists(target.split('?')[0])) {
                target = path.join(publicDirectory, specifier);
            }
        } else {
            return null;
        }
        target = target.split('?')[0];
        return source.exists(target + '.js') && !source.exists(target) ? target + '.js' : target;
    };

    /** @type {Map<string, Set<string>>} */
    const exported = new Map();
    /** @type {Map<string, Set<string>>} */
    const imported = new Map();
    /** @type {Map<string, Map<string, string>>} */
    const importers = new Map();
    /** @type {Map<string, string[]>} */
    const reexportsAll = new Map();
    /** @type {string} */
    let importer = '';
    const use = (/** @type {string|null} */ file, /** @type {string} */ name) => {
        if (!file) return;
        if (!imported.has(file)) imported.set(file, new Set());
        imported.get(file).add(name);
        if (!importers.has(file)) importers.set(file, new Map());
        if (!importers.get(file).has(name)) importers.get(file).set(name, importer);
    };

    for (const file of files) {
        const module = facts.factsOf(file, source.read(file), moduleFacts);
        if (!module) continue;
        importer = file;
        for (const [specifier, name] of module.uses) use(resolve(file, specifier), name);
        for (const specifier of module.reexportsAll) {
            const target = resolve(file, specifier);
            if (target) reexportsAll.set(file, [...(reexportsAll.get(file) ?? []), target]);
        }
        exported.set(file, new Set(module.names));
    }
    facts.prune();

    importer = '';
    let changed = true;
    while (changed) {
        changed = false;
        for (const [file, targets] of reexportsAll) {
            for (const target of targets) {
                for (const name of imported.get(file) ?? []) {
                    if (!imported.get(target)?.has(name)) {
                        use(target, name);
                        changed = true;
                    }
                }
            }
        }
    }

    return { publicDirectory, exported, imported, importers, reexportsAll };
}

/**
 * Every export of a module under public/ (public/lib excluded) that no module of the app or its tests imports:
 * one that exists only for code outside this repository.
 * @param {string} root Repository root
 * @param {ReturnType<typeof analyze>} [analysis]
 * @returns {string[]} `path<TAB>name` for each such export
 */
export function unusedPublicExports(root, analysis = analyze(root)) {
    const { publicDirectory, exported, imported } = analysis;
    /** @type {string[]} */
    const unused = [];
    for (const [file, names] of exported) {
        if (!file.startsWith(publicDirectory + path.sep)) continue;
        const used = imported.get(file) ?? new Set();
        if (used.has('*')) continue;
        for (const name of names) {
            const key = `${path.relative(root, file).split(path.sep).join('/')}\t${name}`;
            if (!used.has(name) && !KEPT.has(key)) unused.push(key);
        }
    }
    return unused.sort();
}

/**
 * Every name imported from a module under public/ (public/lib excluded) that the module does not export.
 * @param {string} root Repository root
 * @param {ReturnType<typeof analyze>} [analysis]
 * @returns {string[]} `path<TAB>name<TAB>importing path` for each such import
 */
export function danglingPublicImports(root, analysis = analyze(root)) {
    const { publicDirectory, exported, importers, reexportsAll } = analysis;
    /** @type {(file: string, seen?: Set<string>) => Set<string>} */
    const exportsOf = (file, seen = new Set()) => {
        if (seen.has(file)) return new Set();
        seen.add(file);
        const names = new Set(exported.get(file));
        for (const target of reexportsAll.get(file) ?? []) {
            for (const name of exportsOf(target, seen)) if (name !== 'default') names.add(name);
        }
        return names;
    };
    /** @type {string[]} */
    const dangling = [];
    for (const [file, names] of importers) {
        if (!file.startsWith(publicDirectory + path.sep) || !exported.has(file)) continue;
        const available = exportsOf(file);
        for (const [name, from] of names) {
            if (name === '*' || available.has(name) || !from) continue;
            const relative = (/** @type {string} */ p) => path.relative(root, p).split(path.sep).join('/');
            dangling.push(`${relative(file)}\t${name}\t${relative(from)}`);
        }
    }
    return dangling.sort();
}

/**
 * What `public/` exports that nothing imports, and imports of what it doesn't export, as lines to print.
 * @param {string} root Repository root
 * @param {{ cache?: string|null, files?: import('./file-facts.mjs').Files }} [options]
 * @returns {string[]}
 */
export function publicExportProblems(root, options) {
    const analysis = analyze(root, options);
    const lines = [];
    const unused = unusedPublicExports(root, analysis);
    if (unused.length) {
        lines.push('Exports of public/ that nothing in the app or its tests imports:');
        for (const line of unused) lines.push(`  ${line.replace('\t', ': ')}`);
    }
    const dangling = danglingPublicImports(root, analysis);
    if (dangling.length) {
        lines.push('Names imported from public/ that the module does not export:');
        for (const line of dangling) {
            const [file, name, from] = line.split('\t');
            lines.push(`  ${file}: ${name} (imported by ${from})`);
        }
    }
    return lines;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { cache, rest } = cacheArgument(process.argv.slice(2));
    const root = path.resolve(rest[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const lines = publicExportProblems(root, { cache });
    if (lines.length) {
        console.error(lines.join('\n'));
        process.exitCode = 1;
    }
}
