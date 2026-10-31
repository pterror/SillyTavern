import { clipPathFor, holesIn } from './geometry.ts';
import type { Rect } from './geometry.ts';
import {
    childOf,
    comesAfter,
    inTopLayer,
    isPositioned,
    isShown,
    paintedBoxes,
    paintsBefore,
    paintsOver,
    rootZOf,
} from './paint.ts';
import type { Policy } from './policies.ts';

export type Stack = {
    readonly members: () => readonly Element[];
    readonly compare: (a: Element, b: Element) => number;
};

export type OcclusionOptions = {
    readonly root?: Element;
    readonly stack?: Stack;
    readonly policies?: readonly Policy[];
    readonly onHiddenChange?: () => void;
};

export type State = 'cut' | 'hidden';

export type Occlusion = {
    readonly setEnabled: (on: boolean) => void;
    readonly enabled: () => boolean;
    readonly update: () => void;
    readonly stateOf: (el: Element) => State | null;
    readonly overlays: () => readonly Element[];
    readonly isFree: (overlay: Element) => boolean;
    readonly dispose: () => void;
};

export const STATE_ATTRIBUTE = 'data-occluded';

const HIDDEN_STYLE = `[${STATE_ATTRIBUTE}="hidden"] {
    visibility: hidden !important;
    clip-path: inset(50%) !important;
    transition: visibility 0s !important;
}`;

type Layer = { el: Element; member: Element | null; top: boolean; z: number };

export function createOcclusion(options: OcclusionOptions = {}): Occlusion {
    const root = options.root ?? document.body;
    const stack = options.stack ?? { members: () => [], compare: () => 0 };
    const policies = options.policies ?? [];
    let on = false;
    const positioned = new Set<Element>();
    const marked = new Map<Element, string>();
    let overlays: Layer[] = [];
    let style: HTMLStyleElement | null = null;
    let frame = 0;
    let lastBoxes = '';

    const policiesOf = (el: Element) => policies.filter((policy) => policy.matches(el));

    const note = (el: Element) => {
        if (isPositioned(el)) positioned.add(el);
        else positioned.delete(el);
    };
    const noteTree = (top: Element) => {
        note(top);
        for (const el of top.querySelectorAll('*')) note(el);
    };

    const take = (records: MutationRecord[]) => {
        for (const record of records) {
            if (record.type === 'childList') {
                for (const node of record.addedNodes) if (node instanceof Element) noteTree(node);
            } else if (record.target instanceof Element) {
                if (record.attributeName === 'class') noteTree(record.target);
                else note(record.target);
            }
        }
    };

    const watcher = new MutationObserver((records) => {
        take(records);
        schedule();
    });
    const sizes = new ResizeObserver(() => {
        if (frame === 0) schedule();
    });
    const onScroll = () => {
        if (overlays.length > 0) schedule();
    };

    const memberOf = (el: Element, members: ReadonlySet<Element>) => {
        for (let at = el.parentElement; at && at !== root; at = at.parentElement) if (members.has(at)) return at;
        return null;
    };

    const findOverlays = (members: ReadonlySet<Element>, shown: readonly Element[]): Layer[] => {
        const lowest = Math.min(Infinity, ...shown.map((member) => rootZOf(childOf(member, root), root)));
        const out: Layer[] = [];
        for (const el of positioned) {
            if (!el.isConnected || !root.contains(el)) {
                positioned.delete(el);
                continue;
            }
            if (
                members.has(el) ||
                !isShown(el) ||
                !paintsOver(el) ||
                [...members].some((member) => el.contains(member))
            )
                continue;
            const top = inTopLayer(el);
            const member = top ? null : memberOf(el, members);
            const z = rootZOf(el, root);
            if (!member && !top && !(z > lowest)) continue;
            out.push({ el, member, top, z });
        }
        return out.sort((a, b) => (comesAfter(a.el, b.el) ? 1 : -1));
    };

    const inFrontOf = (a: Layer, b: Layer, memberZ: ReadonlyMap<Element, number>): boolean => {
        if (a.top || b.top) return a.top && b.top ? comesAfter(a.el, b.el) : a.top;
        if (a.member && b.member) {
            if (a.member !== b.member) return stack.compare(a.member, b.member) > 0;
            if (a.el === a.member) return false;
            return b.el === b.member || a.z > b.z || (a.z === b.z && comesAfter(a.el, b.el));
        }
        if (!a.member && b.member) return a.z > (memberZ.get(b.member) ?? 0);
        if (a.member && !b.member) return !(b.z > (memberZ.get(a.member) ?? 0));
        return a.z > b.z || (a.z === b.z && comesAfter(a.el, b.el));
    };

    const holesInside = (into: Map<Element, Rect[]>, covered: ReadonlySet<Element>) => {
        for (const { el, member, top } of overlays) {
            if (!member || top || covered.has(el)) continue;
            const covers = paintedBoxes(el, false);
            if (covers.length === 0) continue;
            for (let branch: Element = el; branch.parentElement && branch !== member; branch = branch.parentElement) {
                for (const sibling of branch.parentElement.children) {
                    if (sibling === branch || !paintsBefore(sibling, branch)) continue;
                    const holes = holesIn(sibling.getBoundingClientRect(), covers);
                    if (holes.length > 0) into.set(sibling, [...(into.get(sibling) ?? []), ...holes]);
                }
            }
        }
    };

    const apply = (holesByEl: ReadonlyMap<Element, Rect[]>) => {
        const hidden = new Set<Element>();
        const next = new Map<Element, { state: State; clip: string }>();
        for (const [el, raw] of holesByEl) {
            const target = { el, box: el.getBoundingClientRect() };
            let holes = raw;
            const own = policiesOf(el);
            for (const policy of own) if (policy.holes) holes = policy.holes(holes, target);
            if (own.some((policy) => policy.hides?.(holes, target) === true)) {
                hidden.add(el);
                next.set(el, { state: 'hidden', clip: '' });
            } else if (holes.length > 0) {
                next.set(el, { state: 'cut', clip: clipPathFor(holes) });
            }
        }
        for (const [el, clip] of marked) {
            if (next.has(el)) continue;
            unmark(el, clip);
            marked.delete(el);
        }
        for (const [el, { state, clip }] of next) {
            const html = el as HTMLElement;
            if (el.getAttribute(STATE_ATTRIBUTE) !== state) el.setAttribute(STATE_ATTRIBUTE, state);
            const before = marked.get(el);
            if (before !== clip) {
                if (clip !== '' || before !== undefined) html.style.clipPath = clip;
                marked.set(el, clip);
            }
        }
        return hidden;
    };

    const unmark = (el: Element, clip: string) => {
        el.removeAttribute(STATE_ATTRIBUTE);
        if (clip !== '') (el as HTMLElement).style.clipPath = '';
    };

    const clear = () => {
        for (const [el, clip] of marked) unmark(el, clip);
        marked.clear();
        overlays = [];
    };

    function update() {
        if (!on) return;
        take(watcher.takeRecords());
        const before = new Set([...marked.keys()].filter((el) => el.getAttribute(STATE_ATTRIBUTE) === 'hidden'));
        const members = new Set(stack.members());
        const shown = [...members].filter(isShown);
        const previous = overlays;
        overlays = findOverlays(members, shown);
        const memberZ = new Map(shown.map((member) => [member, rootZOf(childOf(member, root), root)]));
        const layers: Layer[] = [
            ...shown.map((el) => ({ el, member: el, top: false, z: memberZ.get(el) ?? 0 })),
            ...overlays,
        ];
        const painted = new Map(
            layers.map((layer) => [
                layer.el,
                paintedBoxes(
                    layer.el,
                    policiesOf(layer.el).some((policy) => policy.coversBox === true),
                ),
            ]),
        );
        const cutAll = (hiddenLayers: ReadonlySet<Element>) => {
            const holesByEl = new Map<Element, Rect[]>();
            for (const layer of layers) {
                const covers = layers
                    .filter(
                        (other) =>
                            other !== layer &&
                            !hiddenLayers.has(other.el) &&
                            (!layer.el.contains(other.el) || other.top) &&
                            !other.el.contains(layer.el) &&
                            inFrontOf(other, layer, memberZ),
                    )
                    .flatMap((other) => painted.get(other.el) ?? []);
                const holes = holesIn(layer.el.getBoundingClientRect(), covers);
                if (holes.length > 0) holesByEl.set(layer.el, holes);
            }
            holesInside(holesByEl, hiddenLayers);
            return apply(holesByEl);
        };
        const hidden = cutAll(new Set());
        if (layers.some((layer) => hidden.has(layer.el))) cutAll(hidden);
        if (previous.length !== overlays.length || previous.some((layer, i) => layer.el !== overlays[i]?.el)) {
            sizes.disconnect();
            for (const layer of layers) sizes.observe(layer.el);
        }
        watcher.takeRecords();
        const after = new Set([...marked.keys()].filter((el) => el.getAttribute(STATE_ATTRIBUTE) === 'hidden'));
        if (before.size !== after.size || [...before].some((el) => !after.has(el))) options.onHiddenChange?.();
    }

    function schedule() {
        if (!on || frame !== 0) return;
        frame = requestAnimationFrame(function step() {
            update();
            const layers = [...stack.members(), ...overlays.map((layer) => layer.el)].filter(isShown);
            const boxes = layers
                .map((el) => {
                    const r = el.getBoundingClientRect();
                    return `${r.left},${r.top},${r.width},${r.height}`;
                })
                .join(';');
            const animating = layers.some((el) =>
                el
                    .getAnimations({ subtree: false })
                    .some(
                        (animation) =>
                            animation.playState === 'running' &&
                            Number.isFinite(animation.effect?.getComputedTiming().endTime),
                    ),
            );
            const moving = boxes !== lastBoxes || animating;
            lastBoxes = boxes;
            frame = on && moving ? requestAnimationFrame(step) : 0;
        });
    }

    const setEnabled = (enable: boolean) => {
        if (enable === on) return;
        on = enable;
        if (on) {
            style = document.createElement('style');
            style.textContent = HIDDEN_STYLE;
            document.head.append(style);
            noteTree(root);
            watcher.observe(root, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['class', 'style', 'open', 'popover', 'hidden'],
            });
            document.addEventListener('scroll', onScroll, { capture: true, passive: true });
            document.addEventListener('toggle', schedule, true);
            window.addEventListener('resize', schedule);
            update();
            schedule();
        } else {
            watcher.disconnect();
            sizes.disconnect();
            document.removeEventListener('scroll', onScroll, { capture: true });
            document.removeEventListener('toggle', schedule, true);
            window.removeEventListener('resize', schedule);
            if (frame !== 0) cancelAnimationFrame(frame);
            frame = 0;
            const hadHidden = [...marked.keys()].some((el) => el.getAttribute(STATE_ATTRIBUTE) === 'hidden');
            clear();
            positioned.clear();
            style?.remove();
            style = null;
            if (hadHidden) options.onHiddenChange?.();
        }
    };

    return {
        setEnabled,
        enabled: () => on,
        update: () => {
            update();
            schedule();
        },
        stateOf: (el) => {
            const state = el.getAttribute(STATE_ATTRIBUTE);
            return state === 'cut' || state === 'hidden' ? state : null;
        },
        overlays: () => overlays.map((layer) => layer.el),
        isFree: (el) => overlays.some((layer) => layer.el === el && layer.member === null),
        dispose: () => setEnabled(false),
    };
}
