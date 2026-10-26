import h from 'solid-js/h';
import type { JSX } from 'solid-js/h/jsx-runtime';

// JSX for Solid without its compiler, through Solid's `h`. Solid's own runtime for it (solid-js/h/jsx-runtime) hands
// `h` an element's children inside its props, so they're inserted as one list, built inside the effect that inserts
// it: a component among them (a <Show>) is then owned by that effect and disposed when it runs again, and the page
// keeps showing what it showed before. `h` takes an element's children as its own arguments instead, each built
// with the element; this runtime passes them so. A component's children stay its `children` prop.

export type { JSX };

type Props = Record<string, unknown> & { children?: unknown };

export function jsx(type: unknown, props: Props): unknown {
    if (typeof type !== 'string') return h(type, props);
    const { children, ...rest } = props;
    if (children === undefined) return h(type, rest);
    return h(type, rest, ...(Array.isArray(children) ? (children as unknown[]) : [children]));
}

export function Fragment(props: { children: unknown }) {
    return props.children;
}

export { jsx as jsxs, jsx as jsxDEV };
