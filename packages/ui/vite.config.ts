/// <reference types="vite-plus/test/config" />
import { defineConfig } from 'vite';

// The new page. JSX compiles to Solid's `h` (no Babel; packages/jsx); `st/reactive-in-arrow` keeps it reactive. The server serves
// it at /ui/: through Vite's middleware while developing, from `dist` otherwise.
export default defineConfig({
    base: '/ui/',
    oxc: { jsx: { runtime: 'automatic', importSource: '@st/jsx' } },
    // Solid's browser build, in tests too (Node would pick its server build, which renders strings).
    resolve: { conditions: ['browser'] },
    test: {
        name: 'ui',
        environment: 'happy-dom',
        include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
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
