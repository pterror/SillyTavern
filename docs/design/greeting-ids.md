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

A session at a tree's root remembers the card greeting it shows as that greeting's id + 1; 0 is the card's default. A
choice whose greeting is gone shows the default. A new chat shows the default.

Choices stored as positions (by code before this change) are converted once by
`scripts/convert-greeting-choices.mjs`, run with the server stopped: each becomes the id of the greeting at that
position.
