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
        {
            // These files are driven to zero errors under tsconfig.chat-strict.json (strict
            // TypeScript via checkJs/JSDoc). Use @typescript-eslint's type-aware rules here to
            // catch the "treating a nullable/string/number value as a plain boolean" bug class -
            // e.g. `if (extra.reasoning)` silently treating a deliberate empty-string reasoning
            // block the same as "no block at all" (fixed in f8a30070c). Scoped tightly to this
            // list (not a broad glob) because the type-aware parser is slow and because the rest
            // of the codebase does not yet typecheck cleanly enough for these rules to be useful
            // signal rather than noise.
            files: [
                'public/scripts/node-identity.js',
                'public/scripts/metadata-store.js',
                'public/scripts/node-navigation.js',
                'public/scripts/generation.js',
                'public/scripts/chat-store.js',
                'src/message-tree-db.js',
                'src/character-metadata-db.js',
                'src/chat-completion-generation-input.js',
                'src/text-completion-generation-input.js',
                'src/endpoints/chats.js',
            ],
            parser: '@typescript-eslint/parser',
            parserOptions: {
                sourceType: 'module',
                // Deliberately NOT `projectService` (typescript-eslint's newer auto-discovery
                // mode): projectService finds a project by walking up from each file looking for
                // a file literally named `tsconfig.json`, and this repo has no such file at the
                // root (only tsconfig.chat-strict.json / tsconfig.precommit.json). Its escape
                // hatch for a non-standard-named config (`defaultProject`) is meant for a handful
                // of stray config files outside the real project (capped at 8 matches by default,
                // with a scary "THIS_WILL_SLOW_DOWN_LINTING" override to raise it) - not for
                // pointing a real batch of source files at a specific tsconfig. The classic
                // `project` option is exactly the supported way to say "typecheck these files
                // against this specific tsconfig", so we use that instead.
                project: './tsconfig.chat-strict.json',
                tsconfigRootDir: __dirname,
            },
            plugins: ['@typescript-eslint'],
            rules: {
                // Empty string / 0 / NaN are meaningful, distinct values in this codebase (see
                // the reasoning.js bug above) - so string/number are NOT allowed as implicit
                // booleans (allowString/allowNumber default to false, i.e. omitted here). A
                // nullable object/function truthy-check (`if (x)` where x: Foo | null) is left
                // allowed: existence-checking an object has no "meaningful falsy" ambiguity the
                // way an empty string or zero does, and disallowing it would just force busywork
                // `!= null` churn with no bug-catching value. Nullable boolean/enum are NOT
                // exempted: `true | false | null` collapsing null into false is the same
                // three-state-collapsed-into-two shape as the reasoning.js bug, so it stays flagged.
                '@typescript-eslint/strict-boolean-expressions': ['error', {
                    allowNullableObject: true,
                    // `any` shows up at these files' boundaries with untyped libraries (jQuery,
                    // JSON.parse, third-party callbacks) - flagging it here is a generic
                    // "add more types" task, not an instance of the falsy-collapsing bug class
                    // this rule exists to catch. Left un-widened for every other type (string,
                    // number, nullable-*) because those are exactly where that bug hides.
                    allowAny: true,
                }],
                // Flags conditions that, given the real inferred type, can never be true or
                // never be false - the more direct hit on tonight's bug class, since once
                // `extra.reasoning` is properly typed as `string` (not `string | undefined`),
                // `if (extra.reasoning)` is exactly a "this condition doesn't mean what the code
                // assumes" case this rule targets. allowConstantLoopConditions: true so idiomatic
                // `while (true)` server-loop patterns aren't flagged - that's a deliberate,
                // self-documenting infinite loop, not a type-confusion bug.
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
