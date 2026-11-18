import { onSettled } from 'solid-js';

/** Sets up a referenced element after mounting, with cleanup owned by the calling component. */
export function elementSetup<T extends Element>(setup: (element: T) => void | (() => void)): (element: T) => void {
    let element: T | undefined;
    onSettled(() => (element === undefined ? undefined : setup(element)));
    return (shown) => {
        element = shown;
    };
}
