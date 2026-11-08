# Worldbuilding: the store and server side of the overview

What the engine keeps for the overview (`worldbuilding.md`, "Relations", "Views", "Grouping inside a cell", "Working at
any size"), what each write touches, and what each read costs. `b` is a book, `e` an entry's entity id, `u` an entry's
key (its upstream `uid`), `k` a relation kind's id, `t` a target's key, `p` a position.

A relation goes from its **source** entry to its **target** entry and has a kind. Under a view grouped by kind `k`, an
entry's **region** shows the entries whose relation of kind `k` targets it; there are as many such groupings as the
world has kinds, so every name here says which kind and which direction it covers.

## Relation kinds

A world has a list of **relation kinds**, each an id and a name. A world file carries it as its top-level
`relationKinds`:

```json
"relationKinds": [{ "id": 1, "name": "in" }, { "id": 2, "name": "works at" }]
```

Each kind is its own text field on the book, `\u0001relationKind:<id>` (`src/world-info-engine.js`), so renaming a kind
is one write of that one field and nothing else: relations name the kind by id. Names aren't unique: two kinds may be
called "In" and "in". A `relationKinds` that isn't a list of `{id, name}` with distinct positive whole ids and non-empty
names is kept as an ordinary field of the book and holds no kinds. Other top-level keys starting with `\u0001` or
`\u0002` are escaped as entries' keys are, so no world file's own key can be taken for a kind.

`worldbuilding.createRelationKind` writes a new kind with the next free id (one more than the world's highest);
`worldbuilding.renameRelationKind` rewrites one; `worldbuilding.deleteRelationKind` removes one that no relation uses
and that isn't being merged or merged into (one read of `RELATION_COUNT_BY_KIND_AND_TARGET (b, k)` to answer "in use",
and the end-of-commit check refuses it anyway if one does). The page picks a relation's kind from the list (the
`worldbuilding.relationKinds` view, searched ignoring case on the page) and makes a new kind only by that separate
action; the relation actions take a kind's id, never a name.

### Merging kind A into kind B

`worldbuilding.mergeRelationKind` marks A as merging into B: one text field on the book,
`\u0001relationKindMergingInto:<A>` = B, carried in a world file as `mergingInto` on A's item of `relationKinds`, and a
derived key `KINDS_BEING_MERGED (b, A) → B` so a restarted server finds it. From then on A can't be picked for a new
relation (`relation_edit` refuses it), B can't be deleted or merged, and A can't be merged again.

The merge job then rewrites, in chunks of `RELATION_REWRITES_PER_CHANGE` source entries, each chunk one commit with
other writes in between (`worldbuildingKindMergeRewrites`): each source's relations of kind A become kind B; a source
that already has the same relation of kind B gets one relation, B's item, strong if either was, with A's extra fields
added where B's item lacks them. The sources are found from A's own index (`RELATION_COUNT_BY_KIND_AND_TARGET (b, A, ·)`,
then `RELATIONS_BY_TARGET (b, t, A, ·)` per target), never by a scan of the world. When no relation of kind A is left,
the job deletes A's two fields in one commit. Every state partway is valid: each source has its relations in one kind
or the other, each counted where it is. The merge costs one rewrite per source entry with a relation of kind A; an
alias (A saying "is B" while relations keep A) wouldn't avoid that, since an entry with the same relation in both kinds
would be counted twice in B's held count and listed twice in B's region until each such entry is rewritten.

## The stored relation

One extension field of the entry, `extensions.relations`, stored as the entry's JSON field `\u0001relations` (an
unknown extension key, `src/world-info-engine.js`), so it round-trips through world files and card books:

```json
[{ "kind": 1, "target": 12, "position": "m" }, { "kind": 2, "target": 7, "position": "a", "weak": true }]
```

`target` is the target's key in the same book (a number or a string, as upstream's `uid`); `position` is a fractional
order key compared as bytes, so moving a relation among the others of its kind and target rewrites only its source's
field (a history edit of a few bytes). `weak: true` makes the relation **weak**: the source is drawn in the target's
region like any other source of that kind, but the relation doesn't keep it off the top level (below). A value that isn't a list of such objects holds no relations: a
third party's `relations` extension is read and kept as it is, never refused. A second `(kind, target)` in the list is
ignored; the first one counts.

This field is the only source of truth. Everything below is derived from it by the entry's own writes (`histSet`,
`histEdit`, `jsonValue`, `valueDelete`, creation, deletion, restore), through the one hook every JSON write of a counted
book's entry passes (`book_stats::owned_value_changed`), and its creation and deletion (`book_stats::created`/`gone`).

## No relation names a missing entry or kind

The store refuses any commit that ends with a live entry's relation naming an entry that neither exists nor is being
deleted, or naming a kind the world doesn't have (or a kind being merged into one it doesn't have). It is checked once,
at the end of the commit (`commit_checks.rs`): a write that adds a relation leaves a check for its target and its kind
in the commit's own layer; deleting an entry leaves one for its key; removing or merging a kind leaves one for the
kind. At the end the engine runs each check (one bounded read each) and drops the check keys, which never reach the
keyspace (replay, bulk loads and derive jobs drop them too). Checking at the end, not per record, is what lets a world
be imported in any order and with loops.

- **Writing a whole world** (import, save of the whole book): each entry's relations to keys not in the written world,
  or to kinds not in its `relationKinds`, are left out of what is written.
- **Restoring an entry**: its own relations to entries or kinds that are gone since are left out, by a history edit in
  the same commit (`worldbuildingRelationsKept`).
- **Moving an entry to another world** drops its relations: they name keys in the world it left.
- **Deleting an entry**: below.

## Deleting an entry

Deleting entry D is one change, whatever targets it. D is gone at once (its entity is deleted, its own relations go
with it), and every relation of every kind whose target is D is removed from its source, in chunks.

- **The delete itself** (`relations::entry_deleted`). D's own relations are removed from the indexes. If nothing
  targets D, D leaves the order tree and that's all. Otherwise D stays in the order tree as **the place of a deleted
  entry**: it is counted as deleted (`DeletedWhileRelationsTargetIt`), and, for each kind of relation still targeting
  it, as a place shown under that kind (`DeletedEntryPlaceForKind(k)`); its own held counts are removed.
  `DELETION_IN_PROGRESS_BY_KEY (b, u) → (D, order value)` and `DELETION_IN_PROGRESS_BY_ENTITY (D) → (b, u)` mark it.
  The first chunk of rewrites goes in the same commit as the delete, so a small delete is one short change.
- **The chunks** (the deletion job, `worldbuildingRelationsWithout`): up to `RELATION_REWRITES_PER_CHANGE` source
  entries at a time, each rewritten without its relations targeting D, as history edits of its own field. Each chunk is
  its own commit, taken in the world's lane like any write, so other writes go between chunks.
- **What the reader sees meanwhile.** In a view grouped by kind `k`, D's place is at the top level where D was in the
  world's order, as a `placeOfDeletedEntry` cell with no content of D's, and its region shows the sources whose
  relation of kind `k` still targets D. A source whose relation to D is removed goes where it would be without it:
  another region if it has another strong relation of `k`, otherwise the top level. In a view grouped by a kind nothing
  of which targets D any longer, and ungrouped, D's place isn't shown. Nothing disappears and nothing is broken at any
  point: every source is in exactly the regions its relations put it in.
- **The end.** When a source's rewrite removes the last relation of kind `k` targeting D, D's place stops counting
  for `k`; when the last of any kind goes, D leaves the order tree and its markers go, in that same commit.
- **What the deletion keeps for a restore.** Each relation removed from a source while D's deletion is in progress is
  kept, as written (its whole object, extra fields included), in `RELATIONS_REMOVED_BY_DELETION (b, D, source, k)`.
  It is dropped when that relation is written back, or when D is erased for good.
- **D's key** stays D's while the deletion is in progress: no other entry can be created or restored under it (the
  store refuses), since the relations still naming that key mean D.
- **Erasing** D for good (erasing its world) drops its place, its markers and what it kept.
- The job is stored: its state is these derived keys. A restarted server reads them (`worldbuildingPendingJobs`) and
  carries on (`src/world-info/worldbuilding-jobs.js`). No size is refused.

### Restoring a deleted entry

Restoring D undoes the deletion, all of it. If D's deletion is still in progress, the restore stops it at once: D is
live again, its place counts and markers go, and the relations not yet removed simply stay. Then (and likewise when the
deletion had finished) the restore job puts back, in chunks of the same size, each kept relation into its source's
field (`worldbuildingRelationsToRestore`), with its target set to D's key now (a different one if D's old key was
taken meanwhile), skipping a source that is gone, a kind that is gone, or a relation the source already has again.

## Every job

| Job | Found by | One chunk | Ends when |
|---|---|---|---|
| a deletion's removals | `DELETION_IN_PROGRESS_BY_ENTITY` | up to 1,000 sources' fields rewritten without their relations targeting the deleted entry | nothing targets it |
| a restore's returns | `RELATIONS_REMOVED_BY_DELETION` of a live entry | up to 1,000 sources' fields rewritten with their kept relations | nothing kept can be put back |
| a kind's merge | `KINDS_BEING_MERGED` | up to 1,000 sources' fields rewritten from kind A to kind B | no relation of kind A is left; then A's fields go |

`RELATION_REWRITES_PER_CHANGE` is 1,000: a source's rewrite reads its field and writes a few derived keys plus the
tree's path, about 24 key operations, so a chunk is about the 24,000 reads one request may take (below, One request's
budget). A chunk that finds nothing to do ends its job. A failed chunk stops the job until the store next opens.

## Keys

Per relation (derived, one each):

| Key | Value | For |
|---|---|---|
| `RELATIONS_OF_ENTRY (e, k, t)` | strength, `p`, the relation's object as written | the source's own relations: the write's diff (old set without reading the old value), its strong kinds, its relations line, the loop check's walk up, and what a deletion keeps |
| `RELATIONS_BY_TARGET (b, t, k, p, e)` | — | the relations of kind `k` targeting `t` in position order (a region); every relation targeting `t` |
| `RELATION_COUNT_BY_KIND_AND_TARGET (b, k, t)` | count (Add) | how many relations of kind `k` target `t` ("+N not shown"), kept on write; whether any relation still has kind `k` |

These are keyed by the target's key, not its entity id, so a relation can be written before its target exists within a
commit (an import writes entries in any order and loops allow no order).

**The world's order** is one counted radix tree per book over every entry (`world_order_tree.rs`),
`(order value, e)` as 16 bytes: the order value is `displayIndex`, else the entry's numeric key (upstream's editor shows
`displayIndex ?? uid`), else last. A path-compressed radix tree with 256-way nodes, canonical (every node but the root
has two or more children), so its shape depends only on the set:

| Key | Value |
|---|---|
| `ORDER_TREE_EDGE (b, P, d)` | the child's prefix (a node's, or the 16-byte entry for a leaf) |
| `ORDER_TREE_COUNT (b, P)` | AddMap: digit → entries under that edge |
| `ORDER_TREE_HELD (b, P, slot)` | AddMap: digit → entries under that edge counted in the slot: `HeldByKind(k)` (having a strong relation of kind `k`), `DeletedWhileRelationsTargetIt`, `DeletedEntryPlaceForKind(k)` |

**The top of a cell** for kind `k` is every entry minus those held by `k`, minus deleted entries, plus the places of
deleted entries that relations of kind `k` still target: under each edge,
`ORDER_TREE_COUNT − HeldByKind(k) − DeletedWhileRelationsTargetIt + DeletedEntryPlaceForKind(k)`; ungrouped, `COUNT −
DeletedWhileRelationsTargetIt`. A split of a node copies every slot's counts under the split edge; a merge deletes
them. It is the complement of a positive index, kept on the same tree. A positive
index ("the entries with no relation of kind `k`") would need every entry of the book written into it the first time a
kind is used, and every new entry written into it once per kind: a cost per entry. The complement costs nothing until
an entry gains the kind. Changing the grouping kind reads a different `ORDER_TREE_HELD`, never a scan. Grouping by
nothing reads `ORDER_TREE_COUNT` alone. Weak relations aren't counted in it, which is all that makes them weak.

## Loops

Relations of a kind may form loops (A in B, B in A). An entry held only by entries in a loop that nothing outside holds
appears nowhere: no top-level region reaches it. The store keeps no loop or reachability state, which would cost per
entry of the loop on each change. Instead:

- **A weak relation** draws the entry in the target's region but doesn't hold it, so making one relation of a loop weak
  puts that entry at the top level, and the loop is drawn from it. It is part of the relation's own record: the same
  per-entry property, at the same cost.
- **A capped check on every write that changes relations.** An entry can only become unreached when its own strong
  relations change (a relation added, moved, made strong, or taken away, including by a deletion's rewrite of a
  source). So after the commit, the server takes every entry whose relations field the commit wrote (plus a restored
  entry) and, for each kind it still has a strong relation of, walks up: the entry, then the targets of its strong
  relations of that kind, then theirs, keeping a visited set. A walk stops when it meets an entry with no strong relation
  of the kind, or targeting a deleted entry's place (at the top level), or one an earlier walk of this write found
  reached (the entry is reached); an entry an earlier walk found
  unreached is a dead end. If a walk runs out without reaching, the entries it found are held only by a loop, and the
  write's answer names them (`unreachedLoops: [{entry, kind, entries}]`), so the page can offer making a relation weak.
  The walks of one write share one limit of visits; when it runs out the check stops and says nothing more, and an
  unreached entry stays findable through search (`relations::unreached_among`).

  Cost per write: at most the limit's visits, each one scan of `RELATIONS_OF_ENTRY (e, k)` and one key lookup per strong
  target. Nothing per other entry, nothing on reads.

Where the answer goes:

| Write | Answer |
|---|---|
| the relation actions | the `worldbuilding.lastChange` view, with the changed relation; the limit is the request's `loopCheckLimit` |
| world import, create, duplicate, replace; entry apply (edits and deletes), edit, transplant | the endpoint's JSON answer, `unreachedLoops` (`src/endpoints/worldinfo.js`) |
| restore | `WorldInfoEngine.restore`'s result (no endpoint restores an entry yet) |
| a character's embedded book (`LibraryEngine.writeCard`) | its result; the character endpoints answer the old client with a plain name or a fixed shape that would break if it changed, so they don't pass it on |
| batched card imports, a card's bundled world (`card-import-extras.js`), new-user seeding (`users.js`), the import of upstream's files (`upstream-import.js`) | none: they run without a page waiting on them |
| the chunks of a deletion, a restore or a merge job after the first | none: they run after the action's answer, with no page waiting on them; the delete's own answer covers the first chunk |

Requests that don't carry a limit use `LOOP_CHECK_VISITS_PER_WRITE` (below).

## What each write touches

`depth` is the tree's depth at the entry: about `log256(n) + 1` for spread keys (5 at 10 billion), at most 16.

| Write | Derived writes |
|---|---|
| an entry's field other than `relations` | none |
| relation added, the source already has a strong relation of its kind, or the new one is weak | 3: `RELATIONS_OF_ENTRY`, `RELATIONS_BY_TARGET`, `RELATION_COUNT_BY_KIND_AND_TARGET` (a count that reaches 0 is deleted, so no zero counters are left behind; that reads it first); + 1 delete if a deletion kept it |
| strong relation added, first strong one of its kind on the source | 3 + `depth` (`HeldByKind` along the source's path) |
| relation removed | the same, mirrored; if its target is being deleted: + 1 (what the deletion keeps), + `depth` if it was the last of its kind targeting it, + `depth` + 1 edge + 2 markers if it was the last of all |
| position changed | 3: `RELATIONS_OF_ENTRY`, `RELATIONS_BY_TARGET` out and in |
| target changed | 6 (one out, one in); + `depth` if the source's last strong one of the kind goes or its first comes |
| weak ↔ strong, or an extra field changed | 1: `RELATIONS_OF_ENTRY`; + `depth` if it is the source's only strong relation of its kind |
| entry created | `depth` + 1 edge; a split adds 3 + one count per slot under the split edge |
| entry deleted, nothing targeting it | its own relations' removals + `depth` × (1 + its strong kinds) + 1 edge |
| entry deleted, relations targeting it | its own relations' removals + `depth` × (its strong kinds + 1 + the kinds targeting it) + 2 markers; finding those kinds is one seek per kind. Nothing per relation targeting it: those are the job's chunks, each source a relation removal (above) |
| entry restored while its deletion is in progress | `depth` × (1 + the kinds targeting it) + 2 markers, plus its own relations written back; the kept relations come back in chunks, each source a relation added (above) |
| `displayIndex` changed | delete and insert: 2 × `depth` × (1 + the entry's strong kinds) + 2 edges |
| kind created or renamed | none (the kind's field is its own record) |
| kind marked merging | 1 (`KINDS_BEING_MERGED`); then per source in its chunks, a relation removed and one added (above), or one removed when it folds into its twin |

No write touches anything per other entry; a deletion's, a restore's and a merge's per-source work is spread over their
chunks, each chunk at most 1,000 sources. A created entry is inserted at its key's order and moved when its
`entryIndex` record follows in the same commit; the shared upper nodes' adds fold in the commit's layer. The
end-of-commit checks read one key or one bounded scan each and write nothing.

## Reads

| Read | Cost |
|---|---|
| top-level count | 4 gets (the root's count and three slots) |
| top-level range of `n` from rank `r` | a descent skipping by counts: 4 gets per node on the way, `O(depth)` per entry found, `O(n · depth)` worst case |
| an entry's rank in the top level | 4 gets per node on its path |
| a region's first `m` entries and how many there are | one page of `m` of `RELATIONS_BY_TARGET (b, t, k)` + 1 get |
| a card | the entry's title, text (cut), keys and `RELATIONS_OF_ENTRY`; per relation one lookup of the target's title and one of the kind's name |
| a step in reading order | the top-level entry's drawn tree (bounded by the layout), and the next top-level entry's per one crossed |
| the kinds list | the book's fields |

### The layout comes from the request

The page says how regions are drawn; the server has no numbers of its own. The request carries, per nesting level (the
first is a top-level entry's own region), its **columns** and the **rows** a region shows, and how many **characters**
of an entry's text a card carries. A region at level `i` fills whole rows: `columns × rows` cells. When the entries whose
relation of the grouping kind targets the region's entry fit, it shows them all; when they don't, it shows
`columns × rows − 1` and a `notShownTile` (shown as "+N more", with `groupingKindRelationsTargetingRegionEntryNotShown`)
takes the last cell. A region nested deeper than the levels given isn't opened: its card still says how many relations
of the grouping kind target it (`groupingKindRelationsTargetingThis`). A repeat (an entry already open
above, on the drawing path) is drawn as its card with no region.

So the cards one top-level entry draws are at most `1 + Σ_i Π_{j≤i} columns_j × rows_j`, and a read of a range of `n`
is `n` times that.

### One request's budget

The only bound is on one request's work, and it follows from the rules: an action has 200 ms (the rules' figure for
sending a message, the one figure they give for an action), and the engine's work is reads of keys. At an assumed 8 µs
per read (not measured; I don't know the real figure, and it should be measured on the slowest storage the app runs on),
200 ms is about 24,000 reads (`READS_PER_REQUEST`). Then:

- a card costs about 6 reads (title, text, the key list, the relations, and per relation the target's title and the
  kind's name, counted as 2), so a read draws at most 4,000 cards (`MAX_CARDS_PER_READ`): the range's top-level entries
  times the cards each draws, checked by the schema on `openOverview` and by the handler on `showRange` and
  `stepOverview` (a step crossing `n` top-level entries draws each);
- a loop check visit costs about 2 reads, so one write's check visits at most 12,000 entries
  (`LOOP_CHECK_VISITS_PER_WRITE`), the cap on `loopCheckLimit` and the limit of writes that carry none.

Everything else is unbounded: levels, columns, rows, the card text's length (one read per card whatever its length; the
answer's size follows the entries' own text), the range's width, a step's length, a key's or a name's length.

## The answer and the page

One area, `@st/worldbuilding`. Views:

- `worldbuilding.overview`: the book, the grouping kind, the top-level count, the range's first rank and its entries,
  each with its drawn region, and where the last step landed with its top-level rank.
- `worldbuilding.relationKinds`: the world's kinds, `{id, name, mergingInto}` in id order.
- `worldbuilding.lastChange`: what the session's last change left to say: the kind it created, and the relation whose
  change left its entry unreached with the entries the check found.

Actions:

- `worldbuilding.openOverview` (book, grouping kind, range, layout, and optionally an occurrence to open around; opens
  the overview, the world's kinds and the last change in the same request);
- `worldbuilding.showRange` and `worldbuilding.stepOverview` (from an occurrence, `n` on in reading order, or to its
  parent or first child; the range follows where it lands when that is outside it) act on the overview the session
  shows, since that is what they move;
- `worldbuilding.showRelationKinds` (book) opens the kinds view for a world, where no overview is open;
- `worldbuilding.createRelationKind`, `renameRelationKind`, `deleteRelationKind` (book, kind), `mergeRelationKind`
  (book, kind, into);
- `worldbuilding.addRelation` (also "Also put in…"), `moveRelation` (to another target, or among the relations of its
  kind and target: "Move to…" and dragging), `removeRelation` ("Take out of…"), `setRelationWeak`, each naming its book. A position is given as the
  sources it goes between (`after`, `before`); with neither it goes last. When the neighbours leave no byte string
  between them, it takes the lower neighbour's position and ties are ordered by entity id. Moving or re-weighting a
  relation rewrites only its `target`, `position` and `weak` fields, keeping every other field of its object and every
  other relation as written.

The engine answers each read in one snapshot (`overview.rs`: `read_overview`, `step_in_reading_order`;
`relations.rs`: `relation_edit`, `unreached_among`). A relation action is one commit of the entry's own field, then the
check, in the same request.

Opening a view from an action is a gap the core had: a view was only answered once the tab had sent `view.open`, so
opening the overview at a range would have been two requests. An action's result may name views it `opensViews`
(`packages/server-ui`); the tab shows them from then on.

An occurrence's key is the path of entity ids from its top-level entry (`12/45/78`), and a region's "+N more" tile is
`12/45/+`. So:

- **KeysAt** is the range; **Locate** of a top-level key is its rank in the held range, else a step by 0;
- **the tree per region** is each entry's `region`;
- **Step** within what's held is the held entries in pre-order; past it, `stepOverview`;
- **parent** is the key without its last part; **first child** is the first of the held region's cells, else `stepOverview`;
- **inside region** `k` is "starts with `k/`".

## Existing stores

Entries written before the tree aren't in it, and a later `entryIndex` write or deletion of one is refused (the tree
never guesses). The derived relation keys of this round's format (the relation's object kept in `RELATIONS_OF_ENTRY`,
the slots of the tree, the deletion and merge keys) are only ever built from the relations fields, and no stored world
has any relation yet, so the conversion has nothing else to convert: a world with no `relationKinds` is already the new
format, and no job is pending in a store this conversion runs on. `scripts/convert-lorebooks-to-worldbuilding.mjs` puts every entry of every counted book in its world's
order and indexes any `relations` already stored in this format, in steps of 2000
(`relations::world_order_conversion_step`, idempotent), run once with the server stopped, then deleted with
`Store::world_order_conversion_step` and its binding. No stored world has kinds or relations in this format yet (no
page wrote any), so a world with no `relationKinds` already is the new format: an empty list. A `relations` value in any
other shape holds none and is kept as it is.

## Open

### Other

- Whether the "+N more" tile is a stop in reading order (it is now).
- The search box (the view's filter): see below.

### The filter (not built)

A filter has no kept counts (`worldbuilding.md`, Cells), so a filtered overview has no ranks: it is read by cursor as
the reader scrolls, without totals. It needs: the filter compiled to a per-entry check over the book's search index
(the library's `DocCheck` shape); the top level walked in the world's order from a cursor, keeping the entries that
pass; a region's entries walked from `RELATIONS_BY_TARGET` the same way, each region read up to a cap ("1,000+");
and what a filtered region shows when entries in it match but its own entry doesn't (the owner's).
