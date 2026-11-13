import { createSignal } from 'solid-js';
import type { Client } from '@st/page/client';
import { HOTKEYS_VIEW } from '../protocol.ts';

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
        async hotkeysRead() {
            if (client.version(HOTKEYS_VIEW) === 0) await client.reread(HOTKEYS_VIEW);
        },
    };
}

export type HelpCompat = ReturnType<typeof helpCompat>;
