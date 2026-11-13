import { onCleanup, onMount } from 'solid-js';

// Calls `close` on a press outside `inside()` (and outside `also`, the button that opened it) or on Escape, which then
// goes no further: the old page closes its drawers on Escape.
export function dismissOn(
    inside: () => HTMLElement | undefined,
    close: () => void,
    also?: () => HTMLElement | undefined,
) {
    onMount(() => {
        const pressed = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (inside()?.contains(target) === true || also?.()?.contains(target) === true) return;
            close();
        };
        const key = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            close();
        };
        document.addEventListener('pointerdown', pressed, true);
        window.addEventListener('keydown', key, true);
        onCleanup(() => {
            document.removeEventListener('pointerdown', pressed, true);
            window.removeEventListener('keydown', key, true);
        });
    });
}
