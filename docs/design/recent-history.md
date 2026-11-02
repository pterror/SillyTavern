# Recent history

Status: model agreed with the owner (2026-11-02), not designed in detail, not built.

The owner's ask: "is there a way to check recent history (of a chat/all chats)? the idea is for users to find recent
stuff without showing every little swipe".

## Model

- An entry is a tip: the message where a line of the conversation ends, shown as that message (chat, message, when).
- Tips that branch off the same split point are one group: the most recent tip shows as the entry, the others fold
  under it ("+16 other tries from message 9") and expand to their tips.
- Alternatives of the last message with nothing after them are not tips; the alternatives list shows them.
- The current position is the top entry. Entries are ordered by the latest activity under them.
- For one chat, its entries; for all chats, every chat's entries merged by time.

Rejected: grouping by time gaps (merges unrelated chats opened close together, splits one session at every pause); an
entry per line with anything after it (17 tries at one point that each got a reply are 17 entries).

## What exists

- Each session keeps every cursor move (`engine/src/store/sessions.rs`, `moved`: `HISTORY`, `HISTORY_N`,
  `HISTORY_BY`), exposed by the binding (`engine/src/store_binding.rs`, `cr::history`) and read by nothing on the page.
- Sessions ordered by last activity: `RECENT` (`sessions.rs`, `recent`).
- Every alternative is its own sibling node (`src/assistant-reply-persist.js`).

## Open

- Cost: a tip's split point is the closest common ancestor of where a move left and where it went. For a swipe it is
  the parent (one lookup); for an arbitrary jump it is a walk up the tree, which `engine/src/store/chat.rs` does one
  parent at a time. Whether the store can answer it without a cost per message of depth decides how this is built.
