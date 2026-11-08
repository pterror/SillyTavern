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
derived key `KINDS_BEING_MERGED (b, A) → B` (kept while A's name field exists) so a restarted server finds the job.
From then on A can't be picked for a new relation (`relation_edit` refuses it), B can't be deleted or merged, and A
can't be merged again.

The merge job rewrites, in chunks of `RELATION_CHANGES_PER_STEP` source entries, each chunk one commit with other
writes in between (`worldbuildingKindMergeRewrites`): each live source's relations of kind A become kind B, both those
in use and those kept while their target is deleted (below); a source that already has the same relation of kind B
gets one relation, B's item, strong if either was, with A's extra fields added where B's item lacks them. The sources
are found from A's own indexes (`RELATION_COUNT_BY_KIND_AND_TARGET (b, A, ·)` then `RELATIONS_BY_TARGET (b, t, A, ·)`,
and `KEPT_RELATIONS_BY_KIND (b, A, ·)`), never by a scan of the world. When no live source has a relation of kind A,
the job deletes A's name field. Every state partway is valid: each source has its relations in one kind or the other,
each counted where it is. The merge costs one rewrite per live source with a relation of kind A; an alias (A saying
"is B" while relations keep A) wouldn't avoid that, since an entry with the same relation in both kinds would be
counted twice in B's held count and listed twice in B's region until each such entry is rewritten.

**The merge's record.** A deleted entry's own field can't be rewritten, so its relations of kind A stay as written.
The marker field stays, without A's name, as the record "A was merged into B", while any deleted entry has a relation
of kind A (`RELATIONS_OF_DELETED_ENTRIES_BY_KIND (b, A)`, a count); restoring such an entry rewrites its relations of
kind A to B in the restore's own commit (`worldbuildingRelationsKept`). When the count reaches 0 the record is due
(`KIND_MERGE_RECORDS_DUE (b, A)`) and the job deletes it. Its cost: one book field and one count per merged kind,
nothing per relation and no read at a store's opening; it lasts as long as a deleted entry holding such a relation
can still be restored.
## The stored relation

One extension field of the entry, `extensions.relations`, stored as the entry's JSON field `\u0001relations`
(`src/world-info-engine.js`):

```json
[{ "kind": 1, "targetEntry": "4711", "position": "m" }, { "kind": 2, "targetEntry": "4790", "position": "a", "weak": true }]
```

A relation names its target by the target's **entity id** (`targetEntry`, decimal), which the store never gives to
another entity: deleting an entry and making another under its key (upstream's `uid`) leaves every relation meaning
what it meant. `position` is a fractional order key compared as bytes, so moving a relation among the others of its
kind and target rewrites only its source's field (a history edit of a few bytes). `weak: true` makes the relation
**weak**: the source is drawn in the target's region like any other source of that kind, but the relation doesn't keep
it off the top level (below). A value that isn't a list of such objects holds no relations: a third party's
`relations` extension is read and kept as it is, never refused. A second `(kind, target)` in the list is ignored; the
first one counts.

**World files carry keys.** Entity ids mean nothing outside one store, so a world file's relation names its target by
the target's key (`"target": 12`), as before. Reading a world (export, the drawer, a card book) turns each
`targetEntry` of an entry of the same world into `target` with that entry's key; one whose target isn't in the world
(a deleted entry, below) stays as `targetEntry`, so a save of what was read keeps it. Writing turns each `target` into
the `targetEntry` of the entry with that key in what is written (an import, a whole-world save) or in the stored world
(an entry edit), and leaves out one whose key names nothing; a `targetEntry` is kept only when it names an entry of
this world, live or deleted. The translation reads only what the write or read already holds, plus one lookup per
target key not among them.

This field is the only source of truth. Everything below is derived from it by the entry's own writes (`histSet`,
`histEdit`, `jsonValue`, `valueDelete`, creation, deletion, restore), through the one hook every JSON write of a counted
book's entry passes (`book_stats::owned_value_changed`), and its creation and deletion (`book_stats::created`/`gone`).

## No relation names a missing entry or kind

The store refuses any commit that ends with a relation naming an entity that isn't an entry of its world (live, or
deleted and restorable), or a kind the world neither has nor holds a merge record for. It is checked once, at the end
of the commit (`commit_checks.rs`): a write that adds a relation leaves a check for its target and its kind in the
commit's own layer; erasing an entry leaves one for it; removing or merging a kind leaves one for the kind. At the end
the engine runs each check (one bounded read each) and drops the check keys, which never reach the keyspace (replay,
bulk loads and derive jobs drop them too). Checking at the end, not per record, is what lets a world be imported in any
order and with loops.

- **Writing a whole world** (import, save of the whole book): relations to keys not in the written world, or to kinds
  not in its `relationKinds`, are left out of what is written.
- **Moving an entry to another world** drops its relations.
- **Deleting and restoring an entry**: below. Nothing is refused while a deletion runs: creating, importing or restoring
  an entry under the deleted entry's key makes a different entity, which no relation names.

## Deleting an entry

Deleting entry D is one change, whatever targets it. D is gone at once, and every relation of every kind whose target
is D stops counting: its source shows where it would without it. The relations stay written in their sources' fields,
**kept**: nothing a user wrote is rewritten by the store.

Each relation's derived state (`RELATIONS_OF_ENTRY`) is one of: **in use**; **kept while its target is deleted**; **kept
while its source is deleted**. Only relations in use are in `RELATIONS_BY_TARGET`, the counts and the held counts.

- **The delete itself** (`relations::entry_deleted`). D's own relations become kept while their source is deleted
  (counted per kind in `RELATIONS_OF_DELETED_ENTRIES_BY_KIND`, so their kinds stay in use). If no relation in use
  targets D, D leaves the order tree. Otherwise D stays in it as **the place of a deleted entry**: counted as deleted
  (`DeletedWhileRelationsTargetIt`) and, for each kind of relation still in use targeting it, as a place shown under
  that kind (`DeletedEntryPlaceForKind(k)`). Up to `RELATION_CHANGES_PER_STEP` relations targeting D are made kept in
  the delete's own commit, so a small delete is one short change. If more remain, `DELETION_IN_PROGRESS (D) → (b, order
  value)` marks it.
- **The steps** (`relations::deletion_step`, a derive job driven by `src/world-info/worldbuilding-jobs.js`): up to
  `RELATION_CHANGES_PER_STEP` relations in use targeting D become kept while their target is deleted
  (`KEPT_RELATIONS_BY_TARGET (b, D, source, k)`, `KEPT_RELATIONS_BY_KIND (b, k, source, D)`). A step writes derived keys
  only, never a log record; each is its own short job, with commits in between. A step lost to a crash is redone: each
  step's result depends only on the state it reads.
- **What the reader sees meanwhile.** In a view grouped by kind `k`, D's place is at the top level where D was in the
  world's order, as a `placeOfDeletedEntry` cell with no content of D's, and its region shows the sources whose
  relation of kind `k` to D is still in use. A source whose relation was made kept goes where it would be without it:
  another region if it has another strong relation of `k` in use, otherwise the top level. In a view grouped by a kind
  no relation in use of which targets D, and ungrouped, D's place isn't shown. Nothing disappears and nothing is broken
  at any point.
- **The end.** When the last relation in use of kind `k` targeting D is made kept, D's place stops counting for `k`;
  when the last of any kind goes, D leaves the order tree and its marker goes, in that same step.
- **A user's own removal.** A source whose field drops a relation to D (an edit, a save from the drawer that left it
  out) has that relation gone for good, kept or not: a later restore of D doesn't bring it back, because the restore
  only uses what the sources' fields still hold.
- **Erasing** D for good (erasing its world, which erases the sources too) drops its place, its marker and its kept
  relations.

### Restoring a deleted entry

Restoring D undoes the deletion. If D's deletion is still running, the restore stops it at once: D's place and marker
go, and the relations still in use stay in use. D's own relations come back from its field (those whose kind was
merged since are rewritten to the kind it went into, in the restore's own commit; those whose target is deleted now are
kept while it is). Then the relations kept while D was deleted come back into use: up to `RELATION_CHANGES_PER_STEP` in
the restore's own commit, the rest by steps (`relations::restore_step`, marked by `RESTORE_IN_PROGRESS (D)`), each a
derive job like a deletion's. A kept relation's kind is in use the whole time (it can't be deleted, and a merge
rewrites it in its live source), so each comes back as written, in the kind it has by then.

**What bounds a kept relation's life.** It goes when it comes back into use (its target restored), when its source's
field drops it, or when its target is erased for good. While kept it costs its derived keys and nothing else: no job
lists it and nothing reads it at a store's opening. It lasts as long as its target can still be restored.

## Every job

| Job | Found by | One step | Ends when |
|---|---|---|---|
| a deletion | `DELETION_IN_PROGRESS` | up to 1,000 relations in use targeting the deleted entry made kept (derived keys only) | none in use targets it |
| a restore | `RESTORE_IN_PROGRESS` | up to 1,000 kept relations targeting the restored entry put back in use (derived keys only) | none kept targets it |
| a kind's merge | `KINDS_BEING_MERGED` | up to 1,000 live sources' fields rewritten from kind A to kind B (one commit) | no live source has kind A; then A's name goes |
| a merge record's end | `KIND_MERGE_RECORDS_DUE` | the record's field deleted | at once |

`RELATION_CHANGES_PER_STEP` is 1,000: a relation's change reads its key and writes a few derived keys plus the tree's
path, about 24 key operations, so a step is about the 24,000 reads one request may take (below, One request's budget).
A step that finds nothing to do ends its job. A failed step stops the job until the store next opens; a restarted
server reads the markers (`worldbuildingPendingJobs`, one scan of each marker index, which hold only running jobs) and
carries on.

After every step the server runs the capped loop check (below) on the sources the step changed and pushes what it
finds to the open tabs of the world's owner (`ui.changed` with `worldbuilding.loopsLeftByJobs`), since no request waits
on a step.

## Keys

Per relation (derived, one each):

| Key | Value | For |
|---|---|---|
| `RELATIONS_OF_ENTRY (e, k, t)` | state (in use, kept while its target is deleted, kept while its source is deleted), strength, `p`, the relation's object as written | the source's own relations: the write's diff (old set without reading the old value), its strong kinds, its relations line, the loop check's walk up |
| `RELATIONS_BY_TARGET (b, t, k, p, e)` | — | relations in use of kind `k` targeting `t` in position order (a region); every relation in use targeting `t` |
| `RELATION_COUNT_BY_KIND_AND_TARGET (b, k, t)` | count (Add) | how many relations in use of kind `k` target `t` ("+N not shown"); whether kind `k` is in use |
| `KEPT_RELATIONS_BY_TARGET (b, t, e, k)` | — | the relations kept while `t` is deleted, for its restore |
| `KEPT_RELATIONS_BY_KIND (b, k, e, t)` | — | the same by kind, for a merge and for "kind in use" |
| `RELATIONS_OF_DELETED_ENTRIES_BY_KIND (b, k)` | count (Add) | relations kept while their source is deleted, for "kind in use" and a merge record's life |

`t` is the target's entity id. A relation can be written before its target's creation in the same commit (an import
writes entries in any order, and loops allow no order): the target's state is decided when either is written, and the
end-of-commit check sees the commit's result.

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
  of the kind in use, or targeting a deleted entry's place (at the top level), or one an earlier walk of this write found
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
| each step of a deletion, a restore or a merge after the action's own commit | pushed to the world's open tabs: the view `worldbuilding.loopsLeftByJobs` (the loops the world's jobs have found since its last job began), changed by `ui.changed` after each step |

Requests that don't carry a limit use `LOOP_CHECK_VISITS_PER_WRITE` (below).

## What each write touches

`depth` is the tree's depth at the entry: about `log256(n) + 1` for spread keys (5 at 10 billion), at most 16.

| Write | Derived writes |
|---|---|
| an entry's field other than `relations` | none |
| relation added, the source already has a strong relation of its kind, or the new one is weak | 3: `RELATIONS_OF_ENTRY`, `RELATIONS_BY_TARGET`, `RELATION_COUNT_BY_KIND_AND_TARGET` (a count that reaches 0 is deleted, so no zero counters are left behind; that reads it first); 3 (the entry's and the two kept indexes) if its target is deleted |
| strong relation added, first strong one of its kind on the source | 3 + `depth` (`HeldByKind` along the source's path) |
| relation removed | the same, mirrored; + `depth` if it was the last in use of its kind targeting a deleted entry, + `depth` + 1 edge + 1 marker if the last of all |
| position changed | 3: `RELATIONS_OF_ENTRY`, `RELATIONS_BY_TARGET` out and in |
| target changed | 6 (one out, one in); + `depth` if the source's last strong one of the kind goes or its first comes |
| weak ↔ strong, or an extra field changed | 1: `RELATIONS_OF_ENTRY`; + `depth` if it is the source's only strong relation of its kind |
| entry created | `depth` + 1 edge; a split adds 3 + one count per slot under the split edge |
| entry deleted | each own relation made kept (2: its entry key and the count per kind, after its in-use keys go) + `depth` × (its strong kinds) ; if nothing in use targets it, `depth` + 1 edge to leave the tree, else `depth` × (1 + the kinds targeting it) + 1 marker; one seek per kind targeting it; and up to 1,000 relations targeting it made kept (each: 3 in-use keys out, 3 kept keys in, + `depth` if the source loses its last strong one of the kind) |
| one deletion step | up to 1,000 relations made kept, as above; the end as in "relation removed" |
| entry restored | its own relations back from its field (each as "relation added"); if its deletion was running, `depth` × (1 + the kinds targeting it) + 1 marker; up to 1,000 kept relations back in use (each the reverse of being made kept), + 1 marker if more remain |
| one restore step | up to 1,000 kept relations back in use |
| `displayIndex` changed | delete and insert: 2 × `depth` × (1 + the entry's strong kinds) + 2 edges |
| kind created or renamed | none (the kind's field is its own record) |
| kind marked merging | 1 (`KINDS_BEING_MERGED`); then per live source in its chunks, a relation removed and one added (above), or one removed when it folds into its twin; at the end A's name field (−1 index key), and the record while deleted entries hold kind A |


No write touches anything per other entry; a deletion's, a restore's and a merge's per-relation work is spread over
steps of at most 1,000 relations or sources each. A created entry is inserted at its key's order and moved when its
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
never guesses). `scripts/convert-lorebooks-to-worldbuilding.mjs` does two things, in steps, idempotently, run once with
the server stopped, then deleted with what only it uses:

1. Rewrites every relations field still naming targets by key (`"target"`) to name them by entity id
   (`"targetEntry"`), as a history edit of that field, leaving out relations whose key names no entry of the world
   (`WorldInfoEngine.relationsByEntity`). No stored world has any relation yet, so this finds nothing today; it is
   there so the format can't be met half-converted.
2. Puts every entry of every counted book in its world's order and indexes its relations
   (`relations::world_order_conversion_step`).

It prints only totals. Running it twice changes nothing.

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
