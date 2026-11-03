import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as espree from 'espree';

/** Exports kept although nothing imports them: a module of JSDoc typedefs needs one to be a module. */
const KEPT = new Set(['public/scripts/char-data.js\tdefault']);

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'lib', '.git', 'data', 'dist', 'backups', '.claude']);

/**
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function jsFiles(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name)) jsFiles(path.join(dir, entry.name), out);
        } else if (/\.m?js$/.test(entry.name)) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
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
 * @param {string} root Repository root
 */
function analyze(root) {
    const publicDirectory = path.join(root, 'public');
    const files = [...jsFiles(publicDirectory), ...jsFiles(path.join(root, 'src')), ...jsFiles(path.join(root, 'tests'))];

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
            if (from.startsWith(path.join(root, 'tests', 'frontend')) && !fs.existsSync(target.split('?')[0])) {
                target = path.join(publicDirectory, specifier);
            }
        } else {
            return null;
        }
        target = target.split('?')[0];
        return fs.existsSync(target + '.js') && !fs.existsSync(target) ? target + '.js' : target;
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
        importer = file;
        const source = fs.readFileSync(file, 'utf8');
        let ast;
        try {
            ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
        } catch {
            continue;
        }
        /** @type {Set<string>} */
        const names = new Set();
        for (const node of /** @type {any[]} */ (ast.body)) {
            if (node.type === 'ExportNamedDeclaration') {
                if (node.declaration?.id) names.add(node.declaration.id.name);
                for (const declarator of node.declaration?.declarations ?? []) {
                    if (declarator.id.type === 'Identifier') names.add(declarator.id.name);
                }
                for (const specifier of node.specifiers) {
                    names.add(specifier.exported.name ?? specifier.exported.value);
                    if (node.source) use(resolve(file, node.source.value), specifier.local.name ?? specifier.local.value);
                }
            } else if (node.type === 'ExportDefaultDeclaration') {
                names.add('default');
            } else if (node.type === 'ExportAllDeclaration') {
                const target = resolve(file, node.source.value);
                if (node.exported) {
                    names.add(node.exported.name ?? node.exported.value);
                    use(target, '*');
                } else if (target) {
                    reexportsAll.set(file, [...(reexportsAll.get(file) ?? []), target]);
                }
            } else if (node.type === 'ImportDeclaration') {
                const target = resolve(file, node.source.value);
                for (const specifier of node.specifiers) {
                    if (specifier.type === 'ImportNamespaceSpecifier') use(target, '*');
                    else if (specifier.type === 'ImportDefaultSpecifier') use(target, 'default');
                    else use(target, specifier.imported.name ?? specifier.imported.value);
                }
            }
        }
        exported.set(file, names);

        const specifierOf = (/** @type {any} */ expression) => {
            const call = expression?.type === 'AwaitExpression' ? expression.argument : expression;
            if (call?.type !== 'ImportExpression') return null;
            if (call.source.type === 'Literal') return { call, specifier: String(call.source.value) };
            if (call.source.type === 'TemplateLiteral') return { call, specifier: call.source.quasis[0].value.cooked };
            return null;
        };
        const placed = new Set();
        /** @type {Map<string, string|null>} */
        const bindings = new Map();
        walk(ast, (node) => {
            if (node.type === 'VariableDeclarator') {
                const found = specifierOf(node.init);
                if (!found) return;
                if (node.id.type === 'ObjectPattern' && node.id.properties.every((/** @type {any} */ p) => p.type === 'Property' && p.key.type === 'Identifier')) {
                    placed.add(found.call);
                    for (const property of node.id.properties) use(resolve(file, found.specifier), property.key.name);
                } else if (node.id.type === 'Identifier') {
                    placed.add(found.call);
                    bindings.set(node.id.name, resolve(file, found.specifier));
                }
            } else if (node.type === 'AssignmentExpression') {
                const found = specifierOf(node.right);
                if (!found) return;
                if (node.left.type === 'ObjectPattern' && node.left.properties.every((/** @type {any} */ p) => p.type === 'Property' && p.key.type === 'Identifier')) {
                    placed.add(found.call);
                    for (const property of node.left.properties) use(resolve(file, found.specifier), property.key.name);
                } else if (node.left.type === 'Identifier') {
                    placed.add(found.call);
                    bindings.set(node.left.name, resolve(file, found.specifier));
                }
            } else if (node.type === 'MemberExpression' && !node.computed) {
                const found = specifierOf(node.object);
                if (found) {
                    placed.add(found.call);
                    use(resolve(file, found.specifier), node.property.name === 'then' ? '*' : node.property.name);
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
                if (found) use(resolve(file, found.specifier), '*');
            }
        });
    }

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
 * @returns {string[]} `path<TAB>name` for each such export
 */
export function unusedPublicExports(root) {
    const { publicDirectory, exported, imported } = analyze(root);
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
 * @returns {string[]} `path<TAB>name<TAB>importing path` for each such import
 */
export function danglingPublicImports(root) {
    const { publicDirectory, exported, importers, reexportsAll } = analyze(root);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const unused = unusedPublicExports(root);
    if (unused.length) {
        console.error('Exports of public/ that nothing in the app or its tests imports:');
        for (const line of unused) console.error(`  ${line.replace('\t', ': ')}`);
    }
    const dangling = danglingPublicImports(root);
    if (dangling.length) {
        console.error('Names imported from public/ that the module does not export:');
        for (const line of dangling) {
            const [file, name, from] = line.split('\t');
            console.error(`  ${file}: ${name} (imported by ${from})`);
        }
    }
    if (unused.length || dangling.length) process.exit(1);
}
