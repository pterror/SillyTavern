import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import type { Router } from 'express';

// The new page (packages/ui), as the engine is (engine/fetch.js): CI builds every change of its source and
// publishes the build as the release ui-<key> (.github/workflows/ui.yml); the server takes the build of the source
// it runs with, downloading it when it doesn't have it, and builds it itself only when no release has it (a change
// not pushed yet), which needs the dev dependencies. It never serves a build of other source: that page would be
// wrong in ways nothing else would catch. While developing (ST_UI_DEV=1), Vite compiles each module when the
// browser asks for it instead.

const UI_ROOT = path.resolve(import.meta.dirname, '../ui');
const CONFIG_FILE = path.join(UI_ROOT, 'vite.config.ts');
const DIST = path.join(UI_ROOT, 'dist');
/** What the build is of: written beside it, compared with the source on every start. */
const SOURCE_HASH_FILE = '.source-hash';

/** Everything the built page is made from: its code, the protocol it bundles, and the dependencies' versions. */
const SOURCES = [
    path.join(UI_ROOT, 'src'),
    CONFIG_FILE,
    path.join(UI_ROOT, 'package.json'),
    path.resolve(UI_ROOT, '../protocol/src'),
    path.resolve(UI_ROOT, '../../package-lock.json'),
];

/** The stable URL old page code imports the new page from. */
export const ENTRY = '/ui/entry.js';

/** Where CI publishes the builds (the engine's releases are there too). */
export const RELEASE_BASE = 'https://github.com/pterror/SillyTavern/releases/download';
/** The release's one file: every file of the build, by its path in the build. */
export const BUNDLE = 'ui.json';
type Bundle = { files: Record<string, string> };

async function filesOf(entry: string): Promise<string[]> {
    const stat = await fs.stat(entry);
    if (!stat.isDirectory()) return [entry];
    const names = (await fs.readdir(entry)).sort();
    return (await Promise.all(names.map((name) => filesOf(path.join(entry, name))))).flat();
}

/** A hash of the page's source as it is now (each file by its path relative to the page and its content). */
export async function uiSourceHash(): Promise<string> {
    const hash = crypto.createHash('sha256');
    for (const file of (await Promise.all(SOURCES.map(filesOf))).flat()) {
        hash.update(path.relative(UI_ROOT, file))
            .update('\0')
            .update(await fs.readFile(file))
            .update('\0');
    }
    return hash.digest('hex');
}

/** The release a source's build is published as: the first 16 hex of its hash. */
export const uiReleaseKey = (source: string) => source.slice(0, 16);

const builtHash = (outDir: string) => fs.readFile(path.join(outDir, SOURCE_HASH_FILE), 'utf8').catch(() => null);

/** Builds the page here (Vite and the Solid compiler are dev dependencies: only this loads them). */
export async function buildUi({ outDir = DIST }: { outDir?: string } = {}): Promise<void> {
    const source = await uiSourceHash();
    const { build } = await import('vite');
    await fs.rm(outDir, { recursive: true, force: true });
    await build({ configFile: CONFIG_FILE, root: UI_ROOT, logLevel: 'warn', build: { outDir } });
    await fs.writeFile(path.join(outDir, SOURCE_HASH_FILE), source);
}

/** A build as the release's one file. */
export async function packUi({ outDir = DIST }: { outDir?: string } = {}): Promise<string> {
    const files: Bundle['files'] = {};
    for (const file of await filesOf(outDir))
        files[path.relative(outDir, file).split(path.sep).join('/')] = (await fs.readFile(file)).toString('base64');
    return JSON.stringify({ files } satisfies Bundle);
}

async function unpack(bundle: Bundle, outDir: string) {
    await fs.rm(outDir, { recursive: true, force: true });
    for (const [name, content] of Object.entries(bundle.files)) {
        const target = path.resolve(outDir, name);
        if (path.relative(outDir, target).startsWith('..') || path.isAbsolute(name))
            throw new Error(`A build file outside the build: ${name}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, Buffer.from(content, 'base64'));
    }
}

/**
 * Makes sure the build is of the source now: the one there, else the release's, else one built here. Answers how
 * (`current`, `downloaded`, `built`); throws when there's no way (no release yet, and no dev dependencies).
 */
export async function ensureUi({
    outDir = DIST,
    releases = RELEASE_BASE,
}: { outDir?: string; releases?: string } = {}): Promise<'current' | 'downloaded' | 'built'> {
    const source = await uiSourceHash();
    if ((await builtHash(outDir)) === source) return 'current';
    const url = `${releases}/ui-${uiReleaseKey(source)}/${BUNDLE}`;
    const response = await fetch(url).catch(() => null);
    if (response?.ok) {
        await unpack((await response.json()) as Bundle, outDir);
        // The bundle's own record of its source is the one that counts.
        if ((await builtHash(outDir)) !== source) throw new Error(`${url} is not a build of this source`);
        return 'downloaded';
    }
    try {
        await import('vite');
    } catch {
        throw new Error(
            `The new page has no released build for this source (${url}: ${response ? `HTTP ${response.status}` : 'unreachable'}), ` +
                'and it can only be built here with the dev dependencies (npm install --include=dev).',
        );
    }
    await buildUi({ outDir });
    return 'built';
}

export type ServeUiOptions = {
    /** Compile on request (Vite's middleware) instead of serving the build. */
    dev: boolean;
    /** Where the build is, and where releases are (tests use their own). */
    outDir?: string;
    releases?: string;
};

export type ServedUi = {
    router: Router;
    /**
     * The URL of the page's entry: the built file (its name carries its hash, so it's cached for good), or the source
     * while developing. The old page's import map points ENTRY here, so a load asks nothing more of the server.
     */
    entry: () => string;
};

export async function serveUi({ dev, outDir = DIST, releases = RELEASE_BASE }: ServeUiOptions): Promise<ServedUi> {
    const router = express.Router();
    let entry = '/ui/src/main.tsx';
    // Only for a page without the import map (it's the map's job): re-exports the entry, never cached.
    router.get(ENTRY, (_request, response) => {
        response.type('text/javascript').set('Cache-Control', 'no-cache').send(`export * from '${entry}';\n`);
    });
    if (dev) {
        const { createServer } = await import('vite');
        // Vite's middleware answers only under the config's `base` (/ui/) and passes everything else on.
        const server = await createServer({
            configFile: CONFIG_FILE,
            root: UI_ROOT,
            server: { middlewareMode: true },
            appType: 'custom',
        });
        router.use(server.middlewares);
        return { router, entry: () => entry };
    }
    await ensureUi({ outDir, releases });
    const manifest = JSON.parse(await fs.readFile(path.join(outDir, '.vite/manifest.json'), 'utf8')) as Record<
        string,
        { file: string }
    >;
    const built = manifest['src/main.tsx'];
    if (!built) throw new Error('The new page was built without its entry');
    entry = `/ui/${built.file}`;
    // Every built file's name carries its hash: what's at a URL never changes.
    router.use('/ui', express.static(outDir, { index: false, immutable: true, maxAge: '365d' }));
    return { router, entry: () => entry };
}
