import { onSettled } from 'solid-js';

/** Sets up a referenced element after mounting, with cleanup owned by the calling component. */
export function elementSetup<T extends Element>(setup: (element: T) => void | (() => void)): (element: T) => void {
    let element: T | undefined;
    onSettled(() => (element === undefined ? undefined : setup(element)));
    return (shown) => {
        element = shown;
    };
}

/** A keyed DOM move may blur a surviving control; keep its focus without taking it from another control. */
export function preserveFocus(change: () => void): void {
    const focused = document.activeElement;
    change();
    if (focused instanceof HTMLElement && focused.isConnected && document.activeElement === document.body)
        focused.focus({ preventScroll: true });
}
