import { NAME_BOX_CLASS, NAME_PICTURE_CLASS, fontFaceCss, thingCss } from '@st/protocol/looks';
import type { Looks, ResolvedLook } from '@st/protocol/looks';

// The note takes no room in the line; a picture side shows only when its thing's look turns it on.
export const NAME_BASE_CSS = [
    `.${NAME_BOX_CLASS} { position: relative; }`,
    `.${NAME_BOX_CLASS}::after { position: absolute; left: 50%; bottom: calc(100% - 0.3em); transform: translateX(-50%); font-size: 0.6em; line-height: 1; white-space: nowrap; font-weight: 400; font-style: normal; letter-spacing: normal; opacity: 0.75; pointer-events: none; }`,
    `.${NAME_PICTURE_CLASS} { display: none; width: 1.05em; height: 1.05em; border-radius: 50%; object-fit: cover; vertical-align: -0.16em; margin: 0 0.2em; }`,
].join('\n');

export type LookSheet = {
    hold: (holder: string, looks: Looks) => void;
    add: (holder: string, looks: Looks) => void;
    drop: (holder: string) => void;
    css: () => string;
};

type Held = { at: number; things: Map<string, ResolvedLook> };

const lookOfThing = (looks: Looks, thing: string): ResolvedLook | undefined => {
    const style = looks.things[thing];
    return style === undefined ? undefined : looks.styles[style];
};

// A thing's rules come from the newest holder that draws it, and go when none does.
export function createLookSheet(write: (css: string) => void): LookSheet {
    const held = new Map<string, Held>();
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
        return [NAME_BASE_CSS, ...faces.values(), ...rules].join('\n');
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

    return {
        hold(holder, looks) {
            held.set(holder, { at: ++sequence, things: thingsOf(looks) });
            changed();
        },
        add(holder, looks) {
            held.set(holder, { at: ++sequence, things: thingsOf(looks, held.get(holder)?.things) });
            changed();
        },
        drop(holder) {
            if (held.delete(holder)) changed();
        },
        css,
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
