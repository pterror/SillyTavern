# Decisions of 2026-11-14

The owner's answers to the open decisions, in their words where they gave any. Where they wrote "up to you", the
choice made is marked as such.

## State model (`state-model.md`)

- **How modules draw.** An allowlisted display API for ordinary module UI; a framed area per module only when it needs
  a DOM library that isn't adapted to the API.
- **HTML in messages.** The display handle has one rich-text constructor that takes HTML or markdown and sanitizes it in
  the host; every other element takes plain text. Owner: "should be its own constructor or something no?"
- **The host's own screens** (permission prompts, the list of grants with revoke, secret entry): a host-drawn modal over
  everything. Owner: "didnt crescent have a design for switchable ocaps + presets". To read before the grant design
  goes further: `~/git/rhizone/crescent` master, `lib/platform/` and `docs/design/`.
- **How extensions join.** Both: what the person installs applies to every chat; a card can bring its own. Owner: "why
  no hooks? of course, idk if hooks should be *built in*, not sure what's the best arch". Hooks are not in the core;
  whether a hook library (named wrap points, as content) is the shape is to be drafted as options.
- **How extensions join, the shape** (option D, chosen over the drafted A, B and C; owner: "it *is* what i was
  thinking of more or less"): the composition itself is data. The root's wiring is one graph the root interprets:
  which modules exist, what each is handed, how a card's turn is composed, and how the app's UI slots are filled. A
  card ships its piece of the graph; an extension is a transform of the graph that can insert, wrap, replace or remove
  any node and add edges, applied in a declared order. A transform sees the whole graph and matches nodes by what they
  are, not only by names. The capability review falls out of the edges a transform adds, and the final composition
  can always be shown and explained. Custom code is an opaque node reached through the references it holds; changing
  what it decides inside takes replacing the node or patching its source, which the owner calls a non-issue.
- **Option D: the order of transforms.** Asked of "the card's extensions run first, then the person's": "is that
  fully general?" It wasn't. Every transform, a card's or the person's, declares "after" and "before" as conditions
  over other transforms, and they go into one constraint graph. The person's first-match rules (cond.lua data, as
  grant's preset rules) add to or replace any transform's constraints. No ordering rule ships: order comes from
  declared constraints and the person's statements. Owner on the shipped "card's run first": "wtf is that". A cycle refuses the composition and names each constraint in it
  and who made it; a tie goes by name, and the explanation lists it. The person's rules win because only the
  person's install holds the references that write them and compose, not because they are applied last.
- **Option D: the app's nodes.** "zero core". The app's piece is content like a card's: no kind of node is the
  app's alone, and the rule "only the app's piece has host nodes" is gone. A reference enters a graph only as a need
  node, which grant answers for that node's install (the app's piece's store and home included). An edge to another
  install's node, the app's included, is a dependency, and the review describes it by the need nodes behind it
  ("Can read and change everything chat keeps" for app/chat-store).
- **Option D: which cards an extension runs with.** "need a fully general way to decide this". A transform declares
  a scope as a condition, the same cond.lua data used everywhere, tested against where the chat is composed (the
  card and its tags, the chat, the persona, the world, the device, anything a condition can test). The person's
  rules widen, narrow or switch it off at any level of the cascade. The review shows the scope as a condition; the
  chat's explanation says which rule decided it. A composition is kept by the card and the list of transforms that
  run, so nothing is per card, and a changed rule recomposes open chats through watches on settings/.
- **The settings cascade.** Owner: "depends on both settings cascade (device, session etc) + card stuff yes??? what
  happened to the cascade stuff". The cascade from `settings-scopes.md` stands and now underlies which transforms run
  and in what order. A setting resolves along one path, built from levels of context (tab, chat, character, device,
  user, and any other level as data), relations (the kinds a world names, as data) and the message tree (a
  statement at a node holds for everything under it). Which chains a setting follows is its schema's path, and the
  path is itself a setting. Statements at every level are in the version store, a tab's and a device's
  under nodes of their own, so they branch and undo.
- **Tabs and branch switches.** Settled by the tab sessions design: what a tab shows is that tab's session state, so
  tabs are independent. Owner: "isnt this fucking decided by fucking sessions design".
- **Connection settings** wait for the state model: a connection is which adapter module holds which key.
- **Overview updates slowing with scroll** wait for the state model (`store:watch`).

- **No relation is special; settings follow whichever relations a path names.** Owner: "what the FUCK is 'in'". "in" is
  only the name the example world uses, next to "works at" and "owes"; relation kinds are named by each world's author.
  Outcome: no kind is built in or privileged. Which relations a value is inherited along is part of that value's
  resolution path, data set per world or per setting; the app ships none (a look applies to exactly what it is set on
  until a world opts in). Grouping on the worlds page already groups by any kind the person picks. Owner: "what about
  various relations as cascade". A path can follow several kinds in priority order, one segment can follow several
  kinds, a relation can have several targets in its own order, and how statements combine (first, merge, union, a pure
  function) is part of the setting's schema. Cycles stop at the repeat; an entry reached two ways counts once, at its
  first position.
- **Every level of the cascade keeps history the same way.** Owner: "why inconsistency". Settings at every level (tab,
  device, chat, character, card, world, user) are in the version store, a tab and a device under nodes of their own, so
  all undo and branch alike; latest holds caches, progress, sessions and drafts, never a setting.
- **A card is one more level.** Its statements, ordering included, are statements at the card level; whether they
  outrank the person's depends only on the path's order, which is itself a setting. Superseded in part below: a card's
  own statements are the character level. The person's authority is that only
  their install holds the references that write their levels, not a rule about levels.
- **Bookmarks.** A setting stated on a bookmark is inherited down the message tree only from pinned bookmarks on the path
  (`engine/src/store/chat.rs`: FOLLOWING moves to each new message, PINNED stays); a following bookmark or any position
  resolves from the nearest pinned bookmarks above it. The store keeps an index of the bookmarks matching a declared
  filter, not one per message.
- **Notes are prompt parts, any number.** Owner: "single author's note feels restrictive", "ANs are the wrong mental
  model", "idk why we cant have multiple authors note/characters note". A note is a prompt part (text, a position or
  depth, a role, an optional condition), the same shape as a constant lorebook entry. Notes are one setting merged by
  note id across the chat, pinned bookmarks, character and card; a nearer place changes or switches off one note by id.
  The interval and the character's note are conditions and sources, not separate features. Owner: "what about an AN that
  stops applying at some point". Two ways, both existing mechanisms: a statement at a later message switching the note
  off by id (it holds for everything under that message, on that branch only), and a condition on the note ("for N
  messages after it was set", "until message N", "while a state key is true", "until the next pinned bookmark").

- **The order of the levels is the critical part.** Owner: "the critical part" (that the order is itself a setting).
  The order is a setting resolved through the cascade, statable at any level and per setting, and central to the
  cascade section of `state-model.md`, not a footnote. Realised as the settings `order/<name>` (a list of levels) and
  `on/<name>` (which are on).
- **A level can be switched off and keep its place.** Owner: "ideally with the ability to toggle some off too i guess
  but preserve position". A stated order is a list of levels, each on or off; off levels are skipped in resolution;
  switching one on returns it to the same position. A toggle is a statement like any other: in history, undoable,
  overridable at a more specific level ("on this phone, chat-level presets are off").
- **Default order** (owner: "sure up to you"; the model's choice), closest first: tab, chat, pinned bookmarks above
  this point, character (in a group: the speaking character, then the group; a card's own statements are the character
  level), world, device, user, default. Containment-relation follows apply within the levels whose subject is an entry
  or world.
- **Resolving `order/` and `on/` themselves** (2026-11-15). Owner: "themselves, except if it'd cause a cycle, starting
  from shipped order?? or shipped order -> recalc until entering/exiting a cycle". Start from the shipped order, resolve
  `order/` and `on/` with it, resolve them again with the result, and repeat until the order stops changing (a fixed
  point). If an order repeats without being a fixed point (a cycle), stop at the first repeat and use that order. The
  explanation shows the steps and the cycle. Iterations are bounded by the number of distinct orders seen, which is
  finite. Replaces the earlier proposal of a fixed shipped order. `state-model.md` has settings.lua and a worked example
  with a fixed point after two steps and a cycle, run under LuaJIT.
- **Unknown and missing levels** (2026-11-15). Owner: "whatever idk tbh" (the choice is the model's). An unknown level
  stays in the stated list and does nothing, so a level an extension adds later takes effect where it was placed. A
  level the statement leaves out goes after the listed ones, in the shipped order.
- **The group relation is named "member of"** (a character is a member of a group). It replaces the placeholder "group".
  How the groups feature stores membership is not designed here.
- **No level restrictions.** Owner: "yeah" (to dropping `settings-scopes.md`'s table of which levels a kind of setting
  may use). Reason: "what's per what: incorrect mental model" (2026-10-17). No level is switched off by default for any
  setting: a theme can be stated per chat and per character like backgrounds, presets per device. A person switches
  levels off with `on/` statements ("never let chats change my theme" at device or user level). The table's rationale,
  that a chat-level theme in a shared chat changes every participant's screen, is now a choice each person makes with
  `on/`, not a rule. The schema-level restriction of levels is removed from the state model; a schema's order is only a
  default order.
- **What modules see of the store: entities, components and relations, with optional schemas** (2026-11-15, agreed by
  the owner). Not raw key strings, and not a SQL engine; the ordered key-value storage underneath stays. Owner: "i
  would ideally still like relational for compatible data (optionally), for some definition of compatible. perhaps
  something like an ecs architecture in relational db" (09-30); "an open bag of properties (…), then be able to search
  based on that" (09-12). Reasons: a key and its value are a special case (an entity with one free-form component);
  conditions are queries over components, so lore activation, view filters, the character list, tags and extension
  scope are one kind of condition on the same indexes (owner: "if they are different things at all it's worrying");
  at 10 billion cards with no cost per row and no write amplification, indexes are declared on component fields by
  schemas and kept by the store, so a write costs what the indexes declared on what it changes cost; the library
  already stores entities with a type, fields, tags and relations (`src/library-codes.js`) and the engine keeps
  counted, ordered indexes over them (`engine/src/store/`). In `state-model.md`: the store's API, scope and versioning
  per component and field; the query language is cond.lua's data form; indexes under branching are the library node's
  index in place plus each chat's rows filtered by ancestry (its option C, with the costs of the others); schemas are
  content, stored data is never rewritten for one, and old shapes are read by the schema. latest stays keys.

## Worldbuilding

- **Preview screen** (try text against the worlds; sample text kept per world): "ideally available in parallel (=
  when editing) but shouldnt take up space when the user doesnt need it".
- **Every setting editable on the overview:** "editable. on the overview. doesn't mean visible for all entries
  everywhere". An entry's full settings open in place on the overview; cards stay minimal.
- **Delete and select-many on cards:** follow the established conventions for cards and photos: a checkbox shown on
  hover, Shift-click for a range, Ctrl/Cmd-click to add, select all, a bulk-action bar, a select mode on touch.
- **Two tabs editing the same entry:** "conflict dialog, bonus points for diffs".

## Text rules

Find-and-replace presets and the regex extension are one feature (`docs/backlog.md`). Before any design: "someone needs
to figure out/understand how users think of it. when would they need find and replace? what kind of edits would they
want to do to a chat message; what kind of bad card formats might they encounter and want to patch; regex for display
(e.g. 'statblock' -> rich html display, although ideally we could do statblocks *better* through scripting)".

## Font picker

Mockup options first.

## Accounts

- **Accounts share one store.** Each account is a node in one store. Content shared between accounts (a card imported
  by two people, a common starting library) sits above the account nodes and is shared copy-on-write, the way the
  version store shares everything above a branch. Privacy comes from capability scopes, quotas are charged per
  reference, deleting an account drops its nodes, and a multiplayer chat is a node two accounts' scopes include.
  Indexes sit at the shared base node, with each account's changes as rows, as a chat's are (replaces "indexes
  declared per home"); a read pays one more level. Images: blobs by content hash are stored once across accounts,
  pinned and charged per account.
- **Accounts are a redesign, not a port,** after the state model. An account is an identity (login, password, sessions
  renewed by any request and expiring after inactivity, no page timer), a home node in the shared store, the scopes
  its capabilities get, and its quotas. An admin is the ceiling on what an account can be granted. Settings snapshots
  become settings history (settings are in the version store at every level). Reason for dropping upstream's shape:
  the owner thinks per-user folders are a leftover of upstream's file-as-database era.
- An admin's edits to another user reach that user's open tabs at once.

## State model: questions closed on 2026-11-15

- **Open question 2 (how non-programmers build things)**, decided earlier: editors are modules that write data that
  libraries read; no language in the core.
- **Open question 6 (building an index on existing data).** Owner: "idc i guess". A schema version that adds an index
  comes into force after the store builds it in one pass; accepted.
- **Open question 8 (speaker names).** Owner: "references (aka new behavior) make more sense right?" Messages refer to
  their speaker entity; a rename renames it everywhere; the rename is itself a change in history.
- **Store integrity (requirements).** A checksum on every page or record, verified on read; copy-on-write and
  append-style writes with no overwrite in place; a write-ahead log with checksums so a torn write is detected and
  rolled back on open; background scrubbing that re-verifies; backups at the level of pages, so only damaged pages are
  restored. The engine has the log's checksums and rollback on open, checksums on blocks verified on read and
  immutable runs; it has no scrubbing, no backups and no blob store (`state-model.md`, "Store integrity").

## App-wide

- **Optimistic updates** (chosen; owner: "up to u"): a person's own edits (tags, toggles, renames) show at once and are
  undone, with a visible "not saved" state, if the server refuses. Search filters what's loaded at once, then shows the
  server's ranked results. Owner: "depends on optimistic vs... non-optimistic ui?"
- **Search** in personas, group members and tags is server search, ranked like the character list.
- **Lab Mode and Zen Sliders** are dropped. Owner: "allow values out of range": fields accept any value; sliders cover
  the usual range.
- **Names:** "just normal names please just like the rest of the ui".
