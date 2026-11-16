import { createSignal } from 'solid-js';
import type { Client } from '@st/page/client';
import type { Of } from '../protocol.ts';

export function recentHistoryCompat(client: Client) {
    const [shown, setShown] = createSignal<Of | null>(null);
    return {
        shown,
        /** @returns why it didn't open, or null */
        async open(of: Of): Promise<string | null> {
            const answer = await client.send('recentHistory.open', { of });
            if (!answer.ok) return answer.error;
            setShown(of);
            return null;
        },
        close() {
            setShown(null);
            void client.send('recentHistory.close', {});
        },
    };
}

export type RecentHistoryCompat = ReturnType<typeof recentHistoryCompat>;
