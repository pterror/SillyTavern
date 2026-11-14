import { For, Show } from 'solid-js';
import { useUi } from '@st/page/context';
import { Name } from '@st/page/name';
import type { AxesView, LastChangeView, OverviewView, RelationKind, ResultsView, OpenWorldView } from '../protocol.ts';
import { Axes } from './Axes.tsx';
import { hoverCards } from './HoverCard.tsx';
import type { AxesChange } from './Axes.tsx';
import { Picture } from './Cards.tsx';
import type { CardActions } from './Cards.tsx';
import { useWb } from './context.ts';
import { Editable } from './Editable.tsx';
import { Icon } from './icons.tsx';
import { TopLevel, drawnEntries } from './Overview.tsx';
import { Results } from './Search.tsx';
import { EntryRows, RowsHead } from './Rows.tsx';
import type { RowsContext } from './Rows.tsx';
import { count, fill } from './words.ts';

type Shown = OpenWorldView;

export function WorldPage(props: {
    world: Shown;
    overview: OverviewView | null;
    results: Extract<ResultsView, { book: string }> | null;
    kinds: RelationKind[];
    lastChange: LastChangeView | null;
    pane: HTMLElement;
    resultsPageSize: number;
    actions: CardActions;
    onGroupBy: (kind: string | null) => void;
    onMore: (from: number) => void;
    onMoreResults: (pages: number) => void;
    // Set when the world has saved views: the bar under the tabs, not the header, chooses the grouping.
    viewed: boolean;
    rows: RowsContext | null;
    // Set when the view draws a board or grid, which stands in for the world's header and its list.
    axes: Extract<AxesView, { book: string }> | null;
    onAxes: AxesChange;
}) {
    const { t } = useUi();
    const wb = useWb();
    const book = () => props.world.id;
    const ownBook = () => props.world.cameWith !== null;
    const groupBy = () => props.overview?.groupBy ?? null;
    const marked = () => props.lastChange?.markedTitleKeys?.book === book() && props.world.namesOffer === null;
    const hover = hoverCards();
    const actions: CardActions = {
        ...props.actions,
        hover: {
            enter: (entry, element) => hover.enter(book(), entry, element, 'card'),
            leave: hover.leave,
            hide: hover.hide,
        },
    };
    return (
        <div class="wb-front wb-hover-host">
            <hover.Drawn />
            <Show when={!props.rows && !props.axes}>
                <div class="wb-front-head">
                    <Show when={props.world.picture}>{(url) => <Picture url={url()} class="wb-front-pic" />}</Show>
                    <div class="wb-front-words">
                        <Show when={!ownBook()} fallback={<h1 class="wb-front-name">{props.world.name}</h1>}>
                            <Editable
                                class="wb-front-name"
                                label={t('World name')}
                                value={props.world.name}
                                onSave={(name) => void wb.act('worldbuilding.renameWorld', { book: book(), name })}
                            >
                                <h1 class="wb-front-name">{props.world.name}</h1>
                            </Editable>
                        </Show>
                        <div class="wb-front-meta">
                            <span>
                                {props.world.entries === 1
                                    ? t('1 entry')
                                    : fill(t('${0} entries'), count(props.world.entries))}
                                <Show when={props.world.cameWith}>
                                    {(character) => (
                                        <>
                                            {' · '}
                                            {t('Lorebook of')} <Name named={character()} />
                                        </>
                                    )}
                                </Show>
                                <Show when={props.kinds.length > 0 && !props.viewed}>
                                    {' · '}
                                    {t('Group by')}{' '}
                                    <select
                                        class="wb-select"
                                        aria-label={t('Group by')}
                                        value={groupBy() ?? ''}
                                        onChange={(event) =>
                                            props.onGroupBy(
                                                event.currentTarget.value === '' ? null : event.currentTarget.value,
                                            )
                                        }
                                    >
                                        <For each={props.kinds}>
                                            {(kind) => <option value={kind.id}>{kind.name}</option>}
                                        </For>
                                        <option value="">{t('None')}</option>
                                    </select>
                                </Show>
                            </span>
                            <Show when={props.world.usedInThisChat}>
                                <span class="wb-used">
                                    <Icon name="check" size={14} />
                                    {t('Used in this chat')}
                                </span>
                            </Show>
                        </div>
                    </div>
                </div>
                <Editable
                    class="wb-front-desc"
                    multiline
                    label={t('World description')}
                    value={props.world.description}
                    onSave={(description) =>
                        void wb.act('worldbuilding.setWorldDescription', { book: book(), description })
                    }
                >
                    <Show
                        when={props.world.description.trim() !== ''}
                        fallback={<span class="wb-ghost">{t('Add a description')}</span>}
                    >
                        {props.world.description}
                    </Show>
                </Editable>
            </Show>
            <Show when={props.world.namesOffer}>
                {(offer) => (
                    <div class="wb-offer">
                        <Show
                            when={offer().running === null}
                            fallback={
                                <p>
                                    {offer().running === 'marking'
                                        ? fill(t('Marking name keys… ${0} done'), count(offer().marked))
                                        : t('Undoing…')}
                                </p>
                            }
                        >
                            <p>
                                {fill(t('In ${0} entries, a key is the title'), count(offer().entries))}
                                <Show when={offer().example}>
                                    {(example) => (
                                        <>
                                            {t(', e.g. ')}
                                            <b>{example().text}</b>
                                        </>
                                    )}
                                </Show>
                                .
                            </p>
                            <div class="wb-offer-acts">
                                <button
                                    type="button"
                                    class="menu_button menu_button_icon margin0 whitespacenowrap wb-btn"
                                    onClick={() => void wb.act('worldbuilding.markTitleKeysAsNames', { book: book() })}
                                >
                                    {t('Mark as name keys')}
                                </button>
                                <button
                                    type="button"
                                    class="menu_button menu_button_icon margin0 whitespacenowrap wb-btn"
                                    onClick={() => void wb.act('worldbuilding.declineNamesOffer', { book: book() })}
                                >
                                    {t('Dismiss')}
                                </button>
                            </div>
                        </Show>
                    </div>
                )}
            </Show>
            <Show when={marked()}>
                <div class="wb-offer">
                    <p>{t('Marked as name keys.')}</p>
                    <div class="wb-offer-acts">
                        <button
                            type="button"
                            class="menu_button menu_button_icon margin0 whitespacenowrap wb-btn"
                            onClick={() => void wb.act('worldbuilding.undoMarkTitleKeysAsNames', { book: book() })}
                        >
                            {t('Undo')}
                        </button>
                    </div>
                </div>
            </Show>
            <Show when={props.rows}>
                {(rows) => <RowsHead fields={rows().fields} selection={rows().selection} book={book()} />}
            </Show>
            <Show
                when={props.axes}
                fallback={
                    <>
                        <Show
                            when={props.results}
                            fallback={
                                <Show when={props.overview}>
                                    {(overview) => (
                                        <TopLevel
                                            view={overview()}
                                            pane={props.pane}
                                            actions={actions}
                                            onMore={props.onMore}
                                            {...(props.rows
                                                ? {
                                                      rows: (cell) => (
                                                          <EntryRows
                                                              cell={cell}
                                                              depth={0}
                                                              context={props.rows as RowsContext}
                                                          />
                                                      ),
                                                  }
                                                : {})}
                                        />
                                    )}
                                </Show>
                            }
                        >
                            {(results) => (
                                <Results
                                    view={results()}
                                    pageSize={props.resultsPageSize}
                                    actions={actions}
                                    onMore={props.onMoreResults}
                                    rows={props.rows}
                                />
                            )}
                        </Show>
                    </>
                }
            >
                {(axes) => <Axes axes={axes()} onChange={props.onAxes} hover={actions.hover} />}
            </Show>
            <Show
                when={
                    props.rows &&
                    !props.results &&
                    props.overview &&
                    drawnEntries(props.overview).length < props.overview.topLevelCount
                }
            >
                <div class="wb-tr wb-loadrow">
                    <span />
                    <span class="wb-dim">{t('Loading…')}</span>
                </div>
            </Show>
        </div>
    );
}
