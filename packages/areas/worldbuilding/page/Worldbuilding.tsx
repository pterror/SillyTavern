import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { useUi } from '@st/page/context';
import {
    AXES_VIEW,
    ENTRY_VIEW,
    LAST_CHANGE_VIEW,
    LOOP_CHECK_VISITS_PER_WRITE,
    MAX_CARDS_PER_READ,
    OVERVIEW_VIEW,
    POINTING_AT_VIEW,
    RELATION_KINDS_VIEW,
    RESULTS_VIEW,
    SELECTION_VIEW,
    VIEWS_VIEW,
    WORLD_VIEW,
} from '../protocol.ts';
import type {
    AxesView,
    EntryView,
    LastChangeView,
    OverviewView,
    PointingAtShown,
    PointingAtView,
    RelationKindsView,
    ResultsView,
    SelectionView,
    ViewsView,
    WorldView,
} from '../protocol.ts';
import type { CardActions } from './Cards.tsx';
import type { Target } from './compat.ts';
import { WbProvider } from './context.ts';
import type { Wb } from './context.ts';
import { DragLayer, dragControl } from './Drag.tsx';
import { EntryPage } from './Entry.tsx';
import { Icon } from './icons.tsx';
import { PLAIN_ROWS_PER_SCREEN, pageLayout, sameLayout, topLevelShown } from './layout.ts';
import type { PageLayout } from './layout.ts';
import type { Range } from './Overview.tsx';
import { NOTHING_TYPED, SearchBox, filterOf } from './Search.tsx';
import type { Typed } from './Search.tsx';
import { Switcher } from './Switcher.tsx';
import { shownView } from './views.ts';
import { WorldPage } from './WorldPage.tsx';
import { ViewBar, ViewTabs, viewActions as viewActionsOf, viewsOf } from './Views.tsx';
import { BulkBar, hasSelection, rowPicking } from './Rows.tsx';
import type { RowsContext } from './Rows.tsx';

const POINTING_AT_SHOWN = 12;

// `notify`: the app's toast, for what the server refused.
type Props = { shown: boolean; target: Target | null; onTargetTaken: () => void; notify: (words: string) => void };

// The page reads nothing until its pane is first shown.
export function Worldbuilding(props: Props & { everShown: boolean }) {
    return (
        <Show when={props.everShown}>
            <Page shown={props.shown} target={props.target} onTargetTaken={props.onTargetTaken} notify={props.notify} />
        </Show>
    );
}

function Page(props: Props) {
    const { client, t } = useUi();
    const world = shownView<WorldView>(client, WORLD_VIEW);
    const overview = shownView<OverviewView>(client, OVERVIEW_VIEW);
    const kinds = shownView<RelationKindsView>(client, RELATION_KINDS_VIEW);
    const entryView = shownView<EntryView>(client, ENTRY_VIEW);
    const pointingAt = shownView<PointingAtView>(client, POINTING_AT_VIEW);
    const results = shownView<ResultsView>(client, RESULTS_VIEW);
    const lastChange = shownView<LastChangeView>(client, LAST_CHANGE_VIEW);
    const views = shownView<ViewsView>(client, VIEWS_VIEW);
    const selection = shownView<SelectionView>(client, SELECTION_VIEW);
    const axes = shownView<AxesView>(client, AXES_VIEW);

    const [pane, setPane] = createSignal<HTMLElement>();
    const [width, setWidth] = createSignal(0);
    const layout = createMemo<PageLayout>(() => pageLayout(width() > 0 ? width() : 1280), pageLayout(1280), {
        equals: (a, b) => sameLayout(a.overview, b.overview) && a.columns === b.columns,
    });
    const shownTop = () => topLevelShown(layout());
    const resultsPageSize = () => Math.min(MAX_CARDS_PER_READ, 2 * PLAIN_ROWS_PER_SCREEN * layout().columns);
    const pointingAtShown = (): PointingAtShown => ({ endRank: POINTING_AT_SHOWN, layout: layout().overview });

    const shownWorld = () => {
        const shown = world();
        return shown && shown.id !== null ? shown : null;
    };
    const shownOverview = () => {
        const shown = overview();
        return shown && shown.book !== null && shown.book === shownWorld()?.id ? shown : null;
    };
    const shownEntry = () => {
        const shown = entryView();
        return shown && shown.book !== null && !shown.deleted && shown.book === shownWorld()?.id ? shown : null;
    };
    const shownResults = () => {
        const shown = results();
        return shown && shown.book !== null && shown.book === shownWorld()?.id ? shown : null;
    };
    const shownPointingAt = () => {
        const shown = pointingAt();
        return shown && shown.book !== null ? shown : null;
    };
    const shownKinds = () => {
        const shown = kinds();
        return shown && shown.book !== null && shown.book === shownWorld()?.id ? shown.kinds : [];
    };

    const say = (words: string) => {
        props.notify(words);
    };
    const act: Wb['act'] = async (type, payload, file) => {
        const done = await client.send(type, payload, file);
        if (!done.ok) say(done.error);
        return done;
    };
    const firstRead = () => ({ firstRank: 0, endRank: shownTop(), layout: layout().overview });
    const openWorld = (book: string | null, groupBy?: string | null) =>
        act('worldbuilding.openOverview', {
            book,
            ...(groupBy === undefined ? {} : { groupBy }),
            ...firstRead(),
            around: null,
        });
    const open = (entry: string) => {
        pane()?.scrollTo({ top: 0 });
        void act('worldbuilding.openEntry', { entry, pointingAt: pointingAtShown() });
    };
    const drag = dragControl(act);
    const wb: Wb = { act, layout: () => layout().overview, firstRead, pointingAt: pointingAtShown, open, say, drag };
    const shownViews = () => viewsOf(views(), shownWorld()?.id ?? null);
    const viewActions = viewActionsOf(wb, () => shownWorld()?.id ?? null);
    const shownSelection = () => {
        const shown = selection();
        return shown && shown.book !== null && shown.book === shownWorld()?.id ? shown : null;
    };
    const picking = rowPicking(
        wb,
        () => shownWorld()?.id ?? '',
        shownSelection,
        () => pane(),
    );
    const shownAxes = () => {
        const shown = axes();
        const view = shownViews()?.shown;
        const drawsAxes = view !== null && view !== undefined && (view.columns.length > 0 || view.rows.length > 0);
        return drawsAxes && shown && shown.book !== null && shown.book === shownWorld()?.id ? shown : null;
    };
    const rows = (): RowsContext | null => {
        const shown = shownViews()?.shown;
        const book = shownWorld()?.id;
        if (
            !shown ||
            shown.drawing !== 'rows' ||
            shown.columns.length > 0 ||
            shown.rows.length > 0 ||
            book === undefined
        )
            return null;
        return {
            book,
            fields: shown.fields,
            selection: shownSelection(),
            isSelected: picking.isSelected,
            press: picking.press,
            enter: picking.enter,
            open,
        };
    };

    const [typed, setTyped] = createSignal<Typed>(NOTHING_TYPED);
    const type = (next: Typed) => {
        const book = shownWorld()?.id;
        if (book === undefined) return;
        setTyped(next);
        void act('worldbuilding.setFilter', { book, ...filterOf(next), pageSize: resultsPageSize() });
    };
    createEffect(
        on(
            () => shownWorld()?.id,
            () => setTyped(NOTHING_TYPED),
            { defer: true },
        ),
    );

    const actions: CardActions = {
        open,
        searchIn(entry, label) {
            const kind = shownOverview()?.groupBy;
            if (kind === null || kind === undefined) return;
            type({ ...typed(), scope: { chip: { kind, target: entry, depth: 'anyDepth' }, label } });
        },
        grouping() {
            const shown = shownOverview();
            const kind = shownKinds().find((one) => one.id === shown?.groupBy);
            return shown && kind ? { book: shown.book ?? '', kind: kind.id, kindName: kind.name } : null;
        },
    };

    onMount(() => {
        const element = pane();
        if (!element) return;
        setWidth(element.clientWidth);
        const watch = new ResizeObserver(() => setWidth(element.clientWidth));
        watch.observe(element);
        onCleanup(() => watch.disconnect());
        if (props.target) return;
        const held = shownOverview();
        void openWorld(held?.book ?? null, held ? held.groupBy : undefined);
    });
    createEffect(
        on(
            () => props.target,
            (target) => {
                if (!target || !pane()) return;
                props.onTargetTaken();
                pane()?.scrollTo({ top: 0 });
                if ('import' in target) void act('worldbuilding.importWorld', { overview: firstRead() }, target.import);
                else if ('character' in target)
                    void act('worldbuilding.openCharacterBook', { character: target.character, overview: firstRead() });
                else if ('at' in target)
                    void act('worldbuilding.openAt', {
                        ...target.at,
                        overview: firstRead(),
                        pointingAt: pointingAtShown(),
                    });
                else
                    void act('worldbuilding.openNamed', {
                        world: target.world,
                        uid: target.uid,
                        overview: firstRead(),
                        pointingAt: pointingAtShown(),
                    });
            },
        ),
    );
    createEffect(
        on(
            layout,
            (_now, before) => {
                const shown = shownOverview();
                if (!before || !shown || !props.shown) return;
                void act('worldbuilding.openOverview', {
                    book: shown.book,
                    groupBy: shown.groupBy,
                    ...firstRead(),
                    around: null,
                });
            },
            { defer: true },
        ),
    );

    return (
        <WbProvider value={wb}>
            <div class="wb" classList={{ 'wb-entry-shown': Boolean(shownEntry()) }}>
                <div class="wb-head">
                    <Switcher
                        world={
                            shownWorld()
                                ? {
                                      id: shownWorld()?.id ?? '',
                                      name: shownWorld()?.name ?? '',
                                      picture: shownWorld()?.picture ?? null,
                                      usedInEveryChat: shownWorld()?.usedInEveryChat ?? false,
                                      ownBook: shownWorld()?.cameWith !== null,
                                  }
                                : null
                        }
                        onOpen={(book) => void openWorld(book)}
                    />
                    <SearchBox typed={typed()} onType={type} />
                    <span class="wb-fill" />
                    <button
                        type="button"
                        class="menu_button menu_button_icon margin0 wb-btn wb-new-entry"
                        aria-label={t('New entry')}
                        disabled={!shownWorld()}
                        onClick={() => {
                            const book = shownWorld()?.id;
                            if (book === undefined) return;
                            void act('worldbuilding.createEntry', {
                                book,
                                after: null,
                                name: null,
                                relation: null,
                                open: { pointingAt: pointingAtShown() },
                                loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
                            });
                        }}
                    >
                        <Icon name="plus" />
                        <span class="wb-wide-only">{t('New entry')}</span>
                    </button>
                </div>
                <Show when={!shownEntry() && shownViews()}>
                    {(shown) => (
                        <>
                            <ViewTabs views={shown()} onShow={viewActions.show} onAdd={viewActions.add} />
                            <ViewBar
                                views={shown()}
                                kinds={shownKinds()}
                                axes={shownAxes()}
                                onChange={viewActions.change}
                                onSave={viewActions.save}
                                onDiscard={viewActions.discard}
                                onReset={viewActions.reset}
                            />
                        </>
                    )}
                </Show>
                <main class="wb-pane" ref={setPane}>
                    <Show when={pane() && shownWorld()} fallback={<NoWorld shown={client.version(WORLD_VIEW) > 0} />}>
                        {(shown) => (
                            <Show
                                when={shownEntry()}
                                fallback={
                                    <WorldPage
                                        world={shown()}
                                        overview={shownOverview()}
                                        results={shownResults()}
                                        kinds={shownKinds()}
                                        lastChange={lastChange() ?? null}
                                        pane={pane() as HTMLElement}
                                        shown={shownTop()}
                                        columns={layout().columns}
                                        resultsPageSize={resultsPageSize()}
                                        actions={actions}
                                        onGroupBy={(groupBy) => void openWorld(shown().id, groupBy)}
                                        viewed={(shownViews()?.tabs.length ?? 0) > 0}
                                        rows={rows()}
                                        axes={shownAxes()}
                                        onAxes={viewActions.change}
                                        onRange={(range: Range) => void act('worldbuilding.showRange', range)}
                                        onMoreResults={(pages) =>
                                            void act('worldbuilding.showResults', {
                                                from: shownResults()?.pages[0]?.cursor ?? null,
                                                pages,
                                            })
                                        }
                                    />
                                }
                            >
                                {(entry) => (
                                    <EntryPage
                                        entry={entry()}
                                        pointingAt={shownPointingAt()}
                                        kinds={shownKinds()}
                                        worldName={shown().name}
                                        groupBy={shownOverview()?.groupBy ?? null}
                                        actions={actions}
                                        onWorld={() => void act('worldbuilding.closeEntry', {})}
                                    />
                                )}
                            </Show>
                        )}
                    </Show>
                </main>
                <DragLayer control={drag} />
                <Show when={rows() && !shownEntry() && hasSelection(shownSelection())}>
                    <BulkBar
                        selection={shownSelection() as NonNullable<ReturnType<typeof shownSelection>>}
                        kinds={shownKinds()}
                        groupBy={shownOverview()?.groupBy ?? null}
                    />
                </Show>
            </div>
        </WbProvider>
    );
}

function NoWorld(props: { shown: boolean }) {
    const { t } = useUi();
    return (
        <Show when={props.shown}>
            <p class="wb-quiet wb-no-world">
                {t('There is no world yet. Make one from the menu by the world’s name.')}
            </p>
        </Show>
    );
}
