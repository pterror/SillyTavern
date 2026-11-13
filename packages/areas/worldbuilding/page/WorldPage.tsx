import { For, Show } from 'solid-js';
import { useUi } from '@st/page/context';
import { Name } from '@st/page/name';
import type { LastChangeView, OverviewView, RelationKind, ResultsView, WorldView } from '../protocol.ts';
import { Picture } from './Cards.tsx';
import type { CardActions } from './Cards.tsx';
import { useWb } from './context.ts';
import { Editable } from './Editable.tsx';
import { Icon } from './icons.tsx';
import { TopLevel } from './Overview.tsx';
import type { Range } from './Overview.tsx';
import { Results } from './Search.tsx';
import { EntryRows, ROW_HEIGHT, RowsHead } from './Rows.tsx';
import type { RowsContext } from './Rows.tsx';
import { count, fill } from './words.ts';

type Shown = Extract<WorldView, { id: string }>;

export function WorldPage(props: {
    world: Shown;
    overview: OverviewView | null;
    results: Extract<ResultsView, { book: string }> | null;
    kinds: RelationKind[];
    lastChange: LastChangeView | null;
    pane: HTMLElement;
    shown: number;
    columns: number;
    resultsPageSize: number;
    actions: CardActions;
    onGroupBy: (kind: string | null) => void;
    onRange: (range: Range) => void;
    onMoreResults: (pages: number) => void;
    // Set when the world has saved views: the bar under the tabs, not the header, chooses the grouping.
    viewed: boolean;
    rows: RowsContext | null;
}) {
    const { t } = useUi();
    const wb = useWb();
    const book = () => props.world.id;
    const ownBook = () => props.world.cameWith !== null;
    const groupBy = () => props.overview?.groupBy ?? null;
    const deleted = () => {
        const gone = props.lastChange?.deletedEntry;
        return gone && gone.book === book() ? gone : null;
    };
    const marked = () => props.lastChange?.markedTitleKeys?.book === book() && props.world.namesOffer === null;
    return (
        <div class="wb-front">
            <Show when={!props.rows}>
                <div class="wb-front-head">
                    <Show when={props.world.picture}>{(url) => <Picture url={url()} class="wb-front-pic" />}</Show>
                    <div class="wb-front-words">
                        <Show when={!ownBook()} fallback={<h1 class="wb-front-name">{props.world.name}</h1>}>
                            <Editable
                                class="wb-front-name"
                                label={t('The world’s name')}
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
                                            {t('came with the character')} <Name named={character()} />
                                        </>
                                    )}
                                </Show>
                                <Show when={props.kinds.length > 0 && !props.viewed}>
                                    {' · '}
                                    {t('Grouped by')}{' '}
                                    <select
                                        class="wb-select"
                                        aria-label={t('Grouped by')}
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
                                        <option value="">{t('nothing')}</option>
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
                    label={t('The world’s description')}
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
                                        ? fill(t('Marking names… ${0} done.'), count(offer().marked))
                                        : t('Taking the names back…')}
                                </p>
                            }
                        >
                            <p>
                                {fill(
                                    t('No names marked. In ${0} entries a key is the entry’s title'),
                                    count(offer().entries),
                                )}
                                <Show when={offer().example}>
                                    {(example) => (
                                        <>
                                            {t(', like ')}
                                            <b>{example().text}</b>
                                        </>
                                    )}
                                </Show>
                                .
                            </p>
                            <div class="wb-offer-acts">
                                <button
                                    type="button"
                                    class="wb-btn wb-btn-main"
                                    onClick={() => void wb.act('worldbuilding.markTitleKeysAsNames', { book: book() })}
                                >
                                    {t('Mark those keys as names')}
                                </button>
                                <button
                                    type="button"
                                    class="wb-btn"
                                    onClick={() => void wb.act('worldbuilding.declineNamesOffer', { book: book() })}
                                >
                                    {t('Leave it')}
                                </button>
                            </div>
                        </Show>
                    </div>
                )}
            </Show>
            <Show when={marked()}>
                <div class="wb-offer">
                    <p>{t('Those keys are marked as names.')}</p>
                    <div class="wb-offer-acts">
                        <button
                            type="button"
                            class="wb-btn"
                            onClick={() => void wb.act('worldbuilding.undoMarkTitleKeysAsNames', { book: book() })}
                        >
                            {t('Undo')}
                        </button>
                    </div>
                </div>
            </Show>
            <Show when={deleted()}>
                {(gone) => (
                    <div class="wb-offer">
                        <p>
                            {t('Deleted')} <Name named={gone().label} />.
                        </p>
                        <div class="wb-offer-acts">
                            <button
                                type="button"
                                class="wb-btn"
                                onClick={() =>
                                    void wb.act('worldbuilding.restoreEntry', {
                                        book: gone().book,
                                        entry: gone().entry,
                                    })
                                }
                            >
                                {t('Restore')}
                            </button>
                        </div>
                    </div>
                )}
            </Show>
            <Show when={props.rows}>
                {(rows) => <RowsHead fields={rows().fields} selection={rows().selection} book={book()} />}
            </Show>
            <Show
                when={props.results}
                fallback={
                    <Show when={props.overview}>
                        {(overview) => (
                            <TopLevel
                                view={overview()}
                                pane={props.pane}
                                shown={props.shown}
                                columns={props.columns}
                                actions={props.actions}
                                onRange={props.onRange}
                                {...(props.rows
                                    ? {
                                          rows: (cell) => (
                                              <EntryRows cell={cell} depth={0} context={props.rows as RowsContext} />
                                          ),
                                          rowHeight: ROW_HEIGHT,
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
                        actions={props.actions}
                        onMore={props.onMoreResults}
                        rows={props.rows}
                    />
                )}
            </Show>
            <Show
                when={
                    props.rows &&
                    !props.results &&
                    props.overview &&
                    props.overview.firstRank + props.overview.entries.length < props.overview.topLevelCount
                }
            >
                <div class="wb-tr wb-loadrow">
                    <span />
                    <span class="wb-dim">{t('Loading as you scroll')}</span>
                </div>
            </Show>
        </div>
    );
}
