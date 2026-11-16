# Greeting ids

A character's greetings are an ordered list of `{ id, text }`, and its default greeting is one id or none. An id is a
whole number unique within the card and never given to another greeting of it. Everything that refers to a greeting
refers to its id: the default, and each session's remembered choice of the greeting a tree shows. Nothing stores a
greeting's position, so nothing is reindexed when greetings are added, deleted or moved.

No two greetings of a card have the same text; texts that differ only in whitespace are different. An add or an edit
to another greeting's text is refused with that greeting's position and id (`same_position`, `same_id`), and the page
keeps the field open, unsaved, saying which greeting it is the same as, with a link that pages to it by its id. The create form checks the same
before the card is saved.

## In the store

On the character's entity:
- The greetings other than the default are the items of the `alternate_greetings` list; an item's number is the
  greeting's id.
- The default greeting's text is `first_mes`; its id is the value `first_mes_item`, which is absent when the id is 0.
- Where the default sits among the others is `extensions.greeting_default_position`, as before.
- The next id to give is the value `greeting_next_item`, absent until a greeting has been added.

A change is written by id: an edit changes the text of that id, a move places that id, an add takes the next id, a
delete removes the id, a new default moves its id into `first_mes_item` and the old default's id into the list.

A change names each greeting it acts on by its id and the hash of the text it was read with (`greetings/edit`,
`greetings/delete`, and the alternatives list's operations: `greeting_id` / `id`, `expected_hash` / `hash`); it is
refused when that greeting is gone or its text is no longer the one read, never applied to another greeting found by
its text or position. An add names only where it goes. Each answer has the card's greetings with their ids (`ids`).

## In the card file

The card the page gets, the PNG an export writes and the JSON a card is shared as are upstream's format: `first_mes`,
`alternate_greetings` and `extensions.greeting_default_position`. They carry no ids. Upstream reads `first_mes` and
`alternate_greetings` and keeps the extension.

A card file written into the store keeps the first copy of each text (the default moves to the kept copy) and gets
its ids there:
- A new character: its greetings get ids 0, 1, 2, … in order.
- Over an existing character (a re-import, a rescan of its file): each greeting whose text the character already has
  keeps that greeting's id, each stored greeting matched once and in order; any other text gets a new id; a stored
  greeting the file doesn't have is gone.

## Remembered choices

A session at a tree's root remembers the card greeting it shows by its character and that greeting's id, or as the
tree's default. A choice holds through any session's adds, edits, moves and deletes of other greetings, and ends when
its greeting is deleted, its card's default is set or unset, or (a group's) its character is no longer a member: the
tree shows the default then. A new chat shows the default. A tree's default is its card's default; a group's is its
first member's with greetings.

The card counts its default changes in the value `greeting_default_epoch` (absent while 0); deleting the default
greeting isn't one. A choice is stored as `epoch × 2³² + id + 1`, 0 being the default, and holds while its card's
count is the one it was made under. A choice of the tree's own character's greeting is the tree's (`openingChoice`),
of a member's the member's (`memberOpeningChoice`); a session has one choice in a tree, each replacing the one
before (a store from before that may hold one per member; the latest is the choice).

Choices stored as positions (by code before this change) are converted once by
`scripts/convert-greeting-choices.mjs`, run with the server stopped: each becomes the id of the greeting at that
position.

## An opening's card greeting

A stored opening names the card greeting it came from in `extra.greeting_id`. The tree's openings the server sends
carry the id on each card greeting not yet stored, so whatever the page stores from one keeps it: the greeting stored
with what goes under it, an in-chat edit of it, an alternative added to it, a duplicate of an opening that has one.
The page names a card greeting not stored yet by that id and its character (the `original_avatar` the server sends
with a member's, else the chat's own), never by its text or its speaker's name (`unstoredGreetingNodeId`). Each
opening that is a card greeting (a stored one: linked) carries `greeting`: its id, its character's avatar and its
text's hash; swiping to one not stored remembers it by that id and character (`/api/chats/openings/choose`, refused
when the hash is no longer its text's).

An opening's greeting is of the character it is stored as spoken by: a member's, in a group's tree; the tree's own
character's for one by it, and for a user's own first message, in a character's tree. A user's opening in a group's
tree is no greeting's.

Texts are compared only when a first message is written (stored, edited, imported or converted): one whose text is a
card greeting of its character's is that greeting, linked with its id and `extra.greeting_hash`, the hash of the text
it had. Any other keeps the greeting it came from, unlinked.
Only the exact text matches, whitespace included (owner, 2026-11-16). Openings linked before by their text without surrounding whitespace hold their greeting no more
once `scripts/convert-greeting-links-exact.mjs` has run, with the server stopped: each keeps its `greeting_id`, and
loses `greeting_hash` unless its text is exactly another greeting's.

A card greeting is left out of the openings exactly when a stored opening links to it with its current text's hash:
editing the card greeting offers its new text again beside the opening that had the old one.

The openings are in card order (a group's: each member's card in member order): each card greeting, then the stored
openings from it, in their group's order. After every card greeting come the openings from no greeting, then each
deleted greeting's openings and each former member's. A group's order puts
an edit or a duplicate directly after what it came from (`ordered-lists.md`, Openings and card greetings).

Chats imported from upstream are linked as they are written. Openings stored before this are written again once by
`scripts/convert-greeting-choices.mjs`.

## The greeting character info shows

The pager holds each greeting with its id: the character the page gets carries its greetings as `readCardGreetings`
reads them (`card_greetings`: `ids` aligned with `texts`, an empty greeting's included, and `default_index`), and each
greeting change answers with them. Every pager action names a greeting by its character and id, with the hash of the
text it had where the action changes or uses it: paging, edit, delete, "Use in chat", "Show in character info". A
greeting being added has no id until it is saved.

The greeting the character info pager shows is the tab's view of that card: kept per tab and card by greeting id on
the server, with the tab's other view state, so it stays through closing the panel and a reload. Paging is one
request (`greetings/show`, by id); opening a character answers with it (`greeting_shown`: its id). A shown greeting
that's deleted gives way to the card's first.

The pager and the chat keep separate positions; two actions copy one to the other, each one request whose answer is the
resulting state:
- "Use in chat", beside the pager number, makes the shown greeting (`greeting_id`) the open chat's opening, as swiping to it would: the
  stored opening that holds it, with what is under it, or the card greeting itself. The opening the chat had keeps its
  replies. It answers with the chat as opening it does. It is disabled unless a chat with this character is open, or
  a group chat it is a member of.
- "Show in character info", in the opening's message menu, pages the pager to the greeting the opening is linked to,
  by its character, its id and the hash of the text it had, and opens character info on it (in a group, on that
  member). It answers with that greeting's id. It is
  disabled when the opening has no live link: it was edited, or its greeting was changed or deleted.

## Converting cards with the same greeting twice

Cards stored before greetings were unique are converted once by `scripts/convert-greeting-duplicates.mjs`, run with
the server stopped: each later copy of a text is removed, and the default, each session's remembered choice, each
tab's shown greeting and each opening's `greeting_id` that named a removed copy name the kept one. The openings'
`greeting_hash` still matches, the text being the same. The server refuses a store that hasn't been converted.
