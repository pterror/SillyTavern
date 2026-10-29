# The alternatives of a message

One surface for any message's alternatives (its swipes): a chat message's, and a character's greetings, which are the
alternatives of its chat's first message. It replaces the swipe picker (`public/scripts/swipe-picker.js`) and the
greetings popup (`openAlternateGreetings`). New-page area: `packages/areas/alternatives`.

## What it shows

A list of the target's alternatives, in the message's own order (so `#12 of 340` is the counter's 12/340), every one
rendered as chat renders it, read-only; an editor only for the greeting being edited. Each row: its number, whose
(for a chat message), when, its token count, its text; the current one marked.

Targets:
- `{ message: <node id> }`: a stored chat message's alternatives (its siblings in the tree, the engine's
  `alternatives()`), in the tab's open chat.
- `{ opening: true }`: the open chat's first message: its stored openings, then the card's greetings no stored
  opening already is (the engine's `openingAlternatives()`, the order message 0's swipes have). A stored opening
  whose text a card greeting has carries that greeting's card position, so every card greeting is in the list once
  and can be edited.
- `{ greetings: <avatar> }`: a character's card greetings alone, in card order (character info, when no chat of that
  character is open, and while one is being created: see below).

## Data flow

| Step | The page sends | The server does | It answers / pushes | Who holds what |
|---|---|---|---|---|
| open | `alternatives.open { target, tokenizer }` (`tokenizer`: the on-screen connection state the count routes already take) | keeps the tab's target and tokenizer; reads the target's alternatives | the `alternatives` view: target, items (id, kind, number, text, name, role, date, card position and hash, node id, default), counts the count store has (null for the rest), the current index | server: the list, counts, the tab's target and query; page: the latest view (the client's view store, so a later open shows it at once and revalidates) |
| counts | nothing | counts the texts the store didn't have, once, through the token count store (stored for every later read) | the view pushed again with them | the count store |
| search | `alternatives.search { query }` | parses it with the library and chat search's parser (`searchClauses`), matches every item's text with the engine's tokenizer (`textMatches`: the chat search's tokens and folding) | the view with `matches`: each matching item's index and the source tokens matched | server: the tab's query; page: nothing but the view |
| go | (old page) the swipe the old chat code makes: `swipe(…, { forceSwipeId })` with the item's index | the chat's select action (node-addressed) | the chat redraws as for any swipe | the tree |
| delete (chat alternative) | (old page) `deleteSwipe(index, mesId, { ask })` | the node-addressed delete | the view pushed again (the old page tells the client to read it) | the tree |
| greeting ops | `alternatives.greeting { op, … }` with the greeting's card position and hash (edit, delete, move, default set / unset, add) | the card's greeting operation (`applyGreetingOperation`: refuses on a stale hash) | the view; a refusal says why, with the list as stored | the card |
| greetings changed | (page) hands the new list to the old page | — | the old page applies it as a greeting save does (pager, CHARACTER_EDITED for the chat's first message) | the card |
| close | `alternatives.close` | forgets the tab's target and query | — | — |

Rules checked:
- The server owns the list, the counts, the query and the matches; the page renders the latest view and keeps
  nothing else (an editor's typing until it's saved).
- Nothing on the page counts tokens or matches text.
- Opening shows the dialog at once: the client's last view of the same target, else the dialog with its list
  loading; nothing waits on a request per row (one view, counts pushed after).
- Correctness never depends on timing: views carry versions, the newest wins whatever order they arrive in.
- Old chat code keeps what it owns (the chat's swipes and selecting one); this area doesn't reimplement it.

## Rendering

Every row is rendered with the old page's message formatting (`messageFormatting`, handed to the new page), the
pipeline chat uses. Rows are formatted visible-first, then the rest in idle time, so the list draws at once with plain
text where a row isn't formatted yet; rows off screen skip layout and paint (`content-visibility: auto`). The list is
one list: no pages, no windowing.

Matches are highlighted in the rendered rows with `<mark class="match">`, coloured by `--match-color` (a theme
variable; custom CSS can override it). The server says which source tokens matched; the page marks those tokens in
the rendered text. (Exact positions in the rendered text need the one markdown parser, ED31.)

## Finding your place

- Numbering `#12 of 340`; "Go to #n" in the list (and the command palette, Q7).
- Opens scrolled to the current alternative, marked.
- Search hides what doesn't match without redrawing anything; clearing it scrolls back to the current one.
- Markers beside the list for matches and the current one; the list reserves its scrollbar (`scrollbar-gutter:
  stable`).

## Opening it

- The swipe counter on any message with more than one alternative, a tap or a click on every device. The counter
  shows on every such message (the "Swipe # for All Messages" setting goes); user messages are included.
- The greetings button in character info.

## Creating a character

A character being created isn't on the server yet, so its greetings are the create form's (the pager there adds,
edits and removes them). The greetings button opens the list once the character exists.
