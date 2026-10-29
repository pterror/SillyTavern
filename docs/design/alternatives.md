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
- `{ opening: true }`: the open chat's first message (a character's chat): its stored openings, then the card's
  greetings no stored opening already is (the engine's `openingAlternatives()`, the order message 0's swipes have).
  A stored opening whose text a card greeting has is marked with that greeting's card position.
- `{ greetings: <avatar> }`: a character's card greetings, in card order (the greetings button in character info).
  When the tab's open chat is this character's, each greeting also says where it is among the chat's openings, so it
  can be shown in the chat.

One component, the same controls on the same rows wherever it's opened: the card's operations (add, edit, reorder,
default, delete from the card) on every card greeting, in either list; delete from the chat on every stored
alternative.

An item's id is its node id; a card greeting not stored in the chat is known by its text's hash (the same text twice
by which it is), so it keeps its row, and an editor open on it, while other greetings move.

The tab looks at one target at a time. The server keeps the look per tab (target, tokenizer, search, the list last
read) and answers three views: `alternatives.list` (the items), `alternatives.counts` (token counts by item id) and
`alternatives.matches` (the search's matches by item id), so a search or a count never resends the texts.

## Data flow

| Step | The page sends | The server does | It answers / pushes | Who holds what |
|---|---|---|---|---|
| open | `alternatives.open { target, tokenizer }` (`tokenizer`: the on-screen connection state the count routes already take) | keeps the tab's look; reads the target's alternatives | the three views: the list (items: id, place, text, name, role, date, node id, card position and hash; the current one; the card's list), the counts the count store has, no matches. A long list streams: the answer is NDJSON, its first line the list's rows around the current one (`complete: false`), the next the whole list (a view read in parts: each part newer than the one before, older than any read started after it) | server: the list, counts, the tab's look; page: the latest views, and the last whole list of each target this browser showed (IndexedDB, by target and the version the server gave it, the newest 16; shown at once when that target opens again, also after a reload, until the server's whole list is here) |
| counts | nothing | counts the texts the store didn't have, once each, nearest the current one first, a few at a time, yielding between texts, through the token count store (stored for every later read) | the counts view: what the store has first, then each count as soon as it's done (a patch with only what's new), on the same answer or push | the count store |
| changes elsewhere | — | a commit that adds, removes, edits or picks a message, or writes a card, pushes the tab's views (`changedFor`), read again | the views | the tree, the card |
| search | `alternatives.search { query }` | parses it with the library and chat search's parser (`searchClauses`), matches every item's text with the engine's tokenizer (`textMatches`: the chat search's tokens and folding) | the matches view, a step of 200 alternatives at a time: what each step found (the source ranges matched, by item id) and how many are checked, of how many (a patch each); a newer search stops the old one | server: the tab's query; page: the search box's text ("Searching… n of N checked" until done) |
| select | (page) a number typed, or a click on a row: that row is selected and scrolled to | — | — | page: which row is selected |
| go | (old page) the swipe the old chat code makes: `swipe(…, { forceSwipeId })` with the item's index (a greeting: message 0, at its place among the openings); from a row's Go, the selected one's Go (or Enter), and `/swipe-go [message=<id>] <n>` | the chat's select action (node-addressed) | the chat redraws as for any swipe | the tree |
| delete (chat alternative) | (old page) `deleteSwipe(index, mesId, { ask })` | the node-addressed delete | the view pushed again (the old page tells the client to read it) | the tree |
| greeting ops | `alternatives.greeting { op, … }` with the greeting's card position and hash (edit, delete, move, default set / unset, add) | the card's greeting operation (`applyGreetingOperation`: refuses on a stale hash; one card's operations run one after another, whoever sends them) | the views; a refusal says why, and the editor keeps what was typed | the card |
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

The rows around the current one go on the page first, then the rest (in the next frames): the current one is drawn
before the whole list is there, both when it streams in and when a list seen before is shown.

Every row is rendered with the old page's message formatting (`messageFormatting`, handed to the new page), the
pipeline chat uses. Rows are formatted visible-first, then the rest in idle time, so the list draws at once with plain
text where a row isn't formatted yet; rows off screen skip layout and paint (`content-visibility: auto`). The list is
one list: no pages, no windowing.

Matches are highlighted in the rendered rows with `<mark class="match">`, coloured by `--match-color` (a theme
variable; custom CSS can override it). The server says which source tokens matched; the page marks those tokens in
the rendered text. (Exact positions in the rendered text need the one markdown parser, ED31.)

## Finding your place

- Numbering `#12 of 340`; a number typed selects that one and scrolls to it (it doesn't send the chat anywhere: Go
  does, and Enter in the number box, and `/swipe-go`).
- Opens scrolled to the current alternative, marked.
- Search hides what doesn't match without redrawing anything; clearing it scrolls back to the current one.
- Markers beside the list for matches and the current one; the list reserves its scrollbar (`scrollbar-gutter:
  stable`).

## Opening it

- The swipe counter on any message with more than one alternative, a tap or a click on every device (on a touch
  screen the counter takes taps past its text). The counter shows on every such message (the "Swipe # for All
  Messages" setting goes); user messages are included.
- The greetings button in character info.

## Adding an alternative

The page never holds alternatives the server doesn't have. A swipe added to a message is stored when it's added:
beside the stored message; at a first message shown from the card (no row of its own), as an opening of the chat
beside the card's greetings (the greeting stays the card's: a stored copy of it would be a duplicate once the card's
greeting is edited). A temporary chat (no character or group) keeps its swipes on the page.

## Creating a character

A character being created isn't on the server yet, so its greetings are the create form's (the pager there adds,
edits and removes them). The greetings button opens the list once the character exists.
