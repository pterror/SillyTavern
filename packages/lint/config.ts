import path from 'node:path';
import type { OxlintConfig } from 'vite-plus/lint';

// The packages' lint rules, in one place: the repo's vite.config.ts uses them for `vp check`, and the rules' test
// lints the fixtures with them. Globs are relative to the repo root.
// A package reaches only what its package.json declares (`st/declared-imports`), so the old code can't be imported.
// Network and timers are banned on the page outright: a view arrives in the answer to an action or is pushed by the
// server, so nothing on the page fetches, polls or waits. The one module that talks to the server is exempt.

const PAGE_BANNED_GLOBALS = [
    { name: '$', message: 'No jQuery in the new code.' },
    { name: 'jQuery', message: 'No jQuery in the new code.' },
    { name: 'fetch', message: 'Only the client talks to the server: send an action.' },
    { name: 'EventSource', message: 'Only the client talks to the server.' },
    { name: 'XMLHttpRequest', message: 'Only the client talks to the server.' },
    { name: 'WebSocket', message: 'Only the client talks to the server.' },
    { name: 'setTimeout', message: 'Correctness never waits: the server answers or pushes the view.' },
    { name: 'setInterval', message: 'Correctness never waits: the server answers or pushes the view.' },
    { name: 'localStorage', message: 'State lives on the server (device state too).' },
    { name: 'sessionStorage', message: 'State lives on the server.' },
];

const STORAGE_AND_JQUERY = new Set(['$', 'jQuery', 'localStorage', 'sessionStorage']);

export const lintConfig = {
    plugins: ['typescript', 'import'],
    jsPlugins: [path.join(import.meta.dirname, 'index.ts')],
    ignorePatterns: ['**/dist/**'],
    options: { typeAware: true, typeCheck: true },
    rules: {
        'st/declared-imports': 'error',
        'import/no-cycle': 'error',
    },
    overrides: [
        {
            files: ['packages/ui/**', 'packages/lint/fixtures/page/**'],
            rules: {
                'st/reactive-in-arrow': 'error',
                'st/no-html-strings': 'error',
                'st/no-module-state': 'error',
                'no-restricted-globals': ['error', ...PAGE_BANNED_GLOBALS],
                'no-restricted-imports': [
                    'error',
                    {
                        paths: [
                            {
                                name: 'solid-js',
                                importNames: ['Show', 'For', 'Index', 'Switch', 'Match'],
                                message: 'Import it from solid.ts (typed for h).',
                            },
                            {
                                name: 'solid-js/web',
                                importNames: ['render'],
                                message: 'Import it from solid.ts (typed for h).',
                            },
                        ],
                    },
                ],
            },
        },
        {
            // Tests stand in for the server (they replace fetch); they're not the page.
            files: ['packages/ui/test/**'],
            rules: { 'no-restricted-globals': 'off' },
        },
        {
            // The one module that bridges Solid's types to h's.
            files: ['packages/ui/src/solid.ts'],
            rules: { 'no-restricted-imports': 'off' },
        },
        {
            // The client is the one place the page talks to the server (and waits to reconnect).
            files: ['packages/ui/src/client.ts'],
            rules: {
                'no-restricted-globals': [
                    'error',
                    ...PAGE_BANNED_GLOBALS.filter((ban) => STORAGE_AND_JQUERY.has(ban.name)),
                ],
            },
        },
    ],
} satisfies OxlintConfig;

/** The fixtures break the rules on purpose: only the rules' own test lints them. */
export const FIXTURES = 'packages/lint/fixtures/**';
