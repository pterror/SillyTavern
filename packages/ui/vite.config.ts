/// <reference types="vite-plus/test/config" />
import path from 'node:path';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// The new page, Solid compiled by its own JSX compiler (vite-plugin-solid). The server serves
// it at /ui/: through Vite's middleware while developing, from `dist` otherwise.
export default defineConfig({
    base: '/ui/',
    plugins: [solid()],
    // Solid's browser build, in tests too (Node would pick its server build, which renders strings).
    resolve: { conditions: ['browser'] },
    test: {
        name: 'ui',
        environment: 'happy-dom',
        // The page's tests: the core's, each area's page half's, and the entry's (all under packages/).
        dir: path.resolve(import.meta.dirname, '..'),
        include: ['{ui,page}/{src,test}/**/*.test.{ts,tsx}', 'areas/*/page/**/*.test.{ts,tsx}'],
        // Loaded by Vite (with the conditions above), not by Node, which would pick Solid's server build.
        server: { deps: { inline: [/solid-js/] } },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        manifest: true,
        // The old page imports `start` from the entry: its exports stay (an app build drops them by default).
        rolldownOptions: { input: 'src/main.tsx', preserveEntrySignatures: 'strict' },
    },
});
