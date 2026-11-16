import * as v from 'valibot';
import type { ActionSchemas, ChatOwner } from '@st/protocol';

export const VIEW = 'recentHistory.list';

// `chat`: the chat the tab shows; `all`: every chat of the user's, merged by time.
export const OF = ['chat', 'all'] as const;
export type Of = (typeof OF)[number];

export type Message = {
    nodeId: string;
    text: string;
    name: string;
    role: 'user' | 'assistant' | 'system';
    date: string | number | null;
};

// `name`: the chat's id, as the chat list names it.
export type Chat = { owner: ChatOwner; name: string };

// Where a chat is now (`split` null), or a group of the places where its lines ended that split off at one message,
// shown as the latest of them; `split` names that message by its number in the chat, or the chat's start. `others`:
// how many more places the group has; `tips`: those, read while the group is expanded.
export type Entry = {
    id: string;
    chat: Chat;
    message: Message;
    split: { number: number } | { start: true } | null;
    others: number;
    tips: { messages: Message[]; more: boolean } | null;
};

export type ListView = { of: Of | null; entries: Entry[]; more: boolean; chatOpen: boolean };

const entryId = v.pipe(v.string(), v.minLength(1));

export const actions = {
    'recentHistory.open': v.object({ of: v.picklist(OF) }),
    'recentHistory.more': v.object({}),
    'recentHistory.expand': v.object({ id: entryId, open: v.boolean() }),
    'recentHistory.moreTips': v.object({ id: entryId }),
    'recentHistory.close': v.object({}),
} satisfies ActionSchemas;
