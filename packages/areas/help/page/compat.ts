import { createSignal } from 'solid-js';
import type { Client } from '@st/page/client';
import { HOTKEYS_VIEW } from '../protocol.ts';

export function helpCompat(client: Client) {
    const [reading, setReading] = createSignal(false);
    let raise: (() => void) | null = null;
    return {
        /** whether the page reads the panel's view: from the first time help opens */
        reading,
        onRaise(next: (() => void) | null) {
            raise = next;
        },
        /** @returns why it didn't open, or null */
        async open(name: string): Promise<string | null> {
            const answer = await client.send('help.open', { name });
            if (!answer.ok) return answer.error;
            setReading(true);
            raise?.();
            return null;
        },
        async hotkeysRead() {
            if (client.version(HOTKEYS_VIEW) === 0) await client.reread(HOTKEYS_VIEW);
        },
    };
}

export type HelpCompat = ReturnType<typeof helpCompat>;
