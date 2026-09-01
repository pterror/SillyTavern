# Migrating group chats into the message tree

Companion to `save-diff-engine-retirement.md`. That doc is about *how* a caller states what it did;
this one is about a prerequisite it kept tripping over: the named operations are all tree operations,
and group chats are not in the tree, so every group call site had nowhere to migrate *to*. The
workaround being reached for during the retirement work — "keep the diff-save fallback for groups
permanently" — is the thing this doc exists to make unnecessary.

## The position this is built on

There is no permanent parallel path for file-backed chats. A chat that is still JSONL-backed when it
gets touched is migrated to tree storage *at that moment*, once, and behaves like every other
tree-backed chat forever after. That is not the same as a per-request "is this migrated yet?" branch
in the handler — the deleted `ensureTreeMigrated()` was exactly that shape and is not coming back.
The distinction is worth stating precisely, because the code looks superficially similar:

- **Banned:** the handler asks whether this owner is migrated and *chooses a code path* from the
  answer. Two live paths, forever, and the JSONL one keeps accreting features.
- **Intended:** the handler unconditionally calls a migrate-on-touch precondition, ignores its
  result, and then has exactly *one* path — the tree. The precondition is idempotent and cheap
  (`migrateCharacterChats()` returns immediately for an owner that already has a labeled node), and
  no branch downstream depends on what it returned.

`hasSavedChats()` is not a migration check and must not be used as one — its own doc comment says so
at length. (`/api/characters/chats` in `characters.js` currently does use it that way. Pre-existing,
noted here so it isn't mistaken for a pattern to copy.)

## Migrate-on-touch is not group-specific

Worth stating up front because it changes what gets built: characters have the same gap. `/save`'s
comment says tree state is "assumed, not checked-and-migrated", and the bulk migration that makes
that assumption true was a one-off run against this install's data — there is no committed code that
would migrate a character that was never part of that run (a fresh install, a card restored from
backup, anything that slipped through). So the mechanism is one mechanism, parameterized by owner id
and `isGroup`, used by both owner kinds. Not two.

## The identity problem, and why it is the whole difficulty

For characters the layout matches the tree's ownership model exactly: one directory per owner
(`chats/<cardName>/`), each file a chat, filename becomes the label. `migrateCharacterChats()` scans
that directory and is done.

Groups do not have that shape. Every group chat across every group sits flat in the single shared
`groupChats/` directory, filenames are *chat* ids, and the mapping from group to its chats lives in
the group's own descriptor (`groups/<id>.json`, `chats` array). So "migrate this group" is not "scan
a directory" — the directory is shared by all 78 chats of every group at once, and scanning it would
file every group's history under whichever owner happened to touch first.

Two consequences:

1. **`migrateCharacterChats()` needs to accept an explicit file list** instead of always scanning
   `chatDir`. Everything else it does is already correct for groups — it takes an `ownerId`, it takes
   `isGroup`, it writes `__is_group`, it labels by filename-minus-`.jsonl` (which for a group chat is
   the chat id, which is what every group route already addresses chats by), and it renames each
   migrated file to `.jsonl.pre-migration`. Only the "which files are mine" question is wrong, and it
   is wrong in exactly one line.

2. **The routes need the group's id, and they are only given the chat's id.** `/group/save` and
   `/group/get` receive `{ id }` where `id` is `group.chat_id`, never the group's persistent id. The
   reverse lookup already exists and is already paid for on every single group save:
   `resolveGroupForChat()` in `character-metadata-db.js` scans `groups/` for the group whose `chats`
   array contains this chat id, and returns both the group id *and* that chats array — which is
   precisely the (ownerId, fileList) pair the previous point needs. Its own doc comment argues the
   scan is affordable at group scale. It is currently private to that module.

   A `null` from that lookup (a chat id no group claims) is not a migration question and must not be
   answered by silently writing JSONL — a chat written to a file that nothing will ever read again is
   the silent-data-loss shape this whole workstream exists to close off.

## What is genuinely blocked, and why this is bigger than two routes

Migrating `/group/save` and `/group/get` alone does not leave the group feature working. The moment a
group's JSONL files are renamed to `.pre-migration`, four other paths that still stat those files
start reporting the group's history as gone:

- `getGroupPastChats()` fetches `/group/info` once per chat id; `/group/info` stats a JSONL file. The
  entire past-chats list for a migrated group goes empty. The character equivalent of this
  (`/api/characters/chats`) has a tree-aware listing path; groups have no equivalent.
- `/recent`'s `getGroupChatFiles()` stats group JSONL files, so migrated group chats vanish from
  recents. Worse, the tree-aware half of the same route (`getTreeBranches()`) maps every branch's
  `owner_id` to `<owner_id>.png` — an assumption that owners are characters. Tree-stored group
  branches would surface there as nonexistent characters.
- `/group/delete` deletes a file and would leave the branch behind.
- `/group/import` writes a fresh JSONL into `groupChats/` for a group that has already been migrated.
  `hasBranchesSync()` reports that group as migrated, so the migrate-on-touch precondition skips it
  and the imported chat is never ingested — present on disk, invisible in the UI.
- `/rename`'s tree path is explicitly solo-only (`is_group` forces `ownerId` to `null`), so renaming
  a migrated group chat would rename nothing.

None of these fail loudly. They report an empty list, which is indistinguishable from "this group has
no history". That is the same failure class as the bug that started the retirement work, so shipping
save+get without the other five is not a safe partial state — it is the unsafe one.

## Found while building this: two chats that share an opening

Groups made an existing weakness in the store reachable on an ordinary day, and it is worth writing down
separately because only half of it is fixed.

Row identity is (parent, speaker, text). Two chats in one group are both seeded from the members'
greetings, so the second one's opening message is byte-identical to the first's and lands on the *same
row* rather than getting one of its own. Two consequences follow, and they are not the same problem:

1. **A new chat's name used to overwrite the older chat's.** `saveChatToTree()` names a brand-new chat
   at its first message; when that message is an existing chat's entry point, the `UPDATE ... SET label`
   simply took the older name away. The older chat's history stayed in the tree with nothing pointing at
   it, and nothing was reported. Fixed: the name goes on the first *unlabeled* node along the chat's own
   path, and if every node on it is already claimed the failure is logged rather than resolved by taking
   someone else's name. This follows the rule the JSONL migration already states for the same situation
   (two files landing on one leaf: report, never overwrite).

2. **A chat that is a strict prefix of another still cannot be distinguished on load. Open.** Resolution
   is "find the label, then follow `default_child_id` down to a leaf", and the longer chat owns that
   pointer, so the shorter chat loads as the longer one. `endPathAt()` exists to terminate a path and
   nothing on this route calls it. This is a property of the model rather than of groups - two character
   chats where one is a prefix of the other behave the same way - but characters rarely produce that
   shape and groups produce it the moment a second chat is started. Deliberately not resolved here: it
   is a question about how the store represents a terminated path, not about group routing, and guessing
   at it inside a migration change is how the last round of silent data loss happened.

## Client surface

`saveGroupChat()`/`getGroupChat()` in `group-chats.js` are the only two callers of the group
save/get routes and are straightforward to move. The harder half is in `script.js`: several
`selected_group ||` guards (in `switchToNode()`, `saveMetadata()`, others) exist specifically because
groups are not tree-backed, and the `chatOp*` helpers resolve their owner id from
`getCurrentCharacter()?.avatar` with no group-id equivalent. Those guards are correct today and
become wrong the moment the server side lands; they are not optional follow-up.
