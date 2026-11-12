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

- **Every message is in one list:** its parent's replies (`List::children(parent)`), or one greeting group of its
  tree's openings (`List::roots(tree, group)`, below). The lists replace `CHILD` and `ROOT` (`chat.rs`), and `SHAPE` no longer counts
  replies. There is one order and no second index beside it.
  - The depth walk's first reply and next sibling are the list's first node and the next link.
  - A message's reply count, and `MessageDelete`'s "has replies" check, are `LIST_COUNT`.
  - With no session's or user's choice, the reply a fork follows is its list's last; a tree's opening is the last of
    its highest group.
  - The `children` read pages one list in order (a message's replies, or a tree's group), `after` a sibling or `from`
    a place, with the list's `total`. The `places` read gives each message's place in its list, the list's count and,
    for an opening, its group.
- **Where a message goes is a record of its own,** `messagePlace (message, after | first, group)`: it takes the
  message out of its list and puts it back after `after`, first, or, when neither is given, last. For an opening,
  `group` names the greeting group it goes into (`after` is in that group's list); without it the opening stays in
  its own. An append puts a message last,
  and a re-parent puts it last among its new parent's replies; a place in the same commit moves it from there. Order
  is an operation in the log, like every other change:
  - a reply that was generated, or a swipe added, goes last;
  - **save as new alternative** goes directly after the alternative it was made from, before any made from it
    earlier;
  - **a move** among a message's alternatives (the Alternatives list's drag) is a place;
  - **a graft** (a message put between two) goes directly after the message it is put above, and that message then
    moves under it. So the new one takes its place among the alternatives;
  - **a cut** that moves a message up, or moves the replies of what it cuts, puts them where the cut message was.
- **An edit changes no order:** editing a message's text keeps its node and its place.
- **Upstream imports** append in their array order, through the same derivers in the bulk path (G12).
- **Reads:**
  - `alternatives()` answers with the place and a page;
  - the list opens at the current one's place;
  - a typed number is a select.

  None of these reads the whole list.

## Openings and card greetings

`greeting-ids.md` puts the openings in card order. Each card greeting comes first, followed by the openings stored
from it. After every card greeting come the openings from no greeting, then the openings from deleted greetings.

- **A tree's openings are one list per greeting group:** `List::roots(tree, group)`, the group being the greeting's
  id + 1, or 0 for none. `MESSAGE_GROUP (m)` keeps an opening's group (absent for 0), and `LIST_GROUPS (tree,
  group)` the groups a tree has openings in. An opening goes into its group by a place: the server knows the group
  when it stores or relinks an opening, from the `greeting_id` it is linked to.
- **The card's order comes with the read.** The openings read (`openingSegments`) is given the card's greetings in
  card order (`CardGreetings.ids`), as it already is. It reads the tree's groups (`rootGroups`: each group's count and
  first opening, O(G)) and lays them out: each card greeting's group in card order, then group 0, then the groups of
  deleted greetings by id. G is at most the card's greeting count plus the groups of deleted greetings.
- **The opening holding a greeting is first in its group.** So whether the card greeting itself is shown (no stored
  opening holds it) is one read of the group's first opening.
- **Costs** (n openings in a group, G groups, L a page):
  - an opening's place among the openings: O(G + log n);
  - a page of openings in order: O(G + log n + L);
  - adding one from a greeting: one read of its group's first opening, then O(log n).
- **Where a new opening goes:**
  - the one that holds its greeting (stored with the greeting's text) goes first in the group;
  - any other from a greeting goes right after the greeting: after the one holding it, if one does, else first;
  - one from no greeting goes last in group 0;
  - one added with a place of its own (a copy after its origin) goes there.

  Relinking (`relinkStarts`, or an edit that changes the link) moves an opening by the same rules.
- **An edited greeting keeps its place.**
  - Editing a card greeting in the chat stores an opening from it right after the greeting. The card greeting, which
    now has a text no opening holds, is offered again right before it (`greeting-ids.md`, An opening's card
    greeting). The two stay where the greeting was.
  - Editing a stored opening keeps its node and its place, as any edit does.
  - Editing the greeting on the card changes only its text (`greeting-ids.md`): the opening that held it stays first in
    the group, and the new text is offered before it.
- **Duplicates follow their origin:** an alternative added to an opening, or a duplicate of it, goes directly after it
  in its group.

## The cutover

A store from before this has its replies and openings keyed by append time. `scripts/convert-message-order.mjs`, run
once with the server stopped, converts it to this format:
1. In engine steps (`order::conversion_step`), every message goes last in its list in the order it had (a tree's
   openings into group 0), its old key goes, and its parent's shape loses the reply it counted.
2. For each tree with openings in group 0 (`ungroupedTrees`), each opening linked to a greeting moves into that
   greeting's group in the same order, and the one holding the greeting goes first (`groupOpenings`).
3. The store is marked (`message-order`).

A store without the mark is refused at start (`user-stores.js`, `CONVERSIONS`), as every earlier format change is. A
run cut off part way is run again: both steps take only what is left.

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
