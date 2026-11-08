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

A stored opening that came from a card greeting names that greeting's id in `extra.greeting_id`, written with the
opening and never worked out again. The tree's openings the server sends carry the id on each card greeting not yet
stored, so whatever the page stores from one keeps it:
- the greeting stored with what goes under it, or with a bookmark;
- the greeting edited in the chat, stored as its edited text;
- an alternative added to it, and a duplicate of an opening that has one, which keep the id they were made from.

An opening the user wrote with no card greeting under it (their own first message) has none.

The openings are in card order: each card greeting, then the stored openings from it in the order they were stored,
the one with the greeting's text first; after every card greeting, the openings from no greeting, and those from a
deleted greeting, in the order they were stored. An edit to a card greeting leaves its openings with it; a delete
leaves them as history, after the card's greetings.

A chat imported from upstream, and the openings stored before this, name the card greeting whose text their first
message has when they're imported or converted (`scripts/convert-greeting-choices.mjs`); this is the only time a
text is matched.

## The greeting character info shows

The greeting the character info pager shows is the tab's view of that card: kept per tab and card by greeting id on
the server, with the tab's other view state, so it stays through closing the panel and a reload. Paging is one
request; opening a character answers with it. A shown greeting that's deleted gives way to the card's first.
