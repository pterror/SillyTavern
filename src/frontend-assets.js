import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import mime from 'mime-types';

import { isPathUnderParent } from './util.js';

export const ASSET_VERSION_PARAM = 'stv';

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);

const HASHED_EXTENSIONS = new Set([
    '.js', '.mjs', '.css', '.html', '.json',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif']);
const MODULE_EXTENSIONS = new Set(['.js', '.mjs']);
const RUNTIME_EXTENSIONS = new Set(['.css', '.html', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif']);

const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const CSS_IMPORT_STRING_PATTERN = /@import\s+(['"])([^'"]+)\1/g;
const HTML_ATTRIBUTE_PATTERN = /(\s(?:src|href)=")([^"]+)(")/g;
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
 * @param {string} reference
 * @import / src / href value
 * @returns {boolean}
 */
function isLocalReference(reference) {
    return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference) && !reference.includes('?');
}

/**
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

export class FrontendAssets {
    /**
     * @param {object} options
     * @param {string} options.publicDirectory
     * @param {() => string|undefined} options.libraryDirectory
     * @param {() => string[]} options.libraryFiles
     * @param {() => string|undefined} options.userCssPath
     * @param {() => Record<string, string>} [options.moduleAliases]
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
     * @param {string} urlPath
     * @returns {string|null}
     */
    resolve(urlPath) {
        if (!urlPath.startsWith('/') || urlPath.includes('\0')) {
            return null;
        }

        const parsed = path.posix.parse(urlPath);
        if (parsed.dir === '/' && this.options.libraryFiles().includes(parsed.base)) {
            const outputDirectory = this.options.libraryDirectory();
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
     * @param {string} urlPath
     * @param {string} filePath
     * @param {Set<string>} [visiting]
     * @returns {Promise<{body: string, hash: string}>}
     */
    async rewritten(urlPath, filePath, visiting = new Set()) {
        const stat = await fs.promises.stat(filePath);
        const text = await this.#textSource(filePath, stat);
        const extension = path.extname(filePath).toLowerCase();
        const patterns = REWRITE_PATTERNS[extension];
        const referenceBase = extension === '.html' ? '/' : urlPath;
        const carriesImages = extension === '.css' && this.#isShipped(filePath);
        visiting.add(filePath);

        /** @type {Map<string, string>} */
        const rewrites = new Map();
        /** @type {[string, string][]} */
        const childHashes = [];
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
                const childFile = this.resolve(decodeURIComponentSafe(childPath));
                const childExtension = childFile ? path.extname(childFile).toLowerCase() : '';
                if (!childFile || !HASHED_EXTENSIONS.has(childExtension) || childExtension === '.html') continue;
                let childHash;
                if (REWRITE_PATTERNS[childExtension]) {
                    if (visiting.has(childFile)) continue;
                    childHash = (await this.rewritten(childPath, childFile, visiting)).hash;
                } else {
                    childHash = await this.fileHash(childFile);
                }
                childHashes.push([reference, childHash]);
                rewrites.set(reference, carriesImages && IMAGE_EXTENSIONS.has(childExtension) && this.#isShipped(childFile)
                    ? await dataUrl(childFile)
                    : withVersion(reference, childHash));
            }
        }
        visiting.delete(filePath);

        const children = JSON.stringify(childHashes);
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
     * @param {string} urlPath
     * @returns {Promise<string|null>}
     */
    async version(urlPath) {
        const filePath = this.resolve(urlPath);
        if (!filePath || !HASHED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
            return null;
        }
        if (REWRITE_PATTERNS[path.extname(filePath).toLowerCase()]) {
            return (await this.rewritten(urlPath, filePath)).hash;
        }
        return await this.fileHash(filePath);
    }

    /**
     * @returns {Promise<Map<string, string>>}
     */
    async manifest() {
        /** @type {Set<string>} */
        const urlPaths = new Set();
        for (const relative of await walk(this.options.publicDirectory)) {
            urlPaths.add(`/${relative}`);
        }
        for (const file of this.options.libraryFiles()) {
            urlPaths.add(`/${file}`);
        }
        urlPaths.add('/css/user.css');

        /** @type {Map<string, string>} */
        const versions = new Map();
        for (const urlPath of Array.from(urlPaths).sort()) {
            if (!HASHED_EXTENSIONS.has(path.posix.extname(urlPath).toLowerCase())) continue;
            const hash = await this.version(urlPath);
            if (hash) {
                versions.set(urlPath, hash);
            }
        }
        return versions;
    }

    /**
     * @param {string} indexPath
     * @returns {Promise<{body: string, buildId: string}>}
     */
    async renderIndex(indexPath) {
        const versions = await this.manifest();
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

        Object.assign(imports, this.options.moduleAliases?.() ?? {});
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
     * @returns {boolean}
     */
    #isShipped(filePath) {
        return isPathUnderParent(this.options.publicDirectory, path.resolve(filePath));
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
            const filePath = assets.resolve(urlPath);
            if (!filePath) {
                return next();
            }

            const rewritten = rewrites ? await assets.rewritten(urlPath, filePath) : null;
            const current = rewritten ? rewritten.hash : await assets.version(urlPath);
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
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function dataUrl(filePath) {
    const type = mime.lookup(filePath) || 'application/octet-stream';
    return `data:${type};base64,${(await fs.promises.readFile(filePath)).toString('base64')}`;
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
 * @returns {string}
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
