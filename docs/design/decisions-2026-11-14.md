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
