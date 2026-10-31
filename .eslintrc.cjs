const noWholeFormCharacterSave = {
    selector: 'ImportSpecifier[imported.name=/^(saveCharacterDebounced|createOrEditCharacter)$/]',
    message: 'saveCharacterDebounced/createOrEditCharacter are upstream-compat exports for third-party extensions only - save the field you changed with saveCharacterField()/saveCharacterFieldDebounced() (script.js), or the greeting/chat/avatar path for it.',
};

const noAppChatSave = [
    {
        selector: 'CallExpression[callee.name=/^saveChat(Conditional|Debounced)?$/]',
        message: 'saveChat()/saveChatConditional()/saveChatDebounced() are upstream-compat entry points for third-party extensions only (public/scripts/chat-compat-save.js). Send the node-addressed action for what you changed: chatOpEdit()/chatOpEditMany()/chatOpPatch()/chatOpAppend()/chatOpGraft()/chatOpCut()/chatOpAddAlternative()/chatOpSelect() (chat-store.js), saveMetadata() (metadata-store.js) for chat metadata.',
    },
    {
        selector: 'CallExpression[callee.property.name=/^saveChat(Conditional|Debounced)?$/]',
        message: 'getContext().saveChat() and the other whole-chat saves are upstream-compat entry points for third-party extensions only (public/scripts/chat-compat-save.js). Send the node-addressed action for what you changed: context.editMessage()/editMessages()/appendMessage(), or chatOpEdit()/chatOpPatch()/chatOpAppend()/chatOpCut()/... (chat-store.js), saveMetadata() for chat metadata.',
    },
];

const pageTokenCounters = 'getTokenCountAsync|getPromptTokenCountAsync|getTokenCount|getTokenCountWithAnswer|countTokensOpenAI|countTokensOpenAIAsync|getTextTokens';
const noPageTokenCounting = [
    {
        selector: `CallExpression[callee.name=/^(${pageTokenCounters})$/]`,
        message: 'The page does not count tokens: the server sends counts with what they belong to (messages, alternatives, prompts); text only the page has goes in one batched request (getTokenCountsAsyncBatch). These per-text counters are upstream-compat API for third-party extensions only.',
    },
    {
        selector: `CallExpression[callee.property.name=/^(${pageTokenCounters})$/]`,
        message: 'The page does not count tokens: the server sends counts with what they belong to (messages, alternatives, prompts); text only the page has goes in one batched request (getTokenCountsAsyncBatch). getContext().getTokenCountAsync() and its siblings are upstream-compat API for third-party extensions only.',
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
            files: ['src/**/*.js', './*.js', 'plugins/**/*.js', 'scripts/**/*.js', 'engine/**/*.js'],
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
                    noWholeFormCharacterSave,
                    ...noAppChatSave,
                    ...noPageTokenCounting,
                ],
            },
        },
        {
            files: ['public/**/*.js'],
            excludedFiles: ['public/script.js', 'public/scripts/character-store.js'],
            rules: {
                'no-restricted-syntax': ['error',
                    {
                        selector: "ImportSpecifier[imported.name='this_chid']",
                        message: 'this_chid is a back-compat shim for third-party extensions/upstream parity only - use this_avatar/getCurrentCharacter()/charactersStore instead.',
                    },
                    noWholeFormCharacterSave,
                    ...noAppChatSave,
                    ...noPageTokenCounting,
                ],
            },
        },
        {
            files: ['public/script.js'],
            rules: {
                'no-restricted-syntax': ['error', ...noAppChatSave, ...noPageTokenCounting],
            },
        },
        {
            files: ['public/scripts/extensions/**/*.js'],
            rules: {
                'no-restricted-syntax': ['error', noWholeFormCharacterSave, ...noAppChatSave, ...noPageTokenCounting],
            },
        },
        {
            files: ['src/**/*.js'],
            rules: {
                'no-restricted-syntax': ['error', ...noAppChatSave],
            },
        },
        {
            files: ['public/scripts/tokenizers.js', 'public/scripts/st-context.js'],
            rules: {
                'no-restricted-syntax': ['error',
                    {
                        selector: "ImportSpecifier[imported.name='this_chid']",
                        message: 'this_chid is a back-compat shim for third-party extensions/upstream parity only - use this_avatar/getCurrentCharacter()/charactersStore instead.',
                    },
                    noWholeFormCharacterSave,
                    ...noAppChatSave,
                ],
            },
        },
        {
            files: ['public/scripts/chat-compat-save.js'],
            rules: {
                'no-restricted-syntax': ['error',
                    {
                        selector: "ImportSpecifier[imported.name='this_chid']",
                        message: 'this_chid is a back-compat shim for third-party extensions/upstream parity only - use this_avatar/getCurrentCharacter()/charactersStore instead.',
                    },
                    noWholeFormCharacterSave,
                ],
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
        'public/scripts/extensions/third-party/**',
        'backups/**',
        'data/**',
        'cache/**',
        'src/tokenizers/**',
        'docker/**',
        'engine/target/**',
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
