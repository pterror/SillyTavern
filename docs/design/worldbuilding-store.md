# Worldbuilding: the store and server side of the overview

What the engine keeps for the overview (`worldbuilding.md`, "Relations", "Views", "Grouping inside a cell", "Working at
any size"), what each write touches, and what each read costs. `b` is a book, `e` an entry's entity id, `u` an entry's
key (its upstream `uid`), `k` a relation kind's id, `t` a target's key, `p` a position.

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
(one read of `MEMBER_COUNT (b, k)` to answer "in use", and the end-of-commit check refuses it anyway if one does). The
page picks a relation's kind from the list (the `worldbuilding.relationKinds` view, searched ignoring case on the page)
and makes a new kind only by that separate action; the relation actions take a kind's id, never a name.

**Merging kind A into kind B** (not built) rewrites every relation of kind A to kind B: one history edit of each entry
that has one, and its derived writes (each relation moves from A's groups to B's, and the entry's hold on A moves to B).
Its cost is per relation of kind A, and it is the same large atomic write as deleting an entry with many members (below,
Open), so it waits on that decision. An alias (A's field saying "is B", relations keeping A) doesn't avoid the cost: an
entry with "A: Saltmarrow" and "B: Saltmarrow" would be in Saltmarrow's B group twice, and an entry held by both A and B
would be counted twice in B's held count, so every entry having both has to be found and corrected: per relation again.

## The stored relation

One extension field of the entry, `extensions.relations`, stored as the entry's JSON field `\u0001relations` (an
unknown extension key, `src/world-info-engine.js`), so it round-trips through world files and card books:

```json
[{ "kind": 1, "target": 12, "position": "m" }, { "kind": 2, "target": 7, "position": "a", "weak": true }]
```

`target` is the target's key in the same book (a number or a string, as upstream's `uid`); `position` is a fractional
order key compared as bytes, so moving an entry within a group rewrites only that entry's field (a history edit of a
few bytes). `weak: true` makes the relation **weak**: the entry is drawn in the target's region like any member, but the
relation doesn't keep it off the top level (below). A value that isn't a list of such objects holds no relations: a
third party's `relations` extension is read and kept as it is, never refused. A second `(kind, target)` in the list is
ignored; the first one counts.

This field is the only source of truth. Everything below is derived from it by the entry's own writes (`histSet`,
`histEdit`, `jsonValue`, `valueDelete`, creation, deletion, restore), through the one hook every JSON write of a counted
book's entry passes (`book_stats::owned_value_changed`), and its creation and deletion (`book_stats::created`/`gone`).

## No relation names a missing entry or kind

The store refuses any commit that ends with a live entry's relation naming an entry that doesn't exist, or naming a kind
the world doesn't have. It is checked once, at the end of the commit (`commit_checks.rs`): a write that adds a relation
leaves a check for its target and its kind in the commit's own layer; deleting an entry leaves one for its key; removing
a kind leaves one for the kind. At the end the engine runs each check (one bounded read: is anything still pointing at
this key, and does it exist; is any group still of this kind, and does the kind exist) and drops the check keys, which
never reach the keyspace (replay and bulk loads drop them too). Checking at the end, not per record, is what lets a
world be imported in any order and with loops, and lets a world be erased entry by entry.

So every writer has to remove what would dangle, in the same commit:

- **Deleting an entry** (`apply`, `transplant` with the original deleted): every live entry pointing at it gets its
  `relations` rewritten without those relations, in the same commit, as history edits of each one's own field. The
  engine computes the rewrites from the deleted entry's members (`worldbuildingRelationsWithout`, one scan of
  `MEMBERS_BY_TARGET (b, u)` plus each member's own field). Cost: proportional to the deleted entry's members, nothing
  per other entry. Entries deleted in the same commit need no rewrite. This is the design the owner rejected (it can't
  delete past one commit's size, and a restore doesn't bring the members back); its replacement waits on a decision
  (Open).
- **Writing a whole world** (import, save of the whole book): each entry's relations to keys not in the written world,
  or to kinds not in its `relationKinds`, are left out of what is written.
- **Restoring an entry**: its relations to entries or kinds that are gone since are left out, by a history edit in the
  same commit (`worldbuildingRelationsKept`).
- **Moving an entry to another world** drops its relations: they name keys in the world it left.
- Erasing a world erases all its entries in one commit, so nothing is left pointing.

A commit can hold only as many records as a log file, so deleting an entry with more members than that is refused, not
done in part.

## Keys

Per relation (derived, one each):

| Key | Value | For |
|---|---|---|
| `RELATIONS_OF_ENTRY (e, k, t)` | strength, `p` | the entry's own relations: the write's diff (old set without reading the old value), its strong kinds, its relations line, the loop check's walk up |
| `MEMBERS_BY_TARGET (b, t, k, p, e)` | — | a group's members in the group's order; everything pointing at `t` |
| `MEMBER_COUNT (b, k, t)` | count (Add) | "+N more", kept on write; whether any relation still uses kind `k` |

Groups are keyed by the target's key, not its entity id, so a relation can be written before its target exists within a
commit (an import writes entries in any order and loops allow no order), and a target restored under its key gets
nothing back (its members were rewritten when it was deleted).

**The world's order** is one counted radix tree per book over every entry (`world_order_tree.rs`),
`(order value, e)` as 16 bytes: the order value is `displayIndex`, else the entry's numeric key (upstream's editor shows
`displayIndex ?? uid`), else last. A path-compressed radix tree with 256-way nodes, canonical (every node but the root
has two or more children), so its shape depends only on the set:

| Key | Value |
|---|---|
| `ORDER_TREE_EDGE (b, P, d)` | the child's prefix (a node's, or the 16-byte entry for a leaf) |
| `ORDER_TREE_COUNT (b, P)` | AddMap: digit → entries under that edge |
| `ORDER_TREE_HELD (b, P, k)` | AddMap: digit → entries under that edge held by kind `k`: having a strong relation of kind `k` |

**The top of a cell** for kind `k` is every entry minus those held by `k`: under each edge,
`ORDER_TREE_COUNT − ORDER_TREE_HELD(k)`. It is the complement of a positive index, kept on the same tree. A positive
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
  relations change (a relation added, moved, made strong, or taken away, including by a deletion's rewrite of its
  members). So after the commit, the server takes every entry whose relations field the commit wrote (plus a restored
  entry) and, for each kind it still has a strong relation of, walks up: the entry, then the targets of its strong
  relations of that kind, then theirs, keeping a visited set. A walk stops when it meets an entry with no strong relation
  of the kind, or one an earlier walk of this write found reached (the entry is reached); an entry an earlier walk found
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

Requests that don't carry a limit use `LOOP_CHECK_VISITS_PER_WRITE` (below).

## What each write touches

`depth` is the tree's depth at the entry: about `log256(n) + 1` for spread keys (5 at 10 billion), at most 16.

| Write | Derived writes |
|---|---|
| an entry's field other than `relations` | none |
| relation added, the entry already has a strong relation of its kind, or the new one is weak | 3: `RELATIONS_OF_ENTRY`, `MEMBERS_BY_TARGET`, `MEMBER_COUNT` (a count that reaches 0 is deleted, so no zero counters are left behind; that reads it first) |
| strong relation added, first strong one of its kind on the entry | 3 + `depth` (`ORDER_TREE_HELD` along the entry's path) |
| relation removed | the same, mirrored |
| position changed (move within a group) | 3: `RELATIONS_OF_ENTRY`, `MEMBERS_BY_TARGET` out and in |
| target changed (move to another group) | 6 (one out, one in); + `depth` if the entry's last strong one of the kind goes or its first comes |
| weak ↔ strong | 1: `RELATIONS_OF_ENTRY`; + `depth` if it is the entry's only strong relation of its kind |
| entry created | `depth` + 1 edge; a split adds 3 + one `ORDER_TREE_HELD` per kind under the split edge |
| entry deleted | its relations' removals + `depth` × (1 + its strong kinds) + 1 edge; a merge 2 + one per kind at the node; and each member's rewrite (the member's own relation removal, above) |
| `displayIndex` changed | delete and insert: 2 × `depth` × (1 + the entry's strong kinds) + 2 edges |
| kind created or renamed | none (the kind's field is its own record) |

No write touches anything per other entry, except an entry's deletion, which rewrites its own members. A created entry
is inserted at its key's order and moved when its `entryIndex` record follows in the same commit; the shared upper
nodes' adds fold in the commit's layer. The end-of-commit checks read one key or one bounded scan each and write
nothing.

## Reads

| Read | Cost |
|---|---|
| top-level count | 2 gets (root `ORDER_TREE_COUNT`, `ORDER_TREE_HELD(k)`) |
| top-level range of `n` from rank `r` | a descent skipping by counts: 2 gets per node on the way, `O(depth)` per entry found, `O(n · depth)` worst case |
| an entry's rank in the top level | 2 gets per node on its path |
| a region's first `m` members and its count | one page of `m` + 1 get |
| a card | the entry's title, text (cut), keys and `RELATIONS_OF_ENTRY`; per relation one lookup of the target's title and one of the kind's name |
| a step in reading order | the top-level entry's drawn tree (bounded by the layout), and the next top-level entry's per one crossed |
| the kinds list | the book's fields |

### The layout comes from the request

The page says how regions are drawn; the server has no numbers of its own. The request carries, per nesting level (the
first is a top-level entry's own region), its **columns** and the **rows** a region shows, and how many **characters**
of an entry's text a card carries. A region at level `i` fills whole rows: `columns × rows` cells. When its members fit,
it shows them all; when they don't, it shows `columns × rows − 1` and the "+N more" tile takes the last cell. A region
nested deeper than the levels given isn't opened: its card shows its member count. A repeat (an entry already open
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
- `worldbuilding.relationKinds`: the world's kinds, `{id, name}` in id order.
- `worldbuilding.lastChange`: what the session's last change left to say: the kind it created, and the relation whose
  change left its entry unreached with the entries the check found.

Actions:

- `worldbuilding.openOverview` (book, grouping kind, range, layout, and optionally an occurrence to open around; opens
  the overview, the world's kinds and the last change in the same request);
- `worldbuilding.showRange` and `worldbuilding.stepOverview` (from an occurrence, `n` on in reading order, or to its
  parent or first child; the range follows where it lands when that is outside it) act on the overview the session
  shows, since that is what they move;
- `worldbuilding.showRelationKinds` (book) opens the kinds view for a world, where no overview is open;
- `worldbuilding.createRelationKind`, `renameRelationKind`, `deleteRelationKind` (book, kind);
- `worldbuilding.addRelation` (also "Also put in…"), `moveRelation` (to another target, or within the group: "Move to…"
  and dragging), `removeRelation` ("Take out of…"), `setRelationWeak`, each naming its book. A position is given as the
  members it goes between (`after`, `before`); with neither it goes last. When the neighbours leave no byte string
  between them, it takes the lower neighbour's position and ties are ordered by entity id. Moving or re-weighting a
  relation rewrites only its `target`, `position` and `weak` members, keeping every other member of its object and every
  other item as written.

The engine answers each read in one snapshot (`overview.rs`: `read_overview`, `step_in_reading_order`;
`relations.rs`: `relation_edit`, `unreached_among`). A relation action is one commit of the entry's own field, then the
check, in the same request.

Opening a view from an action is a gap the core had: a view was only answered once the tab had sent `view.open`, so
opening the overview at a range would have been two requests. An action's result may name views it `opensViews`
(`packages/server-ui`); the tab shows them from then on.

An occurrence's key is the path of entity ids from its top-level entry (`12/45/78`), and a region's "+N more" tile is
`12/45/+`. So:

- **KeysAt** is the range; **Locate** of a top-level key is its rank in the held range, else a step by 0;
- **the tree per region** is each entry's `children`;
- **Step** within what's held is the held entries in pre-order; past it, `stepOverview`;
- **parent** is the key without its last part; **first child** is the first of the held children, else `stepOverview`;
- **inside region** `k` is "starts with `k/`".

## Existing stores

Entries written before the tree aren't in it, and a later `entryIndex` write or deletion of one is refused (the tree
never guesses). `scripts/convert-lorebooks-to-worldbuilding.mjs` puts every entry of every counted book in its world's
order and indexes any `relations` already stored in this format, in steps of 2000
(`relations::world_order_conversion_step`, idempotent), run once with the server stopped, then deleted with
`Store::world_order_conversion_step` and its binding. No stored world has kinds or relations in this format yet (no
page wrote any), so a world with no `relationKinds` already is the new format: an empty list. A `relations` value in any
other shape holds none and is kept as it is.

## Open

### Deleting an entry with any number of members, and restoring it

The owner's requirements: a delete works at any member count, atomically, and a restore brings back the members'
relations to it. Every design that keeps "the members of a deleted entry show at the top, each at its own place" has to
change, at the delete, whether each member is held: an entry's place at the top depends on whether any of its holders is
live, so a delete flips that for up to every member, and any exact count of the top level changes at each of their
places. The options and their costs (`N` the deleted entry's members, `depth` about 5):

1. **Rewrite the members (built now).** `N` history edits in the log plus their derived writes, in one commit. Fails
   past one commit's size; a restore would have to rewrite them back (`N` again, and they must be found).
2. **A relation to a deleted entry resolves as absent.** The members' fields stay as written, so the delete is one log
   record and a restore brings everything back for free. But the held counts of every member whose only live holder was
   the deleted entry change: up to `N × depth` derived writes, atomically. In one commit that is memory proportional to
   `N` (a billion members: tens of gigabytes); chunked and installed at once (the engine already stages large derived
   output to disk for bulk loads), the store's writes wait for it, so the user's messages wait too (minutes at a
   billion), against the 200 ms rule. Partial or "pending" states are what the rules forbid.
3. **The deleted entry stays where it was, marked deleted, holding its members** until restored. One log record, nothing
   per member; a restore brings everything back; no entry is ever unreachable. The overview shows a deleted card (with
   Restore) in its place, and hides deleted entries that hold nothing.
4. **The deleted entry's members take its place.** Where the deleted entry was (at the top or in a region), its members
   are drawn instead, as if its group were spliced into its parent; one count per deleted entry on the order tree
   (its member count instead of 1), updated by its members' own writes. Nothing per member at the delete; a restore
   brings everything back. A member with another live holder shows there too, as an entry in several groups does. It
   needs a counted index per group, so that a range can start in the middle of a large spliced group: `depth` more
   writes per relation added or removed.

By the rules, 1 and 2 are out (1 fails "at any member count"; 2 costs per member and stalls writes). 3 and 4 both meet
the rules and differ in what the reader sees, which is the owner's: see the report.

### Other

- Whether the "+N more" tile is a stop in reading order (it is now).
- The search box (the view's filter): see below.

### The filter (not built)

A filter has no kept counts (`worldbuilding.md`, Cells), so a filtered overview has no ranks: it is read by cursor as
the reader scrolls, without totals. It needs: the filter compiled to a per-entry check over the book's search index
(the library's `DocCheck` shape); the top level walked in the world's order from a cursor, keeping the entries that
pass; a region's members walked from its group's index the same way, each region read up to a cap ("1,000+"); and
what a filtered region shows when members match but the head doesn't (the owner's).
