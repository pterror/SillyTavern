import { For, Show, createSignal } from 'solid-js';
import { useUi } from '@st/page/context';
import type { EntryFacts, Placement } from '../protocol.ts';
import { useWb } from './context.ts';
import { dismissOn } from './dismiss.ts';
import { fill } from './words.ts';

export const statusOf = (placement: Pick<Placement, 'disable' | 'constant' | 'vectorized'>): EntryFacts['comesIn'] =>
    placement.disable ? 'never' : placement.constant ? 'always' : placement.vectorized ? 'found' : 'broughtUp';

const STATUSES: { value: EntryFacts['comesIn']; label: string; description: string }[] = [
    { value: 'broughtUp', label: 'Keyword', description: 'Activated by matching keys' },
    { value: 'always', label: 'Constant', description: 'Always included' },
    { value: 'found', label: 'Vectorized', description: 'Activated by vector search' },
    { value: 'never', label: 'Disabled', description: 'Never included' },
];

export function StatusDot(props: { status: EntryFacts['comesIn'] }) {
    const { t } = useUi();
    const label = () => STATUSES.find((status) => status.value === props.status);
    const words = () => `${t(label()?.label ?? '')}: ${t(label()?.description ?? '')}`;
    return <span class={`wb-status-dot wb-status-${props.status}`} role="img" aria-label={words()} title={words()} />;
}

export function StatusLegend() {
    const { t } = useUi();
    return (
        <div class="wb-status-legend" aria-label={t('Entry status legend')}>
            <For each={STATUSES}>
                {(status) => (
                    <span title={t(status.description)}>
                        <StatusDot status={status.value} />
                        {t(status.label)}
                    </span>
                )}
            </For>
        </div>
    );
}

const statusChange = (status: EntryFacts['comesIn']): Partial<Placement> =>
    status === 'never'
        ? { disable: true }
        : { disable: false, constant: status === 'always', vectorized: status === 'found' };

export function StatusControl(props: { book: string; entry: string; name: string; facts: EntryFacts }) {
    const { t } = useUi();
    const wb = useWb();
    const [open, setOpen] = createSignal(false);
    let opener: HTMLButtonElement | undefined;
    const close = () => setOpen(false);
    function Picker() {
        let box: HTMLDivElement | undefined;
        dismissOn(
            () => box,
            close,
            () => opener,
        );
        return (
            <div
                ref={(element) => (box = element)}
                class="wb-status-picker"
                role="dialog"
                aria-label={t('Entry status')}
            >
                <For each={STATUSES}>
                    {(status) => (
                        <button
                            type="button"
                            class="wb-status-option"
                            aria-pressed={props.facts.comesIn === status.value ? 'true' : 'false'}
                            onClick={(event) => {
                                event.stopPropagation();
                                close();
                                opener?.focus();
                                if (props.facts.comesIn === status.value) return;
                                void wb.edit('worldbuilding.setPlacement', {
                                    book: props.book,
                                    entry: props.entry,
                                    version: props.facts.version,
                                    fields: statusChange(status.value),
                                });
                            }}
                        >
                            <StatusDot status={status.value} />
                            <span>
                                <b>{t(status.label)}</b>
                                <small>{t(status.description)}</small>
                            </span>
                        </button>
                    )}
                </For>
            </div>
        );
    }
    return (
        <>
            <button
                ref={(element) => (opener = element)}
                type="button"
                class="wb-status-control"
                aria-label={fill(t('Change status of ${0}'), props.name)}
                aria-haspopup="dialog"
                aria-expanded={open() ? 'true' : 'false'}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation();
                    setOpen(!open());
                }}
            >
                <StatusDot status={props.facts.comesIn} />
            </button>
            <Show when={open()}>
                <Picker />
            </Show>
        </>
    );
}
