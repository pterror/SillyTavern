import { float } from '@st/page/popover';
import type { Align } from '@st/page/popover';

// Floats `inside()` against the button that opened it (else against the element holding it) and calls `close` on a
// press outside both or on Escape.
export function dismissOn(
    inside: () => HTMLElement | undefined,
    close: () => void,
    opener?: () => HTMLElement | undefined,
    options: { align?: Align; framed?: boolean } = {},
) {
    const anchor = () => opener?.() ?? inside()?.parentElement ?? undefined;
    float(inside, { anchor, close, also: () => [anchor()], ...options });
}
