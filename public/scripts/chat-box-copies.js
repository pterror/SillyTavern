import { clearFieldDraft, clearThingDrafts, confirmFieldDraft, fieldDraftsOf, readFieldDraft, writeFieldDraft } from './field-drafts.js';

/**
 * The chat box's text as the browser keeps it until the server confirms a save of it: per draft (a chat and what the
 * text responds to), the text and the server's draft it was written over. Only text the server hasn't confirmed is
 * kept, so a copy is never a draft of its own: it's asked to be kept, and the server keeps it only over that same draft.
 */

const KIND = 'ChatBox';

/**
 * @typedef {import('./chat-box-ends.js').DraftOwner} DraftOwner
 * @typedef {{ avatar_url: string } | { group_id: string }} ChatOf
 * @typedef {{ text: string, base: string }} Copy
 * @typedef {import('./field-drafts.js').DraftStorage} DraftStorage
 */

/** @param {ChatOf} chat */
const chatId = chat => ('group_id' in chat ? `group:${chat.group_id}` : `card:${chat.avatar_url}`);

/** @param {DraftOwner} owner */
const field = owner => JSON.stringify('message' in owner ? { message: owner.message } : 'root' in owner ? { root: true } : { greeting: owner.greeting, avatar: owner.avatar });

/**
 * @param {ChatOf} chat
 * @param {DraftOwner} owner
 */
const refOf = (chat, owner) => ({ kind: KIND, id: chatId(chat), field: field(owner) });

/**
 * Browser storage that is absent or refuses (a private window) reads as empty and keeps nothing
 * @param {() => Storage} storage
 * @returns {DraftStorage}
 */
export function guardedStorage(storage) {
    return {
        getItem(key) {
            try {
                return storage().getItem(key);
            } catch {
                return null;
            }
        },
        setItem(key, value) {
            storage().setItem(key, value);
        },
        removeItem(key) {
            storage().removeItem(key);
        },
    };
}

/**
 * @param {DraftStorage} storage
 */
export function boxCopies(storage) {
    return {
        /**
         * The text as typed: kept unless it is the server's draft it was written over. A copy written over an older
         * draft keeps that one.
         * @param {ChatOf} chat
         * @param {DraftOwner} owner
         * @param {string} text
         * @param {string} base
         */
        write(chat, owner, text, base) {
            writeFieldDraft(storage, refOf(chat, owner), text, base);
        },
        /**
         * @param {ChatOf} chat
         * @param {DraftOwner} owner
         * @returns {Copy | null}
         */
        read(chat, owner) {
            return readFieldDraft(storage, refOf(chat, owner));
        },
        /**
         * @param {ChatOf} chat
         * @returns {(Copy & { owner: DraftOwner })[]} every copy kept for the chat
         */
        of(chat) {
            return fieldDraftsOf(storage, KIND, chatId(chat)).flatMap(({ field: owner, text, base }) => {
                try {
                    return [{ owner: JSON.parse(owner), text, base }];
                } catch {
                    return [];
                }
            });
        },
        /**
         * The server keeps the text: a copy of just it is gone; one typed since is now written over it
         * @param {ChatOf} chat
         * @param {DraftOwner} owner
         * @param {string} text
         */
        kept(chat, owner, text) {
            confirmFieldDraft(storage, refOf(chat, owner), text);
        },
        /**
         * The text is not to be kept (the draft changed since, or what it responds to is gone) or it is kept elsewhere
         * now: a copy of just it is gone
         * @param {ChatOf} chat
         * @param {DraftOwner} owner
         * @param {string} text
         */
        drop(chat, owner, text) {
            if (readFieldDraft(storage, refOf(chat, owner))?.text === text) clearFieldDraft(storage, refOf(chat, owner));
        },
        /**
         * @param {ChatOf} chat a chat that is gone
         */
        dropChat(chat) {
            clearThingDrafts(storage, KIND, chatId(chat));
        },
    };
}
