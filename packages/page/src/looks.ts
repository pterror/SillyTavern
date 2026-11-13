import {
    NAME_BOX_CLASS,
    NAME_INLINE_CLASS,
    NAME_PICTURE_CLASS,
    NAME_PICTURE_PROPERTY,
    fontFaceCss,
    markCss,
    markShown,
    thingCss,
} from '@st/protocol/looks';
import type { Looks, ResolvedLook, ResolvedMark } from '@st/protocol/looks';

// Inside it, every name is drawn still: the frame a motion shows readers whose device asks for less motion.
export const LOOK_STILL_CLASS = 'look-still';

// The app's motions (a look names them, `look-<name>`): each moves only what no effect sets and nothing that takes
// room, so a motion goes with every effect and moves nothing around the name. A glint passing (shimmer) and a slow
// light (drift) are a mask over the letters; breathe and flicker fade; float lifts the name without moving the line.
const MOTIONS_CSS = [
    `@keyframes look-shimmer { from { -webkit-mask-image: linear-gradient(100deg, #000 40%, rgb(0 0 0 / 45%) 50%, #000 60%); mask-image: linear-gradient(100deg, #000 40%, rgb(0 0 0 / 45%) 50%, #000 60%); -webkit-mask-size: 250% 100%; mask-size: 250% 100%; -webkit-mask-position: 100% 0; mask-position: 100% 0; } to { -webkit-mask-image: linear-gradient(100deg, #000 40%, rgb(0 0 0 / 45%) 50%, #000 60%); mask-image: linear-gradient(100deg, #000 40%, rgb(0 0 0 / 45%) 50%, #000 60%); -webkit-mask-size: 250% 100%; mask-size: 250% 100%; -webkit-mask-position: 0% 0; mask-position: 0% 0; } }`,
    `@keyframes look-drift { from { -webkit-mask-image: linear-gradient(90deg, #000, rgb(0 0 0 / 55%), #000); mask-image: linear-gradient(90deg, #000, rgb(0 0 0 / 55%), #000); -webkit-mask-size: 200% 100%; mask-size: 200% 100%; -webkit-mask-position: 0% 0; mask-position: 0% 0; } to { -webkit-mask-image: linear-gradient(90deg, #000, rgb(0 0 0 / 55%), #000); mask-image: linear-gradient(90deg, #000, rgb(0 0 0 / 55%), #000); -webkit-mask-size: 200% 100%; mask-size: 200% 100%; -webkit-mask-position: 200% 0; mask-position: 200% 0; } }`,
    '@keyframes look-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }',
    '@keyframes look-flicker { 0%, 100% { opacity: 1; } 8% { opacity: 0.8; } 12% { opacity: 1; } 40% { opacity: 0.92; } 44% { opacity: 0.7; } 48% { opacity: 1; } 72% { opacity: 0.85; } }',
    '@keyframes look-float { 0%, 100% { top: 0; } 50% { top: -0.08em; } }',
    `.${LOOK_STILL_CLASS} .named { animation: none; }`,
    '@media (prefers-reduced-motion: reduce) { .name-box .named { animation: none; } }',
];

// The note takes no room in the line; a picture side shows only when its thing's look turns it on, and shows the
// thing's own picture unless its look crops it or draws another image.
export const NAME_BASE_CSS = [
    `.${NAME_BOX_CLASS} { position: relative; }`,
    '.named { position: relative; }',
    `.${NAME_BOX_CLASS}::after { position: absolute; left: 50%; bottom: calc(100% - 0.3em); transform: translateX(-50%); font-size: 0.6em; line-height: 1; white-space: nowrap; font-weight: 400; font-style: normal; letter-spacing: normal; opacity: 0.75; pointer-events: none; }`,
    `.${NAME_PICTURE_CLASS}, .${NAME_INLINE_CLASS}::before, .${NAME_INLINE_CLASS} > .named::after { display: none; width: 1.05em; height: 1.05em; border-radius: 50%; vertical-align: -0.16em; margin: 0 0.2em; background: var(${NAME_PICTURE_PROPERTY}) center / cover no-repeat; }`,
    `.${NAME_INLINE_CLASS}::before, .${NAME_INLINE_CLASS} > .named::after { content: ''; }`,
    ...MOTIONS_CSS,
].join('\n');

export type LookSheet = {
    hold: (holder: string, looks: Looks) => void;
    add: (holder: string, looks: Looks) => void;
    drop: (holder: string) => void;
    css: () => string;
    // Whether the trigger mark is drawn at all; true until a view brings it.
    markShown: () => boolean;
    onMarkShown: (listener: (shown: boolean) => void) => () => void;
};

type Held = { at: number; things: Map<string, ResolvedLook> };

const lookOfThing = (looks: Looks, thing: string): ResolvedLook | undefined => {
    const style = looks.things[thing];
    return style === undefined ? undefined : looks.styles[style];
};

// A thing's rules come from the newest holder that draws it, and go when none does.
export function createLookSheet(write: (css: string) => void): LookSheet {
    const held = new Map<string, Held>();
    let mark: ResolvedMark | null = null;
    const markListeners = new Set<(shown: boolean) => void>();
    let sequence = 0;
    let written: string | null = null;
    let queued = false;

    const css = (): string => {
        const newest = new Map<string, { at: number; look: ResolvedLook }>();
        for (const { at, things } of held.values()) {
            for (const [thing, look] of things) {
                const known = newest.get(thing);
                if (!known || known.at < at) newest.set(thing, { at, look });
            }
        }
        const faces = new Map<string, string>();
        const rules: string[] = [];
        for (const [thing, { look }] of [...newest].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
            for (const face of look.fonts) faces.set(`${face.family}\n${face.url}`, fontFaceCss(face));
            const own = thingCss(thing, look);
            if (own !== '') rules.push(own);
        }
        return [NAME_BASE_CSS, ...faces.values(), ...rules, ...(mark ? [markCss(mark)] : [])].join('\n');
    };

    const changed = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            const next = css();
            if (next === written) return;
            written = next;
            write(next);
        });
    };

    const thingsOf = (looks: Looks, into = new Map<string, ResolvedLook>()) => {
        for (const thing of Object.keys(looks.things)) {
            const look = lookOfThing(looks, thing);
            if (look) into.set(thing, look);
        }
        return into;
    };

    const takeMark = (looks: Looks) => {
        if (!looks.mark) return;
        const was = mark ? markShown(mark) : true;
        mark = looks.mark;
        const shown = markShown(mark);
        if (shown !== was) for (const listener of markListeners) listener(shown);
    };

    return {
        hold(holder, looks) {
            held.set(holder, { at: ++sequence, things: thingsOf(looks) });
            takeMark(looks);
            changed();
        },
        add(holder, looks) {
            held.set(holder, { at: ++sequence, things: thingsOf(looks, held.get(holder)?.things) });
            takeMark(looks);
            changed();
        },
        drop(holder) {
            if (held.delete(holder)) changed();
        },
        css,
        markShown: () => (mark ? markShown(mark) : true),
        onMarkShown(listener) {
            markListeners.add(listener);
            return () => markListeners.delete(listener);
        },
    };
}

export function documentLookSheet(document: Document): LookSheet {
    const style = document.createElement('style');
    style.dataset['looks'] = '';
    document.head.append(style);
    return createLookSheet((css) => {
        style.textContent = css;
    });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const isLooks = (value: unknown): value is Looks =>
    isRecord(value) && isRecord(value['styles']) && isRecord(value['things']);
