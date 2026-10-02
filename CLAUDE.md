# Rules

## Scale

The entire architecture must scale to 10 billion cards.

Nothing may be O(total cards) in memory, reads, or scans on any request path, server or client. No loading, looping over, or keeping resident one entry per card. Every query and every client-side structure is scoped to what the request or view actually needs.

No `.all()` on database statements. Stream rows with `.iterate()`; anything that must be materialized goes through a read with an explicit bound.

## Storage

Every piece of data is stored once, as its own values, never as a blob of a format meant for exchange. Anything derived from it is computed when read, unless that can't meet the scale rule; then it is stored narrow and brought up to date when it is next needed, not on every write. A write costs what actually changed. Reads, writes and disk space are kept at their lowest asymptotic cost together; none is bought with an unbounded amount of another.

## Tests

Subagents run only the tests covering what they changed, never the full suite. Every test run is scoped to the area the change actually touches.

## Compat

Nothing that works in upstream SillyTavern (the upstream/staging branch) may break here. That covers every function upstream exports, with its parameters and what they mean; every event and what it carries; every server route; and every third-party extension. Never modify a third-party extension. Where upstream accepts an argument, accept the same values and handle them the same way. Compat covers what code depends on: those exports, events, routes and extensions. Upstream's stored data (cards, chats, settings) must be importable; how it is stored here is ours. How the app behaves for the user is not bound to upstream: behavior should be maximally intuitive.

While there are no users, our own data formats change by hard cutover: no side-by-side old and new versions.

## Client

Clients only send actions.

## Loading

If the browser may already have a piece of data, it sends the server a hash of its copy and downloads the data only if it changed. Data isn't loaded until something on screen needs it. The exception is a chat's messages: opening a chat always loads all of them. Browser storage (IndexedDB) is limited, so cache only what's worth it.

## Memory

The page's memory holds only what is currently on screen. Browser storage (IndexedDB) may keep more, within a size limit.

## Data safety

Correctness comes before speed. Never lose data. Never leave anything out silently: if something has to be dropped, show a warning listing exactly what. Don't write anything unless something actually changed. Anything the user has typed or changed but not yet saved survives a page reload: it is kept as a draft and restored where it was.

## Tree model

Each character's or group's messages form a tree: a message can have several replies, and each reply starts a different branch of the conversation. The app keeps a pointer to the message you are currently at. A bookmark is a saved reference to one message (its id) plus a label you choose, so you can jump back to that message later; opening it shows the conversation from the first message down to that one. A following bookmark is updated whenever a new message is added right after the one it points to, so it always points at the newest message on that branch. A pinned bookmark always points at the same message. A "chat", as upstream code sees it, is only a thin layer over a bookmark.

## Boot and batches

Server startup must never wait on heavy work. Large passes over the data run after the server is listening, either in background worker threads or on the main thread in small batches with a pause between each, so requests are never held up. They never keep a database read open while writing.

## Multi-user

Several users can be in the same chat at once (multiplayer roleplay). Nothing may assume a single user or a single tab. Show who is present. When someone is editing something, others see it locked and by whom: a lock, not live merging. Live co-editing of text (Yjs) is a later addition, so designs should leave room for it without building it now.
