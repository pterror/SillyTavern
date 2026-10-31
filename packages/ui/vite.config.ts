/// <reference types="vite-plus/test/config" />
import path from 'node:path';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
    base: '/ui/',
    plugins: [solid()],
    resolve: { conditions: ['browser'] },
    test: {
        name: 'ui',
        environment: 'happy-dom',
        dir: path.resolve(import.meta.dirname, '..'),
        include: ['{ui,page}/{src,test}/**/*.test.{ts,tsx}', 'areas/*/page/**/*.test.{ts,tsx}'],
        server: { deps: { inline: [/solid-js/] } },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        manifest: true,
        rolldownOptions: { input: 'src/main.tsx', preserveEntrySignatures: 'strict' },
    },
});
