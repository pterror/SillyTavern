import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isPathUnderParent } from './util.js';

/** The query parameter that carries a frontend file's content hash. */
export const ASSET_VERSION_PARAM = 'stv';

/** URL prefix under which third-party extensions are served (user's dir first, then the global dir). */
const THIRD_PARTY_PREFIX = '/scripts/extensions/third-party/';

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);

/** File types that get a hash at all: what pages load, plus what css references. */
const HASHED_EXTENSIONS = new Set([
    '.js', '.mjs', '.css', '.html', '.json',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif',
]);
const MODULE_EXTENSIONS = new Set(['.js', '.mjs']);
/** Files code fetches, links or shows at runtime by path; their hashes go to the page as a json map. */
const RUNTIME_EXTENSIONS = new Set(['.css', '.html', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif']);

const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const CSS_IMPORT_STRING_PATTERN = /@import\s+(['"])([^'"]+)\1/g;
const HTML_ATTRIBUTE_PATTERN = /(\s(?:src|href)=")([^"]+)(")/g;
/** Files served with their references rewritten to hashed urls; each pattern's 2nd group is the reference. */
const REWRITE_PATTERNS = {
    '.css': [CSS_URL_PATTERN, CSS_IMPORT_STRING_PATTERN],
    '.html': [HTML_ATTRIBUTE_PATTERN],
};

/**
 * @param {string|Buffer} content
 * @returns {string}
 */
function contentHash(content) {
    return crypto.createHash('sha256').update(content).digest('base64url').slice(0, 16);
}

/**
 * @param {string} reference A url() / @import / src / href value
 * @returns {boolean} Whether it may point at one of our files (relative or root-relative, no query of its own)
 */
function isLocalReference(reference) {
    return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference) && !reference.includes('?');
}

/**
 * Appends the version param to a url path, keeping a #fragment after it.
 * @param {string} reference
 * @param {string} hash
 * @returns {string}
 */
function withVersion(reference, hash) {
    const hashIndex = reference.indexOf('#');
    const base = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? '' : reference.slice(hashIndex);
    return `${base}?${ASSET_VERSION_PARAM}=${hash}${fragment}`;
}

/**
 * Content hashes for every frontend file, kept current by stat: a file is re-read only when its mtime or size
 * changed. A css file's hash covers its text after its url()/@import references are rewritten to their own
 * hashed urls, so a changed font or image changes the url of every css that references it.
 */
export class FrontendAssets {
    /**
     * @param {object} options
     * @param {string} options.publicDirectory
     * @param {() => string|undefined} options.webpackOutputDirectory
     * @param {() => string[]} options.webpackOutputFiles File names served at the root, e.g. `lib.js`
     * @param {() => string|undefined} options.globalExtensionsDirectory
     * @param {() => string|undefined} options.userCssPath
     * @param {() => boolean} options.extensionsEnabled
     */
    constructor(options) {
        this.options = options;
        /** @type {Map<string, {mtimeMs: number, size: number, hash: string}>} */
        this.fileHashes = new Map();
        /** @type {Map<string, {mtimeMs: number, size: number, children: string, body: string, hash: string}>} */
        this.rewrittenBodies = new Map();
        /** @type {Map<string, {mtimeMs: number, size: number, text: string}>} */
        this.textSources = new Map();
        /** @type {{mtimeMs: number, size: number, text: string}|null} */
        this.indexSource = null;
    }

    /**
     * Maps a url path to the file the server would answer it with, in the server's own order: webpack outputs,
     * user.css, public/, then the user's and the global third-party extension directories.
     * @param {string} urlPath Decoded path, starting with `/`
     * @param {import('./users.js').UserDirectoryList|undefined} directories The requesting user's directories
     * @returns {string|null}
     */
    resolve(urlPath, directories) {
        if (!urlPath.startsWith('/') || urlPath.includes('\0')) {
            return null;
        }

        const parsed = path.posix.parse(urlPath);
        if (parsed.dir === '/' && this.options.webpackOutputFiles().includes(parsed.base)) {
            const outputDirectory = this.options.webpackOutputDirectory();
            const filePath = outputDirectory ? path.join(outputDirectory, parsed.base) : null;
            return filePath && isFile(filePath) ? filePath : null;
        }

        if (urlPath === '/css/user.css') {
            const userCss = this.options.userCssPath();
            if (userCss && isFile(userCss)) {
                return userCss;
            }
        }

        const publicDirectory = this.options.publicDirectory;
        const publicPath = path.join(publicDirectory, urlPath);
        if (isPathUnderParent(publicDirectory, path.resolve(publicPath)) && isFile(publicPath)) {
            return publicPath;
        }

        if (urlPath.startsWith(THIRD_PARTY_PREFIX) && directories && this.options.extensionsEnabled()) {
            const rest = urlPath.slice(THIRD_PARTY_PREFIX.length);
            for (const root of [directories.extensions, this.options.globalExtensionsDirectory()]) {
                if (!root) continue;
                const filePath = path.join(root, rest);
                if (isPathUnderParent(root, path.resolve(filePath)) && isFile(filePath)) {
                    return filePath;
                }
            }
        }

        return null;
    }

    /**
     * @param {string} filePath
     * @returns {Promise<string>}
     */
    async fileHash(filePath) {
        const stat = await fs.promises.stat(filePath);
        const known = this.fileHashes.get(filePath);
        if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
            return known.hash;
        }
        const hash = contentHash(await fs.promises.readFile(filePath));
        this.fileHashes.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
        return hash;
    }

    /**
     * A css or html file's text with its references to our files rewritten to hashed urls, and the hash of that
     * text: css `url()` and `@import`, html `src`/`href`. A referenced css counts by its own rewritten text, so a
     * changed font changes the url of every css and template above it.
     * @param {string} urlPath
     * @param {string} filePath
     * @param {import('./users.js').UserDirectoryList|undefined} directories
     * @param {Set<string>} [visiting] Files on the current reference chain, to stop on a cycle
     * @returns {Promise<{body: string, hash: string}>}
     */
    async rewritten(urlPath, filePath, directories, visiting = new Set()) {
        const stat = await fs.promises.stat(filePath);
        const text = await this.#textSource(filePath, stat);
        const extension = path.extname(filePath).toLowerCase();
        const patterns = REWRITE_PATTERNS[extension];
        // An html file here is a template: code puts it into the page, so its references resolve against the page.
        const referenceBase = extension === '.html' ? '/' : urlPath;
        visiting.add(filePath);

        /** @type {Map<string, string>} reference → hashed reference */
        const rewrites = new Map();
        for (const pattern of patterns) {
            for (const match of text.matchAll(pattern)) {
                const reference = match[2].trim();
                if (rewrites.has(reference) || !isLocalReference(reference)) continue;
                let childPath;
                try {
                    childPath = new URL(reference.split('#')[0], `http://localhost${referenceBase}`).pathname;
                } catch {
                    continue;
                }
                const childFile = this.resolve(decodeURIComponentSafe(childPath), directories);
                const childExtension = childFile ? path.extname(childFile).toLowerCase() : '';
                if (!childFile || !HASHED_EXTENSIONS.has(childExtension) || childExtension === '.html') continue;
                let childHash;
                if (REWRITE_PATTERNS[childExtension]) {
                    if (visiting.has(childFile)) continue;
                    childHash = (await this.rewritten(childPath, childFile, directories, visiting)).hash;
                } else {
                    childHash = await this.fileHash(childFile);
                }
                rewrites.set(reference, withVersion(reference, childHash));
            }
        }
        visiting.delete(filePath);

        const children = JSON.stringify(Array.from(rewrites.entries()));
        const cacheKey = `${filePath}\n${urlPath}`;
        const known = this.rewrittenBodies.get(cacheKey);
        if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size && known.children === children) {
            return { body: known.body, hash: known.hash };
        }

        let body = text;
        for (const pattern of patterns) {
            body = body.replace(pattern, (match, _quote, reference) => {
                const hashed = rewrites.get(reference.trim());
                return hashed ? match.replace(reference, hashed) : match;
            });
        }
        const hash = contentHash(body);
        this.rewrittenBodies.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, children, body, hash });
        return { body, hash };
    }

    /**
     * The hash a url path's current content has, or null when the server has no such frontend file.
     * @param {string} urlPath
     * @param {import('./users.js').UserDirectoryList|undefined} directories
     * @returns {Promise<string|null>}
     */
    async version(urlPath, directories) {
        const filePath = this.resolve(urlPath, directories);
        if (!filePath || !HASHED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
            return null;
        }
        if (REWRITE_PATTERNS[path.extname(filePath).toLowerCase()]) {
            return (await this.rewritten(urlPath, filePath, directories)).hash;
        }
        return await this.fileHash(filePath);
    }

    /**
     * Every hashed frontend url path a page of this user can load, with its current hash. Walks the directories
     * on every call (stat only; files are read again only when they changed), so an edit shows on the next load.
     * @param {import('./users.js').UserDirectoryList|undefined} directories
     * @returns {Promise<Map<string, string>>}
     */
    async manifest(directories) {
        /** @type {Set<string>} */
        const urlPaths = new Set();
        for (const relative of await walk(this.options.publicDirectory)) {
            urlPaths.add(`/${relative}`);
        }
        for (const file of this.options.webpackOutputFiles()) {
            urlPaths.add(`/${file}`);
        }
        urlPaths.add('/css/user.css');
        if (directories && this.options.extensionsEnabled()) {
            for (const root of [directories.extensions, this.options.globalExtensionsDirectory()]) {
                if (!root) continue;
                for (const relative of await walk(root)) {
                    urlPaths.add(`${THIRD_PARTY_PREFIX}${relative}`);
                }
            }
        }

        /** @type {Map<string, string>} */
        const versions = new Map();
        for (const urlPath of Array.from(urlPaths).sort()) {
            if (!HASHED_EXTENSIONS.has(path.posix.extname(urlPath).toLowerCase())) continue;
            const hash = await this.version(urlPath, directories);
            if (hash) {
                versions.set(urlPath, hash);
            }
        }
        return versions;
    }

    /**
     * The index page for this user: its own asset references carry their hashes, an import map pins every
     * module to its current hash, and a json map gives the hashes of what code fetches or links at runtime.
     * @param {string} indexPath
     * @param {import('./users.js').UserDirectoryList|undefined} directories
     * @returns {Promise<{body: string, buildId: string}>}
     */
    async renderIndex(indexPath, directories) {
        const versions = await this.manifest(directories);
        const stat = await fs.promises.stat(indexPath);
        if (!this.indexSource || this.indexSource.mtimeMs !== stat.mtimeMs || this.indexSource.size !== stat.size) {
            this.indexSource = { mtimeMs: stat.mtimeMs, size: stat.size, text: await fs.promises.readFile(indexPath, 'utf8') };
        }

        /** @type {Record<string, string>} */
        const imports = {};
        /** @type {Record<string, string>} */
        const runtime = {};
        for (const [urlPath, hash] of versions) {
            const extension = path.posix.extname(urlPath).toLowerCase();
            if (MODULE_EXTENSIONS.has(extension)) {
                imports[urlPath] = withVersion(urlPath, hash);
            } else if (RUNTIME_EXTENSIONS.has(extension)) {
                runtime[urlPath] = hash;
            }
        }

        const page = this.indexSource.text.replace(HTML_ATTRIBUTE_PATTERN, (match, before, reference, after) => {
            if (!isLocalReference(reference)) return match;
            const urlPath = new URL(reference.split('#')[0], 'http://localhost/').pathname;
            const hash = versions.get(decodeURIComponentSafe(urlPath));
            return hash ? `${before}${withVersion(reference, hash)}${after}` : match;
        });

        const importMap = JSON.stringify({ imports });
        const runtimeMap = JSON.stringify(runtime);
        const buildId = contentHash(`${importMap}\n${runtimeMap}\n${page}`);
        const head = [
            `<meta name="st-build" content="${buildId}">`,
            `<script type="importmap">${escapeScriptContent(importMap)}</script>`,
            `<script type="application/json" id="st-asset-versions">${escapeScriptContent(runtimeMap)}</script>`,
        ].join('\n    ');
        const body = page.replace(/<head>/i, match => `${match}\n    ${head}`);
        return { body, buildId };
    }

    /**
     * @param {string} filePath
     * @param {fs.Stats} stat
     * @returns {Promise<string>}
     */
    async #textSource(filePath, stat) {
        const known = this.textSources.get(filePath);
        if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
            return known.text;
        }
        const text = await fs.promises.readFile(filePath, 'utf8');
        this.textSources.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, text });
        return text;
    }
}

/**
 * Serves frontend files with caching keyed by content hash:
 * - a request carrying the file's current hash is cached for good (`immutable`);
 * - one carrying an older hash gets 409 and `X-ST-Stale-Asset: 1`, so a page built against older files fails to
 *   load the file instead of running a mix of old and new code;
 * - css and html are answered with their references rewritten to hashed urls, the ETag being the hash of that text.
 * Anything else falls through to the normal handlers, which revalidate on every load.
 * @param {FrontendAssets} assets
 * @returns {import('express').RequestHandler}
 */
export function frontendAssetMiddleware(assets) {
    return async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return next();
        }
        try {
            const urlPath = decodeURIComponentSafe(req.path);
            const requested = typeof req.query[ASSET_VERSION_PARAM] === 'string' ? req.query[ASSET_VERSION_PARAM] : null;
            const extension = path.posix.extname(urlPath).toLowerCase();
            const rewrites = Boolean(REWRITE_PATTERNS[extension]);
            if (!requested && !rewrites) {
                return next();
            }
            const filePath = assets.resolve(urlPath, req.user?.directories);
            if (!filePath) {
                return next();
            }

            const rewritten = rewrites ? await assets.rewritten(urlPath, filePath, req.user?.directories) : null;
            const current = rewritten ? rewritten.hash : await assets.version(urlPath, req.user?.directories);
            if (!current) {
                return next();
            }
            if (requested && requested !== current) {
                res.setHeader('X-ST-Stale-Asset', '1');
                res.setHeader('Cache-Control', 'no-store');
                return res.status(409).send('This file has changed on the server. Reload the page.');
            }
            res.setHeader('Cache-Control', requested ? 'public, max-age=31536000, immutable' : 'public, max-age=0');
            if (!rewritten) {
                return next();
            }

            res.type(extension);
            res.setHeader('ETag', `"${rewritten.hash}"`);
            if (req.fresh) {
                return res.status(304).end();
            }
            return res.send(rewritten.body);
        } catch (error) {
            return next(error);
        }
    };
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeURIComponentSafe(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * @param {string} json
 * @returns {string} The json made safe inside a script element
 */
function escapeScriptContent(json) {
    return json.replace(/</g, '\\u003c');
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isFile(filePath) {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

/**
 * Relative posix paths of every file under a directory, skipping `.git` and `node_modules`.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function walk(root) {
    /** @type {string[]} */
    const files = [];
    /** @param {string} relative */
    async function visit(relative) {
        let entries;
        try {
            entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const child = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (!SKIP_DIRECTORIES.has(entry.name)) {
                    await visit(child);
                }
            } else if (entry.isFile()) {
                files.push(child);
            }
        }
    }
    await visit('');
    return files;
}
