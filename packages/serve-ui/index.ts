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

export async function serveUi({ outDir, dev }: ServeUiOptions): Promise<Router> {
    const router = express.Router();
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
        router.use('/ui', express.static(outDir, { index: false }));
    }
    return router;
}
