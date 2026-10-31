import type { CreateRule } from 'vite-plus/lint/plugins';

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
