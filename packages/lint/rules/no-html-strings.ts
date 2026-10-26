import type { CreateRule, ESTree } from 'vite-plus/lint/plugins';

// Markup is built by components, never parsed from strings: a string can't be type-checked, escapes nothing by
// itself, and replaces whatever was there (including nodes extensions added).
const WRITE_PROPERTIES = new Set(['innerHTML', 'outerHTML']);
const WRITE_METHODS = new Set(['insertAdjacentHTML', 'write', 'writeln', 'createContextualFragment', 'setHTMLUnsafe']);

/** `x.name` → `name`; anything else (computed, private, not a member) → undefined. */
function propertyName(node: ESTree.Node): string | undefined {
    return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
        ? node.property.name
        : undefined;
}

const rule: CreateRule = {
    meta: { type: 'problem', messages: { html: 'No HTML from strings: build the nodes with a component.' } },
    create(context) {
        return {
            AssignmentExpression(node) {
                const name = propertyName(node.left);
                if (name && WRITE_PROPERTIES.has(name)) context.report({ node, messageId: 'html' });
            },
            CallExpression(node) {
                const name = propertyName(node.callee);
                if (name && WRITE_METHODS.has(name)) context.report({ node, messageId: 'html' });
            },
        };
    },
};

export default rule;
