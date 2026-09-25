module.exports = {
    root: true,
    extends: [
        'eslint:recommended',
    ],
    env: {
        es6: true,
        node: true,
        browser: true,
        jquery: true,
    },
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
    },
    overrides: [
        {
            files: ['**/*.test.js'],
            plugins: ['jest'],
            extends: ['plugin:jest/recommended'],
            env: {
                'jest/globals': true,
            },
        },
        {
            files: ['**/*.e2e.js', 'frontend/**/*.js'],
            plugins: ['playwright'],
            extends: ['plugin:playwright/recommended'],
        },
    ],
    ignorePatterns: [
        '*.min.js',
        'node_modules/**/*',
    ],
    globals: {
        SillyTavern: 'readonly',
        globalThis: 'readonly',
    },
    rules: {
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

        // These rules should eventually be enabled.
        'no-async-promise-executor': 'off',
        'no-inner-declarations': 'off',
    },
    settings: {
        jest: {
            version: 29,
        },
    },
};
