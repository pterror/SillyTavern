import { For, Show, createEffect, createSignal, createStore, flush, reconcile } from 'solid-js';
import { useUi } from '@st/page/context';
import { Select } from '@st/page/select';
import { nameClass } from '@st/page/name';
import { elementSetup } from '@st/page/element';
import type { Row, ManagerView, ManagerPorts } from './types.ts';

export function createManager() {
    const [state, setState] = createStore<ManagerView>({ rows: [], sort: 'manual', search: '', status: '' });
    return {
        view: () => state,
        show: (view: ManagerView) => {
            flush(() => setState(reconcile(view, 'id')));
        },
    };
}
type Manager = ReturnType<typeof createManager>;

function TagRow(props: { row: Row; old: ManagerPorts }) {
    const { t, focusActions } = useUi();
    let name: HTMLDivElement | undefined;
    const [focused, setFocused] = createSignal(false);
    createEffect(
        () => (focused() ? undefined : props.row.name),
        (value) => {
            if (name && value !== undefined && name.textContent !== value) name.textContent = value;
        },
    );
    return (
        <div
            id={props.row.id}
            class={['tag_view_item', { tag_view_item_kept: props.row.kept }]}
            title={
                props.row.kept
                    ? t('Kept at the top so you can go on working with it. Its own place in the list is further on.')
                    : undefined
            }
        >
            <div class="drag-handle" title={t('Drag to reorder tag')}>
                ☰
            </div>
            <button
                type="button"
                id={`${props.row.id}-tag-folder`}
                class={['tag_as_folder fa-solid fa-folder-open right_menu_button', props.row.folder.class]}
                title={t(props.row.folder.title)}
                onClick={() => void props.old.folder(props.row.id)}
            >
                <span
                    class="tag_folder_indicator"
                    style={{
                        color: props.row.folder.color,
                        'font-size': `calc(var(--mainFontSize) * ${props.row.folder.size})`,
                    }}
                >
                    {props.row.folder.icon}
                </span>
            </button>
            <button
                type="button"
                class={['right_menu_button fa-solid fa-fw eye-toggle', props.row.hidden ? 'fa-eye-slash' : 'fa-eye']}
                title={t(props.row.hidden ? 'Hide on character card' : 'Show on character card')}
                onClick={() => void props.old.hide(props.row.id)}
            />
            <Show when={props.row.thing !== undefined}>
                <button
                    type="button"
                    class="tag_view_look fa-solid fa-wand-magic-sparkles right_menu_button"
                    title={t("How this tag's name looks")}
                    onClick={() => void props.old.look(props.row.id)}
                />
            </Show>
            <div
                class={[
                    'tag_view_name tag',
                    props.row.thing === undefined ? '' : nameClass({ thing: props.row.thing, shownAs: 'name' }),
                    { tag_view_name_unsaved: props.row.unsaved },
                ]}
                data-thing={props.row.thing}
                contenteditable="true"
                role="textbox"
                aria-label={t('Tag name')}
                title={
                    props.row.unsaved
                        ? t('This name is not saved yet. Click it and press Enter to save it.')
                        : undefined
                }
                ref={elementSetup((element) => {
                    name = element;
                    element.textContent = props.row.name;
                    return focusActions.attach(element, { confirm: () => element.blur() });
                })}
                onInput={(event) => props.old.draft(props.row.id, event.currentTarget.textContent)}
                onFocus={() => setFocused(true)}
                onBlur={() => {
                    setFocused(false);
                    void props.old.rename(props.row.id);
                }}
            />
            <div class="tag_view_counter">
                <span class="tag_view_counter_value">{props.row.count}</span>&nbsp;<span>{t('entries')}</span>
            </div>
            <button
                type="button"
                class="tag_delete fa-solid fa-trash-can right_menu_button danger-button"
                title={t('Delete tag')}
                onClick={() => void props.old.remove(props.row.id)}
            />
        </div>
    );
}

export function TagManager(props: { manager: Manager; old: ManagerPorts }) {
    const { t } = useUi();
    const view = () => props.manager.view();
    return (
        <>
            <div class="title_restorable alignItemsBaseline">
                <h3>{t('Tag Management')}</h3>
                <div class="flex-container alignItemsBaseline">
                    <button
                        type="button"
                        class="menu_button menu_button_icon tag_view_prune"
                        title={t('Remove unused tags')}
                        onClick={() => void props.old.prune()}
                    >
                        <i class="fa-solid fa-scissors" />
                        {t('Prune')}
                    </button>
                    <button
                        type="button"
                        class="menu_button menu_button_icon tag_view_backup"
                        title={t('Save your tags to a file')}
                        onClick={() => props.old.backup()}
                    >
                        <i class="fa-solid fa-file-export" />
                        {t('Backup')}
                    </button>
                    <button
                        type="button"
                        class="menu_button menu_button_icon tag_view_restore"
                        title={t('Restore tags from a file')}
                        onClick={() => props.old.restore()}
                    >
                        <i class="fa-solid fa-file-import" />
                        {t('Restore')}
                    </button>
                    <button
                        type="button"
                        class="menu_button menu_button_icon tag_view_create"
                        title={t('Create a new tag')}
                        onClick={() => void props.old.create()}
                    >
                        <i class="fa-solid fa-plus" />
                        {t('Create')}
                    </button>
                    <input type="file" id="tag_view_restore_input" hidden accept=".json" />
                </div>
            </div>
            <div class="justifyLeft m-b-1">
                <div class="flex-container alignItemsBaseline">
                    <input
                        id="tag_view_search"
                        class="text_pole textarea_compact flex1"
                        type="search"
                        placeholder={t('Search tags')}
                        value={view().search}
                        onInput={(event) => props.old.search(event.currentTarget.value)}
                    />
                </div>
                <div class="flex-container alignItemsBaseline">
                    <span>{t('Sort mode:')}</span>
                    <Select
                        id="tag_sort_mode_select"
                        class="flex1 text_pole"
                        label={t('Sort mode')}
                        value={view().sort}
                        options={[
                            { value: 'manual', label: t('Manual (Drag & Drop)') },
                            { value: 'alphabetical', label: t('Alphabetical (A-Z)') },
                            { value: 'by_entries', label: t('Most Used (By Count)') },
                        ]}
                        onChange={(value, refuse) => {
                            refuse();
                            props.old.sort(value);
                        }}
                    />
                </div>
                <small>
                    {t('Drag handle to reorder. Click name to rename. Click the wand to change how its name looks.')}
                    <br />
                    {t('Click on the folder icon to use this tag as a folder.')}
                    <br />
                </small>
            </div>
            <div class="tag_view_list_edge" />
            <div
                class="tag_view_list_tags ui-sortable"
                onFocusOut={(event) => {
                    if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)))
                        props.old.leftRows();
                }}
            >
                <For each={view().rows}>{(row) => <TagRow row={row} old={props.old} />}</For>
            </div>
            <div class="tag_view_list_status" data-status={view().status} role="status">
                <Show when={view().status === 'loading'}>{t('Loading tags...')}</Show>
                <Show when={view().status === 'failed'}>
                    <span>{t('The tags could not be loaded.')}</span>
                    <button
                        type="button"
                        class="menu_button menu_button_icon"
                        onClick={() => props.old.read(view().rows.some((row) => !row.kept) ? 'after' : 'reload')}
                    >
                        {t('Try again')}
                    </button>
                </Show>
                <Show when={view().status === 'paused'}>
                    <span>{t('No tag found yet among the ones looked at so far.')}</span>
                    <button type="button" class="menu_button menu_button_icon" onClick={() => props.old.read('after')}>
                        {t('Keep looking')}
                    </button>
                </Show>
                <Show when={view().status === 'end' && view().rows.length === 0}>
                    {view().search !== '' ? t('No tags match the search.') : t('There are no tags yet.')}
                </Show>
            </div>
        </>
    );
}
