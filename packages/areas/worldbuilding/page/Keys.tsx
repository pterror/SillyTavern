import { For, Show, createSignal, onMount } from 'solid-js';
import { useUi } from '@st/page/context';
import { Name } from '@st/page/name';
import { KEY_SHARERS_VIEW } from '../protocol.ts';
import type { KeyOfEntry, KeySharersView, OpenEntryView } from '../protocol.ts';
import { useWb } from './context.ts';
import { dismissOn } from './dismiss.ts';
import { shownView } from './views.ts';
import { count, fill } from './words.ts';

const POPOVER_LEFT_AT_MOST = 340;

export function Keys(props: { entry: OpenEntryView }) {
    const { t } = useUi();
    const wb = useWb();
    const [open, setOpen] = createSignal<{ key: string; left: number; chip: HTMLElement } | null>(null);
    const [adding, setAdding] = createSignal<'name' | 'trigger' | null>(null);
    const at = () => ({ book: props.entry.book, entry: props.entry.entry });
    const pick = (key: KeyOfEntry, chip: HTMLElement) => {
        if (open()?.key === key.text) {
            setOpen(null);
            return;
        }
        setAdding(null);
        setOpen({ key: key.text, left: Math.min(chip.offsetLeft, POPOVER_LEFT_AT_MOST), chip });
        if (key.alsoBringsUp > 0) void wb.act('worldbuilding.showKeySharers', { ...at(), key: key.text });
    };
    const shownKey = () => props.entry.keys.find((key) => key.text === open()?.key) ?? null;
    return (
        <div class="wb-keys">
            <span class="wb-keys-label">{t('Keys')}</span>
            <Show when={props.entry.placement.constant && !props.entry.placement.disable}>
                <span class="wb-always">
                    {props.entry.tokens === null
                        ? t('Constant')
                        : fill(t('Constant · ${0} tokens'), count(props.entry.tokens))}
                </span>
            </Show>
            <For each={props.entry.keys}>
                {(key) => (
                    <button
                        type="button"
                        class="tag wb-key"
                        classList={{ 'wb-open': open()?.key === key.text }}
                        aria-expanded={open()?.key === key.text}
                        aria-label={fill(key.isName ? t('“${0}”, name') : t('“${0}”, key'), key.text)}
                        onClick={(event) => pick(key, event.currentTarget)}
                    >
                        <Show when={key.isName} fallback={<span class="wb-key-trigger">{key.text}</span>}>
                            <Name named={{ thing: props.entry.entry, text: key.text, shownAs: 'name' }} />
                        </Show>
                        <Show when={key.alsoBringsUp > 0}>
                            <span class="wb-key-more">{fill(t('· ${0} entries'), count(key.alsoBringsUp + 1))}</span>
                        </Show>
                    </button>
                )}
            </For>
            <Show
                when={adding()}
                fallback={
                    <>
                        <button
                            type="button"
                            class="menu_button margin0 whitespacenowrap wb-key-add"
                            onClick={() => {
                                setOpen(null);
                                setAdding('name');
                            }}
                        >
                            {t('+ Name')}
                        </button>
                        <button
                            type="button"
                            class="menu_button margin0 whitespacenowrap wb-key-add"
                            onClick={() => {
                                setOpen(null);
                                setAdding('trigger');
                            }}
                        >
                            {t('+ Key')}
                        </button>
                    </>
                }
            >
                {(as) => (
                    <NewKey
                        label={as() === 'name' ? t('Name') : t('Key')}
                        onDone={(key) => {
                            const kind = as();
                            setAdding(null);
                            if (key !== null) void wb.act('worldbuilding.addKeys', { ...at(), keys: [key], as: kind });
                        }}
                    />
                )}
            </Show>
            <Show when={open() && shownKey()}>
                {(key) => (
                    <KeyPopover
                        entry={props.entry}
                        shownKey={key()}
                        left={open()?.left ?? 0}
                        chip={() => open()?.chip}
                        onClose={() => setOpen(null)}
                    />
                )}
            </Show>
        </div>
    );
}

function NewKey(props: { label: string; onDone: (key: string | null) => void }) {
    let field: HTMLInputElement | undefined;
    let finished = false;
    const finish = (value: string | null) => {
        if (finished) return;
        finished = true;
        props.onDone(value === null || value.trim() === '' ? null : value.trim());
    };
    onMount(() => field?.focus());
    return (
        <input
            ref={(element) => (field = element)}
            class="text_pole margin0 wb-key-field"
            aria-label={props.label}
            placeholder={props.label}
            on:keydown={(event) => {
                if (event.key === 'Enter') finish((event.currentTarget as HTMLInputElement).value);
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                finish(null);
            }}
            onBlur={(event) => finish(event.currentTarget.value)}
        />
    );
}

function KeyPopover(props: {
    entry: OpenEntryView;
    shownKey: KeyOfEntry;
    left: number;
    chip: () => HTMLElement | undefined;
    onClose: () => void;
}) {
    const { client, t } = useUi();
    const wb = useWb();
    const sharers = shownView<KeySharersView>(client, KEY_SHARERS_VIEW);
    let box: HTMLDivElement | undefined;
    dismissOn(() => box, props.onClose, props.chip);
    const at = () => ({ book: props.entry.book, entry: props.entry.entry, key: props.shownKey.text });
    const setAs = (as: 'name' | 'trigger') => {
        if (props.shownKey.isName === (as === 'name')) return;
        void wb.act('worldbuilding.setKeyAs', { ...at(), as });
    };
    const others = () => {
        const shown = sharers();
        if (!shown || shown.book === null || shown.key !== props.shownKey.text || shown.entry !== props.entry.entry)
            return null;
        return shown;
    };
    return (
        <div
            class="wb-pop"
            style={{ left: `${props.left}px` }}
            role="dialog"
            aria-label={fill(t('Key “${0}”'), props.shownKey.text)}
            ref={(element) => (box = element)}
        >
            <div class="wb-pop-head">“{props.shownKey.text}”</div>
            <button
                type="button"
                class="list-group-item wb-opt"
                classList={{ 'wb-on': props.shownKey.isName }}
                aria-pressed={props.shownKey.isName}
                onClick={() => setAs('name')}
            >
                <b>{t('Name')}</b>
            </button>
            <button
                type="button"
                class="list-group-item wb-opt"
                classList={{ 'wb-on': !props.shownKey.isName }}
                aria-pressed={!props.shownKey.isName}
                onClick={() => setAs('trigger')}
            >
                <b>{t('Key')}</b>
            </button>
            <Show when={props.shownKey.alsoBringsUp > 0 && others()}>
                {(shown) => (
                    <div class="wb-pop-shared">
                        {t('Also activates ')}
                        <For each={shown().entries}>
                            {(other, n) => (
                                <>
                                    {n() > 0 ? ', ' : ''}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            props.onClose();
                                            wb.open(other.thing);
                                        }}
                                    >
                                        {other.text}
                                    </button>
                                </>
                            )}
                        </For>
                        <Show when={shown().more}>{t(' and more')}</Show>
                    </div>
                )}
            </Show>
            <button
                type="button"
                class="list-group-item wb-pop-remove"
                onClick={() => {
                    const key = at();
                    props.onClose();
                    void wb.act('worldbuilding.removeKey', key);
                }}
            >
                {t('Remove')}
            </button>
        </div>
    );
}
