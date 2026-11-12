# Ordered lists

How a message's alternatives, a tree's openings, and the sources of a world relation keep an order of their own. It
covers `docs/backlog.md`'s "an edited greeting keeps its place; duplicates follow their origin; not getting lost among
10-100 edits; re-parenting". Fractional positions are not used: "fractional is fucking unacceptable" (owner,
2026-11-12). A position placed again and again at one spot grows without bound, and the usual cure, renumbering
neighbours, is write amplification.

## Today

- A message's children are keys `CHILD (parent, append time, m)`, and a tree's openings are `ROOT (tree, append time,
  m)` (`engine/src/store/chat.rs`, `child_key`). They are written once by `MessageAppend`, deleted by `MessageDelete`,
  and moved by `MessageParent`, which keeps the append time. So the order is fixed at birth: the order the messages
  were appended in. Nothing can place a message between two others.
- The `children` read (`chat_read.rs`) pages that key range, `after` an id. Sessions' depth walk (`sessions.rs`,
  `walk_next`, `after_subtree`) takes the first child and the next sibling from it.
- No read gives a position. `alternatives()` and `openings()` (`src/chat-engine.js`) read every child, then use
  `indexOf` and `slice`, so `#12 of 340` costs the whole list on every read.
- `SHAPE (m)` counts a message's replies (an `Add`).
- A tree's openings are listed in card order (`openingsInOrder`, `greeting-ids.md`): grouped by `extra.greeting_id`,
  each group in append order, and the groups sorted in JavaScript.
- "Save as new alternative" (`/api/chats/message/alternative`) appends under the parent, so the new one goes last.

## The lower bound

`alternatives.md` numbers alternatives (`#12 of 340`), opens the list at the current one, and jumps to a typed
number. So the order has to answer **rank** (where a node is) and **select** (the node at a rank), while nodes are
inserted anywhere. For a list under insertions and deletions, Fredman and Saks (1989) prove a cell-probe lower bound
of Ω(log n / log log n) per operation for answering ranks, and Dietz (1989) gives a structure that meets it.

So no structure gives an insert in the middle a constant number of writes and also gives a rank in bounded time. A
doubly linked list writes a constant amount per insert, but a rank costs a walk of up to n steps, which is a cost per
row. The structure below costs O(log n) where the bound says that much is needed, and is constant everywhere else.

## The structure: a counted skip list

Each list is a skip list in the keyspace, with counts.

- A node's **height** is fixed when it is created, from its id alone: `h(x) = 1 + ⌊tz(mix(x)) / 2⌋`, capped at 32.
  Here `mix` is a fixed 64-bit mix (splitmix64) and `tz` counts trailing zeros, so a node has height above `i` with
  probability `4⁻ⁱ`.
  - A height never changes, so nothing is ever rebalanced or renumbered.
  - Replay derives the same heights (`CONTRACT.md`, G12).
  - The store assigns ids, so no one can choose where they insert to line up with the heights. The expected bounds
    therefore hold for every sequence of places a person picks.
- Each level `i < h(x)` has a **link** to the previous and the next node at that level, and a **span**: how many
  places the next node at that level is ahead. A list's head is a node of the list's full height at place 0.
- Every key is fixed width: a list id, a node id, and a level. No key grows.

| Key | Value |
|---|---|
| `LIST_LINK (list, x, i)` | at level `i`: previous node, next node, and the span to the next one |
| `LIST_HEAD (list, i)` | the first node at level `i`, and its place |
| `LIST_TAIL (list, i)` | the last node at level `i`, and its place |
| `LIST_COUNT (list)` | `Add`: how many nodes the list has |

A node keeps about 4/3 entries on average: one link per level, at 1 + 1/4 + 1/16 + … levels. A list keeps about
`log₄ n` head and tail entries.

### Operations

`n` is the list's length and `L` a page's length. Costs are expected, in point gets and writes. A point get reads
O(levels) blocks per run (G10).

| Operation | Reads | Writes |
|---|---|---|
| insert at the end (a new reply, an import) | O(1) | O(1): the new node's links, and the tails and last nodes of its own levels |
| insert after a node (a duplicate after its origin) | O(log n) | O(log n): above the new node's height, the span over it grows by one at each level |
| remove (delete, or the first half of a move) | O(log n) | O(log n) |
| move (reorder, re-parent) | remove plus insert | remove plus insert |
| rank: where a node is | O(log n) | — |
| select: the node at a rank | O(log n) | — |
| a page of `L` in order, from a node or a rank | O(log n + L) | — |
| count, first, next, previous | O(1) | — |

**Insert `x` after `a`** (`a` can be the head):
1. Climb from `a`. At level 0 the predecessor is `p₀ = a`. At each level `i > 0`, walk back from `p_{i-1}` through
   level `i-1`'s previous links to the nearest node taller than `i`. That node is `p_i`. Add up the spans walked, so
   the distance from `p_i` to `a` is known.
2. At every level below `h(x)`, link `x` between `p_i` and its next node. `p_i`'s span to `x` is that distance plus
   one, and `x`'s span is what is left of `p_i`'s old span.
3. At every level from `h(x)` up to the list's height, if `p_i` has a next node, its span grows by one. Each tail
   after `x` moves one place up.

At the end of the list the predecessors are the tails themselves, read directly with their places. They have no next
node, and no tail comes after `x`, so step 3 writes nothing. That is why an append costs a constant number of reads
and writes.

**Rank:** climb from the node to the head, as in step 1, adding up spans. **Select:** descend from the head, taking
the next link at each level while its span fits.

A commit's derivers run one after another per tree, and each sees the commits before it (G6). So the reads in step 1
always see the list as it is.

## Chat messages

- **Every message is in one list:** its parent's children, or its tree's openings (below). The list replaces `CHILD`
  and `ROOT` (`chat.rs`). There is one order and no second index beside it.
  - The depth walk's first child and next sibling are `LIST_HEAD` and the next link.
  - `MessageDelete`'s "has replies" check is `LIST_COUNT`.
  - `SHAPE`'s reply count is `LIST_COUNT`.
  - The `children` read pages by links, and gains `rank` and `at` (select).
- **Where a message goes is in its record.** The append and parent records carry where the message goes: `after`
  a sibling, `first`, or, when neither is given, the end. Order is an operation in the log, like every other change:
  - a reply that was generated, or a swipe added, goes at the end;
  - **save as new alternative** goes directly after the alternative it was made from, before any made from it
    earlier;
  - **a re-parent** names its place among the new parent's children, the end by default;
  - **a graft** (a message put between two) goes directly after the message it is put above, and that message then
    moves under it. So the new one takes its place among the alternatives.
- **An edit changes no order:** editing a message's text keeps its node and its place.
- **Upstream imports** append the swipes in their array order. A batch of appends to one list is built in one pass,
  and the bulk path must derive the same entries as the commit path (G12).
- **Reads:**
  - `alternatives()` answers with the rank and a page;
  - the counter `k/n` on each message is a rank and a count;
  - the list opens at the current one's rank;
  - a typed number is a select.
  
  None of these reads the whole list.

## Openings and card greetings

`greeting-ids.md` puts the openings in card order. Each card greeting comes first, followed by the openings stored
from it. After every card greeting come the openings from no greeting, then the openings from deleted greetings.

- **A tree's openings are one list per greeting group:** `(tree, greeting id)`, plus `(tree, none)`. Which group an
  opening joins is in its append record. The server knows it when it stores the opening, since it's the
  `greeting_id` that the server's openings carry. Relinking an opening to another greeting (`relinkStarts`) is a move
  between groups.
- **A group list per tree index:** `LIST_GROUPS (tree, greeting id)` lists the groups a tree has. Groups from deleted
  greetings follow the no-greeting group, by greeting id.
  - This replaces "in the order they were stored" for openings from deleted greetings: they stay with their group.
- **Order:**
  - A card greeting that no stored opening holds comes first in its group, followed by the group's list.
  - An opening's rank among the openings is the counts of the groups before it, plus its rank in its own group:
    O(G + log n), where G is the number of groups. The card's greetings are read for the openings anyway (G is at most
    the card's greeting count plus one).
- **An edited greeting keeps its place.**
  - Editing a card greeting in the chat stores an opening in that greeting's group, directly after the greeting. The
    card greeting, which now has a text no opening holds, is offered again right before it (`greeting-ids.md`, An
    opening's card greeting). The two stay where the greeting was.
  - Editing a stored opening keeps its node and its place, as any edit does.
  - Editing the greeting on the card changes only its text (`greeting-ids.md`), so its group and position stay.
- **Duplicates follow their origin:** an alternative added to an opening, or a duplicate of it, goes directly after it
  in its group.

## World relations

The same structure orders a world's relations: the sources of kind `k` that target `t` in book `b` form one list,
`(b, k, t)`. An entry is in as many lists as it has relations, so a node is `(list, e)` and its height comes from
`mix(list, e)`.

- Placing a relation (adding it, moving it among the others, dropping it between two cards) is an operation that
  names the source it goes after.
- `rank` and `select` serve what `SOURCES_ORDER`'s counted radix tree serves now (`worldbuilding-store.md`): a page
  from a rank, a source's rank, and the region's count.
- The world's own order, which an author reorders, is one more list per book.
- What changes in `worldbuilding-store.md`:
  - the relation's `position` field and `relations::position_between` go;
  - `RELATIONS_BY_TARGET` and the `SOURCES_ORDER` tree become the list;
  - an export writes each list's order as its array order.
  
  That is a change to that store's design, not written down here.

## Unverified

- Per-page cost against today's single scan. A page is now `L` point gets instead of one range scan, so it reads more
  blocks per run per node. Not measured. It stays bounded by `L`.
- The keyspace has no transaction across lists. A move between two lists is one record, derived in one commit, so
  G7 (a commit that can't apply writes nothing) covers it.
