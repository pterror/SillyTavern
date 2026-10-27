# Chat names (CH32)

Every chat has a name, and its name is its chat id (upstream names a chat by its file name). No other form names a
chat: `s<UUID>.<tree>` and `b<id>` are gone.

## Which chats, which names

- **A bookmark**: its label. Every bookmark has one; a new one is given its suggestion when it has none.
- **A session's conversation in a tree** (its own chat there: no current bookmark): `<character name> - <time>` in a
  character's tree, `<time>` in a group's, as upstream names a new chat file and a new group chat. The time is
  `humanizedDateTime(start)` (one definition, `public/scripts/humanized-date.js`, the server's clock and zone), and
  `start` is when the conversation began:
  - a session's: the session's own time, read from its UUID (a v7 UUID begins with its time);
  - a caller with no session (a deterministic v5 UUID): the character's or group's creation date.

## Scopes

Names are unique in their scope, bookmarks and conversations together:
- a character's tree;
- all groups' trees together (a group route may send a chat id with no group id, as upstream's do).

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
| any route | a chat id | finds the bookmark or conversation of that name in the tree (a group route with no group id: among all groups' chats) | that chat, or not found |
| a page asking for its chat id (`getCurrentChatId()`, `characters[].chat`, `group.chat_id`) | its session | the current bookmark's label, else the conversation's name (stored, else worked out) | the name |
| saving a conversation as a bookmark | an optional label | label given: refused if taken; none: the conversation's name, the next free millisecond if taken | the bookmark's name |
| renaming a chat | old name, new name | refused if the new name is taken in the scope; a bookmark's label, or the conversation's stored name | the new name |
| the first write in a tree | the write | stores the conversation's name with it, when the session has no current bookmark there and none is stored | as before |

The engine keeps, per (session, tree), the stored name, and per name the trees holding it (bookmarks and
conversations both), which is how a name alone finds its tree.

## The one-off

`src/migrations/name-every-chat.js`, run once with the server stopped (`--dry-run`, then `--apply`, then
`--verify`):
- gives every unlabelled bookmark a label: its base (the character's name, a group's none) and the time it was made,
  as a conversation's;
- makes repeated labels in a scope unique: the later ones (by bookmark id) get " (2)", " (3)" … appended;
- writes each labelled bookmark's label again, so the name index (new) holds it;
- moves old-form chat ids (`s<UUID>.<tree>`, `b<id>`) found in the settings store's extension settings to the names
  they now have;
and lists every change.
