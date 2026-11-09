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
and that isn't being merged or merged into (one seek among the roots of its trees of sources, `SOURCES_ORDER_COUNT (b,
k, ·)`, to answer "in use", and the end-of-commit check refuses it anyway if one does). The page picks a relation's kind from the list (the
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
are found from A's own indexes (the roots of A's trees of sources, `SOURCES_ORDER_COUNT (b, A, ·)`, one seek per
target, then `RELATIONS_BY_TARGET (b, t, A, ·)`, and `KEPT_RELATIONS_BY_KIND (b, A, ·)`), never by a scan of the world. When no live source has a relation of kind A,
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
## Names and the label

An entry's names are one extension field, `extensions.names`, stored as the entry's JSON field `\u0001names` like
`relations`: a list of strings. Every write of an entry passes it through one function (`withNamesOfItsKeys`,
`src/world-info-engine.js`), which keeps only strings that are keys of the entry (`key`, or a card book's `keys`), in
the keys' order, once each. A value that isn't a list is kept as written and holds no names. The engine reads the names
as the keys the field marks (`entry_label::names_among`), so a name is always a key whatever wrote the field.

Every place that draws an entry gets its **label** from the engine (`entry_label::label`), one rule: a title (upstream
`comment`) with anything but white space in it is the label, shown as a name when it equals one of the entry's names
and as a title otherwise; with no title, the first name; with neither, the opening of the text (from its first
character that isn't white space to the end of that line, at most 120 characters). A label is
`{ thing, text, shownAs }`, `thing` being the entry's entity id.

## Keys shared between entries

An entry's page says, per key, how many other live entries of its world have the same key (`alsoBringsUp`). The count
is kept, never counted on read: `KEY_ITEMS_BY_TEXT (b, key text) → count` (Add), the number of key items of the world's
live entries with exactly that text. Every write of a key item passes the one hook every text write of a counted book's
entry passes (`references::key_written`): the old text's count goes down by one, the new text's up by one, and a count
that reaches 0 is deleted. An entry's creation and restore count all its keys (`references::entry_keys_came`), its
deletion uncounts them (`references::entry_gone`). The read is one get per key: the count less the entry's own items with
that text. The same text twice in one other entry counts twice.

## The stored relation

One extension field of the entry, `extensions.relations`, stored as the entry's JSON field `\u0001relations`
(`src/world-info-engine.js`):

```json
[{ "kind": 1, "targetEntry": "4711", "position": "m" }, { "kind": 2, "targetEntry": "4790", "position": "a", "weak": true }]
```

A relation names its target by the target's **entity id** (`targetEntry`, decimal), which the store never gives to
another entity: deleting an entry and making another under its key (upstream's `uid`) leaves every relation meaning
what it meant. `position` is a fractional order key compared as bytes, so moving a relation among the others of its
kind and target rewrites only its source's field (a history edit of a few bytes). A position made at either end (a
relation added last, or placed before the first) is a whole number, a head letter giving its count of digits
(`a`…`z` for 1 to 26, `Z`…`A` for 1 to 26 below `a0`) then the digits `0-9A-Za-z`, one more or one less than the
whole number its neighbour starts with (`relations::position_between`), so `n` relations added last are
`log62(n) + 1` bytes long, not `n / 7` as halving the space above the last one would make them; a neighbour that
starts with no whole number gets the nearest whole number past it. A position between two is the shortest string
between them, so only repeated placing at one spot grows a position faster than that. `weak: true` makes the relation
**weak**: the source is drawn in the target's region like any other source of that kind, but the relation doesn't keep
it off the top level (below). A value that isn't a list of such objects holds no relations: a third party's
`relations` extension is read and kept as it is, never refused. A second `(kind, target)` in the list is ignored; the
first one counts.

**World files carry keys.** Entity ids mean nothing outside one store, so a world file's relation names its target by
the target's key (`"target": 12`), as before. Reading a world (export, the drawer, a card book) turns each
`targetEntry` of a live entry of the same world into `target` with that entry's key and leaves out every other one: a
relation kept while its target is deleted (below) is in no read and no export, and no file ever carries an entity id.
Writing turns each `target` into the `targetEntry` of the entry with that key in what is written (an import, a
whole-world save) or in the stored world (an entry edit), and leaves out one whose key names nothing or names an entry
that isn't live after the write; a written `targetEntry` is kept only when it names an entry live after the write. The
translation reads only what the write or read already holds, plus one lookup per target key not among them and one
read of which named entries are live (`worldbuildingLiveEntriesOf`).

**A whole-entry write leaves kept relations as they are.** Every write that replaces an entry's relations list (a save
from the drawer, an entry edit, a whole-world save or import over a stored world, the one-time conversion to entity ids)
passes one function (`relationsForStore`): the relations the entry's stored field holds whose target isn't live after
the write are carried over from the stored field unchanged, and whatever the written list says about a target that
isn't live is ignored. So what was read and saved back, with its kept relations left out, changes nothing kept; a
kept relation changes only by its own action (`removeRelation`, which accepts a target that is a deleted entry of the
world), by its source's deletion or restore, or by its target's restore or erasure. A whole-world save also keeps each
stored kind name that kept relations still hold (`worldbuildingRelationKindKept`), so a save of a read can't remove a
kind a kept relation needs. Reverting the relations field to an earlier version as a whole is refused ("relations
change by their own actions").

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
while its source is deleted**. Only relations in use are in `RELATIONS_BY_TARGET`, the trees of sources and the held
counts.

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
- **A user's own removal.** A relation in use to D that a source's write drops before the step reaches it (an edit, a
  save from the drawer that left it out) is gone for good; a kept one goes only by `removeRelation`. Either way a later
  restore of D doesn't bring it back, because the restore only uses what the sources' fields still hold.
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

**What bounds a kept relation's life.** It goes when it comes back into use (its target restored), when it is removed
by its own action, or when its target is erased for good. While kept it costs its derived keys and nothing else: no job
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
| `SOURCES_ORDER_EDGE (b, k, t, P, d)`, `SOURCES_ORDER_COUNT (b, k, t, P)` | the tree of sources of kind `k` targeting `t` (below) | rank ↔ source in a region ("what points at it"); its root's count is how many relations in use of kind `k` target `t` ("+N not shown"); a root under `(b, k)` is kind `k` in use |
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

**The sources pointing at an entry** are one counted radix tree per `(b, k, t)` with a relation in use of kind `k`
targeting `t` (`world_order_tree.rs`, the world's order's tree in another space, `SOURCES_ORDER`), with only the plain
count (no held slots): its count is the region's count, a range from a rank is a descent skipping by counts, and a
source's rank is a descent along its path. The tree is written by the two functions every relation's coming into and
going out of use passes (`relations::put_into_use`, `take_out_of_use`), which also write `RELATIONS_BY_TARGET`: an
add, a removal, a move (out and in), a deletion's and a restore's steps, a source's deletion and restore, and a
merge's rewrites. A tree whose last source goes leaves nothing behind.

**Its leaf key is RELATIONS_BY_TARGET's own suffix**, `put_bytes(p) ++ put_u64(e)`: the position escaped (each `0`
byte as `0 ff`, then `0 1`) and the source's id length-prefixed. So the tree's byte order over its leaves is
RELATIONS_BY_TARGET's order under `(b, t, k)` by construction: the same bytes, compared the same way. Both parts are
prefix-free codes, so no leaf is a prefix of another, which is all a path-compressed radix tree needs; a leaf is told
from a node's prefix by parsing it (`relations::is_source_leaf`). A fixed-width leaf can't order the same: positions
have no length bound, and two that share their first `w` bytes would tie on any `w`-byte prefix and be ordered by
source instead of by the rest of the position. A node's key carries its prefix's length in one byte below 255, else
255 and eight bytes, so the world's order's keys are as they were.

**Its depth** is the number of branching bytes on a leaf's path: about `log62(n) + 1` for positions made at the ends,
at most the position's length plus 10. Ties (one position, several sources) branch only in the source's id.

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
| each step of a deletion, a restore or a merge after the action's own commit | pushed to the world's open tabs: the view `worldbuilding.loopsLeftByJobs` (the loops the world's jobs have found since its last job began), changed by `ui.changed` after each step, whether a request started the job or the store's opening resumed it (each store's job runner reports its steps on the store's events, `worldbuildingJobStep`, which `src/ui-wiring.js` turns into the push when the store opens) |

Requests that don't carry a limit use `LOOP_CHECK_VISITS_PER_WRITE` (below).

## What each write touches

`depth` is the tree's depth at the entry: about `log256(n) + 1` for spread keys (5 at 10 billion), at most 16.
`depth_s` is a tree of sources' depth at a source's leaf: about `log62(n) + 1` for positions made at the ends (about 4
at 312,112 sources), at most the position's length + 10.

| Write | Derived writes |
|---|---|
| an entry's field other than `relations` | none |
| relation added, the source already has a strong relation of its kind, or the new one is weak | 2: `RELATIONS_OF_ENTRY`, `RELATIONS_BY_TARGET`; + its tree of sources: `depth_s` counts + 1 edge (a split adds 3), `depth_s` the tree's depth at the leaf, reading the path first; 3 (the entry's and the two kept indexes) if its target is deleted |
| strong relation added, first strong one of its kind on the source | 3 + `depth` (`HeldByKind` along the source's path) |
| relation removed | the same, mirrored (a node left with one child merges: 2 edges and its count deleted); + `depth` if it was the last in use of its kind targeting a deleted entry, + `depth` + 1 edge + 1 marker if the last of all |
| position changed | 3: `RELATIONS_OF_ENTRY`, `RELATIONS_BY_TARGET` out and in; + its leaf out of the tree of sources and in at the new position (2 × (`depth_s` + 1 edge)) |
| target changed | 4 (one out, one in) + a leaf out of one tree of sources and into another; + `depth` if the source's last strong one of the kind goes or its first comes |
| weak ↔ strong, or an extra field changed | 1: `RELATIONS_OF_ENTRY`; + `depth` if it is the source's only strong relation of its kind |
| entry created | `depth` + 1 edge; a split adds 3 + one count per slot under the split edge |
| entry deleted | each own relation made kept (2: its entry key and the count per kind, after its in-use keys go) + `depth` × (its strong kinds) ; if nothing in use targets it, `depth` + 1 edge to leave the tree, else `depth` × (1 + the kinds targeting it) + 1 marker; one seek per kind targeting it; and up to 1,000 relations targeting it made kept (each: 3 in-use keys out, 3 kept keys in, + `depth` if the source loses its last strong one of the kind) |
| one deletion step | up to 1,000 relations made kept, as above (each one's leaf out of its tree of sources); the end as in "relation removed" |
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
| a region's first `m` entries and how many there are | one page of `m` of `RELATIONS_BY_TARGET (b, t, k)` + 1 get (the tree of sources' root) |
| the kinds pointing at an entry | one seek per kind in `RELATIONS_BY_TARGET (b, t, ·)` |
| what points at an entry: `n` sources of kind `k` from rank `r` | a descent of the tree of sources skipping by counts: 1 get per node on the way, `O(depth_s)` per source found, then each source drawn as a top-level entry |
| a source's rank among those of kind `k` targeting `t` | its `RELATIONS_OF_ENTRY` + 1 get per node on its path |
| a card | the entry's title, text (cut), keys, names and `RELATIONS_OF_ENTRY`; per relation the target's label (its title, keys, names, and its text when it has neither a title nor a name) and the kind's name |
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

- a card costs about 10 reads (title, text, the key list, the names, the relations, and per relation the kind's name
  and the target's label: its title, key list, names and, with neither a title nor a name, its text; counted with one
  relation), so a read draws at most 2,400 cards (`MAX_CARDS_PER_READ`): the range's top-level entries
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
- `worldbuilding.lastChange`: what the session's last change left to say: the kind it created, the relation whose
  change left its entry unreached with the entries the check found, the entry it made, the entry it deleted (with its
  label, for Restore), the entry it moved to another world (and the entry it became there).
- `worldbuilding.entry`: the session's open entry: its label, title, keys (each a name or a trigger, with how many other
  live entries of the world have it), text, relations line (each target a label), placement (every upstream field but
  `key`, `comment` and `content`, as stored, missing ones at upstream's defaults, `public/scripts/world-info-entry-defaults.js`,
  and whether any differs from them), its text in tokens as the chosen connection counts them, and what mentions it:
  the first page of the references to it (`src/world-info/references.js`), each source's label with the sentence
  around its first mention, and the pages `showMoreMentions` added. A deleted entry shows as deleted, under the label
  it was last shown with.
- `worldbuilding.pointingAt`: what points at the session's open entry: `{book, entry, sections}`, one section per kind
  with a relation in use targeting it, in kind id order (the kinds read by one seek each, never from the sources),
  each `{kind, kindName, count, firstRank, entries, stepLanding}`: its sources ranked by their tree, each drawn as a
  top-level entry of the overview is (its region grouped by the same kind, the same layout and repeat cut, the open
  entry being on the drawing path, so a source that is the entry itself is a repeat). Each section's range is held per
  session; one never asked for is ranks `[0, endRank)` from `openEntry`. A read draws at most `MAX_CARDS_PER_READ`
  cards: the ranges are cut in the order they were last asked for (the one asked last first), then the unasked ones'
  in kind order, so the range just asked for is always read whole. A deleted entry, or none open, has no sections.
- `worldbuilding.worlds`: every world, `{id, name, entries, usedInEveryChat}`, in the order of the files their names
  would have had (`compareBookKeys`: `<name>.json` by the server's locale); `entries` is the book's kept count
  (`book_stats`), so no world's entries are read.
- `worldbuilding.world`: the shown world's header, the same fields, or `{id: null}` when no world is shown.
- `worldbuilding.results`: the session's filter on the shown world and what it finds (The filter, below): `{book,
  filter: {query, chips}, pages}`, each chip `{kind, kindName, target, targetDeleted, depth}` (its target's
  label, the last one shown once the target is deleted), each page `{cursor, entries, next}`: the pages the page
  asked for and nothing else, each the cards its cursor reads, drawn as the overview draws a top-level card with no
  region; `{book: null}` with no filter.
- `worldbuilding.found`: the session's search for a target entry (Move to, Also put in, + relation's target step):
  `{book, query, entries, next}`, the first `FOUND_PER_QUERY` (20) labels of the best matches.

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

- `worldbuilding.openEntry` (book, entry, and how the page draws what points at it: the layout and the `endRank` each
  section starts with, within one read's budget; opens the entry view and `worldbuilding.pointingAt`), `closeEntry`,
  `showMoreMentions` (cursor);
- `worldbuilding.showPointingAtRange` (kind, range) and `worldbuilding.stepPointingAt` (kind, from an occurrence or
  none, `n` on in reading order or to its parent or first child; the section's range follows where it lands), refused
  past one read's budget as the overview's are; every relation, entry and kind action that answers the entry view or
  the overview answers `worldbuilding.pointingAt` too, and each job step pushes it;
- `worldbuilding.setEntryText`, `setEntryTitle` (empty clears it), `addKey` (as a name or a trigger, on any entry of
  the world), `setKeyAs`, `removeKey`, `setPlacement` (a partial set of placement fields, each checked by its own
  schema), each naming its book and entry, each a write of the entry as it is stored at that moment (last write wins);
- `worldbuilding.createEntry` (after an entry or last, optionally named, optionally with a relation, optionally opened,
  with the same layout as `openEntry` takes):
  one commit. It goes right after `after` in the world's order: between its order value and the next entry's, a whole
  number when one fits, else the middle (`entry_page::place_after`). When the next entry has the same order value, the
  entries with that value after `after` (at most 1,000) move to a value between it and the entry after them, and the
  new entry takes `after`'s value; past 1,000, or with no value between, it takes `after`'s value and lands after them.
  Last is one more than the last numbered entry's value, rounded down. A new entry has upstream's fields at their
  defaults; with a name, the name is its one key and its one name; its relation goes last among its kind's to its
  target (`relations::relations_of_new_entry`);
- `worldbuilding.deleteEntry` (the chunked delete, through `apply`), `restoreEntry`, `moveEntryToWorld` (a transplant
  that deletes the original; its relations drop; an open entry follows it).
- `worldbuilding.openOverview` takes `book: null` for the world last opened: a book choice of the user in its own slot
  (`CHOICE.lastOpened`), so it follows a rename and goes with a delete; upstream's `power_user.wi_last_editor_book`
  becomes it when upstream's settings are converted. Else the first world; with none, it opens `worldbuilding.world`
  as no world and `worldbuilding.worlds`. Opening a world writes the choice when it changes.
- `worldbuilding.openWorlds` opens the list; `createWorld` (a name; refused when taken, reserved for embedded books, or
  no name a book key can be), `duplicateWorld` (the next free `name (n)`), `importWorld` (the file sent with it:
  upstream's world file, upstream's PNG with a world in its `naidata` text, or a NovelAI, Agnai or Risu book,
  `src/world-info/world-files.js`; named after the file, made free the same way) each write a new book in one commit
  (`books.create`, refused in the write's lane when the name is taken) and open it at the range they carry;
  `renameWorld` and `deleteWorld` are the books' rename (relinking) and delete, run through the settings document so the
  choices it shows follow; `exportWorld` answers `{fileName, json}` in the action's answer; `setUsedInEveryChat` writes
  the user's global selection choice. A delete clears every session showing the world.

- `worldbuilding.setFilter` (book, query, chips, page size within one read): sets the filter of the world the session
  shows and opens the results at their first page, closing an open entry (typing on an entry's page goes to the
  world's page); refused when a chip names no live entry of the world; an empty query with no chips clears it. It
  holds the first page. `showResults` (cursors, null for the first page) names the window of pages the page wants,
  and the session holds those and nothing else; it is refused when they would read more than one read's cards, or
  when a cursor is another filter's: the page sees each store cursor as `<generation>.<cursor>`, the generation
  counting each filter set, so a cursor of an earlier filter is never read under a later one. Opening another world
  clears the filter; every action that answers the overview answers the results, re-reading the held pages by their
  cursors, and job steps push them.
- `worldbuilding.findEntries` (book, query): one request per changed query.

The engine answers each read in one snapshot (`overview.rs`: `read_overview`, `step_in_reading_order`, each for the
world's top level or for the sources pointing at an entry, and `read_pointing_at`;
`relations.rs`: `relation_edit`, `unreached_among`; `entry_page.rs`: `read_entry`, `labels`, `place_after`). A relation
action is one commit of the entry's own field, then the check, in the same request. The entry view is the engine's read
of the entry, then the entry's stored fields for its placement, its count and the references to it, in the same
request (`src/world-info/worldbuilding-entries.js`).

Opening a view from an action is a gap the core had: a view was only answered once the tab had sent `view.open`, so
opening the overview at a range would have been two requests. An action's result may name views it `opensViews`
(`packages/server-ui`); the tab shows them from then on.

An occurrence's key is the path of entity ids from its top-level entry (`12/45/78`), and a region's "+N more" tile is
`12/45/+`. In a section of what points at an entry, the key starts with the list it is in, `<kind>@<entry>`, then the
path from the source (`3@4711/12/45`, `3@4711/12/+`); the open entry itself is never a key's part, and its parent is
no step. So:

- **KeysAt** is the range; **Locate** of a top-level key is its rank in the held range, else a step by 0;
- **the tree per region** is each entry's `region`;
- **Step** within what's held is the held entries in pre-order; past it, `stepOverview`;
- **parent** is the key without its last part; **first child** is the first of the held region's cells, else `stepOverview`;
- **inside region** `k` is "starts with `k/`".

## The filter

A filter has no kept counts (`worldbuilding.md`, Cells), so its results have no ranks: they are read by cursor as the
reader scrolls, without totals (`world_search.rs`). Its words are the app's one search (`src/search-clauses.js`, the
card library's syntax: `field:word`, `-field:word`, quotes) over the world's search index (`searched.rs`, one scope per
book, holding only live entries), with a world's fields as labels: `key`/`keys`, `title`, `text`, `group`,
`secondary`. A chip is a relation filter: kind, target, and **directly** or **at any depth**; chips and words all
must hold. The chip's target is never in its own results.

- **With words**, the results are the search's own hits in its order (relevance, as the card library's), a page per
  cursor (the last hit's score and entity, and the query's word weights from the first page, so a later page scores
  as the first did). A chip is a check on each hit the search considers: directly is one get of
  `RELATIONS_OF_ENTRY (e, k, t)` in use; at any depth walks **up** from the hit through its relations in use of kind
  `k` (weak ones too, since a weak relation draws its source in the target's region), breadth first with a visited
  set, until it meets `t`. Walking up costs the hit's ancestry of kind `k` (one scan of `RELATIONS_OF_ENTRY (e, k, ·)`
  per entry met), and what one walk learns (reached, or not reached after a full walk) is kept for the rest of the read,
  so a read's walks cost about the hits plus their distinct ancestors: the same order as the search's own work.
  Walking **down** from `t` would cost `t`'s whole subtree before the first hit, at any size of it; so the walk goes
  up. A walk past `CHIP_WALK_VISITS` (12,000, one request's budget at two reads a visit) answers no; only a hit with
  more ancestors of the kind than that reaches it.
- **With no words**, there is no relevance, and walking the world to check each entry would cost the world, so the
  first directly chip (else the first chip) leads and the others check. Directly reads `RELATIONS_BY_TARGET (b, t,
  k)` in position order: the region's own order. At any depth reads the region in its drawing order, pre-order, each
  source followed by its own region, an entry already on the path from `t` not entered again (as the overview cuts
  repeats along the drawing path, never by walking the graph), so an entry in two places of the region is listed at
  each, as the overview draws it. The cursor is the path from `t` with the position reached at each level. A page
  reads at most `WALK_STEPS_PER_PAGE` (12,000) keys; one that reaches it ends there, with a cursor that goes on.
- **Cards** are the overview's, with no region; a card's key is its entity with words, else its path from the
  leading chip's target. Every page held is read again in one snapshot when the view is read, so a cursor reads the
  same page while nothing changed. A cursor the store can't use for this search (not its form, or a word weights
  list of other words) reads an empty last page rather than failing the read.

**Finding a target** (`worldbuildingFind`) is the same search over keys (so names) and titles only, the first page of
its hits as labels; no words find nothing.

## Existing stores

Entries written before the tree aren't in it, and a later `entryIndex` write or deletion of one is refused (the tree
never guesses). `scripts/convert-lorebooks-to-worldbuilding.mjs` does two things, in steps, idempotently, run once with
the server stopped, then deleted with what only it uses:

1. Rewrites every relations field still naming targets by key (`"target"`) to name them by entity id
   (`"targetEntry"`), as a history edit of that field, leaving out relations whose key names no entry of the world
   (`WorldInfoEngine.relationsByEntity`). No stored world has any relation yet, so this finds nothing today; it is
   there so the format can't be met half-converted.
2. Puts every entry of every counted book in its world's order and indexes its relations, their trees of sources
   included (`relations::world_order_conversion_step`).

Its first step also deletes every `KEY_ITEMS_BY_TEXT` count, and each step counts the keys of the entries it passes, so
a run counts every key again from nothing. It prints only totals. Running it twice changes nothing.

## Open

### Other

- Whether the "+N more" tile is a stop in reading order (it is now).
- What a filtered region shows when entries in it match but its own entry doesn't (the owner's). Until decided, the
  results are plain cards in the search's order, each with its relations line (The filter).
