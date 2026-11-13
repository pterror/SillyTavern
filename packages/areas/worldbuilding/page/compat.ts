import { createSignal } from 'solid-js';

// What the old page tells the worldbuilding page: whether the pane it lives in is open.
export function worldbuildingCompat() {
    const [shown, setShown] = createSignal(false);
    const [everShown, setEverShown] = createSignal(false);
    return {
        shown,
        everShown,
        paneShown(open: boolean) {
            setShown(open);
            if (open) setEverShown(true);
        },
    };
}

export type WorldbuildingCompat = ReturnType<typeof worldbuildingCompat>;
