/** @typedef {import('chevrotain').TokenType} TokenType */


/** Regex for lexer token matching (no anchors). */
const IDENTIFIER_LEXER_PATTERN = /[a-zA-Z][\w-_]*/;

export const MACRO_IDENTIFIER_PATTERN = /^[a-zA-Z][\w-_]*$/;

export const MACRO_VARIABLE_SHORTHAND_PATTERN = /[a-zA-Z](?:[\w\-_]*[\w])?/;

/** @type {ReturnType<typeof buildMacroLexer>} */
let instance;
export { instance as MacroLexer };

/**
 * Builds the lexer with the parsing library the page or the server has (chevrotain): the engine runs on both, and
 * each loads the library its own way. Once, before the engine is used (macro-system.js, src/macros.js).
 * @param {typeof import('chevrotain')} chevrotain
 */
export function initMacroLexer(chevrotain) {
    instance ??= buildMacroLexer(chevrotain);
}

/** @param {typeof import('chevrotain')} chevrotain */
function buildMacroLexer(chevrotain) {
    const { createToken, Lexer } = chevrotain;

    /** @enum {string} */
    const modes = Object.freeze({
        plaintext: 'plaintext_mode',
        macro_def: 'macro_def_mode',
        macro_identifier_end: 'macro_identifier_end_mode',
        macro_args: 'macro_args_mode',
        macro_filter_modifer: 'macro_filter_modifer_mode',
        macro_filter_modifier_end: 'macro_filter_modifier_end_mode',
        var_identifier: 'var_identifier_mode',
        var_after_identifier: 'var_after_identifier_mode',
        var_value: 'var_value_mode',
    });

    /**
     * All lexer tokens used by the macro parser.
     * @readonly
     */
    const Tokens = Object.freeze({
        Plaintext: createToken({ name: 'Plaintext', pattern: /(?:[^{]|\{(?!\{))+/u, line_breaks: true }),
        PlaintextOpenBrace: createToken({ name: 'Plaintext.OpenBrace', pattern: /\{(?=\{\{)/ }),

        Macro: {
            Start: createToken({ name: 'Macro.Start', pattern: /\{\{/ }),
            Flags: createToken({ name: 'Macro.Flag', pattern: /[!?~#/]/ }),
            FilterFlag: createToken({ name: 'Macro.FilterFlag', pattern: />/ }),
            DoubleSlash: createToken({ name: 'Macro.DoubleSlash', pattern: /\/\// }),
            Identifier: createToken({ name: 'Macro.Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
            EndOfIdentifier: createToken({ name: 'Macro.EndOfIdentifier', pattern: /(?:\s+|(?=:{1,2})|(?=[|}]))/, group: Lexer.SKIPPED }),
            BeforeEnd: createToken({ name: 'Macro.BeforeEnd', pattern: /(?=\}\})/, group: Lexer.SKIPPED }),
            End: createToken({ name: 'Macro.End', pattern: /\}\}/ }),
        },

        Args: {
            DoubleColon: createToken({ name: 'Args.DoubleColon', pattern: /::/ }),
            Colon: createToken({ name: 'Args.Colon', pattern: /:/ }),
            Equals: createToken({ name: 'Args.Equals', pattern: /=/ }),
            Quote: createToken({ name: 'Args.Quote', pattern: /"/ }),
        },

        Filter: {
            EscapedPipe: createToken({ name: 'Filter.EscapedPipe', pattern: /\\\|/ }),
            Pipe: createToken({ name: 'Filter.Pipe', pattern: /\|/ }),
            Identifier: createToken({ name: 'Filter.Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
            EndOfIdentifier: createToken({ name: 'Filter.EndOfIdentifier', pattern: /(?:\s+|(?=:{1,2})|(?=[|}]))/, group: Lexer.SKIPPED }),
        },

        Identifier: createToken({ name: 'Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
        WhiteSpace: createToken({ name: 'WhiteSpace', pattern: /\s+/, group: Lexer.SKIPPED }),

        Var: {
            LocalPrefix: createToken({ name: 'Var.LocalPrefix', pattern: /\./ }),
            GlobalPrefix: createToken({ name: 'Var.GlobalPrefix', pattern: /\$/ }),
            Identifier: createToken({ name: 'Var.Identifier', pattern: MACRO_VARIABLE_SHORTHAND_PATTERN }),

            Operators: {
                Increment: createToken({ name: 'Var.Increment', pattern: /\+\+/ }),
                Decrement: createToken({ name: 'Var.Decrement', pattern: /--/ }),
                NullishCoalescingEquals: createToken({ name: 'Var.NullishCoalescingEquals', pattern: /\?\?=/ }),
                NullishCoalescing: createToken({ name: 'Var.NullishCoalescing', pattern: /\?\?/ }),
                LogicalOrEquals: createToken({ name: 'Var.LogicalOrEquals', pattern: /\|\|=/ }),
                LogicalOr: createToken({ name: 'Var.LogicalOr', pattern: /\|\|/ }),
                MinusEquals: createToken({ name: 'Var.MinusEquals', pattern: /-=/ }),
                DoubleEquals: createToken({ name: 'Var.DoubleEquals', pattern: /==/ }),
                NotEquals: createToken({ name: 'Var.NotEquals', pattern: /!=/ }),
                GreaterThanOrEqual: createToken({ name: 'Var.GreaterThanOrEqual', pattern: />=/ }),
                GreaterThan: createToken({ name: 'Var.GreaterThan', pattern: />/ }),
                LessThanOrEqual: createToken({ name: 'Var.LessThanOrEqual', pattern: /<=/ }),
                LessThan: createToken({ name: 'Var.LessThan', pattern: /</ }),
                PlusEquals: createToken({ name: 'Var.PlusEquals', pattern: /\+=/ }),
                Equals: createToken({ name: 'Var.Equals', pattern: /=/ }),
            },
        },

        Unknown: createToken({ name: 'Unknown', pattern: /([^}]|\}(?!\}))/ }),

        Text: createToken({ name: 'Text', pattern: /.+(?=\}\}|\{\{)/, line_breaks: true }),

        ModePopper: createToken({ name: 'ModePopper', pattern: () => [''], line_breaks: false, group: Lexer.SKIPPED }),
    });

    /** @type {Map<string,string>} */
    const enterModesMap = new Map();

    /** @readonly */
    const Def = {
        modes: {
            [modes.plaintext]: [
                using(Tokens.Plaintext),
                using(Tokens.PlaintextOpenBrace),
                enter(Tokens.Macro.Start, modes.macro_def),
            ],
            [modes.macro_def]: [
                exits(Tokens.Macro.End, modes.macro_def),

                enter(Tokens.Macro.DoubleSlash, modes.macro_args),

                enter(Tokens.Var.LocalPrefix, modes.var_identifier),
                enter(Tokens.Var.GlobalPrefix, modes.var_identifier),

                using(Tokens.Macro.Flags),
                using(Tokens.Macro.FilterFlag),

                using(Tokens.WhiteSpace),

                enter(Tokens.Macro.Identifier, modes.macro_identifier_end),

                exits(Tokens.ModePopper, modes.macro_def),
            ],
            [modes.macro_identifier_end]: [
                exits(Tokens.Macro.BeforeEnd, modes.macro_identifier_end),
                enter(Tokens.Macro.EndOfIdentifier, modes.macro_args, { andExits: modes.macro_identifier_end }),
            ],
            [modes.macro_args]: [
                enter(Tokens.Macro.Start, modes.macro_def),


                using(Tokens.Args.DoubleColon),
                using(Tokens.Args.Colon),
                using(Tokens.Args.Equals),
                using(Tokens.Args.Quote),
                using(Tokens.Identifier),

                using(Tokens.WhiteSpace),

                using(Tokens.Unknown),

                exits(Tokens.ModePopper, modes.macro_args),
            ],
            [modes.macro_filter_modifer]: [
                using(Tokens.WhiteSpace),

                enter(Tokens.Filter.Identifier, modes.macro_filter_modifier_end, { andExits: modes.macro_filter_modifer }),
            ],
            [modes.macro_filter_modifier_end]: [
                exits(Tokens.Macro.BeforeEnd, modes.macro_identifier_end),
                exits(Tokens.Filter.EndOfIdentifier, modes.macro_filter_modifer),
            ],

            [modes.var_identifier]: [
                using(Tokens.WhiteSpace),
                enter(Tokens.Var.Identifier, modes.var_after_identifier, { andExits: modes.var_identifier }),
                exits(Tokens.ModePopper, modes.var_identifier),
            ],
            [modes.var_after_identifier]: [
                using(Tokens.WhiteSpace),
                using(Tokens.Var.Operators.Increment),
                using(Tokens.Var.Operators.Decrement),
                enter(Tokens.Var.Operators.NullishCoalescingEquals, modes.var_value, { andExits: modes.var_after_identifier }),
                enter(Tokens.Var.Operators.NullishCoalescing, modes.var_value, { andExits: modes.var_after_identifier }),
                enter(Tokens.Var.Operators.LogicalOrEquals, modes.var_value, { andExits: modes.var_after_identifier }),
                enter(Tokens.Var.Operators.LogicalOr, modes.var_value, { andExits: modes.var_after_identifier }),
                enter(Tokens.Var.Operators.MinusEquals, modes.var_value, { andExits: modes.var_after_identifier }),
                enter(Tokens.Var.Operators.DoubleEquals, modes.var_value, { andExits: modes.var_after_identifier }),
                enter(Tokens.Var.Operators.NotEquals, modes.var_value, { andExits: modes.var_after_identifier }),
                enter(Tokens.Var.Operators.GreaterThanOrEqual, modes.var_value, { andExits: modes.var_after_identifier }),
                enter(Tokens.Var.Operators.GreaterThan, modes.var_value, { andExits: modes.var_after_identifier }),
                enter(Tokens.Var.Operators.LessThanOrEqual, modes.var_value, { andExits: modes.var_after_identifier }),
                enter(Tokens.Var.Operators.LessThan, modes.var_value, { andExits: modes.var_after_identifier }),
                enter(Tokens.Var.Operators.PlusEquals, modes.var_value, { andExits: modes.var_after_identifier }),
                enter(Tokens.Var.Operators.Equals, modes.var_value, { andExits: modes.var_after_identifier }),
                exits(Tokens.Macro.BeforeEnd, modes.var_after_identifier),
                exits(Tokens.ModePopper, modes.var_after_identifier),
            ],
            [modes.var_value]: [
                enter(Tokens.Macro.Start, modes.macro_def),

                using(Tokens.Identifier),
                using(Tokens.WhiteSpace),
                using(Tokens.Unknown),

                exits(Tokens.ModePopper, modes.var_value),
            ],
        },
        defaultMode: modes.plaintext,
    };

    class MacroLexer extends Lexer {
        /** @type {MacroLexer} */ static #instance;
        /** @type {MacroLexer} */ static get instance() { return MacroLexer.#instance ?? (MacroLexer.#instance = new MacroLexer()); }

        /** @readonly */ static tokens = Tokens;
        /** @readonly */ static def = Def;
        /** @readonly */ tokens = Tokens;
        /** @readonly */ def = MacroLexer.def;

        /** @private */
        constructor() {
            super(MacroLexer.def, {
                traceInitPerf: false,
            });
        }

        test(input) {
            const result = this.tokenize(input);
            return {
                errors: result.errors,
                groups: result.groups,
                tokens: result.tokens.map(({ tokenType, ...rest }) => ({ type: tokenType.name, ...rest, tokenType: tokenType })),
            };
        }
    }

    return MacroLexer.instance;

    function enter(token, mode, { andExits = undefined } = {}) {
        if (!token) throw new Error('Token must not be undefined');
        if (enterModesMap.has(token.name) && enterModesMap.get(token.name) !== mode) {
            throw new Error(`Token ${token.name} already is set to enter mode ${enterModesMap.get(token.name)}. The token definition are global, so they cannot be used to lead to different modes.`);
        }

        if (andExits) exits(token, andExits);

        token.PUSH_MODE = mode;
        enterModesMap.set(token.name, mode);
        return token;
    }

    function exits(token, mode) {
        if (!token) throw new Error('Token must not be undefined');
        token.POP_MODE = !!mode;
        return token;
    }

    function using(token) {
        if (!token) throw new Error('Token must not be undefined');
        if (enterModesMap.has(token.name)) {
            throw new Error(`Token ${token.name} is already marked to enter a mode (${enterModesMap.get(token.name)}). The token definition are global, so they cannot be used to lead or stay differently.`);
        }
        return token;
    }
}
