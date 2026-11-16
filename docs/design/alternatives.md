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
- `{ opening: true }`: the open chat's first message: its stored openings, then the card greetings no stored opening
  already is (the engine's `openingAlternatives()`, the order message 0's swipes have; a group's are every current
  member's, below). A stored opening linked to a card greeting (`greeting-ids.md`) is marked with that greeting's card
  position; a card greeting is on its character's card (a group's: its member's).
- `{ greetings: <avatar> }`: a character's card greetings, in card order (the greetings button in character info).
  When the tab's open chat offers this card's greetings (this character's, or a group's it is a member of), each
  greeting also says where it is among the chat's openings, so it can be shown in the chat.

One component, the same controls on the same rows wherever it's opened: the card's operations (add, edit, reorder,
default, delete from the card) on every card greeting, in either list, each on that greeting's own card (in a group's
list, its member's); delete from the chat on every stored alternative; reorder on a message's alternatives
(`alternatives.move`, a place in `ordered-lists.md`). A tree's openings reorder only as card greetings: the stored ones
are grouped by greeting, and a greeting moves among its own card's greetings only. Add puts a greeting on the list's
card: a character's list's, a character's chat's; a group's first message has no one card to add to.

An item's id is its node id; a card greeting not stored in the chat is known by its id and its character
(`unstoredGreetingNodeId`, `greeting-ids.md`). A row is a card greeting when the server names it one (an opening's
`greeting`: id, character and text hash), never by its text.

The tab looks at one target at a time. The server keeps the look per tab (target, tokenizer, search, the list last
read) and answers three views: `alternatives.list` (the items), `alternatives.counts` (token counts by item id) and
`alternatives.matches` (the search's matches by item id), so a search or a count never resends the texts.

## Data flow

| Step | The page sends | The server does | It answers / pushes | Who holds what |
|---|---|---|---|---|
| open | `alternatives.open { target, tokenizer }` (`tokenizer`: the on-screen connection state the count routes already take) | keeps the tab's look; reads the target's alternatives | the three views: the list (items: id, place, text, name, role, date, node id, its card greeting's character, id, card position and hash; the current one; each card's list), the counts the count store has, no matches. A long list streams (not decided): the answer is NDJSON, its first line the list's rows around the current one (`complete: false`), the next the whole list (a view read in parts: each part newer than the one before, older than any read started after it) | server: the list, counts, the tab's look; page: the latest views, and (not decided) the last whole list of each target this browser showed (IndexedDB, by target and the version the server gave it, the newest 16; shown at once when that target opens again, also after a reload, until the server's whole list is here) |
| counts | nothing | counts the texts the store didn't have, once each, nearest the current one first, a few at a time, yielding between texts, through the token count store (stored for every later read) | the counts view: what the store has first, then each count as soon as it's done (a patch with only what's new; those done within 50 ms of each other in one), on the same answer or push | the count store |
| changes elsewhere | — | a commit that adds, removes, edits or picks a message, or writes a card, pushes the tab's views (`changedFor`), read again | the views | the tree, the card |
| search | `alternatives.search { query }` | parses it with the library and chat search's parser (`searchClauses`), matches every item's text with the engine's tokenizer (`textMatches`: the chat search's tokens and folding) | the matches view, in steps of 200 alternatives (the first sent at once, then as many as fit in 30 ms a part): what they found (the source ranges matched, by item id) and how many are checked, of how many (a patch each); a newer search stops the old one | server: the tab's query; page: the search box's text ("Searching… n of N checked" until done) |
| select | (page) a number typed, or a click on a row: that row is selected and scrolled to | — | — | page: which row is selected |
| go | (old page) the swipe the old chat code makes: `swipe(…, { forceSwipeId })` with the item's index (a greeting: message 0, at its place among the openings); from a row's Go, the selected one's Go (or Enter), and `/swipe-go [message=<id>] <n>` | the chat's select action (node-addressed) | the chat redraws as for any swipe | the tree |
| delete (chat alternative) | (old page) `deleteSwipe(index, mesId, { ask })` | the node-addressed delete | the view pushed again (the old page tells the client to read it) | the tree |
| greeting ops | `alternatives.greeting { op, avatar, … }` with the greeting's character and its card position and hash (edit, delete, move, default set / unset, add); the server takes only a card the list shows | the card's greeting operation (`applyGreetingOperation`: refuses on a stale hash; one card's operations run one after another, whoever sends them) | the views; a refusal says why, and the editor keeps what was typed | the card |
| greetings changed | (page) hands the new list to the old page | — | the old page applies it as a greeting save does (pager, CHARACTER_EDITED for the chat's first message) | the card |
| close | `alternatives.close` | forgets the tab's target and query | — | — |

Rules checked:
- The server owns the list, the counts, the query and the matches; the page renders the latest view and keeps
  nothing else (an editor's typing until it's saved), as `CLAUDE.md`'s Architecture rules have it.
- Nothing on the page counts tokens or matches text.
- Opening shows the dialog at once: the client's last view of the same target, else the dialog with its list
  loading; nothing waits on a request per row (one view, counts pushed after).
- Views carry versions; the newest wins whatever order they arrive in.
- Old chat code keeps what it owns (the chat's swipes and selecting one); this area doesn't reimplement it.

## Rendering

The rows around the current one go on the page first, then the rest (in the next frames): the current one is drawn
before the whole list is there, both when it streams in and when a list seen before is shown.

Every row is rendered with the old page's message formatting (`messageFormatting`, handed to the new page), the
pipeline chat uses. Rows are formatted visible-first, then the rest in idle time, so the list draws at once with plain
text where a row isn't formatted yet; rows off screen skip layout and paint (`content-visibility: auto`). The list is
one list: no pages, no windowing.

Matches are highlighted in the rendered rows; how they're marked is not decided (the code uses `<mark
class="match">`, coloured by the theme variable `--match-color`, `public/css/alternatives.css:2`). The server says
which source tokens matched; the page marks those tokens in the rendered text. (Exact positions in the rendered text
need the one markdown parser, ED31; not showdown: "depending on showdown at all is wrong", owner,
2026-09-23T06:47:16.)

## Finding your place

- Numbering `#12 of 340`; a number typed selects that one and scrolls to it (it doesn't send the chat anywhere: Go
  does, and Enter in the number box, and `/swipe-go`).
- Opens scrolled to the current alternative, marked.
- Search hides what doesn't match without redrawing anything; clearing it scrolls back to the current one.
- Markers beside the list for matches and the current one; the list reserves its scrollbar (`scrollbar-gutter:
  stable`).

## Opening it

- The swipe counter shows on every message, user messages included. On a message with one alternative, other than
  the last message, it is dimmed (`public/style.css:1371-1373`): "idk, wdyt" (owner, 2026-11-01T14:58:04), then "maybe
  it cold be dimmed though" (15:50:50). With more than one alternative, a tap or a click on it opens the list on
  every device (on a touch screen the counter takes taps past its text).
- The greetings button in character info.

## Adding an alternative

"we don't have chats AT ALL, instead we have 'ephemeral' greeting messages" (owner, 2026-09-25T14:35:33). The page
never holds alternatives the server doesn't have. A swipe added to a message is stored when it's added:
beside the stored message; at a first message shown from the card (no row of its own), as an opening of the chat
beside the card's greetings (the greeting stays the card's: a stored copy of it would be a duplicate once the card's
greeting is edited). A temporary chat (no character or group) keeps its swipes on the page.

Where the new alternative goes is part of the add (`ordered-lists.md`):
- a new swipe goes at the end;
- saving an edit as a new alternative puts it directly after the one it was made from.

Its number, the counter and a typed number are a rank and a select in the list, never a read of the whole list.

## An edit with another alternative's text

"An edit that becomes identical to an existing greeting or swipe goes to that one, with no duplicate", for every
message: a reply's alternatives are its siblings; a first message's are the stored openings and the card greetings no
stored opening holds. Identical is the exact text, whitespace included, by the same author (owner, 2026-11-16): who
wrote it, a user message's persona by its avatar key (`persona`; a message that records none is one author), any
other's character by its id (the speaker stored with it, or for the edit the one it is stored as). Names never count:
two personas or two characters with one name are two authors. A card greeting's author is its character, so a user's
opening, or another character's, with a greeting's text is not that greeting.

The same author (`authorOf`) decides when a message written to the tree is one already stored beside it (`twinKey`):
a message sent or grafted, an opening added, an alternative imported.

The server decides (`sameAlternative`, `src/chat-engine.js`), in the request that saves the edit: an edit of a stored
message (`/api/chats/message/edit`); of a card greeting not stored, which is stored as an opening
(`/api/chats/message/select` with the opening); a new alternative typed into an empty swipe (`/api/chats/message/append`
with `typed`, or the select with the opening for a first message); an edit saved as a new alternative
(`/api/chats/message/alternative` with `typed`). A card greeting shown unedited is itself, not the same as another.
When the text is another alternative's:
- the edit is not stored, and the message it was made on stays as it was stored;
- a finished edit (Done, and any save that isn't saving while typing) makes the session show that alternative, with
  what goes under it; the answer (`shown`) has the path from the message down, and for a first message its openings
  and the end's draft. The page shows the edit at once, then what the answer says, with the notice "The text is the same
  as alternative N, so the message shows that one." (a toast for now: one call, `_noticeSameAlternative` in
  `public/scripts/chat-store.js`);
- a save while typing (saving edits while typing on) is refused with the alternative it matches, and the page keeps
  the editor's text unsaved, so typing through another alternative's text never moves the editor; the next save, or
  Done, decides again.

With saving while typing, the message being edited holds what the last save stored when Done goes to another
alternative.

An opening whose text is a card greeting's but for whitespace is stored, and is not linked to that greeting
(`greeting-ids.md`: the exact text only), so the greeting stays among the openings beside it.

## A group chat's first message

A group chat has one first message, as a character's chat has: "every member's greetings in the first message"
(owner, 2026-11-16). Its alternatives are its stored openings and the card greetings of every current member, in
member order and each card in its order, that no stored opening already is; each card greeting is by its member (its
name, avatar and macros are the member's). It is one implementation with a character's chat's
(`ChatEngine.cardGreetings`: a character's tree offers its card's greetings, a group's tree its members'), so
everything above holds for it: swiping, an edit of a greeting not stored stored as an opening by that member, the
same text by the same author, linking by exact text, remembered choices, the list and its counter, the card's operations
in the list (each on its member's card), "Use in chat" and "Show in character info".

- A new group chat shows its first member's default greeting (the first member with greetings; its first greeting
  when its card has no default), as a character's new chat shows its card's default.
- A stored opening records its member as its speaker (the page sends the greeting's `original_avatar`).
- Members added or removed: the card greetings offered are the current members'. Stored openings stay: a removed
  member's come after the members' greetings and the openings from no greeting, grouped by greeting, and go back
  among its greetings if it is a member again. A session's choice of a removed member's greeting gives way to the
  default.
- Group chats stored before this kept their members' openings as a chain (the first member's at the root, each
  next one under the one before), stored with no speaker. They are not rewritten: the chain's root is a stored
  opening from no greeting (it has its greeting's id but no link, and no speaker), shown after the members' card
  greetings among the first message's alternatives, and the rest of the chain stays as messages under it. A session
  that was in the chain stays there.

## Creating a character

A character being created isn't on the server yet, so its greetings are the create form's (the pager there adds,
edits and removes them). The greetings button opens the list once the character exists.
