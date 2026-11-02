# lorebook-editor

**Superseded (2026-10-03) by `2026-10-03-lorebook-wiki.md` for the ui and its frame. Its research (2), debugging (3e), import (3f) and book defaults (3d) are reused there by reference.**

Status: designed, not built. Open: 3 (below).

## root cause

The World Info drawer shows every entry as its ~50 stored fields laid out flat, in storage order, with the same
weight. Nothing distinguishes what an entry *is* and *does* (its subject, when it fires, what it costs) from how it is
tuned (position, depth, order, probability, timing, groups, recursion, scan flags), and nothing distinguishes a value
someone chose from a default nobody touched. The drawer also has no memory of what actually happened: whether an entry
fired, why, and what it cost is computed on the server at generation time and thrown away. So every reader and writer
has to reconstruct meaning from raw settings, and the debugging question ("why did this fire / not fire", "what is
eating my context") can't be answered from the editor at all.

Everything below follows from three moves: show meaning first and tuning on demand; show a setting only where it
differs from what the entry would do anyway; keep and show what actually happened.

## {{user}}'s words this rests on

- "world info drawer needs a rework tbh i think"; "title textarea should get a tooltip with tis full text";
  "strategy + position + depth + order + trigger% + 'move/copy to another lorebook' + duplicate + delete... are just
  clutter usually i think"; "think about what a good lorebook editor shows, what both readers and writers will want to
  know and/or have access to at a glance" (10-03)
- on WorldInfoInfo (which shows the entries active in the last message): "honestly i'd rather replace it with real
  saving and optional highlighting of matches per message" (09-16); "we should get around to the lorebook trigger
  highlight ui stuff (trigger info saved on each message) eventually too" (09-28)
- "vastly simplify options with advanced mode toggle (defaulting to off)", "way better ux … adding/maintaining …
  lorebooks", sections "by default collapsed BUT showing token counts e.g. 'Main Prompt (xyz tokens)'" (09-11); but on
  hiding settings behind advanced mode: "please fucking don't, just put it in a collapsible drawer" (09-12)
- "wait shouldn't we be able to import lorebooks like we do with images?" (09-28)
- "it's about how many entries are displayed per page maybe?" (09-28)
- CLAUDE.md: scale (a book can hold thousands of entries; nothing O(total) in the page), client sends actions, drafts
  survive reload, multi-user locks, "modals suck", plain language, maximally intuitive. Built pieces to reuse: the
  views pill builder and saved views (2026-10-02 plan), the editor layer, the live editor, the drawer stack.

## 1. who uses it, for what

| who / when | what they need | how often | what's in the way today |
|---|---|---|---|
| **writer, new book** | write an entry: subject, text, when it should come up; check it reads right | constant while writing | every new entry opens ~50 controls; the 4 that matter are buried among them |
| **editor, big imported book** (hundreds of entries) | find the entry about X; see which ones are always on; fix a few; spot broken ones | often | 25 per page, no search over content, no sort by cost, no way to see "what's unusual about this one" |
| **reader, someone else's world** | understand the world: what topics exist, what each says, how they relate | occasionally, long sessions | the list is a settings form, not something you can read; titles are often empty or truncated |
| **curator, merging/splitting books** | move or copy groups of entries, find duplicates, compare | rarely, in bursts | one-entry-at-a-time move/copy/duplicate/delete sitting on every row |
| **debugger, mid-chat** | why did this fire / not fire; what's taking my context; which entries are in this reply | very often for heavy lorebook users (they install WorldInfoInfo for it) | the editor knows nothing about what happened; the answer lives in a separate extension or the prompt inspector |
| **player, mid-chat** | quickly toggle or tweak one entry, see which book is active | often, quick | the drawer covers the chat; finding the entry takes paging |

The debugger row is the one current editors serve worst everywhere (see 2), and the one {{user}} asked for twice.

## 2. how others do it

- **SillyTavern upstream** (our `world-info.js`, the `#entry_edit_template` markup): accordion rows; collapsed row
  already carries title, keys, state selector, position, depth, order, trigger %, kill switch, move/duplicate/delete.
  Gets right: everything is reachable; collapsed rows are scannable for experts. Gets wrong: the collapsed row is
  already a settings form; defaults look identical to deliberate choices; no activation history; 25-per-page paging
  with search over title/keys only. ([docs](https://docs.sillytavern.app/usage/core-concepts/worldinfo/))
- **WorldInfoInfo** (extension, several forks): a book icon listing entries active in the last generation; forks add
  `/wi-report` with which keyword triggered each entry and at which recursion step. Proves the demand; lives outside
  the editor and only covers the last message. ([LenAnderson](https://github.com/LenAnderson/SillyTavern-WorldInfoInfo),
  [User-Teixeira](https://github.com/User-Teixeira/SillyTavern-WorldInfoInfo))
- **NovelAI Lorebook**: master–detail (entry list left, editor right); list item = title + enabled toggle; editor in
  tabs (Entry / Placement / Phrase Bias / Advanced Conditions); **Categories** carry default placement that new
  entries inherit and can be pushed to all entries; Placement is explicitly "for experienced users". Gets right:
  defaults live one level up, so most entries never show placement at all; the essential tab is short. Gets wrong:
  tabs hide that something non-default is set; no activation debugging beyond the context viewer.
  ([docs](https://docs.novelai.net/en/text/lorebook/))
- **Lumiverse** (where the user's broken book came from): one **state** control with three values, Active (keyword) /
  Constant / Disabled, instead of separate flags; "one concept per entry" guidance; a **Dry Run** that shows which
  entries would activate and where they'd land in the prompt; exports Lumiverse / Character Book / SillyTavern
  formats. ([guides](https://lumiverse.chat/guides/), [creating entries](https://lumiverse.chat/guides/world-books/creating-entries/),
  [import/export](https://lumiverse.chat/guides/world-books/importing-exporting/))
- **RisuAI**: list with drag-and-drop ordering and folders (encoded in entry data), regex keys by a leading `/`,
  "Always Active" toggle in the entry. Folders make big books navigable. ([wiki](https://github.com/kwaroran/RisuAI/wiki/Lorebook),
  [deepwiki](https://deepwiki.com/kwaroran/Risuai/5.4-lorebook-system))
- **Sudowrite Story Bible**: lore as typed cards (characters, settings, items, lore, rules), written for the human
  first, and the AI reads them. Gets right: it reads like a reference, not a config. Not keyword-triggered, so it
  doesn't face the debugging problem. ([what is Story Bible](https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/what-is-story-bible/jmWepHcQdJetNrE991fjJC))
- **Notion / Airtable databases**: one table, many *views*: the user picks visible columns, filters, sort and grouping
  per view; a record opens in a side panel with every property. Gets right: what's shown at a glance is the user's
  choice per task, not fixed. The views plan already brought this model to the character list.
- **Obsidian / World Anvil**: links and backlinks between articles ("mentioned in"). Maps directly onto recursion:
  entry A's content containing entry B's key is a link from A to B.

Patterns worth taking: master–detail with a short essential pane (NovelAI); defaults one level up (NovelAI
categories); a single state control (Lumiverse); a dry run / activation report (Lumiverse, WorldInfoInfo);
user-chosen views over a big table (Airtable, our views); links between entries (Obsidian).

## 3. the design

### 3a. what an entry *is* at a glance (the row)

A row answers four questions, in this order, and nothing else by default:

1. **What's it about**: the title; if empty, the first keys; if none, the first line of content. Full text in a
   tooltip ({{user}}'s words). One line of content preview under it, so a reader can skim without opening.
2. **When does it come up**: a single state control replacing the kill switch + strategy selector: **Off · On
   keywords · Always · Vector** (Lumiverse's model, plus vector which upstream has). For "On keywords", the keys as
   chips (regex keys marked), and secondary keys with their logic in plain words ("…and also: x, y").
3. **What does it cost**: its token count. Always-on entries cost this in every prompt, so the book header totals the
   always-on cost ("Always on: 7 entries, 1,240 tokens").
4. **Did it come up**: in the open chat, "last used: message 42" (or "not used in this chat"), from 3e.

Then, only where they differ from what the entry would do with nothing set, small **exception badges**: "depth 2",
"50%", "sticky 3", "after char defs", "group: weather", "never recurses", "chars: Alice". An entry with all defaults
shows no badges at all. This is the core move: the user's "clutter" list is clutter *when it's default*, and
information when it isn't; the badge shows exactly the second case.

Rejected: a fixed row with position/depth/order columns (upstream; noise on the 90% of default entries); hiding
everything advanced behind a mode switch ({{user}}: "please fucking don't"); tabs (hide that something non-default
is set).

### 3b. one step away (the entry opened)

Opening an entry (click the row) shows the essentials: title, state, keys (+ secondary + logic), content, token
count, activation history for this chat. Below them, collapsible sections with a one-line summary each, so a closed
section still says what's inside and whether it's default:

- **Placement**: "Before character definitions · order 100 (default)" → position, depth, role, order, outlet
- **Chance & timing**: "Always · no sticky/cooldown/delay" → trigger %, sticky, cooldown, delay
- **Groups**: "None" → inclusion group, weight, prioritize, group scoring
- **Matching**: "Book default" → scan depth, case-sensitive, whole words, extra sources (description, persona, …)
- **Recursion**: "Normal" → non-recursable, prevent further recursion, delay until recursion level
- **Where it applies**: "Everywhere" → character/tag filter, generation triggers
- **Automation**: automation id

A section with anything non-default opens by default and its summary is highlighted. Every upstream field stays,
stored as today; only where it sits changes.

Where it opens: inside the drawer, the entry expands in place (list context kept, scroll position kept); maximize
moves it to the editor layer (06cffa68f) for long content. Rejected: a side pane inside the drawer (the drawer is
too narrow for two panes); a modal ("modals suck").

### 3c. the book

- **Header**: name, entry count, always-on cost, "used by: 3 characters, 2 chats" (from the chat-lorebook reverse
  map plan), and the book's defaults (3d).
- **Navigating big books**: the entry list is a server-paged list (the views mechanisms: cursor paging, work cap, no
  whole-book load in the page), searchable over title, keys *and* content; filter pills (reuse the pill builder):
  state, has keys / no keys, tokens range, used / not used in this chat, has non-default settings, group, position;
  sort by order (prompt order), title, tokens, last used; group by state / inclusion group / position. Filters and
  sort can be saved as views per book (saved views plan, step 3), e.g. "always on, by cost".
- **Reading mode**: a toggle that shows the list as a document: titles as headings, content rendered as prose,
  settings hidden. For the reader row in 1. Same data, different view.
- **Links**: an entry whose content contains another entry's key links to it ("mentions: Castle, Duke"), and shows
  backlinks ("mentioned by: 4 entries"). This is exactly what recursion will do at generation time, made visible
  before it happens.
- **Actions**: per-entry actions (duplicate, move/copy to another book, delete) go into a ⋯ menu on the row; the same
  actions apply to a selection (checkboxes, select all over the current filter, as the character list does). Delete
  is undoable for a while (a notice with Undo), not confirmed by a dialog.

### 3d. defaults one level up

Book-level defaults for placement, chance & timing, matching and recursion (NovelAI's category defaults, applied per
book). An entry with no value of its own uses the book's; the badge and section summaries say "book default". Changing
a book default changes every entry that inherits it, and says how many. Global settings (scan depth, budget, case,
whole words) remain the fallback below the book. Stored as an internal format (CLAUDE.md: ours, hard cutover);
export writes each entry's effective values so upstream and other apps read the same thing. See open 2.

### 3e. what actually happened (debugging)

- The server already decides activation at generation time (`activateWorldInfoEntries`,
  `src/chat-completion-generation-input.js`). It now **stores, with each reply**, which entries were used and why:
  matched key (and where: which message or source), recursion step, or "always on"; probability roll; where it was
  inserted; tokens. Bounded: a list of entry ids with small records per reply.
- **On the message**: a small lorebook indicator with the count; opening it lists the entries and why each fired,
  each linking to the entry. Optional highlighting of the matched keywords in the message text (off by default,
  per "optional highlighting"). This replaces WorldInfoInfo, saved instead of lost at reload.
- **In the editor**: "last used" per entry in the open chat, and in the opened entry the list of messages it fired on.
- **Dry run**: a "what would come up now" button on the book and in the prompt view: runs activation for the next
  message without generating, shows which entries would fire, why, and the total cost. Also answers "why didn't it
  fire": for an entry that didn't, which condition failed (no key in range, probability, cooldown, group lost,
  filter, budget).
- **Budget**: when the budget cut entries, the reply's record says which, so "it should have fired" has an answer.

### 3f. import of other formats

Normalise on import (server side, `importWorldInfoFromRaw`), and on read for books already stored with the mismatch
(hard cutover, once):
- entry key ≠ `uid` (the Lumiverse book): re-key to free integer uids, set `uid` and `displayIndex` to match.
- card-book / Lumiverse fields map as `convertCharacterBook` does: `keys`→`key`, `secondary_keys`→`keysecondary`,
  `insertion_order`→`order`, `constant`, `selective`, position `before_char`/`after_char`, `enabled`→`disable` (see
  open 1), `extensions.*` → ST fields where named the same.
- bulk import from a folder, like images ("import lorebooks like we do with images"), through the existing local
  import scan.
- the drawer never drops an entry silently: an entry it can't draw shows as a broken row naming the problem
  (today `getWorldEntry` returns nothing and the book looks empty).

### 3g. rules that apply throughout

Multi-user: an entry being edited by someone is shown locked with their name; others can read it. Drafts of an open
entry survive reload. The client sends actions (per-entry field updates, moves), never the whole book. Plain words
everywhere ("Comes up when the chat mentions…", not "Primary Keywords"; position names in words). New keys in the help
hotkey registry. Compat: every upstream world-info export, event (`WORLD_INFO_ACTIVATED` keeps firing with what it
carries), route and stored field keeps working; only presentation changes.

## steps

1. **Activation records on replies** (3e storage) and the message indicator listing them. Standalone value first:
   it answers the most-asked question even before the editor changes, and the editor's "last used" needs it.
2. **Import normalisation and the broken-row display** (3f). Fixes the user's book; small.
3. **The row** (3a): state control, keys chips, tokens, last used, exception badges, title fallback + tooltip, ⋯ menu.
4. **The opened entry** (3b): essentials + summarised sections, in place, maximize to the editor layer.
5. **The book list at scale** (3c): server paging, search over content, filter pills, sort, group, per-book views.
6. **Bulk selection and undoable delete** (3c actions).
7. **Book defaults** (3d), after open 2.
8. **Dry run and "why didn't it fire"** (3e).
9. **Reading mode and links/backlinks** (3c).
10. **Keyword highlighting in messages** (3e, optional, off by default).

Each step stands alone and leaves the drawer working.

## alternatives considered

- **Advanced-mode switch** hiding fields: rejected by {{user}}'s words; collapsible summarised sections instead.
- **Table view with chosen columns** (Airtable) as the default: powerful for curators, heavy for writers and readers;
  kept as what saved views + sort/group give, not as the default layout.
- **Tabs in the entry** (NovelAI): hide non-default settings; summarised sections show them.
- **Side-pane editor**: needs width the drawer doesn't have; in-place expand + maximize layer.
- **Leave debugging to an extension**: {{user}} explicitly wants it saved per message and built in.

## open

1. **When `enabled` (card/Lumiverse format) and `disable` (ST) disagree on import**, as in the Adelsvard book
   (`enabled: false`, `disable: false`). Options: (a) the card-format `enabled` wins, since an ST `disable: false`
   in a card-shaped entry is almost always the default nobody set; (b) ST's `disable` wins; (c) import as off and
   list them in the import report. Lean: (a), listed in the import report so it's visible.
2. **Book defaults**: (a) build them (3d; new internal data, export writes effective values); (b) skip, keep only
   global defaults, and rely on badges to show deviations. Lean: (a); NovelAI's categories show it's the main thing
   that keeps big books tidy.
3. **Entry content in the live editor** (the CodeMirror editor now on card fields, chat box and message edits). Its
   scope was set to those ("i mean the card fields", "oh right those count too"); lore content is prose with macros,
   so it fits. Options: (a) yes, same editor; (b) no, plain textarea. Lean: (a).
