# Worldbuilding: the store and server side of the overview

What the engine keeps for the overview (`worldbuilding.md`, "Views", "Grouping inside a cell", "Working at any size"),
what each write touches, and what each read costs. `b` is a book, `e` an entry's entity id, `u` an entry's key (its
upstream `uid`), `r` a relation's name, `t` a target's key, `p` a position.

## The stored relation

One extension field of the entry, `extensions.relations`, stored as the entry's JSON field `\u0001relations` (an
unknown extension key, `src/world-info-engine.js:154`), so it round-trips through world files and card books:

```json
[{ "relation": "in", "target": 12, "position": "m" }]
```

`target` is the target's key in the same book (a number or a string, as upstream's `uid`); `position` is a fractional
order key compared as bytes, so moving an entry within a group rewrites only that entry's field (a history edit of a
few bytes). A value that isn't a list of such objects holds no relations: a third party's `relations` extension is read
and kept as it is, never refused. A second `(relation, target)` in the list is ignored; the first one counts.

This field is the only source of truth. Everything below is derived from it by the entry's own writes (`histSet`,
`histEdit`, `jsonValue`, `valueDelete`, creation, deletion, restore), through the one hook every JSON write of a counted
book's entry passes (`book_stats::owned_value_changed`), and its creation and deletion (`book_stats::created`/`gone`).

## Keys

Per relation (derived, one each):

| Key | Value | For |
|---|---|---|
| `REL_OF (e, r, t)` | `p` | the entry's own relations: the write's diff (old set without reading the old value), its kinds, its relations line |
| `MEMBERS (b, r, t, p, e)` | — | a group's members in the group's order |
| `GROUP_COUNT (b, r, t)` | count (Add) | "+N more", kept on write |

Groups are keyed by the target's key, not its entity id, so a relation can be written before its target exists (an
import writes entries in any order and cycles allow no order), and a target restored under its key gets its group back.

**The world's order** is one counted radix tree per book over every entry, `x = (order value, e)` as 16 bytes: the order
value is `displayIndex`, else the entry's numeric key (upstream's editor shows `displayIndex ?? uid`), else last.
A path-compressed radix tree with 256-way nodes, canonical (every node but the root has two or more children), so its
shape depends only on the set:

| Key | Value |
|---|---|
| `TREE_EDGE (b, P, d)` | the child's prefix (a node's, or the 16-byte element for a leaf) |
| `TREE_COUNT (b, P)` | AddMap: digit → elements under that edge |
| `TREE_KINDS (b, P, r)` | AddMap: digit → elements under that edge that have a relation named `r` |

**The top of a cell** for relation `r` is every entry minus those with a relation named `r`: under each edge,
`TREE_COUNT − TREE_KINDS(r)`. It is the complement of a positive index, kept on the same tree. A positive index ("the
entries with no relation of kind `r`", as `worldbuilding.md` words it) would need every entry of the book written into
it the first time a relation name is used, and every new entry written into it once per relation name: a cost per
entry. The complement costs nothing until an entry gains the kind. Changing the grouping relation reads a different
`TREE_KINDS`, never a scan. Grouping by nothing reads `TREE_COUNT` alone.

## What each write touches

`depth` is the tree's depth at `x`: about `log256(n) + 1` for spread keys (5 at 10 billion), at most 16.

| Write | Derived writes |
|---|---|
| an entry's field other than `relations` | none |
| relation added, kind already on the entry | 3: `REL_OF`, `MEMBERS`, `GROUP_COUNT` |
| relation added, first of its kind on the entry | 3 + `depth` (`TREE_KINDS` along the entry's path) |
| relation removed | the same, mirrored |
| position changed (move within a group) | 3: `REL_OF`, `MEMBERS` out and in |
| target changed (move to another group) | 6 (one out, one in); + `depth` each if a kind is lost or gained |
| entry created | `depth` + 1 edge; a split adds 3 + one `TREE_KINDS` per relation name under the split edge |
| entry deleted | its relations' removals + `depth` × (1 + its kinds) + 1 edge; a merge 2 + one per name at the node |
| `displayIndex` changed | delete and insert: 2 × `depth` × (1 + the entry's kinds) + 2 edges |

No write touches anything per other entry: an entry's writes touch its own path and its own groups. A created entry
is inserted at its key's order and moved when its `entryIndex` record follows in the same commit; the shared upper
nodes' adds fold in the commit's layer.

## Reads

| Read | Cost |
|---|---|
| top-level count | 2 gets (root `TREE_COUNT`, `TREE_KINDS(r)`) |
| top-level window of `n` from rank `k` | a descent skipping by counts: 2 gets per node on the way, `O(depth)` per entry found, `O(n · depth)` worst case |
| an entry's rank in the top level | 2 gets per node on its path |
| a region's first `m` members and its count | one page of `m` + 1 get |
| a card | the entry's title, text (cut), keys and `REL_OF`; per relation one lookup of the target's title |
| a step in reading order | the top-level item's truncated tree (bounded), and the next top-level item's per item crossed |

The truncated tree of a top-level entry is bounded: `FIRST` members per region and `DEPTH` levels below the top
(`overview.rs`); a region at the last level shows its head and "+N more". A repeat (an entry already open above, on the
drawing path) is drawn as its card with no region.

## The answer and the page

One area, `@st/worldbuilding`, one view (`worldbuilding.overview`): the book, the grouping relation, the top-level
count, the window's first rank and its items, each with its truncated region, and the occurrence the last move landed
on with its top-level rank. Actions: `worldbuilding.open` (book, relation, window; opens the view in the same request),
`worldbuilding.window` (the next window), `worldbuilding.move` (from an occurrence, `n` on in reading order, or to its
parent or first child; the window follows the result).

An occurrence's key is the path of entity ids from its top-level entry (`12/45/78`), and a region's "+N more" tile is
`12/45/+`. So:

- **KeysAt** is the window; **Locate** of a top-level key is its rank in the held window, else `move` by 0;
- **the tree per region** is each item's `children`;
- **Step** within what's held is the held items in pre-order; past it, `move`;
- **parent** is the key without its last part; **first child** is the first of the held children, else `move`;
- **inside region** `k` is "starts with `k/`".

## Open

- An entry whose target was deleted, and entries only in cycles, have a relation of the grouping kind and so are not
  at the top, and no top-level region reaches them. What deleting a target does to its members is the owner's.
- `FIRST`, `DEPTH`, how much text a card carries, and whether the "+N more" tile is a stop in reading order.
- The search box (the view's filter): see below.

### The filter (not built)

A filter has no kept counts (`worldbuilding.md`, Cells), so a filtered overview has no ranks: it is read by cursor as
the reader scrolls, without totals. It needs: the filter compiled to a per-entry check over the book's search index
(the library's `DocCheck` shape); the top level walked in the world's order from a cursor, keeping the entries that
pass; a region's members walked from its group's index the same way, each region read up to a cap ("1,000+"); and
what a filtered region shows when members match but the head doesn't (the owner's).
