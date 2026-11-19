import { createEffect, createSignal, flush, onCleanup, onSettled } from 'solid-js';
import { drag } from '@pterror/interact-list/drag';
import type { Dragging, Point } from '@pterror/interact-list/drag';

export type Placement = { before: string } | { after: string };

/** Vertical row reordering. Elements supply geometry; only the caller's snapshots change their order. */
export function createReorder(options: {
    keys: () => readonly string[];
    move: (key: string, placement: Placement) => Promise<void>;
    active: (active: boolean) => void;
}) {
    const rows = new Map<string, HTMLElement>();
    const handles = new WeakMap<Element, string>();
    const drawnListeners = new Set<() => void>();
    const heldListeners = new Set<() => void>();
    const [held, setHeld] = createSignal<string | undefined>(undefined);
    const [target, setTarget] = createSignal<Dragging<string> | undefined>(undefined);
    const [pending, setPending] = createSignal(false);
    const [error, setError] = createSignal('');
    let list: HTMLElement | undefined;
    let stopDrag: (() => void) | undefined;
    let alive = true;
    const isAlive = () => alive;
    let active = false;
    let point: Point | undefined;
    let frame: number | undefined;
    const notify = () => {
        const next = held() !== undefined || pending();
        if (next === active) return;
        active = next;
        options.active(next);
    };
    const hold = (key: string | undefined) => {
        flush(() => {
            setHeld(key);
        });
        notify();
        for (const listener of heldListeners) listener();
    };
    const watch = (listeners: Set<() => void>, listener: () => void) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    };
    createEffect(
        () => [...options.keys()],
        (keys) => {
            const key = held();
            if (key !== undefined && !keys.includes(key)) hold(undefined);
            for (const listener of drawnListeners) listener();
        },
    );
    const move = async (key: string, anchor: string, after: boolean) => {
        const keys = options.keys();
        const from = keys.indexOf(key);
        const to = keys.indexOf(anchor);
        if (!isAlive() || pending() || from < 0 || to < 0 || key === anchor) return false;
        if (to + (after ? 1 : 0) - (from < to ? 1 : 0) === from) return false;
        flush(() => {
            setPending(true);
        });
        setError('');
        notify();
        try {
            await options.move(key, after ? { after: anchor } : { before: anchor });
            return true;
        } catch (reason) {
            if (isAlive()) setError(reason instanceof Error ? reason.message : String(reason));
            return false;
        } finally {
            if (isAlive()) {
                flush(() => {
                    setPending(false);
                });
                notify();
            }
        }
    };
    const scroll = () => {
        if (point === undefined || held() === undefined || list === undefined) return;
        for (let element = list.parentElement; element !== null; element = element.parentElement) {
            if (!['auto', 'scroll'].includes(getComputedStyle(element).overflowY)) continue;
            const box = element.getBoundingClientRect();
            const edge = Math.min(40, box.height / 4);
            if (edge > 0 && point.x >= box.left && point.x <= box.right) {
                const by =
                    point.y < box.top + edge
                        ? point.y - box.top - edge
                        : point.y > box.bottom - edge
                          ? point.y - box.bottom + edge
                          : 0;
                element.scrollTop += Math.max(-16, Math.min(16, by));
            }
            break;
        }
        frame = requestAnimationFrame(scroll);
    };
    const stopScroll = () => {
        point = undefined;
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
    };
    const attach = (element: HTMLElement) =>
        drag<string>({
            element,
            drawn: { watch: (listener) => watch(drawnListeners, listener) },
            held: { get: held, set: hold, watch: (listener) => watch(heldListeners, listener) },
            itemOf: (element) => {
                if (pending() || !(element instanceof Element)) return undefined;
                for (let at: Element | null = element; at !== null && at !== list; at = at.parentElement) {
                    const key = handles.get(at);
                    if (key !== undefined) return { key };
                }
                return undefined;
            },
            gap: (at, pressed) => {
                const element = list;
                if (element === undefined) return undefined;
                const box = element.getBoundingClientRect();
                if (at.x < box.left || at.x > box.right || at.y < box.top || at.y > box.bottom)
                    return { target: pressed.key, after: false };
                const shown = options.keys().flatMap((key) => {
                    const row = rows.get(key);
                    return row === undefined ? [] : [{ key, box: row.getBoundingClientRect() }];
                });
                // Returning the dragged key clears a previously valid gap in interact's drag primitive.
                for (const row of shown) {
                    if (at.y <= row.box.bottom)
                        return { target: row.key, after: at.y > (row.box.top + row.box.bottom) / 2 };
                }
                const last = shown.at(-1);
                return { target: last?.key ?? pressed.key, after: true };
            },
            reorder: move,
            showing: (where, motion) => {
                setTarget(where);
                if (motion.phase === 'moving') {
                    point = motion.point;
                    if (frame === undefined) frame = requestAnimationFrame(scroll);
                } else stopScroll();
            },
        });
    const cancel = () => {
        if (held() === undefined || pending()) return false;
        stopDrag?.();
        if (list !== undefined) stopDrag = attach(list);
        return true;
    };
    onSettled(() => {
        if (list === undefined) return;
        stopDrag = attach(list);
    });
    onCleanup(() => {
        alive = false;
        stopDrag?.();
        stopScroll();
        rows.clear();
        drawnListeners.clear();
        heldListeners.clear();
        if (active) options.active(false);
    });
    return {
        held,
        target,
        pending,
        error,
        list: (element: HTMLElement) => {
            list = element;
        },
        row(key: string) {
            onCleanup(() => {
                rows.delete(key);
            });
            return (element: HTMLElement) => {
                rows.set(key, element);
            };
        },
        handle(key: string) {
            let handle: HTMLElement | undefined;
            onCleanup(() => {
                if (handle !== undefined) handles.delete(handle);
            });
            return (element: HTMLElement) => {
                handle = element;
                handles.set(element, key);
            };
        },
        cancel,
        step(key: string, direction: -1 | 1) {
            if (held() !== undefined) return;
            const keys = options.keys();
            const next = keys[keys.indexOf(key) + direction];
            if (next !== undefined) void move(key, next, direction === 1);
        },
    };
}

export type Reorder = ReturnType<typeof createReorder>;
