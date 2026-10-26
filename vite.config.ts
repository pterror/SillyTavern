import { defineConfig } from 'vite-plus';
import { FIXTURES, lintConfig } from './packages/lint/config.ts';

// Static checks for the packages (`vp check packages`): the old code keeps its own eslint/tsc setup until it's gone.
export default defineConfig({
    lint: { ...lintConfig, ignorePatterns: [...lintConfig.ignorePatterns, FIXTURES] },
    fmt: { singleQuote: true, tabWidth: 4, printWidth: 120, ignorePatterns: [FIXTURES] },
    test: { include: ['packages/**/*.test.ts'] },
});
