# Worldbuilding

The tool for building, reading and using worlds. The screens are on the canvas:
https://claude.ai/artifact/SWFyMbRtYtRZv8yPQxCwST (boards named below in **bold**).

A world is a lorebook: one book is one world. "World" is the word the UI uses.

## Entries

An entry has:

- **text**: what it is, read by people and sent to the model.
- **keys**: everything that brings it up. Each key is either a **name** of the entry or a **trigger**. Names are marked
  in the entry's extension data and are always a subset of its keys; every other key is a trigger.
- **title**: upstream's `comment`, which upstream uses as the entry's title ("doesn't ST use it as the title", owner,
  2026-11-03T06:27:20). It is never sent to the model and never matched. It is shown as a name only when it equals
  one of the entry's names; otherwise it is shown as plain text.
- **picture** (optional), and a **small picture** (optional) used beside the name where the look places one. The small
  picture defaults to the entry's picture; it can be a crop of it (a stored crop rectangle, the image untouched) or a
  different image. Images are stored by content hash.
- **relations** to other entries (below).
- **placement**: where and when it goes into the prompt (below).
- **look** (optional): how its names are drawn (below).

An entry with no name is shown by its title; with neither name nor title, by the opening of its text. Nothing is
invented for it.

Names are linked and drawn in the entry's look wherever they are written: chat messages, other entries' text, lists
and cards. The words that brought an entry into a reply are marked in the chat (the trigger mark).

### Imported books

An imported book keeps its titles and keys unchanged. Upstream has no names, so none of its keys is a name and nothing
in it links. The world's page offers, once and undoably, to mark as names the keys that equal their entry's title, and
says how many that is. Imported entries keep the order the book's own editor showed (`displayIndex`).

## Relations

A world is entries and **relations** between them. A relation has a name the author chooses ("in", "works at",
"owes"…) and goes from one entry to another. Any shape is allowed: an entry can be related to several entries by the
same relation, and cycles are allowed. References in text are one more relation, **mentions**, derived from the text
and never stored by hand.

A relation is stored on the entry it starts from, in its extension data: the relation's name, the target entry, and
the entry's position in that target's group. The position is a fractional order key, so moving an entry within a group
writes only that entry.

Relation names are the author's words, so the app never builds sentences from them. A relation is shown as
"relation: target" ("in: The Lantern House"), what points at an entry as "relation → entry" ("owes → Ilse Varro"),
and a change as the relation with its old and new target ("works at · The Pale Choir → The Lantern House").

On an entry's page, its relations are its first line ("in: The Lantern House · works at: The Lantern House · owes: The
Pale Choir"). Clicking one changes or removes it. **+ relation** offers the world's relation names first, then any
other name, then the target entry.

## Views

A world is seen through **views**, shown as tabs across the world's page. A view is:

- a **filter** on what is included;
- zero, one or two **axes**;
- a **grouping relation** inside each cell;
- an **order**;
- drawn as **cards** or as **rows**.

### Filter

The search box is the view's filter. Typing narrows whatever the view is showing. It is the app's one search, the card
library's, with the same syntax and pills everywhere. Each region has a search button that adds that region to the
filter as a chip. Typing on an entry's page goes to the world's page with that filter.

### Axes

An axis is one of:

- a set of **chosen filters**: each filter, or each combination of the two axes' filters, becomes a column or row. A
  view only shows the columns and rows picked.
- an **ordered value** laid out along the axis. Ordered values are whatever the world defines; none is built in. A
  timeline is one axis over a value of that kind; a map is two axes over a position drawn on the author's image.
  These values come from the state layer.

A relation filter ("in: Saltmarrow") is either **directly** or **at any depth**; the reader chooses per filter.
Directly means the entry has that relation to that target. At any depth also includes entries related to those
entries by the same relation, and so on down.

With no axes the view is the **overview**; one axis is a **board**; two is a **grid**. Drawn as rows, the same
selection is a **table** whose columns are fields the reader picks (placement fields included). Clicking a cell edits
it.

### Selecting rows

- A selection is stored as a filter plus exceptions, never as a list of entries. **Select all matching** stores the
  view's filter; unchecking rows after that adds exceptions; checking rows from nothing stores those rows as the
  exceptions to an empty filter. The bulk bar says what is selected ("All 14 matching, except 1") and offers Set, Move
  to, Also put in and Delete. A bulk action runs on the server over the filter minus the exceptions, as one action, at
  any size.
- Dragging down the checkbox column selects a range; Shift-click extends a selection.
- Rows reorder only from a grip at their left edge, and the grip exists only when the view's order is the author's
  own order (the world's order, or a group's order). Under any other order there is nothing to drag.

### Grouping inside a cell

Inside the overview and inside every cell of a board or grid, entries are grouped by the view's grouping relation:

- An entry's **card** shows what a reader needs to tell what the entry is and how it fits: its name in its look, its
  small picture, the first sentence of its text, and its relations line. Nothing from character cards ("there is zero
  fucking reason for lorebook ui to mirror character card ui", owner, 2026-11-03T04:21:19).
- An entry with members is a **region**, headed by the entry's own card with its member count, and holding its
  members' cards. A member with members of its own is a region nested inside, headed the same way.
- A region shows its first members in that group's order, enough to show what the group is, then a **"+N more"** tile
  that opens the region's entry, which lists every member.
- An entry in several groups appears in each, as the same entry.
- Drawing stops where it would repeat: an entry met again inside its own region is drawn as its card, without opening
  its region again.
- The top of a cell is its entries with no relation of the grouping kind.
- Grouping by "nothing" draws plain cards.

### Moving entries between groups and cells

- A card's menu (on pointer or focus) has **Move to…** (replaces this membership), **Also put in…** (adds a membership
  and keeps the old one; the entry is not copied) and **Take out of [group]**. Move to and Also put in open a search
  for the target.
- Dragging a card to another region or cell changes the relations that define where it is. While dragging, a label on
  the card shows the change as the relation with its old and new target ("works at · The Pale Choir → The Lantern
  House"), with "Alt: keep both" under it, and it changes while Alt is held. A cell defined by anything other than
  relations does not accept a drop. Dropping between cards sets the position in that group.
- Keyboard: Alt+arrows move a card within its group.

### Saved views

- The author's views are stored on the world and travel with it.
- A reader can change any view. The changed tab shows a dot and **Save** / **Discard**. Saving stores the change for
  that reader, layered over the author's view, which stays as it was; **Reset to the world's** drops the reader's
  layer. A view's settings resolve reader over world, the same way settings resolve levels.
- A reader can add views of their own; they are stored with the reader.

## Working at any size

Everything works at 10 billion entries with no cost per entry. The page holds only what it shows.

- **Members of a group** come from an index per (relation, target), in the group's order. A region reads its first few.
- **The top of a cell** comes from an index per relation of the entries that have no relation of that kind. It is kept
  as relations are written: an entry joins it when its last relation of that kind is removed and leaves it when it
  gains one. Changing the grouping relation is one lookup, never a scan. The same index answers filters of the form
  "has no relation of this kind".
- **"+N more"** comes from a count per (relation, target) kept on each write, never counted on read.
- **Cells** of a board or grid are intersections of filters. Their cards are read a page at a time from the indexes.
  Their counts cannot be kept on write, so a cell's count is read up to a cap and shown as "1,000+" beyond it.
- **At any depth** is answered by walking down from the target through the member index, keeping a visited set, so
  its cost grows with the results, not with the world, and cycles end the walk.
- **Rows** are read a page at a time in the view's order, from that order's index.
- **Selections** are a filter plus exceptions, so selecting and acting on millions of entries costs the same as on a
  few.
- **Repeats** are caught along the drawing path (an entry already open above), never by walking the graph.
- **Mentions** come from the book's search index, checked with the activation matcher, so a mention is there exactly
  when recursion would see it (`src/world-info/references.js`, `engine/src/store/references.rs`). "Mentions it" on an
  entry is the same index read the other way.
- **Filters** run on the server, against the indexes, and show results as the reader scrolls, without totals.
- An entry's size and hash, and its book's, are kept by the entry's own writes (`engine/src/store/book_stats.rs`).

## Looks

A **look** is how a name is drawn. It is one mechanism for every named thing: entries, characters, personas,
bookmarks, worlds. A thing's look applies wherever its name is drawn: mentions in text, a message's name line, lists
and cards. One editor, the **Look** screen, opens from any named thing.

### Storage

A look is stored as CSS declarations on the name's own span, limited to what cannot reach outside it: no selectors,
nothing that moves or sizes the span or touches anything else (no position, margins, display, size, `content`), and
animations only by the app's own names. Declarations outside those limits are not stored. `url()` is allowed: banning
it is "arbitrary and bad" (owner, 2026-11-03T06:39:38). A look may use the forms the app's marks use.

The visual editor covers the common effects (below). Anything else stays as CSS, visible and editable on the Look
screen.

### The cascade

A look resolves through a fixed order, most specific last:

1. the **theme**
2. the thing's **world**, when it has one
3. the **shared looks** the thing uses, in the order it lists them
4. the **thing** itself

A **shared look** is a named look ("The Vell family look"): a record of its own, which things refer to by id. It lives
at the level where it is defined, using the cascade's own levels:

- made in a world, it belongs to that world and travels with the world's export;
- made at the user's level (with the theme), it is available in every world and is not exported.

Where it lives is chosen while making it ("New shared look in this world…" or "New shared look for every world…"), with
no extra step. It can be moved between the two levels later. The user's own shared looks are also listed and managed in
the theme settings. Resolution only follows the ids. Looks never pass along relations.

### States

The resting look and each state are separate layers. The states are: **message pointed at**, **word pointed at or
focused** (keyboard focus counts as pointing), and **selected**. Each layer resolves its own cascade, theme → world →
shared looks → thing, most specific wins. What is drawn is the resting layer with the active states on top in that
order; each property comes from the highest active state that sets it, otherwise from rest.

### Effects in the visual editor

- **Color**: one color or a gradient (stops and direction).
- **Glow**: color and size.
- **Outline**: color and width.
- **Shadow**: color, distance, softness.
- **Underline**: solid, double or wavy; color; thickness.
- **Letters**: spacing, weight, italic, small capitals.
- **Typeface**: a font the app ships, or one uploaded into the world. Uploaded fonts are stored by content hash like
  images; the app writes the `@font-face` itself; the look names the font. A look never sets size.
- **Blur**: amount.
- **Motion**: shimmer, breathe, flicker, drift or float, with speed. Every motion has a still frame, shown to readers
  whose device asks for reduced motion.
- **Picture beside it**: the small picture before and/or after the name.
- **Note above it**: a few words drawn above the name, taking no space in the line.

### The trigger mark

The words that brought an entry into the last reply are marked in the chat. The mark is a look set at the theme level,
in the same editor, per state: **dotted** (the default), **dashed**, **large dots** or **none**, with color and opacity.
"Only when pointing at the message" is none at rest and dotted when the message is pointed at. The mark is drawn outside
the name's span, so no name look can cover it. Custom CSS can restyle it through its class.

The marked spans come from each reply's activation record (below), drawn only where the stored text still matches.

## Placement on the entry

Where an entry goes in the prompt belongs to the entry, and nothing about it stands on the entry's page. A button in
the entry's header, beside the Look button, opens **In the prompt** as a popover; the button carries a dot when anything
differs from the defaults. The popover shows the entry's size in tokens and a sentence whose parts are edited by
clicking them (the field names are the app's, so these sentences are fixed wording):

- **Comes in** when it's brought up / always / never (upstream `constant` and `disable`).
- how often: every time / N% of the time (`probability`, `useProbability`).
- **Goes** before or after the character's description, before or after the example messages, at the top or bottom
  of the author's note, or into the chat N messages up (`position`, `depth`, `role`).
- **Order among entries in the same place** (`order`).
- **+ More** adds the rest as sentences when set: stays for N replies (`sticky`), waits N replies before coming up again
  (`cooldown`), only after the chat has N messages (`delay`), needs other words written too (`keysecondary`,
  `selectiveLogic`), only one of a group comes in (`group`, `groupOverride`, `groupWeight`, `useGroupScoring`), looks
  further back for its keys (`scanDepth`), and the rest of upstream's fields.

## Screens

- **In the chat** (`Main`, `PhoneChat`): names drawn in their looks and linked; trigger words marked. Pointing at a name
  or a marked word shows its card (above) with what brought it up for the last reply. A word that brought up several entries shows all of them. Clicking opens the entry;
  on a phone, a tap shows the card from the bottom and Open goes to the entry.
- **The world's page** (`Front`, `World`, `Huge`, `PhoneWorld`): the world's picture, name and description, then the
  view tabs and the view bar (Columns, Rows, Inside grouped by, Order, Cards or Rows; Save and Discard when the view is
  changed), then the view.
- **Board, grid and rows** (`Board`, `Grid`, `Table`): as above under Views.
- **An entry** (`World`, `PhoneEntry`, `Write`): relations line; picture and title; **Brought up by** with names in the
  entry's look and triggers plain (clicking a key switches it between name and trigger or removes it; **+ name**,
  **+ trigger** add keys); the text, edited in place with names linked as typed; selecting words offers a new entry with
  that name (placed right after the current one), or adding the words to an existing entry as a name or a trigger;
  what points at it, one section per relation ("owes → Ilse Varro", as full-size cards, then "mentions → Ilse Varro"
  with the sentences); **+ New entry** with the relation it will get shown beside it. The header holds the Look button,
  the In the prompt button, and the ⋯ menu (Move to another world, Delete).
- **Moving between groups** (`Arrange`, `Drag`): as above under Moving entries.
- **Imported book** (`Imported`): as above under Imported books.
- **Look** (`Style`, `LookChar`): one live preview of the name, which really responds to pointing, focus and
  selection; under it, four small scenes, one per state (as it sits, its message pointed at, the word pointed at, the
  word selected), all visible at once, with the state's name as a tooltip; clicking a scene shows that state in the
  preview and is the state being edited. With motion, the still frame sits in the preview's corner. The picture and
  the note are placed on the preview itself: pointing beside the name shows a faint picture to place before and/or
  after it; pointing above it shows where to type the note; clicking a placed picture opens the small picture's
  choices (whole picture, crop, another image, remove). **Uses** lists the shared looks the thing uses, each marked "this world"
  or "everywhere", with **+ shared look** (existing looks, then a new one in this world or for every world). One
  toolbar: each effect's button is a letter drawn with that effect, bright when the state uses it, its name as a
  tooltip; clicking one opens its controls with **Applies to** (theme, world, each shared look in use, just this
  thing, or a new shared look in this world or for every world) and **Reset**. The toolbar's last button shows the CSS of the chosen
  state at this thing's level: the declarations the controls produce, dimmed, and the rest as editable text. An edit
  goes to the level that supplies the value. Below, the name where it is drawn: a mention (with the trigger mark,
  which is edited by clicking it), a message's name line, a list, a card.

## Compatibility and storage

- Entries are stored per book in the engine (`engine/src/store/books.rs`), keyed by upstream `uid`, ordered by the
  entry index (`displayIndex`).
- This tool's data on an entry (which keys are names, relations, the look, the small picture) lives in the entry's
  `extensions`. Card-book import keeps `extensions` (`src/world-info/candidate-resolution.js:65`) and export spreads it
  back (`src/character-card-normalize.js:241`), so it round-trips through card books. Card-book fields map as
  `convertCharacterBook` does: `keys`→`key`, `secondary_keys`→`keysecondary`, `comment`→`comment`,
  `insertion_order`→`order`, `enabled`→`!disable`, position from `extensions.position` or
  `before_char`/`after_char`, and the rest from `extensions` (`src/world-info/candidate-resolution.js:18`).
- A world's own data (its views, its grouping default, its shared looks, its fonts) is stored on the book.
- World files are imported through `importWorldInfoFromRaw` (`src/endpoints/worldinfo.js`).
- Each reply stores its activation record in the same write as the reply, one per alternative: each entry that came
  up, why (matched key and where, always, sticky, recursion through another entry), the stored messages and spans each
  key matched, the entries that brought it in, its position, depth and role, and what was cut and why (budget, chance,
  inclusion group) (`src/world-info/activation-record.js`). The trigger mark and the hover card's "brought up by" read
  it.

## Architecture

Little here is specific to worlds. Looks, views (filters, axes, grouping, tables, saved views), selections, relations
and search are general mechanisms of the app, built once for every kind of thing (entries, characters, personas,
bookmarks, chats); worldbuilding is their composition plus what is specific to lore: keys, activation, placement.

- **Store** (engine): entries, names, relations and looks as above; the indexes and kept counts under Working at any
  size; views stored on the world, a reader's changes layered over them through the settings cascade.
- **Server**: one action per user action, answering with everything the page needs to draw its result; filters
  compile to index reads; a selection is a filter plus exceptions, so a bulk change is one action at any size; looks
  are resolved and sanitized into one stylesheet of per-thing classes. Activation reads keys exactly as before.
- **Page**: built on interact (`~/git/interact`) and keybinds. Worldbuilding's views are interact components with
  extensions; the app supplies sources over its server index, so nothing beyond what's on screen is loaded. A gap in
  interact is fixed as a general extension point there, never as a worldbuilding feature. The page holds only what is
  on screen. One name renderer
  draws every name in the app, so a look applies everywhere at once.
- When this lands, the old World Info drawer (`public/scripts/world-info.js`) and everything only it uses are removed
  in the same change.
