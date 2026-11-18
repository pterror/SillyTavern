import { For, Show, createEffect, createSignal, createStore, flush, reconcile } from 'solid-js';
import { useUi } from '@st/page/context';
import { Name } from '@st/page/name';
import { Select } from '@st/page/select';
import type { BrowserView, OldPage, Row } from './types.ts';

export function createBrowser() {
    const [state, setState] = createStore<{ view: BrowserView }>({
        view: { rows: [], page: 1, size: 25, total: 0, approximate: false },
    });
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal('');
    const [revision, setRevision] = createSignal(0);
    return {
        view: () => state.view,
        busy,
        error,
        revision,
        loading(loading: boolean, reason = '') {
            setBusy(loading);
            setError(reason);
        },
        async show(view: BrowserView) {
            flush(() => {
                setState(reconcile({ view }, 'id'));
                setRevision((value) => value + 1);
                setBusy(false);
                setError('');
            });
        },
    };
}

type Browser = ReturnType<typeof createBrowser>;
type Props = { browser: Browser; old: OldPage };

export function BrowserRows(props: Props) {
    const { t } = useUi();
    return (
        <>
            <Show when={props.browser.error()}>{(message) => <p role="alert">{message()}</p>}</Show>
            <For each={props.browser.view().rows}>
                {(row) => <BrowserRow row={row} old={props.old} revision={props.browser.revision()} />}
            </For>
            <Show when={props.browser.view().rows.length === 0 && !props.browser.busy()}>
                <div class="text_block empty_block">
                    <i class="fa-solid fa-dragon fa-4x" aria-hidden="true" />
                    <h1>{t('Here be dragons')}</h1>
                    <p>{t('There are no items to display.')}</p>
                </div>
            </Show>
        </>
    );
}

function BrowserRow(props: { row: Row; old: OldPage; revision: number }) {
    const { t } = useUi();
    let tags: HTMLDivElement | undefined;
    let avatar: HTMLDivElement | undefined;
    createEffect(
        () => props.revision,
        () => {
            const cleanup = tags ? props.old.tags(tags, props.row.entity) : undefined;
            if (avatar && props.row.type === 'group') props.old.avatar(avatar, props.row.entity);
            if (typeof cleanup === 'function') return cleanup;
        },
    );
    const folderBack = () => props.row.type === 'folder' && props.row.entity === 'none';
    const activate = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        event.currentTarget.click();
    };
    return (
        <div
            class={[
                'entity_block flex-container wide100p alignitemsflexstart look-scope',
                {
                    character_select: props.row.type === 'character',
                    group_select: props.row.type === 'group',
                    bogus_folder_select: props.row.type === 'folder',
                    bogus_folder_select_back: folderBack(),
                    is_fav: props.row.favorite,
                },
            ]}

            data-avatar={props.row.type === 'character' ? props.row.entity : undefined}
            data-grid={props.row.type === 'group' ? props.row.entity : undefined}
            data-id={props.row.type === 'group' ? props.row.entity : undefined}
            data-folder-case={props.row.type === 'folder' ? props.row.entity : undefined}
            data-search-result-id={props.row.id}
            data-list-position={props.row.position}
            role="listitem"
            tabindex={0}
            onKeyDown={activate}
            aria-label={
                props.row.type === 'folder'
                    ? folderBack()
                        ? t('Go back')
                        : `${t('Folder')} ${props.row.name}, ${props.row.count} ${t('characters and groups')}`
                    : props.row.name
            }
        >
            <div
                class="avatar"
                ref={(element) => {
                    avatar = element;
                }}
                title={props.row.type === 'character' ? `${props.row.name}\nFile: ${props.row.entity}` : props.row.name}
            >
                <Show when={props.row.type === 'character'}>
                    <img src={props.row.image} alt={props.row.name} loading="lazy" />
                </Show>
                <Show when={props.row.type === 'folder'}>
                    <i
                        class={`bogus_folder_icon fa-solid fa-xl ${folderBack() ? 'fa-right-from-bracket fa-flip-horizontal' : 'fa-folder-closed'}`}
                        aria-hidden="true"
                    />
                </Show>
            </div>
            <div
                class={[
                    'flex-container wide100pLess70px',
                    {
                        character_select_container: props.row.type !== 'group',
                        group_select_container: props.row.type === 'group',
                    },
                ]}
            >
                <div class={['wide100p character_name_block', { group_name_block: props.row.type === 'group' }]}>
                    <span class="ch_name" title={props.row.name}>
                        <Show when={props.row.thing !== ''} fallback={props.row.name}>
                            <Name named={{ thing: props.row.thing, text: props.row.name, shownAs: 'name' }} />
                        </Show>
                    </span>
                    <Show when={props.row.type === 'character'}>
                        <small class="ch_additional_info ch_add_placeholder">+++</small>
                        <Show when={props.row.assistant}>
                            <small
                                class="ch_assistant"
                                title={t('This character will be used as a welcome page assistant.')}
                            >
                                <i class="fa-solid fa-sm fa-user-graduate" />
                            </small>
                        </Show>
                        <small
                            class={[
                                'ch_additional_info character_version',
                                { displayNone: props.row.auxiliary === '' },
                            ]}
                        >
                            {props.row.auxiliary}
                        </small>
                        <small class="ch_additional_info ch_avatar_url">{props.row.filename}</small>
                    </Show>
                    <Show when={props.row.type !== 'character' && !folderBack()}>
                        <small
                            class={[
                                'ch_additional_info',
                                {
                                    group_select_counter: props.row.type === 'group',
                                    bogus_folder_counter: props.row.type === 'folder',
                                },
                            ]}
                        >
                            {props.row.count}
                        </small>
                    </Show>
                </div>
                <Show when={props.row.type === 'group'}>
                    <small class="character_name_block_sub_line">{t('in this group')}</small>
                </Show>
                <Show when={props.row.type !== 'folder'}>
                    <i
                        class={
                            props.row.type === 'character'
                                ? 'ch_fav_icon fa-solid fa-star'
                                : 'group_fav_icon fa-solid fa-star'
                        }
                        style={{ display: 'none' }}
                        aria-hidden="true"
                    />
                    <input class="ch_fav" value={String(props.row.favorite)} hidden />
                    <Show when={props.row.type === 'character'}>
                        <div class={['ch_description', { displayNone: props.row.description === '' }]}>
                            {props.row.description}
                        </div>
                    </Show>
                    <Show when={props.row.type === 'group'}>
                        <div class="group_select_block_list ch_description">
                            <For each={props.row.members}>
                                {(member, index) => (
                                    <>
                                        {index() > 0 ? ', ' : ''}
                                        <Show when={member.thing !== ''} fallback={member.text}>
                                            <Name named={member} />
                                        </Show>
                                    </>
                                )}
                            </For>
                        </div>
                    </Show>
                    <div
                        class="tags tags_inline"
                        ref={(element) => {
                            tags = element;
                        }}
                    />
                </Show>
            </div>
        </div>
    );
}

export function BrowserPagination(props: Props) {
    const { t } = useUi();
    const view = () => props.browser.view();
    const [error, setError] = createSignal('');
    const act = async (operation: () => Promise<void>) => {
        try {
            setError('');
            await operation();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    };
    return (
        <div class="paginationjs st-character-pagination">
            <div class="paginationjs-pages">
                <ul>
                    <li class={['paginationjs-prev J-paginationjs-prev', { disabled: view().page <= 1 }]}>
                        <button
                            type="button"
                            aria-label={t('Previous page')}
                            disabled={props.browser.busy() || view().page <= 1}
                            onClick={() => void act(() => props.old.page(view().page - 1))}
                        >
                            ‹
                        </button>
                    </li>
                    <li
                        class={[
                            'paginationjs-next J-paginationjs-next',
                            { disabled: view().page * view().size >= view().total },
                        ]}
                    >
                        <button
                            type="button"
                            aria-label={t('Next page')}
                            disabled={props.browser.busy() || view().page * view().size >= view().total}
                            onClick={() => void act(() => props.old.page(view().page + 1))}
                        >
                            ›
                        </button>
                    </li>
                </ul>
            </div>
            <div class="paginationjs-nav J-paginationjs-nav" aria-live="polite">
                {view().total === 0 ? 0 : (view().page - 1) * view().size + 1}-
                {Math.min(view().page * view().size, view().total)} .. {view().approximate ? '~' : ''}
                {view().total}
            </div>
            <Select
                id="character-page-size"
                class="text_pole"
                label={t('Characters per page')}
                value={String(view().size)}
                options={[10, 25, 50, 100, 250, 500, 1000].map((size) => ({
                    value: String(size),
                    label: String(size),
                }))}
                onChange={(value, refuse) => {
                    refuse();
                    void act(() => props.old.size(Number(value)));
                }}
            />
            <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
        </div>
    );
}
