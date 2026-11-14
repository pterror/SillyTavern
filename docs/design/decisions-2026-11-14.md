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
  grant's preset rules) add to or replace any transform's constraints. "The card's run first" is one rule at the
  lowest level, which the person's rules override. A cycle refuses the composition and names each constraint in it
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
  user, and any other level as data), containment (an entry, the groups it's in, its world) and the message tree (a
  statement at a node holds for everything under it). Which chains a setting follows is its schema's path, and the
  path is itself a setting. Tab and device statements are kept in latest; chat, character, person and world
  statements are in the version store, so they branch and undo.
- **Tabs and branch switches.** Settled by the tab sessions design: what a tab shows is that tab's session state, so
  tabs are independent. Owner: "isnt this fucking decided by fucking sessions design".
- **Connection settings** wait for the state model: a connection is which adapter module holds which key.
- **Overview updates slowing with scroll** wait for the state model (`store:watch`).

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

- A login session is renewed by any request and expires after inactivity; no page timer.
- Settings snapshots belong to settings.
- An admin's edits to another user reach that user's open tabs at once.

## App-wide

- **Optimistic updates** (chosen; owner: "up to u"): a person's own edits (tags, toggles, renames) show at once and are
  undone, with a visible "not saved" state, if the server refuses. Search filters what's loaded at once, then shows the
  server's ranked results. Owner: "depends on optimistic vs... non-optimistic ui?"
- **Search** in personas, group members and tags is server search, ranked like the character list.
- **Lab Mode and Zen Sliders** are dropped. Owner: "allow values out of range": fields accept any value; sliders cover
  the usual range.
- **Names:** "just normal names please just like the rest of the ui".
