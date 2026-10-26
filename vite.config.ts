import { defineConfig } from 'vite-plus';
import { FIXTURES, lintConfig } from './packages/lint/config.ts';

// Static checks for the packages (`vp check packages`): the old code keeps its own eslint/tsc setup until it's gone.
export default defineConfig({
    lint: { ...lintConfig, ignorePatterns: [...lintConfig.ignorePatterns, FIXTURES] },
    fmt: { singleQuote: true, tabWidth: 4, printWidth: 120, ignorePatterns: [FIXTURES] },
    test: {
        projects: [
            'packages/ui/vite.config.ts',
            { extends: false, test: { name: 'node', include: ['packages/**/*.test.ts'], exclude: ['packages/{ui,page}/**', 'packages/areas/*/page/**', '**/node_modules/**'] } },
        ],
    },
});
