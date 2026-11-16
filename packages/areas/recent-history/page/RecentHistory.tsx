import { For, Show, createEffect, on, onCleanup, onMount } from 'solid-js';
import { useUi } from '@st/page/context';
import { VIEW } from '../protocol.ts';
import type { Chat, Entry, ListView, Message, Of } from '../protocol.ts';

export type OldPage = {
    // Opens the chat at the message, the way the chat list does; why it couldn't, or null.
    go(chat: Chat, nodeId: string): Promise<string | null>;
    date(value: string | number): string;
    failed(message: string): void;
    // Called whenever the dialog opens, starts closing or has closed, so the old page can keep its toasts above the
    // topmost open dialog.
    dialogsChanged(): void;
};

export function RecentHistory(props: {
    shown: Of | null;
    old: OldPage;
    onShow: (of: Of) => void;
    onClose: () => void;
}) {
    return (
        <Show when={props.shown}>
            {(of) => <Panel of={of()} old={props.old} onShow={props.onShow} onClose={props.onClose} />}
        </Show>
    );
}

function Panel(props: { of: Of; old: OldPage; onShow: (of: Of) => void; onClose: () => void }) {
    const { client, t } = useUi();
    const view = client.view<ListView>(VIEW);
    const list = () => {
        const current = view();
        return current?.of === props.of ? current : null;
    };
    let dialog: HTMLDialogElement | undefined;
    let scroller: HTMLOListElement | undefined;
    let asking = false;

    onMount(() => {
        dialog?.showModal();
        props.old.dialogsChanged();
    });
    onCleanup(() => {
        dialog?.close();
        props.old.dialogsChanged();
    });

    const close = () => {
        props.onClose();
    };

    const show = (of: Of) => {
        if (of !== props.of) props.onShow(of);
    };

    const more = () => {
        if (asking || list()?.more !== true) return;
        asking = true;
        void client.send('recentHistory.more', {}).finally(() => {
            asking = false;
            fill();
        });
    };
    const nearEnd = () =>
        !!scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - scroller.clientHeight;
    const fill = () => {
        if (nearEnd()) more();
    };
    createEffect(on(list, () => queueMicrotask(fill)));

    const go = async (chat: Chat, message: Message) => {
        const refused = await props.old.go(chat, message.nodeId);
        if (refused !== null) {
            props.old.failed(refused);
            return;
        }
        close();
    };

    const expand = (entry: Entry, open: boolean) => void client.send('recentHistory.expand', { id: entry.id, open });

    const splitText = (entry: Entry) => {
        const split = entry.split;
        if (split === null) return '';
        const words = entry.others === 1 ? '+${0} other try from ${1}' : '+${0} other tries from ${1}';
        const from = 'start' in split ? t('the start') : t('message ${0}').replace('${0}', String(split.number));
        return t(words).replace('${0}', entry.others.toLocaleString()).replace('${1}', from);
    };

    return (
        <dialog
            ref={(el: HTMLDialogElement) => (dialog = el)}
            class="popup recent-history"
            aria-label={t('Recent history')}
            onCancel={(event) => {
                event.preventDefault();
                close();
            }}
        >
            <div class="popup-body">
                <header class="recent-history-header">
                    <h3>{t('Recent history')}</h3>
                    <div class="recent-history-of" role="tablist">
                        <button
                            type="button"
                            role="tab"
                            class="menu_button"
                            classList={{ active: props.of === 'chat' }}
                            aria-selected={props.of === 'chat'}
                            onClick={() => show('chat')}
                        >
                            {t('This chat')}
                        </button>
                        <button
                            type="button"
                            role="tab"
                            class="menu_button"
                            classList={{ active: props.of === 'all' }}
                            aria-selected={props.of === 'all'}
                            onClick={() => show('all')}
                        >
                            {t('All chats')}
                        </button>
                    </div>
                </header>
                <Show when={list()} fallback={<p class="recent-history-note">{t('Loading…')}</p>}>
                    {(shown) => (
                        <Show
                            when={shown().entries.length > 0}
                            fallback={
                                <p class="recent-history-note">
                                    {props.of === 'chat' && !shown().chatOpen
                                        ? t('No chat is open.')
                                        : t('Nothing yet.')}
                                </p>
                            }
                        >
                            <ol
                                class="recent-history-list"
                                ref={(el: HTMLOListElement) => (scroller = el)}
                                onScroll={fill}
                            >
                                <For each={shown().entries}>
                                    {(entry) => (
                                        <li class="recent-history-entry">
                                            <Row
                                                chat={entry.chat}
                                                message={entry.message}
                                                showChat={props.of === 'all'}
                                                current={entry.split === null}
                                                date={(value) => props.old.date(value)}
                                                onGo={() => void go(entry.chat, entry.message)}
                                            />
                                            <Show when={entry.others > 0}>
                                                <button
                                                    type="button"
                                                    class="recent-history-others menu_button"
                                                    aria-expanded={entry.tips !== null}
                                                    onClick={() => expand(entry, entry.tips === null)}
                                                >
                                                    <i
                                                        class="fa-solid"
                                                        classList={{
                                                            'fa-chevron-right': entry.tips === null,
                                                            'fa-chevron-down': entry.tips !== null,
                                                        }}
                                                    />
                                                    {splitText(entry)}
                                                </button>
                                            </Show>
                                            <Show when={entry.tips}>
                                                {(tips) => (
                                                    <ol class="recent-history-tips">
                                                        <For each={tips().messages}>
                                                            {(message) => (
                                                                <li>
                                                                    <Row
                                                                        chat={entry.chat}
                                                                        message={message}
                                                                        showChat={false}
                                                                        current={false}
                                                                        date={(value) => props.old.date(value)}
                                                                        onGo={() => void go(entry.chat, message)}
                                                                    />
                                                                </li>
                                                            )}
                                                        </For>
                                                        <Show when={tips().more}>
                                                            <li>
                                                                <button
                                                                    type="button"
                                                                    class="menu_button"
                                                                    onClick={() =>
                                                                        void client.send('recentHistory.moreTips', {
                                                                            id: entry.id,
                                                                        })
                                                                    }
                                                                >
                                                                    {t('Show more')}
                                                                </button>
                                                            </li>
                                                        </Show>
                                                    </ol>
                                                )}
                                            </Show>
                                        </li>
                                    )}
                                </For>
                            </ol>
                        </Show>
                    )}
                </Show>
            </div>
            <div
                class="popup-button-close right_menu_button fa-solid fa-circle-xmark"
                title={t('Close')}
                onClick={close}
            />
        </dialog>
    );
}

function Row(props: {
    chat: Chat;
    message: Message;
    showChat: boolean;
    current: boolean;
    date: (value: string | number) => string;
    onGo: () => void;
}) {
    const { t } = useUi();
    return (
        <div
            class="select_chat_block_wrapper"
            role="button"
            tabindex="0"
            onClick={() => props.onGo()}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    props.onGo();
                }
            }}
        >
            <div class="select_chat_block wide100p" classList={{ now: props.current }}>
                <div class="flex-container alignItemsCenter justifySpaceBetween wide100p">
                    <small class="select_chat_block_filename">
                        <Show when={props.showChat}>{props.chat.name}</Show>
                        <Show when={props.current}>
                            <span class="recent-history-now">{props.showChat ? ` · ${t('Now')}` : t('Now')}</span>
                        </Show>
                    </small>
                    <Show when={props.message.date !== null}>
                        <small class="select_chat_block_filename_item">{props.date(props.message.date!)}</small>
                    </Show>
                </div>
                <div class="select_chat_block_mes">
                    <Show when={props.message.name !== ''}>
                        <b>{props.message.name}: </b>
                    </Show>
                    {props.message.text}
                </div>
            </div>
        </div>
    );
}
