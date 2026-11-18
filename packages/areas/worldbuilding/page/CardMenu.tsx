import { Show, createSignal } from 'solid-js';
import { useUi } from '@st/page/context';
import { LOOP_CHECK_VISITS_PER_WRITE } from '../protocol.ts';
import type { Named } from '../protocol.ts';
import { useWb } from './context.ts';
import { dismissOn } from './dismiss.ts';
import { Icon } from './icons.tsx';
import { TargetPicker } from './Picker.tsx';
import { WorldChoice } from './WorldChoice.tsx';
import { fill } from './words.ts';

// The relation kind a list of cards is grouped by, in the world it shows.
export type Grouping = { book: string; kind: string; kindName: string };

// The region a card is drawn in: the entry its relation of the grouping kind targets; null at the top of a list.
export type Membership = { entry: string; label: Named } | null;

type Picking = 'move' | 'also' | 'copyToWorld' | 'moveToWorld' | null;

export function CardMenuButton(props: {
    entry: string;
    label: Named;
    book: string;
    grouping: Grouping | null;
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
                class={['right_menu_button interactable wb-card-more', { 'wb-on': props.open }]}
                aria-label={fill(t('More for ${0}'), props.label.text)}
                title={t('More')}
                aria-expanded={props.open ? 'true' : 'false'}
                onClick={() => props.onOpen(!props.open)}
            >
                <Icon name="more" size={16} />
            </button>
            <Show when={props.open}>
                <CardMenu
                    entry={props.entry}
                    label={props.label}
                    book={props.book}
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
    book: string;
    grouping: Grouping | null;
    region: Membership;
    opener: () => HTMLElement | undefined;
    onClose: () => void;
}) {
    const { t } = useUi();
    const wb = useWb();
    const [picking, setPicking] = createSignal<Picking>(null);
    let box: HTMLDivElement | undefined;
    dismissOn(() => box, props.onClose, props.opener, { align: 'end', framed: false });
    const relation = (grouping: Grouping) => ({ book: grouping.book, entry: props.entry, kind: grouping.kind });
    const run = (action: () => Promise<unknown>) => {
        const started = action();
        props.onClose();
        void started;
    };
    const pick = (grouping: Grouping, target: string) => {
        move(grouping, target, props.region, picking());
    };
    const move = (grouping: Grouping, target: string, region: Membership, how: Picking) => {
        run(() =>
            how === 'move' && region !== null
                ? wb.act('worldbuilding.moveRelation', {
                      ...relation(grouping),
                      target: region.entry,
                      newTarget: target,
                      after: null,
                      before: null,
                      loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
                  })
                : wb.act('worldbuilding.addRelation', {
                      ...relation(grouping),
                      target,
                      after: null,
                      before: null,
                      weak: false,
                      loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
                  }),
        );
    };
    const at = () => ({ book: props.book, entry: props.entry });
    return (
        <div class="wb-card-menu-box" ref={(element) => (box = element)}>
            <div class="wb-menu list-group st-floating wb-card-menu" role="menu">
                <Show when={props.grouping}>
                    {(grouping) => (
                        <>
                            <button
                                class={['list-group-item', { 'wb-on': picking() === 'move' }]}
                                type="button"
                                role="menuitem"
                                onClick={() => setPicking('move')}
                            >
                                {t('Move to…')}
                            </button>
                            <Show when={props.region}>
                                {(region) => (
                                    <>
                                        <button
                                            class={['list-group-item', { 'wb-on': picking() === 'also' }]}
                                            type="button"
                                            role="menuitem"
                                            onClick={() => setPicking('also')}
                                        >
                                            {t('Add to…')}
                                        </button>
                                        <button
                                            class="list-group-item"
                                            type="button"
                                            role="menuitem"
                                            onClick={() =>
                                                run(() =>
                                                    wb.act('worldbuilding.removeRelation', {
                                                        ...relation(grouping()),
                                                        target: region().entry,
                                                        loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
                                                    }),
                                                )
                                            }
                                        >
                                            {fill(t('Remove from ${0}'), region().label.text)}
                                        </button>
                                    </>
                                )}
                            </Show>
                            <hr />
                        </>
                    )}
                </Show>
                <button
                    class="list-group-item"
                    type="button"
                    role="menuitem"
                    onClick={() =>
                        run(() =>
                            wb.act('worldbuilding.duplicateEntry', {
                                ...at(),
                                loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
                            }),
                        )
                    }
                >
                    {t('Duplicate')}
                </button>
                <button
                    class={['list-group-item', { 'wb-on': picking() === 'copyToWorld' }]}
                    type="button"
                    role="menuitem"
                    onClick={() => setPicking('copyToWorld')}
                >
                    {t('Copy to world…')}
                </button>
                <button
                    class={['list-group-item', { 'wb-on': picking() === 'moveToWorld' }]}
                    type="button"
                    role="menuitem"
                    onClick={() => setPicking('moveToWorld')}
                >
                    {t('Move to world…')}
                </button>
            </div>
            <Show when={picking() === 'copyToWorld' || picking() === 'moveToWorld' ? picking() : null} keyed>
                {(how) => (
                    <div class="wb-menu list-group st-floating wb-card-pick" role="menu">
                        <WorldChoice
                            heading={fill(
                                how === 'moveToWorld' ? t('Move ${0} to') : t('Copy ${0} to'),
                                props.label.text,
                            )}
                            from={props.book}
                            onPick={(toBook) =>
                                run(() =>
                                    wb.act(
                                        how === 'moveToWorld'
                                            ? 'worldbuilding.moveEntryToWorld'
                                            : 'worldbuilding.copyEntryToWorld',
                                        { ...at(), toBook },
                                    ),
                                )
                            }
                        />
                    </div>
                )}
            </Show>
            <Show when={props.grouping && (picking() === 'move' || picking() === 'also') ? props.grouping : null} keyed>
                {(grouping) => (
                    <TargetPicker
                        class="wb-card-pick st-floating"
                        heading={fill(picking() === 'move' ? t('Move ${0} to') : t('Add ${0} to'), props.label.text)}
                        book={grouping.book}
                        kind={grouping.kind}
                        leaveOut={[props.entry, ...(props.region ? [props.region.entry] : [])]}
                        onPick={(target) => pick(grouping, target)}
                    />
                )}
            </Show>
        </div>
    );
}
