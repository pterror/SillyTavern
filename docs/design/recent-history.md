# Recent history

Status: model agreed with the owner (2026-11-02); built (2026-11-16). The view's layout is a first version for the
owner to change (below, "Choices made in building it").

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

## Built

The store keeps it as each cursor move is recorded (`engine/src/store/tips.rs`, called from `sessions::pointer_moved`,
so a message sent, a move, a move to a tree's root, a history step and a fork all count):

- A chat is a conversation as the chat list names it (`sessions::Convo`): the session's current bookmark in the tree,
  else its own conversation there. A move counts towards the chat the session shows in the tree when it moves.
- Each chat keeps where it is. A move from A to B finds the split, the closest common ancestor of A and B (none: the
  tree's root), once, as it is recorded: by the depth jump pointers (`sessions::climb`, a step per halving of the
  depth), or by walking parents while a tree's depths are being rewritten. For a message the move's record appends,
  its parent stands in for it.
- A is a tip of that split unless the move went on below it (A is the split) or A is an alternative of the split's
  reply (A's parent is the split): a swipe, or a switch between replies of one message, leaves no tip. The place a chat
  is at is no tip of it while it is there.
- A chat's tips with one split are a group, ordered by the activity the move had (its record's log position); a group's
  activity is its latest tip's. Two indexes order the entries, a chat's (`TIP_RECENT`) and every chat's (`TIP_ALL`):
  the place each chat is at and each group, by activity. Reading a page is a scan of one of them and a constant number
  of reads per entry, whatever the depth of the messages.
- A deleted tip leaves its group; a chat at a deleted message is at where the session's pointer goes (its parent);
  a split taken out from between its neighbours hands its groups to its parent. A chat that is gone (a bookmark
  deleted, a session deleted, a session's own conversation replaced by a bookmark) takes its entries with it.

The reads are `recentHistory` and `historyTips` (`engine/src/store/chat_read.rs`), paged by the cursor of the last
entry read; `ChatEngine.recentHistory` and `historyTips` (`src/chat-engine.js`) add each entry's message, chat id and
the split's number in the chat.

Stores from before it are converted once, by `node scripts/convert-recent-history.mjs --data-root <data folder>` with
the server stopped (the server refuses a store not converted): it clears what recent history a store holds, replays
every session's kept moves in their order, then puts each chat where its session is. Run twice it builds the same.
A kept move counts towards the chat its session shows in the tree now, since the moves don't record which chat they
were made in; a bookmark several sessions moved in is replayed a session at a time.

The page (`packages/areas/recent-history`): the view `recentHistory.list` reads the entries a page (50) at a time in
order, one more page each time the list is scrolled to its end, and an expanded group's other tips a page at a time;
it is pushed again on every write while a tab shows it. It opens from the options menu ("Recent history", under
Bookmarks) and from the command palette (`history.recent`, "Recent history" under Chat). An entry opens its chat at
that message by the chat list's navigation (`openRecentCharacterChat` / `openRecentGroupChat`, then `switchToNode`).

## Choices made in building it

For the owner to keep or change:

- A dialog in the app's popup style, rows in the chat list's style (`select_chat_block`): the chat's name (all chats
  only), the message's date, its speaker and text; the current place marked "Now" and highlighted.
- Two tabs, "This chat" and "All chats"; it opens on "This chat" when a chat is open, else on "All chats".
- A group shows as its latest tip with a button under it, "+N other tries from message M" ("from the start" for
  openings), which expands the other tips under it, latest first, with "Show more" for the next page.
- "When" is the message's own date; the order is by the latest move.
- The current place is an entry of its own, not part of a group; a chat at its tree's root (no message) has no
  current entry.
- No key binding for the command.
- Choosing an entry closes the dialog. In a group chat it opens the chat where it is: going to a message of a group
  chat isn't supported by the app's navigation (`switchToNode`).
- Not virtualized, like the chat list.
