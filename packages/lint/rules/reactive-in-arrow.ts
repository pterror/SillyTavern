import type { CreateRule } from 'vite-plus/lint/plugins';

// Solid without a compiler (`solid-js/h`): a JSX value is reactive only when it's a function. `{count()}` reads the
// signal once and renders that value forever; `{() => count()}` follows it. So a JSX value may only be something
// that can't hide a read: a function, a literal, a plain name (a name is either a constant or an accessor, and `h`
// calls accessors itself), or an element (`h` builds it when it's placed). Event handlers and refs take functions or
// values as they are.
const PASSED_AS_IS = /^(on[A-Z:]|ref$)/;

// On a component, `h` reads every function prop whose `length` is 0 as a value (it calls it), callbacks included:
// `onClose={() => close()}` would close when the prop is read. A callback's `length` is 0 when it has no parameter,
// or when its first has a default or is a rest one; so a component's callback is written in place, with a plain
// first parameter (a name passed instead can't be checked).
const CALLBACK = /^on[A-Z]/;
const COMPONENT = /^[A-Z]/;

// `h` builds an element once, when it's first used, and keeps it. An element handed to a component (a <Show>'s
// children or fallback) would come back as the same element the next time the component shows it, built the first
// time and disposed since; so it's handed over as a function, which builds it anew each time.

// A component's props are getters `h` makes (it reads the caller's functions through them): reading one into a
// name, or taking it apart (`const { x } = props`), reads it once, and the name never follows it.

type Node = {
    type: string;
    parent?: Node | null;
    name?: { type: string; name?: string };
    params?: Node[];
};

const isComponentTag = (node: Node | null | undefined) =>
    node?.type === 'JSXOpeningElement' && node.name?.type === 'JSXIdentifier' && COMPONENT.test(node.name.name ?? '');

/** Whether an element or expression is given to a component (as a child, or as a prop). */
function givenToComponent(node: Node): boolean {
    let parent = node.parent;
    if (parent?.type === 'JSXExpressionContainer') parent = parent.parent;
    if (parent?.type === 'JSXAttribute') parent = parent.parent;
    if (parent?.type === 'JSXElement') parent = (parent as Node & { openingElement: Node }).openingElement;
    return isComponentTag(parent);
}

/** Whether `h` reads a function as a value: its `length` is 0. */
function readAsValue(fn: Node): boolean {
    const first = fn.params?.[0];
    return !first || first.type === 'AssignmentPattern' || first.type === 'RestElement';
}

const ALLOWED = new Set([
    'ArrowFunctionExpression',
    'FunctionExpression',
    'Literal',
    'Identifier',
    'JSXEmptyExpression',
    'JSXElement',
    'JSXFragment',
]);

const rule: CreateRule = {
    meta: {
        type: 'problem',
        messages: {
            wrap: 'Wrap this in `() =>`: as written it is read once and never updates.',
            callback:
                "Write a component's callback here, with a plain first parameter: `h` calls a function whose length is 0 to read it.",
            lazy: 'Give a component a function that builds this (`() => <...>`): `h` builds an element once and keeps it.',
            props: 'Read props where they are used (`props.x`): taken out here, it is read once and never follows.',
        },
    },
    create(context) {
        return {
            JSXExpressionContainer(node) {
                const expression = node.expression;
                const parent = node.parent;
                if (parent?.type === 'JSXAttribute' && parent.name.type === 'JSXIdentifier') {
                    const onComponent = isComponentTag(parent.parent as unknown as Node);
                    if (onComponent && CALLBACK.test(parent.name.name)) {
                        const fn =
                            expression.type === 'ArrowFunctionExpression' || expression.type === 'FunctionExpression';
                        if (!fn || readAsValue(expression as unknown as Node)) {
                            return context.report({ node: expression, messageId: 'callback' });
                        }
                        return;
                    }
                    if (PASSED_AS_IS.test(parent.name.name)) return;
                }
                if (
                    (expression.type === 'JSXElement' || expression.type === 'JSXFragment') &&
                    givenToComponent(node as unknown as Node)
                ) {
                    return context.report({ node: expression, messageId: 'lazy' });
                }
                if (ALLOWED.has(expression.type)) return;
                if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0) return;
                context.report({ node: expression, messageId: 'wrap' });
            },
            JSXElement(node) {
                // A child written inside the component's tags (one inside braces is the container's to check).
                const self = node as unknown as Node;
                if (self.parent?.type === 'JSXElement' && givenToComponent(self))
                    context.report({ node, messageId: 'lazy' });
            },
            JSXFragment(node) {
                const self = node as unknown as Node;
                if (self.parent?.type === 'JSXElement' && givenToComponent(self))
                    context.report({ node, messageId: 'lazy' });
            },
            JSXSpreadAttribute(node) {
                // A spread copies the props' current values; Solid's `h` can't follow them.
                context.report({ node, messageId: 'wrap' });
            },
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
