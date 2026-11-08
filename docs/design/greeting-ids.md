# Greeting ids

A character's greetings are an ordered list of `{ id, text }`, and its default greeting is one id or none. An id is a
whole number unique within the card and never given to another greeting of it. Everything that refers to a greeting
refers to its id: the default, and each session's remembered choice of the greeting a tree shows. Nothing stores a
greeting's position, so nothing is reindexed when greetings are added, deleted or moved.

## In the store

On the character's entity:
- The greetings other than the default are the items of the `alternate_greetings` list; an item's number is the
  greeting's id.
- The default greeting's text is `first_mes`; its id is the value `first_mes_item`, which is absent when the id is 0.
- Where the default sits among the others is `extensions.greeting_default_position`, as before.
- The next id to give is the value `greeting_next_item`, absent until a greeting has been added.

A change is written by id: an edit changes the text of that id, a move places that id, an add takes the next id, a
delete removes the id, a new default moves its id into `first_mes_item` and the old default's id into the list.

## In the card file

The card the page gets, the PNG an export writes and the JSON a card is shared as are upstream's format: `first_mes`,
`alternate_greetings` and `extensions.greeting_default_position`. They carry no ids. Upstream reads `first_mes` and
`alternate_greetings` and keeps the extension.

A card file written into the store gets its ids there:
- A new character: its greetings get ids 0, 1, 2, … in order.
- Over an existing character (a re-import, a rescan of its file): each greeting whose text the character already has
  keeps that greeting's id, each stored greeting matched once and in order; any other text gets a new id; a stored
  greeting the file doesn't have is gone.

## Remembered choices

A session at a tree's root remembers the card greeting it shows by that greeting's id, or as the card's default. A
choice holds through any session's adds, edits, moves and deletes of other greetings, and ends when its greeting is
deleted or the card's default is set or unset: the tree shows the default then. A new chat shows the default.

The card counts its default changes in the value `greeting_default_epoch` (absent while 0); deleting the default
greeting isn't one. A choice is stored as `epoch × 2³² + id + 1`, 0 being the default, and holds while the card's
count is the one it was made under.

Choices stored as positions (by code before this change) are converted once by
`scripts/convert-greeting-choices.mjs`, run with the server stopped: each becomes the id of the greeting at that
position.

## An opening's card greeting

A stored opening names the card greeting it came from in `extra.greeting_id`. The tree's openings the server sends
carry the id on each card greeting not yet stored, so whatever the page stores from one keeps it: the greeting stored
with what goes under it, an in-chat edit of it, an alternative added to it, a duplicate of an opening that has one.

Texts are compared only when a first message is written (stored, edited, imported or converted): one whose text is a
card greeting's is that greeting, linked with its id and `extra.greeting_hash`, the hash of the text it had. Any other
keeps the greeting it came from, unlinked. A user's own first message with a greeting's text is that greeting too.

A card greeting is left out of the openings exactly when a stored opening links to it with its current text's hash:
editing the card greeting offers its new text again beside the opening that had the old one.

The openings are in card order: each card greeting, then the stored openings from it in the order they were stored;
after every card greeting, the openings from no greeting, and those from a deleted greeting, in the order they were
stored.

Chats imported from upstream are linked as they are written. Openings stored before this are written again once by
`scripts/convert-greeting-choices.mjs`.

## The greeting character info shows

The greeting the character info pager shows is the tab's view of that card: kept per tab and card by greeting id on
the server, with the tab's other view state, so it stays through closing the panel and a reload. Paging is one
request; opening a character answers with it. A shown greeting that's deleted gives way to the card's first.
