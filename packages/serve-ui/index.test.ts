import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import { BUNDLE, buildUi, ensureUi, filesOf, packUi, serveUi, sources, uiReleaseKey, uiSourceHash } from './index.ts';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ui-build-'));
const built = path.join(temp, 'built');
const servers: { close(): void }[] = [];

const releases = express();
const published: { bundle: string | null } = { bundle: null };
releases.get('/:release/:file', (request, response) => {
    if (published.bundle !== null && request.params.file === BUNDLE) {
        response.type('json').send(published.bundle);
        return;
    }
    response.sendStatus(404);
});

const releasesUrl: { value: string } = { value: '' };
beforeAll(async () => {
    await buildUi({ outDir: built });
    const server = releases.listen(0);
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    releasesUrl.value = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
    for (const server of servers) server.close();
    fs.rmSync(temp, { recursive: true, force: true });
});

async function start(dev: boolean, outDir = built) {
    const app = express();
    const served = await serveUi({ dev, outDir, releases: releasesUrl.value });
    app.use(served.router);
    app.use((_request, response) => void response.status(404).send('not the page'));
    const server = app.listen(0);
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, entry: served.entry() };
}

test('a build of this source is served: its entry, cached for good, and nothing else', async () => {
    const { origin, entry } = await start(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(built, 'ui/.vite/manifest.json'), 'utf8')) as Record<
        string,
        { file: string }
    >;
    expect(entry).toBe(`/ui/${manifest['src/main.tsx']?.file}`);
    const response = await fetch(`${origin}${entry}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toMatch(/immutable/);
    expect(await response.text()).toMatch(/export\s*\{[^}]*\bstart\b/);
    expect(await (await fetch(`${origin}/ui/entry.js`)).text()).toBe(`export * from '${entry}';\n`);
    expect((await fetch(`${origin}/elsewhere.js`)).status).toBe(404);
    const lib = await (await fetch(`${origin}/lib.js`)).text();
    expect(lib).not.toMatch(/from ['"]lodash['"]/);
    expect(lib).toMatch(/initLibraryShims/);
});

test('a build of other source is replaced by the release for this one', async () => {
    const stale = path.join(temp, 'stale');
    fs.cpSync(built, stale, { recursive: true });
    fs.writeFileSync(path.join(stale, '.source-hash'), 'other source');
    published.bundle = await packUi({ outDir: built });
    try {
        expect(await ensureUi({ outDir: stale, releases: releasesUrl.value })).toBe('downloaded');
        expect(fs.readFileSync(path.join(stale, '.source-hash'), 'utf8')).toBe(await uiSourceHash());
    } finally {
        published.bundle = null;
    }
});

test('with no release for this source, it is built here (the dev dependencies are installed)', async () => {
    const empty = path.join(temp, 'empty');
    expect(await ensureUi({ outDir: empty, releases: releasesUrl.value })).toBe('built');
    expect(await ensureUi({ outDir: empty, releases: releasesUrl.value })).toBe('current');
});

test('a release that would write outside the build is refused', async () => {
    const target = path.join(temp, 'refused');
    published.bundle = JSON.stringify({ files: { '../escaped.txt': Buffer.from('x').toString('base64') } });
    try {
        await expect(ensureUi({ outDir: target, releases: releasesUrl.value })).rejects.toThrow(/outside the build/);
        expect(fs.existsSync(path.join(temp, 'escaped.txt'))).toBe(false);
    } finally {
        published.bundle = null;
    }
});

test("dev: a module is compiled when asked for, JSX by Solid's compiler", async () => {
    const { origin } = await start(true);
    const response = await fetch(`${origin}/ui/test/jsx-fixture.tsx`);
    expect(response.status).toBe(200);
    const code = await response.text();
    expect(code).toMatch(/template\(/);
    expect(code).not.toContain('<b>{');
    expect(await (await fetch(`${origin}/ui/entry.js`)).text()).toBe(`export * from '/ui/src/main.tsx';\n`);
});

test("the libraries are built beside the page, each alone, with upstream's exports", async () => {
    const lib = fs.readFileSync(path.join(built, 'lib/lib.js'), 'utf8');
    expect(lib).toMatch(/export\s*\{[^}]*\binitLibraryShims\b/);
    const editor = fs.readFileSync(path.join(built, 'lib/live-editor-lib.js'), 'utf8');
    expect(editor).toMatch(/export\s*\{[^}]*\bstate\b/);
    expect(fs.readdirSync(path.join(built, 'lib')).sort()).toEqual(['lib.js', 'live-editor-lib.js']);
});

test('the release a source is published as is named by its hash', async () => {
    expect(uiReleaseKey(await uiSourceHash())).toMatch(/^[0-9a-f]{16}$/);
});

test('the source hash covers every file that shapes the build, and nothing installed, built or tested', async () => {
    const files = (await Promise.all((await sources()).map(filesOf)))
        .flat()
        .map((file) => path.relative(path.resolve(import.meta.dirname, '..'), file));
    expect(files).toEqual(
        expect.arrayContaining([
            'tsconfig.base.json',
            'ui/tsconfig.json',
            'page/tsconfig.json',
            'protocol/package.json',
        ]),
    );
    expect(files.filter((file) => /(^|\/)(node_modules|dist|test)\//.test(file) || /\.test\.tsx?$/.test(file))).toEqual(
        [],
    );
});
