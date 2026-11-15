import { createSignal } from 'solid-js';
import type { Client } from '@st/page/client';

export function helpCompat(client: Client) {
    const [shown, setShown] = createSignal(false);
    let raise: (() => void) | null = null;
    return {
        shown,
        onRaise(next: (() => void) | null) {
            raise = next;
        },
        /** @returns why it didn't open, or null */
        async open(name: string): Promise<string | null> {
            const answer = await client.send('help.open', { name });
            if (!answer.ok) return answer.error;
            setShown(true);
            raise?.();
            return null;
        },
        close() {
            setShown(false);
            void client.send('help.close', {});
        },
    };
}

export type HelpCompat = ReturnType<typeof helpCompat>;
