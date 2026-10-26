import type { CreateRule } from 'vite-plus/lint/plugins';

// Solid without a compiler (`solid-js/h`): a JSX value is reactive only when it's a function. `{count()}` reads the
// signal once and renders that value forever; `{() => count()}` follows it. So a JSX value may only be something
// that can't hide a read: a function, a literal, or a plain name (a name is either a constant or an accessor, and
// `h` calls accessors itself). Event handlers and refs take functions or values as they are.
const PASSED_AS_IS = /^(on[A-Z:]|ref$)/;

const ALLOWED = new Set([
    'ArrowFunctionExpression',
    'FunctionExpression',
    'Literal',
    'Identifier',
    'JSXEmptyExpression',
]);

const rule: CreateRule = {
    meta: {
        type: 'problem',
        messages: { wrap: 'Wrap this in `() =>`: as written it is read once and never updates.' },
    },
    create(context) {
        return {
            JSXExpressionContainer(node) {
                const parent = node.parent;
                if (
                    parent?.type === 'JSXAttribute' &&
                    parent.name.type === 'JSXIdentifier' &&
                    PASSED_AS_IS.test(parent.name.name)
                )
                    return;
                const expression = node.expression;
                if (ALLOWED.has(expression.type)) return;
                if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0) return;
                context.report({ node: expression, messageId: 'wrap' });
            },
            JSXSpreadAttribute(node) {
                // A spread copies the props' current values; Solid's `h` can't follow them.
                context.report({ node, messageId: 'wrap' });
            },
        };
    },
};

export default rule;
