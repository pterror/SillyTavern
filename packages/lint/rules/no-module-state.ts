import type { CreateRule } from 'vite-plus/lint/plugins';

// State the page keeps lives in the client's view cache, owned by one module. A `let` at module level is a second
// copy nobody else can see change.
const rule: CreateRule = {
    meta: {
        type: 'problem',
        messages: { state: "No mutable state at module level: it belongs in the server's view." },
    },
    create(context) {
        return {
            VariableDeclaration(node) {
                if (node.kind === 'const' || node.kind === 'using' || node.kind === 'await using') return;
                const parent = node.parent;
                const atTop =
                    parent.type === 'Program' ||
                    (parent.type === 'ExportNamedDeclaration' && parent.parent.type === 'Program');
                if (atTop) context.report({ node, messageId: 'state' });
            },
        };
    },
};

export default rule;
