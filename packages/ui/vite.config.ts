import { defineConfig } from 'vite';

// The new page. JSX compiles to Solid's `h` (no Babel); `st/reactive-in-arrow` keeps it reactive. The server serves
// it at /ui/: through Vite's middleware while developing, from `dist` otherwise.
export default defineConfig({
    base: '/ui/',
    oxc: { jsx: { runtime: 'automatic', importSource: 'solid-js/h' } },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        manifest: true,
        rolldownOptions: { input: 'src/main.tsx' },
    },
});
