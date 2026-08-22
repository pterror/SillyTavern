# Character data residency redesign

Reference design for moving the character library off "everything resident in a JS array" and onto
server-backed queries with a bounded client cache, at a target of 300k characters near-term and
1M–10M long-term.

Written to be implemented against by multiple agents working in parallel; the phase list in §9 is the
coordination surface.

## Status, and a warning about staleness

The design body was written against commit `29b01e194`. Phases 0–2 have since been implemented, and
§9 has been reconciled against the shipped code at `11ee9c303` (150 commits later). Read §9 for what
actually exists; the design sections above it describe intent and are marked inline where the
implementation superseded or diverged from them.

| Phase | Commit | State |
|---|---|---|
| 0a — keyed DOM diff in `printCharacters` | `16f460b82` | shipped, matches spec |
| 0b — versioned immutable thumbnail caching | `afbd83b9b` | **shipped half-done** — server-side only; no client emits a version, so every thumbnail takes an uncacheable 302 first. Currently worse than what it replaced |
| 0c — `/duplicate` server wedge | `ade258e49` | **partly fixed** — parse corrected, loop still unbounded, wedge still reachable |
| 0d — `writeExtensionField` dual-accept | — | not started |
| 1 — SQLite metadata store | `f872377eb` | shipped; schema and all three freshness mechanisms as specced, with deviations listed in §9 |
| 2 — browse pagination | `6ac50dca2` | **shipped in part** — `/query`, `/exists`, `/changes` exist but reject search and random sort, and nothing is wired to the client. The whole tantivy sub-scope is outstanding |
| 3 onward | — | not started |

Three things anyone implementing from here should know:

1. **Nothing user-visible has changed on the server side.** `/all` and `/manifest` still serve the UI,
   and `/all`'s no-parameter path is still a full-directory `readdirSync` plus `processCharacter`.
   All six new endpoints are wired to zero client code.
2. **Line references were re-resolved against `11ee9c303`.** Eighty were updated. Four could not be:
   `toShallow()` and `calculateChatSize()` moved out of `characters.js` into `src/character-shallow.js`
   (so their paths are wrong, not just their numbers), and one reference to the `printCharacters`
   pagination callback describes code that phase 0a replaced. Those four are flagged where they
   appear.
3. **Three phase-0/1/2 items shipped in a state that still needs work**: the client half of 0b, the
   loop bound in 0c, and caller-supplied `date_added` in phase 1 — the last of which was skipped on
   the stated but incorrect grounds that this document left it open. It does not; decision 17 settles
   it.

Claims about browser and library behaviour were checked against current sources or measured directly.
Where something could not be pinned down, the document says so inline.

---

## 0. Settled inputs

These are the owner's decisions. They are inputs to this design, not conclusions of it, and are not
re-derived here:

1. Correctness over cost and diff size. No shims, no partial migrations that leave a reachable
   index-based assumption anywhere. This includes full-collection semantics: a question
   like "does any character carry tag X" must be answered correctly over the whole 10M-row library,
   not over whatever happens to be resident.
2. Cache cap is a disk-quota budget, not an item count, and it has to behave on mobile Safari
   (tight, unpredictable quota) as well as desktop.
3. Local search uses a real client-side index library, not a substring scan over the resident
   set. It exists to answer searches without a round trip on a slow link (mobile + VPN), alongside —
   not instead of — the server-side tantivy/FTS search.
4. Phase 0 ships first and independently: the `printCharacters()` DOM-diff fix and thumbnail
   cache headers. Everything else is the foundational work after it.

## 1. Current state (measured)

Two datasets anchor this design.

The live install, at `data/default-user/characters`: 24,195 files, 48 GB on disk, and a
`tags.json` of 16 MB.

The corpus queued for import, at `/mnt/ssd/chub/spec_v2/`: 301,477 PNGs, 503.9 GB (470 GiB),
measured with `du -sb`. This is the near-term target, and it is a measurement rather than a
projection. Where a 300k figure appears below, it comes from here. Long-term target is 1M–10M.

Per-card size differs between the two: 1.67 MB in the import corpus, 2.0 MB on the live install. The
live install is the smaller and less representative sample, so projections derived from it run about
20% high. Extrapolating the real corpus instead, 10M cards is roughly 16.7 TB.

`tags.json` is the one figure that stays an extrapolation, and it needs a caveat: 16 MB covers 24k
*tagged* characters on the live install, so ~200 MB at 300k and ~6.6 GB at 10M describes a library
tagged at this install's density. A freshly imported corpus starts with none. The problem is real
because the file is loaded whole into the browser on every boot, but the timeline depends on tagging,
not on import.

Two counts that do not reconcile, recorded rather than smoothed over: the import corpus directory
holds 301,481 entries of which 301,477 are `.png`, and the card-parsing benchmark in §8.2 read 24,171
cards from the live install against its 24,195 files. Neither gap is explained. Nothing here depends
on which figure is exact.

### 1.1 What the client does today

- `characters` (`public/script.js`) is a plain array holding every character. `charactersStore`
  (`public/scripts/entity-store.js`) is an `EntityStore` wrapping *that same array in place*, keyed
  by `avatar`. It gives O(1) keyed reads and change notification, but it does not reduce residency:
  `getAll()` returns the array, and `has()` means "present in the resident array"
  (`entity-store.js:40-68`).
- Boot goes through a delta cache: `POST /api/characters/manifest` returns `{avatar, mtime}` for
  every character, diffed against IndexedDB (`public/scripts/character-cache.js`), misses fetched
  via `POST /api/characters/batch`. The transport is already incremental and avatar-keyed; it
  still materializes the full array at the end, more cheaply.
- Shallow/unshallow already exists: `toShallow()` (moved by phase 1 to `src/character-shallow.js:58`) projects a
  card down to name/avatar/fav/dates/tags/creator, and `unshallowCharacter(avatar)`
  (`script.js:7916`) hydrates on demand. So a two-tier "list row vs full card" model is already the
  shape of the code, not a new idea.
- `getEntitiesList()` (`script.js:1294`) materializes one entity per character in the whole library
  — `characters.map((item, index) => characterToEntity(item, index))` — then filters and sorts that
  whole list, and pagination consumes the result. Pagination is downstream of the full scan, not a
  bound on it.
- Client-side fuzzy search builds a Fuse index over every character's full text
  (`power-user.js:2427-2477`, 11 weighted keys including `description`, `mes_example`,
  `first_mes`), rebuilt wholesale whenever a dirty flag is set.
- Server search already exists and is good: `fetchServerCharacterSearchResults()`
  (`script.js:11471`) hits `/api/characters/all` with a `search` term and gets avatar-keyed hits
  back, then throws the avatar identity away by `characters.findIndex()`-ing each hit into an array
  index (`script.js:11502`) because that is what `searchFilter()` consumes.

### 1.2 What the server does today

This subsection is the "before" picture, read at `29b01e194`. Phases 0–2 have since landed and
invalidated three of the claims below; each is marked inline. Everything unmarked still holds at
`11ee9c303`.

- `/api/characters/all` browse path (`src/endpoints/characters.js:1369`, `:1429`) is fake
  pagination: `readdirSync` over the whole directory → `processCharacter()` per file → sort → slice.
  `processCharacter` (`:394`) does a PNG tEXt parse + `JSON.parse`, a `statSync` on the card, and
  `calculateChatSize()` (moved by phase 1 to `src/character-shallow.js:23`) which `readdirSync`s that character's chat directory and `statSync`s
  every chat file. So the per-card cost is one PNG read plus 1+N stat calls. An LRU keyed
  `path-mtimeMs` plus a node-persist disk cache sits in front of the parse; the stats still run.
- The search path is index-native for content but not for paging: the engine is called with
  `offset` hardcoded to 0 and ordering always BM25, so it fetches the top `offset+limit` hits and
  discards the front in JS (`paginateSearchResults`, `:1292`). No file reads on this path — full
  character objects come out of the index.
- Sort fields are exactly four (`SORT_FIELD_GETTERS`, `:1184`): `name`, `date_added`,
  `date_last_chat`, `chat_size`. The UI exposes those plus `fav`, `random`, and search-rank
  (`public/index.html:6385-6392`). Provenance splits three ways: `name` lives only in the PNG
  payload; `date_added` is the PNG's `ctimeMs` (not mtime — a chmod or rename moves it);
  `date_last_chat` and `chat_size` come from scanning the chats directory. There is no sidecar for
  any of it.
- Search engine tiers resolve once per process (`src/endpoints/search-engine.js:32`): native tantivy
  (`@oxdev03/node-tantivy-binding`, prebuilts for macOS / Windows / linux-x64-gnu only) → SQLite
  FTS5 via `better-sqlite3` → `node-sqlite3-wasm` → `unavailable`. `better-sqlite3` and the wasm
  fallback are already hard dependencies (`package.json:35`, `src/endpoints/sqlite-engine.js`).
- The tantivy schema is 11 text fields, all `stored: false`, plus one `stored: true` field holding
  the entire character JSON (13 KB mean, 24 KB p90 — see §1). No fast fields, no integer or date
  field, no facets. Tags are a space-joined text field. So `date_added` exists inside the stored blob
  but is neither queryable nor sortable.
- Index freshness is `statSync(charactersDir).mtimeMs` plus `tags.json`'s mtime, checked
  synchronously on every search request. Any change triggers a full rebuild of the entire index,
  preceded by `rmSync` of the index directory. `Index.open()` is never called, so the persisted
  index is never reused across boots. Incremental update was declined in a code comment
  on the grounds that ~6 s at 24k cards is acceptable.
- The write path (`writeCharacterData`, `:259`; delete; `/rename`, `:769`; the import handlers)
  invalidates the in-memory LRU and queues a disk-cache sync. Nothing calls into the search index;
  that omission is intentional, to avoid a circular import.
- `/api/characters/manifest` (`:1680`) is `readdirSync` + one `statSync` per file, no parse. There
  is no file watcher anywhere in `src/` — no `fs.watch`, no chokidar — and no write-path hook
  that could feed a change log.
  **Superseded by phase 1:** `character-metadata-db.js` now has all three — write hooks, a
  non-recursive `fs.watch`, and an interval reconciler — feeding a real `changes` log. `/manifest`
  itself is unchanged and still serves the UI.
- `/api/tags/save` (`src/endpoints/tags.js:68`) rewrites the entire `tags.json` — 16 MB today —
  synchronously, on every tag mutation.
- Thumbnails (`src/endpoints/thumbnails.js:249`) are served by a bare `response.sendFile` with no
  `maxAge`, no `immutable`, no explicit `Cache-Control`; only Express's default ETag and
  Last-Modified. The one header set is `invalidateFirefoxCache()`
  (`src/util.js:1595`), which applies `must-understand, no-store` to image responses on Firefox
  only. The cache key is the URL `/thumbnail?type=avatar&file=<name>` — no hash, no mtime.
  **Superseded by phase 0b**, though not in the way this document specified — the route now serves
  `immutable` when a version matches and 302-redirects when it does not, and no client emits a
  version. See phase 0b in §9 for why that is currently worse than what it replaced.

### 1.3 Other scaling landmines found in passing

Not in scope for this document, but they will bite at the same scale and should get their own
tickets:

- `src/endpoints/stats.js` `init()` reads `stats.json` as one blob per user at boot and, if it is
  missing or corrupt, walks every chat of every character. Re-saved every 5 minutes.
- `/api/chats/recent` (`src/endpoints/chats.js:1047`) readdirs the character directory then stats
  every chat file of every character, per request. It backs the welcome screen.
- The disk-cache `verify()` (`characters.js:131`) readdirs every user's character directory and
  stats every file at boot.
- `/merge-attributes` with an empty avatars array (`:1074`) rewrites every card in the library in
  one request.
- `getPngName()` probes `existsSync` up to 10,000 times for a name collision on every create and
  import.
- All of the above, plus `/all`, `/manifest`, and the per-request index-freshness check, are
  synchronous fs on the request thread.

And one that is not a scaling issue but a live server-wedge bug, found while verifying something
else. `/duplicate` (`characters.js:1874-1893`) guards its suffix parse with
`!isNaN(Number(lastPart))` but then uses `parseInt(lastPart)`. Those disagree: for `foo_.png`,
`foo_ .png`, or `foo_Infinity.png`, `Number` yields `0`/`Infinity` and passes the guard while
`parseInt` yields `NaN`. The first duplicate silently produces `foo_NaN.png` and returns fine. The
*second* duplicate wedges: `suffix` is `NaN`, so the candidate filename is permanently
`foo_NaN.png`, which always exists, and `NaN++` stays `NaN`.

It is a `while` loop around a synchronous `fs.existsSync`, so one HTTP request pins the event loop
at 100% and the whole server stops serving, with no timeout and no recovery. This should be fixed
independently and immediately; it does not need any of this design. (The separate oddity of
recomputing `newFilename` inside the loop is real but harmless: it wastes one iteration and cannot
overwrite, since the exit condition tests the exact name that gets written.) Secondary, and relevant
at target scale: the loop is a linear `existsSync` scan, so duplicating a character that already has
N copies costs N+1 synchronous stats on the request path.

**Partly fixed by phase 0c.** The `Number`/`parseInt` disagreement is gone, so the `foo_.png` trigger
no longer fires. The loop is still unbounded and the wedge is still reachable through a
long-digit-suffix filename — see phase 0c in §9.

---

## 2. Identity

### 2.1 Is the avatar filename a safe primary key?

Verified against the code: the answer is partly. It is already the de-facto key
everywhere, and it has three defects: it mutates on rename, it is recycled after delete, and uniqueness has escape hatches.

It is already the persistence key on disk, everywhere. `tag_map` in `tags.json` is keyed by
avatar; the FTS5 index uses `avatar UNINDEXED` as its row key; the chats directory is named after
it; group `members` are avatars; `active_character` is an avatar. Adopting it is not a question;
it is adopted. The only question is whether its defects get fixed.

**Uniqueness:** yes, by construction, with two escape hatches. `getPngName()` (`characters.js:1793`)
→ `getUniqueName()` suffixes `base`, `base1`, `base2`… checking `fs.existsSync`. The filesystem
*is* the uniqueness constraint. But `maxTries` is 10,000, and on exhaustion it returns null and the
caller falls back to `?? file`, i.e. overwrites. 10k identically-named cards is not absurd
in a 10M library assembled from scraped corpora. Separately, `/import` accepts `preserved_name`,
which bypasses uniqueness as an intended overwrite-in-place path. `/duplicate` has its own
`_1`/`_2` scheme, now read properly: the recompute-inside-the-loop oddity is harmless, but the
`Number`-guard/`parseInt`-use mismatch is a server-wedging bug (see §1.3). All of this becomes
moot under §2.2's minted ids, which is part of the case for them.

**Stability:** no. Rename changes it. `/rename` (`characters.js:769`) derives a new filename from
the new display name, writes the PNG there, unlinks the old, and `cpSync`+`rm`s the chats folder to
a new path. The client-side consequence is the proof of cost (`script.js` ~7441): after a rename it
hand-migrates `renameTagKey`, `world_info.charLore` by name, `extension_settings.note.chara` by
name, `active_character`, emits `CHARACTER_RENAMED`, calls `charactersStore.reportRenamed`,
`renameGroupMember`, optionally rewrites past chats, and then pops a toast telling the user to
rename the sprites folder by hand. That is a manual fan-out across every avatar-keyed persistence
site, and it already leaks.

**Recycling:** yes, and this one is a correctness bug. Delete is a plain `unlinkSync` with no
tombstone. Importing a new card with the old name reclaims the filename, so a stale avatar reference
resolves to a *different character*, silently. The rename path's chats-folder move is skipped if the
destination already exists, so renaming into a previously-used name orphans chats.

**Stability across avatar image change:** yes. `/edit-avatar` and `/edit-attribute` write back to
the same `avatar_url`-derived filename.

**Can a character lack an avatar?** Not in practice — `processCharacter()` assigns
`jsonObject.avatar = item` (the filename) over whatever the card claimed. The `avatar: 'none'` seen
in import paths is overwritten at listing time, and client `!= 'none'` checks are display fallbacks.
One caveat: `tags.js:935` carries a comment recording a real malformed character on this install
with a falsy `avatar`, guarded against because `tag_map[undefined] = []` silently creates a
permanent `"undefined"` string key. So the guard is load-bearing and must survive any migration.

**Any other id already in the card?** No. There is no UUID anywhere in the card pipeline (the
`uuidv4` in `script.js` is only `chat_metadata.integrity`). The v2/v3 spec fields carry
`create_date` (a plain ISO timestamp, not unique) and `character_version`; `date_added` is `ctimeMs`
and moves on every write.

### 2.2 The decision — SETTLED: Option A, UUIDv7

Under settled decision 1 (correctness over cost), "identity that mutates on rename and gets recycled
on delete" is not a correctness-neutral choice. **SETTLED:** the owner has chosen Option A, minting
an immutable UUIDv7 at create/import time and naming the PNG after it. Options B and C are recorded
below for the reasoning trail only; they are not live.

One consequence that must not be missed: `avatar` and `id` become the same value. Today they are
two concepts that happen to coincide — `avatar` is a filename, and `id` is an array index. Under
Option A the filename *is* the uuid, so there is exactly one identifier for a character, and it is
the same string in the DOM, in `tag_map`, in group `members`, in the search index, in the chat
directory name, and in `character.avatar`. Everywhere this document says "avatar" or "id" for a
character, it means that one uuid string. There is no mapping table, no translation step, and
nothing that can desync, which is the point of picking A over C.

Two follow-ons from that unification:

- `character.avatar` keeps its name in the card payload for upstream compatibility, but it stops
  being a *name-derived* value. Anything deriving a display string from the filename (title
  attributes at `script.js:1043`, the `show_card_avatar_urls` display at `:1045`) now shows a uuid
  and has to read `character.name` instead.
- The `data-avatar` DOM attribute becomes uuid-valued, which incidentally removes the CSS-selector
  escaping hazard noted in §2.3: a uuid is a valid CSS identifier fragment, unlike a filename with
  dots and spaces.

**Option A:** mint an immutable id at create/import time, and name the PNG after it.
UUIDv7 (time-ordered, so `date_added` ordering roughly falls out of the id itself). Display name
lives purely in the card payload. Consequences:

- `/rename` collapses to a card-data edit — no file move, no chats-directory `cpSync`, no
  tag/charLore/note/`active_character` fan-out, no "please rename your sprites folder" toast. The
  entire client-side rename block (`script.js` ~7441) deletes itself. Rename today is slow *because*
  it is a fan-out, so this is a user-visible improvement, not only a correctness one.
- Delete-recycling becomes impossible; a dangling reference stays dangling and can be *detected*
  rather than silently resolving to a stranger. This matters directly for §4's destructive-existence
  cluster.
- `getPngName()`'s 10k-probe loop and its overwrite-on-exhaustion path both disappear.
- Accepted cost: filenames stop being human-readable, so managing the corpus with a file manager,
  `rsync`, or shell globs no longer works by name. Partial mitigation: the metadata DB (§3.1) can
  emit a name → uuid listing on demand, so a shell workflow becomes "look it up, then act", not
  "impossible". Worth building as a small CLI/endpoint alongside phase 4d rather than leaving the
  owner to write ad-hoc SQL.
- Cost: a one-time migration must rewrite `tag_map`, chat directory names, group `members`,
  `charLore` and `note.chara` keys, `active_character`, and the search index — atomically enough to
  survive interruption at 300k+ rows.

*Not chosen, kept for the reasoning trail:*

**Option B:** keep human-readable filenames and fix the defects around them.
Keep name-derived filenames; add a persistent tombstone set so a deleted name is never reissued, and
make rename a two-phase operation that updates a server-side mapping before touching the file.
Consequences: readable filenames survive; but identity is still mutable, so every avatar-keyed
persistence site keeps needing rename fan-out, and the fan-out is exactly the thing that already
leaks. Correctness becomes a property maintained by discipline at every new call site rather than by
construction.

**Option C:** hybrid — minted immutable id as the key, filename stays readable, sidecar maps
id ↔ filename. Buys back readable filenames, at the cost of a second source of truth that can
desync from the filesystem, and the filesystem is currently the *only* thing enforcing uniqueness.
Under a corpus maintained partly by dropping files into the directory by hand (which is how the
current import works), desync is not hypothetical.

Option A was chosen because it is the only one where the id is stable *by construction* rather than
by discipline maintained at every call site, and because it is the only one that makes the §4.2
destructive-existence cluster safe: with no id recycling, "not found" means "not there".

### 2.3 The `this_chid` / `data-chid` migration

**SETTLED:** this gets finished completely, and it is not a blocker.

The fork is already most of the way through it. `this_avatar` exists in `script.js` and is
documented as the source of truth for selection; `this_chid` is demoted to a derived cache
recomputed in `setCharacterId()`; `charactersStore` is `new EntityStore(characters, c => c.avatar)`.
A large fraction of the ~110 `this_chid` hits are residue rather than live index-identity.

So the work is mostly *deletion*, and every shape in the table below has a mechanical replacement
that can be applied today, against the current fully-resident array, with no dependency on the
server work in phases 1–3. `this_chid` and `data-chid` can therefore be removed entirely in phase 4b
as an ordinary refactor, and after that no index-based identity remains in the client's own code.
The PromptManager legacy path (§2.4 iii) reads `this_chid`, but it is settled as a straight deletion
and gates nothing. It is not what makes the chid removal hard and must not be allowed to hold it
hostage.

The rule for "fully finished" rather than "mostly": no `this_chid` declaration, no `data-chid`
attribute, no `chid` attribute, no `characters.indexOf`, and no *internal* function signature taking
a character index. If a call site cannot be converted, it is a finding to escalate, not a fallback
branch to leave in.

There is one carve-out, and it is the only one: the public extension API keeps a chid-shaped input
path where upstream has one, since `writeExtensionField` accepts both forms (decision 16, §9.4,
phase 0d). That is a *compat surface*, not internal identity, and it is the exception that has to be
named rather than discovered. What the chid branch resolves *against* after phase 5 is coupled to
the open §9.4 decision: while the full array is still resident it can resolve positionally, and once
residency is bounded it either resolves against a maintained handle space (§9.4 Option 2) or
degrades to a warning-and-fail. Decision 16 settles the signature; it does not by itself settle
that.

The distinct shapes, and their replacements:

| Shape | Where | Replacement |
|---|---|---|
| DOM round-trip | `script.js:1030` writes both `data-chid` and `data-avatar`; readers at `script.js:11741`, `RossAscends-mods.js:850`, `tags.js:965`, `BulkEditOverlay.js:652`, `group-chats.js:2112` already prefer avatar with chid as fallback | Delete the `data-chid` write and the fallback branches. One orphan: `public/index.html:7245` has a bare `chid=""` attribute (different attribute name, missed by the earlier sweep) and `tags.js:887` builds a selector off it. Also `id="CharID${id}"` (`script.js:1030`): under Option A the value is a uuid, which *is* a safe CSS identifier fragment, so `CharID${uuid}` would work; drop it anyway and select on `[data-avatar="…"]`, so there is one way to find a card rather than two. |
| `this_chid === undefined` as "nothing selected" | ~56 of the ~110 hits, almost always `&& !selected_group`: `cfg-scale.js:116`, `bookmarks.js:64`, `regex/index.js:676`, `stable-diffusion/index.js:877` | 1:1 swap to `this_avatar === undefined`. But it is a *tristate* — character / group / temp-chat (`name2 === neutralCharacterName`, `chats.js:1858`) — so introduce one selection accessor returning a tagged value and route all of these through it rather than repeating the conjunction. |
| `Number(this_chid) >= 0` | `personas.js:1938` | Not a swap. It only works because `Number(undefined)` is `NaN`. Rewrite against the selection accessor. |
| `indexOf` to manufacture an index for a callee | largest `indexOf` bucket; `utils.js:2783` `getCharIndex`, `group-chats.js:437`/`:472`, `welcome-screen.js:533` | Every one of these already holds the avatar. Change the callee signature to take an avatar; the `indexOf` deletes itself. |
| Belt-and-suspenders `this_chid !== undefined && getCurrentCharacter()` | `script.js:6331`, `slash-commands.js:5334` | Delete the first conjunct. |
| Group generation cursor | `group-chats.js:1116-1164`: `activatedMembers` is an array of chids while `group.members` is already avatars, so `:1211`/`:1264`/`:1280` convert avatar→index→avatar | Make `activatedMembers` an array of avatars. Pure round-trip removal. |

Sentinels do not unify, and the migration must keep them distinct:

- `undefined` = no selection (never `-1`).
- `-1` from `indexOf`, which degrades quietly because `characters[-1] === undefined`
  (`script.js:9874` has a comment admitting this). Under a keyed store this must become an explicit
  miss, not a quiet undefined.
- `null` / `''` for the persisted `active_character`.
- `this_chid` is a string, so `'0'` is truthy. `power-user.js:3141`'s `if (!characterId)` only
  survives because `getRandomCharacterId` stringifies at both returns. Anything that starts
  returning a number there makes index 0 mean "no characters". Avatar strings are never `'0'`, so
  this hazard disappears, but only if no intermediate step reintroduces a numeric id.

Ordering and adjacency: index does not encode sort order. `sortEntitiesList`
(`power-user.js:2704`) sorts on `sortFunc(a.item, b.item)`, never on id; the index is `readdirSync`
order. There is no next/prev character navigation anywhere. The only adjacency is shift-click range
select (`BulkEditOverlay.js:761`), which already walks the rendered DOM node list — the correct
thing under pagination — and compares numeric ids inside, which is a local fix.

### 2.4 The three sites with no clean 1:1 replacement

These are the actual work: each needed a decision rather than a rename. All three are now settled,
(i) and (ii) as approved fixes and (iii) as a deletion, but the reasoning is kept because it is what
the implementation has to preserve.

**(i) `entity.id` as a cross-structure join key.** `getEntitiesList` (`script.js:1296`) builds
`characterToEntity(item, index)`; `filters.js:384` caches fuzzy scores keyed by Fuse's positional
`refIndex`; `power-user.js:2726` reads them back as `${a.type}.${a.id}`. Three structures agreeing
on a number that none of them owns. Groups already use a real `group.id` string here, so characters
are the odd one out. Under pagination `refIndex` becomes page-local and the join silently mismatches
instead of erroring: a wrong result, not a crash. Fix: `characterToEntity` takes the avatar as `id`;
the score cache is keyed `character.<avatar>`; Fuse's positional `refIndex` stops being used at all
(it disappears anyway with §7's index replacement).

**(ii) the same seam server-side.** `fetchServerCharacterSearchResults()` receives avatar-keyed hits
and `findIndex`es them into a `Map<number, number>` (`script.js:11502`) purely because
`searchFilter()` eats indices. Avatar identity survives the entire server pipeline and is discarded
at the final step, and any avatar not currently resident drops silently via `findIndex → -1`. Fix
falls out of (i): keep the map avatar-keyed end to end.

**(iii) `PromptManager` legacy migration** — not the blocker this document first called it.

The earlier draft called this "the single hardest ordering constraint in the whole plan". That was
wrong. What the code says:

- The legacy path is fork-local, not upstream. `legacyId` was added by commit `9cd8330cd`
  (2026-08-20) as part of this fork's own avatar rekey. `origin/staging`'s PromptManager.js does not
  contain the string at all — upstream still does a plain
  `find(list => String(list.character_id) === String(character.id))`. So the upstream-compatibility
  framing inverts: deleting the legacy path moves this file back toward upstream, not away from it.
  Preserving it is what costs compatibility.
- The branch it lives in has been unreachable since 2023. Every `legacyId` write is inside the
  `'character' === strategy` branch. There is exactly one `new PromptManager()` in the codebase
  (`openai.js:681`) and it hardcodes `strategy: 'global'` (`openai.js:697`), hardcoded by commit
  `b0158bd72` in August 2023. Nothing in `public/` sets `'character'`.
- There is no data to migrate on this install. `settings.json` has exactly two `character_id`
  entries, `100000` and `100001`, both dummy ids. Same across all six presets in
  `OpenAI Settings/`. Zero real per-character entries.
- It never completes and never stamps itself: it re-checks on every character select forever, and
  self-terminates only per-entry, by rewriting `character_id` in place on a hit.
- There is no discriminator. Everything is compared through `String()`. A legacy `3` and a modern
  id differ only by "does it look like an id", and the dummy ids are themselves numbers in the same
  array.
- Reconstruction is not merely hard, it is wrong. The chid meant "position in `readdirSync` order
  *in 2023*". Anyone who has since deleted a character gets a confidently incorrect answer rather
  than a missing one.
- There is an inbound channel bounded residency cannot close. `prompt_order` also lives in every
  chat-completion preset file (`openai.js:377`), so numeric ids can arrive from a downloaded preset
  at any future time. No one-shot migration covers that.

**SETTLED:** option (d) — delete it. The options below are kept for the reasoning trail. What
"delete it" means concretely:

- Remove the `legacyId` plumbing from `PromptManager.js` and the `id: this_chid` payloads on the
  `CHARACTER_EDITED` / `CHAT_LOADED` handlers, returning the file to upstream's
  `find(list => String(list.character_id) === String(character.id))`. This *reduces* the fork's diff
  against upstream rather than growing it.
- Pre-August-2023 per-character entries, if any exist anywhere, fall back to
  `addPromptOrderForCharacter(default)`, the same path a brand-new character takes. Not a crash, not
  a corrupt state: a default prompt order.
- Nothing needs to run before phase 5, nothing needs a version stamp, and there is no ordering
  constraint left. Phase 4c becomes a deletion that can land at any point, including immediately.

One thing the deletion does not cover, and it should be recorded rather than quietly dropped:
numeric `character_id` values can still arrive from a downloaded chat-completion preset
(`openai.js:377`), because presets are a separate inbound channel from settings. After (d) those
entries never match and the character falls back to the default order, which is the same outcome as
today for any preset written against someone else's library, so this is not a regression. Option (e)
below remains available later if unresolvable entries ever turn out to be a live nuisance; it is
additive and does not depend on (d) having been done differently.

*Not chosen, kept for the reasoning trail:*

- **(a) Eager server-side reconstruction at startup/import.** The server can produce a directory
  listing, so it could rebuild a mapping. Costs: it would have to rewrite preset files server-side,
  which upstream's server never does; and it reconstructs *today's* ordering, not 2023's, so it is
  wrong wherever a character was deleted. Upstream-compat: frees PromptManager.js to revert, at the
  price of new server code upstream does not have.
- **(b) Eager client-side one-shot before the residency cutover, then delete the path.** Same
  reconstruction, run while the array is still resident. Costs: needs a "did I run" stamp, and this
  data has no version field anywhere today, so it means inventing the first one; and it does not
  cover presets imported after cutover. Upstream-compat: best of the *migrating* options — after the
  one-shot, the file returns to upstream shape.
- **(c) Keep it lazy, backed by a server endpoint answering "what was the chid of X".** Costs: a
  permanent public API whose only job is to expose the positional index being abolished, and it
  still cannot answer the question being asked (the 2023 index). Keeps the fork-local diff forever.
- **(d) Delete it and accept the break.** Pre-August-2023 per-character entries fall back to
  `addPromptOrderForCharacter(default)`. Affected population: users who ran ST before Aug 2023, still
  hold such entries, *and* run a build that re-enables `'character'` strategy — currently nobody.
  Upstream-compat: strictly best; the file returns to upstream's one-liner.
- **(e) Normalize rather than reconstruct, inside the existing migration hook.**
  `migrateChatCompletionSettings()` (`openai.js:4246`) already runs on both settings load *and*
  preset load, i.e. it already covers both channels `prompt_order` travels on. A shape-level rule
  there could prune or neutralize entries whose `character_id` is neither a dummy id nor id-shaped.
  This recovers nothing (nothing can), but it stops unresolvable entries being a live hazard, and it
  is the only option that covers the inbound-preset channel. Costs: destructive on unverifiable
  data, and it adds to a file upstream edits often, a small additive merge-conflict surface.

Why (a), (b) and (c) lost: all three spend real effort reconstructing a mapping for a code path
nothing currently reaches, and all three reconstruct *today's* directory ordering rather than 2023's,
so they would produce confidently wrong answers wherever a character has since been deleted. A
migration that silently mis-assigns is worse than no migration.

Two more sites:

- `power-user.js:3119` picks a random character via `Math.floor(Math.random() * characters.length)`.
  "The nth of all characters" has no id equivalent; it becomes a server query — see §5.3, which also
  covers the separate random-*sort* problem.
- `st-context.js:188` exposes `context.characterId` as a lazy getter doing a full `findIndex` per
  read, on the public extension API. Correct with respect to staleness, O(n) per access at 10M. And
  `context.characters` is exported raw to every extension for back-compat. So bounded residency is
  an *extension API break*, not just an internal change — see §9.4.

---

## 3. Server-side data architecture

**SETTLED:** introduce a SQLite metadata database as the server-side index of record for everything
that is not full text, and leave tantivy/FTS5 responsible for full text only.

Rationale:

- `better-sqlite3` plus the `node-sqlite3-wasm` fallback are already hard dependencies with a
  working two-tier engine abstraction (`src/endpoints/sqlite-engine.js`), so this adds no new
  platform risk. Tantivy, by contrast, is optional and has prebuilts only for macOS, Windows and
  linux-x64-gnu. A design that puts sort keys, tag relations and change tracking into tantivy fast
  fields would make the whole application non-functional on any platform that falls back.
- The queries §4 and §5 need are relational (`WHERE tag_id = ? ORDER BY name LIMIT ? OFFSET ?`,
  reverse indexes, aggregates), which is what SQLite is for and what a full-text index is not.
- Tantivy has no update-in-place; a row change is delete-by-term plus add. Cheap metadata mutations
  (fav toggled, a tag assigned, `date_last_chat` bumped after every single message) would each force
  an index segment write. SQLite absorbs those at negligible cost.

Verified by running a probe against the installed binding (v0.1.0, Node 22), so the incremental
plan in §3.3 rests on measurement rather than documentation:

- `writer.deleteDocumentsByTerm(field, value)` exists and works; delete + re-add in one writer is
  a working update-in-place. Deletes are invisible until `commit()`.
- `Index.open(dir)` reopens an existing on-disk index and delete+add works on a fresh writer, so
  incremental maintenance across process restarts is real.
- `addIntegerField` / `addDateField` / `fast: true` all exist and work.
  `search(query, limit, count, orderByField, offset, order)` sorts by a fast field
  (re-tested with insertion order scrambled against the sort key), and `offset` + `limit` both work.
  Ordering by a non-fast field throws rather than silently ignoring.

Three findings that change how it must be used:

- The delete key must be a `tokenizerName: 'raw'` field. Deleting by a `default`-tokenized field
  matches on a single token and destroyed an unintended document in the probe. This is not
  hypothetical.
- There is no per-document identity field in the current schema at all. `tantivy-search.js:80-82`
  builds per-column text fields plus one stored blob; nothing is keyable. So incremental maintenance
  requires adding a raw-tokenized id field first, a schema change, which forces exactly one final
  full rebuild before incremental takes over. Schedule that as part of phase 2, not as a surprise.
- `SearchHit.order` is garbage: every hit returned `i64::MAX` as a double regardless of the
  actual sort key. The *ordering* is correct; the per-hit number is not. Never read the sort key off
  a hit.
- `deleteDocumentsByQuery(query)` also exists. `garbageCollectFiles()` is documented as a no-op
  in this binding ("requires an async runtime"), so segment files may accumulate over many
  delete/add cycles. That is untested over long runs and worth watching once incremental maintenance
  is live, since a long-lived index is a new thing for this codebase.
- Minor: `TextFieldOptions` has no `indexed` key (only `stored`, `fast`, `tokenizerName`,
  `indexOption`); nothing in this design should assume one.

### 3.1 Schema

One database per user handle, alongside the existing per-user directories.

```
characters(
  id            TEXT PRIMARY KEY,   -- the immutable id from §2.2 (== the PNG filename stem)
  name          TEXT NOT NULL,
  name_fold     TEXT NOT NULL,      -- case+accent folded, for prefix lookup and A-Z sort
  fav           INTEGER NOT NULL,
  date_added    INTEGER NOT NULL,
  create_date   TEXT,
  date_last_chat INTEGER NOT NULL,
  chat_size     INTEGER NOT NULL,
  data_size     INTEGER NOT NULL,
  file_mtime    INTEGER NOT NULL,   -- drives the client delta feed
  world         TEXT,               -- data.extensions.world, for the reverse index in §4.3
  creator       TEXT,
  version       TEXT,
  creator_notes TEXT,               -- only if shallowCharactersIncludeCreatorNotes
  shallow_json  BLOB NOT NULL,      -- the toShallow() projection, ready to ship
  rev           INTEGER NOT NULL    -- monotonic, from the change log
)
character_tags(character_id TEXT, tag_id TEXT, PRIMARY KEY(character_id, tag_id))
tag_usage(tag_id TEXT PRIMARY KEY, count INTEGER NOT NULL)   -- maintained by trigger
changes(rev INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, op TEXT NOT NULL)
meta(key TEXT PRIMARY KEY, value TEXT)                        -- schema version, oldest retained rev
```

Indexes: `(name_fold)`, `(date_added)`, `(date_last_chat)`, `(chat_size)`, `(fav, name_fold)`,
`(world)`, `character_tags(tag_id, character_id)`, `changes(id)`.

`shallow_json` is the key economy: today the tantivy index stores the *entire* character JSON (13 KB mean)
and `toShallow()` throws most of it away per hit (`characters.js:422`). Storing the shallow
projection directly means a 500-row page parses ~500 KB instead of ~12 MB.

`create_date` stays TEXT because it is the card's own ISO string.

**SETTLED:** `date_added` is recorded once, at first index, and never recomputed. It stops being the
PNG's `ctimeMs`. `ctimeMs` was never a real "added" timestamp; it is a filesystem artefact that
moves on a chmod, a chown, or any metadata write, which is a limitation of the current
filesystem-as-database arrangement rather than a property worth preserving. Consequences to
implement:

- The column is written on insert and is never touched by an update, a reconcile pass, or a
  rebuild. Only a row's first appearance sets it. A repair/rebuild that recomputed it would silently
  reset the whole library's "Newest" ordering, so the rebuild path must preserve it.
- Backfill for the existing library seeds it from `ctimeMs` once, the best available
  approximation for cards that predate the column, and then freezes.
- Under Option A the id is a UUIDv7, which is time-ordered, so the id is a stable tiebreaker for rows
  sharing a `date_added`, which the bulk-import case below produces in quantity. Note it is a
  tiebreaker only: once imports may supply their own `date_added` (next bullet), id order and
  `date_added` order diverge by design, so the id is not a sanity check on the column.
- **SETTLED:** an import may supply its own `date_added`, optionally. When supplied, it is written as
  given; when absent, it falls back to discovery time ("now"), the
  file-dropped-into-the-directory case. Without this, a 301k bulk import would share roughly one
  timestamp and within-batch "Newest" ordering would be arbitrary. Details that matter:
  - It is optional per *record*, not per batch. A corpus with timestamps for some cards and not
    others gets real values where they exist and discovery time elsewhere, rather than an
    all-or-nothing choice.
  - The value is still write-once. Supplying it is a way of setting the column at first index; it is
    not a way of *updating* it later, and a re-import of an existing id must not move it.
  - Because supplied and discovered values can interleave, a supplied timestamp may sort *before*
    rows already present. That is intended, and preserving corpus order is the whole point, but
    it means "Newest" is no longer append-only, and anything that assumed new rows land at one end
    (a cached first page, say) has to tolerate insertion in the middle.
  - Trust boundary: the value is caller-supplied, so it needs range validation (reject
    non-finite, negative, or absurdly-future values) rather than being written through unchecked.

### 3.2 Keeping it fresh

Three mechanisms, in order of latency:

1. Write-path hooks. `writeCharacterData()` (`characters.js:259`), the delete handler,
   `/rename`, and the import handlers each upsert/delete the metadata row and append a `changes`
   entry, in one transaction. This is where the circular-import concern that currently keeps
   `characters.js` away from the index is resolved: the metadata module has no dependency on the
   endpoint module, so the arrow points one way.
2. A single non-recursive `fs.watch` on the characters directory, with the understanding that it
   is a latency optimization and never a correctness mechanism.

   Measured on this machine rather than assumed. The good half: a non-recursive watch on a flat
   directory costs exactly one inotify watch regardless of file count, confirmed by
   counting `inotify wd:` lines in `/proc/<pid>/fdinfo/` before and after creating 200k files in the
   watched directory (1 both times). Against `max_user_watches` of 524288 that is a non-issue at any
   library size.

   The bad half, and it is worse than "documented behaviour": with the creator in a separate
   process and Node free to drain, 200k creates produced 200k events with zero loss. With the burst
   arriving while the event loop was blocked, the same 200k creates produced exactly 16384
   events, the value of `max_queued_events`, and silently dropped 183,616. No `error` event fired in
   either case. `IN_Q_OVERFLOW` does not surface through Node's `fs.watch`; the watcher stops
   reporting and later resumes, and from JS there is no way to distinguish "I saw everything" from
   "I missed 183k files".

   So the discriminator is not library size, it is whether the event loop is busy when the burst
   lands, which during a bulk import it is. This is why (3) is mandatory rather than a
   backstop, and why the watcher must never be trusted as the sole source of truth. (Tested to 200k;
   not tested at 10M, and the cost of watching a directory that *already* contains millions of
   entries was not measured.)
3. A background reconciler, the authority on what is on disk rather than a backstop (see the
   silent-overflow finding in (2)). It uses async `opendir` at a bounded rate off the
   request path, comparing directory contents and mtimes against the metadata table and emitting
   `changes` rows for drift. It runs at boot (non-blocking) and on an interval, plus an explicit
   rescan endpoint. This replaces the current design where the *only* freshness mechanism is a
   synchronous `statSync` of the directory on every search request, whose only remedy is nuking and
   rebuilding the entire index.

The existing full-rebuild path stays, demoted to a repair tool behind an explicit endpoint rather
than something a directory mtime change can trigger implicitly.

### 3.3 Server-side memoization: no unmemoized full-disk reads

At 300k cards the library is 504 GB (§1, measured). Anything that re-reads or re-parses it is not a
performance detail, it is the dominant cost of the whole system. The manifest/mtime machinery
in §5.2 and §7 does nothing for it, because that is a cache on the *other* side of the wire. This
section is the server's own answer, and it was a gap in the first draft.

What is already memoized, and what is not. `readCharacterData()` (`characters.js:200`) is
mtime-keyed: `getCacheKey()` returns `` `${path}-${mtimeMs}` ``, checked against an in-memory
`MemoryLimitedMap` and then a node-persist disk cache under `_cache/`. The PNG tEXt extraction is
not repeated for an unchanged file. That part is right and it stays.

Everything around it is unmemoized, and `processCharacter()` (`characters.js:394`) runs all of it
per character per request:

- `getCacheKey()` itself does an `existsSync` plus a `statSync`, two syscalls before the cache
  can even be consulted.
- A second `statSync` on the same file for `date_added`.
- `calculateChatSize()` (`src/character-shallow.js:23`): an `existsSync`, a `readdirSync` of that character's chat
  directory, and a `statSync` per chat file, every time.
- `JSON.parse` of the card string (13 KB mean, 96 KB p99). Only the *string* is cached, never the parsed object, so
  the parse is paid on every hit.
- `getCharaCardV2()` normalisation, likewise per hit.

At 300k characters, one plain browse request is on the order of 1.5M syscalls and 3.9 GB of
`JSON.parse`, to display 50 rows. The memory cache is also mis-sized for the target: 1000 MB is
configured (`config.yaml:98`) and the code's own comment puts that at roughly 30k characters, so at
300k it holds a tenth of the library and thrashes, pushing everything onto per-character
node-persist files.

Worse is the search index rebuild. Index freshness is `statSync(charactersDir).mtimeMs`, and any
change triggers `rmSync` of the index directory followed by a full rebuild over every card (§1.2).
At 24k cards that was measured at ~6 s and consciously accepted. At 300k it is a full pass over the
library triggered by *one* card changing, which during a 301k-file bulk import means continuously.
`Index.open()` is never called, so the persisted index is not reused across restarts.

The rule this design commits to: *a character file is read and parsed once per change event,
never once per request.* Concretely:

1. The SQLite metadata table is the memoization layer for browse. `shallow_json` plus the sort
   and filter columns (§3.1) mean the browse and query paths touch zero PNG files and do zero
   stat calls; they read rows. This is the largest single win. It falls out of §3 rather than
   needing new machinery, and is called out here because it was not obvious that §3 was also the IO
   answer.
2. Freshness comes from the watcher and the reconciler (§3.2), not from stat-on-read. One stat
   per file per change event, in the background, off the request path. The per-search-request
   `statSync` of the characters directory is deleted.
3. The index build becomes incremental, driven by the same `changes` log: a changed card is one
   delete-plus-add, not a rebuild. `Index.open()` is used so the persisted index survives restarts.
   Full rebuild survives only as an explicit repair endpoint. This is the change that makes bulk
   import viable at all; see (7).
4. Chat statistics get their own invalidation source. `date_last_chat` and `chat_size` are the
   one pair of columns not derivable from the character file's mtime, and they change on every
   message sent. The chat write path updates the metadata row directly; the reconciler may repair
   drift but must never be the primary mechanism, because a periodic full chat-directory walk is
   exactly the library-scale scan being eliminated. (This also fixes `/api/chats/recent` and
   `stats.js` from §1.3.)
5. Full-card reads stay lazy and stay cached. Hydrating a selected character
   (`unshallowCharacter`) is the one place a PNG parse is legitimate. The existing mtime-keyed LRU
   plus disk cache is the right structure; what changes is that it stops also carrying list
   rendering, so its working set becomes "cards the user actually opened", small enough that a
   raised memory cap becomes worth spending, and small enough that caching the *parsed* object
   rather than the JSON string becomes affordable.
6. `getCacheKey()`'s `existsSync` + `statSync` pair collapses into one `stat` whose `ENOENT` is
   the existence answer. On the hydration path the mtime is already known from the metadata
   row, so it need not be stat'd at all.
7. Bulk import needs an explicit batch mode. 301k files arriving through the per-file write path
   means 301k transactions, 301k index writes, and 301k watcher events. A batch mode that suspends
   the watcher, accumulates rows into one transaction per N files, and does a single index commit at
   the end is required, not optional, for the owner's near-term task. The reconciler is what
   makes it safe: an interrupted batch is found as drift on the next pass.

   The batch mode must also carry an optional per-record `date_added` through to the metadata
   insert (§3.1), falling back to discovery time when absent. This is the one place a caller can set
   that column, since it is write-once and the reconciler has no way to know a dropped file's
   intended age. Two consequences for the batch path specifically: the fallback has to be computed
   per record rather than once per batch if "now" is to mean anything within a long-running import,
   and validation of supplied values belongs here rather than in the DB layer, so a bad value fails
   the record rather than the transaction.
8. The disk cache's `verify()` boot scan (`characters.js:131`, readdir plus stat of every file
   for every user) is subsumed by the reconciler and should be deleted rather than run alongside it.

The residual cost: the first pass over the 504 GB corpus has to happen once, to populate the
metadata table. Something has to read every card once and nothing can avoid that. What the design
buys is that it happens exactly once, in the background, restartably, rather than per request and
per index rebuild.

### 3.4 Migrating `tag_map` off `tags.json`

`tag_map` is a second whole-library-resident structure and, at 16 MB for 24k characters, it hits the
wall before the character array does. It moves into `character_tags`. Tag *definitions* (`tags`)
stay in `tags.json` and stay fully client-resident: that set is small, and `filters.js`'s
tag-filter UI needs all of them.

New/changed endpoints:

- `POST /api/tags/for` `{ ids: string[] }` → `{ [id]: tagId[] }`. Called once per rendered page.
- `POST /api/tags/assign` / `POST /api/tags/unassign` `{ id, tagId }`. Single-row writes replacing
  the current full-file rewrite at `src/endpoints/tags.js:68`.
- `GET /api/tags/usage` → `{ [tagId]: count }`, read straight from `tag_usage`. This one aggregate
  subsumes three separate full scans (§4.3).
- `/api/tags/save` keeps working for tag *definitions* only.

`RelationStore` (`entity-store.js:399`) already maintains incremental usage counts client-side for
`tag_map`, which is exactly the shape `tag_usage` takes server-side, so the consumer contract does
not change, only where the number comes from.

---

## 4. Full-collection semantics

The audit sorted every `characters` access. Counts by category:

- **(a) identity/selection** — `script.js` ~16, `group-chats.js` ~16, `BulkEditOverlay.js` ~7,
  `world-info.js` ~3, `slash-commands.js` 2, `power-user.js` 2, `welcome-screen.js` 2,
  `gallery` 2, `utils.js` 1, `st-context.js` 1. Covered by §2.3.
- **(b) single-item lookup** — `script.js` ~35, `group-chats.js` ~19, `slash-commands.js` ~7,
  `welcome-screen.js` 8, `world-info.js` ~5, `personas.js` 2, `tags.js` 1, `BulkEditOverlay.js` 1,
  `utils.js` 1. Mostly already `charactersStore.get()`. These become an async-capable keyed get
  (§6). Two oddities: `script.js:4642` and `group-chats.js:1715` build a full avatar→index `Map` and
  then read a handful of keys out of it, a full-scan costume over N keyed gets.
  `expressions/index.js:644` is keyed *backwards*, scanning all characters asking whether a message
  URL contains each avatar; it cannot become a `.get()` without first parsing the id out of the URL.
- **(c) true full-collection scans** — below.

So nobody spends time there: `bookmarks.js`, `stats.js`, `data-maid.js`,
`tags-cache.js`, `filters.js` and `bulk-edit.js` have zero real `characters` accesses.
`filters.js` and `bulk-edit.js` only ever touch the array `getEntitiesList()` hands them, which is
why fixing that one function removes a large part of category (c) by construction.
`assets/index.js:472`/`:479` is a local variable holding the remote asset list, a false positive.

### 4.1 The list/query pipeline

| Site | Question it answers | Server query needed |
|---|---|---|
| `script.js:1296` `getEntitiesList` | the page of entities to render | (tag filter state, folder state, fav/group flags, search query, sort field+order, page, pageSize) → one page of shallow rows + total match count |
| `script.js:11502` | re-ranking server hits back into client indices | disappears; keep avatar-keyed end to end (§2.4 ii) |
| `group-chats.js:1717` `getGroupCharacters` | the entire non-member library, as a pagination dataSource | not-in-member-set + search/tag/fav predicates + sort → page + count |
| `script.js:1198` | the "N hidden" badge | currently conflates *filtered out* with *not on this page*; needs total-matching-count for the active filter, separate from library total |
| `script.js:9000`, `:9033` | "which page is this newly-imported character on" | rank of a specific row under the current sort+filter — inherently a live query, cannot be a counter |

That last one is the awkward one nobody predicted. `SELECT COUNT(*) … WHERE <filter> AND <sort key
precedes this row's sort key>` gives it, which is a real query but an expensive one at 10M without
a covering index on the sort key. It only fires after an import, so the cost is acceptable; it
must not be on any hot path.

### 4.2 Existence checks that are destructive when they answer wrong

This is the cluster to worry about most, because under bounded residency "not resident" reads as
"deleted" and the code then *writes that conclusion to disk*:

- `group-chats.js:268` → `validateGroup` `:279-290`: unresolvable members are deleted and the
  group saved.
- `world-info.js:3652`: an unresolvable character filter binding is deleted and the world info
  saved.
- `tags.js:2379` (tag-backup restore) and `tags.js:2446` (`onTagsPruneClick`): both ask "does this
  avatar exist anywhere". K is bounded by the input, not the library.
- `script.js:12790`: "does a character with this id exist" before zooming a message avatar. Harmless
  if wrong, but same primitive.
- `assets/index.js:359`: `characters.map(x => x.avatar)` then substring-match, run once per
  marketplace character — "does any id contain this string".

All of these need one primitive: `POST /api/characters/exists` `{ ids: string[] }` →
`{ [id]: boolean }`, chunked, answered from `characters` by primary key. It is cheap and
authoritative. **Shipped in phase 2** to exactly this shape, chunked 500 at a time, with every
requested id present in the response — but no client code calls it yet, so all the sites in §4.2 are
still doing resident-array checks. The two destructive sites additionally need a rule: a failed or
partial existence check must abort the mutation, never fall through to "delete it". Under Option A
(§2.2) the answer is also trustworthy in a way it is not today, because ids are never recycled.

`assets/index.js:359` needs a different primitive: a substring/`LIKE` query, or better, invert it
and send the marketplace ids to get back which ones already exist.

### 4.3 Reverse-index questions

- `world-info.js:4270` — lorebook rename fan-out: which characters point at world `oldName`. The
  count drives a confirmation popup, so a wrong count means the user consents to the wrong thing.
  Served by the `world` column's index (§3.1).
- `tags.js:145` — the question underneath is "which tags have ≥1 non-member character wearing
  them", currently computed by materializing every non-member character. Served by `tag_usage` plus
  a group-membership exclusion.
- `script.js:1355` — "does this tag apply to every entity in the library" (bogus-folder
  detection). Per-tag count from `tag_usage` compared against the library total.

### 4.4 Enumeration and resolution

- `SlashCommandCommonEnumsProvider.js:200` — biggest by fan-in (14 references in `slash-commands.js`
  plus `expressions`, `gallery`, `personas`, `tags`, `world-info`). Every character name, for
  autocomplete. Needs a prefix query with a limit, and the provider API is a synchronous
  `() => SlashCommandEnumValue[]`, so this is an interface change, not a data-source swap. It also
  currently carries no id, so duplicate display names are indistinguishable; the id should be
  attached while this is being touched.
- `utils.js:2719` `findChar()` — name → character, 14 slash-command call sites. Needs a
  case/accent-folded name lookup returning matches plus a count (it warns on ambiguity, so
  first-hit is not enough), plus tag conjunction as a server-side filter; the `filteredByTags` path
  currently materializes a tag-filtered copy of the whole array.
- `power-user.js:2470` `fuzzySearchCharacters` — the Fuse index over every character's full text.
  Replaced by §8 locally and by the existing server search remotely; callers read `.score`, so the
  replacement must produce comparable scores.
- `world-info.js:3108` — an `<option>` per character in a picker. Becomes search-as-you-type plus a
  separate resolve for already-bound names.
- `power-user.js:3120` `doRandomChat` — random pick over the library; the tagged path walks all of
  `tag_map`. Becomes `ORDER BY RANDOM() LIMIT 1` with the filter applied.
- `RossAscends-mods.js:306` `favsToHotswap` — scans everything to fill a 25-slot strip. Becomes
  `WHERE fav = 1 LIMIT 25` (the `(fav, name_fold)` index).
- `tts/index.js:1300` — maps every character name, and it runs on every `/speak`, not only when
  opening settings. Needs to be either lazy or bounded.

### 4.5 Incremental vs live

The split falls out cleanly and is worth respecting in the schema:

- **Incrementally maintainable** (a counter or aggregate the write path updates): library totals,
  per-tag usage counts (subsuming `tags.js:145`, `script.js:1355`, and the tagged half of
  `doRandomChat`), the favourites list, and the world → characters reverse index.
- **Inherently live** (depends on request-time filter/sort state or user input): the page query,
  `group-chats.js:1717`, the rank-of-item lookups at `script.js:9000`/`:9033`, and all three
  resolution paths (name prefix, exact name, full text).
- **Neither**: exists-by-key only, the whole §4.2 cluster.

### 4.6 A semantics gap, not a performance one

Bulk "select all" (`bulk-edit.js:46`) and shift-range select (`BulkEditOverlay.js:763`) both walk
`querySelectorAll` over *rendered rows*. That is already page-bounded, so nothing is slow. But at
10M, "select all" silently means "select this page", and bulk delete and export then act on that.
Nothing to fix for performance; the label and the confirmation copy have to stop lying, and a
"select all matching this filter" needs to be a server-side operation taking the filter, not a list
of ids.

---

## 5. The query endpoint

One endpoint replaces the browse half of `/api/characters/all` and backs `getEntitiesList`,
`getGroupCharacters`, and the enumeration paths:

```
POST /api/characters/query
{
  filter: {
    search?: string,              // routed to the FTS/tantivy index, joined by id
    tags?: { include: string[], exclude: string[], mode: 'and' | 'or' },
    fav?: boolean,
    world?: string,
    excludeIds?: string[],        // group member exclusion
    ids?: string[]                // resolve-by-id batch
  },
  sort: { field: 'name'|'date_added'|'date_last_chat'|'chat_size'|'fav'|'random'|'search', order: 'asc'|'desc' },
  page: number, pageSize: number,
  want?: ('rows'|'total'|'facets'|'rank')[]
}
→ { rows: Shallow[], total: number, facets?: {...}, rev: number, searchBackend?: string }
```

Notes on the shape:

- **SETTLED:** `total` may be approximate, but must never be capped. An exact count at 10M is the
  expensive part of an otherwise cheap query, so the count is allowed to be an estimate. What it is
  *not* allowed to be is a truncated number: no `LIMIT`-then-count, no "1000+", nothing that stops
  counting early. An approximate total still describes the real scope of the result set, so the
  pagination control knows roughly how many pages exist and the user knows roughly how big their
  result is. A capped total is a different number wearing the same label, and it makes the last
  pages of a large result unreachable.

  What that rules out: the current search path's behaviour, where the server fetches a bounded
  window and the client shows "Showing N of M matches" (`script.js:11518`) because `items.length` is
  a fetch cap rather than a match count. That pattern does not carry forward.

  What it permits, in rough order of preference:
  - Exact `COUNT(*)` whenever the filter is selective enough to be cheap. With the §3.1 indexes
    this covers most real queries; measure before assuming otherwise.
  - A maintained row count for the unfiltered case, which is the single most common query and the
    most expensive to count. The metadata store already has to track library size, so "everything,
    no filter" never needs a scan at all.
  - SQLite's own estimate (`EXPLAIN QUERY PLAN` row estimates, or a sampled count) for broad
    filtered queries, rendered as approximate: a `~` prefix, not a bare number.

  `want` still exists so a caller that does not need the count can skip paying for it. But when a
  total is returned, it is scope-honest.
- `sort: 'search'` is only valid with `filter.search`, matching the existing UI rule
  (`verifyCharactersSearchSortRule`, `script.js:1224`).
- `rev` lets the client detect that its cache is stale relative to what it just rendered.
- Combining a full-text search with a SQL filter and SQL ordering means one of the two engines has
  to feed the other. Both directions are workable: push the FTS hit-id set into SQLite as a
  temporary table and let SQLite do the filtering and ordering (correct, and the only option for
  non-rank sorts), or take SQLite's filtered id set into the FTS query (better when the search is
  highly selective). Start with the first — it is the one that composes with every sort field,
  random and rank included — and only add the second if profiling shows the id-set transfer
  dominating.

### 5.1 Index changes for search

The tantivy schema needs the `stored: true` payload changed from the full character JSON to just the
id, since rows now come from SQLite. That alone roughly halves the index footprint and removes the
13 KB-mean `JSON.parse` per hit that currently forces a hard row cap. The `offset: 0` hardcoding in
the search call goes away. `orderBy`, `offset`, `allQuery()`, and `addIntegerField`/`addDateField`
with `fast: true` were all confirmed working by probe (§3), including that ordering by a non-fast
field throws rather than silently ignoring, so no-term browse is schema plus call-site work, not an
engine wall. Since §3 puts sort keys in SQLite anyway the design does not lean on it, but the option
is real rather than documentation-level.

The same schema change that adds the id payload is where the `raw`-tokenized delete key belongs
(§3), so incremental maintenance and the payload shrink land together in one rebuild rather than
two.

### 5.2 Replacing the manifest

Once browse is server-paginated, a whole-library manifest on boot is no longer needed for rendering.
It is still needed for the cache: the client has to learn what changed since it last synced.

Replace `/api/characters/manifest` with a change feed:

```
POST /api/characters/changes { sinceRev: number }
→ { rev: number, changes: [{ id, op: 'upsert'|'delete' }], truncated: boolean }
```

Shipped in phase 2 to this contract, with one addition the contract should absorb: the response
collapses to **one entry per id**, latest op winning. Also note nothing prunes the `changes` log yet,
so `truncated` can currently only fire for a nonsense `sinceRev` — the bounded-window behaviour
described below is designed but not built. `/api/characters/manifest` is still live and still serving
the UI.

`truncated: true` means `sinceRev` predates the oldest retained `changes` row (the log is pruned to
a bounded window), and the client must treat its cache as unknown-stale. It does not have to throw
it away; it can revalidate lazily as rows are touched. `readdirSync` + N `statSync` per boot
disappears; the cost becomes proportional to what changed, not to library size.

### 5.3 Randomness: two unrelated things that share a word

`/random`, the slash command, has no button and no hotkey. It picks a character, sets it active, and
`reloadCurrentChat()`s, so it *opens* a chat rather than just highlighting a card. An optional
argument narrows it to a tag. Under the new model it is
`SELECT id … WHERE <filter> ORDER BY RANDOM() LIMIT 1`: one row, no residency requirement. The
tagged path today round-trips avatar → `indexOf` → position purely to satisfy the caller's chid
expectation; that round trip deletes itself.

Random sort order is a UX defect, redesigned here.

What it is: the dropdown option is `data-field="name" data-order="random"` (`index.html:6396`), so
random rides on `sort_order`, not `sort_field`. `sortEntitiesList` (`power-user.js:2712`) calls
`shuffle(entities)` — Fisher-Yates over `Math.random()`, in place, no seed (`utils.js:384`).

The defect: the sort *mode* is persisted (`saveSettingsDebounced` on the dropdown change, restored
at `power-user.js:2059`), but the *ordering* is not. It is re-derived on every render, so the
library has no stable identity from one render to the next.

What re-renders: every non-search `printCharacters()` / `printCharactersDebounced()`, every tag chip
toggle (~10 sites in `tags.js`), every filter change (`entitiesFilter` is constructed with
`printCharactersDebounced` as its callback, `script.js:701`), bulk-edit select/deselect, tag
create/delete/rename. Two corrections to the original report of the symptom:

- Typing in the search box does not reshuffle. `verifyCharactersSearchSortRule()`
  (`script.js:1224`) selects the hidden `search` sort option as soon as there is a term, and
  `sortEntitiesList` returns on the `isSearch` branch before reaching random. Cards do move while
  typing, but that is relevance re-ranking. Clearing the box flips back to random and *does*
  reshuffle.
- Paging does not reshuffle. The pagination plugin receives the already-shuffled array once and
  slices it, so page 2 → page 1 is stable, and so is the page-size changer.

Two further defects found while checking: the random branch `return`s before the `type === 'tag'`
pin, so bogus folders get shuffled in among the character cards instead of staying at the top; and
`getGroupCharacters` (`group-chats.js:1677`, `:1705`) goes through the same comparator, so the
group "add member" list reshuffles too.

The fix: replace the shuffle with a seeded ordering key. Sort by
`getStringHash(typePrefix + entityId, seed)` instead of shuffling. `getStringHash` (`utils.js:522`,
cyrb53) already takes a seed, and `seedrandom` is already a dependency re-exported from
`public/lib.js`, so no new dependency either way. Being a comparator rather than a shuffle, it slots
into the existing `entities.sort(...)`, so the tag-pin rule applies again and the
folders-shuffled-in bug fixes itself.

Why a hash and not a stored permutation: a hash is a total order over the whole set, so it is
well-defined for a row the client has never seen, which is what server-side pagination needs. It
also degrades gracefully when the library changes mid-browse: adding or removing a character leaves
every other slot untouched, where a stored permutation would have to be regenerated. Under Option A
(§2.2) ids are immutable, so a rename no longer moves a card either.

The server-pagination wrinkle, which must not be missed. `paginateCharacters`
(`characters.js:1205`, `:1244`) models sort as `SORT_FIELD_GETTERS[sortField]` plus
`sortOrder: 'asc'|'desc'`. Random does not fit that shape: passing today's state through sends
`sortField=name&sortOrder=random`, and the server silently falls back to ascending name. Random sort
would become name sort the moment pagination moves server-side, with no error. Random therefore
needs a first-class representation in the §5 query contract,
`sort: { field: 'random', seed: <number> }`, with the seed carried on every page request. If the
seed does not travel, page 2 comes
from a different permutation than page 1 and the user sees duplicated and missing cards: a silent
wrong result, not a failure. The seed joins `field` and `order` as part of the pagination cursor's
identity.

**SETTLED:** the hash is computed per query (`ORDER BY <hash(id, seed)>`), never materialized as a
column. A materialized seeded sort column is faster for a single seed, and would be fine for one
user in one session. It does not generalise: the column is a function of *the seed*, so it would
have to be recomputed per seed, and seeds are per-user and per-reroll. A server holding N users
would need N columns, or one column plus a rebuild every time anyone rerolls. Per-query computation
costs more per request but is O(1) in user count, which is the axis that has to scale.

The `/random` slash command has no such constraint: it picks one row and can use whatever is
simplest (`ORDER BY RANDOM() LIMIT 1` under the active filter).

**SETTLED:** the seed is client-owned, generated client-side, persisted across reloads, and
rerolled by an explicit button. Concretely:

- Generated on the client, never by the server. The server takes the seed as a request parameter
  and does not remember it. The ordering is a property of the user's view, not of server state, so
  two tabs or two devices can disagree without any coordination.
- Stored in `accountStorage`, alongside `Characters_PerPage` and the other per-account view
  preferences (`script.js:1096`, `:1208`). That gets persistence across reloads and restarts, and it
  is per-user on a shared browser in a way `localStorage` would not be. Minted lazily: if no seed is
  stored the first time random sort is used, mint one and store it, so no migration is needed for
  existing installs.
- A reroll button, shown next to the sort dropdown while random sort is active. This is what makes
  persistence safe: a persisted seed with no reroll would freeze the order permanently, which is the
  opposite failure from today's. It also sidesteps the re-selection problem: re-picking "Random" in
  the dropdown fires no `change` event, so the dropdown itself can never be the reroll affordance.
- Because the seed is part of the pagination cursor's identity (§5.3 above), reroll invalidates the
  current page set: it resets to page 1 rather than reshuffling underneath whatever page the user is
  on.
- The button is one of the few places here where a label or tooltip is warranted; "what does this
  icon do" is not inferable from a shuffled list. Nothing else about the feature needs narration.

#### Random and search compose, unconditionally

**SETTLED:** random and search compose, unconditionally. Today they cannot coexist: typing a search
term silently switches the sort to relevance, so a user who chose Random loses that ordering the
moment they search. That has to stop.

The composition is clean because filtering and ordering are independent concerns. Search narrows the
candidate set; the seeded hash orders whatever survives. Nothing about the hash depends on the query,
so `ORDER BY hash(id, seed)` applies to a search result exactly as it applies to a full browse.

This falls out of the design rather than being bolted on, and it has a second property: because
`hash(id, seed)` is a total order over all ids, narrowing the candidate set never *reorders* the
survivors. As the user types and the result set shrinks, cards only disappear; the ones that remain
hold their relative positions. That is the same jump-free behaviour §5.3 was written to get for
browsing, now extended to search.

What has to change:

- Sort and search become independent inputs. `verifyCharactersSearchSortRule()` (`script.js:1224`)
  currently force-selects the hidden `search` option whenever a term is present and reverts when it
  clears. That forcing goes away. Relevance becomes an ordinary sort choice the user can pick, not a
  mode the search box imposes.
- The `search` sort option stops being `hidden` in `index.html`. It is offered whenever a query is
  active and unavailable otherwise, the same rule as today, minus the automatic selection.
- The client comparator loses its short-circuit. `sortEntitiesList` (`power-user.js:2704`) returns
  early on `isSearch` before reaching the random branch. It has to dispatch on the selected sort
  instead: relevance if the user picked it, hash if they picked random, the field comparator
  otherwise, with the search term affecting only which entities are in the list.
- The query contract carries both. `filter.search` and `sort` are orthogonal in the §5 shape
  already; what changes is that `sort: { field: 'random', seed }` alongside a `filter.search` is a
  valid combination the server must honour rather than quietly downgrade. The existing rule that
  `sort: 'search'` requires `filter.search` still holds — that direction is a dependency, not a
  forcing.
- Server-side, the FTS engine returns the candidate id set and SQLite orders it, which is the
  arrangement §5 already chose for non-rank sorts. Relevance sort is the case where the FTS ranking
  must survive the handoff; random sort is the easier case, since the ordering key is computed from
  the id and the seed alone.

`/random` is untouched by this.

### 5.4 The remaining odd queries

Rank-of-row (`script.js:9000`, "which page did my import land on") is the
`COUNT(*) WHERE <sort key precedes this row>` query from §4.1. Under random sort it is the same
query against the hash expression, one more reason the ordering has to be expressible server-side
rather than being a client-side shuffle.

---

## 6. Client data model

Replace direct `characters` array access with a `CharacterRepository` that owns residency.
`EntityStore` stays as the change-notification and keyed-read primitive but gains a notion the
current one lacks: **not-loaded is distinct from not-existing.**

```js
repo.peek(id)            // sync: resident shallow row, or undefined — never a fetch
repo.get(id)             // async: resident, else IDB, else server; caches
repo.getMany(ids)        // async, batched
repo.full(id)            // async: hydrate the full card (today's unshallowCharacter)
repo.query(filter, sort, page)   // async: §5, returns rows + total
repo.exists(ids)         // async: §4.2 primitive
repo.onChange(fn)        // as today
```

The bright line: **`peek()` returning `undefined` must never be interpreted as "does not exist".**
That is why a lazy-loading Proxy pretending to be the old array cannot serve *internal* code.
Internal call sites include the destructive-existence cluster (§4.2), which must be authoritative,
and a sync trap can never be. (This is a claim about the internal repository, not about
`context.characters`. At the extension boundary a Proxy is a live option with weaker guarantees,
§9.4 Option 2, and the objection there is different; do not read this line as ruling that out.)
Every current `characters[i] === undefined` and `indexOf(...) === -1` site has to be classified as
either "resident-only is fine here" (rendering an already-rendered row) or "needs the authoritative
answer" (everything in §4.2). Anything that cannot be classified gets the async path.

`getEntitiesList()` inverts: instead of building all entities and filtering down, it asks
`repo.query()` for the page and maps the returned rows to entities. `printCharacters()`'s pagination
becomes a *controller* over server-side paging rather than a slicer over a materialized array. The
`pagination()` plugin already has the `dataSource`-as-function form needed for that.

Group members: `group-chats.js:388` `getGroupMembers` currently returns `charactersStore.get(member)`
unfiltered into an array typed `Character[]`, so non-resident members become `undefined` holes with
a lot of downstream consumers. It becomes async and returns a resolved list plus an explicit
unresolved list, so callers must handle the distinction instead of tripping over holes.

---

## 7. The IndexedDB cache

### 7.1 What gets cached, and why the sizing changes

Today's cache stores fully-processed character objects keyed by avatar
(`character-cache.js:72`), via localforage. Measured across 4,000 random cards from the real import
corpus, card JSON runs 13 KB mean and 7.8 KB median, with a long right tail: 24 KB at p90, 96 KB at
p99, 585 KB at the largest. That is ~3.9 GB at 300k: still far over any browser's quota, so "cache
everything" never survives contact with the target scale regardless of eviction policy. (The cards
are stored minified already: re-serializing produced byte-identical output, so there is no
whitespace to reclaim.)

Two tiers instead:

- **Shallow rows** (the `toShallow()` projection): what list rendering and local search need.
  Measured serialized: 601 bytes mean without `creator_notes`, 1,377 bytes with it. In memory with an
  avatar-keyed `Map`, ~665 bytes per row. So 300k is ~199 MB resident, 10M is ~6.6 GB: even the
  shallow tier needs eviction at the top of the range, and on mobile well before that.
- **Full cards**, fetched on selection, cached with a much smaller budget and evicted first.

`creator_notes` is the field that decides the shallow tier's cost. It is behind a config flag
(`performance.shallowCharactersIncludeCreatorNotes`, default off), and turning it on more than
doubles the mean and adds a tail worse than the card distribution's own: one sampled card carried
302 KB of `creator_notes`, larger than most entire cards. Everything in this document sized against
601 bytes assumes the flag off. With it on, 300k costs roughly 410 MB rather than 199 MB, which is
the difference between fitting a mobile budget and not.

Also replace localforage with raw IndexedDB for this store. localforage's per-item `setItem` is one
transaction per row and its `keys()` materializes every key. At 300k rows, both are the wrong
shape. Raw IDB gives batched transactions, cursor iteration, and secondary indexes on
`lastAccess` / `size`, which the eviction policy needs anyway. (localforage can stay for the small
stores elsewhere in the app; this is not a wholesale migration.)

### 7.2 Quota detection

Researched against current sources (MDN, caniuse, the WebKit blog) rather than recalled. Findings,
with the confidence attached:

- `navigator.storage.estimate()` is available everywhere that matters: Chrome 61+, Firefox 57+,
  Safari 17.0+ on both desktop and iOS. iOS 17 is therefore the floor for having any quota
  signal at all; below that, there is none.
- `usage` is roughly accurate for IndexedDB. The well-documented padding is for opaque
  cross-origin responses in the Cache API, which Chrome inflates to ~7 MB each regardless of real
  size. No evidence was found that Chrome pads plain IndexedDB usage. Not applicable here anyway:
  this cache stores same-origin JSON.
- `quota` is systematically misleading in the direction that hurts. Chrome computes it as 60% of
  total disk, not free disk, as an anti-fingerprinting measure. So it can report
  hundreds of GB available on a disk with 2 GB free. A budget derived directly from `quota` will
  overcommit and then fail mid-write.
- Current policies: Chrome 60% of total disk per origin. Firefox `min(10% disk, 10 GiB)` where the
  10 GiB is a group limit shared across every origin on the same site. Safari 17+ ~60% of total
  disk for browser tabs, ~15% for embedded webviews, and cross-origin iframes get a tenth of the
  parent's. Safari 17 also stopped prompting: the "allow 200 MB more?" dialog era is over, and
  so is the old hard ~1 GB cap.
- `persist()` on a plain iOS Safari tab is structurally impossible, not merely unlikely.
  Verified by reading WebKit source rather than the blog: `NetworkStorageManager::persist()` grants
  only if the origin is in `registrableDomainsExemptFromWebsiteDataDeletion`, which is
  appBound ∪ managed ∪ persisted ∪ standaloneApplication — every one of those set by the *embedding
  app*, none reachable from web content. There is no engagement heuristic in the code path at all.
  (With "prevent cross-site tracking" off there is no ITP store, the set is empty, and it returns
  false too.) Persistence does not change the quota on iOS either: quota derives from
  default-quota/ratio/volume-capacity with no reference to the persisted flag, and the flag is only
  read as a skip condition inside the eviction loops. Elsewhere: Chrome grants on engagement
  heuristics and buys eviction immunity only; Firefox is the one browser where persistence raises
  the ceiling (10 GiB → 50% of disk), behind a real permission prompt.
  A claim circulating that iOS persistence requires notification permission is not supported by
  the source: push subscription exempts an origin from a different, time-based sweep, not from
  this.
- Storage Buckets is Chromium-only (122+), no signal from Firefox or Safari. Not a portable
  lever; do not design against it.
- Eviction is undetectable and all-or-nothing. There is no API to learn it happened, and when an
  origin is evicted *everything* goes at once across IndexedDB, Cache and OPFS.
- The "Safari deletes IndexedDB after 7 days" number is stale, and the replacement is more
  nuanced. WebKit commit `274398@main` (Feb 2024, bug 265598) introduced a `DataRemovalFrequency`
  split: a 7-day short window that applies only to domains flagged by link-decoration arrival
  from a prevalent/classified domain, and a 30-day long window for an ordinarily-visited
  first-party site, both counted in browser-use days, not calendar days. Domains with no user
  interaction at all remain immediately evictable. Separately, `NetworkStorageManager` runs a general
  time-based eviction defaulting to 180 days, skipping origins that are active, persisted, or
  hold a push subscription. Caveats carry forward. That commit's own message asserts behaviour is
  unchanged and 7 days applies regardless of link decoration, which contradicts the code it adds;
  that is unresolved. And all of this is a read of WebKit main, not verified against shipped iOS
  Safari, with no first-party restatement since the 2023 storage-policy post and no real-world
  2025/2026 on-device measurement found.

Consequence for the mobile+VPN use case: on iOS the cache can vanish wholesale, on a
schedule the app cannot query and cannot opt out of, and `persist()` will always return false in a
normal tab. The design must treat a cold cache as a normal state, not an error state. That is
another reason §5.2's change feed must tolerate `truncated` cleanly, and why nothing
correctness-bearing may depend on the cache (§4.2). The one real mitigation available is that adding
the app to the Home Screen changes the answer (`standaloneApplication` is in the exempt set), which
is a thing to tell the user, not something the app can arrange for itself.

The approach, given all that:

1. Call `estimate()`. If it throws or is absent, skip to step 3.
2. Do not use `quota` as the budget. Use `min(quota - usage, absoluteCeiling)` where
   `absoluteCeiling` is a conservative constant per platform class (proposed: 2 GB desktop,
   256 MB mobile), and treat the result as an *upper bound on ambition*, not a promise.
3. Probe to find the real ceiling, lazily and incrementally. Do not run a dedicated probe pass; let
   the normal cache writes be the probe. IndexedDB semantics guarantee the failing transaction
   aborts and reverts entirely, so a write that hits the wall cannot corrupt the store. On a quota
   failure: record the observed byte total as the effective ceiling, evict down to 80% of it, and
   retry once. This makes the true limit a *learned* value, which is the only thing that works when
   the reported one is fiction.

   Detect it by `error.name === 'QuotaExceededError'` and nothing else. The `QuotaExceededError`
   DOMException *subclass* with its `quota` and `requested` properties is Chrome/Edge 138+ only
   (MDN browser-compat data, read 2026-08). WebKit main has no `QuotaExceededError.idl` at all:
   Safari throws a plain DOMException with that `name`, and `instanceof QuotaExceededError` would
   throw a `ReferenceError` because the global does not exist. Firefox likewise has no WebIDL entry.
   Even on Chrome the numbers are useless here: both the Blink intent-to-ship and the IndexedDB spec
   PR state the properties ship at their default `null`, with populating them left as future work.
   So: never feature-detect the constructor, never read `.quota`/`.requested`, and never make the
   learned-ceiling logic conditional on having them.
4. When no estimate is available at all (iOS < 17), start from the conservative mobile ceiling and
   let step 3 discover the truth the same way.
5. Call `persist()` opportunistically and record the result, but change nothing behavioural based on
   it beyond logging: it is not load-bearing anywhere, and on iOS it can only ever return false.

### 7.3 Eviction policy

Frecency, evaluated against a byte budget rather than a row count:

- Each cached row carries `bytes` (approximate serialized size), `lastAccess`, and a decayed hit
  count. Score = `hits_decayed / bytes`, so a large full card earns its space harder than a shallow
  row.
- The budget is `min(quotaBudget, hardCeiling)` where `quotaBudget` comes from §7.2 and
  `hardCeiling` is a user-visible setting. Eviction runs when the running byte total crosses a high
  watermark, down to a low watermark, in one transaction, iterating a `score` index rather than
  loading everything.
- Rows currently referenced by the rendered page, the selected character, and any open group's
  members are pinned and never evicted.
- Eviction is a *cache* operation and must never be observable as data loss: an evicted row is
  refetched, and any operation that needs authority goes to the server regardless of what is
  resident (§4.2).

Not an LRU, by choice: an LRU is wrong for this access pattern, where a user pages through
thousands of rows once while returning to the same few dozen characters constantly. Recency alone
would evict the frequently-used set behind a single browse session.

---

## 8. Local search

### 8.1 What it is for

Not a replacement for the server's tantivy/FTS search: that stays authoritative and is the only thing
that can search the *whole* library. The local index answers over what is cached, so that on a slow
link (mobile + VPN) typing produces results immediately instead of after a round trip. Results from
it must be labelled as covering the cached subset, never presented as complete, and the server result
supersedes it when it lands. This is the same layering the code already has at `filters.js:373-385`
(server results when present, client pass while in flight). What changes is which client engine runs,
and that it is scoped to a bounded set by construction.

### 8.2 Library choice

Three current candidates were checked against npm and GitHub rather than recalled. Requirements:
incremental add/remove after build (because the cache admits and evicts continuously), index
serialization (so boot does not rebuild), prefix matching, some typo tolerance, small bundle,
permissive licence.

| | MiniSearch | FlexSearch | Orama |
|---|---|---|---|
| Version / date | 7.2.0, 2025-09 | 0.8.212 | 3.1.18 |
| Licence | MIT | Apache-2.0 | Apache-2.0 |
| Bundle (gzip) | 5.8 kB | 16.8 kB | 24.4 kB |
| Weekly downloads | ~2.2M | — | — |
| Incremental add/remove | `add` / `remove` / `discard(id)` with tombstones and batched vacuum | yes | yes |
| Serialize / restore | `toJSON` / `loadJSON` / `loadJSONAsync`, plus public `loadJS`/`loadJSAsync` taking a plain object or generator (§8.4) | export not supported for Document indexes; separately has a real IDB adapter that queries from storage (§8.4) | serialize plugin has an open browser-build bug since 2025-01 (pulls `dpack`, needs node stream polyfills under Vite) |
| Prefix | yes | yes | yes |
| Fuzzy | edit distance | encoder/phonetic only, not edit distance | real Levenshtein |
| Maintenance signal | quiet: ~6 commits in 6 months, new issues sitting unanswered | 0 issues closed in 6 months; an open report that 0.8 gives inconsistent results where 0.7 did not | the only one actively closing issues, but npm has trailed the repo by ~8 months |

**SETTLED:** MiniSearch. It is the only candidate where the two features this design depends on,
`discard(id)` matching cache eviction one-to-one and first-class serialization, are both supported
and not caveated. FlexSearch is disqualified by its own documentation: a Document index (which name +
description + tags is) cannot be serialized, and its IndexedDB adapter, tempting given where this
cache already lives, forfeits import/export entirely. Orama's Levenshtein is the best matching story
of the three, but the one feature that would be depended on is the one with an open browser-build
bug.

The accepted risk is MiniSearch's low maintenance activity. It is bounded: 5.8 kB of MIT code with a
small API surface behind a thin wrapper module is vendorable if it goes unmaintained, which is not
true of the 24 kB alternative.

Measured, not assumed. MiniSearch 7.2.0 was benchmarked against all 24,171 real cards on this install
(extracted from the PNGs, zero parse failures), with 50k/100k reached by cycling the corpus with
per-field rotation. Node 22, not a browser: see the caveats.

Real field sizes, which are what make the field-scope call (chars, mean / p50 / p99 / % empty):

| field | mean | p50 | p99 | empty |
|---|---|---|---|---|
| name | 9 | 6 | 45 | 0% |
| creator | 11 | 9 | 24 | 1% |
| tags | 131 (14.7 tags) | 12 tags | 61 | 2.8% |
| creator_notes | 1158 | 282 | 16165 | 22.5% |
| description | 4749 | 3744 | 21779 | 0.1% |
| personality | 55 | 0 | 1369 | 94.8% |
| scenario | 341 | 40 | 3790 | 47.4% |
| first_mes | 1607 | 1352 | 5853 | 0.1% |
| mes_example | 711 | 0 | 7398 | 63% |

A shallow doc is ~1,309 chars (~238 words); a full doc is ~8,771 chars (~1,595 words).

| | build | index heap | toJSON | serialized | loadJSON |
|---|---|---|---|---|---|
| 10k shallow | 1.2 s | 90 MB | 0.36 s | 11.3 MB | 0.65 s |
| 50k shallow | 7.8 s | 300 MB | 1.6 s | 55.8 MB | 2.1 s |
| 100k shallow | 16.6 s | 518 MB | 3.0 s | 109 MB | 3.2 s |
| 10k full | 9.8 s | 400 MB | 2.2 s | 69.0 MB | 3.4 s |
| 50k full | 64.8 s | 1635 MB | 10.0 s | 363 MB | 19.2 s |
| 100k full | 134 s | 3090 MB | throws | — | — |

Median query latency (ms), worst-case common word first:

| | "the" | "school" | "tsundere" | "ali" (prefix) | "school girl" |
|---|---|---|---|---|---|
| 10k shallow | 1.6 | 0.3 | 0.1 | 0.5 | 1.0 |
| 50k shallow | 14.8 | 1.5 | 0.7 | 2.3 | 7.9 |
| 100k shallow | 37.0 | 3.4 | 1.4 | 6.5 | 22.0 |
| 10k full | 8.6 | 1.4 | 0.2 | 1.4 | 3.9 |
| 50k full | 58.6 | 17.0 | 1.3 | 15.6 | 39.1 |
| 100k full | 147 | 40.9 | 3.7 | 37.3 | 106 |

Incremental ops, which is what the cache lifecycle exercises: `add()` is 0.15–0.23 ms shallow and
0.8–1.1 ms full, flat across all sizes. `discard()` is 0.005–0.015 ms but is *lazy*: MiniSearch marks
and auto-vacuums later, so the amortized cost sits in a vacuum that was not measured.

Conclusions:

- The GitHub issue does not transfer. It claimed 5,000 × 400-word docs took >10 s (2M words); this
  run indexed 10k × 1,595-word docs (16M words) in 9.8 s, roughly 8× the throughput per word.
  Whatever was wrong there is not inherent to the library.
- MiniSearch survives comfortably at shallow scope, up to 100k docs: 16.6 s build, 518 MB heap,
  3.4 ms on an ordinary word.
- The `toJSON()` wall is V8's string cap, and it is avoidable. At 100k full-field docs
  `JSON.stringify` throws `Invalid string length` (V8 caps strings at 536,870,888 chars), and 50k
  full already serializes to 363 MB, so the naive path dies around ~70k docs in browsers too. §8.4
  removes this by never building the string: `toJSON()` returns a plain object, `loadJS` is public,
  and IndexedDB stores by structured clone. Treat the numbers in the table as a measure of index
  *size*, not of a ceiling.

Caveats to carry. These are Node numbers, not browser numbers: 3.1 GB of heap for 100k full is
probably not survivable in a tab, which is reasoning rather than measurement, though the 512 M-char
string cap is a V8 constant that does carry over. The term dictionary saturated at both 50k and 100k
(only 24,171 unique cards exist), so 100k distinct cards would mean a larger dictionary, more memory,
and slower queries than shown. `"the"` is included as a worst case, since MiniSearch does no stopword
filtering by default. No `storeFields` were configured, so these are floor numbers.

For the record, on what is currently in the tree: `lunr` is dead (last publish 2020) and is not a
candidate. `fuse.js` (already a dependency, `public/lib.js:6`) stays for the small collections it
serves elsewhere, but it is bitap-over-an-array with no inverted index, a different shape entirely,
and the reason `fuzzySearchCharacters` (`power-user.js:2470`) cannot scale no matter how it is
tuned.

### 8.3 What gets indexed, and staying in sync

**SETTLED:** shallow tier only, on measured performance (§8.2): `name`, `data.creator`, `data.tags`
plus resolved tag names, and `creator_notes` when the server is configured to include it. Not
`description`, `mes_example`, `first_mes` or `scenario`.

The numbers behind the call, decided on performance rather than storage:

- Full scope costs ~8× the build time at every size, 4.4–6× the index memory, 6.5× the serialized
  bytes, and 2–11× the query latency.
- At 50k+ it is not viable at all: 65–134 s builds, 1.6–3.1 GB heap, and 40–150 ms latency on
  ordinary words like "school" and on two-term queries. This is a search-as-you-type box.
- And it hits a hard V8 wall: full-field serialization cannot be `JSON.stringify`'d past ~70k docs,
  so a naive `JSON.stringify` persist path stops working. Correction to an earlier draft of this
  document: that wall is an artefact of using `loadJSON`, not a property of MiniSearch, and §8.4
  removes it. It is listed here because it is real for the obvious implementation, not because it is
  load-bearing for this decision. The timings alone settle the scope question.

One qualification: at 10k documents full scope is a real option, at 9.8 s build, 400 MB, and sub-9 ms
queries. So a small-cache install could afford deep local search. The design does not take that
option because the cache budget is dynamic (§7.2), and an index whose build time and memory grow 8×
and 5× against a budget that moves underneath it is a worse failure than one that was always narrow.
If the scope is ever revisited: `personality` is empty on 94.8% of cards and `mes_example` on 63%, so
nearly all of full's cost is `description` plus `first_mes`, and a middle scope excluding just those
two was not measured.

This is a narrower field set than today's Fuse index (11 weighted keys including every greeting), so
it is a deliberate reduction in local match recall, traded for the ability to run at all at scale.
The UI should say the local pass is name/tag/creator scope rather than letting the user infer
completeness.

A constraint this creates for §7: the index is not free against the storage budget. At 100k shallow
docs it is 518 MB of heap and 109 MB serialized, against a proposed mobile ceiling of 256 MB for the
*whole* cache. So the index's own footprint has to be counted in the byte budget: it is a third tier
with its own accounting, not an invisible companion to the cache. The document-count limit is a user
config knob defaulting to unlimited (§8.4), so on a constrained device it is the storage budget, not
the knob, that does the limiting. That is why the index must participate in eviction rather than
sitting outside it.

Sync is one-to-one with cache lifecycle, which is why `discard()` matters:

- On cache admit → `index.add(row)`.
- On cache evict → `index.discard(id)`; run the vacuum on the batched schedule MiniSearch already
  provides, not per row.
- On character update (a `changes` feed upsert) → `discard` then `add`.
- Persistence: see §8.4, chunked structured-clone records, not one serialized string.
- Because the index is derived state, it is never authoritative: a rebuild is always available and
  always cheap relative to refetching the rows themselves.

### 8.4 Persistence: avoiding the serialization wall entirely

The owner's question was whether an IDB architecture exists that does not require the
stringify-and-restore cycle at all. It does, and the first draft was wrong to present the V8 cap as
inherent. What was checked, against MiniSearch 7.2.0's source:

- `toJSON()` returns a plain object, not a string. Its `index` field is an array of
  `[term, {fieldId: {docId: freq}}]` pairs. `JSON.stringify` is not part of the design; it is what
  `loadJSON` happens to accept, and `loadJSON` is `loadJS(JSON.parse(json), …)`.
- `MiniSearch.loadJS(plainObject, options)` and `loadJSAsync` are public and typed in the shipped
  `.d.ts` (annotated `@ignore` for doc generation, which is not the same as private).
- IndexedDB stores objects by structured clone, so nothing has to become a string. The 512 M-char V8
  limit is a *string* limit and is structurally dodged.

Verified at 100k documents: `structuredClone` of the whole `toJSON()` object round-trips; chunking
`index` into 20k-entry slices, cloning each, and reassembling produces identical search results; and
because `loadJS` iterates `for (const [term, data] of index)`, passing a generator works, so chunks
can be streamed straight out of an IDB cursor without ever materializing the full array. (Measured
under JSC rather than V8; the char counts were compared against the known V8 cap rather than
reproducing the throw.)

The design: chunked structured-clone records, streamed back through `loadJS`. Not one big record, for
two reasons that are about Chrome rather than about size in principle: values ≥64 KB get wrapped into
a blob internally, and there is a live Chromium bug about large complex IDB values intermittently
failing to read back. No hard per-value byte limit was found in a primary source, so one-giant-record
is *probably* fine; chunking is the version that does not bet on it.

A cheaper win to take first: `storedFields` accounts for roughly half the serialized bytes, and they
are pure duplication, since this design already holds the shallow rows in the IDB row store. Moving
them out roughly halves the index's memory footprint and its persisted size. It is a couple of lines
and it should be done regardless of anything else here.

(An earlier draft quoted this as raising a document ceiling from ~225k to ~400k. Both numbers were
unsourced and neither follows from the §8.2 measurements, and the ceiling they referred to was the V8
*string* cap, which decision 12 removes from the design. The halving is a memory and storage win, not
a ceiling change.)

For scale reference, measured at 100k docs with 60-word notes: term dictionary 4.8 MB, postings
73.6 MB, meta 8.1 MB. The term dictionary is about 5% of the index, which is what makes the hybrid
below viable.

#### If a fully IDB-resident index is ever needed

Not proposed now, but the shape is worth recording because it is not the obvious one:

- **Exact term lookup** maps to IDB perfectly: one `store.get(term)`.
- **Prefix** maps *structurally*: IDB keys sort lexicographically, so `IDBKeyRange.bound('foo',
  'foo￿')` is a native range cursor. The scan is fine; the fanout is not. Short prefixes match a
  large fraction of the vocabulary (measured on a synthetic 400k-term vocab: 2 chars → 44k terms,
  3 chars → ~1.2k). Search-as-you-type from the first keystroke would mean fetching tens of thousands
  of postings lists per keystroke.
- **Fuzzy** does not map at all. MiniSearch's `fuzzyGet` walks a radix tree; IDB has no tree walk. It
  requires a resident dictionary or a full scan.
- **BM25** is fine: `documentCount` and `avgFieldLength` are scalars, and per-term document frequency
  falls out of the postings already fetched.

So a pure-IDB index is good at exact match, bad at prefix-as-you-type, and cannot do fuzzy. The
hybrid the numbers point at is term dictionary in memory (~5 MB), postings in IDB: the dictionary
answers "which terms match" synchronously, including prefix and fuzzy, and then one batched IDB fetch
retrieves the surviving terms, one async hop per query rather than per term. That is not something
MiniSearch supports; it would mean owning the query layer with MiniSearch reduced to tokenizer and
scorer.

Alternatives surveyed, for the record. FlexSearch's IDB adapter does query from storage (per-term
`objectStore.get`, verified in source, shipped in 0.8.212), but its distributed bundle references
`window.indexedDB` so it throws in a web worker (open issue, fix unmerged), and the maintenance
signal from §8.2 still applies. sqlite-wasm with FTS5 is real (FTS5 is in the official build) at
~865 KB wasm plus ~570 KB glue, but the VFS choice is forced and unpleasant: plain OPFS needs
COOP/COEP headers and a worker, while `opfs-sahpool` needs no headers but is single-connection, so no
multi-tab. wa-sqlite is more actively developed with more VFS options, none needing COOP/COEP.
Orama's persistence hydrates everything into memory, which is the thing being avoided.

#### Two decisions that shape this

**SETTLED:** there is no fixed document ceiling; it is a user-facing config knob, default unlimited.
The index grows with whatever the user is willing to spend, rather than being capped at a number
chosen here. Consequences to build for:

- The knob is a *document count* limit, so it sits alongside the §7 byte budget rather than replacing
  it. Both apply: the index stops admitting documents when either the configured count or the
  learned storage ceiling (§7.2) is reached, whichever binds first. The storage ceiling is discovered
  and can move; the knob is declared and does not.
- "Unlimited" therefore means "bounded only by the storage budget", not "unbounded". A user setting
  it to unlimited on mobile still gets eviction, they just do not get a second, smaller cap on top.
- Eviction from the index has to be driven by the same frecency ordering as the row cache (§7.3), so
  that the indexed set is the *most useful* subset rather than an arbitrary prefix.
- The knob's default being unlimited means the hybrid architecture below stops being hypothetical at
  the top end: a desktop install pointed at a large library will reach sizes where the whole-index
  clone becomes slow. Chunked clone stays the shipped design, and the hybrid becomes the documented
  next step if that is ever reached in practice. Not a rewrite, because the wrapper interface (§8.2)
  keeps the engine swappable.

**SETTLED:** a 3-character minimum before search fires is acceptable. This removes the prefix-fanout
problem outright: the measured pain was at 1–2 characters (2 chars matched 44k terms of a 400k-term
vocabulary; 3 chars matched ~1.2k). It also removes the main structural objection to a future
IDB-resident postings design, so both architectures stay viable at any size.

Two implementation notes that follow. The minimum applies to the *local* pass only, since the server
search has no such constraint and should keep answering shorter queries. And the UI should show
nothing rather than showing stale results while below the threshold: a list that does not update
until the third character reads as lag, whereas an empty state does not.

---

## 9. Phases

### Phase 0 — jank fix (independent, ships first)

Isolated, no dependency on anything else.

**0a — SHIPPED (`16f460b82`).** Keyed DOM diff in `printCharacters()`. Rows are indexed into a `Map`
by `data-avatar` before the DOM is touched; kept rows are moved into the `DocumentFragment` and
refreshed rather than re-cloned; the list is swapped in with `replaceChildren()`.

Divergences from the spec above, all worth knowing:

- `getCharacterBlock` was split into a third function, `renderCharacterBlock(template, item, id)`,
  shared by the clone path and the reuse path. The spec named two functions; there are three.
- Reuse forced two behaviour fixes that only exist because rows are now reused: `.ch_assistant`
  changed from a one-shot `.remove()` to a `.toggle()`, and `printTagList` had to become
  re-entrant-safe.
- **Kept rows are not cheap.** Every retained row still has every attribute and text node re-set, and
  its tag list cleared and rebuilt by `printTagList`. What the diff saves is the template clone and
  the teardown, not the per-row render. The spec's "updating in place" reads as cheaper than what
  shipped.
- Kept rows are still detached and reattached (moved into the fragment, then re-appended), not left
  in place.
- Groups, tags, and the back/empty/hidden blocks are still rebuilt every render. The code says so
  deliberately: there are far fewer of them per page.

**0b — SHIPPED, and it diverged the most (`afbd83b9b`).** What the spec asked for was a version token
in the URL the client emits. What shipped is a server-side redirect: if `request.query.v` matches the
version, the route serves the file with `public, max-age=31536000, immutable`; otherwise it responds
`Cache-Control: no-cache` and **302s** to the same URL with `&v=…` appended.

Three consequences, and the first is a live problem:

- **`getThumbnailUrl` was never touched.** `public/script.js:7853` still emits
  `/thumbnail?type=…&file=…` with no `v`, so no client call site ever names a version and *every*
  thumbnail request takes the redirect hop first. The redirect carries `no-cache` and no validator,
  so it is re-fetched every time, forever. A 500-card page is now 500 redirects — each doing an
  `existsSync` plus a `statSync` — ahead of 500 cached hits. Before this change it was one request
  per image with Express's default ETag and Last-Modified. This is half-implemented, not finished:
  the client half of 0b is still outstanding.
- The version token is the mtime of the **cached thumbnail file**, not of the original as the spec
  said. The argument is that `invalidateThumbnail()` deletes the cached file when the source changes,
  so regeneration re-mints the token.
- The Firefox `no-store` header was routed around rather than reconciled. `src/util.js:1595` is
  untouched; the immutable and redirect paths simply avoid calling `invalidateFirefoxCache()`. But
  `serveOriginal()` still calls it, so Firefox still gets `no-store` for GIFs, animated formats, and
  any install with thumbnails disabled.
- Client-side, `personas.js:241` dropped a Firefox-only `t=Date.now()` cache-buster that would have
  defeated the new caching. Two other spots (`personas.js:480`, `:2115`) still force
  `fetch(..., {cache:'reload'})` after upload; different mechanism, still present.

**0c — SHIPPED, incompletely (`ade258e49`).** The parse is fixed as specced: one `/^\d+$/` test with
`parseInt(lastPart, 10)` only inside that branch, plus a `nameParts.length > 1` guard. `foo_.png` now
takes the else branch and becomes `foo__1.png`.

**The loop was not bounded, and the wedge survives with a narrower trigger.** It is still
`while (fs.existsSync(newFilename)) suffix++`, justified by a comment arguing that the suffix is
always a strictly increasing integer. That argument has a hole: `/^\d+$/` accepts arbitrarily long
digit strings, so a card named `foo_9999999999999999999999.png` yields `parseInt(...) + 1 === 1e22`,
`String(1e22)` is `"1e+22"`, and `suffix++` at 1e22 is a no-op in float. The first duplicate produces
`foo_1e+22.png`; a second duplicate of the original collides and spins forever on a synchronous
`existsSync`. Same one-request server wedge, same shape, rarer trigger. Bounding the loop is still
outstanding.

**0d — NOT SHIPPED.** `writeExtensionField` (`public/scripts/extensions.js:2070`) still takes an
avatar only, still goes straight to `charactersStore.get(characterAvatar)`, and still
`console.warn`s and returns on a miss. No discriminator, no chid branch, no deprecation warning.
GroupGreetings is still silently failing to save.

The work, unchanged: detect the form (`typeof x === 'number' || /^\d+$/.test(x)` → chid, else id) and
resolve accordingly, with a deprecation warning on the chid branch. This restores upstream
compatibility and needs no cooperation from any extension author.
*Files:* `public/scripts/extensions.js`.

### Phase 1 — server metadata store — SHIPPED (`f872377eb`)

Landed as `src/character-metadata-db.js`, with `src/character-shallow.js` and
`src/character-card-normalize.js` split out as leaf modules to break an import cycle (a factoring the
spec did not call for), plus `tests/character-metadata-db.test.js`. `sqlite-engine.js` gained a
`run`/`get`/`all`/`transaction` surface.

Schema: every column and index §3.1 specified exists under the specified names. `character_tags`,
`tag_usage`, `changes` and `meta` all exist; `tag_usage` is genuinely trigger-maintained, so no
application code touches it. Deviations:

- `shallow_json` is `TEXT`, not `BLOB`.
- The file is `<userRoot>/character-metadata.sqlite` at `directories.root`, not `characters.sqlite`
  beside the characters directory.
- `id` is the avatar filename, not a UUIDv7. Expected — that is phase 4d — but it means every rename
  is a primary-key change, and there is special-case code carrying `date_added` across it.
- **`meta` only ever holds `bootstrap_completed`.** The spec's other uses for it — schema version,
  oldest retained rev — were not written. There is no schema version anywhere, so a future migration
  has nothing to key off. Worth fixing before the table has data worth migrating.
- The `tag_usage` delete trigger decrements to zero and leaves the row, so zero-count rows
  accumulate.

Freshness: all three mechanisms shipped. Write hooks fire from inside `writeCharacterData()`, so
every create/edit/edit-avatar/edit-attribute/merge/import funnels through one path, with separate
hooks for delete and rename. The watcher is a single non-recursive `fs.watch`, PNG-filtered, with a
300 ms per-filename debounce. The reconciler runs at boot after bootstrap and on an interval
(`performance.characterMetadataReconcileIntervalMs`, default 5 min, unref'd), disposed in
`server-main.js`. The change log and `rev` are real: `rev` is the `changes` table's autoincrement
rowid, and `/query` returns `MAX(rev)`. Batch import mode is real — it suspends the watcher, buffers
into 500-row transactions, then flushes, forces a reconcile, and restarts the watcher.

Divergences that matter:

- **The reconciler uses `fsPromises.readdir`, not the async `opendir` §3.2 specified.** The whole
  filename list is materialized in memory, with a `setImmediate` yield every 500 files for the
  bounded-rate part. Same in `bootstrapIfNeeded`. At 300k this is a real difference from what was
  designed. It also calls `resyncTags()` — a full `tags.json` read and set-diff — at the end of every
  pass.
- Nothing prunes the change log yet, so `truncated` can currently only fire for a nonsense
  `sinceRev`.
- **Caller-supplied `date_added` on import was not implemented, and the reason given is wrong.** The
  module header justifies the omission by saying it is "flagged in the doc's decision log as still an
  open question, not a settled one". It is not: §3.1 marks it settled and decision 17 lists it under
  Settled. A vestigial `forceDateAdded` field exists in the `PendingRow` typedef that nothing sets.
  This is a settled decision skipped on a false premise, and it is the one phase-1 item that should
  be revisited rather than accepted.
- The write-once rule itself is enforced structurally — the UPSERT's `ON CONFLICT SET` list simply
  omits the column. Bootstrap seeds from `ctimeMs` once behind the meta flag; every other discovery
  path uses `Date.now()`.

**Most of §3.3's memoization work did not ship**, and the browse path is still the old one:

- `processCharacter` still does its own `statSync` and still sets `character.date_added =
  charStat.ctimeMs`. So decision 5 is honoured in the new table and still violated in what the UI
  actually receives.
- `getCacheKey()`'s `existsSync` + `statSync` pair was not collapsed.
- The parsed object is still not cached, only the JSON string.
- The disk cache's `verify()` boot scan (`characters.js:131`) is still running, alongside the
  reconciler that was supposed to subsume it.
- §3.3 item 4 did not ship: `chats.js` and `stats.js` do not know the metadata store exists, so
  `date_last_chat` and `chat_size` only refresh when the card file changes or the reconciler happens
  to re-read.

### Phase 2 — browse pagination — SHIPPED IN PART (`6ac50dca2`)

`POST /api/characters/query`, `/exists` and `/changes` all exist, with `tests/characters-query.test.js`
covering them. Three endpoints the spec never mentioned also shipped: `POST /metadata/rescan`,
`/metadata/batch-import/begin`, and `/metadata/batch-import/end`.

What shipped is the browse-only half of `/query`. The request takes the specified
`{filter, sort, page, pageSize, want}` shape; the response is `{rev, rows?, total?}`. Divergences:

- **No `facets`, no `searchBackend`** — not stubbed, rejected. `want` accepts only `rows` and `total`
  and 400s on anything else.
- **`filter.search`, `sort.field: 'random'` and `sort.field: 'search'` all 400.** So decision 23
  (random and search compose) and decision 13 (per-query hash ordering) are unimplemented, and the
  endpoint currently rejects the combination the design requires.
- Sortable fields are name, date_added, date_last_chat, chat_size, fav. `pageSize` defaults to 500,
  capped at 2000.
- `total` is always an exact `COUNT(*)`. Decision 6 permits approximation, and the maintained-counter
  and estimate tiers §5 described are not implemented — acceptable, since exact is the strictest
  reading, but the cost was not measured.
- `/exists` returns a flat `{id: bool}` with every requested id present, chunked 500 at a time.
- `/changes` matches the specified contract except that it collapses to one entry per id, latest op
  winning. Sensible, and not in the contract as written — the contract should be updated to say so.
- 503 `metadata-store-unavailable` when there is no SQLite engine, with no filesystem fallback by
  design.

**All six new endpoints are wired to zero client code.** `/all` and `/manifest` still serve the UI
unchanged, and `/all`'s no-parameter path is still `readdirSync` plus `processCharacter` over the
whole library. Nothing a user can observe has changed yet.

**The tantivy sub-scope of phase 2 is entirely outstanding** — confirmed at HEAD, and none of it was
touched by either commit:

- The stored payload is still `stored: true` on the full character JSON, so every hit still pays a
  full `JSON.parse` and `maxRows` is still load-bearing.
- There is no id field in the schema at all. A `tokenizerName: 'raw'` field exists, but it is on the
  data blob for scoring, not a delete key. Nothing is keyable, so delete-by-term is still unavailable
  in practice.
- There is no delete path whatsoever: no `deleteDocumentsByTerm`, `deleteDocumentsByQuery` or
  `deleteAllDocuments` calls anywhere. Deletion is only ever expressed as discarding the directory.
- The `statSync` freshness signature is still live, stat-ing the characters directory and `tags.json`
  on every search call. `/metadata/rescan` drives the reconciler, not an index repair — a different
  subsystem.

The freshness story as it actually stands: a signature mismatch goes to
`search-index-coordinator.js`; the first search per handle after process start blocks; afterwards
stale results are served immediately while one background rebuild per handle runs and swaps. Always a
**full** rebuild — `rmSync` the index directory, re-read every PNG at 500 per batch, commit every 20
batches. So the two freshness systems, the metadata change log and the search index, are completely
independent, and the metadata module's header states it never touches the search index.

One thing noticed and **not verified**: `buildTantivyIndex` `rmSync`s the index directory as its
first act, while the coordinator may still be serving off an open `Index` handle on that path. POSIX
open-fd semantics probably cover the SQLite tier's equivalent; whether tantivy's segment files
survive it is unchecked. Worth a look before incremental maintenance lands.

*Remaining phase 2 work:* the tantivy items above, plus `filter.search` / random / search-rank sort
in `/query`, plus wiring any of it to the client.
*Files:* `src/endpoints/characters.js`, `src/endpoints/characters-search-index.js`,
`src/endpoints/tantivy-search.js`, `src/endpoints/search-index-coordinator.js`.

### Phase 3 — tags server-side

`tag_map` → `character_tags`; `tag_usage` aggregate; the `/api/tags/for`, `/assign`, `/unassign`,
`/usage` endpoints; client `tags.js` reads through them. Tag *definitions* stay client-resident.

*Files:* `src/endpoints/tags.js`, `src/character-metadata-db.js`, `public/scripts/tags.js`,
`public/scripts/tags-cache.js`.
*Depends on:* phase 1, which has shipped — so phase 3 is unblocked, and it is the next server-side
work available. Runs parallel with the remaining phase 2 items; disjoint files apart from the
metadata module. Note `character_tags` and the trigger-maintained `tag_usage` table already exist
from phase 1, so this phase is the endpoints and the client migration, not the schema.

### Phase 4 — identity cutover (client-heavy, must be split)

- **4a.** `entity.id` becomes the id string: `characterToEntity`, the filter score cache key, the
  sort comparator's key, `BulkEditOverlay`'s numeric comparisons, and the server-search remap
  (§2.4 i, ii).
  *Files:* `public/script.js` (`getEntitiesList`, `fetchServerCharacterSearchResults`),
  `public/scripts/filters.js`, `public/scripts/power-user.js`,
  `public/scripts/BulkEditOverlay.js`.
- **4b.** Delete `this_chid` and `data-chid`: the selection accessor and its tristate; the ~56
  `=== undefined` sites; `personas.js:1938`; the `indexOf`-to-index bucket; the group generation
  cursor; `index.html:7245`'s orphan `chid` attribute and `tags.js:887`'s selector; the
  `id="CharID…"` removal.
  *Files:* `public/script.js`, `public/scripts/group-chats.js`, `public/scripts/personas.js`,
  `public/scripts/utils.js`, `public/scripts/tags.js`, `public/scripts/RossAscends-mods.js`,
  `public/index.html`, and the extension files listed in §2.3.
- **4c.** Delete the `PromptManager` legacy path (§2.4 iii). Settled as a straight deletion, and it
  reduces the fork's diff against upstream. Not a gate on anything: it can land at any point,
  including before phase 4a.
  *Files:* `public/scripts/PromptManager.js`, `public/scripts/openai.js`.
- **4d.** Filename migration (Option A). Mint ids; rename files; rewrite `character_tags`,
  chat directory names, group `members`, `charLore`, `note.chara`, `active_character`; rebuild the
  index. Restartable and idempotent, because at 300k+ it will be interrupted. Includes the
  name → uuid listing tool from §2.2, which is what keeps shell-based corpus management workable
  once filenames stop being readable.
  *Files:* new migration script, `src/endpoints/characters.js`, `src/character-metadata-db.js`, plus
  the listing tool/endpoint.

*Depends on:* 4a, 4b and 4c depend on nothing; they are client-side refactors against the
fully-resident array and can land immediately. 4d depends on phases 1 and 3: it rewrites
`character_tags`, which phase 1 creates and phase 3 populates, and it writes through
`src/character-metadata-db.js`. Running 4d before phase 3 would migrate a table that then gets
repopulated from the old avatar-keyed `tag_map`.

4a and 4b are largely disjoint by file but both touch `public/script.js` heavily, so they want to be
sequential rather than parallel — or one agent. 4d is server-side and can run alongside 4a/4b.

### Phase 5 — client residency

`CharacterRepository`; `getEntitiesList` inverted to a page query; `printCharacters` as a
server-paging controller; the §4.2 destructive-existence sites converted to `repo.exists()` with
abort-on-failure; `getGroupMembers` async with an explicit unresolved list; the §4.4 enumeration
paths.

*Files:* `public/scripts/entity-store.js`, new `public/scripts/character-repository.js`,
`public/script.js`, `public/scripts/group-chats.js`, `public/scripts/world-info.js`,
`public/scripts/tags.js`, `public/scripts/utils.js`,
`public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js`,
`public/scripts/RossAscends-mods.js`, `public/scripts/power-user.js`.
*Depends on:* phases 2, 3, 4a, 4b. Phase 2 shipped only its browse half, and this phase is where the
gap bites: `/query` currently 400s on `filter.search`, `sort.field: 'random'` and
`sort.field: 'search'`, so the remaining phase 2 work is a hard prerequisite rather than a parallel
track.

This is the largest phase and the one where "correctness over diff size" costs the most, because
every one of the ~150 call sites has to be classified rather than mechanically rewritten.

Note the staging option from §9.4: shallow rows for the *entire* library cost ~199 MB at 300k, so
this phase can ship with full shallow residency on desktop — where every extension scan, enumeration
and captured index keeps working — and bounded residency only where the budget demands it (mobile,
and any library past ~1M). That decouples the extension-API decision from this phase's schedule
without changing any of its work: the repository, the query path and the classification of call
sites are the same either way.

### Phase 5b — random sort redesign (small, self-contained)

Seeded hash comparator replacing `shuffle()`; the `sort: { field: 'random', seed }` wire shape and
seed-per-request plumbing; the folders-shuffled-in fix that falls out of it; the seed minted lazily
into `accountStorage` and the reroll button beside the sort dropdown, resetting to page 1 (§5.3; all
settled, nothing here is waiting on a decision).

*Files:* `public/scripts/power-user.js` (`sortEntitiesList`), `public/script.js` (query call),
`src/endpoints/characters.js` (sort contract), `public/index.html` (the dropdown option, if the
reroll control lands there).
*Depends on:* phase 2 for the wire shape. The client-side comparator half can land earlier and
independently, and doing so fixes the visible jumping before the rest of the plan arrives.

### Phase 6 — cache and local search

Raw-IDB two-tier store; quota detection and the frecency budget (§7); the MiniSearch index at
shallow scope (§8) with its own capped budget counted against the same byte total, and its sync to
cache admission/eviction; retire the Fuse index (`power-user.js:2427`).

*Files:* `public/scripts/character-cache.js` (rewritten), new
`public/scripts/local-search-index.js`, `public/scripts/power-user.js`,
`public/scripts/filters.js`.
*Depends on:* phase 5.

### 9.4 The extension API break — measured on this install

`context.characters` is exported raw to every extension for back-compat (`st-context.js`), and
`context.characterId` is a stringified chid (getter-only; extensions cannot set it, though
`selectCharacterById` is exposed and *is* an index-shaped write path that no-ops silently on a bad
id). Bounded residency and uuid identity break both. This was audited against the installed
extension set rather than in the abstract.

Where they live: `src/endpoints/extensions.js:505-530` scans three sources — bundled
(`public/scripts/extensions/`), per-user (`data/default-user/extensions/`, type `local`), and global
(`public/scripts/extensions/third-party/`, type `global`), with per-user winning name conflicts. The
per-user directory is easy to miss and holds one extension.

One installed extension is already broken today, which reframes the question (phase 0d fixes it; see
the settled note below). `writeExtensionField` in this fork now takes an avatar
(`extensions.js:2070`, commits `8d28455b3` / `a682827c3`), but Extension-GroupGreetings still passes
an index (`ContextUtil.js:188`). The `charactersStore.get(index)` misses, logs a `console.warn`, and
no-ops, so group greeting mode has been silently failing to save since that change landed. The
extension API's index contract is already partially broken and nobody noticed, which is evidence
about how loudly these failures announce themselves.

**SETTLED:** That drift gets reverted; `writeExtensionField` accepts both forms. Narrowing an
upstream function from "takes a chid" to "takes an avatar" is unacceptable drift: upstream's
signature takes a numeric id, so every extension written against upstream is silently broken by the
fork, exactly as GroupGreetings is. The function detects which form it was handed and resolves
accordingly:

- The discriminator is clean and does not need a heuristic. Under Option A an id is a UUIDv7, which
  is never all-digits, and a legacy chid is a number or a numeric string (`this_chid` is a *string*
  today, so `'0'` must be handled). So: `typeof x === 'number' || /^\d+$/.test(x)` → treat as a
  positional chid; otherwise treat as an id. No ambiguity is possible between the two spaces.
- The chid branch resolves through whatever the positional space means at that point in the
  migration, and is the branch that carries a deprecation warning. It is the compat path, not the
  primary one.
- This is a general rule, not a one-off patch. Any upstream function this fork has narrowed to
  avatar-only has the same defect and needs the same dual-accept treatment; `writeExtensionField` is
  the one found by audit, not necessarily the only one. Sweeping for others belongs in phase 4b,
  alongside the rest of the identity work.
- This is phase 0d, and it replaces what that phase used to be (a one-line patch to the installed
  extension). With dual-accept, GroupGreetings starts working again without anyone touching the
  extension, which is the point. Fixing the *fork* rather than the extension is the version of this
  that does not depend on extension authors cooperating.

Note the scope boundary: this settles `writeExtensionField` specifically, and the general rule for
any other function the fork has narrowed. It does not settle the broader question of what
`context.characterId` and `context.characters` become. That is the four-option decision still open
at the end of this section, and the two should not be read as the same item.

**Breaks loudly (TypeError on undefined):** SillyTavern-Timelines (`tl_style.js:83`,
`tl_node_data.js:462`/`:464`, `index.js:1507`, and it imports `characters` from `script.js`
directly rather than via context, so the array removal hits it too);
SillyTavern-Smart-Dialogue-Colorizer (`st-utils.js:264`, on every solo-chat stylesheet rebuild;
currently disabled).

**Breaks silently, which is the category that matters:**

- GroupGreetings: `ContextUtil.js:27` findIndex, `:40` `characters[characterId]`. Greetings go
  empty, name shows Unknown. Also `:165-170` mutates the character object in place expecting ST to
  observe it — identity-by-object-reference into the shared array, which the array removal kills.
- Extension-TopInfoBar (`index.js:164`, optional-chained): chat dropdown quietly empties.
- SillyTavern-Flowchart (`PickerNode/definition.ts:40`).
- SillyTavern-Discordia (per-user dir, currently disabled): the largest surface, and the worst
  failure. `parseInt`/`Number(...) >= 0` gates (`ServerBar.tsx:179`, `useSidebarState.ts:102`) go
  `NaN → false` and the UI silently stops working. `ServerIconMenu.tsx:36` and
  `characterService.ts:229` use `characters[characterId] === character` to detect "deleting the
  currently-open character"; with uuids that comparison is always false, so `closeCurrentChat()` is
  skipped, and in `characterService` the delete itself sits inside that `if`, so the delete silently
  does nothing. It also stamps `chat.char_id = characters.indexOf(character)` (`utils.tsx:77`) onto
  chat objects and reads it back later (`useOpenChat.ts:66`), an array index round-tripping through
  persisted-ish data.
- A pattern not previously on the list, and it is in the *bundled* extensions: a module-level "last
  chid" compared with `===` to skip work — `quick-reply/index.js:144`,
  `expressions/index.js:526`/`:534`/`:569`/`:619`, and `memory/index.js:403`, which compares
  `characterId` across an `await` to decide whether to discard a summary. These have a latent bug
  today: delete a character, the next one slides into the freed index, and `===` matches the wrong
  character. Uuid identity *fixes* them, but they still read `characterId`, so they still have to be
  touched.

**Untouched:** PromptInspector, TypingIndicator, WorldInfoInfo, st-custom-fonts, ST-tabbyAPI-loader,
Extension-Notebook, MoonlitEchoesTheme (it watches `.mes .avatar img` in the DOM, never an id),
GuidedGenerations (one dead write at `trackerGuide.js:57`, never read); and bundled attachments,
caption, connection-manager, token-counter, translate, vectors.

**Persistence: none found.** Not one chid-keyed persisted value across the whole installed set:
everything is already avatar-shaped (SD character prompts via `getCharaFilename`, gallery folder
overrides, quick-reply `characterConfigs[avatar]`, regex `AlertRegex_${avatar}`, Colorizer's
`colorOverrides`, Flowchart's `characterAvatar`). Discordia's `setActiveCharacter` looked like a risk
but `getTagKeyForEntity` (`tags.js:926-931`) resolves whatever it is handed down to an avatar before
writing. This removes the single biggest argument for a stable numeric handle: there is no installed
extension whose persisted data a handle would have to remain compatible with.

**Separate axis, hits regardless of identity:** the array-removal half breaks things that never touch
chid — `assets/index.js:359`, `tts/index.js:1296`, `expressions/index.js:644`, Flowchart's avatar
dropdowns, Colorizer `STCharacter.js:156`/`:188`, and Discordia `GroupAvatar.tsx:6`, which
destructures `characters` at module scope.

**Not determinable:** Flowchart depends on `sillytavern-utils-lib`, which is not installed, so what
its `this_chid` export and `buildPrompt(targetCharacterId)` do internally is unread. Dist bundles for
GroupGreetings and Flowchart match their source shape; Discordia's dist was not byte-checked.

#### The wider ecosystem, since 14 extensions is not the installed base

The 14-extension audit above was correctly challenged as too small a sample. It was widened; the
result mostly holds, but for a better reason than the sample size, and one finding changes the
picture.

There is no registry, and there never can be one. SillyTavern's third-party install path is "paste a
git URL": no package name, no index, no telemetry. The installed base is *structurally unknowable*,
not merely unmeasured. What exists instead: `SillyTavern-Content`'s `index.json` (66 `extension`
entries, ~56 of them SillyTavern-org's own — a vouched-for asset list, not a census) and a community
list (68 unofficial entries, 4 of its links already 404). Three independent probes disagree by an
order of magnitude: the `sillytavern-extension` GitHub topic → 110 repos; curated lists → ~70; code
search for the ST-specific `loading_order` manifest key → 1,474 files, extrapolated to very roughly
1,000–1,200 distinct repos. That last figure is order-of-magnitude only and includes core clones.
GitHub also drops forks and unindexed repos, and many extensions circulate as raw clone URLs that
were never indexed at all, so all three are floors.

The two health samples do not overlap, which is itself the finding. The 110 topic-tagged repos are
68% pushed within 3 months and *none* older than a year, because 102 of them were created after
January 2026; that distribution measures topic adoption, not health. The 68 community-list repos run
35% / 43% / 18% (1–2 yr) / 4% (2 yr+), with none archived. Zero repos appear in both. So "the
ecosystem" is at least two populations, a young scaffold layer and a curated survivor layer, and the
abandoned long tail is invisible to both samples. That tail is exactly where the unguarded
`characters[this_chid].name` crashes live.

The persistence risk looks low, for a structural reason. Across 54 cloned repos (33 with hits),
chid-keyed persistence is essentially absent: the ecosystem converged on avatar-as-key on its own.
`Too-Many-Chats` derives its persisted folder map from `characters[characterId].avatar`;
`Character-Creator` stores `lastLoadedCharacterId: 'test.png'`; `character-memory` and `NemoPresetExt`
both do `characters.findIndex(c => c.avatar === avatar)` — avatar as identity, index derived on
demand, which is the shape that survives untouched. The only persisted-chid hits found were
debug/telemetry scope keys (`BetterSimTracker`'s `char:${String(context.characterId)}`), which go
string-shaped and keep working. This is a reason to believe the 14-extension result generalises,
rather than a coincidence, though it holds much more firmly for the popular layer than for the
abandoned tail.

What is fragile instead, ordered by how badly it fails. Code-search floors: `context.characterId`
1,600 files, `this_chid` 1,154, `characters[this_chid]` 710.

1. Numeric coercion guards, silent behavioural inversion. The worst example found:
   `SillyTavern-PicturePrompt` computes `isGroupChat()` as
   `!Number.isFinite(Number(this_chid)) || Number(this_chid) < 0`. Under a uuid that is `NaN`, so
   every single-character chat reports as a group chat, with no error anywhere. `BetterSimTracker`
   has four variants including a hard `typeof context.characterId === "number"`. Several of these
   already misfire today, because `this_chid` is a *stringified* index, and nobody noticed.
2. Bare array indexing, the most common shape by far. With `?.` (most cases) it is
   silent-undefined; without it, a TypeError crash (`InlineSummary` does
   `stContext.characters[this_chid].avatar` unguarded).
3. `=== undefined` sentinel checks, very common, and a trap: they keep *passing* under a uuid
   while no longer answering "is this a valid index", so the failure lands one line later.
4. `-1` sentinels, rarer, total when hit. `Roadway` and `WTracker` do
   `characterId !== -1 ? characterId : undefined`, so the no-character state never normalises and
   downstream `undefined` checks stop firing.
5. Truthiness on the value, common, and survives: a uuid and `"0"` are both truthy.

A grep hazard for anyone re-running this: `SillyTavern-CharacterLibrary`'s ~200 `charId` hits are
chub/janitorai remote uuids, not ST chids.

Upstream precedent is directly on point. Upstream tried making `this_chid` a *number* instead of a
string (PR #3346) and reverted it three days later (PR #3584), because extensions wrote
`if (this_chid)` and index 0 went falsy. A three-day staging window was enough to surface it. Two
things follow: upstream has no stability guarantee here in practice, and breakage of this kind is
loud in aggregate even when each individual instance is quiet. Upstream has not been found to be
moving toward avatar/uuid identity itself, so this fork would be ahead of it rather than aligned
with it.

Loudness inverts from the intuition. Crashes are the *good* case: visible, attributable, one bug
report. The numerous cases are silent — `?.` swallowing an index miss, a `Number()` guard flipping
group-vs-solo detection, `-1` normalisation quietly never firing. Those present as "the extension
just stopped doing anything" or "it thinks I'm in a group chat", and users report that against
SillyTavern, not against the fork.

#### What "the extension breaks" costs

An earlier draft of this section described one option as "loud breaks, fix the six affected
extensions". That framing was wrong and is retracted. Nothing in this design can cause a third-party
extension to be fixed. For an unmaintained extension — and the abandoned tail is both real and
unmeasurable — the outcome is that it silently stops working, permanently, with no recourse for the
user beyond uninstalling it, and the user is likely to attribute the failure to SillyTavern rather
than to this fork. Any option below that breaks extensions carries that cost, and it should be read
that way rather than as a task list.

The counterweight is that the compat surface is not free either, and it is not currently working:
GroupGreetings is broken *today* on this install by a change already made, and several ecosystem
extensions misfire *today* on the string-vs-number quirk. So the choice is not "working compat vs
breakage"; it is between differently-broken states.

#### The bar: no breaking options, full stop

The owner's constraint is that any option whose cost includes "an extension silently stops working"
is out, including unmaintained ones with no recourse. That is a hard bar, not a preference, and it
changes the shape of this section: the four options below are kept because the analysis behind them
is what the implementation has to respect, but none of them clears the bar. Options 1 and 4 break
extensions by design. Option 2 breaks whole-library enumeration. Option 3 makes identity unstable
across residency changes, which is silent wrong-character breakage, the worst kind.

So the question becomes what a non-breaking approach requires, however expensive.

Every failure traced in this section comes from one of two changes: identity changing shape, or the
collection becoming incomplete. Preserving today's observable behaviour therefore means preserving
all four of these at the extension boundary:

1. `context.characters` is a complete array of every character in the library.
2. It is densely indexed from 0, and positions are stable for the life of the session.
3. `context.characterId` is a numeric index into it.
4. Reads are synchronous and return the whole character object.

There is no clever mechanism that provides (4) over non-resident data. JavaScript has no synchronous
fault-in: a Proxy trap cannot await, `Atomics.wait` is unavailable on the main thread, and
synchronous XHR is deprecated and would block the UI anyway. The only way to satisfy (4) is for the
data to already be there. Zero breakage and bounded residency are mutually exclusive at the
extension boundary specifically, not in the app as a whole.

That makes the answer a memory bill, not a mechanism. Keeping the full shallow set resident costs
~665 bytes per row (measured, below): 199 MB at 300k, ~665 MB at 1M, ~6.6 GB at 10M. At the
near-term target that is affordable on desktop, so at 300k zero breakage is achievable today by
continuing to materialize the array: the internal store becomes a repository, and
`context.characters` becomes a fully-materialized view maintained for compatibility.

One wrinkle to handle rather than gloss: those are *shallow* rows, so an extension reading
`.data.description` off an arbitrary character gets undefined where it used to get text. That is a
break, and it is already present upstream — `lazyLoadCharacters` (`characters.js:40`) makes the array
shallow today, defaulting off. Zero breakage means that config must stay off for the extension-facing
view, or the view must hold full cards, which is not affordable at any of these sizes. So the
compatibility view is shallow, and full-card fields fault in through `unshallowCharacter()` as they
already do; extensions that read deep fields synchronously off an arbitrary character are already
broken on any install with that flag on.

Past the point where the bill is payable, at 1M+, the full array stops fitting, and no amount of
design makes it fit. The choice there is between silently degrading, which the bar forbids, and
refusing. Refusal is the only option consistent with the constraint:

- Extensions declare compatibility in their manifest. One new field, absence meaning "legacy".
- If any legacy extension is active, the app maintains the complete materialized array and pays the
  memory. The user's extension choices determine the app's residency behaviour, which is the right
  place for that cost to land: it is visible, attributable, and reversible by uninstalling.
- If the library is too large for that, the app refuses to enable the legacy extension and says so,
  naming the extension and the reason. A clear refusal is not silent breakage; the user knows
  exactly what happened and what their options are.
- Extensions that declare compatibility get the bounded-residency API and impose no cost.

This is more invasive than any of the four options below — it means a manifest field, a
compatibility mode in the repository, and a policy layer deciding between them. It is the only shape
found that never silently breaks anything.

What stays unresolved is not the mechanism but the policy: the threshold at which refusal kicks in,
and whether a user can override it and accept the memory cost. Those are product calls, and they do
not block phases 0–4.
#### The four options, and why each fails the bar

Kept for the analysis, which the implementation still needs. None is recommended.

**Option 1.** `characterId` becomes the uuid string.
Everything treating it opaquely keeps working, and some things get more correct: the module-level
"last chid" caches stop being array positions, which fixes a latent delete-shifts-the-index bug.
Shapes 3, 4 and 5 above survive or fail one line later; shapes 1 and 2 break, shape 1 silently.
`selectCharacterById` would need to accept uuids.
*Cost:* an unknown number of unmaintained extensions silently stop working or start behaving wrongly,
with no path to repair. Cannot be sized, because the installed base cannot be enumerated.

**Option 2.** A numeric compat handle, `context.characters` backed by a Proxy.

A previous draft of this option was wrong, and the correction changes the answer. It argued that a
numeric handle cannot rescue array indexing, because under a sparse handle space `characters[7]`
would be "a valid array slot holding a different character". That assumed the backing store had to be
a physically positional `Array`. It does not, and the assumption was never examined. The claim is
retracted; what follows was measured (Node 24, via the project flake).

The `Array` constraint is not real. `Array.isArray(proxy)` and `proxy instanceof Array` both return
true for a Proxy whose target is an array, and a `get` trap can resolve a numeric key by map lookup
rather than by position. So `characters[7]` returns the correct character under a sparse,
non-positional handle space. `findIndex()` returns a stable handle rather than a position. There is
no collision problem and never was one.

The real constraint is synchronous access to non-resident data, and it is a JS engine property: a
`get` trap cannot `await` any more than an array read can. But that constraint does not differentiate
between these options, which is the substantive correction. Under Option 1 an extension doing
`characters.find(c => c.avatar === uuid)` fails on a non-resident character in exactly the same way.
Residency breaks the same things regardless of what identity looks like. The identity shape only
decides whether resident lookups return the right answer.

So the two failure modes have to be separated, because they behave differently:

**(a)** Indexing by a handle captured earlier: `const i = findIndex(...)`, use `i` later, possibly
across an `await`. A Proxy over stable handles makes this correct, and more correct than today. Right
now deleting a character shifts every later index, so a captured chid silently starts pointing at its
neighbour. That is a latent bug in bundled code today (the module-level "last chid" caches in
`quick-reply`, `expressions`, `memory`). Stable handles fix it.

**(b)** Sequential enumeration: `for (i = 0; i < characters.length; i++)`, `map`, spread, `for…of`,
`JSON.stringify`. This does not survive, and the measured failure shapes are worse than "undefined":

- With throw-on-miss: `find` and `some` terminate early, so they succeed or throw depending on where
  the match happens to sit in handle order. Nondeterministic by cache state. `map`, spread and
  `JSON.stringify` always throw.
- With undefined-on-miss: spreading a 2M-handle space took 219 ms and 55 MB to produce 2M
  `undefined`s and 50 real entries. A no-match `find` full-scans at 122 ms for 2M, so roughly 600 ms
  at 10M, synchronously, on the UI thread.
- One bright spot: `Object.keys(proxy)` through an `ownKeys` trap returns only real handles, cheaply.
  A clean enumeration path exists; it is not the one extensions use.

Enumerating the whole library is a residency casualty, not an identity one. No option preserves it,
because nothing can synchronously enumerate 10M rows.

On keeping the full id list resident (the "it's only a few MB" idea): measured, and the arithmetic
does not hold.

- 300k uuid strings: 50 MB. 1M: 160 MB. Extrapolated 10M: ~1.6 GB. V8 carries ~160 bytes per short
  string, not 36.
- Packed 16-byte binary is 160 MB at 10M, but then a reverse uuid → handle `Map` is needed, which
  gives most of it back.
- More importantly, it does not buy what it was meant to buy. `length` does not need the list: a
  monotone counter gives max-handle+1 for zero bytes, an overestimate by the number of deletions.
  And a resident id list answers existence, while extensions want `characters[7].name`, the object.
  Keeping shallow rows for everything instead is ~199 MB at 300k (measured below), which fits a
  256 MB mobile budget only by consuming ~78% of it, leaving almost nothing for full cards or the
  search index (§7.2, §8.3).

So: cheap and reasonable at the 300k near-term target, marginal at 1M, not viable at 10M. And even
where affordable it does not rescue dereferencing.

Miss-case behaviour: none is safe in general, and they are not equally unsafe.

| behaviour | failure |
|---|---|
| `undefined` | indistinguishable from "no such character"; `?.` swallows it and the extension silently no-ops |
| throw | loud and attributable, but nondeterministic, since it depends on cache state, so an extension works one day and crashes the next with no code change |
| lazy stub (placeholder + promise) | the extension reads `.name` and gets a placeholder it then uses; silently wrong data |
| stale copy | requires having the data, which is the premise being violated |

Throw becomes defensible only when paired with an explicit, held residency guarantee: current
character, current group's members, current page always resident. Then a throw means "you asked for
something outside the documented contract", which is a deterministic programming error rather than
cache weather. Without such a guarantee, throw is randomised breakage.

*Revised cost:* not "half the compat". It rescues shape 1 (numeric coercion guards, the worst silent
failure), shape 2 by captured handle (the most common), and fixes a latent index-shift bug in the
process. Sentinels can be preserved by choosing the handle space: 1-based so 0 is never "nothing
selected", or keeping `undefined`. What it does not rescue is whole-library enumeration, which no
option rescues. The remaining costs are a permanent commitment to a handle space the system does not
otherwise need, `length` being an overestimate, and the miss case being unavoidably imperfect, which
forces the residency guarantee to become a public contract.

Other handle sources are worse. A per-session counter reintroduces the recycled-identity failure
Option A was chosen to eliminate, at a boundary where it cannot be fixed later. A hash needs the
reverse table anyway and produces values that break `>= 0` assumptions harder than a uuid does. A
monotone, never-reused server-assigned counter is the one that works.

**Option 3.** Keep the old API shape, dense indices scoped to the resident set.
`characterId` stays a dense numeric index and `context.characters` is an array of exactly the
resident characters. Array indexing works, numeric guards work, `.length` is accurate for what it
describes, and enumeration works, which is the one thing Option 2 cannot give.
*Cost:* a character's index now changes whenever residency changes, which is far more often than the
library changes today. Anything holding an index across an `await` or in a module-level variable, as
bundled code does, silently gets the wrong character. It trades a one-time break for a permanent
intermittent one.

Note how 2 and 3 divide: Option 2 is stable identity with broken enumeration, Option 3 is working
enumeration with unstable identity. Option 2 strictly dominates on the capture-and-reuse shape, where
3 is worse than today, and Option 3 wins only on whole-library enumeration, the shape that is least
defensible at 10M anyway. Both are strictly more work than 1 or 4.

**Option 4.** Hard break with a documented migration to `context.repo`.
Remove `characterId` and `characters` outright rather than changing what they mean. Every consumer
fails immediately and visibly at load, rather than subtly at runtime.
*Cost:* strictly more extensions stop working than Option 1, and the same no-recourse problem
applies. But nothing silently misbehaves, and the failure is unambiguously attributable to the fork
rather than mistaken for a SillyTavern bug.

On `context.characters` specifically, under any option: a resident-only view plus a deprecation
warning is only tenable if consumers can tell it is a subset, and they cannot, since `.find()`
returning undefined reads as "no such character". It becomes defensible only alongside a stated and
held residency guarantee (current character, group members, current page always resident) with the
collection documented as being that set, not the corpus.

#### Can residency be guaranteed just-in-time, per lookup?

The proposal worth testing: rather than guaranteeing the whole handle space is resident, guarantee
that whatever an extension is about to dereference is resident at the moment of access, so misses on
legitimate lookups never happen in practice. Traced against real code the answer is no as a general
guarantee, yes for a narrower and still useful scope. The blocker is not the one expected.

Handles do not come from the dispatch path. Character-bearing events do exist: `CHARACTER_DELETED`
carries `{id, character}`; `CHARACTER_EDITED` / `CHAT_LOADED` carry `{detail:{id, character}}`;
`CHARACTER_EDITOR_OPENED` and `GROUP_MEMBER_DRAFTED` carry a bare chid; `CHARACTER_RENAMED` /
`CHARACTER_DUPLICATED` carry avatar strings; `CHAT_CHANGED`, the most-listened event, carries only a
chat id, and `CHARACTER_PAGE_LOADED` carries no payload at all. But of the installed extensions
surveyed, almost none take their handle from an event payload. The real doors are:

- **Their own scans.** Colorizer's `STCharacter.fromAvatar` does `characters.find(...)` and throws if
  absent, driven from three MutationObservers, so every DOM mutation on `#chat` becomes a full-array
  membership test. Discordia scans twice per recent-chat entry. `assets` maps every avatar per
  rendered marketplace card.
- **Direct module imports.** Third-party extensions import from `../../../../script.js` and
  `../../../utils.js`, not only through `getContext()`. `findChar()` (synchronous, name-scan), the
  raw `characters` binding, and `getCharIndex()` are all reachable outside the context surface.
- **DOM reads.** `#avatar_url_pole`'s value, an avatar parsed out of a message thumbnail's `src`,
  `element.data('avatar')` on sprite holders. These yield avatar strings, which under Option A are
  the identity, so they are fine in principle; they need an async resolve.
- **Persisted from an earlier session.** Flowchart stores a `characterAvatar` in its saved graph and
  resolves it later with a throwing `find`.

The structural consequence is that `getContext()` is not a chokepoint. Any guarantee enforced at the
context boundary is incomplete by construction, because the module boundary is wide open. That is
what decides this question, not anything about async.

The dispatch-path guarantee is nearly free, and worth doing regardless. `eventSource.emit` is already
`async` and awaits each listener in sequence (`public/lib/eventemitter.js:130`); despite the name,
`emitAndWait` is the synchronous one and is used exactly once in the tree, on an event carrying no
character. So every character-bearing event already flows through an awaitable path, and inserting an
"ensure resident" await before listener dispatch costs nothing structurally. Roughly 195 of 203 emit
sites already `await`, and the three un-awaited character events sit inside functions that are
already `async`, so no currently-synchronous call site would have to change. Also checked: the
emitter's auto-fire replay, which would re-hand a stale payload to a late-registering listener, is
enabled only for `APP_READY` and `APP_INITIALIZED`, neither carrying a character, so that hazard does
not apply. Cheap and safe, but it covers a small fraction of real usage.

Capture-then-reuse splits three ways, and only one is dangerous:

- **Captured object.** Fine automatically, and earlier drafts over-worried it. Ordinary GC keeps a
  referenced character object alive; evicting it from the cache does not invalidate a reference
  someone already holds. `regex`'s `checkCharEmbeddedRegexScripts()` holds a character across
  `await callGenericPopup()`, across a human deciding, and is safe for exactly this reason.
- **Captured avatar string, re-resolved later.** Needs a fault-in on resolve. There is a precedent in
  the tree: `unshallowCharacter(avatar)` is a fault-in, but field-level (entry present, fields
  missing). Entry-level absence is a different shape, nothing is written for it, and
  `EntityStore.get()` is a plain synchronous `Map.get` with no fault-in hook.
- **Captured number, consumed much later.** The real hazard, and not hypothetical. Discordia's
  `getRecentChats()` computes `characters.indexOf(character)` after an await, puts that number into
  React state, and consumes it on a later user click to delete a chat; a wrong index deletes the
  wrong character's chat. Timelines re-dereferences `characters[context.characterId]` inside a loop
  after each `await fetch(...)`. TopInfoBar reads through two deferral hops (debounce, then
  `setTimeout(…, 0)`).

One mitigating detail worth recording: `context.characterId` is a lazy getter recomputed on every
read (`st-context.js:188`), so it self-heals across awaits, while `ctx.characterAvatar`, `ctx.name2`
and `ctx.chatId` on the same object are plain captured snapshots. That asymmetry is undocumented and
has already bitten at least one extension.

Pinning does not close the gap. Pin-on-hand-out with a session-scoped pin set is implementable and
would cover handles passing through a controlled path. But it can only hook what is handed out, and
most handles are not handed out: they are found, by the extension scanning a collection the fork does
not mediate. A self-scanned or synthesized handle has no hand-out event to pin against. Explicit
release would work, and no existing extension will ever call it.

So the workable form of the guarantee is not "the handle you are about to dereference is resident".
It is a scoped residency contract: the current character, the current group's members, the current
page's rows, and anything handed through a controlled path recently, are guaranteed resident;
anything else may fault. That covers the large majority of real dereferences, because real extensions
overwhelmingly care about the current character. What it does not cover is whole-library scans.

Under the no-breakage bar that is not good enough on its own. "The large majority" is not "all", and
Colorizer's throwing `find` is exactly the minority case. The scoped contract is what the
compatibility-declaring API offers; legacy extensions get the fully materialized array instead, and
pay for it in memory. The analysis above is why that split exists rather than a single middle option.

A staging fact changes the urgency. Measured (Node 24, shallow rows shaped from the real field-size
distribution in §8.2, plus an avatar-keyed `Map`, heap delta around a forced GC): ~665 bytes per row,
so 199 MB at 300k, ~665 MB at 1M, ~6.6 GB at 10M. Those figures assume `creator_notes` excluded from
the projection; including it roughly doubles them (§7.1).

So at the stated near-term target of 300k, keeping every shallow row resident is affordable on
desktop and the entire extension-compat problem does not arise: `find(...)` scans work, enumeration
works, captured numbers resolve. This is a 1M+ problem, not a 300k problem.

Mobile is the constraint, and the arithmetic is tighter than a straight over/under. 199 MB does fit
inside the 256 MB mobile budget (§7.2), but it consumes ~78% of it, leaving essentially nothing for
full cards or the local search index (§8.3), which share that budget. So full shallow residency is
not impossible on mobile at 300k, it is not affordable alongside the rest of the cache; and past
~400k rows it exceeds the budget outright. Mobile therefore still needs bounded residency and still
meets everything above.

The consequence for scheduling: the extension decision can be staged behind the rest of the work
rather than blocking it, and phase 5 could ship with full shallow residency on desktop while the
contract is settled.

Where this lands. The question was never primarily "which identity shape". It is what residency
guarantee the fork commits to as a public contract. With the no-breakage bar applied, that question
has an answer: two contracts, not one. Extensions that declare compatibility get bounded residency
and the scoped guarantee. Everything else gets a fully materialized array and costs memory, until the
library is large enough that the app has to refuse rather than degrade.

Identity shape then falls out. The legacy view keeps today's semantics because that is what "no
breakage" means; the declared-compatible API uses the uuid, because there is no reason to carry a
positional handle into a surface built new.

What remains open is policy, not mechanism: the size threshold for refusal, and whether the user may
override it. Neither gates anything before phase 5.

---

## 10. Decision log

### Settled

| # | Decision | Where |
|---|---|---|
| 1 | Identity is a minted immutable **UUIDv7**, and the PNG is named after it. `avatar` and `id` become the same value. | §2.2 |
| 2 | `entity.id` becomes that id; the server-search seam stays id-keyed end to end. | §2.4 i, ii |
| 3 | `this_chid` / `data-chid` are removed completely, as an ordinary refactor, not partially. Not a blocker. | §2.3 |
| 4 | **SQLite metadata DB** as the server-side index of record for everything non-full-text. | §3 |
| 5 | `date_added` is recorded once at first index and never recomputed. It stops being `ctimeMs`. | §3.1 |
| 6 | Pagination totals may be approximate but never capped. | §5 |
| 7 | Server does no unmemoized full-disk reads: read and parse once per change event, never per request. | §3.3 |
| 8 | Random sort becomes a **seeded hash ordering**, with the seed carried on every page request. | §5.3 |
| 9 | Local search indexes the **shallow field set** only. Decided on measured build time, memory and query latency. | §8.2, §8.3 |
| 10 | Random-sort seed is client-generated, stored in `accountStorage`, and rerolled by an explicit button. | §5.3 |
| 11 | The `PromptManager` legacy chid path is **deleted**, not migrated. Reduces the fork's diff against upstream. | §2.4 iii |
| 12 | The index persists as chunked structured-clone IDB records via `loadJS`, never a serialized string, so the V8 string cap is out of the design. `storedFields` move out of the index into the row store. | §8.4 |
| 13 | The random-order hash is computed per query, never materialized: a seeded column is O(users × rerolls) to maintain. `/random` itself is unconstrained. | §5.3 |
| 14 | Local index size is a user config knob, default unlimited. Bounded in practice by the storage budget, so the index participates in eviction. | §8.4, §8.3 |
| 15 | Local search fires at a **3-character minimum**, which removes the prefix-fanout problem. Server search keeps answering shorter queries. | §8.4 |
| 16 | `writeExtensionField` accepts both a chid and an id, reverting fork-local drift that silently broke upstream-written extensions. Applies as a general rule to any other narrowed function. | §9.4, phase 0d |
| 17 | Bulk import may optionally supply `date_added` per record, falling back to discovery time. Still write-once; caller-supplied values get validated. | §3.1, §3.3 item 7 |
| 18 | Local search engine is **MiniSearch**, behind a thin swappable wrapper. | §8.2 |
| 19 | The character cache uses **raw IndexedDB**, not localforage (per-item transactions and full-key materialization are the wrong shape at 300k). localforage stays for the app's small stores. | §7.1 |
| 20 | Cache eviction is **frecency** against a byte budget, not LRU: an LRU inverts this access pattern. | §7.3 |
| 21 | Storage budget is a **learned ceiling**: never trust `quota`, detect exhaustion by `error.name` alone, evict and retry. | §7.2 |
| 22 | No breaking options for extensions, full stop. None of the four candidate options clears that bar, so the extension API splits in two: declared-compatible extensions get bounded residency and the uuid; legacy ones get a fully materialized array and cost memory. Past the size where that is payable the app refuses to enable a legacy extension and says why, rather than degrading silently. | §9.4 |
| 23 | Random sort and search compose unconditionally. Search narrows the set, the seeded hash orders it. Sort stops being forced by the presence of a query. | §5.3 |
| — | (Inputs from the outset: correctness over cost; disk-quota-based cache cap; a real client-side search index; phase 0 ships first.) | §0 |

### Still open

Every design question is settled. What remains is two product policies and one measurement, none of
which blocks any phase.

1. §9.4, the refusal threshold. Decision 22 settles the mechanism: legacy extensions get a
   materialized array, and past the size where that is payable the app refuses to enable them rather
   than degrading. Unsettled is where that line sits and whether a user may override it and accept
   the memory cost. A product call, not a design one. Does not gate phases 0–4.

2. §8.3, whether the extension-facing shallow view includes `creator_notes`. The field is already a
   config flag (`performance.shallowCharactersIncludeCreatorNotes`, default off) and it changes the
   resident cost by more than 2× (601 B → 1,377 B per row, measured). At 300k that is 199 MB versus
   ~410 MB, which is the difference between fitting a mobile budget and not. Whichever way it goes,
   the flag must not silently change residency behaviour underneath the guarantee in decision 22.

3. Not open, but not finished: the term-dictionary saturation caveat in §8.2 means the 50k/100k
   MiniSearch figures understate a library of distinct cards. Re-measure against the real corpus
   during phase 6 rather than trusting the current numbers at the top end.

Both §8.4 questions closed as decisions 14 and 15. The hybrid dictionary/postings architecture stays
documented as the next step if a large desktop index outgrows chunked clone; with the 3-character
minimum it is not forced by anything, and the wrapper keeps the engine swappable.

### Settled decisions the shipped code does not yet honour

Not open questions — implementation gaps, listed here so they are not mistaken for either.

- **Decision 17** (import may supply `date_added`): not implemented, and skipped on the stated
  grounds that this document left it open. It does not. The `PendingRow` typedef has a vestigial
  `forceDateAdded` nothing sets. Phase 1.
- **Decision 5** (`date_added` stops being `ctimeMs`): honoured in the metadata table, still violated
  on the live browse path, where `processCharacter` sets `date_added = charStat.ctimeMs` on what the
  UI actually receives. Phase 1 / §3.3.
- **Decisions 13 and 23** (per-query random ordering; random and search compose): `/query` currently
  400s on `filter.search`, `sort.field: 'random'` and `sort.field: 'search'`. Remaining phase 2 work.
- **Decision 7** (no unmemoized full-disk reads): most of §3.3 did not ship. The per-request
  `statSync` calls, the `getCacheKey()` collapse, caching the parsed object, deleting the disk
  cache's `verify()` boot scan, and wiring the chat write path to `date_last_chat` / `chat_size` are
  all outstanding. Phase 1 / §3.3.
- **Decision 16** (`writeExtensionField` dual-accept): phase 0d, not started.

Two implementation details that want a decision rather than a fix: the metadata `meta` table holds
only `bootstrap_completed`, so there is no schema version to migrate against later; and the
reconciler uses `fsPromises.readdir` rather than the async `opendir` §3.2 specified, materializing
the whole filename list. Neither is wrong today; both get worse at 300k.

### Verified since the first draft

Everything previously carried as `[unverified]` has been checked, and several answers changed the
design rather than confirming it:

- Tantivy delete-by-term exists and works (probed against the installed binding), so incremental
  index maintenance is real. But the schema has no keyable identity field today, so phase 2 must add
  a `raw`-tokenized id field and pay one final full rebuild. `SearchHit.order` is garbage, and
  `garbageCollectFiles()` is a no-op. §3.
- inotify takes one watch per flat directory regardless of file count (measured), but queue overflow
  at 16,384 events is silent: no `error` event, no way to distinguish complete from lossy. The
  reconciler is therefore mandatory, not a backstop. §3.2.
- `QuotaExceededError`'s numeric fields do not exist in Safari or Firefox and are `null` even in
  Chrome 138+ for IndexedDB (MDN browser-compat data, read 2026-08). Detect by `.name` only. And
  `persist()` can never succeed in a plain iOS Safari tab — structural, verified in WebKit source,
  not a heuristic. §7.2.
- MiniSearch was benchmarked against the real 24k-card corpus. The V8 serialization wall turned out
  not to be inherent: `loadJS` takes a plain object or a generator, and IDB stores by structured
  clone, so the string is never built. The field-scope decision now rests on build time, memory and
  query latency alone. §8.2, §8.4.
- The extension ecosystem was surveyed beyond the 14 local installs. No registry exists and the
  installed base is unknowable in principle; chid-keyed *persistence* is near-absent ecosystem-wide
  (it converged on avatar-as-key independently); the fragile shapes are mostly silent rather than
  loud; and upstream already tried and reverted a smaller change to this same value. §9.4.
- The `/duplicate` suffix loop is a real bug — not the one originally suspected, but a
  server-wedging infinite synchronous loop. §1.3, phase 0c.
