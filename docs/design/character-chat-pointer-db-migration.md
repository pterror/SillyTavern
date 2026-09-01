# Retiring the chat pointer from the card file

Scope note: this is a design pass on one specific gap left open by
[`character-data-residency-redesign.md`](character-data-residency-redesign.md) and its own
`character-metadata-db.js` module — that doc moved sort/list/filter state (`fav`, `date_last_chat`,
`chat_size`, tags) off card-embedded fields and into the phase-1 SQLite store; this doc covers the one
piece of per-install character state that move did not touch: which chat file is currently open for a
character. Investigation only. No code changes here.

## 0. Why this matters, and what's actually being defeated

Two independent things in this codebase currently get called "dedup," and they are affected differently
by the chat pointer, which matters for §4 below:

1. **`content_identity_hash`** (`character-metadata-db.js`'s `characters` table, populated via
   `computeContentIdentityHash()` in `src/character-card-normalize.js:166-169`) — a semantic fingerprint
   used to recognize independently-imported copies of the same character. It is **already unaffected** by
   the chat pointer: `stripInstallLocalFields()` (`character-card-normalize.js:138-145`) explicitly strips
   `fav`, `data.extensions.fav`, `chat`, and `create_date` before hashing. This mechanism is not what's
   broken.
2. **On-disk extent sharing** (`cp --reflink=always` at import time, verified via `btrfs fi du`) — this
   *is* defeated, because every chat switch calls `writeCharacterData()` → `writeCardToFile()`
   (`src/endpoints/characters.js:265-340`, `src/character-card-parser.js:320-370`), which writes a new
   file and renames it over the character's PNG. `chat` embedded in the JSON payload
   (`src/endpoints/characters.js:944`, `char.chat = request.body.chat`) means that payload — and
   therefore the file's content — changes every time, but as §4 traces, embedding `chat` in the card is
   not the only reason this write happens.

## 1. Precedent already in this codebase: `fav` made this exact move

This is worth stating up front because it changes the shape of the remaining design questions: `fav` was
already migrated from a card-embedded field to a db-authoritative one, in this same codebase, and the
pattern is fully worked out and shipped. `chat` is explicitly called out as the one field that
deliberately did **not** get the same treatment:

- `character-card-normalize.js:110-116` (`omitFavField()`'s doc comment): "`chat` (the current
  chat-pointer) is a live field those two routes read from the request body and write through
  deliberately... an entirely separate, still-file-resident concern this change does not touch."

The shipped `fav` pattern, piece by piece:

- **Schema**: a plain `fav INTEGER NOT NULL` column on the existing `characters` table
  (`character-metadata-db.js:141-160`, `SCHEMA_SQL`).
- **Write path split in two**: an ordinary card edit never carries `fav` into the file at all
  (`omitFavField()`, called at `characters.js:951` in `/edit` and `characters.js:1138` in
  `/merge-attributes`'s `mergeCharacterUpdate()`). A dedicated `setCharacterFav()`
  (`character-metadata-db.js:794-810`) is the *only* writer of the column post-insert, and its own doc
  comment (`character-metadata-db.js:773-793`) is explicit: "Deliberately does NOT touch the character's
  PNG card file at all: no read, no write, no `fireMetadataUpsertHook()`." It's exposed as its own route,
  `POST /api/characters/fav` (`characters.js:1279-1294`), which 404s if the row isn't tracked yet rather
  than silently no-oping.
- **Read path correction**: because card-derived read paths (`/all`'s `processCharacter()`,
  `/all?search=`'s tantivy results) still serialize whatever `fav` happens to be sitting in the file (or,
  for an already-migrated row, nothing at all), both get corrected post-hoc by `stampDbFav()`
  (`characters.js:1519-1543`), called at `characters.js:1555` and `:1597`. It stamps the db's `fav` value
  over the card-derived one for every already-tracked row, and leaves untracked rows (not yet seen by
  bootstrap/watcher/reconciler) alone.
- **Migration / carry-forward**: `writeRowSync()` (`character-metadata-db.js:688-709`) reads whatever
  `fav` a legacy card had **once**, at the row's first INSERT (`existed` false) — via `buildRow()`
  (`character-metadata-db.js:607-651`, `fav: character.fav ? 1 : 0`, computed straight from whatever JSON
  was parsed off disk). Every subsequent call for that same row is forced back to the row's *current*
  `fav` value before the UPSERT runs (`character-metadata-db.js:692-699`), regardless of what the
  (by-then-irrelevant, and after `/edit`/`/merge-attributes`, absent) card field says. This is exactly the
  "one-time carry-forward, then db owns it forever" shape §3 below proposes for `chat`.
- **`mergeCharacterUpdate()` already extracts a field like this out of a merge payload before it reaches
  the card**: `characters.js:1127-1138` pulls `fav`/`data.extensions.fav` out of the incoming update,
  merges normally so `deepMerge`'s precedence rules decide the winning value, then applies it via
  `setCharacterFav()` *after* `omitFavField()` has already kept it out of what gets written. `chat` is not
  given this treatment today — `mergeCharacterUpdate()` deep-merges `chat` straight into the card like any
  other field (confirmed: no `chat`-specific carve-out exists alongside the `fav` one at that call site).

None of this means `chat`'s migration is a mechanical copy-paste of `fav`'s — `chat` has more read/write
call sites (§2) and a messier "what's the current value if nothing has ever set one" question (`fav`
defaults to `false`/absent; `chat` needs a *name*, and today that name is synthesized client- and
server-side in more than one place) — but it is a directly analogous, already-proven pattern to weigh any
new proposal against, not a fresh design.

## 2. Every real site that reads or writes `character.chat` today

### Server (`src/`)

| Site | What it does |
|---|---|
| `character-card-normalize.js:64` (`convertToV2()`) | `result.chat = char.chat ?? '${name} - ${date}'` — synthesizes a placeholder if the source card had none, on V1→V2 conversion. |
| `character-card-normalize.js:107` (`omitInstallLocalFields()`) | Unsets `chat` outright — used by `importFromX()` importers (`characters.js`) so a freshly-imported card never carries a chat pointer at all; comment states this app "never reads them back off a freshly-imported card itself." |
| `character-card-normalize.js:119-122` (`omitFavField()`) | Explicitly does **not** touch `chat` — doc comment flags this as the still-untouched half of the same problem (§1). |
| `character-card-normalize.js:138-145` (`stripInstallLocalFields()`) | Strips `chat` before computing `content_identity_hash` — already unaffected by chat, per §0. |
| `character-card-normalize.js:256` (`readFromV2()`) | Same placeholder-synthesis fallback as `convertToV2()`, for cards already in V2 shape. |
| `characters.js:636` (BYAF import) | Sets `card.chat` to the first scenario's generated chat name, "so we open to an existing chat instead of creating a new one." |
| `characters.js:944` (`/edit` route) | `char.chat = request.body.chat` — the direct write the task description names; goes through `writeCharacterData()` → full card rewrite. |
| `characters.js:1127-1138` (`mergeCharacterUpdate()`, `/merge-attributes`) | Deep-merges `chat` into the card like any other field (no carve-out, unlike `fav` at the same call site) — full card rewrite. |
| `characters.js:1519-1543` (`stampDbFav()`) | Precedent shape for what a `chat` equivalent read-side correction would need to be — see §1. No `chat` analogue exists today because there's no db value to stamp yet. |

### Client (`public/script.js`)

| Site | What it does |
|---|---|
| `2030-2039` (`deleteCharacterChatByName()`) | If the deleted chat was the active one, picks a replacement and calls `updateRemoteChatName()`. |
| `2045-2072` (`replaceCurrentChat()`) | `charactersStore.update(avatar, { chat })`, syncs `#selected_chat_pole`, calls `saveCharacterDebounced()` (→ full `/edit` POST). |
| `8318` (`getChat()`) | Reads `getCurrentCharacter().chat` to fetch the active chat's contents from `/api/chats/get`. Comment there literally names it "this character's persisted 'current chat' pointer." |
| `8433-8441` (`openCharacterChat()`) | `charactersStore.update(avatar, { chat: file_name })`, then **unconditionally** calls `createOrEditCharacter(new CustomEvent('newChat'))` — see §4, this is the crux of whether removing `chat` from the card actually helps. |
| `9519` | `$('#selected_chat_pole').val(character.chat)` — syncs the hidden form field (`public/index.html:6210`, `<input id="selected_chat_pole" name="chat" type="hidden">`) that `createOrEditCharacter()`'s `FormData` picks up on every submit. |
| `11495-11507` (`doNewChat()`) | Sets, then re-sets, `charactersStore`'s `chat` (comment explains the double-set: `getChat()` can refetch and clobber the pending rename before the save actually fires), then calls `createOrEditCharacter()` directly. |
| `11570-11572` | In-memory sync of `charactersStore`'s `chat` when a chat file itself gets renamed elsewhere, no direct save call at this site. |
| `11638-11657` (`updateRemoteChatName()`) | Posts `{ avatar, chat: newName }` to `/api/characters/merge-attributes` — a narrower payload than `/edit`'s full form, but `mergeCharacterUpdate()` server-side still reads-merges-rewrites the whole card (§2 server table). |
| `12373` | `getCurrentCharacter()?.chat === chatFile` — a display/comparison read, no write. |

### Client, other modules

| Site | What it does |
|---|---|
| `public/scripts/bookmarks.js:117-119` | Parses `getCurrentCharacter().chat` as a string to derive `chat_metadata.main_chat` (bookmark-name token stripping) — a display/derivation read, not a pointer-identity one. |
| `public/scripts/bookmarks.js:138, 279` | Truthiness/branching reads (`selected_group` vs. character chat). |
| `public/scripts/tokenizers.js:901` | `chatId = getCurrentCharacter().chat` — keys token-count caching off the active chat's name. |
| `public/scripts/st-context.js:197` | Exposes `.chat` via `getContext()` — **this is the third-party extension API surface**, not just internal plumbing. |
| `public/scripts/slash-commands.js:5577` | `chat: character.chat` in a slash-command response — same extension-facing concern. |

**On the extension-surface finding**: `st-context.js` and `slash-commands.js` read `character.chat` off
the *client-side* `charactersStore` entity, which is already a JS object assembled server-response data
into — nothing here requires that object's `.chat` property to disappear or be renamed for a db-backed
pointer to work; it only requires that property to keep getting populated (now from a db-sourced value
server-side, mirroring how `fav` still shows up as `character.fav` client-side today post-migration, via
`stampDbFav()`). So the extension API surface is a constraint on **keeping the client shape stable**, not
a blocker on moving the storage.

**On whether anything else depends on the card's own `chat` field for an unrelated reason**: checked
`/export` (`unsetPrivateFields()`, `character-card-normalize.js:76-80`, called at `characters.js:2395` —
already strips `chat`, so exported cards never carry a meaningful pointer for the recipient anyway) and
`/import`/`omitInstallLocalFields()` (already strips it too, §2 table). No other consumer — no other
route in `characters.js`, no other client module beyond the ones listed — reads `chat` for anything other
than "which chat is currently open." This was a `grep` across `src/` and `public/scripts/*.js` for the
literal field access, not an exhaustive semantic audit of every third-party extension that might exist
outside this repo.

## 3. Migration path for existing cards

The `fav` precedent (§1) gives a direct answer for the mechanism: `writeRowSync()`
(`character-metadata-db.js:688-709`) already carries a legacy card's embedded value forward **once**, at
first INSERT, via `buildRow()` reading straight off the just-parsed card. The same shape applies to
`chat`: `bootstrapIfNeeded()`'s one-time backfill (already walks the whole existing library — see
`character-data-residency-redesign.md`'s phase-1 section) and the write-path hook
(`upsertCharacterFromWrite()`, `character-metadata-db.js:749-771`) both already have the parsed card
object in hand when a row is first created; seeding a new `active_chat`-shaped column/field from
`character.chat` at that point costs nothing new to compute. This is lazy-migrate-on-first-touch in the
same sense `fav`'s bootstrap already is — every character gets touched once, either by the bootstrap pass
(existing library) or by the write-path hook (a card touched for the first time after this ships), and
after that the db is authoritative.

What happens to the old card-embedded field is a separate, open question, with the same three shapes this
codebase has already used for other fields at different sites (not a recommendation, an inventory of
what's already precedented here):

- **Leave it stale forever**: cheapest, matches nothing actively — a card opened by an old client, another
  tool, or hand-inspected would show a chat name that may no longer be accurate. `fav` did *not* take this
  path (see below).
- **Actively strip it**: `omitFavField()`/`omitInstallLocalFields()` are exactly this, applied at specific
  write sites — the field is removed the next time the card is written by any route that already goes
  through the omit function, not backfilled proactively across the whole library. `fav` takes this path
  today for `/edit` and `/merge-attributes`, but a card that's never edited again keeps its stale `fav`
  forever too (§0/§1 already establish the db, not the card, is authoritative regardless of what's left
  behind).
- **Deprecate but tolerate**: keep reading a legacy value as a fallback *only* at the moment a row doesn't
  exist yet (mirrors `stampDbFav()`'s explicit "row not yet tracked → leave the card-derived value alone,"
  `characters.js:1526-1528`) — i.e. the card's `chat` field only ever matters again for a character the
  metadata store hasn't seen yet, never for one with a row.

## 4. Does removing `chat` from the card actually get you the reflink benefit?

**Traced directly: not by itself.** `openCharacterChat()` (`script.js:8433-8441`) — the function every
existing-chat-switch goes through (`bookmarks.js:320,465,589,713`, `welcome-screen.js:489`,
`script.js:13562`) — calls `createOrEditCharacter(new CustomEvent('newChat'))` **unconditionally**, every
single time a chat is opened, regardless of what changed. `createOrEditCharacter()`
(`script.js:10478-10650ish`) builds a `FormData` off the *entire* `#form_create` form (name, description,
personality, scenario, first message, system prompt, post-history instructions, creator, tags, world,
alternate greetings — everything) and POSTs it to `/edit`, which calls `writeCharacterData()`
unconditionally. This happens whether or not `chat` is one of the fields in that payload. So even a
version of this design where `chat` is fully removed from the JSON embedded in the card would still incur
a full `writeCharacterData()` → `writeCardToFile()` call, with a fresh rename, on every chat switch —
*unless* the call sites in §2 that only intend to change the active chat (`openCharacterChat()`,
`doNewChat()`, `replaceCurrentChat()`, `updateRemoteChatName()`) are also changed to call something that
does not touch the card at all — exactly the shape `setCharacterFav()`/`POST /api/characters/fav`
(`character-metadata-db.js:794`, `characters.js:1279-1294`) already established for `fav`. Whether that
follow-on change is in scope is the owner's call; it's flagged here because the task's own motivating
problem (reflink preservation) is not solved by the schema/migration piece alone.

**A second, independent finding**: `writeCardToFile()` (`character-card-parser.js:320-370`) already has a
reflink-preserving fast path, shipped separately from this task. It reflink-clones the *image* byte prefix
from the existing file when the metadata tail is the only thing that changed (verified byte-for-byte
before use, per that function's own doc comment), then appends a freshly-written tail and atomically
renames over the destination. Two things follow from this that bound what benefit is achievable even in
the best case:

- The image-data portion of the file already survives a metadata-only edit via reflink, independent of
  whether `chat` is in that metadata or not. This existing optimization is not something the chat-pointer
  migration needs to build — it already exists — but it also means the *headline* reflink-preservation
  problem for the image bytes is arguably already mitigated at the file level, separate from the extent
  sharing with the **original import source** the task's motivating problem describes.
- The metadata tail (`chara`/`ccv3` chunk — the JSON payload) is **always** freshly written and the file
  is **always** renamed, even when `writeCardFromChunks()`'s computed output would be byte-identical to
  what's already on disk (`character-card-parser.js:351-370` has no "skip the write if identical" branch).
  So a resave that changes nothing at all still produces a new inode. Whether that new inode's *image*
  extents still trace back, transitively, to the original import source's extents after several such
  generations is a real btrfs COW-semantics question this investigation did not verify empirically — it
  is plausible (each generation reflinks from the immediately-prior file, which itself reflinked from the
  one before) but confirming it needs an actual multi-generation `btrfs fi du` measurement, not a read of
  this code. Flagged as unverified, not asserted.

**Other "normal use" rewrite triggers, checked and found clear**: besides `chat`, is there anything else
that mutates the card during ordinary (non-explicit-edit) use? `fav` no longer touches the card at all
post-migration (§1). `date_last_chat`/`chat_size` are computed by `calculateChatSize()`
(`character-shallow.js:23-39`) scanning the character's whole chats directory — db-only, never written
into the card. `create_date` is set once at creation/first-hoist (`character-card-normalize.js:29-31`,
`convertToV2()`'s `hoistDate` path) and simply round-trips unchanged on subsequent edits. No other
silent, non-user-initiated card-rewrite trigger turned up in this trace — but this was a targeted trace of
`writeCharacterData()`'s callers and the fields flowing into them, not an exhaustive audit of every route
in `characters.js`.

## 5. Schema shape options and tradeoffs

Three real shapes, laid out without a preference — this is the owner's call:

**Option A — new column on the existing `characters` table** (e.g. `active_chat TEXT`), directly mirroring
`fav`'s shape.
- Matches the `fav` precedent exactly: one row per character already exists, one pointer per character is
  exactly what's needed, `writeRowSync()`'s carry-forward-once logic extends with almost no new code.
- Cheapest write (`UPDATE characters SET active_chat = ? WHERE id = ?`, same shape as `setCharacterFav()`).
- Does not by itself support tracking anything beyond "the one currently-open chat" (e.g. a most-recently-used
  list) — not something anything in this codebase currently needs, but worth naming since it's the one
  thing a column can't grow into without a schema change later.

**Option B — a new table keyed by character id** (e.g. `character_active_chat(character_id PK, chat_name,
updated_at)`), separate from `characters`.
- Same practical capability as Option A for the single-pointer case (a 1:1 table is not meaningfully
  different from a column here), but isolates this specific piece of state from the `characters` table's
  UPSERT/reconcile machinery — a write to the pointer would not need to touch `writeRowSync()`'s
  fav-preservation-style guard logic at all, since it's a wholly separate write path already
  (`setCharacterFav()`-shaped, not `upsertCharacterFromWrite()`-shaped).
- Slightly more schema surface (a table, an index, a migration) for no capability Option A lacks, unless
  the intent is to later extend it to a *history* of opened chats — which nothing in this task or the
  existing codebase currently asks for.

**Option C — no dedicated column/table; ride entirely on `shallow_json`.**
- `shallow_json` (`character-metadata-db.js`'s `characters.shallow_json`) already round-trips arbitrary
  character-shaped data for `/query` responses (`toShallow()`, referenced but not fully traced in this
  pass). Storing the pointer only inside that blob would avoid a schema change entirely.
- Not indexable/queryable on its own (nothing here currently needs to query *by* active chat, but this
  forecloses ever doing so cheaply), and `shallow_json` is explicitly documented elsewhere in this
  codebase as a derived/regenerable projection (`buildRow()`, `character-metadata-db.js:633`) rather than
  a source of truth — storing something authoritative inside a field the rest of the codebase treats as
  derived would be a real deviation from that module's existing invariant, worth flagging even though it's
  not automatically disqualifying.

All three options carry the same §3 migration mechanism and the same §4 caveat (the schema change alone
does not produce the reflink benefit without also touching the `openCharacterChat()`-family call sites).
