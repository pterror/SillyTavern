import { For, Show, createSignal } from 'solid-js';
import { useUi } from '@st/page/context';
import { Name } from '@st/page/name';
import { elementSetup } from '@st/page/element';
import { Floating } from './Floating.tsx';
import type { Controls, ControlPorts } from './controls.ts';

export function SavedViews(props: { controls: Controls; old: ControlPorts }) {
    const { t, focusActions } = useUi();
    const state = () => props.controls.saved();
    const [error, setError] = createSignal('');
    const [saving, setSaving] = createSignal(false);
    const [newName, setNewName] = createSignal('');
    const [edit, setEdit] = createSignal<{ id: string; name: string; kind: 'rename' | 'delete' } | null>(null);
    let picker: HTMLButtonElement | undefined;
    let saveInput: HTMLInputElement | undefined;
    const run = async (action: () => Promise<void>) => {
        if (saving()) return;
        setSaving(true);
        setError('');
        try {
            await action();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setSaving(false);
        }
    };
    const close = () => {
        setEdit(null);
        props.old.saved.close();
        picker?.focus();
    };
    const choose = (id: string | null) => {
        setEdit(null);
        props.old.saved.choose(id);
    };
    const saveAs = async () => {
        if (newName().trim() === '') {
            saveInput?.focus();
            return;
        }
        await props.old.saved.save(newName().trim());
        setNewName('');
    };
    const rename = async (value: string) => {
        const current = edit();
        if (!current) return;
        await props.old.saved.rename(current.id, value.trim());
        setEdit(null);
    };
    const row = (saved: { id: string; name: string }, index: number) => (
        <div class={['view_picker_row', { current: state().current === saved.id }]} data-view-id={saved.id}>
            <Show
                when={edit()?.id === saved.id}
                fallback={
                    <>
                        <button type="button" class="view_picker_row_name" onClick={() => choose(saved.id)}>
                            {saved.name}
                        </button>
                        <Show when={index > 0}>
                            <button
                                type="button"
                                class="fa-solid fa-arrow-up view_picker_action"
                                title={t('Move up')}
                                data-action="up"
                                onClick={() => void run(() => props.old.saved.move(saved.id, -1))}
                            />
                        </Show>
                        <Show when={index + 1 < state().views.length}>
                            <button
                                type="button"
                                class="fa-solid fa-arrow-down view_picker_action"
                                title={t('Move down')}
                                data-action="down"
                                onClick={() => void run(() => props.old.saved.move(saved.id, 1))}
                            />
                        </Show>
                        <button
                            type="button"
                            class="fa-solid fa-pencil view_picker_action"
                            title={t('Rename')}
                            data-action="rename"
                            onClick={() => setEdit({ ...saved, kind: 'rename' })}
                        />
                        <button
                            type="button"
                            class="fa-solid fa-trash-can view_picker_action danger-button"
                            title={t('Delete')}
                            data-action="delete"
                            onClick={() => setEdit({ ...saved, kind: 'delete' })}
                        />
                    </>
                }
            >
                <Show
                    when={edit()?.kind === 'rename'}
                    fallback={
                        <>
                            <span>
                                {t('Delete')} "{edit()?.name}"?
                            </span>
                            <button
                                type="button"
                                class="menu_button view_picker_confirm"
                                disabled={saving()}
                                onClick={() =>
                                    void run(async () => {
                                        await props.old.saved.remove(saved.id);
                                        setEdit(null);
                                    })
                                }
                            >
                                {t('Delete')}
                            </button>
                            <button type="button" class="menu_button" onClick={() => setEdit(null)}>
                                {t('Keep')}
                            </button>
                        </>
                    }
                >
                    <input
                        class="text_pole textarea_compact view_picker_rename"
                        value={edit()?.name ?? ''}
                        onInput={(event) => {
                            const value = event.currentTarget.value;
                            setEdit((current) => (current ? { ...current, name: value } : null));
                        }}
                        ref={elementSetup((element) => {
                            element.focus();
                            element.select();
                            return focusActions.attach(element, {
                                confirm: () => {
                                    void run(() => rename(element.value));
                                },
                                cancel: () => {
                                    setEdit(null);
                                },
                            });
                        })}
                    />
                </Show>
            </Show>
        </div>
    );
    return (
        <>
            <button
                id="character_view_picker"
                type="button"
                class={['menu_button view_picker', { unsaved: state().dirty }]}
                data-view-id={state().current ?? ''}
                ref={(element) => {
                    picker = element;
                }}
                aria-expanded={state().open ? 'true' : 'false'}
                title={`${t('Views')}: ${state().name}`}
                onClick={() => {
                    if (state().open) close();
                    else void run(() => props.old.saved.open());
                }}
            >
                <i class="fa-solid fa-layer-group" />
                <span class="view_picker_name">{t(state().name)}</span>
            </button>
            <Show when={state().open && picker !== undefined}>
                <Floating anchor={picker!} close={close} class="view_picker_popover">
                    <Show when={state().dirty}>
                        <div class="view_picker_unsaved">
                            <span>
                                {t('Unsaved changes to')} "{state().name}"{state().pending ? ':' : ''}
                            </span>
                            <Show when={state().current !== null && state().current?.startsWith('folder:') !== true}>
                                <button
                                    type="button"
                                    class="menu_button"
                                    data-action="save"
                                    disabled={saving()}
                                    onClick={() => void run(() => props.old.saved.save())}
                                >
                                    {t('Save')}
                                </button>
                            </Show>
                            <Show when={state().pending || state().current?.startsWith('folder:') === true}>
                                <button
                                    type="button"
                                    class="menu_button"
                                    data-action="save-as"
                                    onClick={() => saveInput?.focus()}
                                >
                                    {t('Save as new')}
                                </button>
                            </Show>
                            <button
                                type="button"
                                class="menu_button"
                                data-action="discard"
                                onClick={() => {
                                    props.old.saved.discard();
                                }}
                            >
                                {t('Discard')}
                            </button>
                            <Show when={state().pending}>
                                <button
                                    type="button"
                                    class="menu_button"
                                    data-action="keep"
                                    onClick={() => {
                                        props.old.saved.keep();
                                    }}
                                >
                                    {t('Keep editing')}
                                </button>
                            </Show>
                        </div>
                    </Show>
                    <input
                        type="search"
                        class="text_pole textarea_compact"
                        placeholder={t('Find a view')}
                        value={state().filter}
                        onInput={(event) => {
                            void props.old.saved
                                .search(event.currentTarget.value)
                                .catch((reason) => setError(String(reason)));
                        }}
                    />
                    <div class="view_picker_list">
                        <Show when={state().filter === ''}>
                            <div class={['view_picker_row', { current: state().current === null }]} data-view-id="">
                                <button type="button" class="view_picker_row_name" onClick={() => choose(null)}>
                                    {t('All characters')}
                                </button>
                            </div>
                        </Show>
                        <For each={state().views}>{(saved, index) => row(saved, index())}</For>
                        <Show
                            when={
                                edit() !== null && !state().views.some((saved) => saved.id === edit()?.id)
                                    ? edit()
                                    : null
                            }
                        >
                            {(current) => row(current(), state().views.length)}
                        </Show>
                        <Show when={state().views.length === 0 && state().filter !== ''}>
                            <div class="view_picker_empty">{t('No view has that name.')}</div>
                        </Show>
                        <Show when={state().more}>
                            <button
                                type="button"
                                class="menu_button view_picker_more"
                                onClick={() => void run(() => props.old.saved.more(false))}
                            >
                                {t('Show more')}
                            </button>
                        </Show>
                        <Show when={state().folders.length > 0}>
                            <div class="view_picker_heading">{t('Folders')}</div>
                        </Show>
                        <For each={state().folders}>
                            {(folder) => (
                                <div
                                    class={[
                                        'view_picker_row view_picker_folder',
                                        { current: state().current === `folder:${folder.id}` },
                                    ]}
                                    data-view-id={`folder:${folder.id}`}
                                >
                                    <i class="fa-solid fa-folder-open" />
                                    <button
                                        type="button"
                                        class="view_picker_row_name"
                                        onClick={() => choose(`folder:${folder.id}`)}
                                    >
                                        <Show when={folder.thing} fallback={folder.name}>
                                            {(thing) => (
                                                <Name named={{ thing: thing(), text: folder.name, shownAs: 'name' }} />
                                            )}
                                        </Show>
                                    </button>
                                </div>
                            )}
                        </For>
                        <Show when={state().moreFolders}>
                            <button
                                type="button"
                                class="menu_button view_picker_more"
                                onClick={() => void run(() => props.old.saved.more(true))}
                            >
                                {t('Show more folders')}
                            </button>
                        </Show>
                    </div>
                    <div class="view_picker_save">
                        <input
                            ref={(element) => {
                                saveInput = element;
                            }}
                            class="text_pole textarea_compact"
                            placeholder={t('Name for a new view')}
                            value={newName()}
                            onInput={(event) => setNewName(event.currentTarget.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    void run(saveAs);
                                }
                            }}
                        />
                        <button type="button" class="menu_button" disabled={saving()} onClick={() => void run(saveAs)}>
                            {t('Save as new view')}
                        </button>
                    </div>
                    <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
                </Floating>
            </Show>
        </>
    );
}
