import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { cacheArgument, fileFacts, uncachedFacts } from './file-facts.mjs';

/** The modules that mount the server's routers on the app. */
const ENTRY_FILES = ['src/server-main.js', 'src/server-startup.js'];

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

/** Not the app's code: dependencies, vendored libraries, user data, and upstream's extensions (gitignored). */
const SKIPPED = new Set(['node_modules', 'lib', '.git', '.claude', 'data', 'dist', 'backups', 'fixtures', 'extensions']);

/** A `${...}` of a template, as a path segment. */
const HOLE = '\0';

/**
 * The work tree's files, without what SKIPPED names.
 * @type {import('./file-facts.mjs').Files}
 */
const workTree = {
    list(dir) {
        if (!fs.existsSync(dir)) return [];
        /** @type {string[]} */
        const out = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIPPED.has(entry.name)) out.push(...workTree.list(full));
            } else {
                out.push(full);
            }
        }
        return out;
    },
    read: file => fs.readFileSync(file, 'utf8'),
    exists: file => fs.existsSync(file),
};

/**
 * @param {import('./file-facts.mjs').Files} files
 * @param {string} dir
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function sourceFiles(files, dir, pattern) {
    return files.list(dir).filter(file => !path.relative(dir, file).split(path.sep).slice(0, -1).some(part => SKIPPED.has(part))
        && pattern.test(path.basename(file)) && !/\.(test|e2e)\.[jt]sx?$/.test(path.basename(file)));
}

/** @type {WeakMap<import('./file-facts.mjs').Files, Map<string, ts.SourceFile>>} */
const parsed = new WeakMap();

/**
 * @param {import('./file-facts.mjs').Files} files
 * @param {string} file
 * @returns {ts.SourceFile}
 */
function parse(files, file) {
    if (!parsed.has(files)) parsed.set(files, new Map());
    let source = parsed.get(files).get(file);
    if (!source) {
        const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
        source = ts.createSourceFile(file, files.read(file), ts.ScriptTarget.Latest, true, kind);
        parsed.get(files).set(file, source);
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
 * @param {import('./file-facts.mjs').Files} files
 * @param {string} file
 */
function routersOf(files, file) {
    const names = new Set();
    walk(parse(files, file), node => {
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
 * @param {import('./file-facts.mjs').Files} files
 * @param {string} file
 * @param {string} router
 * @param {string} prefix
 * @param {Route[]} out
 */
function routesOfRouter(files, file, router, prefix, out) {
    const source = parse(files, file);
    const local = routersOf(files, file);
    walk(source, node => {
        const call = memberCall(node);
        if (!call || call.object !== router || call.first === null) return;
        if (METHODS.has(call.method)) {
            out.push({ method: call.method.toUpperCase(), path: joinPath(prefix, call.first), file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
        } else if (call.method === 'use' && call.args[1] && ts.isIdentifier(call.args[1]) && local.has(call.args[1].text)) {
            routesOfRouter(files, file, call.args[1].text, joinPath(prefix, call.first), out);
        }
    });
}

/**
 * Every route the server serves: each one the app registers, and each one of a router a module exports by name and the
 * app mounts. Middleware the app `use`s is not a route.
 * @param {string} root Repository root
 * @param {import('./file-facts.mjs').Files} [files]
 * @returns {Route[]}
 */
export function serverRoutes(root, files = workTree) {
    /** @type {Route[]} */
    const routes = [];
    for (const entry of ENTRY_FILES) {
        const file = path.join(root, entry);
        const source = parse(files, file);
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
                if (router && files.exists(router.file) && routersOf(files, router.file).has(router.name)) routesOfRouter(files, router.file, router.name, call.first, routes);
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
 * A string of a file, and whether it is the path argument of a route's registration (`router.post('/x', ...)`); or a
 * template, as its head and the literal text after each `${...}`.
 * @typedef {{ text: string, registration: boolean } | { head: string, spans: string[] }} Literal
 */

/**
 * @param {string} file
 * @param {string} text
 * @returns {Literal[]}
 */
function literalsOf(file, text) {
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    /** @type {Literal[]} */
    const literals = [];
    walk(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind), node => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            const call = memberCall(node.parent);
            literals.push({ text: node.text, registration: call !== null && call.args[0] === node && (METHODS.has(call.method) || call.method === 'use') });
        } else if (ts.isTemplateExpression(node)) {
            literals.push({ head: node.head.text, spans: node.templateSpans.map(span => span.literal.text) });
        }
    });
    return literals;
}

/**
 * The paths the app's code names: the page (public/, packages/) and the server, which hands the page URLs of its own.
 * Tests don't count, and neither does a route's own registration. Of the server's templates, a suffix is a URL of
 * another server.
 * @param {string} root
 * @param {string|null} cache Directory to keep each file's literals in between runs
 * @param {import('./file-facts.mjs').Files} files
 * @returns {{ named: Named[], strings: Set<string> }}
 */
function namedPaths(root, cache, files) {
    /** @type {Named[]} */
    const named = [];
    const strings = new Set();
    const server = path.join(root, 'src') + path.sep;
    const add = (/** @type {string} */ text, /** @type {boolean} */ suffix, /** @type {Set<string>} */ own) => {
        const p = text.split(/[?#]/)[0];
        if (p.startsWith('/') && !p.startsWith('//')) named.push({ segments: segmentsOf(p), suffix, strings: own });
    };
    const code = [
        ...sourceFiles(files, path.join(root, 'public'), /\.m?js$/),
        ...sourceFiles(files, path.join(root, 'packages'), /\.tsx?$/),
        ...sourceFiles(files, path.join(root, 'src'), /\.m?js$/),
    ];
    const facts = cache ? fileFacts(cache, `${files.read(fileURLToPath(import.meta.url))}\0${ts.version}`) : uncachedFacts();
    for (const file of code) {
        const own = new Set();
        const fromServer = file.startsWith(server);
        for (const literal of facts.factsOf(file, files.read(file), text => literalsOf(file, text))) {
            if ('text' in literal) {
                own.add(literal.text);
                if (fromServer && literal.registration) continue;
                strings.add(literal.text);
                add(literal.text, false, own);
            } else {
                const holes = literal.spans.map(text => HOLE + text).join('');
                const suffix = literal.head === '' && literal.spans[0].startsWith('/');
                if (suffix && fromServer) continue;
                add(suffix ? holes.slice(1) : literal.head + holes, suffix, own);
            }
        }
    }
    facts.prune();
    for (const file of sourceFiles(files, path.join(root, 'public'), /\.html$/)) {
        const own = new Set();
        for (const match of files.read(file).matchAll(/["'`](\/[^"'`\s<>]*)["'`]/g)) {
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
 * @param {{ cache?: string|null, files?: import('./file-facts.mjs').Files }} [options] `cache`: a directory to keep each
 *   file's literals in between runs
 * @returns {string[]} `METHOD path<TAB>file:line` for each such route
 */
export function uncalledServerRoutes(root, { cache = null, files = workTree } = {}) {
    const { named, strings } = namedPaths(root, cache, files);
    const whole = named.filter(n => !n.suffix);
    const suffixes = named.filter(n => n.suffix);
    /** @type {string[]} */
    const uncalled = [];
    for (const route of serverRoutes(root, files)) {
        const segments = segmentsOf(route.path);
        const called = whole.some(n => names(segments, n.segments, n.strings, true))
            || suffixes.some(n => segments.some((_, k) => k > 0 && strings.has('/' + segments.slice(0, k).join('/'))
                && names(segments.slice(k), n.segments, n.strings, false)));
        if (!called) uncalled.push(`${route.method} ${route.path}\t${path.relative(root, route.file).split(path.sep).join('/')}:${route.line}`);
    }
    return uncalled.sort();
}

/**
 * The routes nothing in the app calls, as lines to print.
 * @param {string} root Repository root
 * @param {{ cache?: string|null, files?: import('./file-facts.mjs').Files }} [options]
 * @returns {string[]}
 */
export function serverRouteProblems(root, options) {
    const uncalled = uncalledServerRoutes(root, options);
    return uncalled.length ? ['Server routes nothing in the app calls:', ...uncalled.map(line => `  ${line.replace('\t', ' (')})`)] : [];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { cache, rest } = cacheArgument(process.argv.slice(2));
    const root = path.resolve(rest[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const lines = serverRouteProblems(root, { cache });
    if (lines.length) {
        console.error(lines.join('\n'));
        process.exitCode = 1;
    }
}
