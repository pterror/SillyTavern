import { For as SolidFor, Show as SolidShow } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render as solidRender } from 'solid-js/web';
import type { JSX } from 'solid-js/h/jsx-runtime';

// Solid's control flow and render, typed for JSX compiled to `h` (no compiler: a child may be a function, which
// Solid's own types, written for its compiler, don't allow). The runtime is Solid's own; only the types differ.
// Everything here imports them from this module (lint: no-restricted-imports).

type Maybe<T> = T | (() => T);

export type Child = JSX.Element;

/** Shows its children while `when` is truthy; a function child gets the value (as an accessor). */
export const Show = SolidShow as unknown as <T>(props: {
    when: Maybe<T | undefined | null | false>;
    fallback?: Child;
    children: Child | ((value: Accessor<NonNullable<T>>) => Child);
}) => Child;

/** One child per item, kept per item (by identity) as the list changes. */
export const For = SolidFor as unknown as <T>(props: {
    each: Maybe<readonly T[] | undefined | null | false>;
    fallback?: Child;
    children: (item: T, index: Accessor<number>) => Child;
}) => Child;

/** Mounts a surface into a container the old page gives up; answers how to take it down. */
export const render = solidRender as unknown as (surface: () => Child, container: Element) => () => void;

// What `h` does with a component's props: a zero-parameter function passed for one is read through a getter, so the
// component sees the value and follows it. So the caller may pass any prop as its value or as a function giving it
// (callbacks, which take a parameter, and children are passed as they are).
declare module 'solid-js/h/jsx-runtime' {
    // oxlint-disable-next-line typescript/no-namespace -- the JSX namespace is how TypeScript reads JSX types.
    namespace JSX {
        /** Attributes the old page's CSS selects by (`attr:<name>`), kept so its stylesheets still apply. */
        interface ExplicitAttributes {
            bgfile: string | (() => string);
            custom: string | (() => string);
            animated: string | (() => string);
            'data-action': string | (() => string);
            'data-folder-id': string | (() => string);
        }
        type LibraryManagedAttributes<_Component, Props> = {
            [K in keyof Props]: K extends 'children' | 'ref' | `on${string}` ? Props[K] : Props[K] | (() => Props[K]);
        };
    }
}
