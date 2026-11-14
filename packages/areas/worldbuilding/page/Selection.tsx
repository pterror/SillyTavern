import { Show, createSignal } from 'solid-js';
import { useUi } from '@st/page/context';
import { LOOP_CHECK_VISITS_PER_WRITE } from '../protocol.ts';
import { useWb } from './context.ts';
import { float } from '@st/page/popover';
import { TargetPicker } from './Picker.tsx';
import { fill } from './words.ts';

export type Selected = { words: string; left: number; top: number; bottom: number; right: number };

const MENU_WIDTH_PX = 300;

// The words a selection holds as a key would be written: white space runs as one space, none around them.
export const wordsOf = (text: string): string => text.replace(/\s+/gu, ' ').trim();

export function SelectionMenu(props: {
    selected: Selected;
    book: string;
    entry: string;
    kind: string | null;
    onClose: () => void;
}) {
    const { t } = useUi();
    const wb = useWb();
    const [adding, setAdding] = createSignal<'name' | 'trigger' | null>(null);
    let box: HTMLDivElement | undefined;
    const middle = () => (props.selected.left + props.selected.right) / 2 - MENU_WIDTH_PX / 2;
    float(() => box, {
        anchor: () => ({
            getBoundingClientRect: () => ({
                left: middle(),
                right: middle(),
                top: props.selected.top,
                bottom: props.selected.bottom,
            }),
        }),
        close: props.onClose,
        framed: false,
    });
    const run = (action: () => Promise<unknown>) => {
        const started = action();
        props.onClose();
        void started;
    };
    return (
        <div class="wb-selmenu" style={{ width: `${MENU_WIDTH_PX}px` }} ref={(element) => (box = element)}>
            <Show
                when={adding()}
                keyed
                fallback={
                    <div
                        class="wb-menu list-group st-floating wb-selmenu-items"
                        role="menu"
                        aria-label={t('Selected text')}
                    >
                        <button
                            type="button"
                            role="menuitem"
                            class="list-group-item wb-prim"
                            onClick={() =>
                                run(() =>
                                    wb.act('worldbuilding.createEntry', {
                                        book: props.book,
                                        after: props.entry,
                                        name: props.selected.words,
                                        relation: null,
                                        open: null,
                                        loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
                                    }),
                                )
                            }
                        >
                            {fill(t('New entry “${0}”'), props.selected.words)}
                        </button>
                        <button class="list-group-item" type="button" role="menuitem" onClick={() => setAdding('name')}>
                            {t('Add as name key to…')}
                        </button>
                        <button
                            class="list-group-item"
                            type="button"
                            role="menuitem"
                            onClick={() => setAdding('trigger')}
                        >
                            {t('Add as key to…')}
                        </button>
                    </div>
                }
            >
                {(as) => (
                    <TargetPicker
                        class="wb-selmenu-pick st-floating"
                        heading={fill(
                            as === 'name' ? t('Add “${0}” as name key to') : t('Add “${0}” as key to'),
                            props.selected.words,
                        )}
                        book={props.book}
                        kind={props.kind}
                        leaveOut={[]}
                        onPick={(target) =>
                            run(() =>
                                wb.edit('worldbuilding.addKeys', {
                                    book: props.book,
                                    entry: target,
                                    version: null,
                                    keys: [props.selected.words],
                                    as,
                                }),
                            )
                        }
                    />
                )}
            </Show>
        </div>
    );
}
