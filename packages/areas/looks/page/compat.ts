import type { Client } from '@st/page/client';

export function looksCompat(client: Client) {
    return {
        /** @returns why it didn't open, or null */
        open: async (thing: string): Promise<string | null> => {
            const answered = await client.send('looks.open', { thing });
            return answered.ok ? null : answered.error;
        },
    };
}

export type LooksCompat = ReturnType<typeof looksCompat>;
