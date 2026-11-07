import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/** The modules that mount the server's routers on the app. */
const ENTRY_FILES = ['src/server-main.js', 'src/server-startup.js'];

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

/** Not the app's code: dependencies, vendored libraries, user data, and upstream's extensions (gitignored). */
const SKIPPED = new Set(['node_modules', 'lib', '.git', '.claude', 'data', 'dist', 'backups', 'fixtures', 'extensions']);

/** A `${...}` of a template, as a path segment. */
const HOLE = '\0';

/**
 * @param {string} dir
 * @param {RegExp} pattern
 * @param {string[]} [out]
 * @returns {string[]}
 */
function sourceFiles(dir, pattern, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIPPED.has(entry.name)) sourceFiles(full, pattern, out);
        } else if (pattern.test(entry.name) && !/\.(test|e2e)\.[jt]sx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/** @type {Map<string, ts.SourceFile>} */
const parsed = new Map();

/**
 * @param {string} file
 * @returns {ts.SourceFile}
 */
function parse(file) {
    let source = parsed.get(file);
    if (!source) {
        const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
        source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
        parsed.set(file, source);
    }
    return source;
}

/**
 * @param {ts.Node} node
 * @param {(node: ts.Node) => void} visit
 */
function walk(node, visit) {
    visit(node);
    ts.forEachChild(node, child => walk(child, visit));
}

/**
 * `object.method(first, ...)` with `object` a plain name.
 * @param {ts.Node} node
 * @returns {{ object: string, method: string, first: string | null, args: ts.NodeArray<ts.Expression> } | null}
 */
function memberCall(node) {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.expression)) return null;
    const first = node.arguments[0];
    const text = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : null;
    return { object: node.expression.expression.text, method: node.expression.name.text, first: text, args: node.arguments };
}

/**
 * @param {string} prefix
 * @param {string} rest
 */
function joinPath(prefix, rest) {
    return (prefix.replace(/\/$/, '') + '/' + rest.replace(/^\//, '')).replace(/\/$/, '') || '/';
}

/**
 * @param {string} p
 * @returns {string[]}
 */
function segmentsOf(p) {
    return p === '/' ? [] : p.replace(/\/$/, '').split('/').slice(1);
}

/**
 * The names a module binds to `express.Router()`.
 * @param {string} file
 */
function routersOf(file) {
    const names = new Set();
    walk(parse(file), node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
            && ts.isCallExpression(node.initializer) && node.initializer.expression.getText() === 'express.Router') {
            names.add(node.name.text);
        }
    });
    return names;
}

/**
 * @typedef {object} Route
 * @property {string} method
 * @property {string} path
 * @property {string} file
 * @property {number} line
 */

/**
 * The routes `router` of `file` registers under `prefix`, the routers it mounts included.
 * @param {string} file
 * @param {string} router
 * @param {string} prefix
 * @param {Route[]} out
 */
function routesOfRouter(file, router, prefix, out) {
    const source = parse(file);
    const local = routersOf(file);
    walk(source, node => {
        const call = memberCall(node);
        if (!call || call.object !== router || call.first === null) return;
        if (METHODS.has(call.method)) {
            out.push({ method: call.method.toUpperCase(), path: joinPath(prefix, call.first), file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
        } else if (call.method === 'use' && call.args[1] && ts.isIdentifier(call.args[1]) && local.has(call.args[1].text)) {
            routesOfRouter(file, call.args[1].text, joinPath(prefix, call.first), out);
        }
    });
}

/**
 * Every route the server serves: each one the app registers, and each one of a router a module exports by name and the
 * app mounts. Middleware the app `use`s is not a route.
 * @param {string} root Repository root
 * @returns {Route[]}
 */
export function serverRoutes(root) {
    /** @type {Route[]} */
    const routes = [];
    for (const entry of ENTRY_FILES) {
        const file = path.join(root, entry);
        const source = parse(file);
        /** @type {Map<string, { file: string, name: string }>} */
        const imported = new Map();
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) continue;
            const bindings = statement.importClause?.namedBindings;
            if (!bindings || !ts.isNamedImports(bindings)) continue;
            for (const element of bindings.elements) {
                imported.set(element.name.text, { file: path.resolve(path.dirname(file), statement.moduleSpecifier.text), name: (element.propertyName ?? element.name).text });
            }
        }
        walk(source, node => {
            const call = memberCall(node);
            if (!call || call.object !== 'app' || call.first === null) return;
            if (METHODS.has(call.method)) {
                routes.push({ method: call.method.toUpperCase(), path: call.first, file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
            } else if (call.method === 'use' && call.args[1] && ts.isIdentifier(call.args[1])) {
                const router = imported.get(call.args[1].text);
                if (router && fs.existsSync(router.file) && routersOf(router.file).has(router.name)) routesOfRouter(router.file, router.name, call.first, routes);
            }
        });
    }
    return routes;
}

/**
 * A path the app's code names: from a string, or from a template with each `${...}` a HOLE. A suffix is a template
 * that starts with `${...}/`: the path after a base named elsewhere.
 * @typedef {object} Named
 * @property {string[]} segments
 * @property {boolean} suffix
 * @property {Set<string>} strings The strings of its file
 */

/**
 * The paths the app's code names: the page (public/, packages/) and the server, which hands the page URLs of its own.
 * Tests don't count, and neither does a route's own registration. Of the server's templates, a suffix is a URL of
 * another server.
 * @param {string} root
 * @returns {{ named: Named[], strings: Set<string> }}
 */
function namedPaths(root) {
    /** @type {Named[]} */
    const named = [];
    const strings = new Set();
    const server = path.join(root, 'src') + path.sep;
    const add = (/** @type {string} */ text, /** @type {boolean} */ suffix, /** @type {Set<string>} */ own) => {
        const p = text.split(/[?#]/)[0];
        if (p.startsWith('/') && !p.startsWith('//')) named.push({ segments: segmentsOf(p), suffix, strings: own });
    };
    const code = [
        ...sourceFiles(path.join(root, 'public'), /\.m?js$/),
        ...sourceFiles(path.join(root, 'packages'), /\.tsx?$/),
        ...sourceFiles(path.join(root, 'src'), /\.m?js$/),
    ];
    for (const file of code) {
        const own = new Set();
        walk(parse(file), node => {
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
                own.add(node.text);
                const call = memberCall(node.parent);
                const registers = file.startsWith(server) && call !== null && call.args[0] === node && (METHODS.has(call.method) || call.method === 'use');
                if (registers) return;
                strings.add(node.text);
                add(node.text, false, own);
            } else if (ts.isTemplateExpression(node)) {
                const holes = node.templateSpans.map(span => HOLE + span.literal.text).join('');
                const suffix = node.head.text === '' && node.templateSpans[0].literal.text.startsWith('/');
                if (suffix && file.startsWith(server)) return;
                add(suffix ? holes.slice(1) : node.head.text + holes, suffix, own);
            }
        });
    }
    for (const file of sourceFiles(path.join(root, 'public'), /\.html$/)) {
        const own = new Set();
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/["'`](\/[^"'`\s<>]*)["'`]/g)) {
            own.add(match[1]);
            strings.add(match[1]);
            add(match[1], false, own);
        }
    }
    return { named, strings };
}

/** @param {string} segment */
const isParameter = segment => segment.startsWith(':') || segment === '*';

/**
 * Whether the path `name` names route `route`. A HOLE stands for a parameter, or for fixed segments its file names as a
 * string (`post('default/set')` into `/greetings/${op}`). With `open`, the path may end before the route's last
 * parameters, which the caller appends.
 * @param {string[]} route
 * @param {string[]} name
 * @param {Set<string>} strings
 * @param {boolean} open
 * @returns {boolean}
 */
function names(route, name, strings, open) {
    if (name.length === 0) return route.length === 0 || (open && route.every(isParameter));
    if (route.length === 0) return false;
    const [head, ...rest] = route;
    if (head.startsWith(':') && head.endsWith('?') && names(rest, name, strings, open)) return true;
    const [segment, ...after] = name;
    if (head === '*' || /\(\*\)\??$/.test(head)) {
        return segment !== '' && (names(rest, after, strings, open) || names(route, after, strings, open));
    }
    if (isParameter(head)) return segment !== '' && names(rest, after, strings, open);
    if (segment === HOLE) {
        for (let k = 1; k <= route.length && !route.slice(0, k).some(isParameter); k++) {
            if (strings.has(route.slice(0, k).join('/')) && names(route.slice(k), after, strings, open)) return true;
        }
        return false;
    }
    if (segment.includes(HOLE)) {
        const pattern = segment.split(HOLE).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+');
        return new RegExp(`^${pattern}$`).test(head) && names(rest, after, strings, open);
    }
    return segment === head && names(rest, after, strings, open);
}

/**
 * Every route nothing in the app calls: one served only for code outside this repository.
 * @param {string} root Repository root
 * @returns {string[]} `METHOD path<TAB>file:line` for each such route
 */
export function uncalledServerRoutes(root) {
    const { named, strings } = namedPaths(root);
    const whole = named.filter(n => !n.suffix);
    const suffixes = named.filter(n => n.suffix);
    /** @type {string[]} */
    const uncalled = [];
    for (const route of serverRoutes(root)) {
        const segments = segmentsOf(route.path);
        const called = whole.some(n => names(segments, n.segments, n.strings, true))
            || suffixes.some(n => segments.some((_, k) => k > 0 && strings.has('/' + segments.slice(0, k).join('/'))
                && names(segments.slice(k), n.segments, n.strings, false)));
        if (!called) uncalled.push(`${route.method} ${route.path}\t${path.relative(root, route.file).split(path.sep).join('/')}:${route.line}`);
    }
    return uncalled.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const uncalled = uncalledServerRoutes(root);
    if (uncalled.length) {
        console.error('Server routes nothing in the app calls:');
        for (const line of uncalled) console.error(`  ${line.replace('\t', ' (')})`);
        process.exit(1);
    }
}
