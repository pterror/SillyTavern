import { chevrotain } from '../../../lib.js';
const { createToken, Lexer } = chevrotain;

/** @typedef {import('chevrotain').TokenType} TokenType */


/** Regex for lexer token matching (no anchors). */
const IDENTIFIER_LEXER_PATTERN = /[a-zA-Z][\w-_]*/;

/** Same char rule as IDENTIFIER_LEXER_PATTERN, anchored for full-string validation (e.g. macro registration). */
export const MACRO_IDENTIFIER_PATTERN = /^[a-zA-Z][\w-_]*$/;

/** Variable shorthand identifier (`.varName`/`$varName`) - must not end in a hyphen, to avoid conflict with the `--` operator. */
export const MACRO_VARIABLE_SHORTHAND_PATTERN = /[a-zA-Z](?:[\w\-_]*[\w])?/;

/** @enum {string} */
const modes = Object.freeze({
    plaintext: 'plaintext_mode',
    macro_def: 'macro_def_mode',
    macro_identifier_end: 'macro_identifier_end_mode',
    macro_args: 'macro_args_mode',
    macro_filter_modifer: 'macro_filter_modifer_mode',
    macro_filter_modifier_end: 'macro_filter_modifier_end_mode',
    // Variable shorthand modes
    var_identifier: 'var_identifier_mode',
    var_after_identifier: 'var_after_identifier_mode',
    var_value: 'var_value_mode',
});

/**
 * All lexer tokens used by the macro parser.
 * @readonly
 */
const Tokens = Object.freeze({
/** General capture-all plaintext without macros. Consumes any character that is not the first '{' of a macro opener '{{'. */
    Plaintext: createToken({ name: 'Plaintext', pattern: /(?:[^{]|\{(?!\{))+/u, line_breaks: true }),
    /** Single literal '{' that appears immediately before a macro opener '{{' */
    PlaintextOpenBrace: createToken({ name: 'Plaintext.OpenBrace', pattern: /\{(?=\{\{)/ }),

    /** General macro capture */
    Macro: {
        Start: createToken({ name: 'Macro.Start', pattern: /\{\{/ }),
        /** Flags: `!` immediate/`?` delayed/`~` re-evaluate (all TBD), `/` closing block marker, `#` preserve whitespace (also legacy handlebars compat). */
        Flags: createToken({ name: 'Macro.Flag', pattern: /[!?~#/]/ }),
        /** Separate from Flags since a filter flag changes how `|` is parsed inside the macro. */
        FilterFlag: createToken({ name: 'Macro.FilterFlag', pattern: />/ }),
        DoubleSlash: createToken({ name: 'Macro.DoubleSlash', pattern: /\/\// }),
        /** Separate from the general Identifier since only this one switches lexer mode. */
        Identifier: createToken({ name: 'Macro.Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
        /** At the end of an identifier, there has to be whitspace, or must be directly followed by colon/double-colon separator, output modifier or closing braces */
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
        /** At the end of an identifier, there has to be whitspace, or must be directly followed by colon/double-colon separator, output modifier or closing braces */
        EndOfIdentifier: createToken({ name: 'Filter.EndOfIdentifier', pattern: /(?:\s+|(?=:{1,2})|(?=[|}]))/, group: Lexer.SKIPPED }),
    },

    Identifier: createToken({ name: 'Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
    WhiteSpace: createToken({ name: 'WhiteSpace', pattern: /\s+/, group: Lexer.SKIPPED }),

    /** Variable shorthand tokens */
    Var: {
        /** Local variable prefix (`.`) - triggers variable shorthand for local variables */
        LocalPrefix: createToken({ name: 'Var.LocalPrefix', pattern: /\./ }),
        /** Global variable prefix (`$`) - triggers variable shorthand for global variables */
        GlobalPrefix: createToken({ name: 'Var.GlobalPrefix', pattern: /\$/ }),
        /** Allows hyphens inside but not at the end, to avoid conflict with the `--` operator. */
        Identifier: createToken({ name: 'Var.Identifier', pattern: MACRO_VARIABLE_SHORTHAND_PATTERN }),

        Operators: {
            Increment: createToken({ name: 'Var.Increment', pattern: /\+\+/ }),
            Decrement: createToken({ name: 'Var.Decrement', pattern: /--/ }),
            /** Must come before NullishCoalescing (longer pattern first). */
            NullishCoalescingEquals: createToken({ name: 'Var.NullishCoalescingEquals', pattern: /\?\?=/ }),
            NullishCoalescing: createToken({ name: 'Var.NullishCoalescing', pattern: /\?\?/ }),
            /** Must come before LogicalOr (longer pattern first). */
            LogicalOrEquals: createToken({ name: 'Var.LogicalOrEquals', pattern: /\|\|=/ }),
            LogicalOr: createToken({ name: 'Var.LogicalOr', pattern: /\|\|/ }),
            MinusEquals: createToken({ name: 'Var.MinusEquals', pattern: /-=/ }),
            DoubleEquals: createToken({ name: 'Var.DoubleEquals', pattern: /==/ }),
            NotEquals: createToken({ name: 'Var.NotEquals', pattern: /!=/ }),
            /** Must come before GreaterThan (longer pattern first). */
            GreaterThanOrEqual: createToken({ name: 'Var.GreaterThanOrEqual', pattern: />=/ }),
            GreaterThan: createToken({ name: 'Var.GreaterThan', pattern: />/ }),
            /** Must come before LessThan (longer pattern first). */
            LessThanOrEqual: createToken({ name: 'Var.LessThanOrEqual', pattern: /<=/ }),
            LessThan: createToken({ name: 'Var.LessThan', pattern: /</ }),
            /** Must come before Equals, to avoid conflict. */
            PlusEquals: createToken({ name: 'Var.PlusEquals', pattern: /\+=/ }),
            Equals: createToken({ name: 'Var.Equals', pattern: /=/ }),
        },
    },

    /** Captures unknown chars one at a time, so other tokens can still match once they appear. */
    Unknown: createToken({ name: 'Unknown', pattern: /([^}]|\}(?!\}))/ }),

    Text: createToken({ name: 'Text', pattern: /.+(?=\}\}|\{\{)/, line_breaks: true }),

    /** Pops the current mode when nothing else matches - must always be listed last. */
    ModePopper: createToken({ name: 'ModePopper', pattern: () => [''], line_breaks: false, group: Lexer.SKIPPED }),
});

/** @type {Map<string,string>} Saves all token definitions that are marked as entering modes */
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

            // Double-slash is a comment macro, so it must be checked before flags.
            enter(Tokens.Macro.DoubleSlash, modes.macro_args),

            // Must come before flags, to take precedence for variable shorthand.
            enter(Tokens.Var.LocalPrefix, modes.var_identifier),
            enter(Tokens.Var.GlobalPrefix, modes.var_identifier),

            using(Tokens.Macro.Flags),
            using(Tokens.Macro.FilterFlag),

            using(Tokens.WhiteSpace),

            enter(Tokens.Macro.Identifier, modes.macro_identifier_end),

            exits(Tokens.ModePopper, modes.macro_def),
        ],
        [modes.macro_identifier_end]: [
            // Valid options after a macro identifier: whitespace, colon/double-colon (captured), macro end braces, or output modifier pipe.
            exits(Tokens.Macro.BeforeEnd, modes.macro_identifier_end),
            enter(Tokens.Macro.EndOfIdentifier, modes.macro_args, { andExits: modes.macro_identifier_end }),
        ],
        [modes.macro_args]: [
            enter(Tokens.Macro.Start, modes.macro_def),

            // Disabled: breaks macros using | as a literal char in arg values (e.g. {{setvar::foo::|bar}}). TODO: re-enable once the filter flag (>) gates pipe parsing, see #5618
            // using(Tokens.Filter.EscapedPipe),
            // enter(Tokens.Filter.Pipe, modes.macro_filter_modifer),

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
            // Valid options after a filter itenfier: whitespace, colon/double-colon (captured), macro end braces, or output modifier pipe.
            exits(Tokens.Macro.BeforeEnd, modes.macro_identifier_end),
            exits(Tokens.Filter.EndOfIdentifier, modes.macro_filter_modifer),
        ],

        // After seeing `.` or `$`, expect a variable identifier
        [modes.var_identifier]: [
            using(Tokens.WhiteSpace),
            enter(Tokens.Var.Identifier, modes.var_after_identifier, { andExits: modes.var_identifier }),
            exits(Tokens.ModePopper, modes.var_identifier),
        ],
        // After the variable identifier, look for operators or end
        [modes.var_after_identifier]: [
            using(Tokens.WhiteSpace),
            // Order matters here: longer patterns must come first.
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
        // After `=` or `+=`, capture the value (can contain nested macros)
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

/** @type {MacroLexer} */
let instance;
export { instance as MacroLexer };

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

instance = MacroLexer.instance;

/** Marks a token to push the given lexer mode when matched. */
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

/** Marks a token to pop the current lexer mode when matched. */
function exits(token, mode) {
    if (!token) throw new Error('Token must not be undefined');
    token.POP_MODE = !!mode; // always true; `mode` is only taken for clarity at call sites
    return token;
}

/** Marks a token to be consumed without entering or exiting a mode. */
function using(token) {
    if (!token) throw new Error('Token must not be undefined');
    if (enterModesMap.has(token.name)) {
        throw new Error(`Token ${token.name} is already marked to enter a mode (${enterModesMap.get(token.name)}). The token definition are global, so they cannot be used to lead or stay differently.`);
    }
    return token;
}
