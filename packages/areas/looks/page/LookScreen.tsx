import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { useUi } from '@st/page/context';
import { ask } from '@st/page/dialog';
import { Name } from '@st/page/name';
import {
    LOOK_SCOPE_CLASS,
    LOOK_SHOWS_MESSAGE_POINTED_CLASS,
    LOOK_SHOWS_WORD_POINTED_CLASS,
    LOOK_STATES,
    TRIGGER_MARK_CLASS,
    cropCss,
    lookClass,
} from '@st/protocol/looks';
import type { Declaration, LookState, MarkState, MarkStyle, PictureCrop } from '@st/protocol/looks';
import { LOOK_VIEW } from '../protocol.ts';
import type { LevelItem, LookView, Shown } from '../protocol.ts';
import {
    CONTROLLED,
    EFFECTS,
    MOTIONS,
    NEUTRAL,
    changeOf,
    cssText,
    declareEffect,
    drawnDeclarations,
    effects,
    hexOf,
    readEffect,
    styleText,
    withoutEffect,
} from './effects.ts';
import type { Controls, EffectId, Layer, Motion } from './effects.ts';

type Open = Extract<LookView, { thing: string }>;

type Panel = EffectId | 'css' | 'mark';

export const STATE_LABELS: Record<LookState, string> = {
    rest: 'As it sits',
    messagePointed: 'Message pointed at',
    wordPointed: 'Word pointed at or focused',
    selected: 'Selected',
};

export const EFFECT_LABELS: Record<EffectId, string> = {
    color: 'Color',
    glow: 'Glow',
    outline: 'Outline',
    shadow: 'Shadow',
    underline: 'Underline',
    letters: 'Letters',
    typeface: 'Typeface',
    blur: 'Blur',
    motion: 'Motion',
};

const MOTION_LABELS: Record<Motion, string> = {
    shimmer: 'Shimmer',
    breathe: 'Breathe',
    flicker: 'Flicker',
    drift: 'Drift',
    float: 'Float',
};

const MARK_STYLE_LABELS: [MarkStyle, string][] = [
    ['dotted', 'Dotted'],
    ['dashed', 'Dashed'],
    ['large-dots', 'Large dots'],
    ['none', 'None'],
];

const GLYPH_INK = '#e4e2dc';
const DEFAULT_CROP: PictureCrop = { x: 0.28, y: 0.12, width: 0.44, height: 0.44 };

// The classes that show a state's layers as if it were on: a state shows the layers below it too.
export function stateClasses(state: LookState): Record<string, boolean> {
    const at = LOOK_STATES.indexOf(state);
    return {
        [LOOK_SHOWS_MESSAGE_POINTED_CLASS]: at >= LOOK_STATES.indexOf('messagePointed'),
        [LOOK_SHOWS_WORD_POINTED_CLASS]: at >= LOOK_STATES.indexOf('wordPointed'),
    };
}

export function levelLabel(item: LevelItem, thingName: string, t: (text: string) => string): string {
    switch (item.kind) {
        case 'theme':
            return t('Every name');
        case 'world':
            return t('Everything in ${0}').replace('${0}', item.name);
        case 'shared':
            return item.name ?? t('A shared look that is gone');
        case 'thing':
            return t('Just ${0}').replace('${0}', thingName);
    }
}

const layerOf = (shown: readonly Shown[]): Map<string, string> => new Map(shown.map((d) => [d.property, d.value]));

// The level an effect's controls write to in `state`: the most specific one that sets it in that state's own layer,
// else the thing itself.
export function supplierOf(id: EffectId, state: LookState, shown: readonly Shown[], thingLevel: number): number {
    const own = shown.filter((d) => d.state === state && effects[id].properties.includes(d.property));
    return own.length === 0 ? thingLevel : Math.max(...own.map((d) => d.level));
}

const resolveColor = (color: string): string | null => {
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return null;
    context.fillStyle = '#000000';
    context.fillStyle = color;
    return context.fillStyle;
};
const hex = (color: string, fallback: string) =>
    /^currentcolor$/i.test(color.trim()) ? fallback : (hexOf(color, resolveColor) ?? fallback);

// The view this tab holds once `looks.open` has answered it; reading it never opens it on its own.
const shownView = <T,>(read: () => T | undefined, version: () => number): Accessor<T | undefined> =>
    createMemo(() => (version() > 0 ? read() : undefined));

export function LookScreen() {
    const { client } = useUi();
    const view = shownView(
        () => client.view<LookView>(LOOK_VIEW)(),
        () => client.version(LOOK_VIEW),
    );
    const open = (): Open | null => {
        const shown = view();
        return shown !== undefined && shown.thing !== null ? shown : null;
    };
    return <Show when={open()}>{(shown) => <Screen view={shown()} />}</Show>;
}

function Screen(props: { view: Open }) {
    const { client, t } = useUi();
    const [state, setState] = createSignal<LookState>('rest');
    const [panel, setPanel] = createSignal<Panel | null>(null);
    const [draft, setDraft] = createSignal<Declaration[] | null>(null);
    const thingLevel = () => props.view.levels.length - 1;
    const name = () => props.view.named.text;
    const shown = () => props.view.shown[state()];
    const layer = (): Layer => layerOf(shown());
    const families = () => new Map(props.view.fonts.map((f) => [f.id, f.family]));
    const send = (type: string, payload: unknown, file?: File) => client.send(type, payload, file);
    const close = () => void send('looks.close', {});

    const writeEffect = async <K extends EffectId>(id: K, next: Controls[K]) => {
        const at = supplierOf(id, state(), shown(), thingLevel());
        const { set, cleared } = changeOf(id, layer(), next);
        const suppliers = new Map(shown().map((d) => [d.property, d]));
        const reset = cleared.filter((p) => suppliers.get(p)?.level === at && suppliers.get(p)?.state === state());
        const neutral = cleared.filter((p) => !reset.includes(p)).map((property) => ({ property, value: NEUTRAL }));
        const level = props.view.levels[at]?.level;
        if (!level) return;
        await send('looks.setDeclarations', { level, state: state(), set: [...neutral, ...set], reset });
        setDraft(null);
    };
    const preview = <K extends EffectId>(id: K, next: Controls[K]) => setDraft(declareEffect(id, next, layer()));

    const draftCss = () => {
        const declarations = draft();
        if (declarations === null) return '';
        const body = styleText(drawnDeclarations(declarations, families()));
        return `.look-draft .${lookClass(props.view.thing)} { ${body} }`;
    };

    onMount(() => {
        const key = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
            event.stopPropagation();
            if (panel() !== null) setPanel(null);
            else close();
        };
        window.addEventListener('keydown', key, true);
        onCleanup(() => window.removeEventListener('keydown', key, true));
    });

    return (
        <div class="look-screen" role="dialog" aria-label={t('Look')}>
            <style>{draftCss()}</style>
            <div class="look-hd">
                <button type="button" class="look-back" onClick={close}>
                    <svg class="look-ic" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M15 6l-6 6 6 6" />
                    </svg>
                    {name()}
                </button>
                <div class="look-hdt">{t('Look')}</div>
            </div>
            <div class="look-body">
                <Stage view={props.view} state={state()} />
                <div class="look-states" role="radiogroup" aria-label={t('State to set')}>
                    <For each={LOOK_STATES}>
                        {(each) => (
                            <button
                                type="button"
                                role="radio"
                                aria-checked={state() === each}
                                aria-label={t(STATE_LABELS[each])}
                                title={t(STATE_LABELS[each])}
                                class={`look-sth look-sth-${each}`}
                                classList={{ 'look-sel': state() === each, 'look-draft': state() === each }}
                                onClick={() => {
                                    setDraft(null);
                                    setState(each);
                                }}
                            >
                                <span class="look-stl" classList={stateClasses(each)}>
                                    <span class="look-std" aria-hidden="true" />
                                    <span class="look-stw">
                                        <Name named={props.view.named} selected={each === 'selected'} />
                                    </span>
                                    <span class="look-stx" aria-hidden="true" />
                                </span>
                                <svg class="look-cur" viewBox="0 0 16 16" aria-hidden="true">
                                    <path d="M3 2l9 6.5-4 .8 2.4 4.6-1.8.9-2.4-4.6L3 13z" />
                                </svg>
                            </button>
                        )}
                    </For>
                </div>
                <Uses view={props.view} />
                <div
                    class="look-tbar"
                    role="toolbar"
                    aria-label={`${t('Look of the name')}: ${t(STATE_LABELS[state()])}`}
                >
                    <For each={EFFECTS}>
                        {(id) => (
                            <Tool
                                id={id}
                                layer={layer()}
                                families={families()}
                                open={panel() === id}
                                onPick={() => {
                                    if (panel() === id) {
                                        setPanel(null);
                                        return;
                                    }
                                    if (readEffect(id, layer()) === null) void writeEffect(id, effects[id].start);
                                    setPanel(id);
                                }}
                            />
                        )}
                    </For>
                    <button
                        type="button"
                        class="look-tool look-csst"
                        classList={{ 'look-open': panel() === 'css' }}
                        aria-label="CSS"
                        title="CSS"
                        aria-expanded={panel() === 'css'}
                        onClick={() => setPanel(panel() === 'css' ? null : 'css')}
                    >
                        <svg
                            class="look-ic"
                            style={{ width: '20px', height: '20px' }}
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                        >
                            <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
                        </svg>
                    </button>
                </div>
                <Show when={panel()}>
                    {(open) => (
                        <div class="look-edw">
                            <Switch>
                                <Match when={open() === 'css'}>
                                    <CssPanel view={props.view} state={state()} />
                                </Match>
                                <Match when={open() === 'mark'}>
                                    <MarkPanel view={props.view} state={state()} />
                                </Match>
                                <Match when={open() !== 'css' && open() !== 'mark'}>
                                    <EffectPanel
                                        id={open() as EffectId}
                                        view={props.view}
                                        state={state()}
                                        layer={layer()}
                                        onPreview={preview}
                                        onWrite={(id, next) => void writeEffect(id, next)}
                                    />
                                </Match>
                            </Switch>
                        </div>
                    )}
                </Show>
                <Renders
                    view={props.view}
                    markOpen={panel() === 'mark'}
                    onMark={() => setPanel(panel() === 'mark' ? null : 'mark')}
                />
            </div>
        </div>
    );
}

// The small picture as the look shows it: another image, or the thing's own, cropped when the look crops it.
function smallPictureStyle(view: Open): string | undefined {
    const url = view.picture.image ?? view.picture.own;
    if (url === null) return undefined;
    const crop = view.picture.crop === null ? '' : ` ${cropCss(view.picture.crop)}`;
    return `background-image: url("${url}");${crop}`;
}

const pictureUrl = (view: Open): string | null => view.picture.own ?? view.picture.image;

function Stage(props: { view: Open; state: LookState }) {
    const { client, t } = useUi();
    const [pop, setPop] = createSignal<'before' | 'after' | null>(null);
    const thing = () => ({ thing: props.view.thing });
    const placed = (side: 'before' | 'after') => props.view.placement[side]?.value === true;
    const moving = () =>
        LOOK_STATES.some((state) => props.view.shown[state].some((d) => d.property === 'animation-name'));
    const choose = async (): Promise<File | null> =>
        new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.addEventListener('change', () => {
                resolve(input.files?.[0] ?? null);
            });
            input.addEventListener('cancel', () => {
                resolve(null);
            });
            input.click();
        });
    const slot = (side: 'before' | 'after') => (
        <button
            type="button"
            class="look-slot"
            classList={{ 'look-on': placed(side) }}
            aria-pressed={placed(side)}
            aria-label={`${side === 'before' ? t('Picture before the name') : t('Picture after the name')}: ${props.view.named.text}`}
            onClick={() =>
                void (async () => {
                    if (placed(side)) {
                        setPop(pop() === side ? null : side);
                        return;
                    }
                    if (pictureUrl(props.view) === null) {
                        const file = await choose();
                        if (!file) return;
                        const sent = await client.send('looks.uploadPicture', thing(), file);
                        if (!sent.ok) return;
                    }
                    await client.send('looks.setPicture', {
                        level: thing(),
                        before: side === 'before' ? true : null,
                        after: side === 'after' ? true : null,
                    });
                })()
            }
        >
            <span class="look-slp" style={smallPictureStyle(props.view)} aria-hidden="true" />
        </button>
    );
    return (
        <div class="look-stage1">
            <div class="look-rd look-big1 look-draft" classList={stateClasses(props.state)}>
                <div class="look-big">
                    <NoteInput view={props.view} />
                    <div class="look-nline">
                        {slot('before')}
                        <span class={LOOK_SCOPE_CLASS}>
                            <Name named={props.view.named} selected={props.state === 'selected'} />
                        </span>
                        {slot('after')}
                    </div>
                </div>
                <Show when={pop()}>
                    {(side) => (
                        <PicturePop view={props.view} side={side()} onClose={() => setPop(null)} onChoose={choose} />
                    )}
                </Show>
                <Show when={moving()}>
                    <span class="look-still look-still-frame" title={t('With less motion')}>
                        <svg
                            class="look-ic"
                            style={{ width: '13px', height: '13px' }}
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                        >
                            <path d="M9 6v12M15 6v12" />
                        </svg>
                        <span class="look-still">
                            <Name named={props.view.named} />
                        </span>
                    </span>
                </Show>
            </div>
        </div>
    );
}

function NoteInput(props: { view: Open }) {
    const { client, t } = useUi();
    const note = () => props.view.placement.note?.value ?? '';
    return (
        <input
            class="look-notein"
            value={note()}
            placeholder={t('Note')}
            aria-label={`${t('Note above the name')}: ${props.view.named.text}`}
            onChange={(event) => {
                const next = event.currentTarget.value.trim();
                if (next === note()) return;
                void client.send('looks.setNote', {
                    level: { thing: props.view.thing },
                    note: next === '' ? null : next,
                });
            }}
            onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
            }}
        />
    );
}

function PicturePop(props: {
    view: Open;
    side: 'before' | 'after';
    onClose: () => void;
    onChoose: () => Promise<File | null>;
}) {
    const { client, t } = useUi();
    const [moved, setMoved] = createSignal<PictureCrop | null>(null);
    let box: HTMLDivElement | undefined;
    let frame: HTMLSpanElement | undefined;
    const crop = () => moved() ?? props.view.picture.crop;
    const thing = () => ({ thing: props.view.thing });
    const whole = () => props.view.picture.crop === null && props.view.picture.image === null;
    const url = () => props.view.picture.image ?? props.view.picture.own;
    onMount(() => {
        const pressed = (event: PointerEvent) => {
            if (box?.contains(event.target as Node) !== true) props.onClose();
        };
        document.addEventListener('pointerdown', pressed, true);
        onCleanup(() => document.removeEventListener('pointerdown', pressed, true));
    });
    const drag = (event: PointerEvent) => {
        const start = crop();
        const area = frame?.parentElement?.getBoundingClientRect();
        if (!start || !area) return;
        event.preventDefault();
        const from = { x: event.clientX, y: event.clientY };
        const clamp = (n: number, size: number) => Math.min(Math.max(n, 0), 1 - size);
        const move = (at: PointerEvent) =>
            setMoved({
                ...start,
                x: clamp(start.x + (at.clientX - from.x) / area.width, start.width),
                y: clamp(start.y + (at.clientY - from.y) / area.height, start.height),
            });
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            const done = moved();
            if (done) void client.send('looks.cropPicture', { ...thing(), crop: done }).then(() => setMoved(null));
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };
    return (
        <div class="look-hpop" role="dialog" aria-label={t('Small picture beside the name')} ref={(el) => (box = el)}>
            <span
                class="look-hbig"
                style={url() === null ? undefined : { 'background-image': `url("${url() ?? ''}")` }}
                aria-hidden="true"
            >
                <Show when={crop()}>
                    {(shown) => (
                        <span
                            ref={(el) => (frame = el)}
                            class="look-hframe"
                            style={{
                                left: `${shown().x * 100}%`,
                                top: `${shown().y * 100}%`,
                                width: `${shown().width * 100}%`,
                                height: `${shown().height * 100}%`,
                            }}
                            onPointerDown={drag}
                        />
                    )}
                </Show>
            </span>
            <div class="look-hopts">
                <button
                    type="button"
                    classList={{ 'look-on': whole() }}
                    onClick={() => void client.send('looks.useOwnPicture', thing())}
                >
                    {t('Whole picture')}
                </button>
                <button
                    type="button"
                    classList={{ 'look-on': props.view.picture.crop !== null }}
                    onClick={() => {
                        if (props.view.picture.crop === null)
                            void client.send('looks.cropPicture', { ...thing(), crop: DEFAULT_CROP });
                    }}
                >
                    {t('Crop')}
                </button>
                <button
                    type="button"
                    onClick={() =>
                        void (async () => {
                            const file = await props.onChoose();
                            if (file) await client.send('looks.uploadPicture', thing(), file);
                        })()
                    }
                >
                    {t('Another image…')}
                </button>
                <button
                    type="button"
                    class="look-danger"
                    onClick={() => {
                        props.onClose();
                        void client.send('looks.setPicture', {
                            level: thing(),
                            before: props.side === 'before' ? false : null,
                            after: props.side === 'after' ? false : null,
                        });
                    }}
                >
                    {t('Remove from here')}
                </button>
            </div>
        </div>
    );
}

function Uses(props: { view: Open }) {
    const { client, t } = useUi();
    const [adding, setAdding] = createSignal(false);
    let box: HTMLDivElement | undefined;
    const at = (world: string | null) => (world === null ? t('everywhere') : t('this world'));
    const offered = () => props.view.available.filter((item) => !props.view.uses.some((u) => u.id === item.id));
    onMount(() => {
        const pressed = (event: PointerEvent) => {
            if (adding() && box?.contains(event.target as Node) !== true) setAdding(false);
        };
        document.addEventListener('pointerdown', pressed, true);
        onCleanup(() => document.removeEventListener('pointerdown', pressed, true));
    });
    const makeNew = async (world: string | null) => {
        setAdding(false);
        const name = await ask({ kind: 'input', message: t('Name the shared look'), value: '' }, t);
        if (name === null) return;
        await client.send('looks.makeShared', { name, world, usedBy: props.view.thing });
    };
    return (
        <div class="look-uses" ref={(el) => (box = el)}>
            <span class="look-ul">{t('Uses')}</span>
            <For each={props.view.uses}>
                {(used) => (
                    <span class="look-uchip">
                        {used.name ?? t('A shared look that is gone')}
                        <span class="look-uat">{at(used.world)}</span>
                        <button
                            type="button"
                            class="look-ux"
                            aria-label={`${t('Stop using')} ${used.name ?? ''}`}
                            onClick={() =>
                                void client.send('looks.stopUsing', { thing: props.view.thing, shared: used.id })
                            }
                        >
                            ×
                        </button>
                    </span>
                )}
            </For>
            <button type="button" class="look-uadd" aria-expanded={adding()} onClick={() => setAdding(!adding())}>
                {t('+ shared look')}
            </button>
            <Show when={adding()}>
                <div class="look-upop" role="menu">
                    <For each={offered()}>
                        {(item) => (
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    setAdding(false);
                                    void client.send('looks.use', {
                                        thing: props.view.thing,
                                        shared: item.id,
                                        before: null,
                                    });
                                }}
                            >
                                {item.name}
                                <span class="look-uat">{at(item.world)}</span>
                            </button>
                        )}
                    </For>
                    <Show when={props.view.world}>
                        {(world) => (
                            <button
                                type="button"
                                role="menuitem"
                                class="look-unew"
                                onClick={() => void makeNew(world())}
                            >
                                {t('New shared look in this world…')}
                            </button>
                        )}
                    </Show>
                    <button type="button" role="menuitem" class="look-unew" onClick={() => void makeNew(null)}>
                        {t('New shared look for every world…')}
                    </button>
                </div>
            </Show>
        </div>
    );
}

// The effect's letter, drawn with the effect as the state shows it, or as it would be turned on.
export function glyphDeclarations(id: EffectId, layer: Layer): Declaration[] {
    const shown = readEffect(id, layer);
    const own = shown === null ? declareEffect(id, effects[id].start, new Map()) : declareEffect(id, shown, new Map());
    return id === 'color' ? own : [{ property: 'color', value: GLYPH_INK }, ...own];
}

function Tool(props: {
    id: EffectId;
    layer: Layer;
    families: ReadonlyMap<string, string>;
    open: boolean;
    onPick: () => void;
}) {
    const { t } = useUi();
    const on = () => readEffect(props.id, props.layer) !== null;
    const style = () => styleText(drawnDeclarations(glyphDeclarations(props.id, props.layer), props.families));
    return (
        <button
            type="button"
            class="look-tool"
            classList={{ 'look-on': on(), 'look-open': props.open }}
            aria-label={t(EFFECT_LABELS[props.id])}
            title={t(EFFECT_LABELS[props.id])}
            aria-expanded={props.open}
            onClick={() => props.onPick()}
        >
            <span class="look-glyph" style={style()}>
                {props.id === 'typeface' ? 'Aa' : 'A'}
            </span>
        </button>
    );
}

function Head(props: { title: string; state: LookState; children?: JSX.Element }) {
    const { t } = useUi();
    return (
        <div class="look-fxh">
            <span>
                {props.title}
                <span class="look-fst"> · {t(STATE_LABELS[props.state])}</span>
            </span>
            {props.children}
        </div>
    );
}

function Range(props: {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    onInput: (value: number) => void;
    onChange: (value: number) => void;
}) {
    return (
        <div class="look-ctl">
            <label>{props.label}</label>
            <input
                type="range"
                min={props.min}
                max={props.max}
                step={props.step}
                value={props.value}
                aria-label={props.label}
                onInput={(event) => props.onInput(Number(event.currentTarget.value))}
                onChange={(event) => props.onChange(Number(event.currentTarget.value))}
            />
        </div>
    );
}

function ColorInput(props: { label: string; value: string; fallback: string; onChange: (value: string) => void }) {
    return (
        <input
            type="color"
            value={hex(props.value, props.fallback)}
            aria-label={props.label}
            onChange={(event) => props.onChange(event.currentTarget.value)}
        />
    );
}

function EffectPanel(props: {
    id: EffectId;
    view: Open;
    state: LookState;
    layer: Layer;
    onPreview: <K extends EffectId>(id: K, next: Controls[K]) => void;
    onWrite: <K extends EffectId>(id: K, next: Controls[K]) => void;
}) {
    const { client, t } = useUi();
    const thingName = () => props.view.named.text;
    const at = () => supplierOf(props.id, props.state, props.view.shown[props.state], props.view.levels.length - 1);
    const controls = <K extends EffectId>(id: K): Controls[K] => readEffect(id, props.layer) ?? effects[id].start;
    const write = <K extends EffectId>(id: K, next: Controls[K]) => {
        props.onWrite(id, next);
    };
    const preview = <K extends EffectId>(id: K, next: Controls[K]) => {
        props.onPreview(id, next);
    };
    const moveTo = async (value: string) => {
        const from = props.view.levels[at()]?.level;
        if (!from) return;
        const properties = [...effects[props.id].properties].filter((p) =>
            props.view.shown[props.state].some((d) => d.property === p),
        );
        if (properties.length === 0) return;
        const what = { state: props.state, properties };
        if (value === '__new' || value === '__newuser') {
            const name = await ask({ kind: 'input', message: t('Name the shared look'), value: '' }, t);
            if (name === null) return;
            await client.send('looks.applyTo', {
                thing: props.view.thing,
                what,
                from,
                to: { newShared: { name, world: value === '__new' ? props.view.world : null } },
            });
            return;
        }
        const to = props.view.levels[Number(value)]?.level;
        if (to) await client.send('looks.applyTo', { thing: props.view.thing, what, from, to });
    };
    const reset = () => {
        const level = props.view.levels[at()]?.level;
        if (!level) return;
        const { set, reset } = withoutEffect(props.id, props.layer);
        void client.send('looks.setDeclarations', { level, state: props.state, set, reset });
    };
    return (
        <div class="look-fx">
            <Head title={t(EFFECT_LABELS[props.id])} state={props.state}>
                <select
                    class="look-scope"
                    value={String(at())}
                    aria-label={t('Applies to')}
                    onChange={(event) => void moveTo(event.currentTarget.value)}
                >
                    <For each={props.view.levels}>
                        {(item, i) => <option value={String(i())}>{levelLabel(item, thingName(), t)}</option>}
                    </For>
                    <Show when={props.view.world !== null}>
                        <option value="__new">{t('New shared look in this world…')}</option>
                    </Show>
                    <option value="__newuser">{t('New shared look for every world…')}</option>
                </select>
                <button type="button" class="look-rs2" onClick={reset}>
                    {t('Reset')}
                </button>
            </Head>
            <Switch>
                <Match when={props.id === 'color'}>
                    {(() => {
                        const c = () => controls('color');
                        const stops = () => {
                            const now = c();
                            return now.mode === 'gradient' ? now.stops : [now.color, now.color];
                        };
                        const angle = () => {
                            const now = c();
                            return now.mode === 'gradient' ? now.angle : 90;
                        };
                        const solid = () => c().mode === 'solid';
                        return (
                            <>
                                <div class="look-seg">
                                    <button
                                        type="button"
                                        classList={{ 'look-on': solid() }}
                                        onClick={() =>
                                            write('color', { mode: 'solid', color: stops()[0] ?? '#f6cf86' })
                                        }
                                    >
                                        {t('One color')}
                                    </button>
                                    <button
                                        type="button"
                                        classList={{ 'look-on': !solid() }}
                                        onClick={() =>
                                            write('color', {
                                                mode: 'gradient',
                                                angle: angle(),
                                                stops: solid() ? [stops()[0] ?? '#f6cf86', '#ec8f6f'] : stops(),
                                            })
                                        }
                                    >
                                        {t('Gradient')}
                                    </button>
                                </div>
                                <div class="look-ctl">
                                    <label>{solid() ? t('Color') : t('From, to')}</label>
                                    <ColorInput
                                        label={solid() ? t('Color') : t('From')}
                                        value={stops()[0] ?? ''}
                                        fallback="#f6cf86"
                                        onChange={(value) =>
                                            write(
                                                'color',
                                                solid()
                                                    ? { mode: 'solid', color: value }
                                                    : {
                                                          mode: 'gradient',
                                                          angle: angle(),
                                                          stops: [value, ...stops().slice(1)],
                                                      },
                                            )
                                        }
                                    />
                                    <Show when={!solid()}>
                                        <ColorInput
                                            label={t('To')}
                                            value={stops().at(-1) ?? ''}
                                            fallback="#ec8f6f"
                                            onChange={(value) =>
                                                write('color', {
                                                    mode: 'gradient',
                                                    angle: angle(),
                                                    stops: [...stops().slice(0, -1), value],
                                                })
                                            }
                                        />
                                    </Show>
                                </div>
                                <Show when={!solid()}>
                                    <Range
                                        label={t('Direction')}
                                        min={0}
                                        max={360}
                                        step={1}
                                        value={angle()}
                                        onInput={(value) =>
                                            preview('color', { mode: 'gradient', angle: value, stops: stops() })
                                        }
                                        onChange={(value) =>
                                            write('color', { mode: 'gradient', angle: value, stops: stops() })
                                        }
                                    />
                                </Show>
                            </>
                        );
                    })()}
                </Match>
                <Match when={props.id === 'glow'}>
                    <div class="look-ctl">
                        <label>{t('Color')}</label>
                        <ColorInput
                            label={t('Glow color')}
                            value={controls('glow').color}
                            fallback="#f0965a"
                            onChange={(color) => write('glow', { ...controls('glow'), color })}
                        />
                    </div>
                    <Range
                        label={t('Size')}
                        min={1}
                        max={20}
                        step={1}
                        value={controls('glow').size}
                        onInput={(size) => preview('glow', { ...controls('glow'), size })}
                        onChange={(size) => write('glow', { ...controls('glow'), size })}
                    />
                </Match>
                <Match when={props.id === 'outline'}>
                    <div class="look-ctl">
                        <label>{t('Color')}</label>
                        <ColorInput
                            label={t('Outline color')}
                            value={controls('outline').color}
                            fallback="#2a1208"
                            onChange={(color) => write('outline', { ...controls('outline'), color })}
                        />
                    </div>
                    <Range
                        label={t('Width')}
                        min={0.25}
                        max={3}
                        step={0.25}
                        value={controls('outline').width}
                        onInput={(width) => preview('outline', { ...controls('outline'), width })}
                        onChange={(width) => write('outline', { ...controls('outline'), width })}
                    />
                </Match>
                <Match when={props.id === 'shadow'}>
                    <div class="look-ctl">
                        <label>{t('Color')}</label>
                        <ColorInput
                            label={t('Shadow color')}
                            value={controls('shadow').color}
                            fallback="#000000"
                            onChange={(color) => write('shadow', { ...controls('shadow'), color })}
                        />
                    </div>
                    <Range
                        label={t('Distance')}
                        min={0}
                        max={8}
                        step={1}
                        value={controls('shadow').distance}
                        onInput={(distance) => preview('shadow', { ...controls('shadow'), distance })}
                        onChange={(distance) => write('shadow', { ...controls('shadow'), distance })}
                    />
                    <Range
                        label={t('Softness')}
                        min={0}
                        max={10}
                        step={1}
                        value={controls('shadow').softness}
                        onInput={(softness) => preview('shadow', { ...controls('shadow'), softness })}
                        onChange={(softness) => write('shadow', { ...controls('shadow'), softness })}
                    />
                </Match>
                <Match when={props.id === 'underline'}>
                    <div class="look-seg">
                        <For each={['solid', 'double', 'wavy'] as const}>
                            {(style) => (
                                <button
                                    type="button"
                                    classList={{ 'look-on': controls('underline').style === style }}
                                    onClick={() => write('underline', { ...controls('underline'), style })}
                                >
                                    {t(style === 'solid' ? 'Solid' : style === 'double' ? 'Double' : 'Wavy')}
                                </button>
                            )}
                        </For>
                    </div>
                    <div class="look-ctl">
                        <label>{t('Color')}</label>
                        <ColorInput
                            label={t('Underline color')}
                            value={controls('underline').color}
                            fallback="#ec8f6f"
                            onChange={(color) => write('underline', { ...controls('underline'), color })}
                        />
                    </div>
                    <Range
                        label={t('Thickness')}
                        min={1}
                        max={4}
                        step={0.5}
                        value={controls('underline').thickness}
                        onInput={(thickness) => preview('underline', { ...controls('underline'), thickness })}
                        onChange={(thickness) => write('underline', { ...controls('underline'), thickness })}
                    />
                </Match>
                <Match when={props.id === 'letters'}>
                    <Range
                        label={t('Spacing')}
                        min={-0.04}
                        max={0.3}
                        step={0.01}
                        value={controls('letters').spacing}
                        onInput={(spacing) => preview('letters', { ...controls('letters'), spacing })}
                        onChange={(spacing) => write('letters', { ...controls('letters'), spacing })}
                    />
                    <Range
                        label={t('Weight')}
                        min={300}
                        max={800}
                        step={100}
                        value={controls('letters').weight}
                        onInput={(weight) => preview('letters', { ...controls('letters'), weight })}
                        onChange={(weight) => write('letters', { ...controls('letters'), weight })}
                    />
                    <div class="look-seg">
                        <button
                            type="button"
                            classList={{ 'look-on': controls('letters').italic }}
                            aria-pressed={controls('letters').italic}
                            onClick={() =>
                                write('letters', { ...controls('letters'), italic: !controls('letters').italic })
                            }
                        >
                            {t('Italic')}
                        </button>
                        <button
                            type="button"
                            classList={{ 'look-on': controls('letters').caps }}
                            aria-pressed={controls('letters').caps}
                            onClick={() =>
                                write('letters', { ...controls('letters'), caps: !controls('letters').caps })
                            }
                        >
                            {t('Small capitals')}
                        </button>
                    </div>
                </Match>
                <Match when={props.id === 'typeface'}>
                    <Typefaces
                        view={props.view}
                        current={controls('typeface')}
                        onPick={(next) => write('typeface', next)}
                    />
                </Match>
                <Match when={props.id === 'blur'}>
                    <Range
                        label={t('Amount')}
                        min={0.2}
                        max={2}
                        step={0.1}
                        value={controls('blur').amount}
                        onInput={(amount) => preview('blur', { amount })}
                        onChange={(amount) => write('blur', { amount })}
                    />
                </Match>
                <Match when={props.id === 'motion'}>
                    <div class="look-tiles">
                        <For each={MOTIONS}>
                            {(motion) => (
                                <button
                                    type="button"
                                    class="look-tile"
                                    classList={{ 'look-on': controls('motion').motion === motion }}
                                    onClick={() => write('motion', { ...controls('motion'), motion })}
                                >
                                    <span class="look-tv">
                                        <span
                                            class="look-motion-sample"
                                            style={styleText(
                                                drawnDeclarations(
                                                    declareEffect(
                                                        'motion',
                                                        { motion, seconds: controls('motion').seconds },
                                                        new Map(),
                                                    ),
                                                    new Map(),
                                                ),
                                            )}
                                        >
                                            {props.view.named.text}
                                        </span>
                                    </span>
                                    <span class="look-tn">{t(MOTION_LABELS[motion])}</span>
                                </button>
                            )}
                        </For>
                    </div>
                    <Range
                        label={t('Speed')}
                        min={1}
                        max={10}
                        step={0.5}
                        value={11 - controls('motion').seconds}
                        onInput={(speed) => preview('motion', { ...controls('motion'), seconds: 11 - speed })}
                        onChange={(speed) => write('motion', { ...controls('motion'), seconds: 11 - speed })}
                    />
                </Match>
            </Switch>
        </div>
    );
}

function Typefaces(props: { view: Open; current: Controls['typeface']; onPick: (next: Controls['typeface']) => void }) {
    const { client, t } = useUi();
    const app = () => props.view.fonts.filter((f) => !f.uploaded);
    const uploaded = () => props.view.fonts.filter((f) => f.uploaded);
    const button = (font: Open['fonts'][number]) => (
        <button
            type="button"
            classList={{ 'look-on': props.current.font === font.id }}
            style={{ 'font-family': `"${font.family}"` }}
            onClick={() => props.onPick({ font: font.id, uploaded: font.uploaded })}
        >
            {font.name}
        </button>
    );
    const addFont = (world: string) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.woff2,.woff,.ttf,.otf';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) return;
            const name = file.name.replace(/\.[^.]+$/, '');
            void client.send('looks.uploadFont', { world, name }, file);
        });
        input.click();
    };
    return (
        <>
            <div class="look-fgrp">
                <span class="look-fgl">{t('The app’s')}</span>
                <div class="look-seg">
                    <For each={app()}>{button}</For>
                </div>
            </div>
            <Show when={props.view.world}>
                {(world) => (
                    <div class="look-fgrp">
                        <span class="look-fgl">{t('This world’s')}</span>
                        <div class="look-seg">
                            <For each={uploaded()}>{button}</For>
                            <button type="button" class="look-addf" onClick={() => addFont(world())}>
                                {t('Add a font…')}
                            </button>
                        </div>
                    </div>
                )}
            </Show>
        </>
    );
}

function CssPanel(props: { view: Open; state: LookState }) {
    const { client, t } = useUi();
    const own = () => props.view.own[props.state] ?? [];
    const controlled = () => own().filter((d) => CONTROLLED.has(d.property));
    const rest = () => own().filter((d) => !CONTROLLED.has(d.property));
    return (
        <div class="look-fx">
            <Head title="CSS" state={props.state}>
                <span class="look-fixed">
                    {levelLabel({ kind: 'thing', level: { thing: props.view.thing } }, props.view.named.text, t)}
                </span>
            </Head>
            <pre class="look-cssfx" aria-label={t('From the controls')}>
                {cssText(controlled())}
            </pre>
            <textarea
                class="look-cssta"
                spellcheck={false}
                aria-label={t('Other declarations')}
                value={cssText(rest())}
                onChange={(event) =>
                    void client.send('looks.writeCss', {
                        thing: props.view.thing,
                        state: props.state,
                        css: event.currentTarget.value,
                        replaces: rest().map((d) => d.property),
                        newAt: { thing: props.view.thing },
                    })
                }
            />
        </div>
    );
}

// A mark is never selected: the selected state edits the mark as the word pointed at shows it.
const markStateOf = (state: LookState): MarkState => (state === 'selected' ? 'wordPointed' : state);

function MarkPanel(props: { view: Open; state: LookState }) {
    const { client, t } = useUi();
    const markState = () => markStateOf(props.state);
    const shown = () => props.view.mark.shown[markState()];
    const set = (layer: Partial<{ style: MarkStyle | null; color: string | null; opacity: number | null }>) =>
        void client.send('looks.setMark', { change: { [markState()]: layer } });
    return (
        <div class="look-fx">
            <Head title={t('Mark on the words that brought it up')} state={props.state}>
                <span class="look-fixed">{t('Every world')}</span>
                <button type="button" class="look-rs2" onClick={() => set({ style: null, color: null, opacity: null })}>
                    {t('Reset')}
                </button>
            </Head>
            <div class="look-seg">
                <For each={MARK_STYLE_LABELS}>
                    {([style, label]) => (
                        <button
                            type="button"
                            classList={{ 'look-on': shown().style === style }}
                            onClick={() => set({ style })}
                        >
                            <span class={`look-mark-sample look-mark-${style}`}>{t(label)}</span>
                        </button>
                    )}
                </For>
            </div>
            <div class="look-ctl">
                <label>{t('Color')}</label>
                <ColorInput
                    label={t('Mark color')}
                    value={shown().color}
                    fallback="#e4e2dc"
                    onChange={(color) => set({ color })}
                />
            </div>
            <Range
                label={t('Opacity')}
                min={0.2}
                max={1}
                step={0.05}
                value={shown().opacity}
                onInput={() => undefined}
                onChange={(opacity) => set({ opacity })}
            />
        </div>
    );
}

const KIND_WORDS: Record<Open['kind'], string> = {
    entry: 'Entry',
    world: 'World',
    character: 'Character',
    persona: 'Persona',
    bookmark: 'Bookmark',
};

function Renders(props: { view: Open; markOpen: boolean; onMark: () => void }) {
    const { t } = useUi();
    const picture = () => pictureUrl(props.view);
    const where = () => {
        const world = props.view.levels.find((l) => l.kind === 'world');
        return props.view.kind === 'entry' && world?.kind === 'world' ? world.name : t(KIND_WORDS[props.view.kind]);
    };
    const time = new Date(2026, 0, 1, 21, 42).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const big = (class_: string) => (
        <span
            class={class_}
            style={picture() === null ? undefined : { 'background-image': `url("${picture() ?? ''}")` }}
            aria-hidden="true"
        />
    );
    return (
        <div class="look-ctx">
            <div class="look-cx">
                <span class="look-cxl">{t('In the chat')}</span>
                <div class={`look-chatl ${LOOK_SCOPE_CLASS}`}>
                    <span class="look-av" aria-hidden="true" />
                    <div>
                        {t('Then we go to')}{' '}
                        <span class={`${TRIGGER_MARK_CLASS} look-tm`}>
                            <Name named={props.view.named} picture={picture()} />
                        </span>
                        {t('. She still has my')}{' '}
                        <button
                            type="button"
                            class="look-mkbtn"
                            classList={{ 'look-open': props.markOpen }}
                            aria-label={t('The mark on words that brought an entry up')}
                            onClick={() => props.onMark()}
                        >
                            <span class={`${TRIGGER_MARK_CLASS} look-tm`}>{t('ledger')}</span>
                        </button>{' '}
                        {t('page.')}
                    </div>
                </div>
            </div>
            <div class="look-cx">
                <span class="look-cxl">{t('As a message’s name')}</span>
                <div class={`look-mline ${LOOK_SCOPE_CLASS}`}>
                    <Name named={props.view.named} picture={picture()} />
                    <span class="look-when">{time}</span>
                </div>
            </div>
            <div class="look-cx">
                <span class="look-cxl">{t('In a list')}</span>
                <div class={`look-orow ${LOOK_SCOPE_CLASS}`}>
                    {big('look-rpic')}
                    <Name named={props.view.named} />
                </div>
            </div>
            <div class="look-cx">
                <span class="look-cxl">{t('On a card')}</span>
                <div class={`look-card ${LOOK_SCOPE_CLASS}`}>
                    {big('look-cpic')}
                    <div>
                        <div class="look-ct">
                            <Name named={props.view.named} />
                        </div>
                        <div class="look-cp">{where()}</div>
                    </div>
                </div>
            </div>
        </div>
    );
}
