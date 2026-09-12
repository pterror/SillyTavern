import { chevrotain } from '../../../lib.js';
import { MacroLexer } from './MacroLexer.js';

const { CstParser } = chevrotain;

/** @typedef {import('chevrotain').TokenType} TokenType */
/** @typedef {import('chevrotain').CstNode} CstNode */
/** @typedef {import('chevrotain').ILexingError} ILexingError */
/** @typedef {import('chevrotain').IRecognitionException} IRecognitionException */

/**
 * The singleton instance of the MacroParser.
 *
 * @type {MacroParser}
 */
let instance;
export { instance as MacroParser };

class MacroParser extends CstParser {
    /** @type {MacroParser} */ static #instance;
    /** @type {MacroParser} */ static get instance() { return MacroParser.#instance ?? (MacroParser.#instance = new MacroParser()); }

    /** @private */
    constructor() {
        super(MacroLexer.def, {
            traceInitPerf: false,
            nodeLocationTracking: 'full',
            recoveryEnabled: true,
        });
        const Tokens = MacroLexer.tokens;

        const $ = this;

        $.document = $.RULE('document', () => {
            $.MANY(() => {
                $.OR([
                    { ALT: () => $.CONSUME(Tokens.Plaintext, { LABEL: 'plaintext' }) },
                    { ALT: () => $.CONSUME(Tokens.PlaintextOpenBrace, { LABEL: 'plaintext' }) },
                    { ALT: () => $.SUBRULE($.macro) },
                    { ALT: () => $.CONSUME(Tokens.Macro.Start, { LABEL: 'plaintext' }) },
                ]);
            });
        });

        $.macro = $.RULE('macro', () => {
            $.CONSUME(Tokens.Macro.Start);

            $.MANY(() => {
                $.OR1([
                    { ALT: () => $.CONSUME(Tokens.Macro.Flags, { LABEL: 'flags' }) },
                    { ALT: () => $.CONSUME(Tokens.Macro.FilterFlag, { LABEL: 'flags' }) },
                ]);
            });

            $.OR([
                { ALT: () => $.SUBRULE($.variableExpr) },
                { ALT: () => $.SUBRULE($.macroBody) },
            ]);

            $.CONSUME(Tokens.Macro.End);
        });

        $.macroBody = $.RULE('macroBody', () => {
            $.OR2([
                { ALT: () => $.CONSUME(Tokens.Macro.DoubleSlash, { LABEL: 'Macro.identifier' }) },
                { ALT: () => $.CONSUME(Tokens.Macro.Identifier, { LABEL: 'Macro.identifier' }) },
            ]);
            $.OPTION(() => $.SUBRULE($.arguments));
        });

        $.variableExpr = $.RULE('variableExpr', () => {
            $.OR3([
                { ALT: () => $.CONSUME(Tokens.Var.LocalPrefix, { LABEL: 'Var.scope' }) },
                { ALT: () => $.CONSUME(Tokens.Var.GlobalPrefix, { LABEL: 'Var.scope' }) },
            ]);

            $.CONSUME(Tokens.Var.Identifier, { LABEL: 'Var.identifier' });

            $.OPTION2(() => $.SUBRULE($.variableOperator));
        });

        $.variableOperator = $.RULE('variableOperator', () => {
            $.OR4([
                { ALT: () => $.CONSUME(Tokens.Var.Operators.Increment, { LABEL: 'Var.operator' }) },
                { ALT: () => $.CONSUME(Tokens.Var.Operators.Decrement, { LABEL: 'Var.operator' }) },
                {
                    ALT: () => {
                        $.OR5([
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.NullishCoalescingEquals, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.NullishCoalescing, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.LogicalOrEquals, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.LogicalOr, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.MinusEquals, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.DoubleEquals, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.NotEquals, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.GreaterThanOrEqual, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.GreaterThan, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.LessThanOrEqual, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.LessThan, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.PlusEquals, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.Equals, { LABEL: 'Var.operator' }) },
                        ]);
                        $.SUBRULE($.variableValue, { LABEL: 'Var.value' });
                    },
                },
            ]);
        });

        $.variableValue = $.RULE('variableValue', () => {
            $.MANY2(() => {
                $.OR5([
                    { ALT: () => $.SUBRULE($.macro) },
                    { ALT: () => $.CONSUME(Tokens.Identifier) },
                    { ALT: () => $.CONSUME(Tokens.Unknown) },
                ]);
            });
        });

        $.arguments = $.RULE('arguments', () => {
            $.OR([
                {
                    ALT: () => {
                        $.CONSUME(Tokens.Args.DoubleColon, { LABEL: 'separator' });
                        $.AT_LEAST_ONE_SEP({
                            SEP: Tokens.Args.DoubleColon,
                            DEF: () => $.SUBRULE($.argument, { LABEL: 'argument' }),
                        });
                    },
                },
                {
                    ALT: () => {
                        $.OPTION(() => {
                            $.CONSUME(Tokens.Args.Colon, { LABEL: 'separator' });
                        });
                        $.SUBRULE($.argumentAllowingColons, { LABEL: 'argument' });
                    },
                    // Chevrotain flags this as ambiguous with the DoubleColon branch above, but argument
                    // capture explicitly excludes double colons as a first token, so it can't actually occur.
                    IGNORE_AMBIGUITIES: true,
                },
            ]);
        });

        const validArgumentTokens = [
            { ALT: () => $.SUBRULE($.macro) },
            { ALT: () => $.CONSUME(Tokens.Identifier) },
            { ALT: () => $.CONSUME(Tokens.Unknown) },
            { ALT: () => $.CONSUME(Tokens.Args.Colon) },
            { ALT: () => $.CONSUME(Tokens.Args.Equals) },
            { ALT: () => $.CONSUME(Tokens.Args.Quote) },
        ];

        $.argument = $.RULE('argument', () => {
            $.MANY(() => {
                $.OR([...validArgumentTokens]);
            });
        });
        $.argumentAllowingColons = $.RULE('argumentAllowingColons', () => {
            $.AT_LEAST_ONE(() => {
                $.OR([
                    ...validArgumentTokens,
                    { ALT: () => $.CONSUME(Tokens.Args.DoubleColon) },
                ]);
            });
        });

        this.performSelfAnalysis();
    }

    /**
     * Parses a document into a CST.
     *
     * @param {string} input
     * @returns {{ cst: CstNode|null, errors: ({ message: string }|ILexingError|IRecognitionException)[] , lexingErrors: ILexingError[], parserErrors: IRecognitionException[] }}
     */
    parseDocument(input) {
        if (!input) {
            return { cst: null, errors: [{ message: 'Input is empty' }], lexingErrors: [], parserErrors: [] };
        }

        const lexingResult = MacroLexer.tokenize(input);

        this.input = lexingResult.tokens;
        const cst = this.document();

        const errors = [
            ...lexingResult.errors,
            ...this.errors,
        ];

        return { cst, errors, lexingErrors: lexingResult.errors, parserErrors: this.errors };
    }

    test(input) {
        const lexingResult = MacroLexer.tokenize(input);
        this.input = lexingResult.tokens;
        const cst = this.macro();

        const errors = this.errors.map(x => ({ message: x.message, ...x, stack: x.stack }));

        return { cst, errors: errors };
    }
}

instance = MacroParser.instance;
