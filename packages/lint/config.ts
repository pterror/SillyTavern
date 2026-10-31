import path from 'node:path';
import type { OxlintConfig } from 'vite-plus/lint';

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
        'typescript/strict-boolean-expressions': [
            'error',
            { allowString: false, allowNumber: false, allowNullableObject: true },
        ],
        'typescript/no-unnecessary-condition': 'error',
        'typescript/switch-exhaustiveness-check': 'error',
        'typescript/restrict-template-expressions': 'error',
        'typescript/no-floating-promises': 'error',
        'typescript/no-misused-promises': 'error',
        'typescript/no-confusing-void-expression': ['error', { ignoreVoidReturningFunctions: true }],
        'typescript/consistent-type-imports': 'error',
        eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
    overrides: [
        {
            files: ['packages/ui/**', 'packages/page/**', 'packages/areas/*/page/**', 'packages/lint/fixtures/page/**'],
            rules: {
                'st/props-read-in-place': 'error',
                'st/no-html-strings': 'error',
                'st/no-module-state': 'error',
                'no-restricted-globals': ['error', ...PAGE_BANNED_GLOBALS],
            },
        },
        {
            files: ['packages/ui/test/**', 'packages/page/test/**', 'packages/areas/*/page/**/*.test.{ts,tsx}'],
            rules: { 'no-restricted-globals': 'off' },
        },
        {
            files: ['packages/page/src/client.ts'],
            rules: {
                'no-restricted-globals': [
                    'error',
                    ...PAGE_BANNED_GLOBALS.filter((ban) => STORAGE_AND_JQUERY.has(ban.name)),
                ],
            },
        },
    ],
} satisfies OxlintConfig;

export const FIXTURES = 'packages/lint/fixtures/**';
