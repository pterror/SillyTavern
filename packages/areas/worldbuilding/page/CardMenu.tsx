import { Show, createSignal } from 'solid-js';
import { useUi } from '@st/page/context';
import { LOOP_CHECK_VISITS_PER_WRITE } from '../protocol.ts';
import type { Named } from '../protocol.ts';
import { useWb } from './context.ts';
import { dismissOn } from './dismiss.ts';
import { Icon } from './icons.tsx';
import { TargetPicker } from './Picker.tsx';
import { fill } from './words.ts';

// The relation kind a list of cards is grouped by, in the world it shows.
export type Grouping = { book: string; kind: string; kindName: string };

// The region a card is drawn in: the entry its relation of the grouping kind targets; null at the top of a list.
export type Membership = { entry: string; label: Named } | null;

type Picking = 'move' | 'also' | null;

export function CardMenuButton(props: {
    entry: string;
    label: Named;
    grouping: Grouping;
    region: Membership;
    open: boolean;
    onOpen: (open: boolean) => void;
}) {
    const { t } = useUi();
    let button: HTMLButtonElement | undefined;
    return (
        <>
            <button
                ref={(element) => (button = element)}
                type="button"
                class="wb-card-more"
                classList={{ 'wb-on': props.open }}
                aria-label={fill(t('More for ${0}'), props.label.text)}
                title={t('Move, also put in, take out')}
                aria-expanded={props.open}
                onClick={() => props.onOpen(!props.open)}
            >
                <Icon name="more" size={16} />
            </button>
            <Show when={props.open}>
                <CardMenu
                    entry={props.entry}
                    label={props.label}
                    grouping={props.grouping}
                    region={props.region}
                    opener={() => button}
                    onClose={() => props.onOpen(false)}
                />
            </Show>
        </>
    );
}

function CardMenu(props: {
    entry: string;
    label: Named;
    grouping: Grouping;
    region: Membership;
    opener: () => HTMLElement | undefined;
    onClose: () => void;
}) {
    const { t } = useUi();
    const wb = useWb();
    const [picking, setPicking] = createSignal<Picking>(null);
    let box: HTMLDivElement | undefined;
    dismissOn(() => box, props.onClose, props.opener);
    const relation = () => ({ book: props.grouping.book, entry: props.entry, kind: props.grouping.kind });
    const run = (action: () => Promise<unknown>) => {
        const started = action();
        props.onClose();
        void started;
    };
    const pick = (target: string) => {
        move(target, props.region, picking());
    };
    const move = (target: string, region: Membership, how: Picking) => {
        run(() =>
            how === 'move' && region !== null
                ? wb.act('worldbuilding.moveRelation', {
                      ...relation(),
                      target: region.entry,
                      newTarget: target,
                      after: null,
                      before: null,
                      loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
                  })
                : wb.act('worldbuilding.addRelation', {
                      ...relation(),
                      target,
                      after: null,
                      before: null,
                      weak: false,
                      loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
                  }),
        );
    };
    return (
        <div class="wb-card-menu-box" ref={(element) => (box = element)}>
            <div class="wb-menu wb-card-menu" role="menu">
                <button
                    type="button"
                    role="menuitem"
                    classList={{ 'wb-on': picking() === 'move' }}
                    onClick={() => setPicking('move')}
                >
                    {t('Move to…')}
                </button>
                <Show when={props.region}>
                    {(region) => (
                        <>
                            <button
                                type="button"
                                role="menuitem"
                                classList={{ 'wb-on': picking() === 'also' }}
                                onClick={() => setPicking('also')}
                            >
                                {t('Also put in…')}
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() =>
                                    run(() =>
                                        wb.act('worldbuilding.removeRelation', {
                                            ...relation(),
                                            target: region().entry,
                                            loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
                                        }),
                                    )
                                }
                            >
                                {fill(t('Take out of ${0}'), region().label.text)}
                            </button>
                        </>
                    )}
                </Show>
            </div>
            <Show when={picking()} keyed>
                {(how) => (
                    <TargetPicker
                        class="wb-card-pick"
                        heading={fill(how === 'move' ? t('Move ${0} to') : t('Also put ${0} in'), props.label.text)}
                        book={props.grouping.book}
                        kind={props.grouping.kind}
                        leaveOut={[props.entry, ...(props.region ? [props.region.entry] : [])]}
                        onPick={pick}
                    />
                )}
            </Show>
        </div>
    );
}
