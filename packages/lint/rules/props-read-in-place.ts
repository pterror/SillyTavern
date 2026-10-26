import type { CreateRule } from 'vite-plus/lint/plugins';

// A Solid component runs once; its props are getters that follow what the caller passes. Reading one into a name,
// or taking props apart (`const { x } = props`), reads it once, and the name never follows it. Props are read where
// they're used: in JSX, or in a function Solid calls again (a memo, an effect, a handler).
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
