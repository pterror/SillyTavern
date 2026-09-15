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
            // Server-side files (plus this configuration file)
            files: ['src/**/*.js', './*.js', 'plugins/**/*.js'],
            env: {
                node: true,
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
                SillyTavern: 'readonly',
            },
        },
        {
            // openai.js is a back-compat shim for third-party extensions only (see its own header comment) -
            // internal code must import chat-completion-settings.js directly.
            files: ['public/**/*.js'],
            rules: {
                'no-restricted-syntax': ['error',
                    {
                        selector: "CallExpression[callee.name='saveSettingsDebounced'][arguments.length=0]",
                        message: "saveSettingsDebounced() requires at least one settings key — pass the key(s) you modified, e.g. saveSettingsDebounced('power_user'). Third-party extensions are exempt from this rule.",
                    },
                    {
                        selector: 'ImportDeclaration[source.value=/openai\\.js$/]',
                        message: "openai.js was renamed to chat-completion-settings.js (it covers every Chat Completion provider, not just OpenAI) - import from there instead. The old path is kept only as a back-compat shim for third-party extensions.",
                    },
                ],
            },
        },
        {
            // saveChatConditional()/saveChatDebounced() dispatch to _saveTreeChat()'s diff-based
            // persistence, which has no idea what actually happened. A real user action knows what it
            // did - call the matching chatOp*() directly (chat-store.js) instead of asking the whole
            // chat to be diffed. Silence with an inline eslint-disable comment ONLY for a call that's
            // a documented fallback after a direct op already failed/doesn't apply, not as a shortcut.
            files: ['public/script.js'],
            rules: {
                'no-restricted-syntax': ['error',
                    {
                        selector: "CallExpression[callee.name=/^saveChat(Conditional|Debounced)$/]",
                        message: 'Call the specific chatOp*() for this action instead (public/scripts/chat-store.js) - see this rule\'s own comment in .eslintrc.cjs.',
                    },
                ],
            },
        },
        {
            // Same rationale as the block above, for bundled (first-party-maintained) extensions -
            // context.saveChat() is the getContext() equivalent of saveChatConditional(). Real
            // third-party extensions are excluded from lint entirely (see ignorePatterns below), so
            // this only applies to extensions we actually maintain and can migrate to
            // context.editMessage()/editMessages()/appendMessage().
            files: ['public/scripts/extensions/**/*.js'],
            rules: {
                'no-restricted-syntax': ['error',
                    {
                        selector: "CallExpression[callee.property.name='saveChat']",
                        message: 'Use context.editMessage()/editMessages()/appendMessage() for this action instead - see this rule\'s own comment in .eslintrc.cjs.',
                    },
                ],
            },
        },
    ],
    ignorePatterns: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.git/**',
        'public/lib/**',
        'public/scripts/extensions/third-party/**',
        'backups/**',
        'data/**',
        'cache/**',
        'src/tokenizers/**',
        'docker/**',
        'plugins/**',
        '**/*.min.js',
        'public/scripts/extensions/quick-reply/lib/**',
        'public/scripts/extensions/tts/lib/**',
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
