const pageTokenCounters = 'getTokenCountAsync|getPromptTokenCountAsync|getTokenCount|getTokenCountWithAnswer|countTokensOpenAI|countTokensOpenAIAsync|getTextTokens';
const noPageDomWatching = [
    {
        selector: "NewExpression[callee.name='MutationObserver']",
        message: 'The page does not watch its own DOM: the code that changes something tells what depends on it (a call or an event). Observers left from before that are marked with an eslint-disable comment.',
    },
];

const noPageTokenCounting = [
    {
        selector: `CallExpression[callee.name=/^(${pageTokenCounters})$/]`,
        message: 'The page does not count tokens: the server sends counts with what they belong to (messages, alternatives, prompts); text only the page has goes in one batched request (getTokenCountsAsyncBatch). Calls left from before that are marked with an eslint-disable comment.',
    },
    {
        selector: `CallExpression[callee.property.name=/^(${pageTokenCounters})$/]`,
        message: 'The page does not count tokens: the server sends counts with what they belong to (messages, alternatives, prompts); text only the page has goes in one batched request (getTokenCountsAsyncBatch). Calls left from before that are marked with an eslint-disable comment.',
    },
];

module.exports = {
    root: true,
    extends: [
        'eslint:recommended',
    ],
    plugins: [
        'jsdoc',
    ],
    env: {
        es6: true,
    },
    parserOptions: {
        ecmaVersion: 'latest',
    },
    overrides: [
        {
            files: ['src/**/*.js', './*.js', 'scripts/**/*.js', 'engine/**/*.js'],
            env: {
                node: true,
                es2024: true,
            },
            parserOptions: {
                sourceType: 'module',
            },
            globals: {
                globalThis: 'readonly',
                Deno: 'readonly',
            },
        },
        {
            files: ['src/**/*.js', 'engine/**/*.js'],
            excludedFiles: ['**/*.test.js'],
            rules: {
                'no-restricted-globals': ['error', {
                    name: 'fetch',
                    message: 'Use fetchOutgoing() (src/outgoing-fetch.js): it says why a request failed instead of "fetch failed".',
                }],
            },
        },
        {
            files: ['*.cjs'],
            parserOptions: {
                sourceType: 'commonjs',
            },
            env: {
                node: true,
            },
        },
        {
            files: ['src/**/*.mjs'],
            parserOptions: {
                sourceType: 'module',
            },
            env: {
                node: true,
            },
        },
        {
            // Browser-side files
            files: ['public/**/*.js'],
            env: {
                browser: true,
                jquery: true,
            },
            parserOptions: {
                sourceType: 'module',
            },
            // These scripts are loaded in HTML; tell ESLint not to complain about them being undefined
            globals: {
                globalThis: 'readonly',
                ePub: 'readonly',
                pdfjsLib: 'readonly',
                toastr: 'readonly',
            },
        },
        {
            files: ['public/**/*.js'],
            rules: {
                'no-restricted-syntax': ['error',
                    {
                        selector: "CallExpression[callee.name='saveSettingsDebounced'][arguments.length=0]",
                        message: "saveSettingsDebounced() requires at least one settings key — pass the key(s) you modified, e.g. saveSettingsDebounced('power_user').",
                    },
                    ...noPageTokenCounting,
                    ...noPageDomWatching,
                ],
            },
        },
        {
            files: ['public/scripts/tokenizers.js'],
            rules: {
                'no-restricted-syntax': 'off',
            },
        },
        {
            // TypeScript via checkJs/JSDoc). Use @typescript-eslint's type-aware rules here to
            files: [
                'public/scripts/node-identity.js',
                'public/scripts/metadata-store.js',
                'public/scripts/node-navigation.js',
                'public/scripts/generation.js',
                'public/scripts/chat-store.js',
                'src/chat-completion-generation-input.js',
                'src/text-completion-generation-input.js',
                'src/endpoints/chats.js',
            ],
            parser: '@typescript-eslint/parser',
            parserOptions: {
                sourceType: 'module',
                // Deliberately NOT `projectService` (typescript-eslint's newer auto-discovery
                project: './tsconfig.chat-strict.json',
                tsconfigRootDir: __dirname,
            },
            plugins: ['@typescript-eslint'],
            rules: {
                '@typescript-eslint/strict-boolean-expressions': ['error', {
                    allowNullableObject: true,
                    allowAny: true,
                }],
                '@typescript-eslint/no-unnecessary-condition': ['error', {
                    allowConstantLoopConditions: true,
                }],
            },
        },
    ],
    ignorePatterns: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.git/**',
        'public/lib/**',
        'backups/**',
        'data/**',
        'cache/**',
        'src/tokenizers/**',
        'docker/**',
        'engine/target/**',
        '**/*.min.js',
    ],
    rules: {
        'jsdoc/no-undefined-types': ['warn', { disableReporting: true, markVariablesAsUsed: true }],
        'no-unused-vars': ['error', { args: 'none' }],
        'no-control-regex': 'off',
        'no-constant-condition': ['error', { checkLoops: false }],
        'require-yield': 'off',
        'quotes': ['error', 'single'],
        'semi': ['error', 'always'],
        'indent': ['error', 4, { SwitchCase: 1, FunctionDeclaration: { parameters: 'first' } }],
        'comma-dangle': ['error', 'always-multiline'],
        'eol-last': ['error', 'always'],
        'no-trailing-spaces': 'error',
        'object-curly-spacing': ['error', 'always'],
        'space-infix-ops': 'error',
        'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
        'no-cond-assign': 'error',
        'no-unneeded-ternary': 'error',
        'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }],
        'dot-notation': ['error', { 'allowPattern': '[A-Z]\\w*$' }],
        // These rules should eventually be enabled.
        'no-async-promise-executor': 'off',
        'no-inner-declarations': 'off',
        // Additional formatting rules based on codebase conventions
        'brace-style': ['error', '1tbs', { allowSingleLine: true }],
        'array-bracket-spacing': ['error', 'never'],
        'computed-property-spacing': ['error', 'never'],
        'block-spacing': ['error', 'always'],
        'keyword-spacing': ['error', { before: true, after: true }],
        'space-before-blocks': ['error', 'always'],
        'space-before-function-paren': ['error', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
        'space-in-parens': ['error', 'never'],
        'comma-spacing': ['error', { before: false, after: true }],
        'key-spacing': ['error', { beforeColon: false, afterColon: true }],
        'func-call-spacing': ['error', 'never'],
        'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 1, maxBOF: 0 }],
        'padded-blocks': ['error', 'never'],
        'no-whitespace-before-property': 'error',
        'space-unary-ops': ['error', { words: true, nonwords: false }],
        'arrow-spacing': ['error', { before: true, after: true }],
        'template-curly-spacing': ['error', 'never'],
        'rest-spread-spacing': ['error', 'never'],
        'generator-star-spacing': ['error', { before: false, after: true }],
        'yield-star-spacing': ['error', { before: false, after: true }],
        'template-tag-spacing': ['error', 'never'],
        'switch-colon-spacing': ['error', { after: true, before: false }],
    },
};
