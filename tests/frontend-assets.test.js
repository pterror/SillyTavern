import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { ASSET_VERSION_PARAM, FrontendAssets, frontendAssetMiddleware } from '../src/frontend-assets.js';

let root;
let publicDirectory;
let userExtensions;
let globalExtensions;
let extensionsEnabled = true;

/**
 * @param {string} file
 * @param {string} content
 */
function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    // A distinct mtime per write, so a rewrite within the same millisecond still reads as changed.
    const time = new Date(Date.now() + Math.floor(Math.random() * 1e6));
    fs.utimesSync(file, time, time);
}

function makeAssets() {
    return new FrontendAssets({
        publicDirectory,
        webpackOutputDirectory: () => path.join(root, 'webpack'),
        webpackOutputFiles: () => ['lib.js'],
        globalExtensionsDirectory: () => globalExtensions,
        userCssPath: () => path.join(root, 'data', '_css', 'user.css'),
        extensionsEnabled: () => extensionsEnabled,
    });
}

const directories = () => /** @type {any} */ ({ extensions: userExtensions });

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-frontend-assets-'));
    publicDirectory = path.join(root, 'public');
    userExtensions = path.join(root, 'user-extensions');
    globalExtensions = path.join(root, 'global-extensions');
    write(path.join(publicDirectory, 'index.html'), '<html><head><link href="style.css" rel="stylesheet"></head><body><script type="module" src="script.js"></script><a href="#top">x</a><img src="https://example.com/a.png"></body></html>');
    write(path.join(publicDirectory, 'script.js'), 'import "./scripts/a.js";');
    write(path.join(publicDirectory, 'scripts/a.js'), 'export const a = 1;');
    write(path.join(publicDirectory, 'scripts/templates/t.html'), '<div></div>');
    write(path.join(publicDirectory, 'style.css'), '@import url(css/child.css);\nbody { background: url("img/bg.png"); }\n.x { background: url(data:image/png;base64,AAAA); }\n@font-face { src: url(fonts/f.eot?#iefix); }');
    write(path.join(publicDirectory, 'css/child.css'), '@font-face { src: url(../fonts/f.woff2); }');
    write(path.join(publicDirectory, 'fonts/f.woff2'), 'font-1');
    write(path.join(publicDirectory, 'img/bg.png'), 'png-1');
    write(path.join(publicDirectory, 'lib.js'), 'source of lib');
    write(path.join(root, 'webpack', 'lib.js'), 'built lib');
    write(path.join(publicDirectory, '.git/HEAD'), 'ref');
    write(path.join(userExtensions, 'Ext/index.js'), 'import "../../../../script.js";');
    write(path.join(userExtensions, 'Ext/style.css'), '.e { background: url(../../../../img/bg.png); }');
    write(path.join(globalExtensions, 'Ext/index.js'), 'global copy');
    write(path.join(globalExtensions, 'Global/index.js'), 'global only');
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('FrontendAssets', () => {
    test('resolves in the server order: webpack output, public, then the user\'s and the global extensions', () => {
        const assets = makeAssets();
        expect(assets.resolve('/lib.js', directories())).toBe(path.join(root, 'webpack', 'lib.js'));
        expect(assets.resolve('/scripts/a.js', directories())).toBe(path.join(publicDirectory, 'scripts/a.js'));
        expect(assets.resolve('/scripts/extensions/third-party/Ext/index.js', directories())).toBe(path.join(userExtensions, 'Ext/index.js'));
        expect(assets.resolve('/scripts/extensions/third-party/Global/index.js', directories())).toBe(path.join(globalExtensions, 'Global/index.js'));
        expect(assets.resolve('/scripts/extensions/third-party/Ext/index.js', undefined)).toBeNull();
        expect(assets.resolve('/../outside.js', directories())).toBeNull();
        expect(assets.resolve('/missing.js', directories())).toBeNull();
    });

    test('no third-party files when extensions are disabled', () => {
        extensionsEnabled = false;
        try {
            expect(makeAssets().resolve('/scripts/extensions/third-party/Ext/index.js', directories())).toBeNull();
        } finally {
            extensionsEnabled = true;
        }
    });

    test('a file\'s hash changes when its content does, and only then', async () => {
        const assets = makeAssets();
        const before = await assets.version('/scripts/a.js', directories());
        expect(await assets.version('/scripts/a.js', directories())).toBe(before);
        write(path.join(publicDirectory, 'scripts/a.js'), 'export const a = 2;');
        const after = await assets.version('/scripts/a.js', directories());
        expect(after).not.toBe(before);
    });

    test('css references carry their hashes, nested @import included, and a changed font changes every css above it', async () => {
        const assets = makeAssets();
        const font = await assets.version('/fonts/f.woff2', directories());
        const image = await assets.version('/img/bg.png', directories());
        const child = await assets.rewritten('/css/child.css', path.join(publicDirectory, 'css/child.css'), directories());
        expect(child.body).toContain(`url(../fonts/f.woff2?${ASSET_VERSION_PARAM}=${font})`);

        const parent = await assets.rewritten('/style.css', path.join(publicDirectory, 'style.css'), directories());
        expect(parent.body).toContain(`@import url(css/child.css?${ASSET_VERSION_PARAM}=${child.hash})`);
        expect(parent.body).toContain(`url("img/bg.png?${ASSET_VERSION_PARAM}=${image}")`);
        expect(parent.body).toContain('url(data:image/png;base64,AAAA)');
        expect(parent.body).toContain('url(fonts/f.eot?#iefix)');

        write(path.join(publicDirectory, 'fonts/f.woff2'), 'font-2');
        const parentAfter = await assets.rewritten('/style.css', path.join(publicDirectory, 'style.css'), directories());
        expect(parentAfter.hash).not.toBe(parent.hash);
    });

    test('an extension css resolves its references from its own url', async () => {
        const assets = makeAssets();
        const image = await assets.version('/img/bg.png', directories());
        const css = await assets.rewritten('/scripts/extensions/third-party/Ext/style.css', path.join(userExtensions, 'Ext/style.css'), directories());
        expect(css.body).toContain(`url(../../../../img/bg.png?${ASSET_VERSION_PARAM}=${image})`);
    });

    test('a template\'s src and href to our files carry their hashes; handlebars and links to pages stay as written', async () => {
        write(path.join(publicDirectory, 'scripts/templates/img.html'), '<img src="/img/bg.png"><img src="{{avatar}}"><a href="/scripts/templates/t.html">t</a><link href="../../style.css">');
        const assets = makeAssets();
        const image = await assets.version('/img/bg.png', directories());
        const style = await assets.version('/style.css', directories());
        const template = await assets.rewritten('/scripts/templates/img.html', path.join(publicDirectory, 'scripts/templates/img.html'), directories());
        expect(template.body).toContain(`src="/img/bg.png?${ASSET_VERSION_PARAM}=${image}"`);
        expect(template.body).toContain('src="{{avatar}}"');
        expect(template.body).toContain('href="/scripts/templates/t.html"');
        expect(template.body).toContain(`href="../../style.css?${ASSET_VERSION_PARAM}=${style}"`);
        expect(await assets.version('/scripts/templates/img.html', directories())).toBe(template.hash);
    });

    test('the manifest covers public, webpack outputs and the user\'s extensions, and skips .git', async () => {
        const manifest = await makeAssets().manifest(directories());
        expect(manifest.has('/script.js')).toBe(true);
        expect(manifest.has('/lib.js')).toBe(true);
        expect(manifest.has('/scripts/extensions/third-party/Ext/index.js')).toBe(true);
        expect(manifest.has('/scripts/extensions/third-party/Global/index.js')).toBe(true);
        expect([...manifest.keys()].some(key => key.includes('.git'))).toBe(false);
        expect(manifest.get('/lib.js')).toBe(await makeAssets().version('/lib.js', directories()));
    });

    test('the index carries an import map of every module, versioned references and the runtime map', async () => {
        const assets = makeAssets();
        const { body, buildId } = await assets.renderIndex(path.join(publicDirectory, 'index.html'), directories());
        const manifest = await assets.manifest(directories());
        const importMap = JSON.parse(/<script type="importmap">(.*?)<\/script>/.exec(body)[1]);
        expect(importMap.imports['/scripts/a.js']).toBe(`/scripts/a.js?${ASSET_VERSION_PARAM}=${manifest.get('/scripts/a.js')}`);
        expect(importMap.imports['/scripts/extensions/third-party/Ext/index.js']).toBeDefined();
        expect(body).toContain(`src="script.js?${ASSET_VERSION_PARAM}=${manifest.get('/script.js')}"`);
        expect(body).toContain(`href="style.css?${ASSET_VERSION_PARAM}=${manifest.get('/style.css')}"`);
        expect(body).toContain('href="#top"');
        expect(body).toContain('src="https://example.com/a.png"');
        const runtime = JSON.parse(/<script type="application\/json" id="st-asset-versions">(.*?)<\/script>/.exec(body)[1]);
        expect(runtime['/scripts/templates/t.html']).toBe(manifest.get('/scripts/templates/t.html'));
        expect(body).toContain(`<meta name="st-build" content="${buildId}">`);

        write(path.join(publicDirectory, 'scripts/templates/t.html'), '<div>changed</div>');
        expect((await assets.renderIndex(path.join(publicDirectory, 'index.html'), directories())).buildId).not.toBe(buildId);
    });
});

describe('frontendAssetMiddleware', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let assets;

    beforeAll(async () => {
        assets = makeAssets();
        const app = express();
        app.use((req, _res, next) => {
            req.user = /** @type {any} */ ({ directories: directories() });
            next();
        });
        app.use(frontendAssetMiddleware(assets));
        app.use(express.static(publicDirectory));
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', () => resolve(undefined));
        });
        const address = /** @type {import('node:net').AddressInfo} */ (server.address());
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(() => resolve(undefined)));
    });

    test('the current hash is cached for good', async () => {
        const hash = await assets.version('/scripts/a.js', directories());
        const response = await fetch(`${baseUrl}/scripts/a.js?${ASSET_VERSION_PARAM}=${hash}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(await response.text()).toBe(fs.readFileSync(path.join(publicDirectory, 'scripts/a.js'), 'utf8'));
    });

    test('an old hash gets 409 and the stale marker, never the new file', async () => {
        const response = await fetch(`${baseUrl}/scripts/a.js?${ASSET_VERSION_PARAM}=oldhash`);
        expect(response.status).toBe(409);
        expect(response.headers.get('x-st-stale-asset')).toBe('1');
    });

    test('an unversioned request revalidates as before', async () => {
        const response = await fetch(`${baseUrl}/scripts/a.js`);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('public, max-age=0');
    });

    test('css is served rewritten, with an etag of the rewritten text', async () => {
        const css = await assets.rewritten('/style.css', path.join(publicDirectory, 'style.css'), directories());
        const response = await fetch(`${baseUrl}/style.css`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/css');
        expect(response.headers.get('etag')).toBe(`"${css.hash}"`);
        expect(await response.text()).toBe(css.body);

        // node's fetch adds `cache-control: no-cache` to a conditional request, which rightly defeats the 304;
        // a browser revalidating its cache sends only If-None-Match.
        const againStatus = await new Promise((resolve, reject) => {
            http.get(`${baseUrl}/style.css`, { headers: { 'If-None-Match': `"${css.hash}"` } }, response => {
                response.resume();
                resolve(response.statusCode);
            }).on('error', reject);
        });
        expect(againStatus).toBe(304);

        const versioned = await fetch(`${baseUrl}/style.css?${ASSET_VERSION_PARAM}=${css.hash}`);
        expect(versioned.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    });

    test('paths that aren\'t frontend files pass through untouched', async () => {
        const response = await fetch(`${baseUrl}/nothing-here.js?${ASSET_VERSION_PARAM}=abc`);
        expect(response.status).toBe(404);
    });
});
