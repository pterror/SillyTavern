import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import type { Router } from 'express';

const UI_ROOT = path.resolve(import.meta.dirname, '../ui');
const CONFIG_FILE = path.join(UI_ROOT, 'vite.config.ts');
const PUBLIC = path.resolve(UI_ROOT, '../../public');
const DIST = path.join(UI_ROOT, 'dist');
const LIBRARIES = { lib: path.join(PUBLIC, 'lib.js'), 'live-editor-lib': path.join(PUBLIC, 'live-editor-lib.js') };
const PAGE_DIR = 'ui';
const LIBRARY_DIR = 'lib';
const SOURCE_HASH_FILE = '.source-hash';

const AREAS = path.resolve(UI_ROOT, '../areas');

export async function sources(): Promise<string[]> {
    const areas = (await fs.readdir(AREAS)).sort().map((name) => path.join(AREAS, name));
    return [
        ...Object.values(LIBRARIES),
        UI_ROOT,
        path.resolve(UI_ROOT, '../page'),
        path.resolve(UI_ROOT, '../protocol'),
        path.resolve(UI_ROOT, '../tsconfig.base.json'),
        ...areas,
        path.resolve(UI_ROOT, '../../package-lock.json'),
    ];
}

const notSource = (name: string) =>
    name === 'node_modules' || name === 'dist' || name === 'test' || /\.test\.tsx?$/.test(name);

export const ENTRY = '/ui/entry.js';

export const RELEASE_BASE = 'https://github.com/pterror/SillyTavern/releases/download';
export const BUNDLE = 'ui.json';
type Bundle = { files: Record<string, string> };

export async function filesOf(entry: string): Promise<string[]> {
    const stat = await fs.stat(entry);
    if (!stat.isDirectory()) return [entry];
    const names = (await fs.readdir(entry)).filter((name) => !notSource(name)).sort();
    return (await Promise.all(names.map((name) => filesOf(path.join(entry, name))))).flat();
}

export async function uiSourceHash(): Promise<string> {
    const hash = crypto.createHash('sha256');
    for (const file of (await Promise.all((await sources()).map(filesOf))).flat()) {
        hash.update(path.relative(UI_ROOT, file))
            .update('\0')
            .update(await fs.readFile(file))
            .update('\0');
    }
    return hash.digest('hex');
}

export const uiReleaseKey = (source: string) => source.slice(0, 16);

const builtHash = (outDir: string) => fs.readFile(path.join(outDir, SOURCE_HASH_FILE), 'utf8').catch(() => null);

export async function buildUi({ outDir = DIST }: { outDir?: string } = {}): Promise<void> {
    const source = await uiSourceHash();
    const { build } = await import('vite');
    await fs.rm(outDir, { recursive: true, force: true });
    await build({
        configFile: CONFIG_FILE,
        root: UI_ROOT,
        logLevel: 'warn',
        build: { outDir: path.join(outDir, PAGE_DIR) },
    });
    for (const [name, entry] of Object.entries(LIBRARIES)) {
        await build({
            configFile: false,
            root: PUBLIC,
            logLevel: 'warn',
            build: {
                outDir: path.join(outDir, LIBRARY_DIR),
                emptyOutDir: false,
                minify: true,
                lib: { entry, formats: ['es'], fileName: () => `${name}.js` },
            },
        });
    }
    await fs.writeFile(path.join(outDir, SOURCE_HASH_FILE), source);
}

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

export async function ensureUi({
    outDir = DIST,
    releases = RELEASE_BASE,
}: { outDir?: string; releases?: string } = {}): Promise<'current' | 'downloaded' | 'built'> {
    const source = await uiSourceHash();
    if ((await builtHash(outDir)) === source) return 'current';
    const url = `${releases}/ui-${uiReleaseKey(source)}/${BUNDLE}`;
    const response = await fetch(url).catch(() => null);
    if (response?.ok === true) {
        await unpack((await response.json()) as Bundle, outDir);
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
    dev: boolean;
    outDir?: string;
    releases?: string;
};

export type ServedUi = {
    router: Router;
    libraries: { directory: string; files: string[] };
    entry: () => string;
};

export async function serveUi({ dev, outDir = DIST, releases = RELEASE_BASE }: ServeUiOptions): Promise<ServedUi> {
    const router = express.Router();
    let entry = '/ui/src/main.tsx';
    router.get(ENTRY, (_request, response) => {
        response.type('text/javascript').set('Cache-Control', 'no-cache').send(`export * from '${entry}';\n`);
    });
    await ensureUi({ outDir, releases });
    const libraries = {
        directory: path.join(outDir, LIBRARY_DIR),
        files: Object.keys(LIBRARIES).map((name) => `${name}.js`),
    };
    for (const file of libraries.files) {
        router.get(`/${file}`, (_request, response) => {
            response.type('text/javascript').sendFile(path.join(libraries.directory, file), { cacheControl: false });
        });
    }
    if (dev) {
        const { createServer } = await import('vite');
        const server = await createServer({
            configFile: CONFIG_FILE,
            root: UI_ROOT,
            server: { middlewareMode: true },
            appType: 'custom',
        });
        router.use(server.middlewares);
        return { router, libraries, entry: () => entry };
    }
    const manifest = JSON.parse(
        await fs.readFile(path.join(outDir, PAGE_DIR, '.vite/manifest.json'), 'utf8'),
    ) as Record<string, { file: string }>;
    const built = manifest['src/main.tsx'];
    if (!built) throw new Error('The new page was built without its entry');
    entry = `/ui/${built.file}`;
    router.use('/ui', express.static(path.join(outDir, PAGE_DIR), { index: false, immutable: true, maxAge: '365d' }));
    return { router, libraries, entry: () => entry };
}
