import type { CreateRule } from 'vite-plus/lint/plugins';

const rule: CreateRule = {
    meta: {
        type: 'problem',
        messages: {
            props: 'Read props where they are used (`props.x`): taken out here, it is read once and never follows.',
        },
    },
    create(context) {
        return {
            VariableDeclarator(node) {
                const init = node.init;
                const fromProps =
                    (init?.type === 'Identifier' && init.name === 'props' && node.id.type !== 'Identifier') ||
                    (init?.type === 'MemberExpression' &&
                        init.object.type === 'Identifier' &&
                        init.object.name === 'props');
                if (fromProps) context.report({ node, messageId: 'props' });
            },
        };
    },
};

export default rule;
