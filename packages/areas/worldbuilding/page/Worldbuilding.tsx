import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { useUi } from '@st/page/context';
import {
    ENTRY_VIEW,
    LAST_CHANGE_VIEW,
    LOOP_CHECK_VISITS_PER_WRITE,
    MAX_CARDS_PER_READ,
    OVERVIEW_VIEW,
    POINTING_AT_VIEW,
    RELATION_KINDS_VIEW,
    RESULTS_VIEW,
    WORLD_VIEW,
} from '../protocol.ts';
import type {
    EntryView,
    LastChangeView,
    OverviewView,
    PointingAtShown,
    PointingAtView,
    RelationKindsView,
    ResultsView,
    WorldView,
} from '../protocol.ts';
import type { CardActions } from './Cards.tsx';
import { WbProvider } from './context.ts';
import type { Wb } from './context.ts';
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

const POINTING_AT_SHOWN = 12;

// The page reads nothing until its pane is first shown.
export function Worldbuilding(props: { shown: boolean; everShown: boolean }) {
    return (
        <Show when={props.everShown}>
            <Page shown={props.shown} />
        </Show>
    );
}

function Page(props: { shown: boolean }) {
    const { client, t } = useUi();
    const world = shownView<WorldView>(client, WORLD_VIEW);
    const overview = shownView<OverviewView>(client, OVERVIEW_VIEW);
    const kinds = shownView<RelationKindsView>(client, RELATION_KINDS_VIEW);
    const entryView = shownView<EntryView>(client, ENTRY_VIEW);
    const pointingAt = shownView<PointingAtView>(client, POINTING_AT_VIEW);
    const results = shownView<ResultsView>(client, RESULTS_VIEW);
    const lastChange = shownView<LastChangeView>(client, LAST_CHANGE_VIEW);

    const [pane, setPane] = createSignal<HTMLElement>();
    const [width, setWidth] = createSignal(0);
    const [said, setSaid] = createSignal<string | null>(null);
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

    const say = (words: string) => setSaid(words);
    const act: Wb['act'] = async (type, payload, file) => {
        setSaid(null);
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
    const wb: Wb = { act, layout: () => layout().overview, firstRead, pointingAt: pointingAtShown, open, say };

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
    };

    onMount(() => {
        const element = pane();
        if (!element) return;
        setWidth(element.clientWidth);
        const watch = new ResizeObserver(() => setWidth(element.clientWidth));
        watch.observe(element);
        onCleanup(() => watch.disconnect());
        const held = shownOverview();
        void openWorld(held?.book ?? null, held ? held.groupBy : undefined);
    });
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
            <div class="wb">
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
                        class="wb-btn"
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
                        {t('New entry')}
                    </button>
                </div>
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
                <Show when={said()}>
                    <div class="wb-said" role="status">
                        {said()}
                        <button type="button" aria-label={t('Close')} onClick={() => setSaid(null)}>
                            ×
                        </button>
                    </div>
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
