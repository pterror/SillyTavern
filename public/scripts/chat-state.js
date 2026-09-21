/** @type {ChatMessage[]} */
export let chat = [];

// Messages in `chat` are frozen after load/creation; all mutation goes through updateMessage()/updateIn()
// (chat-store.js), which swaps in a new frozen object - so reference equality against a snapshot is a
// complete, hash-free change-detection signal for script.js's slim wire save protocol (the
// _messageSnapshots reference-equality checks around its /api/chats/save calls).

/** @type {ChatMetadata} */
export let chat_metadata = {};

// script.js's own reassignment sites call this instead of `chat_metadata = ...` directly: an ESM
// live binding can't be reassigned from outside its owning module.
export function setChatMetadata(value) {
    chat_metadata = value;
}
