import type { Setter } from 'solid-js';
import type { Look } from './Alternatives.tsx';

// What the old page calls to open the list: the swipe counter on a message, and the greetings button in character
// info. (Upstream's swipe-picker.js exports are stubs over this.)

export function alternativesCompat(setLook: Setter<Look | null>) {
    return {
        /**
         * A chat message's alternatives (`node`: its node id), or, with no node (the chat's first message of a
         * character's chat), its openings; `at`: the one selected (0-based), else the current one.
         */
        openMessage(mesId: number, node: string | null, title: string, at?: number) {
            const target = node === null ? { opening: true as const } : { message: node };
            setLook({ target, mesId, title, ...(at === undefined ? {} : { at }) });
        },
        /** A character's greetings. */
        openGreetings(avatar: string, title: string) {
            setLook({ target: { greetings: avatar }, mesId: null, title });
        },
        close() {
            setLook(null);
        },
    };
}

export type AlternativesCompat = ReturnType<typeof alternativesCompat>;
