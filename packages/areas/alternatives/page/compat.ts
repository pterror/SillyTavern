import type { Setter } from 'solid-js';
import type { Look } from './Alternatives.tsx';

export function alternativesCompat(setLook: Setter<Look | null>) {
    return {
        openMessage(mesId: number, node: string | null, title: string, at?: number) {
            const target = node === null ? { opening: true as const } : { message: node };
            setLook({ target, mesId, title, ...(at === undefined ? {} : { at }) });
        },
        openGreetings(avatar: string, title: string) {
            setLook({ target: { greetings: avatar }, mesId: null, title });
        },
        close() {
            setLook(null);
        },
    };
}

export type AlternativesCompat = ReturnType<typeof alternativesCompat>;
