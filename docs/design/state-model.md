# State: a small core, everything else content

One model: a core of two primitives, modules the host provides, and everything else as content built from them, chats and extensions included. Each primitive passes two tests: it can't be built from the others, and every assumption it bakes in is listed with what it would rule out, replaced by the less restrictive form where one exists; what stays restrictive is said. Modules are Lua: LuaJIT on the server, compiled to JavaScript on the page; the pure-computation libraries are wasm (gap 8). Stored data is JSON. In code, [core] marks a core primitive and [host] a call to a host-provided module; every other name is content. The owner decides the questions; nothing here is a pick.

## The model

The core has two primitives: sandboxed execution, whose runtimes are pluggable, and capability references, the only authority there is. The host (the server, a page) provides modules the root is handed: a version store whose history is a graph and whose changes are operations defined by content; network; the page; a clock; blobs. Everything else is a module: chats and messages, the turn, the prompt, lorebooks, conditions, backend adapters, and every extension, upstream-style or not. A chat is a node, a message is a child node, a swipe is a sibling, the turn is a list of steps a card composes, and a condition is a function. Neither the core nor the host modules know any of those words.

**Easy:** Nothing is a special category: an extension and a built-in feature are the same kind of module with the same powers. Any card can recompose its turn, replace any part, or not be a chat at all. Each module holds only the capabilities it was handed, so installing one shows what it can touch. Branches, swipes and undo come from the store, for every module alike.

**Hard:** Everything is code someone wrote, so people who don’t program depend on libraries (question 2). The page can only explain why something is in the prompt if the libraries report it. Content keeps its own indexes. Undoing an early change re-runs the later operations on that path. What stays restrictive is listed under each primitive: a module runs only where its runtime exists; I/O exists only where the host provides a module for it; operations can’t do I/O; history under a node that’s kept stays.

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
store:node(parents)          -> node     a list: two or more to merge; none only if unscoped
store:parents(node)          -> list     only the parents inside this reference's scope
store:get(node, key)         -> value, or { conflict = { value, value, ... } }
store:range(node, prefix)    -> every key under prefix at node, in key order
store:apply(node, changes)   -> ids      changes = { { key, op, arg }, ... }, all or none
store:revert(node, id)       -> id       a change cancelling change id, from node down
store:drop(node)             removes node and what is reachable only through it
store:children(node, after, limit)  -> child nodes, oldest first, a page at a time
store:watch(node, prefix, since, sink)  -> handle; pushes what changes under prefix at
                             node, from any cause, to sink (gap 4); handle:stop()
store:narrow{ nodes = { ... }, prefix = "chat/", mode = "rw" }  -> a store reference
                             whose scope is the old one cut down to those nodes and
                             their descendants, keys under prefix, and those rights

A store reference has a scope: a set of nodes and everything descending from them
(the host's own reference, which the root holds, is unscoped), a key prefix, and
rights: r (get, range, watch, children, parents), w (apply, revert, node), d (drop).
A node id or a change id is only a name. Every call resolves it within the scope and
raises "not in scope" otherwise, so a guessed or stored id reaches nothing more:
  node, children, drop  the node (and every parent given to node) is in scope
  get, range, watch     the node is in scope; keys outside the prefix aren't there
  apply                 the node is in scope, every key under the prefix
  revert                the change was made at a node in scope, to a key under the prefix
  an op's read          sees only keys under the prefix of the reference that applied it
  watch's batches       children are in scope by construction; a change made above the
                        scope shows as by = { above = true }, without its id or module
A key's value at a node is what its changes on the paths to that node give, including
changes made above the scope: reading a node's value is allowed, reaching those nodes isn't.
op is a pure function (old, arg, read) -> new that a module exports. An op that raises
fails the whole apply.
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
Assumes: other orders than key order are native.
  Rules out: nothing, but bakes in which indexes exist.
  So: one order; a module keeps index keys for others, by wrapping the store
  reference it hands out.
Assumes: the module that cares about a write is the one that made it.
  Rules out: seeing other modules' and devices' writes, reverts, and the replays
  after them.
  So: watch reports every change of a value at a node, whatever caused it.
Assumes: a node knows only its parents.
  Rules out: listing swipes and branches unless a module keeps a list.
  So: children, a page at a time.
Assumes: a store reference reaches every node it can name.
  Rules out: authority being only what was handed; handing a module one chat.
  So: a reference has a scope of nodes, and ids are names resolved within it.
Assumes: an id stored in a value is authority over that node.
  Rules out: storing ids at all (condensed spans, a viewed node, page actions).
  So: ids stay names; only the reference resolving them is authority.
Assumes: a scope is one subtree.
  Rules out: handing a module two chats, or a chat and the library it reads.
  So: a set of nodes.
Assumes: narrowing by node can be a wrapper (content).
  Rules out: nothing, but a wrapper would walk every path to check a node and filter
  every watch and children page itself, repeating the store's ancestry.
  So: store:narrow, checked by the store's ancestry index.
Assumes: an op reads the whole node.
  Rules out: a module's op being kept from other modules' keys.
  So: read sees the prefix of the reference that applied it.

Still restrictive:
  operations can't do I/O, or replaying them wouldn't give the same result;
  an operation's code is kept as long as changes use it (recorded by content hash);
  values are JSON or a blob by hash, so exact large numbers go as strings;
  history under a node that's kept stays; discarding it means dropping nodes;
  a scope can only be cut down, never widened, and never reaches a node above it,
  even to read its keys (it reads their effect on the values at its own nodes);
  only an unscoped reference makes a root node; a module that needs its own roots is
  handed a node to make them under;
  resolving an id costs an ancestry check (jump pointers, about log depth steps);
  a merge with a parent outside the scope makes that check search both paths.
```

A host-provided module, not a core primitive, but the one every example rests on. Both tests rerun with scope: necessary as before (persistence is I/O), and scope is part of the store, not a wrapper, because only the store knows which nodes descend from which. Holding a store reference is now the only authority over nodes: an id is a name, so a module can store or receive one without gaining anything.

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
  indexes           keys a wrapper keeps, read with store:range
  narrowing         latest's: a wrapper forwarding only keys under a prefix (narrow.lua);
                    the store's covers nodes too, so it is store:narrow
  merge policy      content settles conflicts
  timeouts, races,  async.lua and stream.lua over tasks (gap 1)
  streams
  secrets           secrets.lua over latest and net (gap 2)
  jobs              jobs.lua over latest, clock and tasks (gap 3)
```

Host-provided modules other than the store, and what was dropped from the candidate core.

## What the store holds

```json
{ "node": 811, "parents": [790] }
{ "node": 812, "parents": [811] }

{ "id": 9031, "node": 811, "key": "chat/msg", "op": "kv.set", "module": "chat",
  "arg":    { "role": "user", "name": "Ren", "text": "Where do dragons nest?" },
  "result": { "role": "user", "name": "Ren", "text": "Where do dragons nest?" },
  "time": 1763100000 }

{ "id": 9040, "node": 812, "key": "tracker/time", "op": "kv.add", "module": "tracker",
  "arg": 90, "result": 1290, "time": 1763100004 }

{ "id": 9055, "node": 812, "revert": 9040, "module": "ren-undo", "time": 1763100090 }
```

Nodes and changes are all the store has. "chat/msg", "kv.set" and "tracker/time" are names chosen by modules; the core stores them without knowing what they mean.

## A chat and its messages

```lua
-- chat.lua: a chat is a node; each message is a child node holding "chat/msg"
return function(c)                        -- c: what the loader handed this module
  local store, kv = c.store, c.kv
  local M = {}

  function M.new(library)                 -- library: the node a chat starts under
    return store:node{ library }          -- [host]
  end

  function M.append(at, msg)              -- msg = { role, name, text }
    local n = store:node{ at }            -- [host]
    store:apply(n, { { "chat/msg", kv.set, msg } })   -- [host]
    return n
  end

  function M.history(at)                  -- the messages on the path to at, oldest first
    local out, n = {}, at
    while n do
      local m = store:get(n, "chat/msg")  -- [host]
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
      return { { role = "system", content = store:get(ctx.at, "chars/Ilse").description } }  -- [host]
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

  local reply_steps = {
    function(ctx) ctx.history = history(ctx.at) end,
    function(ctx) ctx.speaker = "Ilse"; lore.activate(ctx, { "bestiary", "places", "capital", "story" }, 4) end,
    function(ctx) ctx.messages = prompt.assemble(parts, ctx) end,
    function(ctx) ctx.reply = model.generate(ctx.messages) end,
    function(ctx) ctx.at = chat.append(ctx.at, { role = "assistant", name = "Ilse", text = ctx.reply }) end,
    tracker.step,
  }

  function T.reply(ctx)                   -- also what a swipe runs, from the message above
    for _, step in ipairs(reply_steps) do step(ctx) end
    return ctx
  end

  function T.send(ctx)
    ctx.at = chat.append(ctx.at, { role = "user", name = ctx.persona, text = ctx.text })
    return T.reply(ctx)
  end

  return T
end
```

The person sends, the prompt is assembled, the model is called, the reply is stored: four entries in a list the card owns. There are no hooks. An extension is one more step, or a wrapper around a part; a group chat is a module that runs the reply steps once per speaker, or composes their replies into one.

## The install: loading modules and handing out capabilities

```lua
-- root.lua: the one module the host starts, holding every host module
return function(caps)                     -- caps: sandbox, store, latest, net, page, clock, disk, home, ...
  local store, home = caps.store, caps.home
  local function load(name, given)
    return caps.sandbox:load(store:get(home, "pkg/" .. name), "lua", given)   -- [core], [host]
  end
  local narrow = load("narrow", {})       -- a wrapper forwarding only keys under a prefix, for latest
  local function only(prefix, mode)       -- the nodes under home, keys under prefix
    return store:narrow{ nodes = { home }, prefix = prefix, mode = mode }   -- [host]
  end
  local function only_latest(prefix, mode) return narrow(caps.latest, prefix, mode) end

  local json     = load("json", {})
  local kv       = load("kv", {})
  local cond     = load("cond", {})
  local secrets  = load("secrets",  { latest = only_latest("secrets/", "rw"), net = caps.net, kv = kv,
                                      signers = load("signers", {}), scrub = load("scrub", {}) })
  local chat     = load("chat",     { store = only("chat/", "rw"), kv = kv })
  local model    = load("openai",   { net = secrets:net("openai"), json = json,
                                      base = "https://api.example.com", model_id = "some-model" })
  local lore     = load("lore",     { store = only("lore/", "r"), cond = cond })
  local chars    = load("chars",    { store = only("chars/", "r"), cond = cond })
  local prompt   = load("prompt",   {})
  local tracker  = load("tracker",  { store = only("tracker/", "rw"), kv = kv, model = model, cond = cond })
  local condense = load("condense", { store = only("condense/", "rw"), kv = kv, model = model })
  local ilse     = load("ilse",     { store = only("chars/", "r"), chat = chat, lore = lore,
                                      prompt = prompt, model = model, tracker = tracker, condense = condense })

  caps.page:on(function(action, conn)                                       -- [host]
    if action.type == "send" then
      local ctx = ilse.send{ at = action.at, text = action.text, persona = action.persona }
      conn:send{ at = ctx.at, reply = ctx.reply }                           -- [host]
    elseif action.type == "swipe" then
      local ctx = ilse.reply{ at = store:parents(action.reply)[1] }         -- [host]
      conn:send{ at = ctx.at, reply = ctx.reply }                           -- [host]
    elseif action.type == "condense" then
      condense.run(action.at, condense.wrap(chat.history), action.from, action.to)
      conn:send{ at = action.at, condensed = { from = action.from, to = action.to } }   -- [host]
    end
  end)
end
```

Installing a module is the root loading its source and handing it capabilities; nothing else gives a module any power. The model's key never reaches the adapter: secrets:net hands it a net that puts the key into requests (gap 2). This root wires one card; a real install’s root would load a module that picks each chat’s composition.

## Lorebook activation as a library

```lua
-- cond.lua: conditions as data, e.g. ["all", ["keys", "dragon"], ["speakerTag", "npc"]]
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

-- lore.lua: lorebook activation (keys, recursion) as a library
return function(c)
  local store, cond = c.store, c.cond
  local L = {}

  cond.define("keys", function(ctx, ...)      -- any of these words in the scanned text
    local text = ctx.scanned:lower()
    for _, word in ipairs({ ... }) do
      if text:find(word:lower(), 1, true) then return true end
    end
    return false
  end)

  cond.define("cameUp", function(ctx, name) return ctx.active[name] ~= nil end)

  function L.activate(ctx, books, depth)      -- depth: how many recent messages are scanned
    local recent = {}
    for i = math.max(1, #ctx.history - depth + 1), #ctx.history do
      recent[#recent + 1] = ctx.history[i].msg.text
    end
    ctx.scanned, ctx.active, ctx.came_up = table.concat(recent, "\n"), {}, {}
    repeat                                    -- recursion: scan again with what came up
      local grew = false
      for _, book in ipairs(books) do
        local b = store:get(ctx.at, "lore/book/" .. book) or {}                 -- [host]
        if cond.holds(b.when, ctx) then
          for _, e in store:range(ctx.at, "lore/entry/" .. book .. "/") do      -- [host]
            if ctx.active[e.name] == nil and cond.holds(e.when, ctx) then
              ctx.active[e.name] = e
              ctx.came_up[#ctx.came_up + 1] = e
              ctx.scanned = ctx.scanned .. "\n" .. e.text
              grew = true
            end
          end
        end
      end
    until not grew
  end

  return L
end
```

keys and cameUp are lore.lua’s own operators, added to cond.lua the way any module adds one. Tags and saved views use the same cond.lua; at library scale, a views module keeps index keys current by wrapping the store capability it hands out, and reads them with store:range.

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
      { "tracker/time", kv.add, r.minutes_passed },
      { "tracker/affection/Ilse", kv.add_within, { r.affection_change, 0, 100 } },
    })
  end

  cond.define("evening", function(ctx)
    local minutes = store:get(ctx.at, "tracker/time") or 0                  -- [host]
    return math.floor(minutes / 60) % 24 >= 18
  end)

  return T
end
```

An upstream extension and a feature that ships with the app are the same thing: a module, holding only what it was handed (here, writes under tracker/ and the model).

## Case 1: an entry that comes up on a keyword, only for characters tagged "npc"

```lua
key "lore/entry/bestiary/dragons", on the library node, op kv.set:
{ "name": "Dragons",
  "when": ["all", ["keys", "dragon"], ["speakerTag", "npc"]],
  "text": "Dragons nest in the eastern cliffs…" }

key "chars/Ilse", on the library node:
{ "description": "…", "tags": { "npc": true } }

-- chars.lua
return function(c)
  c.cond.define("speakerTag", function(ctx, tag)
    local who = c.store:get(ctx.at, "chars/" .. ctx.speaker)              -- [host]
    return who ~= nil and who.tags[tag] == true
  end)
  return {}
end
```

The card set ctx.speaker; a group module would set it per speaker. Filtering the character list by the tag is the same ["speakerTag"]-style data, read by a views module.

## Case 2: a book that loads when another entry came up

```
key "lore/book/capital":
{ "when": ["cameUp", "The Capital"] }

key "lore/entry/places/capital":
{ "name": "The Capital", "when": ["keys", "capital"], "text": "…" }

key "lore/entry/capital/palace":
{ "name": "The Palace", "when": ["keys", "palace"], "text": "…" }
```

lore.activate checks each book’s condition on every pass, so once The Capital comes up from another book, this book’s entries are scanned on the next pass. Whether a book gates its entries is lore.lua’s choice, not the core’s.

## Case 3: time passing and an affection meter

```
tracker.lua (above) after each reply:
  tracker/time            kv.add         reply’s minutes_passed
  tracker/affection/Ilse  kv.add_within  { affection_change, 0, 100 }

key "lore/entry/story/evening":
{ "name": "Evening", "when": ["evening"], "text": "It is evening." }
```

The time and the meter are keys the tracker chose, and “evening” is its condition. A card that wants the model to report them in the same reply, or as a tool call, writes a different step.

## Case 4: condensing a finished 80-message side quest so the prompt carries the condensed version

```lua
-- condense.lua: put a condensed text in place of a span of messages
return function(c)
  local store, kv, model = c.store, c.kv, c.model
  local C = {}

  function C.run(at, history, from, to)     -- from, to: message nodes on the path to at
    local lines, inside = {}, false
    for _, h in ipairs(history(at)) do
      if h.node == from then inside = true end
      if inside then lines[#lines + 1] = h.msg.name .. ": " .. h.msg.text end
      if h.node == to then break end
    end
    local text = model.generate({
      { role = "system", content = "Condense this finished side quest. Keep what later events depend on." },
      { role = "user", content = table.concat(lines, "\n") },
    })
    store:apply(at, { { "condense/spans", kv.append, { from = from, to = to, text = text } } })  -- [host]
  end

  function C.wrap(history)                  -- the same history, condensed spans in place
    return function(at)
      local starts, out, skip = {}, {}, nil
      for _, s in ipairs(store:get(at, "condense/spans") or {}) do starts[s.from] = s end  -- [host]
      for _, h in ipairs(history(at)) do
        if skip == nil and starts[h.node] then
          local s = starts[h.node]
          out[#out + 1] = { node = h.node, msg = { role = "system", name = "", text = s.text } }
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

Nothing about summarizing is in the core or in chat.lua. The root runs it from a page action; a module could offer C.run to the model as a tool, or a step could run it. Run over C.wrap’s output, a span can cover earlier condensed text.

## Case 5: a swipe or branch rolling it back

```
node 811  chat/msg  Ren: "Where do dragons nest?"
├─ node 812  chat/msg  Ilse: reply A
│            tracker/time kv.add 90, tracker/affection/Ilse kv.add_within +2
└─ node 813  chat/msg  Ilse: reply B   (the swipe: ilse.reply from 811)
             tracker/time kv.add 30

state at 813: tracker/time is its value at 811 plus 30; nothing from 812.
condense/spans written at node 925: not on a branch from node 900.

store:revert(at, 9040)                                                  -- [host]
  cancels the "add 90"; every later tracker/time on that path is 90 less
```

Swipes, branches and undo come from where a change hangs, for every module alike; a merge is a node with two parents. A module that keeps something out of rollback writes it on a node above the chat, such as the library node.

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
  ctx.reply, ctx.stopped = table.concat(got), not ok   -- the append step stores stopped with it
  shown:close()
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

Which page: every open page of the person; the first answer wins and the others' calls are cancelled, so their page modules take the question down. None connected: the call raises at once, and the module decides. A page that closes mid-question makes its call raise "gone", and first goes on with the rest. A question that must wait for someone to connect, or survive a restart, is a job (gap 3) whose record is the question; pages watch jobs/ (gap 4) and answer with an action. Assumes: the install has one person, so "their pages" is every page; how persons and their pages are told apart is not settled here (I don't know whether several persons per install are wanted). How a question is drawn is the display handle's (the owner's).

## Gap 1, waiting: blocking-style Lua on the page

```lua
-- a Lua module on the page
local function title(store, at)
  local ch = store:get(at, "chars/Ilse")    -- a call through a reference: can wait
  return ch.name:upper()
end

local function clamp(v, lo, hi)             -- calls nothing that can wait
  if v < lo then return lo elseif v > hi then return hi end
  return v
end

// what the compiler emits
function* title(store, at) {
  const ch = yield* call(store, "get", at, "chars/Ilse");
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
  Rules out: a preference that belongs to one device (text size on a phone).
  So: every host has its own.

Still restrictive:
  no history: what needs undo or branches goes in the version store;
  a page's offline writes meant for the server are content's to send and merge.

{ "key": "settings/lore/scan_depth", "value": 4 }
{ "key": "drafts/chat/790", "value": { "text": "Where do drag" }, "expires": 1765700000000 }
{ "key": "cache/tokens/llama3/sha256:9f2c…", "value": 1287, "evictable": true }
{ "key": "viewing/790", "value": 821 }
on a page's own latest:
{ "key": "prefs/text_size", "value": 17 }
```

Settings, caches, sessions, progress, drafts and device preferences are one host module, narrowed by prefix with narrow.lua, so each module sees only its own keys. It is a host module rather than content because nothing else holds a value without keeping its history. Costs: one write per change, no history; a module has to choose for each piece of state whether it belongs in the version store (follows branches, can be undone) or here (doesn't). Where a module's settings are edited is a UI slot (gap 5), and the editor is drawn through the display handle; both are the owner's.

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

Secrets are content over latest and net, held only by secrets.lua: it is the only module with latest under secrets/, it exports put but no read, and what it hands out is a net that substitutes the value at send time for the hosts the secret was stored for. Never in versioned history: latest has none. Never on the page: secrets.lua runs on the server, and the root never hands a page anything under secrets/; the person types a key into a page module that holds only a reference to put (that field is drawn through the display handle, the owner's). How the value goes into a request is the signer named in the secret's record (content: plain replacement, Basic auth, HMAC signing), chosen when the secret is stored, not by the module using it, so a module can't pick a transform that hides the secret where a server would echo it. Every string the signer inserted is replaced by the mark wherever a reply repeats it, in streams too. A token refresh is a signer that also reads the new token from the reply and stores it with put. Assumes: hosts are named exactly (no wildcard). Rules out: a module computing anything from the secret except through a signer. Costs: one latest read per request; scrubbing scans each reply for the inserted strings. I don't know whether secrets must also be encrypted on disk; that needs a key the host holds, which nothing here provides.

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
         store:apply at 821: chat/msg with the blob → the blob is pinned
         derived.request("caption@some-vision-model", "sha256:4b1e…"):
           latest: the pending entry and jobs/derived/caption@…/sha256:4b1e…, one apply
         reply to the action: the message, and its caption { state = "pending" }
t=2s     the job: the vision model replies 503 → tries = 1, error kept; sleeps 2s
t=3s     the server stops
t=3.4s   the root wires its modules; jobs.resume() finds the record and runs it
t=6s     the model replies → one latest apply: the entry settles to done (its job
         matches) and the record is removed; pages watching derived/ get the text
```

Derived data is content: values that are functions of an input are kept in latest by the input's hash and the kind (whose name includes what the result depends on, such as the model), and every reader goes through derived.get, which reads absence as "none", so nothing reads a hole. Nothing stored is partial or waiting: the store holds only complete values, and in latest every pending entry has the job that will settle it, written in the same apply. A feature added to a library that already exists doesn't backfill: entries are asked for when something needs them, or by a sweep job that pages through store:range with its cursor in its record, so it resumes where it stopped and costs nothing per card until it runs. Assumes: the result depends only on what the key names. Rules out: a derived value that differs by branch without saying so in its input (a summary of a path has the path's message hashes as its input). Costs: every reader handles four states; a person editing a caption makes it content, stored at the message's node, read before the derived entry.

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

Durable jobs are content over latest, clock and tasks. The jobs module's own tasks run the work, so a job outlives the action that started it, and J.cancel stops it with the task's cancel. Restarts: the record is written before the work and removed in the same apply as the result, so a job is run at least once; a cancel racing a finish is harmless because results settle through kv.settle, which only replaces the pending entry of that job, and kv.merge writes no progress into a record that's gone. A kind whose result goes to the version store makes that write idempotent itself (a key named by the job id, written with an op that refuses a second time), because a crash between that write and finish runs it again. Concurrency limits per kind are a few lines more of the same. Costs: at-least-once, so a model may be called twice; progress is one latest write per report, so a kind reports at a rate it chooses. Which job kinds exist comes from what is installed, so the root's kinds table depends on the manifest (gap 5); showing progress and a cancel control is the display handle's (the owner's).

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
store:watch(node, prefix, since, sink) -> handle
  pushes to sink, in commit order, one batch per apply, revert or drop that changes a
  value under prefix at node, from any cause: a write at node or above it, a revert and
  the replay after it, a merge settling, another module, another device
  since omitted: the first batch is every value under prefix (snapshot = true);
  since = a cursor: the batches after it, or a snapshot if it's older than the log keeps
latest:watch(prefix, since, sink) -> the same for latest
store:children(node, after, limit) -> child nodes, oldest first

{ "cursor": 99120, "snapshot": true, "changed": [ { "key": "tracker/time", "value": 1290 } ] }
{ "cursor": 99140, "children": [ 821 ] }
{ "cursor": 99151, "changed": [ { "key": "tracker/time", "value": 1200 } ],
  "by": { "revert": 9040, "module": "ren-undo" } }
{ "cursor": 99160, "dropped": true }
```

Watching is a property of the store and latest (host modules), not content, because what changed at a node is the store's own resolution: a write above the node, a revert and the replay after it, a merge. A wrapper would have to repeat that logic and would still miss writers who don't go through it. Assumes: watches are few, about one per open view, so on each apply the store checks the watches at or below the written node whose prefix covers a written key. Rules out: a watch per stored row at scale (a live query over 10 billion cards is a views index plus one watch on the index's prefix). The cursor is the store's commit sequence, the one order every reader shares. Costs: the store keeps a commit log for a window so a reconnect can resume; past it, a snapshot of the prefix. A narrowed store watches only nodes in its scope and keys under its prefix.

## Gap 4, watching: a page following a chat, across tabs and reconnects

```lua
-- view.lua (on the page): the values a view shows, kept from the server's batches
return function(c)
  local server, clock = c.server, c.clock   -- server: the exports the root gave this page
  local V = {}

  function V.follow(node, prefix, draw)     -- draw(values) after each batch
    local values, cursor = {}, nil
    local sink = {}
    function sink:push(b)
      if cursor and b.cursor <= cursor then return end   -- already applied
      if b.snapshot then values = {} end
      for _, ch in ipairs(b.changed or {}) do values[ch.key] = ch.value end
      cursor = b.cursor
      draw(values)
    end
    function sink:close() end
    return task.spawn(function()                                            -- [core]
      while true do
        local ok, err = pcall(server.watch, server, node, prefix, cursor, sink)
        if ok then return end
        if err ~= "gone" then error(err, 0) end
        clock:sleep(1000)                   -- the connection dropped; resume from cursor   -- [host]
      end
    end)
  end

  return V
end

tabs A and B show chat 790 at node 820; both follow latest "viewing/790" and store 820
t=0      A: action { type = "send", at = 820, text = "…" }
t=180ms  store: node 821 under 820, chat/msg at 821 (cursor 99140); in the same action
         the root sets latest viewing/790 = 821
         A: the action's reply { at = 821, cursor = 99140 }; the batch 99140 is skipped
         B: { children = { 821 } } on 820, then viewing/790 = 821: B follows 821
t=5s     A: action { type = "view", chat = 790, at = 813 }: a branch switch, no store write
         root: latest viewing/790 = 813; B moves too. With viewing/790/<tab>, only A moves.
t=9s     a module on the server reverts change 9040
         A and B: { tracker/time = 1200, by = { revert = 9040 } }
```

A page keeps its state only by applying the server's batches, and the cursor makes a batch that arrives twice (from the action's reply and from the watch) harmless. Several tabs stay in step because each has its own watches on the same keys. The node a page is viewing is state like any other: a page action sets it in latest and whoever watches the key follows. Whether tabs follow each other is which key the root writes (one per chat, or one per tab); that is a UX decision, the owner's. Batching: the core sends everything bound for one host in one scheduler turn as one frame, in order; there is no promise pipelining, so opening a view is one call to a server export that returns what the view needs and starts its watches. Listing swipes is store:children of the message above. What draw puts on screen is the display handle's (the owner's).

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
  store   = caps.store:charge(acct):narrow{ nodes = { home }, prefix = "rag/", mode = "rw" },  -- [host]
  latest  = narrow(caps.latest:charge(acct), "rag/", "rw"),                 -- [host]
  disk    = caps.disk:charge(acct), vectors = caps.vectors:charge(acct),    -- [host]
  embed   = embed })
```

Quotas are a host module, because only the store, latest, disk and holds see every byte they keep, including pins made by values. Each charged reference is a narrowing like any other, so a module's quota is in what it was handed. Assumes: space is the limited thing. Rules out: limiting calls or GPU time with it; a call rate is a net wrapper (ratelimit.lua, gap 7), and charging inference time would be infer's own (I don't know whether that's wanted). A blob shared by two accounts counts in both, so the accounts' usage can add up to more than the disk holds. How much each installed module gets is decided when it's installed (gap 5's manifest), and showing usage is the display handle's (the owner's).

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
local regex   = caps.sandbox:load(store:get(home, "pkg/regex"), "wasm", {})      -- [core], [host]
local unicode = caps.sandbox:load(store:get(home, "pkg/unicode"), "wasm", {})    -- [core], [host]
local cleanup = load("cleanup", { regex = regex, unicode = unicode })

-- cleanup.lua: a reply cleanup step
return function(c)
  local ooc = c.regex.compile([[\s*\(OOC:[^)]*\)]], "giu")   -- ECMAScript syntax and flags
  return function(ctx)
    ctx.reply = c.unicode.normalize(ooc:replace(ctx.reply, ""), "NFC")
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
| book type | Keys under a prefix that lore.activate reads; another kind of book is another module handing lore its entries |
| input handler | A module that takes a file or URL from a page action, parses it, and writes through its store capability; export is the reverse |
| transform | A step that rewrites ctx.reply or ctx.messages, or a wrapper around a part |
| command | A function a module exports: run from a page action, offered to the model as a tool by a tools module, or put in a turn’s steps |
| setting schema | Data a module stores about its own keys, read by whatever module edits them |
| backend adapter | A module holding a net capability for one host (openai.lua) |
| Chats, swipes, branches | chat.lua: nodes; a swipe or branch is another child of the same node |
| Characters, personas | Keys under chars/ on the library node, read by a card’s parts |
| World info | lore.lua over cond.lua |
| Author’s note, character’s note | A part returning a message placed where it’s wanted; several notes are several parts |
| Presets, prompt manager | Data a card’s composition reads: its parts, their order, the parameters |
| Regex, reply cleanups | Transform steps |
| Macros | A library function parts call on their text |
| Quick replies, slash commands, STscript | Commands; STscript is an interpreter module, for compatibility |
| Tags, saved views | Data plus cond.lua expressions; a views module keeps index keys current by wrapping the store capability it hands out |
| Group chats | A module that sets ctx.speaker and runs the reply steps per character, or composes their replies into one |
| Summarize, vectors, TTS, image generation, trackers | Modules, each with only its own capabilities (condense.lua, tracker.lua; TTS holds net for its service) |
| Extensions | Modules, the same as everything above |
| Stop button, time limits, streamed replies | A task's cancel; async.lua; stream.lua, with net and the store pushing to sinks |
| Settings, drafts, caches, device preferences | latest, narrowed per module by prefix; a page's own latest stays on its device |
| API keys and other secrets | secrets.lua over latest and net: no read, added to requests by a signer, scrubbed from replies |
| Captions, embeddings, translations, classifications | derived.lua: entries by input hash in latest, stated none, pending, done or failed |
| Background work that survives restarts | jobs.lua over latest, clock and tasks: retries, progress, cancel |
| Live updates, several tabs, branch switches | store:watch and latest:watch, followed by a page module from a cursor |
| Uploads and files outside the store | Pinned by the values naming them, leased until then; holds and their release list; accounts for quotas |
| Allowing a URL, a LAN server, a folder | grant: a prompt the host draws, minting a narrowed net or files |
| Regex, Unicode, tokenizers, zip, PDF | wasm modules, the same build on both sides |
| Local models, video, a headless browser | Host modules: infer, proc, browser |
| Code editor, graph view (libraries needing a DOM) | The display handle's surface: the owner's decision |

## The owner's words

**Supports:** "ok so what you’re saying is everything* should be an extension"; "much of ccv2 behavior would become its own app"; "an ideal rp platform wouldn’t be so chat-centric"; "how *would* the ‘turn pipeline’ be ‘composed’" (a list of steps a card owns); "it’s a composition of parts"; "think closer to arbitrary scripting running on sandboxed luajit"; "ideally state is schemaless"; "something something ocaps may be not a terrible idea".

**Strains:** "authoring being too hard for non-programmers — a problem we need to solve" (question 2); "constrained dsl since an ideal browser target is sandboxed" (question 3).

## Questions still open

Decided: modules are Lua, run by LuaJIT on the server and compiled to JavaScript on the page, which the browser's engine JITs, with the compiler deciding every name code can reach; the pure-computation libraries (regex, Unicode, tokenizers, zip, PDF) are wasm, one build for both sides (gap 8).

2. **How does someone who doesn’t program build things?** a. Libraries in a module language that read data, as cond.lua reads ["all", …] · b. A declarative form the core itself evaluates, so it can index and explain it without running code. This puts a language in the core, which then has to pass both tests above

Left out: how much control the model gets over state. Each card or world decides that for itself.
