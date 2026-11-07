# Chat names (CH32)

Every chat has a name, and its name is its chat id. No other form names a chat: `s<UUID>.<tree>` and `b<id>` are
gone.

What a chat is, in the owner's words:
- "a chat can obviovusly be uniquely defined by its last message (and *optionally* that message's child swipes)"
  (2026-09-20T06:10:59).
- "in ours there should. be. no. checkpoint vs chat" (2026-09-27T01:25:20).
- Upstream's current chat: "doesn't fucking exist. bookmarks are what replaced them" (2026-10-03T09:23:57).

## Which chats, which names

- **A bookmark**: its label. Every bookmark has one; a new one is given its suggestion when it has none.
- **A session's conversation in a tree** (its own chat there: no current bookmark): `<character name> - <time>` in a
  character's tree, `<time>` in a group's. The time is
  `humanizedDateTime(start)` (one definition, `public/scripts/humanized-date.js`, the server's clock and zone), and
  `start` is when the conversation began:
  - a session's: the session's own time, read from its UUID (a v7 UUID begins with its time);
  - a tab with no session yet (its requests say `X-ST-Session: none`; a deterministic v5 UUID): the character's or group's creation date. A request without the header is refused.

## Scopes

Names are unique in their scope, bookmarks and conversations together:
- a character's tree;
- all groups' trees together.

## When a conversation's name is fixed

Before the conversation's first write its name is worked out, never stored: opening a chat writes nothing. A
clash in its scope resolves on read, the same way every time: the next free millisecond (the name's own unit).

At its first write (a message, a move, a metadata write: whatever first stores something of the session's in the
tree), that exact name is stored for the session and tree: a `conversationName` record. From then on it never
changes but by a rename, which is refused when the name is taken. A character renamed before the first write
changes the name not yet stored.

## Writes and reads

| Who | Sends | Server does | Answers |
|---|---|---|---|
| any route | a chat id, with its character or group | finds the bookmark or conversation of that name in that tree | that chat, or not found |
| a page asking for its chat id (`getCurrentChatId()`, `characters[].chat`, `group.chat_id`) | its session | the current bookmark's label, else the conversation's name (stored, else worked out) | the name |
| saving a conversation as a bookmark | an optional label | label given: refused if taken; none: the conversation's name, the next free millisecond if taken | the bookmark's name |
| renaming a chat | old name, new name | refused if the new name is taken in the scope; a bookmark's label, or the conversation's stored name | the new name |
| the first write in a tree | the write | stores the conversation's name with it, when the session has no current bookmark there and none is stored | as before |

The engine keeps, per (session, tree), the stored name, and per name the trees holding it (bookmarks and
conversations both).

## The cutover

The existing store was converted once, as a hard cutover ("while there are no users, migrations should be hard
cutovers", owner, 2026-10-02T10:30:07): every unlabelled bookmark labelled, repeated labels in a
scope made unique (the later ones by bookmark id get the next free name: a name ending in a chat's time a millisecond
later, else " (2)", " (3)" …), every label written again so the name index holds it, old-form chat ids in extension
settings moved to their names. The server only knows the current format.

## Names a chat is given

- A label the user types (saving a bookmark, renaming a chat) is refused when another chat of its scope has it.
- A suggested one (a branch's `<name> - Branch #n`, a bookmark's `<name> - Bookmark #n` the dialog shows, an imported
  chat's file name, a save with `unique`) becomes the next free one.
- A new chat (the new-chat routes) is named anew, `chatNameAt()` now.
