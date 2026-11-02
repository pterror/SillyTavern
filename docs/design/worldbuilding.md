# worldbuilding tool (things, names, references)

Status: designed, not built. Nothing open (the world-vs-book question is answered below). Supersedes `lorebook-editor-superseded.md` for the ui; that plan's
facts (research, activation records 3e, import normalisation 3f, book defaults 3d) are reused here by reference.

The bar, in {{user}}'s words: "think about ours less as 'lorebook editor'/'world info editor' and more as 'best in
class worldbuilding tool'". The product is a tool for building, keeping consistent, navigating and sharing a world.
Its content happens to feed the model; the classic lorebook's insertion machinery is one consumer of the world, kept
compatible and out of the way.

## root cause

A world is **things that refer to each other**: you understand a thing through what it's connected to, and you get
around by following references. The classic (ccv2 / SillyTavern World Info) lorebook already holds exactly that, and
the drawer never shows it: it presents each entry as a row of the prompt builder's settings. So nobody can read the
world through it, building it is form-filling, the references already in the data are invisible, and nothing helps
keep the world consistent.

An earlier draft called this "a wiki". {{user}}: "wiki isnt necessarily *the* best way though (?)", "think about
what's the root cause why you were drawn to wiki and what the 'purest' form of that would be (?)". The purest form is
three things:
- **things**: a person, a place, a rule of the world; each with its content (an entry);
- **names**: how anything refers to a thing (an entry's keys);
- **references**: a text mentioning a thing by one of its names.

The chat is just another text in that web. A page mentioning "the tavern" is a link; a chat message mentioning it is
a lorebook activation; recursion is following references from what got pulled in. The conversation and the world are
one web of references, and "what the model knows right now" is the neighbourhood of what the conversation refers to.

So the ui is not "a wiki" but **lenses over that web, picked by task** ({{user}}: "i don't disagree with this :)"):
- **page lens**: read or write one thing;
- **list/table lens**: bulk work and tuning;
- **neighbourhood lens**: how a thing relates (what it references, what references it);
- **the chat itself**: references marked in the messages.

The insertion machinery is a property of a thing reached for when tuning, not its face.

What a worldbuilder needs, and where each is answered:
- **build**: write things fast, create a thing from a mention, organise into groups (4e, 4f);
- **connect**: names and references that make themselves, backlinks, unlinked mentions (4d, 4e, 4g);
- **keep consistent**: shared names, never-reachable things, orphans, missing things, contradictions (4g);
- **navigate**: landing, sidebar, search, groups, hubs (4b, 4c, 4f);
- **share**: a world readable by someone else, exported as a card book or ST book with nothing lost (4k);
- **feed the model**: insertion settings, costs, and "why did this come up", from the chat (4d, 4i, 4j).

## {{user}}'s words this rests on

- "how about... think about what a good lorebook editor shows, what both readers and writers will want to know and/or
  have access to at a glance"; "the hell i mean the reader's/writer's mental model for the fucking ui"; "are wikis
  lists"; "wiki isnt necessarily *the* best way though (?)"; the root/purest-form question above (10-03).
- "we could have a landing page", "(or an entry marked as default)", "authoring tools to help with this wiki model of
  authoring", "some of the lorebook editors i've seen have a sidebar", "although i suppose none of them have been
  super neat so think about it more... think about what information is most important, standard visual design
  principles i guess (???) gestalt and the stuff like that (???)" (10-03).
- landing: "up to you :) and/or configurable both user-side and lorebook-side (?)"; search: "up to you, could do local
  on frontend if frontend has it all resident (useful in e.g. vpn/mobile data/high latency cases)" (10-03).
- the chat as hypertext: `text-decoration-line: underline; text-decoration-style: dotted;` ("i have an awful idea");
  which words: "whether 'words that actually triggered something for this reply' or 'every mention of any known name'
  configurable maybe", "two styles/configurable i'm fine with"; noise handling agreed (10-03).
- per-thing styling: "custom css for each entry would be funny (e.g. yellow + glow for blonde princess)" (10-03).
- hierarchy: "hierarchy would be useful too sometimes", "i mean hierarchical ui, not sure if it'd make sense under ccv2
  lorebooks for it to have actual semantic meaning (?)"; folders vs categories: "would they not be the same thing"
  (10-03).
- "strategy + position + depth + order + trigger% + 'move/copy to another lorebook' + duplicate + delete... are just
  clutter usually"; "title textarea should get a tooltip with tis full text" (10-03).
- "just put it in a collapsible drawer" (not an advanced mode, 09-12); "real saving and optional highlighting of
  matches per message" (WorldInfoInfo, 09-16); "lorebook trigger highlight ui stuff (trigger info saved on each
  message)" (09-28); "import lorebooks like we do with images" (09-28).
- the classic lorebook is "in spirit" an extension on the core mechanism (10-03); compat: upstream WI data,
  activation behaviour, `character_book` import/export, `/world` and friends, WI events all keep working.
- CLAUDE.md: scale (books with thousands of entries; nothing O(total) in the page), memory (the page holds only what's
  on screen), client sends actions, modals suck, plain language, maximally intuitive, multi-user locks, drafts survive
  reload.

## 1. information hierarchy

Ranked per moment; P = shown, S = shown smaller / one glance away, D = on demand.

| moment | reader | writer | why |
|---|---|---|---|
| **arriving at a book** | P: what world this is (front page / overview); the main topics (groups, most-referenced things); the basics (always-on things). S: size. D: everything else | P: same, plus what needs work (issue count) and the always-on cost. S: recently edited | first question for both is "what is this"; a writer's second is "what's unfinished" |
| **reading a thing** | P: title, the content as prose, references in it. S: other names ("also called"), groups, "referenced by". D: when it comes up, insertion | same | the content *is* the knowledge; names and backlinks place it in the world; mechanics answer no reader question |
| **writing a thing** | (n/a) | P: the content, its names (they decide both references and when it comes up), what it references as typed. S: groups, token cost, "comes up when / always", suggestions. D: insertion settings | names are the one field with double meaning, so they sit right under the title; cost matters while writing because always-on and long things cost every prompt |
| **in the chat** | S: references marked in messages (hover = preview). D: open the thing | same | the reader's question mid-chat is "who/what is that"; the answer belongs at the word |
| **debugging** | P (mid-chat): what came up on this message and why (matched name, reference chain, always). S: what got cut by budget. D: dry run, "why didn't it" | same, plus jump from the reason to the thing and its names | the question starts from a message, so the answer starts there |

Consequences: the machinery (strategy, position, depth, order, %, timing, inclusion groups, recursion flags, filters)
is D in every row ({{user}}'s "clutter usually"). Token cost is S for writers only. Activation is P only when
debugging, and it starts from the chat.

## 2. visual design, applied

- **Hierarchy (size, weight, contrast).** The thing's title is the largest text in the drawer; content prose at the
  chat's reading size; names, groups and backlinks small and muted; machinery lowest contrast and collapsed. In the
  sidebar, titles normal weight, group labels small caps, counts muted. One accent colour, only for references and the
  current thing (per-thing mention styles, 4h, apply in the chat and in content, never to the drawer's own chrome).
- **Proximity.** A thing's names sit directly under its title (they are its identity); "referenced by" sits at the end
  of the content (where reading ends and "where next" begins); the insertion section is separated by whitespace and a
  rule, so it never reads as part of the content.
- **Similarity.** A reference looks the same in content, sidebar, backlinks, debug reasons and (in its configured
  style) the chat; always-on things carry one marker everywhere; every authoring issue uses one badge style. A name
  that is a regex looks different from plain names.
- **Common region.** Three regions with their own background: sidebar (navigation), the lens (content), and inside the
  page lens the insertion box. Debug info always appears in one region (the panel on the message, or the page's "came
  up" strip), never sprinkled.
- **Continuity.** Reading is one flow: title → names → content → referenced by. Editing keeps the same order, so
  switching to edit moves nothing (no layout shift).
- **Figure-ground.** The lens is the figure; the sidebar is ground (lower contrast, recedes while reading).
- **Progressive disclosure.** read (default) → edit (pencil / click-to-edit) → tune (the collapsed "How it's added to
  the prompt" box, summary line visible). Non-default settings surface as small badges by the title.
- **Consistency with the app.** Preview-by-default with ✓ ✕ (the character field editor); the live editor for content;
  the editor layer for maximize; filter pills and saved views; the drawer stack; drafts and locks as everywhere.
- **Reading comfort.** Content measure capped (~70 characters per line) even when the drawer is wide; chat typography
  and markdown rendering; macros rendered as in previews.
- **Density for big books.** The sidebar is compact (one line per thing), virtualised and paged; never the whole book
  in the page unless the book is small enough to be resident (4c).

## 3. references (external tools), as checks only

{{user}}: "i have seen some that are fine that use sidebars, but other than that i guess they don't have anything
super important that we need to include that we wouldn't be able to derive from other principles (?)". The design is
derived from the model, the hierarchy and the principles; references only checked a derived choice:
- **Sidebar + content** (lorebook editors with sidebars, Notion): the one pattern {{user}} validated; confirms the
  two-region layout. Their failure mode: the sidebar lists config entries; ours lists things.
- **Backlinks with unlinked mentions** (Obsidian): confirms writers fix names from unlinked mentions ("add as a name").
- **One parent per page fails** (LegendKeeper's tree, Notion nesting): confirms groups that allow several memberships.
- **Fixed entity types** (Kanka), **template overload** (World Anvil): confirm schemaless things; World Anvil users
  asking for its article sidebar off by default
  ([suggestion](https://www.worldanvil.com/community/voting/suggestion/741b0087-4a3c-4197-9bb7-dca375685920/view))
  confirms the sidebar must recede.
- **Graph views** (Obsidian): confirm a whole-world graph fails past a few dozen nodes; the neighbourhood lens (one
  thing and its direct references) is the part that holds up.

## 4. the design

### 4a. where it lives

The World Info drawer (centre, over the chat). Two regions: sidebar (~240px) and the lens. At chat width under ~720px
the sidebar folds behind a menu button (as the help panel does). Maximize moves the drawer content into the editor
layer (three columns, capped to Chat Width Max). Book picker in the drawer header (see open 1 for worlds spanning
books). Lens switch in the header: Page / Table / Neighbourhood.

### 4b. the landing

Opening a book shows its landing. Configurable per book (the author's default) and per user (overrides the book's),
{{user}}: "configurable both user-side and lorebook-side": front page only, overview only, or front page above the
overview (the default).
- **front page**: the thing marked as the book's front page, read in the page lens; unmarked → the book's description
  (`character_book.description`, ST book description);
- **overview**: **Basics** (always-on things, one-line previews, total token cost for writers: "Always in the prompt:
  7 things, 1,240 tokens"); **Groups** (top-level groups with counts); **Most referenced** (the world's hubs, by
  backlinks); for writers: **Needs attention** count and recently edited.

### 4c. the sidebar and search

Top to bottom: search; front page; the group tree (4f); "All" (A–Z). Current thing highlighted; for writers a small
cost dot and an issue dot per thing.

**Resident or paged**, {{user}}: "could do local on frontend if frontend has it all resident (useful in e.g.
vpn/mobile data/high latency cases)". The server answers each book's size (entries and total text bytes) with the
book's hash. A book is **resident** when it fits the resident budget: a fixed cap on text bytes and entries held in the
page at once (the memory rule holds only what's on screen; a small open book counts as on screen, the same way an open
chat's messages do). Resident: the whole book is loaded once (by hash, cached in browser storage within its size
limit), and search, filters, the tree and the reference marking run locally, with no round trips. Not resident (a
5,000-entry book): every list is a server page with a cursor (the views mechanisms), search runs on the server, and
the page holds only what's shown. The cap is a setting with a sane default; the drawer says which mode a book is in
("Searching on this device" / "Searching on the server").

Search covers titles, names and content; the pill builder filters by group, always-on, has issues, came up in this
chat, cost range. Saved views per book.

### 4d. the page lens (reading)

- **Title** (the entry's comment; if empty, its first name; full text on hover), with small badges only for what's
  unusual: "always on", "off", non-default insertion ("depth 2", "50%", "sticky 3", "inclusion group: weather").
- **Also called**: the other names (keys) as plain words; regex keys shown as "also comes up on a pattern". Secondary
  keys in words: "only when also mentioned: x, y" (or "…unless: …" for NOT logic).
- **The content**, rendered like chat, every reference to another thing marked (in that thing's style, 4h): hover =
  preview of its first lines; click = open it, with back/forward in the drawer. A name with no thing stays plain.
- **Groups** it's in, as chips.
- **Referenced by** (backlinks), then **unlinked mentions** (4g), each with "add as a name".
- **Came up in this chat** (when a chat is open): "messages 12, 40, 41 · because 'the tavern' was mentioned / via
  Elara / always", from the stored activation records.
- **How it's added to the prompt**: one collapsed box with a one-line summary, holding every upstream field grouped
  as in the superseded plan 3b. Book-level defaults (3d) apply. Nothing removed from data or behaviour.

### 4e. the page lens (writing)

- Edit in place (pencil / click-to-edit), ✓ ✕, drafts, locks: the character field editor pattern; same layout as
  reading.
- **Names** as chips under the title: type + Enter; each shows how many other things already mention it ("mentioned
  in 12"); a name another thing already uses is flagged inline.
- **Content** in the live editor; mentions of existing names marked as typed (same matching as the server). Selecting
  a phrase offers "make a thing for this" (named by the phrase, referenced immediately) and "add as a name of…".
- **Groups**: chips with autocomplete; several allowed.
- **Mention style** (4h): an optional field under "How it looks when mentioned".
- **Cost** live (tokens), and for always-on things their share of the always-on total.
- New thing: sidebar "+", from a selection, or from a "missing" suggestion (4g); opens in edit mode with its name set.

### 4f. groups (the tree)

{{user}}: "hierarchy would be useful too sometimes", "i mean hierarchical ui, not sure if it'd make sense under ccv2
lorebooks for it to have actual semantic meaning (?)"; folders vs categories: "would they not be the same thing". So
one concept: **nestable groups**, shown as a tree in the sidebar, for organising only. A thing can be in several
groups and shows under each. Groups have **no effect on activation**. Not upstream's inclusion `group` (which decides
which entries compete to fire; reusing it would change what fires): a separate list of group paths per entry, in the
entry's extension data (`extensions` on card-book entries; the same key on stored entries), exported with card books,
ignored by upstream. Risu/Lumiverse folders import into it and export back out. Drag a thing onto a group to add it;
drag a group onto another to nest. The group tree is one lens of organisation, not a meaning.

### 4g. authoring tools ("Needs attention")

Computed on the server per book, kept current on writes, listed in the sidebar and as badges:
- **Never comes up**: no names and not always on.
- **Shared names**: two things with the same name; offer merge or rename.
- **Unlinked mentions**: text referring to a thing by a form not in its names (case, plural, possessive when matching
  is strict; spacing variants); offer "add as a name".
- **Missing things**: terms mentioned across several things (capitalised phrases, quoted terms) with no thing named
  for them; offer "make a thing".
- **Orphans**: nothing references it and it isn't always on or the front page.
- **Heavy**: always-on things above a share of the always-on budget; long things relative to the book.
- **Broken**: entries that can't be drawn (the Adelsvard uid mismatch class), listed with the reason, never silently
  dropped.
- **Possible contradictions** (opt-in, off by default, cost shown first): a model pass over things that reference each
  other, listing statements that disagree, as suggestions only; nothing edited without acceptance.

### 4h. the chat as hypertext, and per-thing styles

{{user}}'s "awful idea": references in chat messages get `text-decoration-line: underline;
text-decoration-style: dotted;`. Hover = a preview of the thing; click = open it in the drawer.
- **Which words**, configurable per user ("whether 'words that actually triggered something for this reply' or 'every
  mention of any known name' configurable maybe"; "two styles/configurable i'm fine with"): **triggered** (from the
  reply's stored activation record: what actually reached the prompt) and **mentioned** (every mention of any name in
  the active books, from the reference automaton), each with its own style, either or both on.
- **Noise**: a toggle; or marks shown only on hover over a message; or only for the message in focus. Configurable;
  default: triggered marks on, mentioned marks on hover.
- **Where the spans come from**: the server, never the page's own matching for stored messages: activation records
  carry the matched spans; for "mentioned", the server marks spans when a message is stored and when the books' names
  change (bounded: per message, per book version), sent with the messages. The page draws what it's given.
- **Per-thing mention style** ("custom css for each entry would be funny (e.g. yellow + glow for blonde princess)"):
  an optional style on a thing, applied wherever it's referenced (chat and content). Scoped so it can only style its
  own mentions: a sanitised declaration list (colour, text-shadow, font-weight/style, text-decoration, background),
  attached to the mention's own span through a per-thing class; no selectors, no url(), no layout properties, never the
  page. Stored in the entry's extension data, exported with it.

### 4i. the table lens (for bulk work)

Same data as a table, one row per thing in prompt order: title, names, state, cost, and only the columns the user adds
(position, depth, order, %, inclusion group…), with filters, sort and saved views. Bulk select → bulk actions (state,
groups, move/copy to another book, delete with undo, set insertion fields). Move / copy / duplicate / delete live here
and in a ⋯ menu by the title in the page lens, not on every row. Default lens is Page; Table is one click.

### 4j. the neighbourhood lens and debugging

- **Neighbourhood**: one thing in the middle, what it references and what references it around it, one hop (two on
  request), clickable. Never the whole world (which fails past a few dozen nodes).
- **Debugging from the chat**: each reply carries its activation record (superseded plan 3e). The triggered marks
  (4h) are the first view of it; a small lorebook mark on the message opens the panel: things that came up, each with
  its reason (the matched name, the reference chain "Elara → the tavern", or "always"), things cut by budget, links to
  each. "What would come up now" (dry run) and "why didn't X come up" sit there too. A thing's "came up in this chat"
  strip is the same data from the thing's side.
- **Insertions shown in place** (a per-user setting: "optionally we can have lorebook injection 'highlighting' as
  'ephemeral' messages in context or something (as a setting?)"): the activation record holds where each thing went
  in (position, depth, role), so the chat can show it as a distinct, collapsible row at that depth, the history as the
  model saw it. Drawn from the record only: never stored as a message, never sent, never counted as one. Insertions
  outside the history (around the character definitions, the author's note slots) have no place between messages and
  show in the message panel only. Settings: off, collapsed, expanded.

### 4k. data and compat

- References and backlinks are derived, never stored by hand: the server matches every thing's plain (non-regex)
  names in every thing's content (one automaton per book, rebuilt per book version, bounded), keeping a backlinks table
  updated on each entry write. Matching follows each target's own case-sensitive and whole-word settings, so a
  reference is marked exactly when recursion would see a mention.
- Groups (4f), mention style (4h), front-page mark (4b) live in entry/book extension data; exported with card books;
  ignored by upstream. Builder check: confirm upstream's World Info save keeps unknown entry fields; if not, export
  round-trips through card books only, said in the export.
- Every upstream field, export format, `character_book` import/export, `/world`, `/findentry`, `/setentryfield` and the
  WI events keep their meaning; the lenses are presentations over the same entries. In spirit an extension: the drawer
  uses only the server's entry, reference, issue, activation and span actions.
- Import normalisation and bulk import from a folder: superseded plan 3f, unchanged.

### 4l. alternatives considered

- **Keep the list, tidied** (the first superseded design): fixes clutter, keeps the wrong frame.
- **"A wiki" as the model**: one lens (pages + links) mistaken for the thing; drops bulk work and the chat's side of
  the web. Kept as the page lens.
- **Graph as main navigation**: useless past a few dozen things; kept only as the one-hop neighbourhood lens.
- **One parent per thing**: worlds aren't trees; groups allow several.
- **Typed entities with fixed fields**: contradicts schemaless; groups and free content carry the same information.
- **Explicit `[[link]]` markup**: the data's mentions already are the references (that's how recursion works); markup
  would diverge from what the model sees.
- **Page-side matching for chat marks**: duplicates the server's matching and costs every render; the server marks
  spans once per message.
- **Full CSS per thing**: can restyle the page; replaced by a sanitised, span-scoped declaration list.

## 5. build order (each standalone)

1. Server: reference automaton, backlinks table, issues (4g, 4k), entry/book size and hash, as actions with paged
   answers. No ui change.
2. Activation records on replies, with matched spans, and the message panel (4j; superseded 3e step 1).
3. Chat marks: triggered spans from the records, the per-user settings and noise options (4h), hover preview and
   click-to-open.
4. Page lens (read) with the sidebar, landing (configurable per book and per user) and resident/paged search (4b–4d).
5. Page lens editing (4e) on the live editor: names as chips, selection actions.
6. Groups data, the tree, and Risu/Lumiverse folder import/export (4f).
7. "Mentioned" chat marks from server-stored spans, and per-thing mention styles (4h).
8. Needs attention (4g) in the sidebar and as badges.
9. Table lens with columns, filters, saved views, bulk actions (4i); per-row actions leave the page lens.
10. Neighbourhood lens (4j).
11. Book defaults (superseded 3d) and import normalisation (3f).

## open

1. **Answered: a world is one book.** {{user}}: "wouldnt a world be a single book". So (a): each book is browsed
   as its own web; a chat can draw on several worlds at once (the character's, globals, chat books), and references
   that cross books are still marked (in the chat and in content) and open the other book. The rest of this item is
   the question as it was asked.
   A chat pulls from several books (the character's, globals, chat
   books, persona), so references in the chat and between things cross books, and a worldbuilder may split a world
   across books. Nothing in {{user}}'s words settles it. (a) One book is one world; cross-book references are marked
   but each book is browsed alone. (b) A **world** is a named set of books, browsed as one web (sidebar, search,
   backlinks and issues span its books; each thing still lives in one book, so compat and export are unchanged); a
   chat's active books form an implicit world. (c) Drop books from the ui entirely: one web of everything the user
   has, books only as an export/sharing unit. Lean (b): it matches how a chat already composes books, keeps books as
   the unit that ships with a card, and costs only the scope of queries.

Superseded plan's open 1 (`enabled` vs `disable` on import) stays open there; 2 and 3 (book defaults, live editor for
content) are taken here as yes. The earlier open "keep the Entries table view" is settled by the lens model: the table
is one lens.
