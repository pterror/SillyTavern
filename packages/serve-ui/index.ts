import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import type { Router } from 'express';
import { build, createServer } from 'vite';

// Serves the new page (packages/ui) at /ui/. While developing, Vite transforms each module when the browser asks for
// it, so a change shows on the next load; otherwise the page is built once at startup and served as files. Both use
// packages/ui/vite.config.ts, so the two can't differ in how the page compiles.

const UI_ROOT = path.resolve(import.meta.dirname, '../ui');
const CONFIG_FILE = path.join(UI_ROOT, 'vite.config.ts');

export type ServeUiOptions = {
    /** Where the built page goes; it must be writable (the data root, or `dist` in Docker). */
    outDir: string;
    /** Transform on request instead of building. */
    dev: boolean;
};

/** The stable URL old page code imports the new page from. */
export const ENTRY = '/ui/entry.js';

export type ServedUi = {
    router: Router;
    /**
     * The URL of the page's entry now: the built file (its name carries its hash, so it's cached for good), or the
     * source while developing. The old page's import map points ENTRY here, so a load asks nothing more of the server.
     */
    entry: () => string;
};

export async function serveUi({ outDir, dev }: ServeUiOptions): Promise<ServedUi> {
    const router = express.Router();
    let entry = '/ui/src/main.tsx';
    // Only for a page without the import map (it's the map's job): re-exports the entry, never cached.
    router.get(ENTRY, (_request, response) => {
        response.type('text/javascript').set('Cache-Control', 'no-cache').send(`export * from '${entry}';\n`);
    });
    if (dev) {
        // Vite's middleware answers only under the config's `base` (/ui/) and passes everything else on.
        const server = await createServer({
            configFile: CONFIG_FILE,
            root: UI_ROOT,
            server: { middlewareMode: true },
            appType: 'custom',
        });
        router.use(server.middlewares);
    } else {
        await build({ configFile: CONFIG_FILE, root: UI_ROOT, logLevel: 'warn', build: { outDir } });
        const manifest = JSON.parse(await fs.readFile(path.join(outDir, '.vite/manifest.json'), 'utf8')) as Record<
            string,
            { file: string }
        >;
        const built = manifest['src/main.tsx'];
        if (!built) throw new Error('The new page was built without its entry');
        entry = `/ui/${built.file}`;
        // Every built file's name carries its hash: what's at a URL never changes.
        router.use('/ui', express.static(outDir, { index: false, immutable: true, maxAge: '365d' }));
    }
    return { router, entry: () => entry };
}
