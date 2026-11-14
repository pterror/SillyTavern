# State: a small core, everything else content

One model: a core of two primitives, modules the host provides, and everything else as content built from them, chats and extensions included. Each primitive passes two tests: it can't be built from the others, and every assumption it bakes in is listed with what it would rule out, replaced by the less restrictive form where one exists; what stays restrictive is said. Modules are Lua: LuaJIT on the server, compiled to JavaScript on the page; the pure-computation libraries are wasm (gap 8). Stored data is JSON. In code, [core] marks a core primitive and [host] a call to a host-provided module; every other name is content. The owner decides the questions; nothing here is a pick.

## The model

The core has two primitives: sandboxed execution, whose runtimes are pluggable, and capability references, the only authority there is. The host (the server, a page) provides modules the root is handed: a version store of entities and their components, whose history is a graph, whose changes are operations defined by content, and whose queries are conditions; network; the page; a clock; blobs. Everything else is a module: chats and messages, the turn, the prompt, lorebooks, conditions, backend adapters, and every extension, upstream-style or not. A chat is a node, a message is a child node, a swipe is a sibling, the turn is a list of steps a card composes, and a condition is a function. Neither the core nor the host modules know any of those words.

**Easy:** Nothing is a special category: an extension and a built-in feature are the same kind of module with the same powers. Any card can recompose its turn, replace any part, or not be a chat at all. Each module holds only the capabilities it was handed, so installing one shows what it can touch. Branches, swipes and undo come from the store, for every module alike.

**Hard:** Everything is code someone wrote, so people who don’t program depend on libraries (question 2). The page can only explain why something is in the prompt if the libraries report it. A write costs the indexes declared on what it changes. Undoing an early change re-runs the later operations on that path. What stays restrictive is listed under each primitive: a module runs only where its runtime exists; I/O exists only where the host provides a module for it; operations can’t do I/O; history under a node that’s kept stays.

## Core primitive: sandboxed execution

```
sandbox:load(source, runtime, refs) -> exports
  runs a module in the named runtime, holding nothing but refs. Its exports are
  references that can be handed to others. Each host (the server, a page) has its
  own runtimes.

A sandbox runs tasks, and every call into it starts one. A task runs until it waits,
and it waits only for a call through a reference or for a promise; the sandbox's other
tasks run meanwhile, so between two waits a task sees nothing change but what it does.
A call that arrives starts its task at once and runs it to its first wait, in the order
calls arrive.
  task.spawn(fn, ...) -> handle   a new task running fn, at once, until its first wait
  handle:join()       -> fn's results, or raises its error   (a wait)
  handle:cancel()     the task's current wait raises "cancelled", and so does join;
                      the tasks it spawned that are still running are cancelled too
  task.promise()      -> p; p:get() waits until p:set(...) or p:fail(err), once
A budget is a reference; when it runs out or is revoked, the tasks running on it stop
at their next check, and that can't be caught.

Necessary: without it, code either runs with all authority or nothing can be content.
Waiting is part of it: only the runtime can run a sandbox's other calls while one waits.

Assumes: one language.
  Rules out: code in other languages; running where that language has no runtime.
  So: runtimes are pluggable host modules, and a module names its runtime.
Assumes: fixed CPU and memory limits.
  Rules out: long or heavy work that someone is willing to allow.
  So: budgets are granted like any other reference.
Assumes: modules share no memory; they pass values and references.
  Rules out: handing over large data by pointer.
  So: large data goes as a blob reference (by hash).
Assumes: all code is deterministic.
  Rules out: nothing needed; only operations must replay.
  So: a runtime offers a deterministic mode, and operations run in it. It has no
  task, no promise and no reference but read, so an operation never waits.
Assumes: a call holds its sandbox until it returns.
  Rules out: doing anything else while a model or a person answers; N calls at once.
  So: a call holds only its task.
Assumes: tasks in one sandbox run in parallel.
  Rules out: reading, deciding and writing without locks.
  So: tasks interleave only at waits; parallel work is several sandboxes.
Assumes: cancelling stops the callee on the spot.
  Rules out: the callee recording that it stopped, or keeping what it had.
  So: the caller is released at once; the callee sees "cancelled" at its wait and
  may clean up; its budget stops it if it won't.
Assumes: a task outlives the task that spawned it.
  Rules out: stopping a turn and everything it started with one cancel.
  So: cancelling a task cancels what it spawned; work meant to outlast a turn is
  spawned by a task that lasts, such as a jobs module's own.

Still restrictive:
  a module runs only on hosts that have its runtime;
  data between modules is copied, or passed as a blob reference;
  between two waits a task can only be stopped by its budget, not cancelled;
  on the server a wait inside a function LuaJIT calls from C (table.sort's
  comparator, string.gsub's replacement function) raises; the page compiler raises
  the same error there, so a module behaves the same on both.
```

Core primitive 1 of 2. The runtimes it ships with are decided: "lua" (LuaJIT on the server; on the page, Lua compiled to JavaScript, with the compiler deciding every name code can reach) and "wasm" for the pure-computation libraries (gap 8). In the code below, [core] marks a core primitive and [host] a call to a host-provided module; every other name is defined by content.

## Core primitive: capability references

```
A reference is an unforgeable handle to a module's export or to a host module.
Calls go through references; a call's arguments and results are values and
references. The core carries references between the server and a page. Holding a
reference is the only authority there is. At start the host runs one module, the
root, holding every host module.

A call is a message, and the calling task waits for its result. Calls one sandbox
makes through one reference arrive in the order they were made. A call raises "gone"
when the sandbox or host at the far end goes away, and "cancelled" when the calling
task is cancelled; the task running the call at the far end is cancelled then.
Values: nil, booleans, numbers, byte strings, tables of values, references; a
function in a table that crosses becomes a reference.

Necessary: without it, modules have ambient access (anything reaches anything) or none.

Assumes: a fixed set of capabilities.
  Rules out: any I/O not on the list.
  So: there is no list. Every capability is a module: content, or provided by the host.
Assumes: modules find each other by name.
  Rules out: a module having only what it was handed.
  So: no lookup; a directory is a module that holds references and hands them out.
Assumes: authority, once handed, is kept.
  Rules out: taking it back, narrowing it, auditing it.
  So: revoking, narrowing and logging are wrappers that forward calls (content).
Assumes: a call's reply comes back before the next call goes.
  Rules out: a stream (a token at a time) without a round trip per item.
  So: calls don't wait for each other; a task that spawns a call per item and joins
  every Nth sends a stream in order with N in flight (stream.lua).
Assumes: values are JSON.
  Rules out: bytes (tensors, images, files) without making each one a blob.
  So: byte strings are values; what the store keeps is still JSON or a blob by hash.

Still restrictive:
  I/O the host provides no module for can't happen; sandboxed code can't do I/O alone;
  whoever writes the root holds all authority;
  a call on a result can't go before the result is back (no promise pipelining), so
  a page action needing several steps calls one server export that does them all.
```

Core primitive 2 of 2. That is the whole core.

## Host module: the version store

```
store:node(parents)              -> node   a list: two or more to merge; none only if unscoped.
                                           A node is an entity too: what is about that point
                                           (the message at it) is its components
store:entity(node)               -> e      a new entity id; it has no component until a change
                                           gives it one, so above node it has none
store:parents(node)              -> list   only the parents inside this reference's scope
store:get(node, e, c, field)     -> value, or { conflict = { value, value, ... } }: component c
                                           of entity e at node, or one field of it (a name, or a
                                           list of names for a path)
store:components(node, e)        -> { [c] = value }: every component of e at node
store:query(node, q, how)        -> { rows = { { e, values }, ... }, count?, after? }: the
                                           entities whose components at node match q, a
                                           condition (Queries, below); how = { order = { c, field,
                                           "desc"? }, read = { c, ... }, limit, after, count }
store:apply(node, changes)       -> ids    changes = { { e, c, op, arg, field = f? }, ... },
                                           all or none
store:revert(node, id)           -> id     a change cancelling change id, from node down
store:drop(node)                 removes node and what is reachable only through it
store:children(node, after, limit)  -> child nodes, oldest first, a page at a time
store:watch(node, what, since, sink)  -> handle; what = { e, c } or a query; pushes what
                                 changes for it at node, from any cause, to sink (gap 4)
store:match(q, list)             -> { true | false, ... }: q's store operators over components the
                                 caller holds ({ [c] = value } each), with no read
store:declare(node, schema)      the indexes schema declares are kept for node and what is
                                 under it from now on (Indexes, below); unscoped only
store:narrow{ nodes = { ... }, components = { "chat.", "card" }, entities = q, mode = "rw" }
                                 -> a store reference whose scope is the old one cut down to
                                 those nodes and their descendants, those components (a name,
                                 or a prefix ending in "."), the entities matching q, and those
                                 rights

A store reference has a scope: a set of nodes and everything descending from them (the
host's own reference, which the root holds, is unscoped), a set of component names, an
optional condition on entities, and rights: r (get, components, query, watch, children,
parents), w (apply, revert, node, entity), d (drop). A node id, an entity id or a change id
is only a name. Every call resolves it within the scope and raises "not in scope" otherwise,
so a guessed or stored id reaches nothing more:
  node, children, drop   the node (and every parent given to node) is in scope
  get, components, query, watch
                         the node is in scope; components outside the names, and entities
                         the condition doesn't match at that node, aren't there
  apply                  the node is in scope; every change's component is in the names, and
                         its entity matches the condition before the apply and after it, so
                         no write moves an entity out of the scope or into it
  revert                 the change was made at a node in scope, to a component in the names,
                         on an entity in scope there
  an op's read           sees only the components and entities of the reference that applied it
  watch's batches        children are in scope by construction; a change made above the
                         scope shows as by = { above = true }, without its id or module
A component's value at a node is what its changes on the paths to that node give, including
changes made above the scope: reading a node's value is allowed, reaching those nodes isn't.
A change with a field changes only that field (a path of names reaches into nested tables):
it is replayed, reverted and merged on its own, so two branches that change different
fields of one component merge without a conflict, and a revert of one field leaves the
others. A change without one replaces the whole component; a later field change applies on
top of it.
op is a pure function (old, arg, read) -> new that a module exports; old is the field's
value, or the component's. An op that raises fails the whole apply.
A value names a blob as { "$blob": hash } and a hold as { "$hold": id }; each kept
change result that names one keeps it alive (gap 6).

Necessary: persistence is I/O, so a host module has to hold it. Versioning could be
content over a plain disk module; the host provides it because every module's undo,
branches and merges rest on it, and a native store keeps reads and writes indexed.
A module that wants another store is handed a disk module instead.

Assumes: history is a tree.
  Rules out: merges (two branches, or two people's edits, coming together).
  So: a graph; a node has any number of parents.
Assumes: the store picks a value where merged branches disagree.
  Rules out: resolving it the way the content means.
  So: get returns every side's value until a change at the merge settles it; a merge
  module can settle it by replaying both sides' operations.
Assumes: a fixed set of operations.
  Rules out: any change the set lacks.
  So: operations are content; even "set" is a module's function.
Assumes: a change stores only the new value.
  Rules out: undoing an early change moving the later values.
  So: changes are operations; the store keeps each result and re-runs later ones
  after a revert.
Assumes: a node is frozen once it has children.
  Rules out: writing to a message after a reply to it exists.
  So: any node takes changes; content wanting a frozen version makes a new node.
Assumes: what a module stores is a value at a key it names.
  Rules out: asking for what is stored by what it is (every card tagged npc, the entries
  that need a word in this text) without a module keeping index keys for it, which sees
  only the writes made through its own wrapper and can't answer at a node below a branch.
  So: entities, with named components, each a table; a key and its value are one entity
  with one free-form component (Entities, components and relations, below).
Assumes: every component has a fixed shape.
  Rules out: state nobody declared ("ideally state is schemaless").
  So: a schema is optional; a component without one is any table.
Assumes: queries are a language of their own (SQL, or an index API).
  Rules out: lore activation, view filters, tags, extension scopes and settings rules being
  one kind of condition.
  So: a query is a condition in cond.lua's data form, with the store's operators.
Assumes: the store keeps no index, or a fixed set.
  Rules out: no index: any query at 10 billion rows without reading them; a fixed set: the
  indexes a module's own components need.
  So: a schema declares indexes on its component's fields; the store keeps them, and a
  write costs what the indexes declared on what it changes cost (Indexes, below).
Assumes: an index can be content, a wrapper keeping index keys.
  Rules out: an index that sees writes through every reference, reverts, replays and
  merges, and answers at any node without a copy per branch.
  So: the store keeps them, because only the store sees every write and resolves values
  at a node.
Assumes: a change replaces the whole value.
  Rules out: two branches changing different fields of one component merging cleanly; a
  revert of one statement in a table of settings.
  So: a change can name a field.
Assumes: the module that cares about a write is the one that made it.
  Rules out: seeing other modules' and devices' writes, reverts, and the replays
  after them.
  So: watch reports every change at a node, whatever caused it.
Assumes: a node knows only its parents.
  Rules out: listing swipes and branches unless a module keeps a list.
  So: children, a page at a time.
Assumes: a store reference reaches every node it can name.
  Rules out: authority being only what was handed; handing a module one chat.
  So: a reference has a scope of nodes, and ids are names resolved within it.
Assumes: an id stored in a value is authority over that node or entity.
  Rules out: storing ids at all (condensed spans, a viewed node, page actions, a relation).
  So: ids stay names; only the reference resolving them is authority.
Assumes: a scope is one subtree.
  Rules out: handing a module two chats, or a chat and the library it reads.
  So: a set of nodes.
Assumes: a scope is a set of nodes alone.
  Rules out: handing a module its own components and no others', or one book's entries.
  So: a scope also names components, and can carry a condition on entities.
Assumes: narrowing can be a wrapper (content).
  Rules out: nothing, but a wrapper would walk every path to check a node, evaluate the
  entity condition against values it can't read, and filter every query, watch and
  children page itself, repeating the store's ancestry and resolution.
  So: store:narrow, checked by the store.
Assumes: an op reads the whole node.
  Rules out: a module's op being kept from other modules' components.
  So: read sees the scope of the reference that applied it.

Still restrictive:
  operations can't do I/O, or replaying them wouldn't give the same result;
  an operation's code is kept as long as changes use it (recorded by content hash);
  values are JSON or a blob by hash, so exact large numbers go as strings;
  history under a node that's kept stays; discarding it means dropping nodes;
  a scope can only be cut down, never widened, and never reaches a node above it,
  even to read its components (it reads their effect on the values at its own nodes);
  only an unscoped reference makes a root node or declares an index; a module that needs
  its own roots is handed a node to make them under;
  a query's part that the store answers uses only the store's operators; an operator a
  module defines is checked by the module over what that part found (Queries, below);
  a query with no declared index under it reads at most a budget of rows per page;
  one schema per component name is in force at a time, on every branch (Free-form and typed);
  resolving an id costs an ancestry check (jump pointers, about log depth steps);
  a merge with a parent outside the scope makes that check search both paths.
```

A host-provided module, not a core primitive, but the one every example rests on. Both tests rerun with scope: necessary as before (persistence is I/O), and scope is part of the store, not a wrapper, because only the store knows which nodes descend from which. Holding a store reference is now the only authority over nodes and entities: an id is a name, so a module can store or receive one without gaining anything. Entities, components, queries and indexes are host: the two tests for each are in the list above (a key is a special case of a component, so nothing that keys allowed is lost; an index kept by content can't see every writer or answer below a branch). The engine's library already stores things this way (`src/library-codes.js`: an entity with a type, fields by code, tags and relations), and its store keeps counted, ordered indexes over them (`engine/src/store/`: the counted radix trees of `world_order_tree.rs`, the sorts of `sorts.rs`, the tag blocks of `kinds.rs`, the counts of `book_stats.rs`); this section makes that the contract every module sees.

## Other host modules, and what was dropped

```
net       fetch, only to the destinations this reference allows; net:only(host) or
          net:only(test) narrows it (gap 7); a body can go to a sink as it arrives (gap 1)
page      on the server: page:on(fn(action, conn)), conn:closed() waits for it to close.
          on a page: a sandboxed display a module draws into, and the person's input
clock     now(), sleep(ms)
disk      blobs by hash, leased until a value names them (gap 6)
latest    keys holding only their last value, no history; one per host (gap 2)
holds     things outside the store that live while a value names them (gap 6)
accounts  quotas that store, latest, disk, holds and vectors charge (gap 6)
grant     prompts the host draws, which narrow or mint a reference (gap 7)
files     a filesystem: the server's, narrowed to a folder; a page's picked files (gap 7)
infer, vectors, proc, browser   heavy native work (gap 8)

Each is a module the host provides, narrowable and replaceable like any other. A host
can add more (audio, a camera, a GPU) without the core changing.

Assumes: the page has a fixed renderer that modules describe things to.
  Rules out: anything the renderer doesn't know.
  So: modules run on the page too and draw into a sandboxed display.

Dropped, because they're built from the above:
  events, triggers  would bake in what counts as happening. Code runs when a
                    reference delivers something: a page action, a reply from net,
                    a timer. Being told about writes is store:watch or latest:watch.
  call a model      a backend adapter: a module holding net for one host
  conditions        functions; cond.lua below is one library of them
  narrowing         latest's: a wrapper forwarding only keys under a prefix (narrow.lua);
                    the store's covers nodes, components and entities, so it is store:narrow
  merge policy      content settles conflicts
  timeouts, races,  async.lua and stream.lua over tasks (gap 1)
  streams
  secrets           secrets.lua over latest and net (gap 2)
  jobs              jobs.lua over latest, clock and tasks (gap 3)
```

Host-provided modules other than the store, and what was dropped from the candidate core.

## What the store holds

```json
{ "node": 790, "parents": [1] }
{ "node": 811, "parents": [790] }
{ "node": 812, "parents": [811] }

{ "id": 9031, "node": 811, "entity": 811, "component": "chat.message", "op": "kv.set", "module": "chat",
  "arg":    { "role": "user", "speaker": 3, "text": "Where do dragons nest?" },
  "result": { "role": "user", "speaker": 3, "text": "Where do dragons nest?" },
  "time": 1763100000 }

{ "id": 9040, "node": 812, "entity": 790, "component": "tracker", "field": "minutes", "op": "kv.add",
  "module": "tracker", "arg": 90, "result": 1290, "time": 1763100004 }
{ "id": 9041, "node": 812, "entity": 7, "component": "tracker", "field": "affection", "op": "kv.add_within",
  "module": "tracker", "arg": [ 2, 0, 100 ], "result": 52, "time": 1763100004 }

{ "id": 9055, "node": 812, "revert": 9040, "module": "ren-undo", "time": 1763100090 }
```

Nodes and changes are all the store has, and what it derives from them: each change's result and the declared indexes (below). 811 is a message node, so the message is a component of entity 811; 790 is the chat's root, whose "tracker" component holds the chat's time; 7 is Ilse, a card at the library node 1, and her affection is a field of a component on her own entity changed at node 812, so it holds at 812 and under it, and nowhere else: not on the swipe at 813, not in another chat with her, not in the library. "chat.message", "tracker", "kv.set" and the fields are names chosen by modules; the store keeps them without knowing what they mean.

## Entities, components and relations

```
An entity is an id. Its components are named tables, each typed by a schema content defines,
  or free-form. A relation is a component, or a field of one, holding entity ids in order:
  "tags": [ 41, 57 ]; "relations": { "in": [ 812 ], "belongs to": [ 930 ] }. A schema says
  which fields hold ids, so the store can keep who points at an entity.
A node is an entity: the message at a node is that node's "chat.message", and a chat's own
  state is on its root node. Every other entity is made with store:entity.
An entity's components exist where their changes are: a component made at the library node
  holds everywhere under it; one made or changed at a message node holds at that node and
  under it, whichever entity it is on.
A component's name says whose it is: a name the app's piece owns ("card", "chat.message",
  "lore.entry", "settings", "tags", "relations", "pkg") or an install's own name and names
  under it ("tracker", "tracker.log"). A store reference names the components it reaches,
  so a module is narrowed by the components it may read or write.
A key and its value are a special case: an entity with one free-form component.
```

| What | Entity | Components | Where its changes hang |
|---|---|---|---|
| A card (a character) | one per card | "card" (upstream's fields), "tags" (a relation to tag entities), "lore.books" (a relation to its books), "settings" (its statements: the character level), "pkg" if it brings modules | the library node |
| A tag | one per tag | "tag" { name } | the library node |
| A lorebook, its entries | one per book, one per entry | "lore.book" { name, when }; "lore.entry" { book (an id), name, order, when, text } | the library node; an entry made in a chat, at that chat's node |
| A world, its entries | one each | "world", "world.entry", "relations" (one field per kind the world's author named, each a list in the relation's order), "settings" | the library node |
| A chat | its root node | "chat" { card }, "tracker" { minutes } | the root, and the messages that change it |
| A message | its node | "chat.message" { role, speaker (an id), text, stopped? } | its own node |
| A bookmark | one per bookmark | "bookmark" { at (a message node), mode, name }, "settings" | the chat's root |
| Settings statements | the subject of the level: the tab's, device's, chat's, bookmark's, character's, world's, entry's, theme's or person's entity | "settings": one field per setting name, "order/…" and "on/…" among them | where the level says ("Settings: one cascade along a path") |
| Tracker state | the chat's, and each character's | "tracker" { minutes } on the chat, "tracker" { affection } on a character | the message that changed it |
| A package | one per package | "pkg" { name, hash, source, runtime, piece, extension, schemas } | the library node, whose own entity holds "pkg.installed" { [name] = id } |
| A person, a persona, a device, a tab | one each; a tab and a device are their own nodes | "persona" { name, … }, "settings" | the library node; a tab's and a device's at their nodes |

```lua
-- in root.lua: what three modules are handed
local chats    = store:narrow{ nodes = { home }, components = { "chat", "chat.message" }, mode = "r" }  -- [host]
local tracker  = store:narrow{ nodes = { home }, components = { "tracker" }, mode = "rw" }           -- [host]
local bestiary = store:narrow{ nodes = { home }, components = { "lore.book", "lore.entry" },         -- [host]
                               entities = { "any", { "is", 4001 }, { "=", "lore.entry", "book", 4001 } },
                               mode = "r" }
```

The tracker can write "tracker" on any entity at any node under home, and nothing else; its affection field on Ilse's entity is its own component there, and Ilse's "card" is not in its scope. The third reference reaches one book and its entries; an entry the module can see can't be moved to another book through it, since an apply must leave every changed entity in the scope. Narrowing stays capability-shaped: a reference is cut down by nodes, component names and a condition on entities, and an id outside them isn't there.

The owner asked for this: "i would ideally still like relational for compatible data (optionally), for some definition of compatible. perhaps something like an ecs architecture in relational db" (09-30), and "an open bag of properties (…), then be able to search based on that" (09-12). Compatible data is the shared formats, which have schemas; the bag of properties is a free-form component; searching is a query over either. Assumes: one entity has one value per component name. Rules out: two installs keeping different things under one name. So: names are an install's own: its install name, and names under it.

## Queries

```
A query is a condition in cond.lua's data form. The store's operators test one entity's
components at the node read at:
  ["has", c]                       it has component c
  ["is", e]                        it is entity e
  ["=", c, f, v]                   field f of c is v; "<", "<=", ">", ">=" compare numbers or strings
  ["in", c, f, { v, ... }]         field f is one of the values or, if it is a list, holds one
  ["to", c, x], ["to", c, f, x]    the relation c, or its field f, holds the id x
  ["words", c, f, text]            field f's text index matches text (the app's search syntax)
  ["all", ...], ["any", ...], ["not", q]
store:match(q, list) -> { true | false, ... }   the same operators over components a caller
  holds ({ [c] = value } each), with no read: one meaning for every operator, the store's
At a node v, the store answers q as follows:
  a part an index covers is an index read: "=", "in" and comparisons on an indexed field,
    "to" on a relation, "words" on a text index, "has" (every component is listed by name);
    in "all", the part with the smallest count leads (each index keeps its counts, one read
    each; below the library node that count is the library's, which the chat's rows only
    correct, so it plans and doesn't answer) and the rest are checked on what it finds: through a composite index that covers
    both, else on the entity's values, one read per field named; "any" is the union of its
    parts, each entity once. "in" with a list is a merge of the list, in order, with the
    index: about the shorter of the two in seeks.
  with how.order, an index in that order leads if one covers the query's first part; else
    the matches are sorted, up to a bound past which the query is refused
  a part no index covers is checked on what the covered parts found; a query no index
    covers at all reads the components it names, at most a budget of rows per page, and
    returns a cursor that goes on (the world filter's walk: WALK_STEPS_PER_READ)
  each entity once; count = true adds how many match: the index's count when one index read
    is the whole query, else a count of what was read
An operator a module defines (keys, cameUp, speakerTag, since…) is not the store's: the
  module sends the store its part and checks the rest with cond.holds on what comes back.
  One condition can be partly index and partly code, in one form.
```

```lua
-- query.lua: a condition, answered by the store where its operators are the store's
return function(c)
  local store, cond = c.store, c.cond
  local STORE = { has = true, is = true, ["="] = true, ["<"] = true, ["<="] = true, [">"] = true,
                  [">="] = true, ["in"] = true, to = true, words = true }
  local Q = {}

  local function stored(q)
    if q[1] == "all" or q[1] == "any" or q[1] == "not" then
      for i = 2, #q do if not stored(q[i]) then return false end end
      return true
    end
    return STORE[q[1]] == true
  end

  function Q.split(q)                       -- the store's part (or nil), and the rest (or nil)
    if stored(q) then return q, nil end
    if q[1] ~= "all" then return nil, q end
    local s, r = { "all" }, { "all" }
    for i = 2, #q do
      local a, b = Q.split(q[i])
      if a then s[#s + 1] = a end
      if b then r[#r + 1] = b end
    end
    return s[2] and s or nil, r[2] and r or nil
  end

  function Q.each(at, q, how, ctx, fn)      -- fn(row) for each match at at; the rest is checked with ctx.row = row
    local s, rest = Q.split(q)
    if not s then error("no part of this condition is the store's", 0) end
    local after
    repeat
      local page = store:query(at, s, { order = how.order, read = how.read, limit = 500, after = after })   -- [host]
      for _, row in ipairs(page.rows) do
        if rest == nil or cond.holds(rest, setmetatable({ row = row }, { __index = ctx })) then fn(row) end
      end
      after = page.after
    until after == nil
  end

  function Q.holds(at, e, q)                -- q, all the store's, of the one entity e: a read per field it names
    return store:query(at, { "all", { "is", e }, q }, { limit = 1 }).rows[1] ~= nil   -- [host]
  end

  return Q
end
```

Three conditions from elsewhere in this document, as queries:

```lua
-- the dragon entry (case 1): its "when" is the entry's own data; what the store answers is
-- which entries of the open books can come up for this text at all
{ "all", { "=", "lore.entry", "book", 4001 },
         { "in", "lore.entry", "need", { "", "d", "dr", "dra", "r", "ra", "rag", … } } }
-- read through the index lore.entry (book, need): the book's entries whose need is one of
-- the text's grams; then each one's when, ["all", ["keys", "dragon"], ["speakerTag", 41]],
-- with cond.holds; speakerTag is chars.lua's Q.holds(at, speaker, { "to", "tags", 41 })

-- the character list filtered by a tag (41 is the tag "npc")
store:query(home, { "all", { "has", "card" }, { "to", "tags", 41 } },                     -- [host]
            { order = { "card", "name" }, limit = 50, count = true, read = { "card" } })
-- -> { rows = { { e = 7, values = { card = { name = "Ilse", … } } } }, count = 1 }
-- through the composite index on (tags, card.name): the tag's cards in name order, and the
-- tag's count, one read

-- an extension's scope (option D): a person's rule { when = ["all", ["transform", "tracker"],
-- ["card-tag", 41]], on = true }; card-tag is context_cond.lua's
cond.define("card-tag", function(x, tag) return x.card ~= nil and q.holds(x.at, x.card, { "to", "tags", tag }) end)
-- and which cards that reaches, for the review, is the same condition without the card:
store:query(home, { "all", { "has", "card" }, { "to", "tags", 41 } }, { count = true, limit = 0 })   -- [host]
```

Run under LuaJIT on a store that folds every path (no index, the reference meaning): Ilse, tagged 41, brings up Dragons, The Capital and then The Palace for "Where do dragons nest? Near the capital?"; Maren, not tagged, brings up only the two places; the character list tagged 41 is Ilse, count 1; after a change at node 812 that empties Ilse's tags in chat 790, the same list read at 812 has count 0 and at the swipe 813 count 1, and the tracker's scope tested at 812 and 813 gives false and true. A condition is one kind of thing now: lore activation, the character list, tags, saved views, an extension's scope, the settings cascade's rules and grant's preset rules are all cond.lua data, and every part of them that tests what is stored runs on the same indexes. Context conditions (the note's since and until, compose_order's transform) are operators of the module that reads them; the ones about stored things go through Q.holds or store:match, so their meaning is the store's.

## Indexes under branching

```
A schema declares indexes on its component's fields:
  { "on": [ "name" ] }                    ordered: equality, ranges, rank, counts
  { "on": [ "book", "need" ] }            composite: the first field, then the next within it
  { "on": [ "tags" ], "relation": true }  a relation's other side: who holds x, with counts
  { "on": [ [ "tags" ], [ "card", "name" ] ], "relation": true }
                                          a composite may take a field of another component
                                          of the same entity: each tag's cards in name order,
                                          kept by writes of either
  { "on": [ "text" ], "text": true }      the app's text search over the field (searched.rs)
  "computed": { "need": "lore/need" }     a field computed by a pure function of the component,
                                          named like an op; indexed as a stored field is
A query can't ask for an index: it uses the declared ones, or reads a budget at a time.
  An index costs every writer of its component, so it comes with the schema, from the
  install that owns the component, reviewed with it, and the root declares it
  (store:declare); a module can't make every card write dearer by asking.
```

The difficulty: a component's value at a node is what its changes on the paths to it give, including changes made later at nodes above it (an edit in the library holds in every chat under it). An index has to answer "at this node" for any node, without a copy per branch, and a write above has to reach every node below it without being written there.

```
n        rows of the index at the library node (10 billion cards)
t        a counted radix tree's depth over n rows: about log256(n) + 1, 5 at 10 billion
D        the depth of the node read at, below the library node
b        branches (leaves) of the chat the node is in
m        the index's rows below the library node in that chat, every branch included
s        changes of one (component, entity) on the chat's other branches, at depths
         between the nearest change on the read's path and the read
r        rows a read returns; k the index entries one change writes (1 for a field, one per
         member or term that changed for a list or a text)

A. A delta per node: each node keeps the rows its own changes add or remove, and points at
   the nearest node above with a delta (the bookmark index's FILTER_UP shape); a read
   merges the deltas on its path.
     write   at the library node t + 1 edge per entry; below it k rows, a pointer when a node
             first has one; nothing per branch
     read    t + r, plus a seek per node on the path with a delta: up to D. A component that
             changes at most messages (the tracker's minutes) makes every read D seeks, and
             a count at a node costs the same
B. Persistent trees sharing structure: a root per node, each change copying the path to
   its leaf.
     read    t + r from the node's root
     write   t tree nodes copied per entry, each with its edges (up to 256 keys a node in the
             engine's layout): amplification by t times the fan-out. A change above existing
             branches has to reach every root below it, (roots below) × t per entry, so a
             library write costs per chat. Ruled out: write amplification and cost per row.
A'. A with the message tree's own skew-binary jump spans: each node keeps the merged deltas
    of its span, so a path is about log D spans.
     read    t + r + about log D seeks
     write   each entry copied into every span covering it, about log D times, and a change
             at an earlier message rewrites the spans of everything under it: b × log D.
             Ruled out: write amplification.
C. The library node's index in place, the rows below it where their changes are, by chat,
   read through the ancestry check. Picked.
     rows    at the library node: the counted tree, written in place, as the engine's indexes
             are today. Below it: per change of an indexed field, one row (index, chat, key, e,
             depth, node), where chat is the child of the library node on the node's path; a
             count per (component, e, chat) saying e changed there; and for every component the
             changes by (component, e, chat, depth, node), which point reads use
     point read of (e, c) at v
             one get: no change of e in v's chat, so the library node's value, one get more.
             Else the chat's changes of (c, e) at depth D or above, deepest first, each tested
             for being on v's path (log D): the first that is decides. (1 + s) log D
     query at v
             the library node's range, t + its rows, each with a change in the chat (one get)
             settled by its point read; plus the chat's rows in the range, each tested for
             being on v's path (log D) and for being its entity's nearest change. t + r +
             m_range (1 + s) log D, m_range ≤ m
     count at v
             the library node's count (t), corrected by the chat's rows in the range
     write   at the library node t counts + 1 edge per entry (a split adds 3), as sorts.rs and
             world_order_tree.rs write today; below it k rows and 1 count, with no read of other
             rows and nothing per branch. A change above existing branches writes only its own
             rows: a chat that changed the same component keeps its rows, which still decide
             there. A revert, or a write above a later op that depends on it (kv.add), replays
             those later changes and rewrites their rows: the replay's own cost
     disk    one row per change per entry; nothing copied
```

C, because it is the only one with neither a cost per branch nor write amplification, and its read cost is bounded by what happened in the read's own chat: never by n, never by other chats. At the library node, where the cards are, it is the engine's indexes as they stand. What it costs is a chat whose indexed components change on many branches: a read pays for the other branches' rows in its range (m_range counts every branch, and s the other branches' changes of one entity). In the usual shape, a long main line with swipes as leaves, s is the swipes at one depth. A chat started from inside another chat is part of that chat; a chat's tab and device nodes are chats of their own here.

```lua
-- the store's read of an ordered index at node v (native in the store; Lua here, run under LuaJIT
-- against folding every path: 400 random reads on each of five random histories of 1,205 nodes in
-- four chats with branches, 3,000 changes below the library node, no difference)
local function read(index, v, lo, hi)
  local chat, hit = chat_of(v), {}
  for _, row in ipairs(library_range(index, lo, hi)) do          -- t + its rows
    if not changed_in(chat, index.component, row.e) or not nearest(chat, index.component, row.e, v) then
      hit[row.e] = true                                          -- no change of it on v's path
    end
  end
  for _, row in ipairs(chat_range(index, chat, lo, hi)) do       -- the chat's rows, every branch
    if on_path(row.node, v) and nearest(chat, index.component, row.e, v) == row.change then
      hit[row.e] = true
    end
  end
  return hit
end
-- nearest: the chat's changes of (component, e) at depth(v) or above, deepest first; the first
-- whose node is on v's path (on_path: the jump pointers, about log D steps)
```

```
chat 790, Ilse's tags emptied at 812 (the example under Queries):
  library node: the relation index on tags holds (41 → 7); its count for 41 is 1
  chat 790: the change of (tags, 7) at 812, depth 2; the count (tags, 7, 790) = 1; no row for
            41, since the new value holds nothing
  at 812: the library's (41 → 7) is found; 7 has a change in 790; its nearest on 812's path
          is the change at 812, which holds no 41: not a match. count 1 - 1 = 0
  at 813: the same row; the change at 812 is not on 813's path, nor is any other: the library's
          value holds. count 1
```

Merges: a node with two parents is one deeper than the deeper of them and in its first parent's chat; on_path climbs both parents, so each merge on a path doubles that check's cost, and a point read finds a nearest change on each side; two that aren't one above the other are a conflict, which get returns as it did. The bookmark index ("Settings") is a declared index of this store whose filter is a query over "bookmark"; its structure is the one described there, kept per declared filter.

```
Write cost per declared index, per change that changes what it reads:
  ordered field     library node: t counts + 1 edge (6 at 10 billion); below it: 1 row
                    (+ 1 count the first time e changes in that chat)
  composite         the same, one tree over both fields
  relation          per id added or removed: 1 block-map add + 1 count + 1 row at the
                    library node (kinds.rs's member blocks), 1 row below it
  text              per term whose count changed (searched.rs)
  computed          its function, run once per change of the component, then as its kind
  A change that leaves an index's fields as they were writes nothing to it.
A new index on existing rows: built in steps by the store's own job over the component's
  rows (n at the base node, then each account's, then each chat's), before the schema
  version that declares it is in force; until then the version before it is, and writes
  during the build keep the part the build has passed. Nothing reads a half-built index, and
  nothing is left to build once the version is in force. Cost: one pass, once; after it,
  only the writes. Decided (question 6): the version waits for the pass.

With accounts (see "Accounts: one store, a home node each"): the base node is shared, each
account is a child of it, and a chat is a child of its account's node (a multiplayer chat is
a child of the base node that two accounts' scopes include, so it has no account level).
Rows below the base node are keyed by the level they sit at: (index, account, key, e,
depth, node) for a change made at an account's own nodes, (index, chat, ...) as above for a
chat's. Nothing is keyed by other accounts, so no read touches another account's rows.
  a    the index's rows at the reader's account node, in the range read (account level)
  s_a  changes of one (component, e) on the account's other branches, between the nearest
       change on the read's path and the read
  point read of (e, c) at v in a chat
          one get per level, deepest first: the chat's changes of (c, e), then the account's,
          then the base node's value: no change at either below level costs 3 gets. Else the
          nearest level that has changes is searched as before, (1 + s) log D in the chat or
          (1 + s_a) log D in the account; a deeper level with changes decides before a higher one
  query at v
          t + r + (m_range + a_range) (1 + s) log D, a_range the account's rows in the range
          (a_range ≤ the account's own changes of the component: edits of shared content,
          not its chats). Compared with the table above: one more level to look up and test,
          one more get per row the base range returns that has a change in the account, and
          a term a_range that is zero for an account that changed nothing of the component
  count at v
          the base node's count (t), corrected by the account's rows and the chat's rows in
          the range
  write   at the base node as before; below it k rows and 1 count, at the account or chat
          level the change was made at. A change above existing accounts and chats writes
          only its own rows: every account's and chat's value that it doesn't override
          follows, with nothing written per account. This is the cost table above unchanged
          except that a read pays one more level (a_range and 1 more get); no write got
          dearer

Host: indexes, queries and store:declare are the store's. Necessary: only the store sees
  every write (any reference, a revert, the replay after it, a merge) and resolves a value
  at a node; an index kept by content sees only the writes through its wrapper and could
  only answer below a branch by copying itself per branch.
Assumes: an index is kept per node.
  Rules out: a node costing nothing until something changes at it; a library write not
  reaching every chat.
  So: kept where its changes are, read through the ancestry.
Still restrictive:
  a read below the library node pays for the rows of its chat's other branches in its range;
  each merge on a read's path doubles its ancestry checks;
  an index is the base node's, an account's or a chat's: a node below the base that takes many
  in-place writes (a long-lived node in a chat) is read as any chat node is;
  a read pays one more level for an account's changes of shared content;
  a schema version with a new index on existing rows comes into force when the build ends.
```

## Free-form and typed

```json
{ "name": "lore.entry", "version": 3,
  "fields": { "book":  { "type": "id" },     "name": { "type": "string" },
              "order": { "type": "number" }, "when": { "type": "condition" },
              "text":  { "type": "string" } },
  "computed": { "need": "lore/need" },
  "indexes": [ { "on": [ "book", "need" ] }, { "on": [ "book", "order" ] } ],
  "reads": "lore/read" }
```

```
Shared formats have schemas: card, chat, chat.message, lore.book, lore.entry, lore.books,
  world.entry, relations, tags, bookmark, pkg; settings has one whose fields are open (each a setting name).
  An install's own component may have none; then it is any table, with no index but "has".
A schema is content: a package ships it, and a new package version with a changed schema is
  a content change like any other. The root declares the schemas of what is installed;
  one version per component name is in force, on every branch.
Stored data is never rewritten for a schema: a value keeps the shape it was written in, with
  the version it was written under, and "reads" (a pure function, (value, version) -> the
  value in this version's shape) gives readers and indexes the current shape. The only
  migration is upstream's: the import reads upstream's cards, books and chats into the
  first version of these schemas. A version that drops a field reads it away; one that adds
  a field gives it a value in reads; an index on it is built as above.
Free-form: a component with no schema is a table; a change can still name a field, so its
  fields still merge and revert apart. Searching an open bag of properties is a query over
  it, reading a budget of rows a page, or over a schema the install declares later.
```

A schema change never touches stored data, and old shapes are read, not converted: "reads" is the place a change of format lives, so nothing stored is ever partial or waiting. Assumes: the store checks every write against the schema. Rules out: reading a component written under an older version without converting it. So: the schema's reads gives the current shape; a write is in the version in force, and the store checks only the fields its indexes read and the fields that hold ids. Still restrictive: one schema version in force for all branches, so a branch can't try a new format on its own.

## A chat and its messages

```lua
-- chat.lua: a chat is a node; each message is a child node, whose own "chat.message" is the message
return function(c)                        -- c: what the loader handed this module
  local store, kv = c.store, c.kv
  local M = {}

  function M.new(library, card)           -- library: the node a chat starts under; card: the card's entity
    local chat = store:node{ library }    -- [host]
    store:apply(chat, { { chat, "chat", kv.set, { card = card } } })        -- [host]
    return chat
  end

  function M.append(at, msg)              -- msg = { role, speaker, text }; speaker: a card's or persona's entity
    local n = store:node{ at }            -- [host]
    store:apply(n, { { n, "chat.message", kv.set, msg } })                  -- [host]
    return n
  end

  function M.history(at)                  -- the messages on the path to at, oldest first
    local out, n = {}, at
    while n do
      local m = store:get(n, n, "chat.message")   -- [host]
      if m then table.insert(out, 1, { node = n, msg = m }) end
      n = store:parents(n)[1]             -- [host] a chat's messages have one parent
    end
    return out
  end

  return M
end
```

A swipe or a branch needs no code here: appending to a node that already has a child makes a sibling.

## Operations

```lua
-- kv.lua: operations; each is pure, (old, arg) -> new
return function()
  local M = {}
  function M.set(_, v) return v end
  function M.add(old, n) return (old or 0) + n end
  function M.add_within(old, a)           -- a = { amount, low, high }
    local v = (old or 0) + a[1]
    if v < a[2] then v = a[2] elseif v > a[3] then v = a[3] end
    return v
  end
  function M.append(old, v)
    local t = {}
    for i, x in ipairs(old or {}) do t[i] = x end
    t[#t + 1] = v
    return t
  end
  function M.merge(old, t)                -- fields into an existing table; nothing if it's gone
    if old == nil then return nil end
    local n = {}
    for k, v in pairs(old) do n[k] = v end
    for k, v in pairs(t) do n[k] = v end
    return n
  end
  function M.settle(old, a)               -- a = { job, value }: replaces only that job's pending entry
    if old == nil or old.state ~= "pending" or old.job ~= a.job then return old end
    return a.value
  end
  return M
end
```

Even “set” is content. Because ops are pure, the store can re-run the later ones after a revert.

## One turn, composed

```lua
-- prompt.lua: a prompt is what its parts return, in order
return function()
  local M = {}
  function M.assemble(parts, ctx)
    local messages = {}
    for _, part in ipairs(parts) do
      for _, m in ipairs(part(ctx)) do messages[#messages + 1] = m end
    end
    return messages
  end
  return M
end

-- ilse/main.lua: this card’s turn, composed from parts
return function(c)
  local store, chat, lore, prompt, model, tracker, condense =
    c.store, c.chat, c.lore, c.prompt, c.model, c.tracker, c.condense
  local history = condense.wrap(chat.history)
  local T = {}

  local parts = {
    function(ctx)
      return { { role = "system", content = store:get(ctx.at, ctx.speaker, "card").description } }  -- [host]
    end,
    function(ctx)
      local out = {}
      for _, e in ipairs(ctx.came_up) do out[#out + 1] = { role = "system", content = e.text } end
      return out
    end,
    function(ctx)
      local out = {}
      for _, h in ipairs(ctx.history) do out[#out + 1] = { role = h.msg.role, content = h.msg.text } end
      return out
    end,
  }

  local reply_steps = {                   -- each returns the fields it sets, or nothing
    function(ctx) return { history = history(ctx.at), speaker = c.me } end,   -- c.me: this card's entity
    function(ctx) return { came_up = lore.activate(ctx, store:get(ctx.at, c.me, "lore.books"), 4) } end,  -- [host]
    function(ctx) return { messages = prompt.assemble(parts, ctx) } end,
    function(ctx) return { reply = model.generate(ctx.messages) } end,
    function(ctx)
      return { at = chat.append(ctx.at, { role = "assistant", speaker = c.me, text = ctx.reply }) }
    end,
    tracker.step,
  }

  function T.reply(ctx)                   -- also what a swipe runs, from the message above
    for _, step in ipairs(reply_steps) do
      for k, v in pairs(step(ctx) or {}) do ctx[k] = v end
    end
    return ctx
  end

  function T.send(ctx)
    ctx.at = chat.append(ctx.at, { role = "user", speaker = ctx.persona, text = ctx.text })
    return T.reply(ctx)
  end

  return T
end
```

The person sends, the prompt is assembled, the model is called, the reply is stored: four entries in a list the card owns. The card's books are its "lore.books" relation, and the speaker is an entity, so every part reads the card it needs by id. Each step returns the fields it sets and the turn merges them, because values crossing a reference are copied: a step from another module (tracker.step, cleanup in gap 8) can't write into the card's ctx, and lore.activate returns what came up. There are no hooks. An extension is one more step, or a wrapper around a part; a group chat is a module that runs the reply steps once per speaker, or composes their replies into one.

## The install: loading modules and handing out capabilities

```lua
-- root.lua: the one module the host starts, holding every host module
return function(caps)                     -- caps: sandbox, store, latest, net, page, clock, disk, home, ...
  local store, home = caps.store, caps.home
  local function pkg(name)                -- a package's "pkg", by name in the library's list of them
    return store:get(home, store:get(home, home, "pkg.installed")[name], "pkg")   -- [host]
  end
  local function load(name, given)
    return caps.sandbox:load(pkg(name).source, "lua", given)               -- [core]
  end
  for _, name in ipairs{ "chat", "lore", "chars" } do                       -- the shared formats' schemas
    for _, s in ipairs(pkg(name).schemas or {}) do store:declare(home, s) end   -- [host]
  end
  local narrow = load("narrow", {})       -- a wrapper forwarding only keys under a prefix, for latest
  local function only(components, mode)   -- the nodes under home, those components
    return store:narrow{ nodes = { home }, components = components, mode = mode }   -- [host]
  end
  local function only_latest(prefix, mode) return narrow(caps.latest, prefix, mode) end

  local json     = load("json", {})
  local kv       = load("kv", {})
  local cond     = load("cond", {})
  local function query(s) return load("query", { store = s, cond = cond }) end
  local secrets  = load("secrets",  { latest = only_latest("secrets/", "rw"), net = caps.net, kv = kv,
                                      signers = load("signers", {}), scrub = load("scrub", {}) })
  local chat     = load("chat",     { store = only({ "chat", "chat.message" }, "rw"), kv = kv })
  local model    = load("openai",   { net = secrets:net("openai"), json = json,
                                      base = "https://api.example.com", model_id = "some-model" })
  local lorebooks = only({ "lore.book", "lore.entry" }, "r")
  local lore     = load("lore",     { store = lorebooks, cond = cond, query = query(lorebooks) })
  local cards    = only({ "card", "tags", "lore.books" }, "r")
  local chars    = load("chars",    { store = cards, cond = cond, query = query(cards) })
  local prompt   = load("prompt",   {})
  local tracker  = load("tracker",  { store = only({ "tracker" }, "rw"), kv = kv, model = model, cond = cond })
  local condense = load("condense", { store = only({ "condense" }, "rw"), names = only({ "card", "persona" }, "r"),
                                      kv = kv, model = model })
  local ilse     = load("ilse",     { store = cards, me = 7, chat = chat, lore = lore,   -- 7: Ilse's card in the library
                                      prompt = prompt, model = model, tracker = tracker, condense = condense })

  caps.page:on(function(action, conn)                                       -- [host]
    if action.type == "send" then
      local ctx = ilse.send{ at = action.at, chat = action.chat, text = action.text, persona = action.persona }
      conn:send{ at = ctx.at, reply = ctx.reply }                           -- [host]
    elseif action.type == "swipe" then
      local ctx = ilse.reply{ at = store:parents(action.reply)[1], chat = action.chat }   -- [host]
      conn:send{ at = ctx.at, reply = ctx.reply }                           -- [host]
    elseif action.type == "condense" then
      condense.run(action.at, condense.wrap(chat.history), action.from, action.to)
      conn:send{ at = action.at, condensed = { from = action.from, to = action.to } }   -- [host]
    end
  end)
end
```

Installing a module is the root loading its source and handing it capabilities; nothing else gives a module any power. Each store reference names the components it reaches, so lore can't read a card and the tracker can't touch a message; the shared formats' schemas, and with them their indexes, are declared before anything reads. The model's key never reaches the adapter: secrets:net hands it a net that puts the key into requests (gap 2). This root wires one card; a real install’s root composes each chat’s wiring from the card and what is installed (gap 5, option D).

## Lorebook activation as a library

```lua
-- cond.lua: conditions as data, e.g. ["all", ["keys", "dragon"], ["speakerTag", 41]]
return function()
  local unpack = unpack or table.unpack
  local ops, M = {}, {}
  function M.define(name, fn) ops[name] = fn end
  function M.holds(c, ctx)
    if c == nil then return true end
    return ops[c[1]](ctx, unpack(c, 2))
  end
  ops.all = function(ctx, ...)
    for _, c in ipairs({ ... }) do if not M.holds(c, ctx) then return false end end
    return true
  end
  ops.any = function(ctx, ...)
    for _, c in ipairs({ ... }) do if M.holds(c, ctx) then return true end end
    return false
  end
  ops["not"] = function(ctx, c) return not M.holds(c, ctx) end
  return M
end

-- lore_need.lua: what an entry can't come up without; the schema's computed field "need"
return function()
  local function need(c)                    -- the grams c can't hold without, or nil if it can hold with none
    if c == nil then return nil end
    if c[1] == "keys" then
      local out = {}
      for i = 2, #c do out[#out + 1] = c[i]:lower():sub(1, 3) end
      return out
    elseif c[1] == "all" then               -- any conjunct's need will do; the shortest narrows most
      local best
      for i = 2, #c do
        local n = need(c[i])
        if n and (best == nil or #n < #best) then best = n end
      end
      return best
    elseif c[1] == "any" then               -- only if every branch needs something
      local out = {}
      for i = 2, #c do
        local n = need(c[i])
        if n == nil then return nil end
        for _, g in ipairs(n) do out[#out + 1] = g end
      end
      return out
    end
    return nil
  end
  return function(entry) return need(entry.when) or { "" } end
end

-- lore.lua: lorebook activation (keys, recursion) as a library
return function(c)
  local store, cond, query = c.store, c.cond, c.query
  local L = {}

  cond.define("keys", function(ctx, ...)      -- any of these words in the scanned text
    local text = ctx.scanned:lower()
    for _, word in ipairs({ ... }) do
      if text:find(word:lower(), 1, true) then return true end
    end
    return false
  end)

  cond.define("cameUp", function(ctx, name) return ctx.active[name] ~= nil end)

  local function grams(text, into)          -- every piece of 1 to 3 characters of text, and ""
    text = text:lower()
    into[""] = true
    for i = 1, #text do
      for n = 1, 3 do
        if i + n - 1 <= #text then into[text:sub(i, i + n - 1)] = true end
      end
    end
  end

  function L.activate(ctx, books, depth)      -- books: book entities; the entries that came up, in order
    local recent = {}
    for i = math.max(1, #ctx.history - depth + 1), #ctx.history do
      recent[#recent + 1] = ctx.history[i].msg.text
    end
    local scan = { at = ctx.at, speaker = ctx.speaker,   -- what conditions read
                   scanned = table.concat(recent, "\n"), active = {} }
    local seen, came_up = {}, {}
    grams(scan.scanned, seen)
    repeat                                    -- recursion: scan again with what came up
      local grew, found, list = false, {}, {}
      for g in pairs(seen) do list[#list + 1] = g end
      for _, book in ipairs(books or {}) do
        if cond.holds((store:get(ctx.at, book, "lore.book") or {}).when, scan) then   -- [host]
          local q = { "all", { "=", "lore.entry", "book", book }, { "in", "lore.entry", "need", list } }
          query.each(ctx.at, q, { order = { "lore.entry", "order" }, read = { "lore.entry" } }, {}, function(row)
            local e = row.values["lore.entry"]
            if scan.active[e.name] == nil and cond.holds(e.when, scan) then
              scan.active[e.name] = e
              came_up[#came_up + 1] = e
              found[#found + 1] = e.text
              grew = true
            end
          end)
        end
      end
      for _, t in ipairs(found) do
        scan.scanned = scan.scanned .. "\n" .. t
        grams(t, seen)
      end
    until not grew
    return came_up
  end

  return L
end
```

keys and cameUp are lore.lua’s own operators, added to cond.lua the way any module adds one. An entry's condition is its own data, so the store can't run it; what it can answer is which entries could come up at all. The schema's computed field "need" is the grams an entry's condition can't hold without (the first three characters of each key, lowercased: an "all" needs what any of its parts needs, an "any" what all of them need, and anything else needs nothing, which is the gram ""), and the index on (book, need) gives, per open book, the entries whose need is one of the scanned text's grams, which cond.holds then checks in full. A pass costs, per open book, about the smaller of the text's distinct grams and the book's distinct needs in seeks, plus a check per entry found; nothing per entry of other books, nothing per card. Recursion scans again with what came up, its grams added. Unicode case folding is the unicode wasm module's in the real library (gap 8); :lower() here is ASCII. Tags and saved views are queries too ("Queries"), on the indexes their schemas declare, and a live view is a watch on its query (gap 4).

## A backend adapter and an upstream-style tracker

```lua
-- openai.lua: a backend adapter; its net reaches one host and adds the key it can't read
return function(c)
  local A = {}
  local function call(messages, extra)
    local body = { model = c.model_id, messages = messages }
    for k, v in pairs(extra or {}) do body[k] = v end
    local res = c.net:fetch{ method = "POST", url = c.base .. "/v1/chat/completions",   -- [host]
                             headers = { authorization = "Bearer " .. c.net.mark },
                             body = c.json.encode(body) }
    return c.json.decode(res.body).choices[1].message.content
  end
  function A.generate(messages) return call(messages) end
  function A.generate_json(messages)
    return c.json.decode(call(messages, { response_format = { type = "json_object" } }))
  end
  return A
end

-- tracker.lua: an upstream-style tracker, as a module
return function(c)
  local store, kv, model, cond = c.store, c.kv, c.model, c.cond
  local T = {}

  function T.step(ctx)
    local r = model.generate_json({
      { role = "system", content = [[Reply with JSON: {"minutes_passed": n, "affection_change": n}]] },
      { role = "user", content = ctx.reply },
    })
    store:apply(ctx.at, {                                                   -- [host]
      { ctx.chat, "tracker", kv.add, r.minutes_passed, field = "minutes" },
      { ctx.speaker, "tracker", kv.add_within, { r.affection_change, 0, 100 }, field = "affection" },
    })
  end

  cond.define("evening", function(ctx)
    local minutes = store:get(ctx.at, ctx.chat, "tracker", "minutes") or 0  -- [host]
    return math.floor(minutes / 60) % 24 >= 18
  end)

  return T
end
```

An upstream extension and a feature that ships with the app are the same thing: a module, holding only what it was handed (here, writes of its own component "tracker", on any entity, and the model). The chat's time is a field on the chat's entity and the affection a field on the character's, both changed at the reply's node, so they follow the branch.

## Case 1: an entry that comes up on a keyword, only for characters tagged "npc"

```lua
entity 5001, on the library node, "lore.entry", op kv.set:
{ "book": 4001, "name": "Dragons", "order": 10,
  "when": ["all", ["keys", "dragon"], ["speakerTag", 41]],
  "text": "Dragons nest in the eastern cliffs…" }
  need, computed: ["dra"]; the index lore.entry (book, need) holds (4001, "dra", 5001)

entity 7, Ilse, on the library node: "card" { "name": "Ilse", "description": "…" },
  "tags" [ 41 ], "lore.books" [ 4001, 4002, 4003, 4004 ]
entity 41: "tag" { "name": "npc" }

-- chars.lua
return function(c)
  c.cond.define("speakerTag", function(ctx, tag)   -- ctx.speaker: the speaking character's entity
    return c.query.holds(ctx.at, ctx.speaker, { "to", "tags", tag })
  end)
  return {}
end
```

The card set ctx.speaker; a group module would set it per speaker. Filtering the character list by the tag is the query { "all", { "has", "card" }, { "to", "tags", 41 } } ("Queries"), which a views module keeps as a saved view's data and the store answers from the tags index. Run under LuaJIT on a store that folds every path: Ilse brings up Dragons; Maren, untagged, doesn't.

## Case 2: a book that loads when another entry came up

```
entity 4003, "lore.book":
{ "name": "capital", "when": ["cameUp", "The Capital"] }

entity 5002, "lore.entry":
{ "book": 4002, "name": "The Capital", "order": 1, "when": ["keys", "capital"], "text": "The capital has a palace." }

entity 5003, "lore.entry":
{ "book": 4003, "name": "The Palace", "order": 1, "when": ["keys", "palace"], "text": "…" }
```

lore.activate checks each book’s condition on every pass, so once The Capital comes up from another book, this book’s entries are looked up on the next pass, with the grams of what came up; run under LuaJIT, "Near the capital?" brings up The Capital, and its text, which names the palace, brings up The Palace. Whether a book gates its entries is lore.lua’s choice, not the core’s.

## Case 3: time passing and an affection meter

```
tracker.lua (above) after each reply, at the reply's node:
  the chat 790,  "tracker" field minutes    kv.add         reply’s minutes_passed
  Ilse (7),      "tracker" field affection  kv.add_within  { affection_change, 0, 100 }

entity 5009, "lore.entry":
{ "book": 4004, "name": "Evening", "when": ["evening"], "text": "It is evening." }
  need: [""]: no key, so it is looked up on every pass of its book
```

The time and the meter are fields the tracker chose on the entities they are about, and “evening” is its condition. A card that wants the model to report them in the same reply, or as a tool call, writes a different step.

## Case 4: condensing a finished 80-message side quest so the prompt carries the condensed version

```lua
-- condense.lua: put a condensed text in place of a span of messages
return function(c)
  local store, names, kv, model = c.store, c.names, c.kv, c.model
  local C = {}

  local function name(at, e)                -- a speaker's name, from its card or persona
    local who = names:get(at, e, "card") or names:get(at, e, "persona") or {}   -- [host]
    return who.name or ""
  end

  function C.run(at, history, from, to)     -- from, to: message nodes on the path to at
    local lines, inside = {}, false
    for _, h in ipairs(history(at)) do
      if h.node == from then inside = true end
      if inside then lines[#lines + 1] = name(at, h.msg.speaker) .. ": " .. h.msg.text end
      if h.node == to then break end
    end
    local text = model.generate({
      { role = "system", content = "Condense this finished side quest. Keep what later events depend on." },
      { role = "user", content = table.concat(lines, "\n") },
    })
    local span = store:entity(at)                                           -- [host]
    store:apply(at, { { span, "condense", kv.set, { from = from, to = to, text = text } } })   -- [host]
  end

  function C.wrap(history)                  -- the same history, condensed spans in place
    return function(at)
      local starts, out, skip = {}, {}, nil
      for _, row in ipairs(store:query(at, { "has", "condense" }, { read = { "condense" } }).rows) do   -- [host]
        local s = row.values.condense
        starts[s.from] = s
      end
      for _, h in ipairs(history(at)) do
        if skip == nil and starts[h.node] then
          local s = starts[h.node]
          out[#out + 1] = { node = h.node, msg = { role = "system", text = s.text } }
          skip = s.to
        end
        if skip == nil then out[#out + 1] = h
        elseif h.node == skip then skip = nil end
      end
      return out
    end
  end

  return C
end
```

Nothing about summarizing is in the core or in chat.lua. A span is an entity of its own, made at the node where it was condensed, so the spans in force at a node are the query ["has", "condense"] there: the chat's few span rows, filtered by ancestry ("Indexes under branching"), not a read per message. The root runs it from a page action; a module could offer C.run to the model as a tool, or a step could run it. Run over C.wrap’s output, a span can cover earlier condensed text.

## Case 5: a swipe or branch rolling it back

```
node 811  chat.message  Ren: "Where do dragons nest?"
├─ node 812  chat.message  Ilse: reply A
│            chat 790's tracker minutes kv.add 90, Ilse's tracker affection kv.add_within +2
└─ node 813  chat.message  Ilse: reply B   (the swipe: ilse.reply from 811)
             chat 790's tracker minutes kv.add 30

state at 813: the chat's minutes are their value at 811 plus 30; nothing from 812, and
Ilse's affection is what it was at 811.
a condense span made at node 925: not on a branch from node 900.

store:revert(at, 9040)                                                  -- [host]
  cancels the "add 90"; every later value of the chat's minutes on that path is 90 less
```

Swipes, branches and undo come from where a change hangs, for every module alike; a merge is a node with two parents. A module that keeps something out of rollback writes it on a node above the chat, such as the library node; which entity it is on doesn't matter to that.

## Gap 1, waiting: several calls at once, the first answer, a time limit

```lua
-- async.lua: several calls at once, the first of several, a time limit
return function(c)
  local clock = c.clock
  local A = {}

  function A.all(fns)                       -- every fn at once; their results in order
    local hs, out = {}, {}
    for i, fn in ipairs(fns) do hs[i] = task.spawn(fn) end                  -- [core]
    for i, h in ipairs(hs) do
      local ok, r = pcall(h.join, h)                                        -- [core]
      if not ok then
        for j = i + 1, #hs do hs[j]:cancel() end                            -- [core]
        error(r, 0)
      end
      out[i] = r
    end
    return out
  end

  function A.first(fns)                     -- the first fn to succeed; the rest are cancelled
    if #fns == 0 then error("nothing to wait for", 0) end
    local p, hs, left = task.promise(), {}, #fns                            -- [core]
    for i, fn in ipairs(fns) do
      hs[i] = task.spawn(function()                                         -- [core]
        local ok, r = pcall(fn)
        if ok then p:set(r) else left = left - 1; if left == 0 then p:fail(r) end end
      end)
    end
    local ok, r = pcall(p.get, p)                                           -- [core]
    for _, h in ipairs(hs) do h:cancel() end
    if ok then return r end
    error(r, 0)
  end

  function A.within(ms, fn)                 -- fn's result, or raises "timeout"
    local p = task.promise()                                                -- [core]
    local work = task.spawn(function()                                      -- [core]
      local ok, r = pcall(fn)
      if ok then p:set(r) else p:fail(r) end
    end)
    local timer = task.spawn(function() clock:sleep(ms); p:fail("timeout") end)   -- [core], [host]
    local ok, r = pcall(p.get, p)
    work:cancel(); timer:cancel()
    if ok then return r end
    error(r, 0)
  end

  return A
end
```

Waiting became a property of the two core primitives (changed above), because nothing else can provide it: only the runtime can run a sandbox's other calls while one waits, and only the core carries a call whose result comes later. Both tests, rerun: it is necessary for that reason, and its assumptions are listed under each primitive, with the less restrictive form taken each time (a call holds only its task; tasks interleave only at waits, so no locks; the caller is released at once and the callee may clean up; cancelling reaches what a task spawned). Everything built on it is content: all, first and within are twenty lines each, and N concurrent calls are N spawns. Determinism is untouched: operations run in deterministic mode, which has no task, no promise and no reference but read, so an apply is never interleaved with anything. What concurrency adds is that a module reading a value, waiting, and then writing can race another task; it writes through an operation instead (kv.add, kv.settle), which the store runs on the current value. Costs: every call can interleave with others, so module authors have to know that state can change across any call; a task that loops without calling can't be cancelled, only stopped by its budget.

## Gap 1, waiting: a reply streamed to the page

```lua
-- stream.lua: a sink is a reference with push(item) and close(err);
-- push records the item before it waits, so items stay in order
return function()
  local S = {}

  function S.sender(sink, window)           -- pushes without waiting for each; at most window in flight
    local flying, first = {}, 1
    local out = {}
    function out:push(item)
      flying[#flying + 1] = task.spawn(sink.push, sink, item)              -- [core] sent at once, in order
      if #flying - first + 1 > window then
        flying[first]:join(); flying[first] = nil; first = first + 1       -- [core]
      end
    end
    function out:close(err)                 -- after a cancel, the last pushes may have been cancelled
      for i = first, #flying do pcall(flying[i].join, flying[i]) end
      sink:close(err)
    end
    return out
  end

  function S.queue()                        -- a sink one reader takes items from, in order
    local items, head, tail, wake, closed = {}, 1, 0, nil, nil
    local q = {}
    local function ring() if wake then local w = wake; wake = nil; w:set() end end
    function q:push(item) tail = tail + 1; items[tail] = item; ring() end
    function q:close(err) closed = { err }; ring() end
    function q:read()                       -- the next item; nil at the end
      while head > tail do
        if closed then if closed[1] then error(closed[1], 0) end return nil end
        wake = task.promise(); wake:get()                                   -- [core]
      end
      local item = items[head]; items[head] = nil; head = head + 1
      return item
    end
    return q
  end

  return S
end

-- openai.lua, streaming: pushes the text to sink as it comes
function A.stream(messages, sink)
  local q = c.stream.queue()
  local fetching = task.spawn(c.net.fetch, c.net, {                         -- [core], [host]
    method = "POST", url = c.base .. "/v1/chat/completions",
    headers = { authorization = "Bearer " .. c.net.mark },
    body = c.json.encode{ model = c.model_id, messages = messages, stream = true },
    sink = q })                             -- net pushes the body's bytes as they arrive
  local rest = ""
  while true do
    local chunk = q:read()
    if not chunk then break end
    rest = rest .. chunk
    while true do
      local nl = rest:find("\n", 1, true)
      if not nl then break end
      local data = rest:sub(1, nl - 1):match("^data: (.*)$")
      rest = rest:sub(nl + 1)
      if data and data ~= "[DONE]" then
        local delta = c.json.decode(data).choices[1].delta.content
        if delta then sink:push(delta) end
      end
    end
  end
  fetching:join()
end

-- ilse/main.lua: the reply step, keeping what came if the person stops it
function(ctx)
  local shown, got = c.stream.sender(ctx.page_sink, 16), {}
  local sink = {}
  function sink:push(t) got[#got + 1] = t; shown:push(t) end
  function sink:close() end
  local ok, err = pcall(model.stream, ctx.messages, sink)
  if not ok and err ~= "cancelled" then error(err, 0) end
  shown:close()
  return { reply = table.concat(got), stopped = not ok }   -- the append step stores stopped with it
end
```

A stream is content: a sink reference, a sender that keeps 16 pushes in flight so no item waits for a round trip, and a queue for the reader. Order holds by construction: calls through one reference arrive in order, and each push records its item before its first wait. Net and the store push to a sink the same way (net's body here, store:watch in gap 4), so a host's stream crosses to the page with no content in between. The person's stop reaches the HTTP request through structured cancellation: the turn's task waits in model.stream, openai.lua's task waits in q:read, and fetching is its child, so one cancel aborts the request. Assumes: the consumer can keep up within a window, and a push that waits slows the sender. Rules out: a stream whose items may be reordered for speed (none needed). Costs: one task per item in flight, and a page's view of the stream depends on how the display handle appends text without layout shift (the owner's).

## Gap 1, waiting: a turn stopped mid-reply, step by step

```
t=0      page: action { type = "send", id = 41, at = 820, text = "…", sink = <page ref> }
         root: spawns task T41 for ilse.send and keeps turns[41] = T41
t=8ms    T41: chat.append → store:apply at 821; model.stream → task F: net:fetch
t=420ms  bytes arrive: net pushes to q; openai.lua parses; the card's sink keeps each
         piece and sends it on to the page, up to 16 unanswered
t=900ms  page: action { type = "stop", id = 42, turn = 41 }
         root: turns[41]:cancel()
           T41's wait (its call to model.stream) raises "cancelled" at once
           openai.lua's task, waiting in q:read, is cancelled; F, its child, is
           cancelled; net aborts the HTTP request
           the card keeps got: chat.append stores one complete message,
           { "role": "assistant", "name": "Ilse", "text": "…", "stopped": true },
           and the card skips its remaining steps (tracker.step)
t=905ms  reply to action 41: { at = 822, reply = "…", stopped = true }
         reply to action 42: {}
```

The stop is one action and one reply, and the stopped reply is stored complete or not at all; whether to keep it is the card's choice, not the core's. Where a step that an extension added sits in the turn (gap 5) doesn't change this: its task is the turn's, so it is cancelled with it.

## Gap 1, waiting: asking the person on a page

```lua
-- ask.lua: a question for the person, answered on any of their open pages
return function(c)
  local async = c.async
  local Q, pages = {}, {}                   -- pages[conn] = that page's answer reference

  function Q.connected(conn, answer)        -- the root calls this when a page says hello
    pages[conn] = answer
    task.spawn(function() conn:closed(); pages[conn] = nil end)             -- [core], [host]
  end

  function Q.ask(question, ms)              -- the answer; raises "nobody connected" or "timeout"
    local tries = {}
    for _, answer in pairs(pages) do
      tries[#tries + 1] = function() return answer:ask(question) end
    end
    if #tries == 0 then error("nobody connected", 0) end
    return async.within(ms, function() return async.first(tries) end)
  end

  return Q
end
```

Which page: every open page of the person; the first answer wins and the others' calls are cancelled, so their page modules take the question down. None connected: the call raises at once, and the module decides. A page that closes mid-question makes its call raise "gone", and first goes on with the rest. A question that must wait for someone to connect, or survive a restart, is a job (gap 3) whose record is the question; pages watch jobs/ (gap 4) and answer with an action. Assumes: "their pages" are the pages whose sessions belong to the account asking ("Accounts: one store, a home node each"). How a question is drawn is the display handle's (the owner's).

## Gap 1, waiting: blocking-style Lua on the page

```lua
-- a Lua module on the page
local function title(store, at, ilse)
  local ch = store:get(at, ilse, "card")    -- a call through a reference: can wait
  return ch.name:upper()
end

local function clamp(v, lo, hi)             -- calls nothing that can wait
  if v < lo then return lo elseif v > hi then return hi end
  return v
end

// what the compiler emits
function* title(store, at, ilse) {
  const ch = yield* call(store, "get", at, ilse, "card");
  return str_upper(index(ch, "name"));
}
function clamp(v, lo, hi) {
  if (lt(v, lo)) return lo; else if (lt(hi, v)) return hi;
  return v;
}
// in every loop: if (--slice.left === 0) yield* slice.check();
```

Every Lua function that can reach a wait compiles to a generator, and every call to it to yield*; the page's scheduler runs each task as a generator and resumes it when the promise behind its host call settles. Lua's own coroutines need the same transform, so this is not an extra cost of waiting. A function the compiler can show never waits (it calls only functions it knows don't) compiles to a plain function; operations run in deterministic mode, where nothing waits, so they are always plain. Each loop counts down a time slice and yields to the browser when it is spent, which is also where budgets are checked, so a long task never holds up drawing. On the server, LuaJIT runs tasks as coroutines and a host call that has to wait yields to the host's event loop. Unknown until measured: what generators cost on call-heavy code such as lore activation.

## Gap 2, state without history: latest, a host module

```
latest:get(key)                    -> value, or nil
latest:range(prefix, after, limit) -> { { key, value }, ... } in key order, a page at a time
latest:apply(changes)              all or none; changes = { { key, op, arg,
                                     expires = ms, evictable = true }, ... }
latest:watch(prefix, since, sink)  -> handle, as store:watch (gap 4)
op as in the store: a pure function (old, arg) -> new; nil deletes the key.
expires: the key is deleted then. evictable: when its account is full, the host may
delete it, least recently read first. Only each key's last value is kept.
The server has one; each page has its device's own, which never leaves the device.

Necessary: persistence is I/O. The version store keeps every change while its node is
kept, so a setting written there grows history forever and a secret stays in it;
disk is by hash, so it has no place whose content changes.

Assumes: writers don't overlap, so the last write wins.
  Rules out: two tabs adding to one counter; two devices editing one list.
  So: a change is an operation run on the current value, as in the store.
Assumes: an entry lives until it's deleted.
  Rules out: caches and drafts that go away by themselves.
  So: expires and evictable, per change.
Assumes: one copy for every device.
  Rules out: state that belongs to one device (an upload's progress on a phone).
  So: every host has its own.

Still restrictive:
  no history: what needs undo or branches goes in the version store;
  a page's offline writes meant for the server are content's to send and merge.

{ "key": "drafts/chat/790", "value": { "text": "Where do drag" }, "expires": 1765700000000 }
{ "key": "cache/tokens/llama3/sha256:9f2c…", "value": 1287, "evictable": true }
{ "key": "viewing/790", "value": 821 }
on a page's own latest:
{ "key": "progress/upload/42", "value": 0.4 }
```

Caches, sessions, progress and drafts are one host module, narrowed by prefix with narrow.lua, so each module sees only its own keys. latest stays keys and doesn't become components: nothing in it is asked for by what it is (a job is resumed by paging jobs/, a derived value is named by its kind and its input's hash, a secret by its name, a draft by its chat), so it needs no query and no index, and a key is its identity rather than an entity's name for it. Components would give it schemas, indexes and per-field merging it has no use for, with no history or branches to version them along. A module that needs to find unversioned state by what it is keeps it in the version store at a node above the chats, which costs history. No setting is kept here: settings at every level are in the version store, so they all branch and undo the same way ("Settings: one cascade along a path"). It is a host module rather than content because nothing else holds a value without keeping its history. Costs: one write per change, no history; a module has to choose for each piece of state whether it belongs in the version store (follows branches, can be undone) or here (doesn't). Where a module's settings are edited is a UI slot (gap 5), and the editor is drawn through the display handle; both are the owner's.

## Gap 2, state without history: secrets

```lua
-- secrets.lua: secrets kept in latest under secrets/; no export reads one
return function(c)
  local latest, net, kv = c.latest, c.net, c.kv   -- latest narrowed to secrets/; net: any host
  local S = {}

  function S:put(name, value, hosts, signer)      -- hosts: { ["api.example.com"] = true }
    latest:apply{ { "secrets/" .. name, kv.set,                             -- [host]
                    { value = value, hosts = hosts, signer = signer or "replace" } } }
  end

  function S:net(name)                            -- a net that adds the secret and never shows it
    local mark = "\0secret:" .. name .. "\0"      -- what a module writes where the secret goes
    local N = { mark = mark }
    function N:fetch(req)
      local s = latest:get("secrets/" .. name)                              -- [host]
      if not s then error("no secret named " .. name, 0) end
      local host = req.url:match("^https://([^/:]+)")
      if not host or not s.hosts[host] then error(name .. " isn't for that host", 0) end
      req.redirect = false                        -- a redirect would carry it elsewhere
      local signed, inserted = c.signers[s.signer](s.value, mark, req)
      if req.sink then signed.sink = c.scrub.sink(req.sink, inserted, mark) end
      return c.scrub.reply(net:fetch(signed), inserted, mark)               -- [host]
    end
    return N
  end

  return S
end
```

Secrets are content over latest and net, held only by secrets.lua: it is the only module with latest under secrets/, it exports put but no read, and what it hands out is a net that substitutes the value at send time for the hosts the secret was stored for. Never in versioned history: latest has none. Never on the page: secrets.lua runs on the server, and the root never hands a page anything under secrets/; the person types a key into a page module that holds only a reference to put (that field is drawn through the display handle, the owner's). How the value goes into a request is the signer named in the secret's record (content: plain replacement, Basic auth, HMAC signing), chosen when the secret is stored, not by the module using it, so a module can't pick a way of inserting it that hides the secret where a server would echo it. Every string the signer inserted is replaced by the mark wherever a reply repeats it, in streams too. A token refresh is a signer that also reads the new token from the reply and stores it with put. Assumes: hosts are named exactly (no wildcard). Rules out: a module computing anything from the secret except through a signer. Costs: one latest read per request; scrubbing scans each reply for the inserted strings. I don't know whether secrets must also be encrypted on disk; that needs a key the host holds, which nothing here provides.

## Gap 3, derived data: how "not computed yet" is stated

```
States, in latest under derived/<kind>/<input hash>:
  absent, read as   { "state": "none" }     never asked for
  { "state": "pending", "job": "derived/caption@some-vision-model/sha256:4b1e…",
    "since": 1763100002000 }
  { "state": "done", "text": "A red dragon on a cliff at dusk." }
  { "state": "failed", "error": "503 from host", "at": 1763100060000 }
A pending entry and its job record (jobs/<id>) are written in one apply, and the
result and the record's removal in another, so no pending entry is ever without a job.
The version store never holds a pending value: a result that is content (a condensed
span, a translated message) is applied once, complete, when its job finishes.

t=0      the person attaches an image to a message; the page sends one action
         server: disk:put(bytes) → { "$blob": "sha256:4b1e…" }, leased
         store:apply at 821: 821's chat.message with the blob → the blob is pinned
         derived.request("caption@some-vision-model", "sha256:4b1e…"):
           latest: the pending entry and jobs/derived/caption@…/sha256:4b1e…, one apply
         reply to the action: the message, and its caption { state = "pending" }
t=2s     the job: the vision model replies 503 → tries = 1, error kept; sleeps 2s
t=3s     the server stops
t=3.4s   the root wires its modules; jobs.resume() finds the record and runs it
t=6s     the model replies → one latest apply: the entry settles to done (its job
         matches) and the record is removed; pages watching derived/ get the text
```

Derived data is content: values that are functions of an input are kept in latest by the input's hash and the kind (whose name includes what the result depends on, such as the model), and every reader goes through derived.get, which reads absence as "none", so nothing reads a hole. Nothing stored is partial or waiting: the store holds only complete values, and in latest every pending entry has the job that will settle it, written in the same apply. A feature added to a library that already exists doesn't backfill: entries are asked for when something needs them, or by a sweep job that pages through a store:query with its cursor in its record, so it resumes where it stopped and costs nothing per card until it runs. Assumes: the result depends only on what the key names. Rules out: a derived value that differs by branch without saying so in its input (a summary of a path has the path's message hashes as its input). Costs: every reader handles four states; a person editing a caption makes it content, stored at the message's node, read before the derived entry.

## Gap 3, derived data: jobs.lua, work that survives restarts

```lua
-- jobs.lua: work that survives restarts, is retried, reports progress, can be cancelled
return function(c)
  local latest, clock, kv, kinds = c.latest, c.clock, c.kv, c.kinds   -- kinds: from the root
  local J, running = {}, {}

  local function finish(id, changes)        -- the result, and the record's removal, all or none
    changes[#changes + 1] = { "jobs/" .. id, kv.set, nil }
    latest:apply(changes)                                                   -- [host]
    running[id] = nil
  end

  local function run(id, rec)
    local kind = kinds[rec.kind]
    running[id] = task.spawn(function()                                     -- [core]
      while true do
        local ok, r = pcall(kind.run, rec.input, function(done, total)
          latest:apply{ { "jobs/" .. id, kv.merge, { progress = { done, total } } } }   -- [host]
        end)
        if ok then return finish(id, r) end
        if r == "cancelled" then return end
        rec.tries = rec.tries + 1
        if rec.tries >= kind.tries then return finish(id, kind.failed(rec.input, r)) end
        latest:apply{ { "jobs/" .. id, kv.merge, { tries = rec.tries, error = tostring(r) } } }  -- [host]
        clock:sleep(1000 * 2 ^ rec.tries)                                   -- [host]
      end
    end)
  end

  function J.start(id, kind, input, with)   -- with: changes made together with the record
    local rec = { kind = kind, input = input, tries = 0 }
    local changes = { { "jobs/" .. id, kv.set, rec } }
    for _, ch in ipairs(with or {}) do changes[#changes + 1] = ch end
    latest:apply(changes)                                                   -- [host]
    run(id, rec)
  end

  function J.cancel(id)
    local rec = latest:get("jobs/" .. id)                                   -- [host]
    if not rec then return end
    if running[id] then running[id]:cancel() end
    finish(id, kinds[rec.kind].failed(rec.input, "cancelled"))
  end

  function J.resume()                       -- at start: every job not finished runs again
    local after
    repeat
      local page = latest:range("jobs/", after, 500)                        -- [host]
      for _, e in ipairs(page) do run(e.key:sub(6), e.value) end
      after = page[#page] and page[#page].key
    until #page < 500
  end

  return J
end
```

Durable jobs are content over latest, clock and tasks. The jobs module's own tasks run the work, so a job outlives the action that started it, and J.cancel stops it with the task's cancel. Restarts: the record is written before the work and removed in the same apply as the result, so a job is run at least once; a cancel racing a finish is harmless because results settle through kv.settle, which only replaces the pending entry of that job, and kv.merge writes no progress into a record that's gone. A kind whose result goes to the version store makes that write idempotent itself (a component, on the entity the result is about, written with an op that refuses a second result of that job), because a crash between that write and finish runs it again. Concurrency limits per kind are a few lines more of the same. Costs: at-least-once, so a model may be called twice; progress is one latest write per report, so a kind reports at a rate it chooses. Which job kinds exist comes from what is installed, so the root's kinds table depends on the manifest (gap 5); showing progress and a cancel control is the display handle's (the owner's).

## Gap 3, derived data: derived.lua and a caption kind

```lua
-- derived.lua: values computed by I/O from an input, kept by kind and input hash
return function(c)
  local latest, jobs, clock = c.latest, c.jobs, c.clock
  local D = {}
  local function key(kind, input) return "derived/" .. kind .. "/" .. input end

  function D.ask(old, entry)                -- an op: only when never asked, or failed
    if old ~= nil and old.state ~= "failed" then error("asked already", 0) end
    return entry
  end

  function D.get(kind, input)
    return latest:get(key(kind, input)) or { state = "none" }               -- [host]
  end

  function D.request(kind, input)
    local k = key(kind, input)
    pcall(jobs.start, k, kind, input,
          { { k, D.ask, { state = "pending", job = k, since = clock:now() }, evictable = true } })
    return D.get(kind, input)
  end

  return D
end

-- caption.lua: a job kind; an image's description from a vision model
return function(c)                          -- c.kind: e.g. "caption@some-vision-model"
  local K = { tries = 4 }
  local function k(blob) return "derived/" .. c.kind .. "/" .. blob end
  function K.run(blob, progress)
    local text = c.model.describe(c.disk:get(blob))                         -- [host] then I/O, seconds
    return { { k(blob), c.kv.settle, { job = k(blob), value = { state = "done", text = text } } } }
  end
  function K.failed(blob, err)
    return { { k(blob), c.kv.settle, { job = k(blob),
               value = { state = "failed", error = tostring(err), at = c.clock:now() } } } }
  end
  return K
end

-- a part of a card's prompt that uses it
function(ctx)
  local cap = derived.get("caption@some-vision-model", ctx.image)
  if cap.state == "done" then return { { role = "system", content = "[Image: " .. cap.text .. "]" } } end
  return { { role = "system", content = "[An image that hasn't been described yet]" } }
end
```

Two requests at once can't start two jobs: D.ask raises in the second apply, which then makes nothing. The same shape gives embeddings (input: the text's hash), translations (the text's hash and the language in the kind) and classifications. A turn that would rather wait for the caption watches its key (gap 4) inside async.within. Entries are evictable: a caption whose image has been deleted is still a correct fact about that hash and goes when space is needed; an evicted entry reads as none and is asked for again.

## Gap 4, watching: the store and latest report every change

```
store:watch(node, what, since, sink) -> handle
  what = { e, c }: one component of one entity; or a query (cond data, the store's
  operators), with "read": the components to send of what matches
  pushes to sink, in commit order, one batch per apply, revert or drop that changes what it
  watches at node, from any cause: a write at node or above it, a revert and the replay
  after it, a merge settling, another module, another device. A query's batch says which
  entities came to match (entered, with their components read), which stopped (left), and
  the read components that changed of those still matching
  since omitted: the first batch is the value, or every match (snapshot = true);
  since = a cursor: the batches after it, or a snapshot if it's older than the log keeps
latest:watch(prefix, since, sink) -> the same for latest, by key prefix
store:children(node, after, limit) -> child nodes, oldest first

{ "cursor": 99120, "snapshot": true, "changed": [ { "e": 790, "c": "tracker", "value": { "minutes": 1290 } } ] }
{ "cursor": 99140, "children": [ 821 ] }
{ "cursor": 99151, "changed": [ { "e": 790, "c": "tracker", "value": { "minutes": 1200 } } ],
  "by": { "revert": 9040, "module": "ren-undo" } }
{ "cursor": 99152, "entered": [ 9 ], "left": [ 8 ],
  "changed": [ { "e": 9, "c": "card", "value": { "name": "Oren", … } } ] }
{ "cursor": 99160, "dropped": true }
```

Watching is a property of the store and latest (host modules), not content, because what changed at a node is the store's own resolution: a write above the node, a revert and the replay after it, a merge. A wrapper would have to repeat that logic and would still miss writers who don't go through it. Assumes: watches are few, about one per open view, so on each apply the store checks the watches at or below the written node that name a written component, and tests a query's watch on each changed entity before and after the change (a read per field the query names). Rules out: a watch per stored row at scale; a live query over 10 billion cards is one watch on its query, whose batches carry only the entities that enter, leave or change. The cursor is the store's commit sequence, the one order every reader shares. Costs: the store keeps a commit log for a window so a reconnect can resume; past it, a snapshot of what is watched, which for a query is a page of its matches and the query again from there. A narrowed store watches only nodes in its scope, its components and its entities.

## Gap 4, watching: a page following a chat, across tabs and reconnects

```lua
-- view.lua (on the page): the values a view shows, kept from the server's batches
return function(c)
  local server, clock = c.server, c.clock   -- server: the exports the root gave this page
  local V = {}

  function V.follow(node, what, draw)       -- draw(values) after each batch; values[e][c]
    local values, cursor = {}, nil
    local sink = {}
    function sink:push(b)
      if cursor and b.cursor <= cursor then return end   -- already applied
      if b.snapshot then values = {} end
      for _, e in ipairs(b.left or {}) do values[e] = nil end
      for _, ch in ipairs(b.changed or {}) do
        values[ch.e] = values[ch.e] or {}
        values[ch.e][ch.c] = ch.value
      end
      cursor = b.cursor
      draw(values)
    end
    function sink:close() end
    return task.spawn(function()                                            -- [core]
      while true do
        local ok, err = pcall(server.watch, server, node, what, cursor, sink)
        if ok then return end
        if err ~= "gone" then error(err, 0) end
        clock:sleep(1000)                   -- the connection dropped; resume from cursor   -- [host]
      end
    end)
  end

  return V
end

tabs A and B show chat 790 at node 820; both follow latest "viewing/790" and the store at 820
t=0      A: action { type = "send", at = 820, text = "…" }
t=180ms  store: node 821 under 820, 821's chat.message (cursor 99140); in the same action
         the root sets latest viewing/790 = 821
         A: the action's reply { at = 821, cursor = 99140 }; the batch 99140 is skipped
         B: { children = { 821 } } on 820, then viewing/790 = 821: B follows 821
t=5s     A: action { type = "view", chat = 790, at = 813 }: a branch switch, no store write
         root: latest viewing/790 = 813; B moves too. With viewing/790/<tab>, only A moves.
t=9s     a module on the server reverts change 9040
         A and B: { 790's tracker = { minutes = 1200 }, by = { revert = 9040 } }
```

A page keeps its state only by applying the server's batches, and the cursor makes a batch that arrives twice (from the action's reply and from the watch) harmless. Several tabs stay in step because each has its own watches on the same keys. The node a page is viewing is state like any other: a page action sets it in latest and whoever watches the key follows. Whether tabs follow each other is which key the root writes (one per chat, or one per tab); that is a UX decision, the owner's. Batching: the core sends everything bound for one host in one scheduler turn as one frame, in order; there is no promise pipelining, so opening a view is one call to a server export that returns what the view needs and starts its watches. Listing swipes is store:children of the message above. What draw puts on screen is the display handle's (the owner's).

## Settings: one cascade along a path

A setting's value is the first statement found along a path of places, most specific first, and the default when none states it. Which places, and in which order, is the first thing the cascade resolves, because the order is itself a setting. The owner called that "the critical part".

**The order is a setting.** The order of the levels is not fixed anywhere. For a setting `x` it is two settings, resolved through this same cascade, statable at any level, for `x` or for every setting under a prefix of its name (`order/generation/` for all generation settings, `order/` for all):

- `order/x`, a list of item ids, closest first. A stated list puts those items first, in that order; an id in it that is not a level (yet) stays in the list and does nothing, so a level an extension adds later takes effect where it was placed; items it leaves out follow the listed ones, in the shipped order.
- `on/x`, a table from item id to true or false, merged field by field: the most specific place that states an id decides it, and an id nobody states is on. An item that is off is skipped when resolving `x`; its place in the order is not touched, so switching it back on puts it exactly where it was, and moving it while it is off moves it there.

Both are statements like any other: kept in history, undone and branched by the store, shown and reset like every value, and overridable at a more specific level ("on this phone, chat-level presets are off" is a device statement of `on/`; "my preset over characters' presets" is a user statement of `order/` for presets). Read together they are the list of `{ id, on }` the user sees. An item is a level, with the walk the level needs at that point: plain, a `follow` along relation kinds (a character's groups; an entry's containers), or an `ancestry` (the pinned bookmarks above). The default order, closest first, is tab, chat, the pinned bookmarks above this point, character (in a group: the speaking character, then the group; a card's own statements are the character level), world, device, user, and then the setting's default, which is not an item: it is the value when no item states one, so it can be neither moved nor switched off. A schema's order is only the setting's default order, and restricts nothing: every setting can be stated and reordered at every level, and no level is switched off by default for any setting. A person switches levels off with `on/` statements ("never let chats change my theme" is an `on/` statement at device or user level). Which order resolves `order/` and `on/` themselves is the next paragraph.

**Resolving `order/` and `on/` themselves.** The owner: "themselves, except if it'd cause a cycle, starting from shipped order?? or shipped order -> recalc until entering/exiting a cycle". Reading `order/` needs an order, and the order is what it states, so the cascade settles it in steps. Step 0 is the shipped order. Each next step reads `order/` and `on/` (the statements for every setting) along the order of the step before and arranges the shipped items by what they state. It stops at the first order that has been seen before, and uses that order: when it repeats the step before it, it is a fixed point; when it repeats an earlier one, the steps loop, and the order used is the one the loop was entered at. Every step is a new order or the last, so the steps are at most the number of distinct orders, which is finite because they arrange the same items. All other `order/…` and `on/…` names, and every setting's own order, are then read along that one order. The explanation lists the steps, and for a loop says it is one and names the orders in it. Worked example below. Cost: a step is one read of `order/` and of `on/` per level on the order; the steps are normally one or two.

Three kinds of chain feed that order in the owner's designs, and here they are one mechanism:

- **Levels of context.** `settings-scopes.md`: the levels and the default order above. `settings-reorganization.md`'s level slider adds a preset level ("default · preset · you · character · chat"), which is a level and an item like the others.
- **Relations.** `world-model.md`: no relation kind is built in or privileged; a value is inherited along the relation kinds its order names. A world's relation kinds are named by its author ("in", "works at", "belongs to", "part of"…), so which kinds a setting follows is data, stated per world. `looks.md` and `worldbuilding.md` resolve a look "theme → world → shared looks → thing, most specific wins"; whether a look also passes along relations is the world's statement of the look's path, and the app ships none (a look applies to exactly what it is set on). A path may follow several kinds, in priority order, and an entry may have several targets for one kind.
- **The message tree.** The Author's Note panel says "Bookmarks inherit the Note from their parent, and can be changed individually after that" (`public/index.html:5832`, upstream's text with checkpoints renamed). The owner: "single author's note feels restrictive", "ANs are the wrong mental model", "idk why we cant have multiple authors note/characters note". So there is no single note: a note is a prompt part (text, a position or depth, a role, an optional condition), the same shape as a constant lorebook entry, and the notes are one setting, "prompt/notes", a table of notes by id merged across the path. A value set at a message holds for everything under it. A bookmark is a position with a mode (`engine/src/store/chat.rs`: FOLLOWING moves to each new message, PINNED stays on its message; `bookmarks_at(view, m)` lists the bookmarks at a message), and the owner's rule is that a setting stated on a bookmark is inherited down the message tree only from PINNED bookmarks on the path to it, not from every message and not from following bookmarks. A position without statements of its own, a following bookmark included, resolves a bookmark-level setting from the nearest pinned bookmarks above it.

```json
{ "order": [
    { "id": "tab",       "level": "tab" },
    { "id": "chat",      "level": "chat" },
    { "id": "bookmarks", "level": "bookmark",  "ancestry": { "start": "at", "filter": "pinned" } },
    { "id": "character", "level": "character", "follow": { "kinds": [ "member of" ] } },
    { "id": "world",     "level": "world" },
    { "id": "device",    "level": "device" },
    { "id": "user",      "level": "user" } ],
  "levels": {
    "tab":       { "kept": "store",  "node": "tab",    "entity": "tab" },
    "chat":      { "kept": "store",  "node": "at",     "entity": "chat" },
    "bookmark":  { "kept": "store",  "node": "chat",   "of": "bookmark",  "entity": "id" },
    "character": [ { "kept": "store", "node": "home",  "of": "character", "entity": "id" },
                   { "given": "card_settings", "name": "card" } ],
    "world":     { "kept": "world",  "node": "home",   "of": "world",     "entity": "id" },
    "device":    { "kept": "store",  "node": "device", "entity": "device" },
    "user":      { "kept": "store",  "node": "home",   "entity": "home" },
    "declared":  { "given": "declared" },
    "entry":     { "kept": "world",  "node": "home",   "of": "entry",     "entity": "id" },
    "theme":     { "kept": "store",  "node": "home",   "of": "theme",     "entity": "id" } },
  "schemas": {
    "generation/preset": { "default": "Default" },
    "looks/text_size":  { "default": 16 },
    "look/name":        { "default": { "color": "#dddddd" }, "combine": "merge",
                          "order": [ { "id": "entry", "level": "entry", "follow": { "kinds": [] } }, { "id": "theme", "level": "theme" } ] },
    "tags":             { "default": [], "combine": "union",
                          "order": [ { "id": "entry", "level": "entry", "follow": { "kinds": [] } }, "world" ] },
    "prompt/notes":     { "default": {}, "combine": "merge",
                          "order": [ "tab", { "id": "own-bookmark", "level": "bookmark", "follow": { "kinds": [] } }, "chat",
                                     "bookmarks", "character", "user" ] },
    "order/":           { },
    "on/":              { "default": {}, "combine": "merge" },
    "compose":          { "combine": "rules",
                          "order": [ "tab", "chat", "bookmarks", "character", "world", "device", "user", { "id": "declared", "level": "declared" } ] } } }
```

```
An item of an order is { id, level, follow?, ancestry? }; the id names it in "order/x" and
  "on/x", and the level says where its statements are. The shipped "order" above is the
  default for every setting; a schema's own "order" is that setting's default order (a string
  is the id of a shipped item, a table is an item of its own); the shipped items it leaves out
  follow in the shipped order.
A level is data: where its statements are kept, and what of the context names its place.
  A filter is data too: { "pinned": ["=", "bookmark", "mode", "pinned"] } is a query over a
  bookmark's own component, declared in the app's piece; the store keeps one index per
  declared filter.
  A level is one source, or a list of them, nearest first: "character" is the character's
  statements kept in the store, then the card's own (the card is not a level of its own).
  kept    a reference the root hands settings.lua by that name: "store" or "world", both the
          version store, so every level has history and branches
  node    the context field naming the store node to read at; a tab and a device each have a
          node of their own
  of      the context field naming the level's subject (the speaking character, an entry, a
          world, a bookmark, a theme): "id" while that level is read, and what a "follow" or
          "ancestry" walks over
  entity  the context field naming the entity whose "settings" component holds the level's
          statements, one field per setting name ("order/…" and "on/…" are names like any
          other); a level whose node or entity the context lacks isn't on the path (no chat
          open: no chat level). The person's statements are on the library node's own entity
  given   a table the context carries (what the card ships, what transforms declare); it
          belongs to the context's own subject, so a follow reads it at its start only
  name    what the source is called in "from" reports (default: the level)
A schema, which the module that owns the settings ships (the "setting schema" row at the end):
  order   the setting's default order of items; absent: the shipped order. It restricts
          nothing: shipped items it omits follow, in the shipped order.
          What an item walks is the item's own:
            plain                           that level's place
            "follow": { kinds, start?, most? }  the place of the level's subject (start: the
                                             context field, default the level's "of"), then,
                                             depth first, of each target of each of kinds
                                             (a list of relation kinds, in priority order;
                                             an entry's targets of a kind are the field of
                                             that name in its "relations" component, in that
                                             relation's own order), at most most steps away.
                                             A kind is whatever the world calls it; none is
                                             special, and [] follows nothing: the start only.
                                             Cycles stop at the repeat; an entry reached two
                                             ways is one place, at its first position.
                                             Two items of one level are two priority tiers,
                                             each walked in full before the next
            "ancestry": { start, filter }   the places of the bookmarks matching the named
                                             filter on the context's start message and on
                                             each message above it, nearest first (several
                                             on one message, in the bookmark index's order);
                                             the store answers it from an index declared
                                             for that filter, below
          The order a setting resolves along is the settings "order/<name>" and "on/<name>",
          or those of "<a prefix of name>/", or "order/" and "on/", stated along the order of
          orders (below); the schema's order is the default. No level is barred from any
          setting: which levels a setting uses is only what is stated and switched off, so
          settings-scopes has no table of levels per kind. Which relation kinds a setting
          follows is data, and a world states it at its own level (as an item with a follow).
  combine how the statements found along the order become the value, a property of the
          setting:
            "first" (the default)  the first place that states it
            "merge"   statements are tables; each field comes from the first place that
                      states that field, and the source is kept per field
            "union"   statements are lists; the places' lists in path order, each value once
            { "fn": name }  a pure function the content provides (like an op) of the list
                      of { value, level } and the default; it returns the value
            "rules"   every place's list of rules, most specific first, for the module that
                      reads them to apply
  default the value when no place states it (under merge and union, the last place).
A statement is a value, or { "$rules": [ { "when": a condition, "value": v }, ... ] }: the
  first rule whose condition holds against the context states v; if none holds, this
  place states nothing and the path goes on. One kind of condition, cond.lua's, with
  context_cond.lua's operators and any a module adds.
The tree comes from the store: a statement at node 800 is a change at 800, so reading at
  any node below sees it, and a statement lower down shadows it from there on. A branch
  from above 800 doesn't see it. Undo and branching are the store's.
Writes: settings.state(level, name, statement, ctx, field?) at the level's place: a change
  of the field name of the subject's "settings" component; a level that is not defined, or
  whose place the context can't name, is refused. nil takes a statement back. With field,
  the change names the path { name, field }, so a node's table of notes keeps the others,
  and a revert restores that one note.
```

```lua
-- context_cond.lua: what a rule can test about where it's asked, as cond.lua operators
return function(c)
  local cond, q = c.cond, c.query           -- a cond of its own; modules add operators the same way
  cond.define("card", function(x, name) return x.card ~= nil and q.holds(x.at, x.card, { "=", "card", "name", name }) end)
  cond.define("card-tag", function(x, tag) return x.card ~= nil and q.holds(x.at, x.card, { "to", "tags", tag }) end)
  cond.define("persona", function(x, name) return x.persona == name end)
  cond.define("world", function(x, world) return x.world == world end)
  cond.define("device", function(x, device) return x.device == device end)
  -- note conditions: x.note is the note, x.depth the position's depth, x.source the id of
  -- the place its statement was found at, x.nearest_pin the nearest pinned bookmark's
  cond.define("since", function(x, n) return x.depth - x.note.set < n end)
  cond.define("until", function(x, n) return x.depth <= n end)
  cond.define("every", function(x, n) return (x.depth - x.note.set) % n == 0 end)
  cond.define("until-next-pin", function(x) return x.source == x.nearest_pin end)
  cond.define("state", function(x, comp, field, v) return q.holds(x.at, x.chat, { "=", comp, field, v }) end)
  return cond
end

-- settings.lua: a setting's value, from the statements along its order of levels, most specific first
return function(c)
  local cond, kv, kept, levels, schema_of = c.cond, c.kv, c.kept, c.levels, c.schema   -- schema_of(name): a schema, or nil
  local default_order = c.order             -- the shipped order: a list of items { id, level, follow?, ancestry? }
  local combiners = c.combiners or {}       -- name -> pure function(list, default) -> value
  local ancestry = c.ancestry               -- (filter, message) -> { bookmark ids, nearest first }   [host]
  local S = {}

  local function reader(spec, ctx)          -- read(name, component?) at this source's place, or nil if ctx can't name it
    if spec.given then
      local t = ctx[spec.given]
      return t and function(name, component) if component == nil then return t[name] end end
    end
    local ref, node, e = kept[spec.kept], ctx[spec.node], ctx[spec.entity]
    if node == nil or e == nil then return nil end
    return function(name, component) return ref:get(node, e, component or "settings", name) end   -- [host]
  end

  local function sources(level)             -- a level is one source, or a list of them, nearest first; none for a level not defined
    local spec = levels[level]
    if not spec then return {} end
    return spec[1] and spec or { spec }
  end

  local function index(items)
    local by_id = {}
    for _, it in ipairs(items) do by_id[it.id] = it end
    return by_id
  end

  local function expand(list, known)        -- a string is the id of an item in known, or of none yet; a table is an item
    local out, seen = {}, {}
    for _, e in ipairs(list or {}) do
      local it = type(e) == "table" and e or known[e] or { id = e }   -- an unknown id stays in the list and does nothing
      if not seen[it.id] then seen[it.id] = true; out[#out + 1] = it end
    end
    return out, seen
  end

  local function schema(name)               -- the schema for name, or for the longest prefix of it ending in "/"
    local p = name
    while true do
      local s = schema_of(p)
      if s then return s end
      local up = p:match("^(.*/)[^/]+/?$")
      if not up then error("no schema for " .. name, 0) end
      p = up
    end
  end

  local function default_of(s)              -- the schema's own order, then the shipped items it leaves out, in the shipped order
    local items, seen = expand(s.order, index(default_order))
    for _, it in ipairs(default_order) do if not seen[it.id] then items[#items + 1] = it end end
    return items
  end

  local function places(items, ctx)         -- { { name, read } }, most specific first
    local out, emitted = {}, {}
    local function place(item, id, first)   -- the level's places for id, each once, at its first position
      local frame = setmetatable({ id = id }, { __index = ctx })
      local reads = {}
      for _, src in ipairs(sources(item.level)) do
        local name = (src.name or item.level) .. (id and (" " .. id) or "")
        local read = (first or not src.given) and reader(src, frame)
        if read then
          if not emitted[name] then
            emitted[name] = true
            out[#out + 1] = { name = name, read = read }
          end
          reads[#reads + 1] = read
        end
      end
      return reads[1]
    end
    for _, item in ipairs(items) do
      local srcs = sources(item.level)
      if #srcs > 0 then
        local of = srcs[1].of
        local f, a = item.follow, item.ancestry
        if f then
          local seen = {}
          local function visit(id, depth)
            if seen[id] and (not f.most or seen[id] <= depth) then return end   -- a repeat, or no nearer than before
            seen[id] = depth
            local read = place(item, id, depth == 0)
            if not read or (f.most and depth >= f.most) then return end
            for _, kind in ipairs(f.kinds) do
              for _, next_id in ipairs(read(kind, "relations") or {}) do visit(next_id, depth + 1) end
            end
          end
          local start = ctx[f.start or of]
          if start ~= nil then visit(start, 0) end
        elseif a then
          if ctx[a.start] ~= nil then
            for _, id in ipairs(ancestry(a.filter, ctx[a.start])) do place(item, id) end
          end
        else
          place(item, of and ctx[of], true)
        end
      end
    end
    return out
  end

  local function stated(s, ctx)             -- whether s states something here, what, and by which rule
    if type(s) == "table" and s["$rules"] then
      for i, r in ipairs(s["$rules"]) do
        if cond.holds(r.when, ctx) then return true, r.value, i end
      end
      return false
    end
    return s ~= nil, s
  end

  local function prefixes(name)             -- name, then each prefix of it ending in "/", down to ""
    local p = name
    return function()
      if p == nil then return nil end
      local this = p
      p = this ~= "" and (this:match("^(.*/)[^/]+/?$") or "") or nil
      return this
    end
  end

  local function has(list, x)
    for _, v in ipairs(list) do if v == x then return true end end
    return false
  end

  local function resolve(name, s, ctx, items)   -- the value, and where it came from, along these items
    local ps = places(items, ctx)
    local how = s.combine or "first"
    if how == "rules" then
      local rules = {}
      for _, p in ipairs(ps) do
        for i, r in ipairs(p.read(name) or {}) do rules[#rules + 1] = { rule = r, level = p.name, index = i } end
      end
      return rules
    end
    local found = {}
    for _, p in ipairs(ps) do
      local yes, v, i = stated(p.read(name), ctx)
      if yes then
        found[#found + 1] = { value = v, level = p.name, rule = i }
        if how == "first" then break end
      end
    end
    if how == "first" then
      local f = found[1]
      if f then return f.value, { level = f.level, rule = f.rule } end
      return s.default, { level = "default" }
    elseif how == "merge" then              -- { level = per field }
      local out, from = {}, {}
      for _, f in ipairs(found) do
        for k, v in pairs(f.value) do if out[k] == nil then out[k], from[k] = v, f.level end end
      end
      for k, v in pairs(s.default or {}) do if out[k] == nil then out[k], from[k] = v, "default" end end
      return out, { level = from }
    elseif how == "union" then              -- { level = per value, parallel to the list }
      local out, from = {}, {}
      for _, f in ipairs(found) do
        for _, v in ipairs(f.value) do
          if not has(out, v) then out[#out + 1], from[#from + 1] = v, f.level end
        end
      end
      for _, v in ipairs(s.default or {}) do
        if not has(out, v) then out[#out + 1], from[#from + 1] = v, "default" end
      end
      return out, { level = from }
    end
    local fn = combiners[how.fn] or error("no combiner " .. tostring(how.fn), 0)
    return fn(found, s.default), { levels = found }
  end

  local function arrange(base, listed, off)     -- the listed items first, the rest of base after them in base's order; { item, on } each
    local items = base
    if listed ~= nil then
      local seen
      items, seen = expand(listed, index(base))
      for _, it in ipairs(base) do if not seen[it.id] then items[#items + 1] = it end end
    end
    local out = {}
    for _, it in ipairs(items) do out[#out + 1] = { item = it, on = not off[it.id] } end
    return out
  end

  local function walk(order)                -- the items that are on
    local out = {}
    for _, o in ipairs(order) do if o.on then out[#out + 1] = o.item end end
    return out
  end

  local function stated_order(name, ctx, along)   -- the list and the toggles stated for name or a prefix of it, read along `along`
    local listed, off = nil, {}
    for p in prefixes(name) do
      if listed == nil then listed = resolve("order/" .. p, schema("order/" .. p), ctx, along) end
      for id, on in pairs(resolve("on/" .. p, schema("on/" .. p), ctx, along)) do
        if off[id] == nil then off[id] = (on == false) end        -- the most specific name states each id
      end
    end
    return listed, off
  end

  local function key(order)
    local k = {}
    for _, o in ipairs(order) do k[#k + 1] = o.item.id .. (o.on and "" or "-") end
    return table.concat(k, ",")
  end

  -- The order that "order/" and "on/" themselves resolve along. Reading them needs an order, and
  -- the order is what they state: start from the shipped order, read them along it, read them
  -- again along the result, and stop at the first order seen twice. That order is a fixed point
  -- when it repeats its predecessor, and the entry into a cycle otherwise. Each step is a new
  -- order or the last one, so the steps are at most the number of distinct orders.
  local function order_of_orders(ctx)
    local base = default_order
    local current = arrange(base, nil, {})
    local steps, seen = { current }, { [key(current)] = 1 }
    while true do
      local listed, off = stated_order("", ctx, walk(current))
      local nxt = arrange(base, listed, off)
      local at = seen[key(nxt)]
      if at then
        return steps[at], { steps = steps, kind = at == #steps and "fixed" or "cycle", back_to = at }
      end
      steps[#steps + 1] = nxt
      seen[key(nxt)] = #steps
      current = nxt
    end
  end

  local function is_order_name(name) return name:find("^order/") or name:find("^on/") end

  local function ordered(name, s, ctx)      -- every item, in the order the cascade states, with whether it is on
    local along = order_of_orders(ctx)
    if is_order_name(name) then return along end
    local listed, off = stated_order(name, ctx, walk(along))
    return arrange(default_of(s), listed, off)
  end

  function S.order(name, ctx)               -- the order of levels that applies to name: { { id, on, unknown? } }
    local out = {}
    for _, o in ipairs(ordered(name, schema(name), ctx)) do
      out[#out + 1] = { id = o.item.id, on = o.on, unknown = #sources(o.item.level) == 0 or nil }
    end
    return out
  end

  function S.order_of_orders(ctx)           -- the order for "order/" and "on/", and how it was reached: { steps, kind, back_to }
    local along, why = order_of_orders(ctx)
    local out = {}
    for _, o in ipairs(along) do out[#out + 1] = { id = o.item.id, on = o.on } end
    return out, why
  end

  function S.get(name, ctx)                 -- the value, and where it came from
    local s = schema(name)
    return resolve(name, s, ctx, walk(ordered(name, s, ctx)))
  end

  function S.state(level, name, statement, ctx, field)   -- field: set only that field of the table already there
    local spec
    for _, src in ipairs(sources(level)) do if src.kept then spec = src; break end end
    local frame = setmetatable({ id = spec and spec.of and ctx[spec.of] }, { __index = ctx })
    local node, e = spec and frame[spec.node], spec and frame[spec.entity]
    if node == nil or e == nil then error(name .. " can't be stated at " .. level .. " here", 0) end
    kept[spec.kept]:apply(node, { { e, "settings", kv.set, statement,                -- [host]
                                    field = field == nil and name or { name, field } } })
  end

  function S.narrow(prefix)                 -- the same, for names under prefix only
    return { get = function(name, ctx) return S.get(prefix .. name, ctx) end,
             state = function(level, name, statement, ctx) return S.state(level, prefix .. name, statement, ctx) end }
  end

  return S
end
```

```
levels of context: looks/text_size, which states no order, so every shipped item applies
t=0      laptop: action { type = "state", level = "user", name = "looks/text_size", value = 15 }
         store: the person's settings, field looks/text_size = 15, at home; every device reads 15
t=1m     phone (device 3f0c…): the same at level "device", 17: the device's settings, field
         looks/text_size, at the device's node in the store; the phone's tabs read 17 (from "device"), the
         laptop still 15
t=2m     phone, tab 9a71…: level "tab", 20, at the tab's node; that tab reads 20 (from
         "tab"), the phone's other tabs 17. Undoing it at the tab's node brings 17 back
t=3m     the chat states 18 (level "chat"): no kind of setting is limited to some levels, so
         it is accepted. The phone's other tabs read 18 (the chat outranks the device), tab
         9a71 still 20, the laptop 18
t=4m     phone: level "device", name "on/looks/", field "chat", value false ("never let chats
         change my text size", for everything under looks/). The phone's other tabs read 17
         again; the laptop, which states no on/, reads 18. This is a statement the person
         made, in history and undoable, not a rule about reader settings. Run under LuaJIT.

the order: generation/preset, whose schema states no order of its own, so every shipped
         item applies. user states "Balanced", chat "Chat-X", character mira "Mira-tuned"; the
         phone is device 3f0c…, no world is open. S.order(name, ctx) is the list of
         { id, on } and S.get the value; the lines below are the output of the Lua above run
         under LuaJIT, the statements as the calls that wrote them:
t0       nothing stated about the order
           chat                   Chat-X (from chat)
           [tab, chat, bookmarks, character, world, device, user]
t1       phone: S.state("device", "on/generation/preset", false, ctx, "chat")
           the statement is { "chat": false } at the device's node, a change in history
           Mira-tuned (from character mira)
           [tab, chat (off), bookmarks, character, world, device, user]
t2       phone: S.state("device", "order/generation/preset",
             ["tab","user","chat","bookmarks","character","world","device"], ctx)
           user moves in front of chat; chat is still off, and still where the list puts it
           Balanced (from user)
           [tab, user, chat (off), bookmarks, character, world, device]
t3       phone: S.state("device", "on/generation/preset", true, ctx, "chat")
           chat is on again, at the position it had at t2, not at the end and not at its
           shipped place; user still outranks it
           Balanced (from user)
           [tab, user, chat, bookmarks, character, world, device]
t4       phone: S.state("device", "order/generation/preset", nil, ctx), taking the order back
           chat is on and back at its shipped place
           Chat-X (from chat)
           [tab, chat, bookmarks, character, world, device, user]
t5       phone: S.state("device", "order/generation/preset", ["scene","chat","user"], ctx)
           "scene" is not a level yet: it stays in the list, does nothing, and the levels the
           list leaves out follow the listed ones in the shipped order
           Chat-X (from chat)
           [scene (unknown), chat, user, tab, bookmarks, character, world, device]
t6       an extension adds the level "scene" (statements on the scene's entity) and the item
           { id = "scene", level = "scene" } to the shipped order, placed second, after tab; scene
           "harbor" is open and states "Harbor-tuned". The statement of t5 was not touched
           Harbor-tuned (from scene harbor)
           [scene, chat, user, tab, bookmarks, character, world, device]
         with no scene open the same list reads Chat-X (from chat): the scene level has no place
t7       phone: S.state("device", "order/generation/preset", nil, ctx)
           scene is where the extension put it in the shipped order
           Harbor-tuned (from scene harbor)
           [tab, scene, chat, bookmarks, character, world, device, user]

the order of the orders: one chat (790), open on two devices. The statements of "order/":
           chat 790:        ["device", "chat"]
           phone  (3f0c…):  ["device", "user"]
           tablet (b2e8…):  ["chat", "device"]
         S.order_of_orders(ctx) gives the order used and the steps (output under LuaJIT):
         phone, a fixed point after two steps
           step 0   [tab, chat, bookmarks, character, world, device, user]   the shipped order
                    chat is ahead of device, so the chat's list is read
           step 1   [device, chat, tab, bookmarks, character, world, user]
                    device is ahead now, so the phone's own list is read
           step 2   [device, user, tab, chat, bookmarks, character, world]
                    the phone's list again: step 3 would equal step 2. Fixed point; used: step 2
         tablet, a cycle
           step 0   the shipped order; the chat's list is read
           step 1   [device, chat, tab, bookmarks, character, world, user]
                    device is ahead, so the tablet's list is read
           step 2   [chat, device, tab, bookmarks, character, world, user]
                    chat is ahead again, so the chat's list is read: step 3 would equal step 1.
                    A cycle (step 1 -> step 2 -> step 1), stopped at the first repeat;
                    used: step 1, where the loop was entered
         The explanation shows these steps, and for the tablet says that its order of orders
         is a cycle and names the two orders in it. The effect: the chat states
         order/generation/preset ["chat","user"] and the user ["user","chat"], "Balanced" at
         user and "Chat-X" at chat. The phone reads the user's list first (user is ahead of
         chat in its order of orders): [user, chat, …], Balanced (from user). The tablet reads
         the chat's: [chat, user, …], Chat-X (from chat).

relations: look/name, merged; which relations it follows is each world's own statement
         The app ships order look/name = follow nothing, then theme: a look applies to exactly
         what it is set on. A world opts in by stating order/look/ at its world level; no
         relation kind is named anywhere in the app.
         world vell, whose author calls its relations "in" and "belongs to":
           aldric: in [ house-vell ]; belongs to [ pale-choir ]; states nothing
           house-vell: in [ vell ]; states { color = #77aa33 }
           pale-choir: in [ vell ]; states { color = #aa3355, italic = true }
           vell: states { color = #3355aa, font = serif }
           world level, order/look/ (the first two are items of the world's own, the third
             the shipped "theme"):
             [ { "id": "in", "level": "entry", "follow": { "kinds": ["in"] } },
               { "id": "belongs to", "level": "entry", "follow": { "kinds": ["belongs to"] } },
               "theme" ]
         places for aldric: entry aldric, house-vell, vell (the "in" chain), then pale-choir
           (aldric is already a place; its "belongs to" is still followed), then theme
         look/name = { color #77aa33 (entry house-vell), font serif (entry vell), italic
           true (entry pale-choir) }; the "belongs to" item first would make the color
           #aa3355; one item with kinds ["in","belongs to"] visits house-vell, vell, then
           pale-choir. Run under LuaJIT, this reads #77aa33, serif, italic true
         world coast, whose author calls the relation "part of": mira: part of [ reef ] and
           in [ harbor ]; reef states { color = #2288aa }; harbor states { color = #aa2222 };
           order/look/: [ { "id": "part of", "level": "entry", "follow": { "kinds": ["part of"] } }, "theme" ]
           mira reads #2288aa from "entry reef"; "in" means nothing here and harbor is ignored
         world tide states no order: mira reads only its own look and the theme's, then the
           default { color = #dddddd }
         tags (union): aldric's list, then house-vell's, vell's and pale-choir's, each tag once

notes: prompt/notes, merged by note id; order tab, the bookmark's own, chat, the pinned
         bookmarks above, character (the card included), user. A note is { text, depth or position, role,
         set (the depth it was stated at), when? }, a prompt part; notes from every place
         apply together, and one id stated nearer replaces that id alone. false switches an
         id off. A bookmark's statements are kept by the bookmark under the chat's node, so
         they stay with it when it moves. The chat level outranks the pinned ones because the
         order says so; the order is data.
         chat 790: positions 40 … 60 … 70 … 85 … 120 on the main line (a position is its depth
         in the chat's path, which the store knows); 62 under 60 and 105 under 100 are branches
t=0      P1, pinned at 40, states { scene = { text "The Drowned Coast, night.", depth 4, set 40 },
         tone = { text "Keep it light.", depth 2, set 40 } } (level "bookmark", id P1)
         F, a following bookmark at 85, states nothing; the pinned bookmarks at or above 85
         are P1: scene and tone, both from "bookmark P1". Position 62, on the branch from 60,
         reads the same: 40 is above it
t=1m     P2, pinned at 70, states { tone = { text "Ilse is tired now.", depth 2, set 70 } }
         F at 85: scene from "bookmark P1", tone from "bookmark P2" (nearest). 62 still reads
         P1's tone: 70 isn't above it
t=2m     way 1, a statement at a later message: at 120 the chat level states { scene = false },
         a change whose op sets that one id in the table the node already has (the store's
         ops run on the current value). Positions 40 to 119 get scene; 120 and everything
         under it do not, and tone from P2 still applies. A branch from 100 (105) still gets
         scene: it isn't under 120. Reverting the change at 120 brings scene back
t=3m     way 2, a condition on the note, a cond.lua condition over the note and the context:
         { tone … when ["since", 20] }    applies while depth - set < 20: at 85 (15 after 70)
                                          yes, at 95 (25) no; set is in the note and depth
                                          is the store's, so no message is read
         { … when ["until", 150] }        while depth <= 150
         { … when ["state", "scene", "active", true] }  while that field of the chat's "scene",
                                          which a tracker or the
                                          model writes, holds true at this position (one read)
         { … when ["until-next-pin"] }    while the note's source is the nearest pinned
                                          bookmark: scene so marked at P1 stops at 70, where
                                          P2 is nearest
         { … when ["every", 3] }          the old interval: when (depth - set) % 3 == 0
         A note whose condition fails doesn't apply and its id stays taken: a lower place's
         note of that id doesn't show through. Character and card notes are the same notes
         stated at those levels (the character's note is a note stated at the character
         level); nothing is a separate feature
t=4m     P2 is unpinned: the index drops it; 85 reads P1's tone again. P2's statements are
         still kept under P2, and read again if it is pinned again
a rule:  level "user": { "$rules": [ { "when": ["card-tag", "npc"],
           "value": { terse = { text = "Stay terse.", depth = 1 } } } ] }
         with a card tagged npc: the notes gain terse (user, rule 1); with any other card the
         user level states nothing
```

The ancestry lookup, [host] in the store, because only the store knows which messages are above which:

```
store:ancestry(filter, at) -> { bookmark ids at `at` and above it matching the filter, nearest first }

Kept per declared filter, only for the bookmarks that match, never per message:
  FILTER_AT (filter, m, b)       the bookmarks matching at message m (bookmarks_at, filtered)
  FILTER_UP (filter, m)          for a message that has one: the nearest message above it
                                 that has one too, or none
  FILTER_KIDS (filter, m, k)     the messages whose FILTER_UP is m; (filter, none, k) the tops
A lookup starts at the tops, and each step goes to the one message that is above `at`
  (the store's ancestry check, jump pointers, about log depth steps), then to its FILTER_KIDS;
  it ends when none is. Pinning or unpinning at message x re-points only the matching
  messages whose nearest was x's: no message in between is written. A following bookmark's
  move writes nothing here (it does not match); a pinned bookmark's move is an unpin and a pin.
Cost: a lookup is at most (matching messages tried) × log depth; a chat with no match costs
  one read; nothing is per message, per row or per card. How many matching messages share one
  parent in real chats I don't know; if it is large, a count of matches per subtree would be
  needed and the lookup would binary-search the jump pointers instead.
Necessary: the store alone holds the ancestry. It is a declared index of the store's
  ("Indexes under branching") of a kind of its own: over a field holding a message node
  ("at"), answering for the messages above a node. Assumes: the filter is a query over the
  bookmark's own component. Rules out: a filter on the message's text or on another bookmark.
  So: a filter is declared data, and the store keeps one index per filter.
```

The examples above were run again under LuaJIT on a store of entities that folds every path, each level's statements a field of its subject's "settings" component and each relation kind a field of an entry's "relations", with the same results as stated (entities are written by name, mira, house-vell, for reading). Every setting resolves this way, so a setting's levels, their order, the relation kinds it follows, how statements combine and where each level is kept are data: settings-scopes has no table of levels per kind, its "the order is a setting" is "order/<name>" with "on/<name>", and its levels are the levels list, which content can add to (a preset level, settings-reorganization's, is a level whose prefix names the preset the context carries and an item in the order; settings-scopes' group, after the speaking character, is the follow of "member of" on the character item). Every level is kept in the version store, a tab's and a device's under nodes of their own, so every statement at every level branches and undoes the same way; latest holds caches, progress, sessions and drafts, never a setting. Costs: a resolve is one read per place on its order (a follow, one per entry it passes and kind it follows), plus the reads of "order/" and "on/" for the name and each prefix of it, themselves resolved along the order of orders (a few steps, each one read of "order/" and "on/" per level); that is a constant number of reads per setting, never per card; a "rules" setting is one read per level; no setting costs anything per card, chat or row. Nothing here is a host module or a primitive, so both tests are only the assumptions:

```
settings.lua, context_cond.lua: content.
Necessary: none of it.

Assumes: a fixed set of levels (tab, chat, bookmarks, character, world, device, user, default).
  Rules out: a level someone needs that isn't on the list: a preset, a group, a world
  entry's container, a session.
  So: levels are data: where each is kept and what of the context names its place.
Assumes: one order of levels for every setting.
  Rules out: settings-scopes' "my preset over characters' presets", or a world whose looks
  pass along its relations next to one whose looks don't.
  So: the order is itself a setting ("order/<name>"), statable at any level and per
  setting, and each level in it can be switched off ("on/<name>") with its place kept.
Assumes: which levels a kind of setting may use is fixed by its kind (reader settings at tab, device
  and user only, as settings-scopes once tabulated).
  Rules out: a theme per chat or per character, as backgrounds already are, and a person who
  wants it; the owner: "what's per what: incorrect mental model".
  So: no level is barred from any setting; a person switches levels off with on/ statements.
Assumes: a level is either always consulted or never.
  Rules out: "on this phone, chat-level presets are off" without losing where chat sits.
  So: on/ is a statement apart from order/: a toggle never edits the list.
Assumes: one relation kind is the one a value is inherited along.
  Rules out: a world that names it differently, or inherits along several kinds, or none.
  So: an item names the relation kinds it follows, as data a world states.
Assumes: the first place that states a value decides it.
  Rules out: a look assembled from parts set at different entries, a list of tags from all
  of them.
  So: the setting's schema says how statements combine: first, merge, union or a pure
  function.
Assumes: inheritance down the message tree is copying the parent's value.
  Rules out: a change at a bookmark reaching what's already under it, and undo of it.
  So: a statement is a change at a node, and the store's resolution is the inheritance.
Assumes: a statement is a value.
  Rules out: "off for cards tagged no-tracker" without a level per tag.
  So: a statement can be first-match rules over the context.

Still restrictive:
  a filter reads only a bookmark's own fields (above);
  every level has history, so a tab's and a device's statements are at nodes of their own
  in the store; what keeps those nodes from piling up for every tab ever opened is not
  designed here;
  the order of orders is reached by steps from the shipped order, so a loop of orders is
  cut at its first repeat, and which order that is depends on the shipped order the steps
  start from; the explanation says so;
  the order is data, and which level outranks which is only the order of that list;
  an id in a stated "order/" that is no level stays in the list and does nothing, and the
  levels it omits follow the listed ones in the shipped order: no refusal, no warning,
  though a misspelt level silently does nothing;
  "member of", the relation a character has to its groups, is only named here: how the
  groups feature keeps membership is not designed here;
  a "follow" that loops (an entry in itself, through others) stops at the repeat, with
  no error, and an entry reached two ways is one place at its first position.
```

## Gap 5, joining: what every option shares

Decided: what the person installs applies to every chat, and a card can bring its own (decisions of 11-14). Hooks are not in the core. Three options, A, B and C, were drafted for how the two join a card's turn, and the owner chose a fourth, D, of which each is a special case; A, B and C stay as the record of what each gave up. This section is what they have in common, and the same example runs through all four: the person installs a tracker that adds a step after each reply, a note in the prompt two messages from the end, a button on messages and a settings section; the card Ilse brings its own lorebook activation library.

```
The manifest: needs, as in "Capabilities from crescent: needs in a manifest"; a dependency is
  a need on another install's exports; "after": [ installs ] orders this one after those
  where both add to the same place (an install that isn't there is skipped; a cycle refuses
  to load and names it); what it adds to the turn is the part the options differ on.
UI slots: named contracts. A contribution is data in the manifest; the app's page module
  reads the manifests of what is installed and the display handle draws it (the owner's):
    message.actions  { label, export }      pressed: one page action { type = "run",
                     install, export, at }; the reply carries the state it changed
    settings         { label, settings, fields }  an editor over the module's own settings
                     (the names under settings, resolved and stated through the cascade)
    commands         { name, export, args }   run from a page action, offered to the model
                     as a tool, or put in a step
  The root runs only exports a slot names. Which slots exist, and where each is drawn,
  are the owner's. Declared as data, a slot's contributions are known before any
  extension code runs, so the page can lay them out with nothing moving afterwards.
A card brings modules in its package, each with its own needs, reviewed when the card is
  imported, with decisions kept by package hash (gap 7).
Values crossing a reference are copied, so a step from another module returns the fields
  it sets on the turn's context instead of writing into it.
```

```json
"slots": {
  "message.actions": [ { "label": "Recount time and affection", "export": "recount" } ],
  "settings": { "label": "Tracker", "settings": "tracker/settings/", "fields": {
      "note":  { "type": "boolean", "default": true, "label": "Tell the model the time and affection" },
      "depth": { "type": "number",  "default": 2,    "label": "Messages from the end where that goes" } } },
  "commands": [ { "name": "recount", "export": "recount", "args": [ "message" ] } ] }
```

```lua
-- order.lua: install names in an order that keeps every "after"; ties by name
return function()
  return function(installs)                 -- installs[name] = its manifest
    local names, out, state = {}, {}, {}
    for name in pairs(installs) do names[#names + 1] = name end
    table.sort(names)
    local function visit(name, path)
      if state[name] == "done" then return end
      if state[name] == "on" then error("these installs each wait for the other: " .. path, 0) end
      state[name] = "on"
      for _, before in ipairs(installs[name].after or {}) do
        if installs[before] then visit(before, path .. " -> " .. before) end
      end
      state[name] = "done"
      out[#out + 1] = name
    end
    for _, name in ipairs(names) do visit(name, name) end
    return out
  end
end

-- tracker.lua, as the person installs it: its needs are its manifest's (from crescent, below), plus prompt
return function(c)
  local store, chats, cards, settings, model, kv = c.store, c.chats, c.cards, c.settings, c.model, c.kv
  local T = {}

  local function judge(text)
    return model.generate_json({
      { role = "system", content = [[Reply with JSON: {"minutes_passed": n, "affection_change": n}]] },
      { role = "user", content = text },
    })
  end

  local function changes(at, chat, who, r, last)   -- last: what this reply added before, on a recount
    last = last or { 0, 0 }
    return {
      { chat, "tracker", kv.add, r.minutes_passed - last[1], field = "minutes" },
      { who, "tracker", kv.add_within, { r.affection_change - last[2], 0, 100 }, field = "affection" },
      { at, "tracker", kv.set, { r.minutes_passed, r.affection_change }, field = "last" },
    }
  end

  function T.step(ctx)                      -- after the reply is stored at ctx.at
    store:apply(ctx.at, changes(ctx.at, ctx.chat, ctx.speaker, judge(ctx.reply)))   -- [host]
  end

  function T.recount(at, chat)              -- the message button: that reply judged again
    local msg = chats:get(at, at, "chat.message")                             -- [host]
    store:apply(at, changes(at, chat, msg.speaker, judge(msg.text),
                            store:get(at, at, "tracker", "last")))            -- [host]
  end

  function T.note(ctx)                      -- the prompt's note, or nil
    if settings:get("tracker/settings/note") == false then return nil end     -- [host]
    local m = store:get(ctx.at, ctx.chat, "tracker", "minutes") or 0          -- [host]
    local a = store:get(ctx.at, ctx.speaker, "tracker", "affection") or 0     -- [host]
    local who = cards:get(ctx.at, ctx.speaker, "card").name                   -- [host]
    return { depth = settings:get("tracker/settings/depth") or 2, role = "system",       -- [host]
             text = string.format("[It is %02d:%02d. %s's affection is %d of 100.]",
                                  math.floor(m / 60) % 24, m % 60, who, a) }
  end

  return T
end

-- prompt.lua gains: notes put a number of messages from the end
function M.at_depth(messages, notes)        -- notes = { { depth, role, text }, ... }; 0 is after the last
  local out = {}
  for i, m in ipairs(messages) do out[i] = m end
  for _, n in ipairs(notes) do
    table.insert(out, math.max(1, #out - n.depth + 1), { role = n.role, content = n.text })
  end
  return out
end

-- ilse-lore.lua, brought by the card: only the person's own words bring entries up
return function(c)
  local lorebooks, cond = c.lorebooks, c.cond   -- lorebooks: lore's components, read only
  local L = {}
  function L.activate(ctx, books, depth)    -- the entries that came up, in book order
    local said = {}
    for i = #ctx.history, 1, -1 do
      local m = ctx.history[i].msg
      if m.role == "user" then said[#said + 1] = m.text end
      if #said == depth then break end
    end
    local scan, came_up = { scanned = table.concat(said, "\n"), active = {}, speaker = ctx.speaker,
                            at = ctx.at }, {}
    for _, book in ipairs(books or {}) do
      local q = { "all", { "=", "lore.entry", "book", book } }
      for _, row in ipairs(lorebooks:query(ctx.at, q, { order = { "lore.entry", "order" },   -- [host]
                                                        read = { "lore.entry" } }).rows) do
        if cond.holds(row.values["lore.entry"].when, scan) then came_up[#came_up + 1] = row.values["lore.entry"] end
      end
    end
    return came_up
  end
  return L
end
```

```
{ "name": "Ilse", "main": "ilse/main.lua",
  "needs": { "lore":  { "what": "export", "of": "ilse-lore", "required": true },
             "chat":  { "what": "export", "of": "chat", "required": true },
             "model": { "what": "model", "required": true,
                        "why": "Ilse's replies" } },
  "brings": {
    "ilse-lore": { "main": "ilse-lore.lua", "needs": {
      "lorebooks": { "what": "store", "of": "lore", "mode": "r", "required": true,
                     "why": "Reads this card's lorebooks" },
      "cond":      { "what": "export", "of": "cond", "required": true } } } } }

pressing the button, in every option:
t=0      page: action { type = "run", install = "tracker", export = "recount", at = 822, chat = 790 }
         root: recount is in tracker's message.actions; installed.tracker.recount(822, 790)
t=1.2s   store: the chat's minutes and Ilse's affection change at 822 and every node below it
         reply to the action: { cursor = 99210 }; pages watching the chat get the batch
```

The settings section is data about the module's own settings, which the table at the end already gave as a setting schema; a module that needs drawing of its own gets it through the display handle (decided: an allowlisted display API, a framed area where a DOM library needs one). How a card's lore activation and the person's extensions meet is the second half of each option. Under D the manifest's needs become need nodes and its slot contributions item nodes, and compose_order.lua replaces order.lua: "after" and "before" are conditions, and the person's rules override them.

## Gap 5, joining, option A: a hook library of named points

Superseded by option D (decisions of 11-14), where a hook point is a node holding a list that extensions insert into. Kept as the record of what A gave up: an extension acts only where a card placed a point.

```lua
-- hooks.lua: named points a card runs; installed modules add to them
return function()
  return function()                         -- a set of points, one per chat
    local H, points = {}, {}
    function H.add(point, entry)            -- entry = { install, run }, in the order the loader adds
      points[point] = points[point] or {}
      table.insert(points[point], entry)
    end
    function H.run(point, ctx)              -- each entry in order; returns the fields they set
      local set = {}
      for _, e in ipairs(points[point] or {}) do
        for k, v in pairs(e.run(ctx) or {}) do ctx[k] = v; set[k] = v end
      end
      return set
    end
    function H.wrap(point, fn)              -- fn inside every entry's wrapper, the last added outermost
      for _, e in ipairs(points[point] or {}) do fn = e.run(fn) end
      return fn
    end
    function H.list(point, ctx)             -- each entry's result, in order
      local out = {}
      for _, e in ipairs(points[point] or {}) do out[#out + 1] = e.run(ctx) end
      return out
    end
    return H
  end
end

-- tracker's manifest under A
"adds": { "after_reply": { "export": "step" }, "prompt.notes": { "export": "note" } },
"after": [ "summarize" ]

-- ilse/main.lua under A: the card runs the points it chooses, where it chooses
local reply_steps = {
  function(ctx) return { history = history(ctx.at), speaker = "Ilse" } end,
  function(ctx) return { came_up = ctx.hooks.wrap("lore.activate", lore.activate)(ctx, books, 4) } end,
  function(ctx)
    return { messages = prompt.at_depth(prompt.assemble(parts, ctx), ctx.hooks.list("prompt.notes", ctx)) }
  end,
  function(ctx) return { reply = model.generate(ctx.messages) } end,
  function(ctx)
    return { at = chat.append(ctx.at, { role = "assistant", name = "Ilse", text = ctx.reply }) }
  end,
  function(ctx) return ctx.hooks.run("after_reply", ctx) end,
}                                           -- run and merged as T.reply does

-- in root.lua under A: a chat's points, the person's installs first, then the card's
local function points_for(card)
  local h = hooks()
  local function add_all(name)
    for point, a in pairs(manifests[name].adds or {}) do
      h.add(point, { install = name, run = installed[name][a.export] })
    end
  end
  for _, name in ipairs(order(person_installs)) do add_all(name) end
  for _, name in ipairs(order(card.brings)) do add_all(name) end
  return h
end

t=0      page: action { type = "open", chat = 790 }; root: points_for(Ilse): summarize, then
         tracker, on after_reply; tracker on prompt.notes; ilse-lore adds nothing
         reply: the chat's values and the slots' contributions, in one response
t=1m     send: ilse's steps run; at lore, the card's own ilse-lore.activate inside whatever
         wraps lore.activate (nothing here); at the prompt, tracker's note 2 from the end;
         after the reply is stored, summarize's entry, then tracker.step
```

Hooks are a content library, so whether they are "built in" is whether the app ships one: it does, cards use it or another, and the core is unchanged. The card decides where each point runs, how often (once per speaker in a group) and whether at all; an extension knows only point names. The card's own library is the base a point wraps, so the person's extensions that wrap lore.activate wrap the card's activation too. Order: entries at one point run in the person's installs' order, then the card's; there is nothing to conflict but order, since a wrap point's base is always the card's. Upstream's shape is closest to this. Costs: the point names are a shared vocabulary someone has to keep, and an extension adding to a point a card never runs does nothing, which can only be reported if the card's manifest lists the points it runs; every turn reads the points; a card author has to place points for extensions they haven't seen. Rules out: an extension acting anywhere a card placed no point, short of wrapping the whole card.

## Gap 5, joining, option B: cards name their steps, extensions edit the list

Superseded by option D (decisions of 11-14), where a named step is a node with a name and the composed value is the whole graph. Kept as the record of what B gave up: an extension goes only after or around a step a card named.

```lua
-- compose.lua: a card's named steps with every install's edits applied, and a runner
return function()
  local M = {}
  function M.steps(steps, edits)            -- edits, in order: { install, id, run, after = id | wrap = id }
    local ids, after, wraps, unplaced = {}, {}, {}, {}
    for _, s in ipairs(steps) do ids[s.id] = true end
    for _, e in ipairs(edits) do
      local at = e.after or e.wrap
      if not ids[at] then unplaced[#unplaced + 1] = { install = e.install, at = at }
      else
        local list = e.wrap and wraps or after
        list[at] = list[at] or {}
        table.insert(list[at], e)
      end
    end
    local out = {}
    for _, s in ipairs(steps) do
      local run = s.run
      for _, w in ipairs(wraps[s.id] or {}) do run = w.run(run) end
      out[#out + 1] = { id = s.id, run = run }
      for _, e in ipairs(after[s.id] or {}) do out[#out + 1] = { id = e.id, run = e.run } end
    end
    return out, unplaced
  end
  function M.run(steps, ctx)                -- what a step returns is set on ctx
    for _, s in ipairs(steps) do
      for k, v in pairs(s.run(ctx) or {}) do ctx[k] = v end
    end
    return ctx
  end
  return M
end

-- tracker's manifest under B
"edits": [ { "after": "store", "id": "tracker", "export": "step" },
           { "wrap": "prompt", "export": "with_note" } ],
"after": [ "summarize" ]

-- tracker.lua gains, under B
function T.with_note(inner)                 -- the prompt step, then the note at its depth
  return function(ctx)
    local r, n = inner(ctx), T.note(ctx)
    if n then r.messages = c.prompt.at_depth(r.messages, { n }) end
    return r
  end
end

-- ilse/main.lua under B: the turn as named steps the card hands out
T.steps = {
  { id = "history", run = function(ctx) return { history = history(ctx.at), speaker = "Ilse" } end },
  { id = "lore",    run = function(ctx) return { came_up = lore.activate(ctx, books, 4) } end },
  { id = "prompt",  run = function(ctx) return { messages = prompt.assemble(parts, ctx) } end },
  { id = "reply",   run = function(ctx) return { reply = model.generate(ctx.messages) } end },
  { id = "store",   run = function(ctx)
      return { at = chat.append(ctx.at, { role = "assistant", name = "Ilse", text = ctx.reply }) }
    end },
}

-- in root.lua under B: composed once per card version and installed set, kept in memory only
local composed = {}
local function turn_for(card)
  local k = card.hash .. "/" .. installs_hash
  if not composed[k] then
    local edits = {}
    local function add_edits(name)
      for _, e in ipairs(manifests[name].edits or {}) do
        edits[#edits + 1] = { install = name, id = e.id, after = e.after, wrap = e.wrap,
                              run = installed[name][e.export] }
      end
    end
    for _, name in ipairs(order(person_installs)) do add_edits(name) end
    for _, name in ipairs(order(card.brings)) do add_edits(name) end
    composed[k] = { compose.steps(installed[card.name].steps, edits) }
  end
  return composed[k][1], composed[k][2]     -- the steps, and the edits that found no step
end

t=0      page: action { type = "open", chat = 790 }; root: turn_for(Ilse): history, lore,
         prompt (wrapped by with_note), reply, store, summarize, tracker; nothing unplaced
         reply: the chat's values, the slots' contributions, and the unplaced edits (none)
t=1m     send: compose.run(steps, ctx); the card's lore step runs ilse-lore; the note goes
         in as the prompt step returns; tracker runs last
a card with no step named "prompt": the note's edit is unplaced, and the open's reply says so
```

Hooks here are turn steps that cards declare: the card names its steps, and an extension says where it goes by those names. The composition is a value, made once per card version and installed set and kept in memory, so nothing is stored per card and a turn reads no registry; it can be shown, explained ("what runs in this turn, and from which install"), and an edit that found no step is known when the chat opens instead of silently doing nothing. A card that runs its steps per speaker runs the edited list per speaker without knowing about edits. The card's own lore library is its "lore" step, and a person's extension wrapping "lore" wraps it. Order: edits at one step go in the person's installs' order, then the card's; several wraps of one step nest in that order, the last outermost. Costs: step names are a shared vocabulary as point names are in A, but a card has to name every step it wants extensible rather than place points; a card whose turn isn't a list (a game loop, a module that isn't a chat) offers whatever list it has or none; edits are limited to after and around a step. Rules out: an extension changing a card's control flow (a loop, a branch inside a step) except by wrapping the whole step.

## Gap 5, joining, option C: extensions wrap what a card is handed

Superseded by option D (decisions of 11-14), where wrapping a reference is a wrap edit limited to some holders. Kept as the record of what C gave up: an extension sees only what crosses a reference, and guesses the turn's context from it.

```lua
-- tracker.lua gains, under C: wrappers made once per chat
function T.wrappers()
  local at, speaker = nil, nil              -- this chat's last node and speaker, as seen through chat
  local W = {}
  function W.chat(chat)                     -- the step after each assistant message is stored
    local w = {}
    for k, f in pairs(chat) do w[k] = f end
    function w.append(parent, msg)
      local n = chat.append(parent, msg)
      at = n
      if msg.role == "assistant" then
        speaker = msg.name
        T.step{ at = n, reply = msg.text, speaker = msg.name }
      end
      return n
    end
    return w
  end
  function W.model(model)                   -- the note in every prompt the card sends
    local w = {}
    for k, f in pairs(model) do w[k] = f end
    local function noted(messages)
      local n = at and speaker and T.note{ at = at, speaker = speaker }
      return n and c.prompt.at_depth(messages, { n }) or messages
    end
    function w.generate(messages) return model.generate(noted(messages)) end
    function w.stream(messages, sink) return model.stream(noted(messages), sink) end
    return w
  end
  return W
end

-- tracker's manifest under C
"wraps": [ "chat", "model" ], "after": [ "summarize" ]

-- in root.lua under C: a card is loaded per open chat, with what it's handed wrapped
local function card_for_chat(card)
  local given = resolve(card)               -- as wire does: { [need] = { name = of or what, ref } }
  for _, install in ipairs(order(person_installs)) do
    local w = installed[install].wrappers and installed[install].wrappers()
    for _, g in pairs(given) do
      if w and w[g.name] then g.ref = w[g.name](g.ref) end
    end
  end
  local refs = {}
  for need, g in pairs(given) do refs[need] = g.ref end
  return caps.sandbox:load(card.source, "lua", refs)                       -- [core]
end

t=0      page: action { type = "open", chat = 790 }; root: card_for_chat(Ilse): its chat
         and model pass through summarize's wrappers, then tracker's; its lore is ilse-lore,
         which no install wraps
t=1m     send: ilse's own steps, unchanged from "One turn, composed"; chat.append of the
         person's message tells the tracker the node; model.stream puts the note 2 from the
         end, naming whoever spoke last; chat.append of the reply runs tracker.step
```

There are no hooks: an extension wraps references, the one way this model already composes (revoking, narrowing, logging and the switch are wrappers too). Any card is extended without having anticipated anything, including a card that isn't a chat, and the card's code is the same whether extensions exist or not. Order: an install's wrappers sit outside those of installs it comes after; a card's own modules aren't wrapped, since they are the card's. Costs: a wrapper sees only what crosses its reference, so the tracker has to learn the chat's node from chat.append and can only name the last speaker, not the one about to reply; a card handing its prompt somewhere other than model.generate, or reading lore through a library it brought, goes around the person's wrappers; what put a message into the prompt can be explained only if wrappers report it; a sandbox per open chat. Rules out: an extension placed between two of a card's steps; two turns at once in one chat (a group replying in parallel) with wrappers that keep the chat's state, as the tracker's do.

## Gap 5, joining, option D (decided): the composition is data

Decided by the owner (decisions of 11-14), superseding A, B and C. The root's wiring is one graph the root interprets: which modules exist, what each is handed, how a card's turn is composed, and how the app's UI slots are filled. A card ships its piece of the graph; an extension is a transform of the graph, a list of edits, applied where and in the order rules decide (below). The others are special cases: A's hook point is a node holding a list others insert into (the prompt step's notes below), B's named step is a node with a name, and C's wrapped reference is a wrap edit limited to some holders.

```json
{ "name": "app",
  "nodes": {
    "store":           { "kind": "need", "what": "store", "components": "all", "mode": "rw", "required": true },
    "home":            { "kind": "need", "what": "home", "required": true },
    "kv":              { "kind": "module", "pkg": "kv" },
    "cond":            { "kind": "module", "pkg": "cond" },
    "prompt":          { "kind": "module", "pkg": "prompt" },
    "steps":           { "kind": "module", "pkg": "steps" },
    "chat":            { "kind": "module", "pkg": "chat", "with": {
                         "store": { "$ref": "chat-store" }, "kv": { "$ref": "kv" } } },
    "chat-store":      { "kind": "call", "on": { "$ref": "store" }, "method": "narrow", "with": {
                         "nodes": [ { "$ref": "home" } ], "components": [ "chat", "chat.message" ], "mode": "rw" } },
    "parts":           { "kind": "module", "pkg": "parts", "with": { "chars": { "$ref": "chars-store" } } },
    "chars-store":     { "kind": "call", "on": { "$ref": "store" }, "method": "narrow", "with": {
                         "nodes": [ { "$ref": "home" } ], "components": [ "card", "tags", "lore.books" ], "mode": "r" } },
    "cascade":         { "kind": "module", "pkg": "settings", "with": {
                         "cond": { "$ref": "context-cond" }, "kv": { "$ref": "kv" },
                         "kept": { "store": { "$ref": "settings-store" }, "world": { "$ref": "world-store" } } } },
    "settings-store":  { "kind": "call", "on": { "$ref": "store" }, "method": "narrow", "with": {
                         "nodes": [ { "$ref": "home" } ], "components": [ "settings" ], "mode": "rw" } },
    "world-store":     { "kind": "call", "on": { "$ref": "store" }, "method": "narrow", "with": {
                         "nodes": [ { "$ref": "home" } ], "components": [ "settings", "relations" ], "mode": "r" } },
    "connections":     { "kind": "module", "pkg": "connections", "with": {
                         "latest": { "$ref": "connections-latest" }, "kv": { "$ref": "kv" },
                         "switch": { "$ref": "switch" }, "default": "openai",
                         "adapters": { "openai": { "$ref": "openai" }, "kobold": { "$ref": "kobold" } } } },
    "message.actions": { "kind": "slot", "name": "message.actions", "items": [] },
    "settings":        { "kind": "slot", "name": "settings", "items": [] },
    "commands":        { "kind": "slot", "name": "commands", "items": [] } } }
```

```
A piece is { name, nodes, entries }. In the composed graph a node's id is its piece's
name, a slash, and its id in the piece ("app/chat"); an edge without a slash is to the
piece's own node. "app" is the app's piece, and the root gives no install that name.
An edge is { "$ref": id }, with "export" to reach one of the node's exports, and on an
edge out of a piece "why" (the module's words) and "required": false where it can do
without. Anything else in a node is a value.
Kinds, and what each node's value is (wiring.lua):
  need    what grant minted for the piece's install: gap 7's needs, as nodes. "components"
          asks for those components (or "all") rather than the install's own; "home" is the
          node the person's data is under, a name
  module  sandbox:load of the package, handed with
  call    fn(with), or on:method(with): a value made from other values
  steps   a function running steps in order, setting on ctx what each returns
  slot    a UI slot's items, in order; which slots exist is the owner's
  item    one contribution to a slot: data, and an edge to what runs it
  wrap    with(inner): what with makes of the node it wraps
A card's piece names its entries, "send" and "reply", which the root's page actions run.
A reference enters a graph only as a need node, which grant answers for that node's
install; every other node reaches one through an edge, which its install's review shows.
```

The excerpt leaves out connections' own inputs (its narrowed latest, the switch, the adapters and their secrets) and cascade's (context-cond, the levels and the schemas), which are nodes of the same kinds. The app's piece is content like a card's: its store and home are need nodes, which grant answers for the install "app" as it answers any install's, and no kind of node is the app's alone. It differs from a card's piece only in what grant gave it, the widest needs there are, because the root, which holds the host modules, installed it. Every edge is a `$ref` wherever it sits, the way a value names a blob with `$blob`, so one walk finds every reference a node holds, and an edit reaches them all without knowing the kind.

```lua
-- graph.lua: what the graph modules share
return function(c)
  local G = {}
  function G.is_edge(v) return type(v) == "table" and v["$ref"] ~= nil end
  function G.edges(v, fn)                   -- fn(edge) for every edge in v, however deep
    if type(v) ~= "table" then return end
    for _, x in pairs(v) do
      if G.is_edge(x) then fn(x) else G.edges(x, fn) end
    end
  end
  function G.hash(g, id, pkg)               -- the node, each edge as its target's hash
    g.hashes = g.hashes or {}
    if g.hashes[id] then return g.hashes[id] end
    local n = g.nodes[id]
    local function canon(v)
      if type(v) ~= "table" then return v end
      if G.is_edge(v) then return { ["$ref"] = G.hash(g, v["$ref"], pkg), export = v.export } end
      local out = {}
      for k, x in pairs(v) do out[k] = canon(x) end
      return out
    end
    local top = canon(n)
    top.by, top.inside, top.name = nil, nil, nil   -- bookkeeping that doesn't change the value
    local of = (n.kind == "module" and n.pkg) or (n.kind == "need" and n.by) or nil
    g.hashes[id] = c.sha256(c.json.encode{ top, of and pkg(of).hash or false })   -- keys sorted
    return g.hashes[id]
  end
  return G
end

-- steps.lua: the turn's usual steps, each made from what it's handed (w)
return function()
  local S = {}
  function S.history(w)                     -- w.history: chat's; w.speaker, else the card the chat is with
    return function(ctx) return { history = w.history(ctx.at), speaker = w.speaker or ctx.where.character } end
  end
  function S.lore(w)                        -- w.library; w.books: a store reading "lore.books"; w.depth; w.scan: functions giving text or nil
    return function(ctx)
      local also = {}
      for _, f in ipairs(w.scan or {}) do also[#also + 1] = f(ctx) end
      local books = w.books:get(ctx.at, ctx.speaker, "lore.books")                             -- [host]
      return { came_up = w.library.activate(ctx, books, w.depth, also) }
    end
  end
  function S.prompt(w)                      -- w.assemble, w.at_depth: prompt's; w.parts; w.notes: functions giving a note or nil
    return function(ctx)
      local notes = {}
      for _, f in ipairs(w.notes or {}) do notes[#notes + 1] = f(ctx) end
      return { messages = w.at_depth(w.assemble(w.parts, ctx), notes) }
    end
  end
  function S.reply(w)                       -- w.model
    return function(ctx) return { reply = w.model.generate(ctx.messages) } end
  end
  function S.append(w)                      -- w.append: chat's; w.role
    return function(ctx)
      local user = w.role == "user"
      return { at = w.append(ctx.at, { role = w.role, speaker = user and ctx.persona or ctx.speaker,
                                       text = user and ctx.text or ctx.reply }) }
    end
  end
  return S
end

-- parts.lua: the usual parts of a prompt, as "One turn, composed" wrote them inline
return function(c)
  local P = {}
  function P.description(ctx)
    return { { role = "system", content = c.chars:get(ctx.at, ctx.speaker, "card").description } }  -- [host]
  end
  function P.came_up(ctx)
    local out = {}
    for _, e in ipairs(ctx.came_up or {}) do out[#out + 1] = { role = "system", content = e.text } end
    return out
  end
  function P.history(ctx)
    local out = {}
    for _, h in ipairs(ctx.history) do out[#out + 1] = { role = h.msg.role, content = h.msg.text } end
    return out
  end
  return P
end

-- wiring.lua: a composed graph's values, each made when first used and shared by hash
return function(c)
  local graph, grant, sandbox, pkg = c.graph, c.grant, c.sandbox, c.pkg
  local made = {}                           -- node hash -> a promise of its value, across compositions
  return function(g)
    local value
    local function resolve(v)             -- v with every edge replaced by what it reaches
      if type(v) ~= "table" then return v end
      if graph.is_edge(v) then
        local x = value(v["$ref"])
        if v.export then return x[v.export] end
        return x
      end
      local out = {}
      for k, x in pairs(v) do out[k] = resolve(x) end
      return out
    end
    local kinds = {
      need   = function(n, id)
        local v = grant:needs(n.by)[id:sub(#n.by + 2)]                    -- [host]
        if v == nil and n.required then error(id .. " was not granted", 0) end
        return v
      end,
      module = function(n)
        local p = pkg(n.pkg)
        return sandbox:load(p.source, p.runtime or "lua", resolve(n.with or {}))   -- [core]
      end,
      call   = function(n)
        if n.method then
          local on = resolve(n.on)
          return on[n.method](on, resolve(n.with or {}))
        end
        return resolve(n.fn)(resolve(n.with or {}))
      end,
      steps  = function(n)
        local steps = resolve(n.steps)
        return function(ctx)
          for _, step in ipairs(steps) do
            for k, v in pairs(step(ctx) or {}) do ctx[k] = v end
          end
          return ctx
        end
      end,
      slot   = function(n) return resolve(n.items) end,
      item   = function(n) return resolve(n) end,
      wrap   = function(n) return resolve(n.with)(resolve(n.inner)) end,
    }
    function value(id)
      local h = graph.hash(g, id, pkg)
      local p = made[h]
      if p then
        local ok, v = pcall(p.get, p)                                     -- [core]
        if ok then return v end
        if made[h] == p then error(v, 0) end    -- still being made: this task was cancelled
        return value(id)                        -- its maker failed or was cancelled: make it here
      end
      p = task.promise(); made[h] = p                                     -- [core]
      local n = g.nodes[id]
      local ok, v = pcall(kinds[n.kind], n, id)
      if not ok then made[h] = nil; p:fail(v); error(v, 0) end
      p:set(v)
      return v
    end
    local W = {}
    function W.entry(name) return resolve(g.entries[name]) end
    function W.item(id)                   -- an item, only if one of this graph's slots holds it
      for _, n in pairs(g.nodes) do
        if n.kind == "slot" then
          for _, e in ipairs(n.items) do if e["$ref"] == id then return value(id) end end
        end
      end
    end
    return W
  end
end
```

The root interprets the graph with wiring.lua, which is content: each kind is a few lines over sandbox:load and calls through references. A node's value is made the first time something reaches it, so nothing removed or unreached is loaded, and it is kept by the node's hash: the node's definition with each edge replaced by its target's hash, and a module by its package's hash. Two compositions that share a subgraph (every card's use of app/chat, app/steps, app/prompt) share its values, so the app's modules load once and a card's nodes once per card version and list of transforms that run. A value two tasks reach at once is made once: the second waits on the first's promise, and makes it itself if the first fails or is cancelled, so a cancel in one turn never fails another. Nothing about a chat lives in a module's memory, as before, so sharing a value between chats changes nothing. The steps list is the turn the card ran by hand in "One turn, composed", now made from data; a card that wants a different loop (per speaker, a game) makes its turn a module node and names it as its entry. Costs: made only grows here; dropping a value when no kept composition reaches it is a count per hash, left out. Which nodes run on a page, and how a page's root gets its part of the graph, isn't worked out here.

## Gap 5, joining, option D: extensions as transforms of the graph

```json
{ "name": "tracker", "version": "3.0.0", "tags": [ "tracker" ],
  "scope": [ "all" ], "after": [ [ "transform", "summarize" ] ],
  "nodes": {
    "main":     { "kind": "module", "pkg": "tracker", "with": {
                  "store": { "$ref": "store" }, "settings": { "$ref": "settings" }, "kv": { "$ref": "app/kv" },
                  "chats": { "$ref": "app/chat-store", "why": "Reads a reply again when you ask for a recount" },
                  "cards": { "$ref": "app/chars-store", "why": "Names the character in its note" },
                  "model": { "$ref": "app/connections", "export": "model",
                             "why": "Asks the model how much time passed in each reply" } } },
    "store":    { "kind": "need", "what": "store", "mode": "rw", "required": true,
                  "why": "Keeps the time and each character's affection at every message" },
    "settings": { "kind": "call", "on": { "$ref": "app/cascade" }, "method": "narrow",
                  "with": { "prefix": "tracker/settings/" } },
    "recount":  { "kind": "item", "label": "Recount time and affection",
                  "run": { "$ref": "main", "export": "recount" } },
    "panel":    { "kind": "item", "label": "Tracker", "settings": "tracker/settings/", "fields": {
                  "note":  { "type": "boolean", "default": true, "label": "Tell the model the time and affection" },
                  "depth": { "type": "number",  "default": 2,    "label": "Messages from the end where that goes" } } } },
  "schemas": {
    "tracker/settings/note":  { "default": true, "order": [ "tab", "chat", "character", "device", "user" ] },
    "tracker/settings/depth": { "default": 2, "order": [ "chat", "character", "user" ] } },
  "edits": [
    { "op": "insert", "into": [ "kind", "steps" ],
      "after": [ "all", [ "holds", [ "pkg", "chat" ], "append" ], [ "given", "role", "assistant" ] ],
      "edge": { "$ref": "main", "export": "step" } },
    { "op": "insert", "into": [ "holds", [ "pkg", "prompt" ], "assemble" ], "field": "notes",
      "edge": { "$ref": "main", "export": "note" } },
    { "op": "insert", "into": [ "holds", [ "pkg", "steps" ], "lore" ], "field": "scan",
      "edge": { "$ref": "main", "export": "scan" } },
    { "op": "insert", "into": [ "all", [ "kind", "slot" ], [ "name", "message.actions" ] ],
      "edge": { "$ref": "recount" } },
    { "op": "insert", "into": [ "all", [ "kind", "slot" ], [ "name", "settings" ] ],
      "edge": { "$ref": "panel" } } ] }
```

```
An extension is { name, scope, after, before, nodes, edits }: where it runs, what it runs
next to, its own nodes, which are a piece, and edits to the graph it's applied to. scope
is a condition (cond.lua data, context_cond.lua's operators; ["all"] holds everywhere);
after and before are conditions over other transforms. All three are its declarations,
which the person's rules can override (option D: which transforms run, below). The
manifest's needs are its need nodes; its slot contributions are item nodes; a dependency
is an edge to another install's node, the app's piece's included.
A match is cond.lua data over a node (graph_match.lua):
  ["kind", k]               the node's kind
  ["name", n]               the name its piece gave it
  ["pkg", p]                a module node's package
  ["from", install]         the piece or extension it came from
  ["given", field, value]   it is handed value under field
  ["holds", match, export]  it holds an edge to a node match matches (to that export, if given)
  and "all", "any", "not" from cond.lua. A wrap answers for what it wraps.
Edits; each acts on every node its match finds, in id order:
  insert   { into, edge, field?, after? | before? }   the edge into the list of each node into
           matches (a steps node's steps, a slot's items, or with[field]); next to each member
           after or before matches, or at the end. An edge put after m goes after what earlier
           extensions put after m, so order at one place is the transforms' order.
  wrap     { target, with, holders? }   with(inner) takes the node's place, outside any earlier
           wrap; with holders, only the edges from nodes holders matches go through it
  replace  { target, node }   node takes the place of the thing itself; wraps around it stay
  remove   { target }   the node and the wraps around it; edges to them go
  connect  { to, field, edge }   the node holds edge under with[field]
Order: compose_order.lua's (below); each extension's edits see what those before it
  made, and its own nodes go in after its edits, so it never matches itself.
After the last extension: a wrap whose inner is gone goes; an edge to a removed node goes
  from a list or an optional field; a required one refuses the composition, naming the
  extension that removed it; so does a cycle (a module can't load holding what holds it).
  An edit that matched nothing is listed, not an error.
```

```lua
-- graph_match.lua: what an edit can match a node by, as cond.lua operators
return function(c)
  local cond, graph = c.cond, c.graph       -- a cond of its own, so these names reach nothing else
  local M
  cond.define("kind", function(m, kind) return m.node.kind == kind end)
  cond.define("name", function(m, name) return m.node.name == name end)
  cond.define("pkg", function(m, pkg) return m.node.pkg == pkg end)
  cond.define("from", function(m, install) return m.node.by == install end)
  cond.define("given", function(m, field, value) return m.node.with ~= nil and m.node.with[field] == value end)
  cond.define("holds", function(m, what, export)
    local yes = false
    graph.edges(m.node, function(e)
      if not yes and (export == nil or e.export == export) then yes = M(m.graph, e["$ref"], what) end
    end)
    return yes
  end)
  function M(g, id, expr)                   -- a wrap answers for what it wraps
    local n, seen = g.nodes[id], {}
    while n and not seen[n] do
      if cond.holds(expr, { graph = g, node = n }) then return true end
      seen[n] = true
      n = n.kind == "wrap" and n.inner and g.nodes[n.inner["$ref"]] or nil
    end
    return false
  end
  return M
end

-- compose.lua: pieces and extensions into one graph; pure, so the same inputs give the same graph
return function(c)
  local graph, match = c.graph, c.match
  local LIST = { steps = "steps", slot = "items" }

  local function copy(v, piece)             -- v, its local ids made the piece's
    if type(v) ~= "table" then return v end
    local out = {}
    for k, x in pairs(v) do out[k] = copy(x, piece) end
    if graph.is_edge(out) and not out["$ref"]:find("/", 1, true) then
      out["$ref"] = piece .. "/" .. out["$ref"]
    end
    return out
  end

  local function own(n, piece)              -- a node the piece brings
    local x = copy(n, piece)
    x.by = piece
    return x
  end

  local function found(g, expr)             -- the ids expr matches, in id order
    local ids = {}
    for id, n in pairs(g.nodes) do
      if not n.inside and match(g, id, expr) then ids[#ids + 1] = id end
    end
    table.sort(ids)
    return ids
  end

  local function innermost(g, id)           -- the thing itself, inside its wraps
    while g.nodes[id].kind == "wrap" do id = g.nodes[id].inner["$ref"] end
    return id
  end

  local ops = {}

  function ops.insert(g, e, by, hit)
    local near = e.after or e.before
    for _, id in ipairs(found(g, e.into)) do
      local n = g.nodes[innermost(g, id)]
      local holder, key = n, LIST[n.kind]
      if e.field then n.with = n.with or {}; holder, key = n.with, e.field end
      if key then
        local list, out = holder[key] or {}, {}
        local function new(placed)
          local x = copy(e.edge, by)
          x.by, x.placed = by, placed
          hit(id)
          return x
        end
        local i = 1
        while i <= #list do
          local m = list[i]
          local here = near and graph.is_edge(m) and match(g, m["$ref"], near)
          if here and e.before then out[#out + 1] = new(true) end
          out[#out + 1] = m
          i = i + 1
          if here and e.after then
            while list[i] and list[i].placed == m["$ref"] do out[#out + 1] = list[i]; i = i + 1 end
            out[#out + 1] = new(m["$ref"])
          end
        end
        if not near then out[#out + 1] = new(true) end
        holder[key] = out
      end
    end
  end

  function ops.wrap(g, e, by, hit, i)
    for _, id in ipairs(found(g, e.target)) do
      local w = { kind = "wrap", with = copy(e.with, by), by = by }
      local aside = id .. "@" .. by .. "." .. i
      if e.holders then                     -- the reference those holders are handed
        w.inner, w.inside = { ["$ref"] = id }, true
        g.nodes[aside] = w
        for hid, h in pairs(g.nodes) do
          if hid ~= aside and match(g, hid, e.holders) then
            graph.edges(h, function(edge) if edge["$ref"] == id then edge["$ref"] = aside end end)
          end
        end
      else                                  -- the wrap takes the node's place; the node moves aside
        g.nodes[aside] = g.nodes[id]
        g.nodes[aside].inside = true
        w.inner = { ["$ref"] = aside }
        g.nodes[id] = w
      end
      hit(id)
    end
  end

  function ops.replace(g, e, by, hit)
    for _, id in ipairs(found(g, e.target)) do
      local at = innermost(g, id)
      local new = own(e.node, by)
      new.inside = g.nodes[at].inside
      g.nodes[at] = new
      hit(id)
    end
  end

  function ops.remove(g, e, by, hit)
    for _, id in ipairs(found(g, e.target)) do
      local at = id
      while at do
        local n = g.nodes[at]
        g.nodes[at], g.removed[at] = nil, by
        at = n.kind == "wrap" and n.inner["$ref"] or nil
      end
      hit(id)
    end
  end

  function ops.connect(g, e, by, hit)
    for _, id in ipairs(found(g, e.to)) do
      local n = g.nodes[innermost(g, id)]
      local x = copy(e.edge, by)
      x.by = by
      n.with = n.with or {}
      n.with[e.field] = x
      hit(id)
    end
  end

  local function gone(g, x) return graph.is_edge(x) and not g.nodes[x["$ref"]] end

  local function drop_gone(g, v, at, problems)   -- v without its edges to removed nodes
    if type(v) ~= "table" then return v end
    local out = {}
    if v[1] ~= nil then
      for _, x in ipairs(v) do
        if not gone(g, x) then out[#out + 1] = drop_gone(g, x, at, problems) end
      end
      return out
    end
    for k, x in pairs(v) do
      if gone(g, x) then
        if x.required ~= false then
          local by = g.removed[x["$ref"]]
          problems[#problems + 1] = at .. " needs " .. x["$ref"] ..
            (by and (", which " .. by .. " removed") or ", which isn't there")
        end
      else
        out[k] = drop_gone(g, x, at, problems)
      end
    end
    return out
  end

  local function prune(g, problems)
    local again = true
    while again do
      again = false
      for id, n in pairs(g.nodes) do
        if n.kind == "wrap" and not g.nodes[n.inner["$ref"]] then
          g.nodes[id], g.removed[id] = nil, g.removed[n.inner["$ref"]]
          again = true
        end
      end
    end
    for id, n in pairs(g.nodes) do g.nodes[id] = drop_gone(g, n, id, problems) end
  end

  local function cycles(g, problems)
    local state = {}
    local function visit(id, path)
      if state[id] == "done" then return end
      if state[id] == "on" then problems[#problems + 1] = "these hold each other: " .. path; return end
      state[id] = "on"
      graph.edges(g.nodes[id], function(e)
        if g.nodes[e["$ref"]] then visit(e["$ref"], path .. " -> " .. e["$ref"]) end
      end)
      state[id] = "done"
    end
    for id in pairs(g.nodes) do visit(id, id) end
  end

  return function(pieces, extensions)        -- pieces[name] = a piece; extensions = { { name, t } }, in order
    local g = { nodes = {}, entries = {}, removed = {}, log = {}, unmatched = {} }
    for name, p in pairs(pieces) do
      for id, n in pairs(p.nodes or {}) do g.nodes[name .. "/" .. id] = own(n, name) end
      for k, e in pairs(p.entries or {}) do g.entries[k] = copy(e, name) end
    end
    for _, x in ipairs(extensions) do
      for i, e in ipairs(x.t.edits or {}) do
        if not ops[e.op] then error(x.name .. ": no edit called " .. tostring(e.op), 0) end
        local hits = 0
        ops[e.op](g, e, x.name, function(id)
          hits = hits + 1
          g.log[#g.log + 1] = { by = x.name, edit = i, op = e.op, at = id }
        end, i)
        if hits == 0 then g.unmatched[#g.unmatched + 1] = { by = x.name, edit = i } end
      end
      for id, n in pairs(x.t.nodes or {}) do g.nodes[x.name .. "/" .. id] = own(n, x.name) end
    end
    local problems = {}
    prune(g, problems)
    cycles(g, problems)
    table.sort(problems)
    return g, problems
  end
end
```

A transform sees the whole graph, the app's piece included, and matches nodes by what they are: the tracker's step goes after every step that hands chat's append the role "assistant", whatever the card called that step or whether it named it at all, so nothing is missed for lack of a card's cooperation. Names are one operator among several, kept for slots, which are named contracts, and for cards that want to offer a place by name. A wrap goes outside every earlier wrap of the same node, so several nest in the transforms' order, the last outermost; a replace puts the new thing inside the wraps, so a later replacement of the model still has the tracker's wrapper (if it had one) around it; a remove takes the wraps with it. Conflicts are settled by order, since each extension edits what those before it made; what order can't settle (an edge someone needs removed, a cycle) refuses the composition and names who did it, so the chat says which extensions can't run together instead of running a broken turn. The order is decided before any edit runs, from rules (below), so no edit can change it. Costs: composing tests every edit against every node, once per card version and list of transforms that run; a node id that other pieces hold is part of its piece's contract, the way an export name is.

Custom code is an opaque node: the edits can't see into a module's source. It can only act through the references it holds, which are all edges, so a transform reaches every input, output and capability of it: it can wrap what the node is handed, wrap the node itself (seeing each call and what it returns), or insert next to it. Changing what it decides inside takes replacing the node, which the review shows, or patching its stored source, which is possible but breaks when the source changes. The owner calls this limitation a non-issue.

## Gap 5, joining, option D: which transforms run, and in what order

Whether a transform runs where a chat is composed, and what it runs next to, are rules: the person's first-match rules, the same cond.lua data as grant's preset rules, kept as the setting "compose" and resolved through the settings cascade, so they can be stated at any level of the cascade: a tab, a chat, a character, a device, the person, a card (its statements, ordering included, are statements at the card level) or a transform's declarations. Whether a card's statements outrank the person's depends only on the order of the path, which is itself the setting "path/compose". No ordering rule ships: order comes only from what transforms declare and what the person states, and a tie is broken by name, which the explanation lists.

```json
{ "node": 1, "entity": 1, "component": "settings", "field": "compose", "value": [
    { "when": [ "all", [ "transform", "tracker" ], [ "card-tag", 44 ] ], "on": false },
    { "when": [ "transform", "summarize" ], "after": [ [ "transform", "tracker" ] ] },
    { "when": [ "transform", "tracker" ], "replace": true } ] }
{ "node": "3f0c…", "entity": "3f0c…", "component": "settings", "field": "compose", "value": [
    { "when": [ "transform", "tracker" ], "on": false } ] }
{ "node": 790, "entity": 790, "component": "settings", "field": "compose", "value": [
    { "when": [ "transform", "tracker" ], "on": true } ] }
{ "node": "9a71…", "entity": "9a71…", "component": "settings", "field": "compose", "value": [
    { "when": [ "transform", "summarize" ], "on": false } ] }
```

```
A rule: { when, on?, after?, before?, replace? }. when is a condition about one transform,
  asked where the chat is composed: compose_order.lua's operators ("transform",
  "transform-tag", queries over the transform's "pkg" with store:match) and
  context_cond.lua's ("card", "card-tag", "persona", "world", "device", and any a module
  adds). 44 is the tag "no-tracker".
The rules are settings' "compose", combined as "rules": every level's list, most specific
  first along the path "path/compose" gives (by default tab, chat, character, device,
  user, card, declared), each in its own order. "card" is what the card ships; a card that
  states "path/compose" at its level changes the order only as far as that level's place
  in the path allows, and a person who wants otherwise states it earlier in the path.
  "declared" is two rules for each transform, from its declarations:
  { by, when = ["all", ["transform", it], its scope], on = true, after, before } and
  { by, when = ["transform", it], on = false }.
Whether it runs: the first rule that holds for it and sets on.
What it runs next to: what every rule that holds for it adds as after or before, most
  specific first, down to and including the first with replace; so a rule adds to what is
  declared, and with replace it sets it. An after or before is a condition over the other
  transforms that run, the card's and the person's alike: one constraint graph.
Order: every constraint is kept; of two with none between them, the one whose name sorts
  first goes first, and the explanation lists each such tie.
A cycle refuses the composition and names each constraint in it and who made it. A
  constraint that matches nothing that runs adds nothing.
```

```lua
-- compose_order.lua: which transforms run here and in what order, from the rules settings resolved
return function(c)
  local cond, store = c.cond, c.store       -- a cond of its own, with context_cond's operators
  local unpack = unpack or table.unpack
  local function about_pkg(q, t) return store:match(q, { { pkg = t.pkg } })[1] end   -- [host] no read
  cond.define("transform", function(x, name) return about_pkg({ "=", "pkg", "name", name }, x.transform) end)
  cond.define("transform-tag", function(x, tag) return about_pkg({ "in", "pkg", "tags", { tag } }, x.transform) end)

  local function about(t, ctx) return setmetatable({ transform = t }, { __index = ctx }) end
  local function said(r)
    return r.rule.by and ("declared by " .. r.rule.by) or (r.level .. " rule " .. r.index)
  end

  return function(transforms, rules, ctx)   -- transforms[name] = { name, pkg, card }; rules: settings.get("compose", ctx)
    local names = {}
    for name in pairs(transforms) do names[#names + 1] = name end
    table.sort(names)

    local on, why, wants = {}, {}, {}       -- wants[name] = { { "after" | "before", match, rule } }
    for _, name in ipairs(names) do
      local x, stop = about(transforms[name], ctx), false
      wants[name] = {}
      for _, r in ipairs(rules) do
        if cond.holds(r.rule.when, x) then
          if why[name] == nil and r.rule.on ~= nil then on[name], why[name] = r.rule.on, r end
          if not stop then
            for _, m in ipairs(r.rule.after or {}) do table.insert(wants[name], { "after", m, r }) end
            for _, m in ipairs(r.rule.before or {}) do table.insert(wants[name], { "before", m, r }) end
            stop = r.rule.replace == true
          end
        end
      end
    end

    local live, first, into = {}, {}, {}   -- into[b] = { { from = a, because } }: a runs before b
    for _, name in ipairs(names) do
      if on[name] then live[#live + 1] = name; first[name], into[name] = {}, {} end
    end
    for _, a in ipairs(live) do
      for _, w in ipairs(wants[a]) do
        for _, b in ipairs(live) do
          if b ~= a and cond.holds(w[2], about(transforms[b], ctx)) then
            local from, to = b, a
            if w[1] == "before" then from, to = a, b end
            table.insert(first[from], to)
            table.insert(into[to], { from = from, because = w[3] })
          end
        end
      end
    end

    local order, ties, waiting, ready = {}, {}, {}, {}
    for _, name in ipairs(live) do
      waiting[name] = #into[name]
      if waiting[name] == 0 then ready[#ready + 1] = name end
    end
    while ready[1] do
      table.sort(ready)
      local a = table.remove(ready, 1)
      if ready[1] then ties[#ties + 1] = { went = a, over = { unpack(ready) } } end
      order[#order + 1] = a
      for _, b in ipairs(first[a]) do
        waiting[b] = waiting[b] - 1
        if waiting[b] == 0 then ready[#ready + 1] = b end
      end
    end

    if #order < #live then                  -- what's left waits on itself: follow what it waits on back to a repeat
      local at, seen, steps = nil, {}, {}
      for _, name in ipairs(live) do if waiting[name] > 0 then at = name; break end end
      while not seen[at] do
        seen[at] = #steps + 1
        for _, e in ipairs(into[at]) do
          if waiting[e.from] > 0 then
            steps[#steps + 1] = at .. " after " .. e.from .. " (" .. said(e.because) .. ")"
            at = e.from
            break
          end
        end
      end
      local cycle = {}
      for i = seen[at], #steps do cycle[#cycle + 1] = steps[i] end
      return nil, { "these transforms each have to run after the other: " .. table.concat(cycle, "; ") }
    end

    local placed = {}
    for _, b in ipairs(order) do
      placed[b] = {}
      for _, e in ipairs(into[b]) do placed[b][#placed[b] + 1] = { after = e.from, because = said(e.because) } end
    end
    local decided = {}
    for _, name in ipairs(names) do decided[name] = { on = on[name] == true, because = why[name] and said(why[name]) } end
    return { order = order, decided = decided, placed = placed, ties = ties }, {}
  end
end
```

The person's rules have the last word because of who holds what, not because of an order or a rule about levels. The person's levels are fields of "settings" components in the version store, and only the root's own settings.lua and app/cascade hold references that write them; an install reaches app/cascade only through an edge, which its review shows as "Can read and change your settings", these rules among them. A card's statements are in its package, read at the "card" level, and a transform's declarations at "declared"; where they stand against the person's is the order of "path/compose", a setting like any other, and the person can state it. The root alone composes, and it decides which transforms run and in what order before any edit runs, so no edit can change either. A card's transform can still edit what the person's transforms added if the order puts it after them; the explanation and the card's review say so, and that is the person's choice to make. No order is shipped for the card's transforms against the person's: with no constraint between two, the tie goes by name, and the explanation lists it.

A transform's scope is a condition like any other: the tracker declares ["all"], every chat; a rule that holds where the declared scope doesn't widens it ({ "when": ["all", ["transform", "tracker"], ["card-tag", "npc"]], "on": true }), one that holds within it narrows it ({ ..., "on": false }), and { "when": ["transform", "tracker"], "on": false } switches it off. The review shows the declared scope as a condition, in the app's words; which rule decided it for a card is in that chat's explanation.

A composition is a pure function of the app's piece, the card's package, and the running transforms in order with their package hashes, so that list's hash is its key. Each action resolves the rules again: one read per level on the path (eight at most), and a condition check per rule and transform, and per constraint and pair of transforms, each a call to store:match with no read; none of it is per card or per row, and every chat that resolves to the same list shares the composition, its values shared by node hash as before. A changed rule changes the key at the next action. Open chats learn of it at once: the root watches the query ["has", "settings"] at the node each open chat views, which covers the chat, character and user levels because their changes are at that node or above it, and at the tab's and device's nodes; a batch makes the root resolve again for the chats it touches, and a chat whose key changed gets a new explanation.

```
compose_order.lua, settings.lua, context_cond.lua: content the root loads.
Necessary: none of it.

Assumes: the card's extensions run before or after the person's.
  Rules out: either order being wrong for some transform of the person's or a card's.
  So: nothing ships; order comes from declared constraints and the person's statements,
  and a tie is broken by name and listed.
Assumes: ordering names other installs ("after": [ "summarize" ]).
  Rules out: running next to a kind of transform (every one tagged "lore"), or a card's,
  whose names the person's transform doesn't know.
  So: after and before are conditions over transforms.
Assumes: an installed extension runs with every card.
  Rules out: "off for cards tagged no-tracker", "on in this chat", "off on this device".
  So: whether it runs is a rule, resolved through the cascade with the context.
Assumes: who has the last word is who applies last.
  Rules out: a person putting a card's transform after their own and keeping control of it.
  So: the last word is the person's because only their install holds the references that
  write the rules and compose; the order of application is data.

Still restrictive:
  a condition that reads something other than settings (a card's tags) is read again at
  the next action, and a page's explanation catches up then; telling open chats at once
  takes a watch on whatever each operator reads, which operators don't declare;
  a cycle refuses the chat until a rule breaks it;
  ties go by name, which says nothing about intent; the explanation shows each one.
```

## Gap 5, joining, option D: the review, the cache, the explanation

```lua
-- review.lua: what an install asks for, read off its need nodes and the edges its nodes and edits add
return function(c)
  local graph, words = c.graph, c.words     -- words(x): the app's text for an edit, a scope or a constraint
  local function behind(node_of, id, out, seen)   -- the need nodes what id makes can use, and the calls made on them
    if seen[id] then return end
    seen[id] = true
    local n = node_of(id)
    if not n then return end
    if n.kind == "need" then out[#out + 1] = { node = id, need = n }; return end
    if n.kind == "call" and graph.is_edge(n.on) then
      local on = node_of(n.on["$ref"])
      if on and on.kind == "need" then
        out[#out + 1] = { node = id, need = on, call = { method = n.method, with = n.with } }
        return
      end
    end
    graph.edges(n, function(e) behind(node_of, e["$ref"], out, seen) end)
  end
  return function(install, t, node_of)      -- t: an extension, or a card's piece; node_of(id): a node of what's installed
    local needs, changes = {}, {}
    for id, n in pairs(t.nodes or {}) do
      if n.kind == "need" then
        needs[id] = n
      else
        graph.edges(n, function(e)
          local of = e["$ref"]:match("^([^/]+)/")
          if of and of ~= install then        -- an edge out of this install: a dependency
            local uses = {}
            behind(node_of, e["$ref"], uses, {})
            needs[id .. " " .. e["$ref"] .. " " .. (e.export or "")] = { what = "export", of = of,
              node = e["$ref"], export = e.export, required = e.required ~= false, why = e.why, uses = uses }
          end
        end)
      end
    end
    for i, e in ipairs(t.edits or {}) do changes[i] = { text = words(e), why = e.why } end
    changes[#changes + 1] = { text = words{ scope = t.scope or { "all" } } }
    for _, k in ipairs{ "after", "before" } do
      for _, m in ipairs(t[k] or {}) do changes[#changes + 1] = { text = words{ [k] = m } } end
    end
    return { needs = needs, changes = changes }
  end
end
```

```
grant:install(install, review) -> decisions, or nil if the person refused
  review = { needs = { [id] = a need }, changes = { { text, why }, ... } }
  A need node is described as before: the host's text for it, the module's why apart.
  An edge to another install's node is described by what is behind it (uses): the host's
  text for each need node it reaches through edges, and for a call made on one, the
  host's text for what that call makes (store:describe of the narrowing app/chat-store
  is). An edge to the app's piece is one of these: app/store reads "Can read and change
  everything you keep", app/chat-store "Can read and change everything chat keeps: your
  messages". changes are what the install's edits hand it, where it runs (its scope) and
  what it runs next to, in the app's words (the root's), drawn apart from both.
  Decisions are kept by package hash; an update asks only for a need that is new or
  wider, and for a change that is new.

Necessary: an edit hands the extension what reaches the edited node (an inserted step
gets the turn's context, which can carry references such as the page's sink in gap 1;
a wrap gets every call to what it wraps), and only grant's answer installs, so it has
to be in what grant asks.

Assumes: what an install can do is what its own nodes hold.
  Rules out: showing what reaches it through other modules' calls.
  So: the review has a change for each edit.
Assumes: the app's piece is a category whose nodes may be the host's references.
  Rules out: the app's piece being content like a card's (the owner: "zero core").
  So: a reference enters a graph only as a need node; the app's are need nodes grant
  answers for "app", and an edge to one, from any install, is a dependency reviewed by
  what it uses.
Assumes: an edge is described by the name of what it reaches.
  Rules out: seeing that app/chat-store can write, or that app/connections reaches two hosts.
  So: by the need nodes behind it, followed through edges, in the host's words.
Assumes: the host words every item.
  Rules out: describing an edit, whose format is the root's and which only content knows.
  So: the root words changes, shown as the app's words; the host still words what it mints.
Assumes: a change is reviewed as the nodes it reaches.
  Rules out: installing once for every chat (decided), since the nodes depend on the card.
  So: a change is reviewed as its match, once per package hash; each chat's explanation
  names the nodes.

Still restrictive:
  the root's words for a change are believed; whoever writes the root holds all
  authority anyway (core primitive 2);
  the review says where an extension goes and its scope as a condition; how many cards
  the scope reaches is a count of the same condition as a query, where it tests only
  stored things (a tag, a field), and unknown where it tests the context (a device);
  a module is described by what it holds, not by what it does with it: app/cascade
  holds every "settings" component, and narrows by content, so an edge to its narrow reads
  as all of them, with settings' own description of narrow beside it as its words;
  whether the person reviews the app's own piece at first start is the owner's, as
  before ("Capabilities from crescent: needs in a manifest").
```

This is the only change outside content, and it is to grant, a host module: grant:install took a manifest, and now takes the review the root derives; its need vocabulary gains "components" (components other than the install's own, or "all") and "home", which name narrowings the host modules already make for the root. A need is one of the extension's need nodes (described by the host module that mints it, as before) or an edge from one of its nodes to another install's node (an export, described by the need nodes behind it, as a contract was through grant:provides). The app's piece is one more install here: an edge to app/store is a dependency on a node whose need is the whole store, and the review says so in the store's words. A change is an edit: what the edit adds is edges from other nodes to the extension's, and those are the calls that will reach its code. The capability review falls out of the edges a transform adds, so nothing in the extension's JSON says what to review, and nothing can be left out of it. A card's piece is reviewed the same way at import: its need nodes, its edges into the app's nodes, and its own extensions' edits.

```lua
-- root.lua under D: each action's context picks the transforms; a composition is kept by what it's made of
return function(caps)
  local store, home, latest, grant = caps.store, caps.home, caps.latest, caps.grant
  local function installed() return store:get(home, home, "pkg.installed") end   -- [host] name -> the package's entity
  local function pkg(name) return store:get(home, installed()[name], "pkg") end  -- [host] { hash, source, piece, extension, ... }
  local function lib(name, given) return caps.sandbox:load(pkg(name).source, "lua", given) end   -- [core]
  local json, kv = lib("json", {}), lib("kv", {})
  local sha256  = caps.sandbox:load(pkg("sha256").source, "wasm", {})      -- [core]
  local graph   = lib("graph", { json = json, sha256 = sha256 })
  local cards = store:narrow{ nodes = { home }, components = { "card", "tags" }, mode = "r" }   -- [host]
  local function context_cond()
    local cond = lib("cond", {})
    return lib("context_cond", { cond = cond, query = lib("query", { store = cards, cond = cond }) })
  end
  local compose = lib("compose", { graph = graph,
                                   match = lib("graph_match", { cond = lib("cond", {}), graph = graph }) })
  local order   = lib("compose_order", { cond = context_cond(), store = store })
  local explain = lib("explain", { graph = graph })
  local wire    = lib("wiring", { graph = graph, grant = grant, sandbox = caps.sandbox, pkg = pkg })
  local app     = pkg("app")                -- { hash, piece, levels, schemas, combiners, filters }
  local function schema(name)               -- the app's, or that of the install whose name it starts with
    if app.schemas[name] then return app.schemas[name] end
    local install = name:match("^([^/]+)/")
    local x = install and installed()[install] and pkg(install).extension
    return x and x.schemas and x.schemas[name]
  end
  local settings = lib("settings", { cond = context_cond(), kv = kv, levels = app.levels, schema = schema, combiners = app.combiners,
    ancestry = function(filter, at) return store:ancestry(app.filters[filter], at) end,   -- [host]
    kept = { store  = store:narrow{ nodes = { home }, components = { "settings" }, mode = "rw" },   -- [host]
             world  = store:narrow{ nodes = { home }, components = { "settings", "relations" }, mode = "r" } } })   -- [host]

  local function transforms(card)           -- what could run with this card: its own, and what the person installed
    local all = {}
    for name, x in pairs(card and card.extensions or {}) do
      local id = card.name .. "." .. name
      all[id] = { name = id, pkg = { name = id, tags = x.tags }, card = true, hash = card.hash, t = x }
    end
    for name in pairs(installed()) do
      local p = pkg(name)
      if p.extension then all[name] = { name = name, pkg = p, hash = p.hash, t = p.extension } end
    end
    return all
  end

  local function declared(all)              -- the "declared" level: each transform's
    local rules, names = {}, {}
    for name in pairs(all) do names[#names + 1] = name end
    table.sort(names)
    for _, name in ipairs(names) do
      local t = all[name].t
      rules[#rules + 1] = { by = name, when = { "all", { "transform", name }, t.scope or { "all" } },
                            on = true, after = t.after, before = t.before }
      rules[#rules + 1] = { by = name, when = { "transform", name }, on = false }
    end
    return { compose = rules }
  end

  local composed = {}                       -- by the hash of what each is made of, in memory only
  local function for_action(action)
    local card_e = action.chat and store:get(action.chat, action.chat, "chat").card   -- [host] the card's entity
    local card = card_e and store:get(home, card_e, "pkg")                    -- [host] what the card ships
    local all = transforms(card)
    local ctx = { home = home, tab = action.tab, device = action.device, persona = action.persona,
                  chat = action.chat,
                  at = action.at or (action.reply and store:parents(action.reply)[1]) or action.chat,   -- [host]
                  character = card_e, card = card_e, world = card and card.world,
                  card_settings = card and card.settings, declared = declared(all) }
    local picked, refused = order(all, settings.get("compose", ctx), ctx)
    if not picked then return { key = table.concat(refused, "\n"), problems = refused }, nil, ctx end
    local made_of = { app.hash, card and card.hash or false }
    for _, name in ipairs(picked.order) do made_of[#made_of + 1] = { name, all[name].hash } end
    local key = sha256(json.encode(made_of))
    if not composed[key] then
      local pieces, list = { app = app.piece }, {}
      if card then pieces[card.name] = card.piece end
      for _, name in ipairs(picked.order) do list[#list + 1] = { name = name, t = all[name].t } end
      local g, problems = compose(pieces, list)
      composed[key] = { key = key, graph = g, problems = problems, run = problems[1] == nil and wire(g) or nil }
    end
    return composed[key], picked, ctx
  end

  local function explained(chat, picked)
    return { explained = chat.graph and explain(chat.graph, picked), problems = chat.problems }
  end
  local following = {}                      -- conn -> { action, key, watches }: what its page was last told
  local function recheck(conn)
    local f = following[conn]
    local chat, picked = for_action(f.action)
    if chat.key ~= f.key then f.key = chat.key; conn:send(explained(chat, picked)) end   -- [host]
  end
  local function follow(conn, action, at, chat)   -- the chat's page is shown at at; tell it when its composition changes
    local function stop(f) for _, w in ipairs(f.watches) do w:stop() end end
    local f = following[conn]
    if f then stop(f) else
      task.spawn(function() conn:closed(); stop(following[conn]); following[conn] = nil end)   -- [core], [host]
    end
    local a = {}
    for k, v in pairs(action) do a[k] = v end
    a.at, a.reply = at, nil
    f = { action = a, key = chat.key, watches = {} }
    for _, n in ipairs{ at, action.tab, action.device } do                    -- every level's node: the path's, the tab's, the device's
      f.watches[#f.watches + 1] = store:watch(n, { "has", "settings" }, nil, { push = function() recheck(conn) end })   -- [host]
    end
    following[conn] = f
  end

  caps.page:on(function(action, conn)                                       -- [host]
    local chat, picked, ctx = for_action(action)
    if action.type == "state" then          -- the person states a setting at a level
      settings.state(action.level, action.name, action.value, ctx)
      conn:send{}                                                           -- [host]
    elseif action.type == "open" then
      follow(conn, action, ctx.at, chat)
      conn:send(explained(chat, picked))                                    -- [host]
    elseif chat.problems[1] then
      conn:send{ problems = chat.problems }                                 -- [host]
    elseif action.type == "send" then
      local turn = chat.run.entry("send"){ at = action.at, text = action.text, persona = action.persona, where = ctx }
      follow(conn, action, turn.at, chat)
      conn:send{ at = turn.at, reply = turn.reply }                         -- [host]
    elseif action.type == "swipe" then
      local turn = chat.run.entry("reply"){ at = ctx.at, where = ctx }
      follow(conn, action, turn.at, chat)
      conn:send{ at = turn.at, reply = turn.reply }                         -- [host]
    elseif action.type == "run" then
      local item = chat.run.item(action.item)
      if not item then error(action.item .. " isn't in this chat's slots", 0) end
      item.run(action.at, action.chat)
      conn:send{}                                                           -- [host]
    end
  end)
end
```

```json
{ "send":  [ { "node": "ilse/user", "from": "ilse", "fn": "app/steps.append" },
             { "node": "ilse/turn", "from": "ilse" } ],
  "reply": [ { "node": "ilse/history", "from": "ilse", "fn": "app/steps.history" },
             { "node": "ilse/lore", "from": "ilse", "fn": "app/steps.lore", "library": "ilse/library",
               "scan": [ { "node": "tracker/main", "export": "scan", "by": "tracker", "edit": 3 } ] },
             { "node": "ilse/prompt", "from": "ilse", "fn": "app/steps.prompt",
               "notes": [ { "node": "tracker/main", "export": "note", "by": "tracker", "edit": 2 } ] },
             { "node": "ilse/reply", "from": "ilse", "fn": "app/steps.reply" },
             { "node": "ilse/store", "from": "ilse", "fn": "app/steps.append" },
             { "node": "summarize/main", "export": "step", "by": "summarize", "edit": 1 },
             { "node": "tracker/main", "export": "step", "by": "tracker", "edit": 1 } ],
  "slots": { "message.actions": [ { "item": "tracker/recount", "label": "Recount time and affection", "by": "tracker" } ],
             "settings": [ { "item": "tracker/panel", "label": "Tracker", "by": "tracker" } ] },
  "transforms": [ { "name": "summarize", "on": true, "because": "declared by summarize", "after": [] },
                  { "name": "tracker", "on": true, "because": "declared by tracker",
                    "after": [ { "after": "summarize", "because": "declared by tracker" } ] } ],
  "ties": [],
  "unmatched": [],
  "removed": [] }
```

The composed graph is a value, made by a pure function of the app's piece, the card's package and the transforms that run, in order, so the root keeps it in memory by the hash of those, and nothing is stored per card: a card costs nothing until a chat with it opens. An install, an update, a removal or a changed rule changes which transforms run for some contexts, and the next action there composes again; values whose node hashes didn't change are reused. Because it's data before it runs, the final composition can always be shown and explained: explain.lua walks from the entries and the slot nodes and reports each node's piece, what it's made from, each edge an extension added (every added edge and node carries by), the edits that matched nothing, and what was removed and by whom, and from compose_order's answer, each transform that could run with the rule that decided whether it does, what it runs after and why, and each tie; the open's reply carries it with the chat's values, in one response, and a watch sends it again when a rule changes it. What the page makes of it (a "what runs in this turn" view) is the owner's.

## Gap 5, joining, option D: the tracker, and Ilse's own lore

```json
{ "name": "ilse", "version": "4.0.0",
  "nodes": {
    "library":   { "kind": "module", "pkg": "ilse-lore", "with": {
                   "lorebooks": { "$ref": "lorebooks" }, "cond": { "$ref": "app/cond" } } },
    "lorebooks": { "kind": "need", "what": "store", "of": "lore", "mode": "r", "required": true,
                   "why": "Reads this card's lorebooks" },
    "user":      { "kind": "call", "fn": { "$ref": "app/steps", "export": "append" }, "with": {
                   "append": { "$ref": "app/chat", "export": "append" }, "role": "user" } },
    "history":   { "kind": "call", "name": "history", "fn": { "$ref": "app/steps", "export": "history" }, "with": {
                   "history": { "$ref": "app/chat", "export": "history" } } },
    "lore":      { "kind": "call", "name": "lore", "fn": { "$ref": "app/steps", "export": "lore" }, "with": {
                   "library": { "$ref": "library" }, "books": { "$ref": "app/chars-store" }, "depth": 4 } },
    "prompt":    { "kind": "call", "name": "prompt", "fn": { "$ref": "app/steps", "export": "prompt" }, "with": {
                   "assemble": { "$ref": "app/prompt", "export": "assemble" },
                   "at_depth": { "$ref": "app/prompt", "export": "at_depth" },
                   "parts": [ { "$ref": "app/parts", "export": "description" },
                              { "$ref": "app/parts", "export": "came_up" },
                              { "$ref": "app/parts", "export": "history" } ] } },
    "reply":     { "kind": "call", "name": "reply", "fn": { "$ref": "app/steps", "export": "reply" }, "with": {
                   "model": { "$ref": "app/connections", "export": "model", "why": "Ilse's replies" } } },
    "store":     { "kind": "call", "name": "store", "fn": { "$ref": "app/steps", "export": "append" }, "with": {
                   "append": { "$ref": "app/chat", "export": "append" }, "role": "assistant" } },
    "turn":      { "kind": "steps", "name": "reply", "steps": [
                   { "$ref": "history" }, { "$ref": "lore" }, { "$ref": "prompt" },
                   { "$ref": "reply" }, { "$ref": "store" } ] },
    "send":      { "kind": "steps", "name": "send", "steps": [ { "$ref": "user" }, { "$ref": "turn" } ] } },
  "entries": { "send": { "$ref": "send" }, "reply": { "$ref": "turn" } } }
```

```lua
-- tracker.lua under D: judge, changes and recount as in "what every option shares"
local function here(ctx)                    -- where its settings resolve: the turn's context, at the turn's node
  local w = {}
  for k, v in pairs(ctx.where) do w[k] = v end
  w.at = ctx.at
  return w
end
function T.note(ctx)                        -- the prompt's note, or nil
  if settings.get("note", here(ctx)) == false then return nil end
  local m = store:get(ctx.at, ctx.where.chat, "tracker", "minutes") or 0      -- [host]
  local a = store:get(ctx.at, ctx.speaker, "tracker", "affection") or 0       -- [host]
  local who = cards:get(ctx.at, ctx.speaker, "card").name                     -- [host]
  return { depth = settings.get("depth", here(ctx)), role = "system",
           text = string.format("[It is %02d:%02d. %s's affection is %d of 100.]",
                                math.floor(m / 60) % 24, m % 60, who, a) }
end
function T.step(ctx)                        -- inserted after the step that stores a character's reply
  if ctx.stopped then return end            -- a reply the person stopped isn't judged
  store:apply(ctx.at, changes(ctx.at, ctx.where.chat, ctx.speaker, judge(ctx.reply)))   -- [host]
end
function T.scan(ctx)                        -- the note's text, for lorebooks to scan too
  local n = T.note(ctx)
  return n and n.text
end

-- lore.lua's activate gains also, the step's extra text, and scans it with the messages:
local scan = { at = ctx.at, speaker = ctx.speaker, active = {},
               scanned = table.concat(recent, "\n") .. "\n" .. table.concat(also or {}, "\n") }
-- ilse-lore.lua's activate gains also, and adds it to what the person said:
for _, t in ipairs(also or {}) do said[#said + 1] = t end
```

```
install  page: action { type = "install", pkg = { "$blob": "sha256:91d4…" } }
         root: review("tracker", extension): needs store (its need node), and edges to app's
         nodes, each with what it uses:
           app/chat-store  a narrow of app/store: store:describe{ of = "chat", mode = "rw" }:
                           "Can read and change everything chat keeps: your messages."
                           The tracker only reads, but the node it holds can write, and
                           the review says what the node can do
           app/connections model  openai's net (api.example.com), kobold's (192.168.1.20:5001)
           app/cascade narrow  settings-latest and settings-store: "Can read and change
                           your settings", with settings' own words for narrow
           app/kv          uses nothing
         and seven changes: the five edits, its scope, and what it runs after
         grant: one review: the host's text for the need and for each edge's uses, the app's
         words for the changes (placeholders: "Runs after each step that stores a
         character's reply, and gets everything that turn holds", "Adds a note to every
         prompt the app's prompt step builds", "Adds text for lorebooks to scan in the app's
         lore step", "Adds a button to messages", "Adds a section to settings", "Runs in
         every chat", "Runs after summarize"), each why as the tracker's words. Allowed;
         decisions kept under tracker@sha256:91d4…; the package is an entity at home, and
         home's "pkg.installed" gains tracker
t=0      page: action { type = "open", chat = 790, tab = "9a71…", device = "c2e8…" }
         root: 790's "chat" names Ilse's card; the rules resolved there are the declared level's:
         summarize's and the tracker's; both run, tracker after summarize
         (declared by tracker); no composition for that list: compose app and ilse, then
         summarize, then tracker; nothing unmatched
         reply: the chat's values and the explanation above, slots included, in one response
t=1m     send: ilse/user, then the turn: history; lore, the tracker's text scanned with the
         messages; prompt, the note 2 from the end; reply; store; summarize's step;
         tracker.step. app/steps, app/chat and app/prompt were loaded once for every
         composition; ilse's nodes once for this one
press    as in every option: action { type = "run", item = "tracker/recount", at = 822 };
         the root runs it only because a slot in this composition holds it
```

The person's rules, as stated in "which transforms run" above, one action each:

```
t=2m     laptop: action { type = "state", level = "user", name = "compose", value =
         [ { when = ["all", ["transform", "tracker"], ["card-tag", 44]], on = false } ] }
         store: the person's settings, field compose, at home; chat 790's watch fires (home is
         above the node it views); resolved again: Ilse isn't tagged, the list is the same,
         nothing sent
t=3m     open chat 812 with Maren, tagged no-tracker: tracker off ("user rule 1"); the list
         is summarize alone, a composition without the tracker's nodes. Every card tagged
         no-tracker shares it
t=4m     rule 2, { when = ["transform", "summarize"], after = [["transform", "tracker"]] }:
         790's watch fires; compose_order refuses: "these transforms each have to run after
         the other: summarize after tracker (user rule 2); tracker after summarize (declared
         by tracker)"; the page is sent the problem, and a send there gets it back
t=5m     rule 3, { when = ["transform", "tracker"], replace = true }: the tracker's own
         "after summarize" no longer counts; order tracker, summarize (user rule 2); a new
         list, a new composition, a new explanation sent
t=6m     phone (device 3f0c…): level "device", [ { when = ["transform", "tracker"], on = false } ]
         the device's settings, field compose, at its node; its watch fires; on the phone the
         tracker is off ("device rule 1"), the laptop's chats keep it
t=7m     phone, in chat 790: level "chat" at node 790, [ { when = ["transform", "tracker"],
         on = true } ]: chat is before device in compose's path, so in 790 the tracker runs
         on the phone too ("chat rule 1"), for every message under 790 and every branch
         made there; the phone's other chats still don't run it
t=8m     phone, tab 9a71…: level "tab", [ { when = ["transform", "summarize"], on = false } ]:
         that tab composes the tracker alone; the phone's other tabs keep summarize
```

Each of these is the same mechanism: a rule list at one level of the cascade, the levels in compose's path order, a condition over the transform and the context in each rule. The tracker's own settings resolve the same way: its note and depth are settings with its own schemas, so "no note on this device" is a device-level statement of tracker/settings/note, and tracker.lua reads it where the turn is.

Ilse's lore library is a node of her piece, handed to the app's lore step through an edge, so the person's extensions reach it as they reach any card's: the tracker's scan text goes into its scan list because the step is made from app/steps.lore, which the match names, not because Ilse named anything. Her piece names her steps (history, lore, prompt, reply, store), which B needed and D doesn't. Her books are her card's "lore.books", read where the step runs, and the speaker is the card the chat is with, so her piece names no entity.

```json
"lore": { "kind": "call", "name": "lore", "fn": { "$ref": "library", "export": "step" }, "with": {
          "books": { "$ref": "app/chars-store" }, "depth": 4 } }
```

```lua
-- ilse-lore.lua 4.1: the same activation, handed out as a step of its own
function L.step(w)
  return function(ctx)
    return { came_up = L.activate(ctx, w.books:get(ctx.at, ctx.speaker, "lore.books"), w.depth) }   -- [host]
  end
end
```

```
Ilse 4.1 makes her lore step her own code: a new card hash, so a new composition
t=0      open: the tracker's third edit matches nothing, since no node holds app/steps.lore;
         the reply's explanation lists { by = "tracker", edit = 3 } as unmatched, and the
         lore step as { node = "ilse/lore", fn = "ilse/library.step" }
t=1m     send: the lore step runs Ilse's code; the note still goes in the prompt and the step
         after the reply still runs, but lorebooks don't scan the note
```

When the card's lore step is opaque code, the person's extensions still reach everything it acts through: the lorebooks need and app/cond that ilse/library holds are edges (a wrap of app/cond sees every condition it checks), the step's place in the turn is a list member (an insert goes before or after it), and the step itself can be wrapped, which sees the ctx it's called with and the came_up it returns, so an extension can add to or filter what came up. What it can't reach is how Ilse decides what comes up from what it reads; for that an extension replaces the node, and the review says "Takes the place of" with the match, or patches ilse-lore's stored source, which is a new package hash for every Ilse version it patches. The scan didn't go in because the tracker's match described the app's lore step; an extension that wants every lore step whatever made it matches ["name", "lore"] or what the step holds, and wraps it.

## Gap 5, joining, option D: what it rests on

```
compose.lua, graph_match.lua, wiring.lua, review.lua, explain.lua, compose_order.lua,
settings.lua: content the root loads.
Necessary: none of it. Interpreting the graph is sandbox:load and calls through references,
which the root holds; the root is content, so a root with another graph format, or none,
is another root, and the core is unchanged.

Assumes: an extension finds its place by names a card gives.
  Rules out: reaching a card whose author named nothing (A's and B's cost).
  So: matches by kind, package, what a node is handed and the references it holds; a name
  is one operator.
Assumes: the composition is code that runs.
  Rules out: showing, explaining or reviewing an extension's place before anything runs.
  So: the composition is data, made by a pure function.
Assumes: an extension edits only the card's turn.
  Rules out: changing the app's own wiring (every model call, a UI slot).
  So: one graph: the app's piece, the card's and every extension's.
Assumes: edits from different extensions commute.
  Rules out: knowing what two extensions at one place give.
  So: an order, each extension editing what those before it made; the order is one
  constraint graph from what each declares and the person's rules (compose_order.lua).
Assumes: some kinds of node are the app's (host nodes).
  Rules out: the app's piece being content like any other.
  So: a reference enters only as a need node, and an edge to one is reviewed by what it uses.
Assumes: an extension runs with every card.
  Rules out: a scope, and the person's per-card, per-chat and per-device choices.
  So: a scope is a condition, overridden by rules through the cascade.
Assumes: an edit can reach inside a code node.
  Rules out: code nodes at all, or edits that parse code.
  So: code nodes are opaque; every input, output and capability of one is an edge.
Assumes: a composition per chat.
  Rules out: opening a card's chats without composing and loading again for each.
  So: by the card version and the transforms that run, in order, in memory, with values
  shared by node hash.
Assumes: adding an edge to another's node grants nothing.
  Rules out: seeing that an inserted step gets the turn's context.
  So: the review has a change for each edit (grant, above).

Still restrictive:
  what a code node decides inside is reached only by replacing the node or patching its
  source (the owner: a non-issue);
  a node id that other pieces hold is part of its piece's contract, like an export name;
  nodes can't hold each other; two modules that call each other need one of them handed
  the other later (a promise, or a directory module);
  a removal that leaves a required edge refuses the composition, so two extensions can
  be impossible together; the problems name them;
  the app's piece holds the widest needs because the root installed it, not by rule; an
  extension that holds an edge to one of its nodes is reviewed by what that node uses,
  and a module is described by what it holds, not by what it does with it.
```

The graph and its interpreter are content, as the root is. The one thing D changes outside content is grant:install's input, run through both tests above, because the review has to show what edits hand an extension and only grant's answer installs. Costs: composing once per card version and list of transforms that run; resolving the rules at each action; every edit is tested against every node; extension authors write matches, which are data but are a new thing to learn; and the review describes a match, not the cards it reaches, until a chat opens and explains itself.

## Gap 5, joining: upstream's hook points under each option

| Upstream | A: hook library | B: named steps | C: wrapping | D: the graph (decided) |
|---|---|---|---|---|
| `generate_interceptor` in the manifest, called with the chat, the context size, an abort and the generation type | An entry on a point before the prompt, returning a changed history; abort is raising | A wrap of "history" | A wrapper of chat.history | A wrap of every step that holds chat's history, returning a changed history; abort is raising |
| `setExtensionPrompt(key, value, position, depth, scan, role)` | An entry on prompt.notes returning { depth, role, text }; scan is an entry on lore's point that adds its text to what's scanned | A wrap of "prompt" using prompt.at_depth; scan is a wrap of "lore" | A model wrapper; scan has no reference to wrap unless lore is one the card is handed | An insert into the notes of every step that holds prompt's assemble; scan is an insert into the scan list of every app lore step, and a wrap where a card's lore step is its own code |
| Post-reply processing on `MESSAGE_RECEIVED`, `CHARACTER_MESSAGE_RENDERED` | An after_reply entry | An edit after "store" | A wrapper of chat.append, or store:watch on "chat.message" | An insert after every step that hands chat's append the role "assistant" |
| Message toolbar buttons (`.extraMesButtons`) | The message.actions slot, in A, B and C | | | An item node inserted into the message.actions slot node |
| Settings panels (`#extensions_settings`) | The settings slot, in A, B and C | | | An item node inserted into the settings slot node |
| Slash commands (`SlashCommandParser.addCommandObject`) | The commands slot, in A, B and C | | | An item node inserted into the commands slot node |
| Other `eventSource` events | A point per event, where the card runs it | A step to go after | store:watch or latest:watch, or a wrapper of what the event was about | An insert next to the step that causes it, or a wrap of the node it was about; a change to state is store:watch or latest:watch |
| `loading_order`, `dependencies`, `requires`, `optional` | "after"; needs on another install's exports; optional needs | The same | The same | "after" and "before" as conditions over transforms, in one graph with the person's rules; an edge to another install's node; "required": false on an edge or a need node |

Upstream extensions aren't supported (project rule), so this is where each purpose lands, not a compatibility layer. In D an upstream hook is never a place a card has to provide: the match finds the step by what it holds. In every option a page event that upstream broadcasts becomes the action that caused it, and a change to state is a watch (gap 4), so nothing here needs an event bus.

## Gap 5, joining: what each option costs

A keeps the card in charge of where extensions run and is closest to what extension authors know; it costs a vocabulary of point names, a registry read every turn, and extensions that silently miss a card that doesn't run their point. B makes the turn a value that is composed once, inspected and explained, and reports an extension that found no place; it costs card authors naming their steps and limits extensions to going after or around a step. C needs nothing from cards and adds no concept to the model; it costs extensions seeing only what passes through a reference, so a prompt note that needs the turn's context has to infer it, and it rules out parallel turns in one chat for stateful wrappers. The UI slots, the manifest's needs, ordering by "after", and how a card's brought modules are reviewed are the same in all three. In none of the three does a choice add to the core, and in each, whether the person can turn an installed extension off for one card is a key the root reads (the owner's, as a UX decision; under D, decided as rules through the cascade). The owner chose D (decisions of 11-14), which has each of the three as a special case and drops their limits on reach: it finds a card's steps by what they hold rather than by names, reaches the app's wiring as well as the turn, composes once into a value that is explained and reviewed from its edges, and reaches custom code through every edge it holds. Which transforms run where, and in what order, are the person's rules resolved through the settings cascade. Its own costs are under "what it rests on"; it adds nothing to the core, and its one change outside content is to grant:install's input.

## Gap 6, lifetime outside the store: pins, leases, release

```
A value in the store or latest names a blob as { "$blob": "sha256:…" } and a hold as
{ "$hold": 77 }. Each lives while something names it or while its lease lasts:
  disk:put(bytes)        -> { "$blob": hash }   leased for an hour
  holds:new(data)        -> { "$hold": id }     leased for an hour; data: what its
                                                owner needs to clean up after it
  each kept change result in the store, and each current value in latest, that names
  one pins it; dropping the node, or overwriting, deleting or expiring the key, unpins it
With no pin and no lease: a blob is deleted; a hold's data goes on its kind's release
list, and holds:released(sink) pushes every entry on it until holds:done(id).
A host resource (a vector index, a model session) is a hold its host module made and
cleans up itself.

-- provider_files.lua: a file uploaded to a model provider lives while a value names it
return function(c)
  local holds, net, json = c.holds, c.net, c.json   -- holds narrowed to this module's kind
  local P = {}
  function P.upload(bytes)
    local res = net:fetch{ method = "POST", url = "https://api.example.com/v1/files", body = bytes }  -- [host]
    return holds:new{ provider_file = json.decode(res.body).id }    -- leased until stored   -- [host]
  end
  function P.start()                        -- the root runs this at start
    local sink = {}
    function sink:push(r)                   -- a push that raises stays on the list
      net:fetch{ method = "DELETE", url = "https://api.example.com/v1/files/" .. r.data.provider_file }
      holds:done(r.id)                                                      -- [host]
    end
    function sink:close() end
    holds:released(sink)                                                    -- [host]
  end
  return P
end

store:drop(790): the chat and every message under it
  change results at 811…925 named sha256:4b1e… and hold 77
  sha256:4b1e…: 2 pins → 0, no lease: deleted
  hold 77: 1 pin → 0: { id = 77, data = { provider_file = "file-abc" } } on the list
  provider_files.lua: DELETE file-abc, then done(77)
```

Lifetime is a contract of the host modules (store, latest, disk, holds): a reference count of the kept values that name a thing, plus a lease covering the time between making it and storing the value. Pins count kept change results, not current values, because a revert can bring an old value back; a blob replaced in a chat stays until its node is dropped. Nothing is ever swept: cost is one count update per name in a change result and one per name when its node is dropped, and expired leases are found by an index on time. An upload that is never stored, or a crash before the apply that names it, ends with the lease. Release is durable: the list is the holds module's own and a module drains it at start, so a crash between a drop and the cleanup loses nothing. Assumes: whatever owns a thing outside the store is a value in the store or latest. Rules out: a thing kept alive by a module that's running but has stored nothing (it renews the lease, or stores a value). The holds module is necessary because only the store and latest know when the last value naming something is gone.

## Gap 6, lifetime outside the store: quotas

```
accounts:new(limits)   -> account; limits = { bytes = n }
x:charge(account)      -> store, latest, disk, holds or vectors, charging what is stored
                          through this reference to account
account:usage()        -> { bytes = n }
A write that would go over raises "over quota" and isn't made; evictable latest keys
go first, least recently read. A blob or hold counts once in each account whose writes
pin it, and stops counting when that account's last pin goes.

-- in root.lua
local acct = caps.accounts:new{ bytes = 2 * 2^30 }                          -- [host]
local rag  = load("rag", {
  store   = caps.store:charge(acct):narrow{ nodes = { home }, components = { "rag" }, mode = "rw" },  -- [host]
  latest  = narrow(caps.latest:charge(acct), "rag/", "rw"),                 -- [host]
  disk    = caps.disk:charge(acct), vectors = caps.vectors:charge(acct),    -- [host]
  embed   = embed })
```

Quotas are a host module, because only the store, latest, disk and holds see every byte they keep, including pins made by values. Each charged reference is a narrowing like any other, so a module's quota is in what it was handed. Assumes: space is the limited thing. Rules out: limiting calls or GPU time with it; a call rate is a net wrapper (ratelimit.lua, gap 7), and charging inference time would be infer's own (I don't know whether that's wanted). A blob shared by two accounts counts in both, so the accounts' usage can add up to more than the disk holds. How much each installed module gets is decided when it's installed (gap 5's manifest), and showing usage is the display handle's (the owner's).

## Accounts: one store, a home node each

```
Decided by the owner: accounts share one store. Each account is a node in it.

   base node           content shared between accounts: a card imported by two people, a common
     |                 starting library; copy-on-write, as the version store shares everything
     |                 above a branch
     +-- account A     A's home: what A made or changed; A's chats are nodes under it
     |     +-- chat
     +-- account B
     +-- chat 55       a multiplayer chat: a child of the base node that A's and B's scopes include
```

An account that changes shared content writes the change at its own node, as a row; the content is not copied (indexes: "Indexes under branching", with accounts). Privacy is the capability scopes: A's grant narrows the store to A's node and what is under it, and to the shared content for reading. Quotas are charged per reference (gap 6): what an account's writes add under its node is charged to it, and shared content is charged to nobody in particular, or to whoever owns the base node (I don't know which). Deleting an account drops its nodes (`store:drop`, gap 6), so the pins its values held go with them. Images and other blobs are by content hash, stored once across accounts; each account that has a value naming one pins it and is charged for it (gap 6), so usage can add up to more than the disk holds, and a blob goes when its last pin goes.

```
An account, in the model:
  identity      a login and a password; sessions renewed by any request and expiring after
                inactivity (no timer on a page); sessions are latest (gap 2), never history
  home          its node in the shared store
  scopes        the capabilities its grant mints: narrowings of the admin's ceiling ("an admin's
                ceiling"), one of them the store narrowed to its home
  quotas        what its references charge (gap 6)
An admin is the ceiling on what an account can be granted, and holds no other power over what
an account does with what it holds.
Settings snapshots are settings history: settings at every level are changes in the store
(the cascade), so an earlier state of them is a node, and a person who wants it back reverts
to it. There is no second kind of copy.
```

This is a redesign of accounts, not a port of upstream's, after the state model. Upstream keeps a folder of files per user. The owner thinks per-user folders are a leftover of upstream's file-as-database era: a folder is how a database made of files tells whose data is whose, and here the node and the scopes do that. What the redesign has to answer is listed in "Questions still open" (9 to 11). Not decided here: how accounts are created and removed (the install page, an admin's page), what a login looks like, and where the password's hash is kept.

## Store integrity: what the store must promise, and what the engine has

Requirements (the owner's):

```
1. A checksum on every page or record, verified on read.
2. Copy-on-write and append-style writes; nothing is overwritten in place.
3. A write-ahead log with checksums: a torn write is detected and rolled back on open.
4. Background scrubbing that re-verifies what is stored.
5. Backups at the level of pages, so only damaged pages are restored.
```

What the engine has today (`engine/src/log`, `engine/src/keyspace`, `engine/src/store`; the promises are `engine/CONTRACT.md` G1, G2, G13 and the fault-injection row):

```
1. Checksums
   exists   the record log: a crc32c per group of records, seeded with the group's position, in a
            5-byte trailer (log/mod.rs group_seed, whole_group_at; log/format.rs TRAILER);
            keyspace data and index blocks: a crc32c at the end of each, checked whenever a block is
            read from disk (keyspace/block.rs Block::parse, called from run.rs read_block);
            a run's 64-byte footer, and its kinds bitmap (run.rs read, Kinds::parse)
   missing  nothing checks a block until it is read, so damage to a block no query reads is
            not found; a damaged block makes the read fail (KsError::Corrupt), with no repair;
            no checksum on a run as a whole or on the files outside the log and runs (the bulk
            load's marker, the directory lock)
2. No overwrite in place
   exists   the log is append-only, in files of 16 MB (log/mod.rs FILE_TARGET); a run is written to a
            temporary file, synced, renamed into place and the directory synced, and is never
            changed afterwards (keyspace/mod.rs around the rename, run.rs RunWriter::finish);
            a merge writes a new run and marks the inputs obsolete before deleting them
   missing  restamp (run.rs) rewrites a run's footer in place during a bulk install (bulk.rs
            install); the log is truncated at open (below). The bulk path has no fault hooks
3. Write-ahead log
   exists   the log is the write-ahead log: commit() resolves after sync_data on the log
            (log/mod.rs, G1); at open the last file is scanned group by group, and a torn or
            wrong-checksum tail is truncated to the last whole group and synced (log/mod.rs open,
            set_len); damage that has whole groups after it refuses to open and changes nothing
            (LogError::Corrupt, find_damage; G2). Runs are derived from the log and replayed from
            the covered position at open (G12, G13). Crashes, torn writes, EIO and ENOSPC at
            every I/O operation of a workload are injected in store/fault_tests.rs
   missing  a rename or new file lost because its directory wasn't synced is not modelled
            (CONTRACT.md); nothing in the log is replicated or repaired: the damage case stops
            the open and waits for a person
4. Scrubbing
   exists   none. Verification happens at open (footers, top blocks, the log tail) and on reads
   missing  a background pass that reads every block and group, finds damage early, and reports it
5. Backups at page level
   exists   none: no backup, no copy of pages, no restore
   missing  a way to take a copy of the store's pages and to put back only the damaged ones; the
            log files and runs are immutable once written, which makes a page-level copy natural
            but nothing uses it
Blobs and images: the engine has no blob store (`grep` for blob/sha256 in engine/src finds nothing),
so content-hash blobs, their pins and per-account charges (gap 6) are not in the engine at all.
```

What is missing, as work: a scrub job, page-level backup and restore, and a way for a read that finds a bad block to ask for the page back instead of failing; the verification on read, the append-only layout and the checksummed log with rollback on open exist and are tested.

## Gap 7, granting at runtime: prompts the host draws

```
grant:for(install)  -> the grant reference the root hands one installed module
  g:net{ hosts = { "192.168.1.20:5001" }, why = "…" }  -> a net for exactly those, or nil
  g:folder{ mode = "r", why = "…" }  -> files narrowed to the folder the person picks, or nil
  g:file{ types = { "image/png" }, why = "…" }  -> the picked file's blob, or nil
The page host draws the prompt where no module's display reaches, and shows the
install's name and the request as the host read it; why is shown as the module's words.
The person can answer once or always; "always" is kept in grant's own storage under
the install and minted again when the root calls grant:for at the next start.
What's granted is a revocable forwarder; revoked (from a host screen), its next call
raises "revoked". On the server, grant asks on the person's open pages and the first
answer wins; with none open it raises "nobody to ask" unless the request gives a wait.

files (server: the machine's filesystem; page: what the person picked)
  f:list(path), f:read(path), f:write(path, bytes), f:stat(path)
  f:only(path, mode) -> narrowed to a folder; no path leaves it (opened beneath it,
                        so neither .. nor a symbolic link escapes)

t=0      a backend adapter calls g:net{ hosts = { "192.168.1.20:5001" }, why = "Your KoboldCpp" }
t=1ms    grant → the person's pages: the page host draws its prompt
t=4s     the person allows it, always, on one page; the other pages' prompts close
         grant keeps { "install": "kobold-adapter", "net": [ "192.168.1.20:5001" ] }
         and returns a forwarder over net:only(test for 192.168.1.20 port 5001)
restart  the root wires kobold-adapter, calls grant:for: the same net is minted again
later    the person revokes it: the adapter's next fetch raises "revoked"
```

Granting is a host module, because the prompt has to be one no module can draw: a module that paints a look-alike in its own display gets nothing, since only the host's prompt mints, and while it is up the person's input goes to the host. It narrows what the root holds (net, files) into a new reference on the spot; nothing else about authority changes. Assumes: the person answering is the person who installed the module. Rules out: a module asking for authority it has no grant reference for (the root decides who may ask). Costs: the root keeps one grant reference per install, and asking is itself authority, so a module can pester; rate limits on asking are grant's. Where and how the prompt is drawn, and the screen that lists and revokes grants, are the display handle's and the host's own screens: the owner's decisions, and grant can't ship before them. The install name it shows comes from the manifest (gap 5).

## Gap 7, granting at runtime: net narrowed by a test, and rate limits

```
net:only(test) -> a net that, for every connection, every redirect included:
  resolves the name once, calls test{ scheme, host, port, ip }, and connects only to
  that ip, so a name that later resolves elsewhere (DNS rebinding) can't move it;
  through a proxy, it connects by the ip it tested (CONNECT ip:port).
  On a page the browser hides the address, so ip is nil there.

-- public.lua: a test for net:only, "any public host"
return function(c)
  local ip = c.ip                           -- address parsing and ranges (content)
  local private = ip.ranges{
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3",
    "::/127", "fc00::/7", "fe80::/10", "ff00::/8" }
  return function(d)
    if d.scheme ~= "https" and d.scheme ~= "http" then return false end
    if d.ip == nil then return false end
    return not private:has(ip.embedded_v4(d.ip) or d.ip)   -- ::ffff:a.b.c.d, 64:ff9b::/96, 2002::/16
  end
end

-- ratelimit.lua: a net allowing n fetches per ms
return function(c)
  return function(net, n, ms)
    local times, R = {}, {}
    function R:fetch(req)
      while true do
        local now = c.clock:now()                                           -- [host]
        while times[1] and times[1] <= now - ms do table.remove(times, 1) end
        if #times < n then break end
        c.clock:sleep(times[1] + ms - now)                                  -- [host]
      end
      times[#times + 1] = c.clock:now()
      return net:fetch(req)                                                 -- [host]
    end
    return R
  end
end
```

Net gains one narrowing, by a test it calls with the address it will connect to; that is a change to a host module, and the only part of this gap that has to be host, because only net knows the resolved address and can pin it. Everything else is content: which addresses count as public is a library (public.lua), a LAN grant is a test for one address and port, and a rate limit is a wrapper whose check and count happen between two waits, so tasks can't race it. Assumes: a destination is an address and a port. Rules out: on a page, any test that needs the address (the browser's own private-network rules apply there instead). Costs: one call into the test per connection; getting the ranges right is a library's job, so its authors have to keep it current.

## Capabilities from crescent: switching a provider mid-session

Crescent (`~/git/rhizone/crescent`, master: `docs/artifacts/2026-07-09-platform-caps-design/notes.md`) holds that a capability is at the right level when it is a swappable unit: "switch LLM providers mid-session, migrate storage backend live", and, from its owner, "capabilities are not just for security… flexibility would be a sick feature". In this model a reference already is that unit, so the switch is a forwarder whose target can change, and it is content.

```lua
-- switch.lua: a forwarder whose target whoever holds its control can change
return function()
  return function(target, names)            -- names: the exports the contract has
    local function check(t)                 -- a target lacking one is refused, not found out at a call
      for _, n in ipairs(names) do
        if t[n] == nil then error("the new target has no " .. n, 0) end
      end
    end
    check(target)
    local front, control = {}, {}
    for _, n in ipairs(names) do
      front[n] = function(...) return target[n](...) end
    end
    function control.set(t) check(t); target = t end
    return front, control
  end
end

-- connections.lua: which adapter answers the model calls of what it's handed to
return function(c)
  local latest, kv, adapters = c.latest, c.kv, c.adapters   -- adapters[name]: an adapter's exports
  local front, control = c.switch(adapters[latest:get("connections/active") or c.default],   -- [host]
                                  { "generate", "generate_json", "stream" })
  local M = { model = front }
  function M.use(name)
    local a = adapters[name]
    if not a then error("no connection named " .. name, 0) end
    latest:apply{ { "connections/active", kv.set, name } }                  -- [host] kept first
    control.set(a)
  end
  return M
end

-- in root.lua
local kobold      = load("kobold", { net = secrets:net("kobold"), json = json, base = "http://192.168.1.20:5001" })
local connections = load("connections", { latest = only_latest("connections/", "rw"), kv = kv,
                                          switch = load("switch", {}), default = "openai",
                                          adapters = { openai = model, kobold = kobold } })
local ilse        = load("ilse", { store = cards, me = 7, chat = chat, lore = lore, prompt = prompt,
                                   model = connections.model, tracker = tracker, condense = condense })

t=0      ilse holds connections.model; a reply streams from openai through it
t=2.1s   page: action { type = "connection", use = "kobold" }
         root: connections.use("kobold"): latest connections/active = "kobold", then the switch
         the reply in flight keeps streaming from openai: its call had already gone through
t=2.1s   reply to the action: { connection = "kobold" }; pages watching connections/ follow
t=9s     the next turn's model.stream goes to kobold; ilse can't tell
restart  connections.lua reads connections/active and starts on kobold
```

A connection is which adapter answers, and each adapter holds its own key through secrets:net (decided: "a connection is which adapter module holds which key"). Necessity: none of this is a primitive; a switch is a reference that forwards, built from the two the core has. It restricts nothing: anything that holds a reference can put a switch in front of it, so a card can switch its own model, the tracker can be handed a different switch from the card (a cheap model for bookkeeping), and a migration can switch a disk or latest it holds once a copy job (gap 3) has caught up, writing to both while it copies. Assumes: the targets share a contract, named by the list. Rules out: a target switched under a call already made (that call finishes where it went, which is what keeps a stream whole). Still restrictive: the module holding the front isn't told; one that must be is handed a watch of connections/ as well. The version store can't be moved this way: its ids are names that only the store resolves, so moving it is the host's own work. Whether connections/active is one key for the app or one per chat or per card is a settings scope (`settings-scopes.md`), the owner's.

## Capabilities from crescent: needs in a manifest, the install review, and presets

```json
{ "name": "tracker", "version": "2.0.0", "main": "tracker.lua", "tags": [ "tracker" ],
  "needs": {
    "store":    { "what": "store", "mode": "rw", "required": true,
                  "why": "Keeps the time and each character's affection at every message" },
    "chats":    { "what": "store", "of": "chat", "mode": "r", "required": true,
                  "why": "Reads a reply again when you ask for a recount" },
    "settings": { "what": "latest", "mode": "rw", "required": true },
    "model":    { "what": "model", "required": true,
                  "why": "Asks the model how much time passed in each reply" },
    "kv":       { "what": "export", "of": "kv", "required": true },
    "sheet":    { "what": "net", "hosts": [ "sheets.example.com" ], "secret": "sheets",
                  "varies": [ "hosts" ], "required": false,
                  "why": "Copies the meter to your spreadsheet" },
    "space":    { "what": "space", "bytes": 10485760, "required": true } } }
```

```
A need names what it wants, whether the module runs without it, and why, in the module's
own words. "store" is the module's own components, named by its install name ("tracker",
and names under it), and "latest" its own keys (tracker/), so two modules can't collide
and none can name its way into another's; "of" asks for another install's components or
keys, and the review names that install. "export" is
another install's exports, which is how a dependency is said. A need the root provides by
contract ("model") is whatever the root hands for it (connections.model above). "secret"
makes the net one that carries a key the person picks or enters: the key goes to
secrets.lua, never to the module. "varies" lists what the person is expected to change.

grant:install(install, manifest) -> decisions, or nil if the person refused
  the host draws one review of every need (decided: a host-drawn modal), each with the host's
  text for it (below), the module's why kept apart as the module's words, and the values of
  the preset the rules picked. Nothing is granted unless the person allows it; closing the
  review grants nothing. A required need refused means not installed.
  decisions are kept in grant's own storage by install and package hash. An update whose
  needs are the same asks nothing; a new or widened need is asked on its own; a narrowed
  one keeps its decision.
grant:needs(install) -> { [need] = a reference minted again, true for an allowed need the
                          root provides, nil for an optional need refused }
grant:match(fn)      the root hands grant a pure fn(manifest, when) -> boolean for rules
presets and rules    in grant's own storage, written only from the host's own screens, so
                     no module can change what a preset gives; grant ships with none

{ "key": "grant/presets/trackers", "value": {
    "store": { "allow": true }, "latest": { "allow": true }, "model": { "allow": true },
    "space": { "bytes": 52428800 }, "net": { "allow": false } } }
{ "key": "grant/rules", "value": [
    { "when": [ "all", [ "tag", "tracker" ], [ "asks", "model" ] ], "preset": "trackers" },
    { "when": [ "asks", "model" ], "preset": "my-usual" } ] }
```

```lua
-- grant_rules.lua: what a preset rule can test, as cond.lua operators over a manifest
return function(c)
  local cond = c.cond                       -- a cond of its own, so these names reach nothing else
  cond.define("asks", function(m, what)
    for _, decl in pairs(m.needs or {}) do if decl.what == what then return true end end
    return false
  end)
  cond.define("tag", function(m, tag)
    for _, t in ipairs(m.tags or {}) do if t == tag then return true end end
    return false
  end)
  return function(manifest, when) return cond.holds(when, manifest) end
end

-- in root.lua: rules, then wiring an installed module from the person's decisions
caps.grant:match(load("grant_rules", { cond = load("cond", {}) }))          -- [host]
local provided  = { model = connections.model }   -- what this root hands by contract
local installed = { kv = kv, cond = cond, prompt = prompt }   -- exports by name: what ships, then each install
local function wire(name)
  local p = pkg(name)                                                       -- [host] { manifest, source }
  local got, given = caps.grant:needs(name), {}                             -- [host]
  for need, decl in pairs(p.manifest.needs) do
    local v = got[need]
    if v == true then v = provided[decl.what] or installed[decl.of] end
    if v == nil and decl.required then error(name .. " can't run without " .. need, 0) end
    given[need] = v
  end
  installed[name] = caps.sandbox:load(p.source, p.manifest.runtime or "lua", given)   -- [core]
  return installed[name]
end

t=0      page: action { type = "install", pkg = { "$blob": "sha256:77c0…" } }
         root: unpacks it, grant:install("tracker", manifest)
         grant: rules in order; the first matches (tagged tracker, asks for a model): trackers;
         sheet starts refused (net: allow false)
t=2ms    the review is drawn on the person's pages, every need listed, trackers' values in it
t=6s     the person allows it as it stands; grant keeps the decisions under tracker@sha256:77c0…
         root: wire("tracker"); sheet is nil, and tracker.lua runs without the spreadsheet
t=6s     reply to the action: { installed = "tracker" }
update   2.1.0 adds "clock": only that need is asked
```

Crescent's grant presets (`docs/platform-design.md`, "Grant presets and install UX") are taken as they are: named bundles the person writes, picked by the first rule that matches, a starting point the person still confirms, and no preset shipped ("Predefined presets are unacceptable — the system must not decide what's 'normal'", notes.md). Its rule language was left undesigned ("sexpr dsl structured editor style conditions"); here it is cond.lua data, the same shape as lore's conditions, so the structured editor that edits one can edit both. Presets and decisions are grant's because a preset is authority waiting to be handed out: a module that could write one could give itself anything at the next install. The matcher is content because it only suggests; whatever it picks, the person confirms. Optional needs are crescent's too: the module gets nil and handles it, so the author splits needs where the module can do without one. Costs: every installed module's needs are reviewed once per package hash; a card that brings modules is reviewed when it's imported (gap 5), and a decision is kept by package hash, so a library a thousand cards bring is asked about once. What ships with the app is wired by the root without a review, as root.lua does above; whether the person sees those too is the owner's.

## Capabilities from crescent: whose words say what a grant allows

```
Each host module grant mints from describes a narrowing of itself:
  net:describe{ hosts = { "sheets.example.com" }, secret = "sheets" }
    -> { text = "Can send anything this module is given to sheets.example.com, with your
                 key for it. Once sent, it is out of this app's hands." }
  files:describe{ path = "/home/ren/notes", mode = "r" }
    -> { text = "Can read every file in /home/ren/notes." }
  store:describe{ own = "tracker" }      -> { text = "Keeps its own data. No other module can read it." }
  store:describe{ of = "chat", mode = "r" }  -> { text = "Can read everything chat keeps: your messages." }
  accounts:describe{ bytes = 10485760 }  -> { text = "Can use up to 10 MB of space." }
A need the root provides by contract is described by what provides it:
  model -> connections, which can reach api.example.com (openai) and 192.168.1.20:5001
           (kobold): each install's own host grants, described as above
  plus the provider's own description, shown as that module's words
grant:provides("model", { "openai", "kobold" })   the root tells grant who stands behind a contract
```

Crescent writes one risk text per capability type, in the capability's factory, never in the manifest (`lib/platform/cap_dispatch.lua`'s `M.risk`, `docs/daemon-design.md` "Cap risk disclosure"), and shows the app's reason beside it as the app's own words. The model keeps the rule and moves the text to where the power is. A host module's text is authoritative, because only it knows what its narrowing allows, and it fills in the exact hosts or folder. A capability that is content can do at most what its module holds, so its authoritative text is the host text of what that module was granted, followed through every provider; the provider's own description is shown as its words, the way a module's why is. Examples of wording above are placeholders; the words are the owner's. Crescent's code also returns a severity with each text; whether there are tiers, and what each tier does to the review, is the owner's.

## Capabilities from crescent: an admin's ceiling

```lua
-- in root.lua, for each person who logs in: their grant can only narrow what the admin left them
local policy = load("policy", { latest = only_latest("admin/policy/", "r") })   -- the admin's limits, content
local function grant_of(person)
  local p = policy.of(person)
  return caps.grant:narrow{                                                 -- [host]
    net   = caps.net:only(p.net_test),        -- p.net_test reads the admin's current limits    -- [host]
    files = p.folder and caps.files:only(p.folder, p.folder_mode),          -- [host]
    store = caps.store:narrow{ nodes = { p.home }, mode = "rw" },          -- [host] every component
    space = caps.accounts:new{ bytes = p.bytes },                           -- [host]
  }
end

grant:narrow{ net, files, store, space, ... } -> a grant that mints only narrowings of these;
  a need its references can't meet is shown as not allowed here before the person is asked,
  and a required one means the install can't go ahead

t=0      the admin limits Ren to public hosts; Ren's grant holds net:only(public)
t=1m     Ren installs the kobold adapter, which asks for 192.168.1.20:5001
         grant: the test refuses 192.168.1.20; the need is required, so the review says the
         install isn't allowed on this server, and nothing is asked
t=3m     the admin allows Ren's LAN address; p.net_test sees it at the next connection
```

Crescent's admin policy (`lib/platform/policy/init.lua`) can only restrict: it denies a capability type or narrows its parameters, and checks each declaration against them (`check_cap_decl`). Here the ceiling is what Ren's grant holds, so a grant above it can't be minted at all; nothing checks a declaration, and a new kind of capability is under the ceiling without the policy knowing its name. That is construction instead of detection, and it costs nothing at use: every reference minted from Ren's grant is already a narrowing of the admin's. Tightening reaches what was minted before because the test runs at every connection, and a folder or quota the admin can take back is a revocable forwarder at the ceiling. Still restrictive: the admin limits what's handed, not what a person does with what they hold; which modules a person may install is the root's install export loading only from the admin's list.

## Capabilities from crescent: where the two differ

| | Crescent | This model | Taken, and why |
|---|---|---|---|
| What a capability is | A fixed set of types the platform implements (`cap_dispatch.lua`'s table) | No list: any export is a reference | The model's: a fixed list rules out every capability the list lacks |
| Narrowing | "No partial grants, no narrowing. The app's manifest declaration *is* the scope" | Every reference narrows; grant can mint less than a need asks (read for read-write, fewer hosts) | The model's, which is less restrictive; crescent's split into several named needs still works. Whether the review offers less than asked is the owner's |
| Swapping | Host-side, with live swaps "a host/script agreement" over signals | switch.lua: content, the user of the front unaware | The model's: no agreement needed, and any holder can switch, not only the host |
| Admin limits | A policy file checked against each declaration | What the person's grant holds | The model's: construction, not a check, and it covers capabilities the policy doesn't name |
| Risk text | Per type, from the factory | From the host module, and through providers for content | Crescent's rule; the model follows it through content |
| Sensitive fields | Stored with the other overrides, masked in the UI only ("currently a UI hint only") | A secret never reaches the module: the person's key goes to secrets.lua, the module gets a net that carries it | The model's: the key can't leak from a module that never has it |
| Fields the operator changes | `configurable_fields` as a hint; any known field overridable, checked when the cap is built | "varies" as a hint; the person changes a narrowing's parameters, checked by the host module as it mints | Both the same idea; the model checks at the review, so a bad value is refused before anything runs |
| Revoking | A flag in each cap's closure; calls return `nil, "capability revoked"` | A forwarder; calls raise "revoked" | The same; raising matches "gone" and "cancelled" |
| Presets, rules, re-asking only for a manifest's new needs | As above | As above | Crescent's |

Crescent's grant page rules (`docs/daemon-design.md`, "Browser approve flow") are screen design, so they are recorded here for the owner, not taken: Deny is the primary button, with the default focus; every box starts unchecked; the app's reason is shown in brackets, marked as the app's own words; a settings page lists every app's grants with a revoke for each and for all; friction grows with risk (typed or held confirmation for the widest grants, a short delay before submit); "just this session" grants; an opt-in auto-grant of harmless capabilities. What the model fixes regardless: nothing is granted without the person's answer, the module's words reach the host's screen apart from the host's own text, and only grant's own screens write presets and decisions.

## Gap 8, heavy work and libraries: what runs where

```
Pure computation is content, in the wasm runtime: one build, the same results on both sides.
  regex        an ECMAScript-compatible engine (the regress crate), Unicode tables pinned
  unicode      ICU4X: case folding, normalization, segmentation, collation
  tokenizers   the Hugging Face tokenizers crate
  zip, PDF, images   the zip and image crates, pdfium
What needs hardware or the OS is a host module.
  infer     server: ONNX Runtime (CPU, CUDA); page: onnxruntime-web (WebGPU, else wasm)
            infer:open(model_blob, options) -> session; session:run(inputs) -> outputs;
            a tensor is { dtype, shape, data = byte string }, or a blob when large
  vectors   a native nearest-neighbour index; each index is a hold (gap 6)
  proc      server: proc:only(executable) -> p; p:spawn(args) with stdin, stdout and
            stderr as sinks; video goes through it (ffmpeg)
  browser   server: a headless browser whose traffic goes through a net it's handed,
            so net's tests (gap 7) hold for every page it loads
Randomness, outside deterministic mode: math.random, seeded from the host's secure
  generator, and random_bytes(n); math.randomseed(n) gives the same sequence on both sides.
Runtimes: "lua"; "wasm" (Wasmtime on the server; on a page the browser's WebAssembly, with
  fuel checks added at load so it runs on the caller's thread within its budget);
  "js" (a page: a worker in an opaque-origin frame with no network; the server: QuickJS).
Who brings what: an extension can bring wasm or js modules, which hold only what they're
  handed; native code can't be confined, so only the person running the server adds a
  host module.
```

Heavy work splits by whether it needs more than a CPU. Pure computation is content in the wasm runtime that the sandbox primitive already allows, which gives regex, Unicode and tokenizers identical results on the server and the page from one build, and lets extension authors bring native-speed libraries without the core trusting them. Inference, processes and the headless browser need the GPU or the OS, so they are host modules. Assumes: what must match on both sides is pure. Rules out: an extension shipping native code (a CUDA kernel, a Python library) except as a host module someone installs on purpose; wasm threads on a page unless the page is cross-origin isolated, which is a deployment choice. Costs: wasm calls copy text in and out; wasm regex is slower than the browser's own, which differs across browsers and so can't be the same on both sides; fuel checks cost something on a page. None of these has been measured. A process proc spawns holds whatever that program can do, so proc is narrowed to one executable and should be handed out rarely.

## Gap 8, heavy work and libraries: a wasm library from Lua

```lua
-- in root.lua: a wasm module handed no references can do no I/O
local regex   = caps.sandbox:load(pkg("regex").source, "wasm", {})               -- [core], [host]
local unicode = caps.sandbox:load(pkg("unicode").source, "wasm", {})             -- [core], [host]
local cleanup = load("cleanup", { regex = regex, unicode = unicode })

-- cleanup.lua: a reply cleanup step
return function(c)
  local ooc = c.regex.compile([[\s*\(OOC:[^)]*\)]], "giu")   -- ECMAScript syntax and flags
  return function(ctx)
    return { reply = c.unicode.normalize(ooc:replace(ctx.reply, ""), "NFC") }
  end
end
```

A wasm module's exports are references like any other module's, so a Lua module can't tell a wasm library from a Lua one, and the same step runs on the server or the page. compile returns a reference to the compiled pattern, which stays inside the wasm sandbox.

## Gap 8, heavy work and libraries: JS libraries and the display

```
DOM-free JS libraries (a Markdown parser, a diff): the "js" runtime, as a module.
Libraries that need a DOM (CodeMirror, Cytoscape, React), one of:
  a. the host provides the widget (a code editor, a graph view) in the display handle;
     the library runs in host code and modules hand it values
  b. the display handle offers a framed area: a module gets its own DOM in an
     opaque-origin frame with no network, sized by the display, talking by values
     and references
DOMPurify: no module puts HTML into the app, so nothing of theirs needs it. If the
display handle accepts HTML or Markdown (card messages carry HTML), sanitizing is the
display handle's own job.
```

Which of a and b exists, or both, is the display handle's surface, so it is the owner's decision; until it is made, no module can use a DOM library. Both are possible without changing the core. A costs a host widget per library and limits modules to what the widget exposes. B costs a document per frame, focus and accessibility across frames, and the frame's size has to be settled before it draws so there's no layout shift.

## What provides each point and feature

| Point or feature | Content that provides it |
|---|---|
| provider | A function returning messages, in the parts list a card hands prompt.assemble |
| condition type | An operator a module adds with cond.define, or any function |
| book type | Entities with "lore.entry" naming the book, which lore.activate queries; another kind of book is another module handing lore its entries |
| input handler | A module that takes a file or URL from a page action, parses it, and writes through its store capability; export is the reverse |
| rewrite step | A step that rewrites ctx.reply or ctx.messages, or a wrapper around a part |
| command | A function a module exports: run from a page action, offered to the model as a tool by a tools module, or put in a turn’s steps |
| setting schema | Data a module ships about its own settings: the default, how statements combine, and the path the value resolves along (which levels and which relation kinds it follows, in what order); settings.lua resolves it, and whatever edits it reads it |
| backend adapter | A module holding a net capability for one host (openai.lua) |
| Chats, swipes, branches | chat.lua: nodes; a swipe or branch is another child of the same node |
| Characters, personas | Entities with "card" or "persona" on the library node, read by a card’s parts |
| World info | lore.lua over cond.lua |
| Notes (author’s, character’s, any number) | The setting prompt/notes: a table of notes by id, each a prompt part (text, depth or position, role, optional when) merged across the path, from the chat, pinned bookmarks, character and card alike; the prompt step turns the ones whose condition holds into parts. The interval and delay are conditions on depth |
| Presets, prompt manager | Data a card’s composition reads: its parts, their order, the parameters |
| Regex, reply cleanups | Rewrite steps |
| Macros | A library function parts call on their text |
| Quick replies, slash commands, STscript | Commands; STscript is an interpreter module, for compatibility |
| Tags, saved views | Tags are a relation component; a view is a query (cond.lua data) the store answers from declared indexes, live through a watch on the query |
| Indexes, searching stored data | Declared by schemas on component fields and kept by the store: the library node's in place, each chat's rows read through the ancestry |
| Group chats | A module that sets ctx.speaker and runs the reply steps per character, or composes their replies into one |
| Summarize, vectors, TTS, image generation, trackers | Modules, each with only its own capabilities (condense.lua, tracker.lua; TTS holds net for its service) |
| Extensions | Modules, the same as everything above |
| Stop button, time limits, streamed replies | A task's cancel; async.lua; stream.lua, with net and the store pushing to sinks |
| Settings per tab, chat, character, device, person, world entry | settings.lua: the statements along a path of levels, followed relations and the message tree, combined as the setting says, each level kept in the version store |
| Drafts, caches | latest, narrowed per module by prefix; a page's own latest stays on its device |
| API keys and other secrets | secrets.lua over latest and net: no read, added to requests by a signer, scrubbed from replies |
| Captions, embeddings, translations, classifications | derived.lua: entries by input hash in latest, stated none, pending, done or failed |
| Background work that survives restarts | jobs.lua over latest, clock and tasks: retries, progress, cancel |
| Live updates, several tabs, branch switches | store:watch and latest:watch, followed by a page module from a cursor |
| Uploads and files outside the store | Pinned by the values naming them, leased until then; holds and their release list; accounts for quotas |
| Allowing a URL, a LAN server, a folder | grant: a prompt the host draws, minting a narrowed net or files |
| Switching the model or another provider mid-session | switch.lua: a forwarder; connections.lua keeps which adapter answers |
| What a module asks for, reviewed at install; presets | Needs in its manifest; grant:install, with presets and first-match rules the person writes |
| What a grant allows, in words | describe on the host module that mints it, followed through providers for content |
| An admin's limits per person | What that person's grant holds (grant:narrow) |
| Extensions in every chat, a card's own, their buttons and settings | Gap 5, option D: the app's wiring is a graph, a card ships its piece, an extension is a transform of it; buttons and settings are item nodes in slot nodes |
| Which extensions run where, and in what order | Rules in the setting "compose", resolved through the cascade: a scope and constraints each transform declares, which the person's rules at any level override |
| Regex, Unicode, tokenizers, zip, PDF | wasm modules, the same build on both sides |
| Local models, video, a headless browser | Host modules: infer, proc, browser |
| Code editor, graph view (libraries needing a DOM) | The display handle's surface: the owner's decision |

## The owner's words

**Supports:** "i would ideally still like relational for compatible data (optionally), for some definition of compatible. perhaps something like an ecs architecture in relational db" (entities, components and relations, with optional schemas); "an open bag of properties (…), then be able to search based on that" (free-form components and queries); "ok so what you’re saying is everything* should be an extension"; "much of ccv2 behavior would become its own app"; "an ideal rp platform wouldn’t be so chat-centric"; "how *would* the ‘turn pipeline’ be ‘composed’" (a list of steps a card owns); "it’s a composition of parts"; "think closer to arbitrary scripting running on sandboxed luajit"; "ideally state is schemaless"; "something something ocaps may be not a terrible idea".

**Strains:** "authoring being too hard for non-programmers — a problem we need to solve" (question 2); "constrained dsl since an ideal browser target is sandboxed" (question 3).

## Questions still open

Decided: store integrity requirements ("Store integrity"): a checksum on every page or record verified on read, copy-on-write and append-style writes with no overwrite in place, a write-ahead log with checksums so a torn write is detected and rolled back on open, background scrubbing, and page-level backups so only damaged pages are restored. Modules are Lua, run by LuaJIT on the server and compiled to JavaScript on the page, which the browser's engine JITs, with the compiler deciding every name code can reach; the pure-computation libraries (regex, Unicode, tokenizers, zip, PDF) are wasm, one build for both sides (gap 8). Question 5, how installed extensions and a card's own join a card's turn, is answered by option D: the composition is data, a graph the root interprets, which a card ships a piece of and an extension transforms (gap 5); which transforms run where, and in what order, are the person's rules resolved through the settings cascade, which is one mechanism for levels of context, followed relations and the message tree ("Settings: one cascade along a path").

2. **How does someone who doesn’t program build things?** Decided. Editors are modules that write data that libraries read; there is no language in the core. Option D (gap 5) makes a card's composition data the root explains without running it; what a code node does inside is still code.

6. **Building an index on data that already exists.** Decided. Owner: "idc i guess". A schema version that adds an index comes into force after the store has built it in one pass over the component's existing rows; until then the version before it is in force ("Indexes under branching"). That wait is accepted.

7. **Where an index's base is.** Decided, replacing "indexes declared per home". Accounts share one store ("Accounts: one store, a home node each"), so indexes sit at the shared base node, with each account's changes as rows keyed by account, as a chat's are keyed by chat. The read cost with the extra level is stated under "Indexes under branching".

8. **Shown names of entities.** Decided. Owner: "references (aka new behavior) make more sense right?" Messages refer to their speaker's entity; a rename renames it everywhere, and the rename is itself a change in history. Upstream's imported messages keep the name upstream stored, which "reads" returns until something names an entity.

9. **What a multiplayer chat sees.** A multiplayer chat is a child of the base node that two accounts' scopes include, so its ancestry is the base node and the chat, not either account's node: an account's own edits of shared content (a card it changed) are not in it. I don't know whether that is wanted, or whether a participant's edits should be visible there, which would need a different place for the chat.

10. **How content moves between an account and the base node, and who is charged for the base.** Importing a card into the base node for everyone, or taking a common library's card into one account's changes, are operations the model doesn't yet name. I don't know who a shared node's bytes are charged to (nobody, the admin, the first importer).

11. **Accounts' identity data.** Where the login, the password's hash and the list of accounts live (a store entity, the secrets of gap 2, something else), how an account is created and removed, and whether an account's home can be moved or merged. The owner's.

Left out: how much control the model gets over state. Each card or world decides that for itself.
