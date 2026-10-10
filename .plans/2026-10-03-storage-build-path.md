# storage build path: from staging to `2026-10-03-storage-from-needs.md` (revision 5)

Status: **complete: stages 1–11, the one-off run order (section 6), stages in one line (section 7).** Section 4 keeps the stops and their answers. Planning only, no code changed. Read: CLAUDE.md,
the design (revision 5), `2026-10-03-storage-redesign.md`, `2026-10-03-remove-migrations.md`,
`2026-10-03-backlog.md`. No user data or live DB was opened.

{{user}}: "how do we get absolute minimum latency + absolute minimum disk writes"; "mine pre compaction for the rest of
the task list, then proceed onto architecture fixes".

## 1. engine parts and build-vs-reuse (decided from the design's bounds, 4.3)

The design names three engine parts (4.1, 4.2, 7.2):
- **P1 record log**: append-only blocks, group commit with one shared `fdatasync`, records as edits (text: offset,
  removed length, inserted text; full value once edits reach the value's size), replaced records dropped by cleaning
  blocks under a live fraction u, positions as the value addresses. The log is both the durable record and the value
  store.
- **P2 derived keyspace**: one shared in-memory buffer (B), flushed as one immutable sorted run per B bytes or L log
  bytes, runs merged in tiers of δ, each run's own on-disk index, run footer recording the log position it covers,
  replay of < L bytes after a crash. Memory O(B + C + log N); no per-key filter and no per-file metadata growing with N.
- **P3 search**: postings per (entity, field), term dictionary with edge n-grams, BM25, block-max, deletes as entries;
  all of it entries in P2.

Measured passes are required for reuse; a library is ruled out by the bound it fails, from its own documentation.

| library | shape | bound it fails (design 4.3) |
|---|---|---|
| SQLite | B-tree | write: a page per structure per change (design §0, measured) |
| tantivy | segments + delete bitsets | write: a delete rewrites the segment's whole bitset (design 7.4, measured) |
| RocksDB, Speedb, TerarkDB (and LevelDB, Pebble) | LSM, leveled or universal | memory/read: the SST index is at most two levels ("the index block of an SST file is partitioned into smaller blocks with an additional top-level index on them", RocksDB wiki, Partitioned Index/Filters). A run of unbounded size has a top-level index O(run size); bounded file sizes instead keep per-file metadata in memory, O(N / file size). Either is O(N) memory or an O(N) block read, against O(B + C + log N). LevelDB and Pebble have the same file metadata. |
| RocksDB BlobDB as P1 | values to blob files at flush, GC by age cutoff | write: live blobs in the oldest files are relocated whenever compaction reaches them, whatever their garbage, so a cold live value is rewritten again over time; the design cleans only blocks under u (writes O(changed bytes)). Also not a store of edit records. |
| Badger, fjall / lsm-tree | LSM with value log | memory: per-table index / segment metadata resident, O(N / table size); Badger is Go |
| SplinterDB | size-tiered Bε | its own limitations doc: "Data recovery is not yet implemented", "does not expose an API to force the latest write to be durable", "disk size cannot be changed once configured" (Data safety; space O(live / u)) |
| PerconaFT (TokuDB), WiredTiger | Bε-tree / B-tree with checkpoints | write: checkpoints are time-triggered and write whole dirty nodes, so an isolated change writes a node at the next checkpoint (against "no structure writes a page per change"; derived writes only per B bytes) |
| LMDB, libmdbx, redb, BoltDB, ForestDB | copy-on-write B-tree | write: the changed path's pages per commit |
| Bitcask, HaloDB, FASTER, sled | in-memory key index / page table | memory: O(N) resident |
| Lucene and other segment search engines | as tantivy | as tantivy |

So no existing library meets a part's bounds: **P1, P2 and P3 are ours**. Nothing passed, so nothing needed measuring
as a pass.

## 2. the engine's language and platforms (answered, coordinator, 10-03)

Rust, a native addon via napi, in the Node process; merges on the addon's own threads. {{user}}: "up to you :) ideally
all platforms (including mobile) + all relevant arches". Prebuilt binaries for: linux x64/arm64 (glibc and musl),
macOS x64/arm64, windows x64/arm64, android arm64 (Termux), armv7 where it builds. A wasm build of the same crate is
the fallback wherever no prebuild exists (Node runs wasm), and what the browser's local cache can use. The Rust
toolchain goes in the flake for development; installs never need it. The CI/build setup for the prebuilds is a stage
of its own.


Names (coordinator, 10-03): crate directory `engine/`, crate name `st-engine`; release tag `engine-<first 16 hex of
the source hash>`; git-ignored output directory `engine/dist/`, files named by hash and platform. Further pure naming
choices are picked here and recorded (coordinator: "pick and record them in the plan instead of stopping").

## 3. stages

The engine parts depend on each other in one order: P2's recovery replays P1 from a run footer's log position, P1's
cleaning needs P2's current-value entries to know which records are live and to repoint them, and P3 is entries in
P2. So the crate stages are: build (1), P1 (2), P2 (3), P3 (4). The store cutovers come after them.

Where data lives: each user handle's store stays in that handle's data directory, as `character-metadata.sqlite` and
`message-tree.sqlite` are today (`message-tree-db.js:442`, `directories.root`). The design changes the format, not the
placement. Picked name: `<handle dir>/store/` (log files `log-<first block seq>.blk`, runs `run-<id>.run`).

### stage 1: the crate and its prebuilds

Status: **built** (540c56b80, c3bf2b8ae, ded7604ba). Verified locally: native (linux-x64-gnu) and wasm build, fetch
and load; CI and the other targets are verified once pushed.

Builds:
- `engine/` with the crate `st-engine` (napi-rs), its toolchain pin, and the Rust toolchain in `flake.nix` for
  development.
- CI (a new workflow next to upstream's) computing the source hash (every input that affects the build: sources,
  `Cargo.toml`, `Cargo.lock`, the toolchain pin) and, for a hash with no release, building every target (linux x64 /
  arm64 glibc and musl, macOS x64 / arm64, windows x64 / arm64, android arm64, armv7 where it builds) and the wasm
  fallback, attached to a release tagged `engine-<16 hex>`.
- The fetch (coordinator, 10-03: not a postinstall, since this repo disables npm scripts on purpose with
  `ignore-scripts=true`, and every install path (start.sh, Start.bat, docker, plain `node server.js`, the one-click
  bundle) goes through the server): one module, `engine/fetch.js`, run by the server right before the loader and
  runnable alone (`node engine/fetch.js`). Hash the clone's crate inputs; if `engine/dist/` holds a file for that
  hash and platform (a development build, or an earlier fetch), nothing more and nothing logged; else fetch the
  platform's binary from that release, else its wasm, logging one line; if the hash has no release, fail with one
  message naming the hash and saying to retry once CI has finished. Never an older release's file. It is the one
  thing before listening; a single small download once per crate change, not a pass over data. The Dockerfile runs
  it at image build, so the image ships with the file and never fetches at start.
- The server's loader: loads the file for the clone's hash from `engine/dist/`, native first, else wasm; refuses to
  start with one line if neither is there.
- A crate exporting one trivial function, so the whole path (build, release, fetch, load, both native and wasm) is
  exercised before the engine exists.

Must not block a one-click installer (settled separately): the loader takes its file from `engine/dist/` by hash, so a
bundle that ships `engine/dist/` already filled works with no fetch.

Replaces nothing. Obsoletes nothing in the redesign, migration-removal or backlog lists.

Measured: not against the bounds table (nothing stored). Checked: CI produces a release with every target for a new
hash and none for a commit that doesn't touch the crate; the fetch picks the native file on this machine, the
wasm when told the platform has none, and fails with the message for an unpublished hash; the server loads both.

### stage 2: P1, the record log

Status: **built** (b48e6687c, 8dee04a6c, fe3b6adb1; source key b5c1e354e032a393). Native (linux-x64-gnu) and wasm built and tested locally; the other targets once pushed. Also here:
`engine/fetch.js` removes other source hashes' files from `engine/dist/` once the current one is there.

Answered (coordinator, 10-03): each record kind has a code that fixes a typed tuple, encoded with no per-value type
tags (varints for integers and ids, length-prefixed text and bytes, bits packed); a kind's schema never changes (a
change is a new code). Stage 2 builds the mechanism and the kinds the bounds are measured on: fav, tag assign,
pointer move, fork selection, message append, and a text edit and a full text value (one kind each, the field code a
value in the tuple: a varint, code 0 the escape followed by an extension's key). Ids are integers; mapping the app's
UUIDs to them belongs to the store stages. The rest are engineering choices decided from the bounds:

| choice | picked | reason |
|---|---|---|
| record header | one varint per record: each kind owns 2^(its bits) consecutive header values (fav 2–3, tag assign 4–5, pointer move 6, fork selection 7, message append 8–15, text edit 16, text value 17; 0 is a pad, 1 a trailer); bits and optional-value presence ride in it | a fav or tag assign pays no byte for its bit or for absent optional values |
| ids | zigzag varint of the difference from the previous id of the same space (entity, tag, message, position, user) in the block | a repeat costs 1 byte and the next message id 1 byte; a block-local table helps only repeats |
| time | milliseconds (JS's unit), zigzag delta from the previous time in the block | the first time in a block is the "once per block" full value, the rest small deltas |
| text | WTF-8; edit offsets and lengths in its bytes | JS strings may hold lone surrogates, which upstream's JSON keeps (Data safety); WTF-8 is the smallest lossless form, and the stored bytes are what an edit applies to |
| checksum | CRC-32C, in a 5-byte trailer (marker + 4) ending each sync group: the CRC of the group's start position (file and offset), continued over every item byte since the previous trailer | hardware instruction on x86-64 and arm64 (latency); 32 bits leaves a 2^-32 chance of taking a torn group as whole; a trailer needs no length field, so 5 bytes per sync; seeded with the position so a group checks out only where it was written (one beginning with a pad would otherwise check out from any zero byte in its block) |
| blocks | an item never crosses a block boundary, except a record too large for the rest of the block, which starts at a block start (the next item at the next block start); a pad byte skips to the next block; the decoding context resets at every block start | a record is decoded by reading its block from the start, with no index |
| positions | `(file index << 36) \| offset in the file`, BigInt in JS | the file follows from the position, so nothing per file is resident (the RocksDB row of section 1) |
| files | `log-<first block seq, 16 hex>.blk`; a file takes rounds until it reaches 16 MiB; a group never crosses files; plain appends | opening reads one file (≤ 16 MiB + one round); preallocation didn't lower the sync's device bytes (measured on sdb: append 125 KB, zero-filled file 133 KB, `fallocate` 131 KB per 32 B sync) |
| block size | 4 KiB, provisional (stage 3 retunes it with cleaning) | sync cost doesn't depend on it (134–139 KB per isolated commit at 4, 16, 64 and 256 KiB, two runs each); log bytes barely do (165.1 B per mixed commit at 4 KiB, 164.5 at 256 KiB); a read by position decodes from its block's start (3.8 µs at 4 KiB, 12.6 at 16, 47 at 64, 183 at 256); 4 KiB is also the page a read fetches |
| recovery | at open, read the last file to its last trailer whose checksum holds. If anything follows, look for a whole group (layout and checksum) starting at any later byte: if none, it is a torn last group, cut off (truncate + `fdatasync`); if one exists, it is damage, and opening fails with `Corrupt` (file, damaged byte range, whole groups before it and after it) and changes nothing | answered (coordinator, 10-03, Data safety): each round syncs before the next starts, so only the last group can be torn and it was never acknowledged; cutting at a damaged middle group would silently drop acknowledged groups on filesystems without data checksums (ext4, NTFS). Later files can't exist: a file is created only after the round before it synced |
| writer | one Rust thread; a round takes every queued commit, appends their bytes with one write per contiguous run, `fdatasync`s once, then resolves each commit's promise; a commit's records are always in one group | design 3; no timer |
| JS API | `RecordLog.open(dir)`, `append(records) → Promise<bigint[]>` (one commit), `read(position)`, `iterate(from, limit) → { records, next }`, `durableEnd()`, `stats()`, `close()`; open, read and iterate run on the libuv pool | the event loop never waits on a disk read; a record is `{ kind, ...values }`, and a value of the wrong type, a missing one or one the kind doesn't have is refused, not dropped |
| new files | the directory is `fsync`ed after creating one (not on Windows, as SQLite: NTFS journals the entry) | a file's entry must survive a crash before its first group counts |
| wasm | the writer thread opens the tail file itself; reads open the file per call (no shared handles) | under WASI threads a file descriptor belongs to the thread that opened it |

Left for stage 3: opening lists the log directory to find the last file (O(files)). Stage 3 replaces it by probing
upward from the newest run's covered position: files after it hold < L bytes, and cleaning can't have touched them
(liveness comes from P2). Done in stage 3.

Measured (on sdb, the data directory's btrfs, in a temp directory outside the repo; `/proc/diskstats` deltas minus
an idle window, as `needs/fsyncappend.mjs`; harnesses in the scratchpad's `stage2/`):
- isolated durable commit through the binding: fav 124.6 KB and 0.93 ms; 600 B message 154.6–155.5 KB and
  1.0–1.3 ms. A raw append + `fdatasync` of the same size on the same disk: 125 KB (32 B), 155.2–155.8 KB (626 B).
  So one sync plus the record, at the floor;
- concurrent commits through the binding, `strace -f -c`: `fdatasync` calls = sync rounds in every run (100 rounds for
  100 commits issued one at a time; 200 for 800 issued 8 at a time; 201 for 6,400 at 64; 434 for 51,200 at 512); each
  commit's promise resolves after its round's sync (tested: every resolved position is below the durable end and
  reads back);
- record bytes (34-bit ids, the size at 10^10 entities; the first record in a block / one following a similar one):
  fav 6 / 2 B (bound ~5–6), tag assign 8 / 4 B (~10), one-word edit 16 / 12 B (~20–40), 600 B message 628 / 613 B
  (~620). Plus 5 B of trailer per sync;
- torn tails: a log of 20 commits with records spanning 256 B blocks, truncated at every byte and reopened, holds
  exactly the commits whose groups end at or before the cut, and the file is cut there (Rust test); a corrupted last
  group is dropped; native and wasm write identical bytes and both cut a torn tail;
- damage: the same log with each byte before its last group flipped in turn either refuses to open with `Corrupt`
  naming exactly the damaged group, the groups before it and the whole groups after it, the file byte-identical
  afterwards, or (a byte in a block's unused tail, covered by no item) opens with every record intact (Rust test;
  native and wasm refuse the same way through the binding).

Builds (in the crate; not wired to any store yet):
- Log files of fixed-size blocks; records appended in commit order. A record is (id, field, change): ids delta-coded
  within a block or by a block-local table; field a small code with an escape for an extension's own key; change a
  bit, a number, a text edit (offset, removed length, inserted text), a full value, or bytes; seq implicit (the
  record's position); time once per block plus a small delta where a record carries one (design 4.1).
- Group commit (design 3): one writer; every commit that arrives while a sync runs joins the next; a sync starts as
  soon as the previous one ends; no timer. A commit's promise resolves only after its sync. Writes append the block's
  new bytes; nothing already synced is rewritten.
- Each sync group carries a checksum. On open, a tail whose checksum doesn't hold (a torn write) is dropped: it was
  never acknowledged, so nothing acknowledged is lost (Data safety).
- Read a record by position; iterate records from a position (the change feed and P2's replay use it).
- Block size: a constant, set by measurement (the device bytes per sync and per cleaning rewrite), like u.

Not here: cleaning (stage 3: liveness is P2's current-value entries), and the text rule "a full value once the edits
since the last one reach the value's size" (needs the current value's size, so it runs where commits are made, from
stage 3 on).

Replaces nothing yet. Obsoletes nothing yet.

Measured against the bounds table, row "per action, durable" (O(changed bytes) + O(1) syncs), on the data directory's
filesystem with the design's harness (`needs/fsyncappend.mjs`, `/proc/diskstats` deltas minus an idle window):
- device bytes and time per isolated durable commit: at the sync floor of design §0 (131–141 KB, 2.6 ms for a 32 B
  append), i.e. no more than one sync plus the record;
- k concurrent commits: `fdatasync` count (`strace -c`) equals the number of sync rounds, not k; each commit resolves
  after the sync that holds it;
- record bytes for the design §6 cases: fav ~5–6 B, tag assign ~10 B, a one-word edit ~20–40 B, a 600 B message
  ~620 B;
- torn tails: every truncation point of a written log reopens to exactly the groups whose checksums hold.

### stage 3: P2, the derived keyspace

Status: **built** (105c8e858, a7e84d1d5, 52b6f5c04, 08b3b72fe, 1b6011709, 7a8fd64e6, 108ac011f, ba5083476,
6f68c036c, fc55e3d63, bc65180bf, 97fbc0410). Native (linux-x64-gnu) and wasm built and tested locally. The record kinds' real derivers come with
the store stages; stage 3 has current values for fav, textValue and textEdit (with versions and the text full-value
rule) and a test kind, `testSet`, behind the `measure` feature. Choices and measurements below the original scope.

Builds (in the crate): the shared in-memory buffer sorted by (structure, key); flush to one immutable run when the
buffer reaches B bytes or the log passes L bytes since the last flush, synced once, its footer holding the log
position it covers; each run's own multi-level index on disk, only its top block resident; tiered merges of δ runs on
the crate's own threads; point and range reads merging buffer and runs; block cache of C bytes; cleaning of log blocks
under live fraction u, repointing current-value entries; recovery: after listen, replay the records past the newest
run's covered position into the buffer, every request that reads derived data or commits waiting until it's done
(design 4.2 step 5).

Derivation (answered, coordinator, 10-03): **Rust, inside `st-engine`; JavaScript sends records only.** Commit and
replay then derive the same entries from one implementation (Data safety), replay needs no calls into JS around boot,
no entry crosses the napi boundary on the commit path, and the browser's wasm build gets the same derivation. Schema
changes need Rust (accepted). JS keeps the app logic above records: building the record for an action, compat
shapes, routes.

So stage 3 also builds the derivation framework: one deriver per record kind, run at commit (in memory, with the
point lookups of old values it needs, design 4.2 step 1) and at replay by the same code. Stage 3 has only test record
kinds; each store stage adds its own kinds and derivers. Also here: an entity's version (the seq of its latest
record, design 5 "hash check") and the change feed (records from a seq, sent after their sync).

Replaces nothing yet. Obsoletes nothing yet.

Measured against the bounds table rows "per action, derived", "read: a point value", "read: a sorted page", "space",
"memory" and "crash recovery", on synthetic test records at 10^6, 10^7 and 10^8 entries (growth is what is checked,
so three sizes a decade apart):
- entry bytes written per entry over its life (flush plus merges) against entry size × log_δ N; per-commit work in
  memory against O(log B); one sync per flush, none per commit;
- blocks read per point lookup (counted in the crate) growing as O(log N); a page of P entries as O(log N + P);
- resident memory flat across the three sizes (B + C + one top index block per run);
- space against live records / u + entries; cleaning writes per byte freed against u / (1 − u);
- recovery: kill -9 at random points under load, then reopen: the replay reads less than L bytes of log at every
  size, and every commit acknowledged before the kill is visible in derived reads afterwards;
- B, L, δ, u, C and the block size are set here from these measurements (design Q-D4, Q-D6: tuning constants).

Engineering choices (decided from the bounds; each picked and recorded):

| choice | picked | reason |
|---|---|---|
| layout | log files stay in the store directory; runs in `runs/`, `run-<first flush>-<last flush>.run` (16 hex each) | opening lists only `runs/` (O(runs)); a run's name says which flushes it holds, so a merge's leftover inputs are recognised without reading them |
| run file | prefix-compressed blocks with a full key every 16 entries, CRC-32C per block; index blocks written as they fill, one builder per level; 64-byte footer (top block, levels, entries, covered position, flushes, CRC) | writing a run of any size holds one block per level; only the top block is read at open and kept (memory bound) |
| run durability | written as `.tmp`, synced, renamed, directory synced; merge inputs removed after the output is in place | a `.run` is always whole; on open `.tmp` is removed (nothing counted on it), a run whose flushes another holds is removed (a crash between install and removal), a gap in the flushes or a damaged footer refuses to open (Data safety) |
| entry values | put, delete, or add to a counter | counts and dead bytes change without a read at commit |
| buffer | keys and values in chunks the buffer owns (4 KiB growing to 1 MiB), freed whole with it; a sorted map of fixed-size references, counted at 72 bytes per entry plus the chunks (bc65180bf, coordinator 10-04) | measured: 85 bytes per entry of 12 (was 136 with a map of owned keys and values), so a flush holds 1.6× as much (36 flushes at 10^7 instead of 58); B is real memory |
| frozen buffers | at most 1 per store waits for its flush | |
| memory pool (fc55e3d63, coordinator 10-04) | one `Pool` per process for every store: B is the budget of all active buffers together (once reached, the store with the largest buffer freezes it at its last published log end); a store prepares and publishes only while active + frozen hold less than 2B (else the largest buffer is frozen and it waits); one block cache C; flushes and merges take one of 2 slots each; L stays per store (it bounds that store's replay) | memory is bounded for the process, not per user handle (CLAUDE.md Multi-user) |
| engine threads (bc65180bf, coordinator 10-04) | 10 threads per process in the pool; a store owns none. Its work is activities (prepare, sync, clean per store; flush, merge per keyspace), each one bounded step per task, requeued behind others when it has more; no step waits on another (backpressure parks the activity and kicks it later) | per-thread costs (stacks, glibc arenas) no longer scale with stores; 6 threads cost 16-store throughput (79 s against 59) |
| allocator (97fbc0410, {{user}} via coordinator 10-04) | mimalloc as the crate's global allocator on native builds; wasm keeps its default; Node's memory untouched | glibc kept each engine thread's arena at its peak (one store at 10^7: 699 MB held, 156 MB used); with mimalloc 245 MB. Its C compiles and links with zig for every linux target (glibc 2.17 and musl, armv7 with -latomic), macOS and windows x64 / arm64 (gnu ABI); MSVC and the Android NDK weren't available locally (mimalloc's source has their paths) and are built by CI |
| fairness | two lanes: an activity whose last step took under 5 ms (a lone commit's prepare or sync, a sync on a slow disk) queues ahead of long steps (large commits, flushes, merges); 2 of the 10 threads take only that lane | a store committing now and then isn't stuck behind busy stores' long steps (measured below) |
| tiers | a run's tier is log_δ of its size in full flushes (the last one measured), rounded | δ flushes merged are the next tier even after the merge drops entries (B/8 left them a tier low and merged them twice) |
| merges | 2 threads; δ adjacent runs of one tier, lowest tier first; deletions dropped only when the oldest run is an input | concurrency with flushes; newest-wins needs adjacency |
| block cache | LRU of run blocks by bytes; merges bypass it; log reads use the OS cache | a merge reading GBs would evict every index block |
| commit path | a prepare thread (derive, lay out) and a sync thread (write, sync, publish, resolve) | derivation of one group overlaps the previous sync; an entry is readable only once its record is durable; a refused commit writes nothing |
| derivers | Rust, one per kind: `prepare` (commit only, may refuse or rewrite), `derive`, `is_live`, `repoint`, all seeing the state just before the record | commit and replay give the same entries; kinds without a deriver yet are kept by cleaning |
| text | current value = head (last full value, size, edit count and bytes) + one entry per edit; an edit becomes the full value once the edits since would reach its size; an edit outside the value or inside a character is refused | design 4.1; WTF-8 offsets checked against the stored bytes |
| version | (entity) → position of its latest record, for fav and text kinds; not changed by cleaning | design 5 hash check; a copy is not a change |
| cleaning unit | a whole log file (16 MiB), cleaned when a flush finds its dead bytes past (1 − u) of it | deleting a file frees space on every platform; punching holes in place has no portable form (none under wasm); u/(1 − u) and 1/u hold per unit, so the bounds are the same |
| relocation | live records copied through the commit path, each after an internal `moved` record (`from`, a log-position id); the file is removed once the runs cover past the copies | replay repoints instead of re-deriving; no replay meets a pointer into a removed file; liveness is decided under the commit order, so a racing commit can't lose a record |
| change feed | `feed(from, limit)`: durable records, copies left out; a removed file is `Gone` | a reader that far behind reloads |
| opening | runs, then the log probed upward from the newest run's file; no runs → the directory is listed, and a log not starting at file 0 refuses (its runs are missing) | O(runs) + the tail file; never O(log files) |
| recovery wait | the prepare thread replays before taking commits; reads of derived data are parked and run after it (not blocking libuv threads) | design 4.2 step 5 |
| wasm strings | a text with lone surrogates is built from pieces | emnapi decodes > 16 code units with TextDecoder, which replaced them with U+FFFD (a stage 2 bug, fixed in 105c8e858) |
| binding | `RecordLog` replaced by `Store`: open, ready, commit, read, feed, fav, text, version, durableEnd, stats, close | nothing used RecordLog yet |

Measured (`engine/examples/measure.rs`, release build, on the NVMe in the scratchpad: the measures are counts in the
crate and memory, not device bytes, so the data disk wasn't needed; 10^8 took about an hour and 3.8 GB, removed after).
Workload: N entries = N/2 ids of `testSet` (current value + order entry each) loaded, then every id updated once at
random (half the log dies, cleaning runs), 8 commits of 1000 records in flight. Constants as picked below.

| | 10^6 | 10^7 | 10^8 | bound |
|---|---|---|---|---|
| run bytes written per entry inserted (flush + merges) | 12.7 B | 28.2 B | 51.4 B | entry (~11 B) × log_δ N: grows ~1.7 entries per decade, log_4 10 = 1.66 |
| commit work per record, load / update (derive + lookups, µs) | 2.6 / 11.0 | 4.6 / 21.3 | 7.1 / 36.3 | O(log N) lookups (old values read at commit) |
| syncs | one per flush (7 / 58 / 582) and merge; none per commit beyond the log's | | | |
| blocks per point lookup after updates (fetched / from file) | 1.1 / 0.0 | 4.9 / 0.14 | 7.0 / 1.8 | O(log N): ≈ 1 per run, runs (δ − 1) per tier |
| blocks per page of 100 (fetched / from file) | 3.1 / 0.3 | 9.2 / 2.7 | 6.2 / 3.0 | O(log N + P) |
| point / page time (µs) | 1.1 / 20 | 4.9 / 39 | 11.5 / 32 | |
| peak memory | 123 MB | 234 MB | 247 MB | flat once B and C fill (10^6 never fills them); top blocks 9–24 KB |
| log on disk / live record bytes | 1.12 | 1.31 | 1.32 | ≤ 1/u = 2 |
| cleaning bytes moved per byte freed | 0.53 | 0.48 | 0.48 | ≤ u/(1 − u) = 1 |
| runs on disk | 23 MB | 265 MB | 2.5 GB | O(entries); ~2.3× the live entries' bytes: older versions wait in older tiers until merged (tiering's write saving) |
| open after a clean close | 33 ms | 12 ms | 0.7 ms | footers + top blocks; replay 0 |
| kill -9 under load, 6 rounds each | all acknowledged commits read back (0.1–0.4 M ids checked per round) | same | same | |
| replay after kill: log bytes / time | ≤ 3.2 MB / ≤ 1.2 s | ≤ 3.2 MB / ≤ 2.3 s | ≤ 2.8 MB / ≤ 3.4 s | < L; bounded by the ≤ 2 buffers unflushed at the kill |

Constants (`engine/src/store/mod.rs`), from a sweep at 10^7 (one setting changed at a time; scratchpad `m/sweep/`):
- **δ = 4**: run bytes per entry inserted 55.9 / 28.2 / 20.2 / 18.4 B at δ = 2 / 4 / 8 / 16; blocks per page after
  updates 4.3 / 10.6 / 14.7 / 22.7. Past 4 writes fall little while reads climb; 2 doubles writes.
- **u = 0.5**: at 0.25 nothing was cleaned (space 1.97× live); at 0.75 0.70 bytes moved per byte freed for 1.20×
  space. 0.5 bounds both at 1 byte moved per byte freed and 2× space; measured 0.48 and 1.31.
- **B = 64 MiB** of memory: 16 MiB writes 39.5 B per entry (73 merges against 17), 256 MiB 23.7 B but 434 MB peak
  against 240.
- **C = 64 MiB**: point lookups read 1.74 / 0.40 / 0 blocks from files at 16 / 64 / 256 MiB, for 140 / 240 / 397 MB
  peak; 64 MiB holds every index block up to ~10^8 entries.
- **run block 16 KiB** (was 4): file reads per point lookup 0.40 → 0.14, per page 4.5 → 2.7, same time from the page
  cache; fewer reads when cold.
- **log block 4 KiB** kept: 16 KiB slowed an update's old-record read from 21.8 to 37.6 µs; cleaning is per file.
- **L = 64 MiB**: replay is bounded first by the buffers (≤ 3.2 MB of these small records, ≤ 3.4 s); L binds for
  large records (64 MiB ≈ 100k 600-byte messages, a similar time).

Found while measuring (all fixed): the tier unit mismatch above; a commit or relocation that wrote nothing resolved
before the groups ahead of it (7a8fd64e6); cleaning a file read on into the next and failed forever once that one was
removed (108ac011f, seen only at 10^8, where files are cleaned out of order).

Several stores (`measure multi`, one submitting thread as the server's JavaScript, a probe store committing one
record every 5 ms beside them), with mimalloc:
- the same total load (16·10^6 entries, 8 commits in flight) over 1 / 4 / 16 stores: peak 250 / 249 / 271 MB; probe
  commit latency p50 2.6–3.4 ms, p99 4.9–8.3 ms. Memory doesn't grow with the number of stores;
- every store flat out (2·10^6 entries each, 8 commits in flight each), 1 / 4 / 16 stores: 16.2 / 23.0 / 49.1 s
  (16.4 / 20.7 / 63.7 s with a store's own threads); peak 219 / 267 / 325 MB, growing with the work in flight, not
  the stores; probe p50 2.6 / 2.6 / 3.2 ms, p99 4.8 / 6.4 / 41 ms (one lane: 17.9 / 68 ms at 16);
- per store as for one store of that size. One store at 10^7: 28.1 B written per entry, 3.4 blocks per point
  lookup, 6.1 per page, 0.48 bytes moved per byte freed, log 1.31× live, peak 245 MB.

Left: replay derives ~10 µs per record on one thread, so a crash costs up to a few seconds of waiting.

### stage 4: P3, search

Status: **built** (71a13ad71, 80a609e4c, efa162953, be66c4996, 653079f53, 252d0a344; compression 1ee526cd4,
c9f7b4d0e; best first 9e80e4f81, 142f9f9ef, 5897fa9de, 72320bbaf, dd4adede1; one list per string a55123107; bulk loads
b61a67c17, a062db76b; id-ordered postings with block maxima and top lists d80e03d30, a96badf40; tag matches beside
the page, top lists per entry in slices, multi-word walk, 10-10). Open: multi-word medians 10–20 ms at 10^6 against
single-digit, accepted ("hard case is hard"; no length codes; see "Tags, top lists, multi-word, 10-10"); closed-quote
phrases, optional pair postings and the crate swaps not started. Native (linux-x64-gnu) and wasm
built and tested locally. Card and tag-name field codes come with 5a; until then only test and measurement builds
index library fields (`kinds::test_codes`); chat postings (`messageAppend`) and tag membership (`tagAssign`) are live.

Answered (coordinator, 10-04): measured on two generators, neither reading the user's data:
`walrepro/seedpng.mjs` ported exactly (its 2000 cards are the old index's 3.68 MB) for the space comparison, and
`scripts/bench-search-synth.mjs`'s text generator (30,000-word Zipf vocabulary, its word list at the kept report's
live shares, fixed numbers for its live samples) for latency and the scan check; `bench-search-synth.mjs` itself
stays broken until stage 5 rewires it. Behaviour ({{user}}'s "maximally intuitive", via the coordinator): an
unquoted word the tokenizer splits (`foo-bar`, `o'neil`, `{{char}}`) is a phrase; a quoted phrase ending the query
has its last word a prefix, as today.

Builds (in the crate, on stage 3):
- postings per (entity, field) with term frequency; per-field lengths, document frequencies and average lengths for
  BM25; a sorted term dictionary; edge n-grams (2–20) in the prefix fields (name, creator, tags); no positions;
  deletes as entries; block-max scoring;
- a tokenizer folding case and accents, otherwise with the token boundaries of today's index (tantivy's default
  tokenizer);
- queries: AND of words, the last word a prefix, `label:value`, `-label:value`, quoted phrases (rarest word first,
  the phrase checked in the candidates' text); ranked by BM25 with the design's field weights (7.1) or ordered by a
  sort key from the current values; totals exact under the work cap, marked past it; a cursor for "more";
- tag names indexed once and joined through membership (design 7.3); chat text postings per owner, entity = message
  (S5).
The query parser stays JavaScript (`src/endpoints/search-query.js`) and hands the engine the parsed query.

Replaces nothing yet (tantivy goes at the stage that wires search). Obsoletes nothing yet.

Measured against design 7.5's rows, on the synthetic library (`scripts/bench-search-synth.mjs`, 2000 cards, and the
same generator at 10^5 and 10^6):
- entries written per card field edit = that field's changed terms; no index entries for fav, tag assign or chat
  activity; a tag rename O(1) entries;
- query latency per word count against today's medians (9–57 ms, search-performance plan), with dictionary and
  postings reads growing as O(log N);
- space without positions against today's index on the same cards (3.68 MB for 2000);
- results equal to a brute-force scan of the same cards for a fixed query set (exact under the cap).

Engineering choices (decided from the bounds; each picked and recorded):

| choice | picked | reason |
|---|---|---|
| unit | entries in the derived keyspace: (term kind, term, doc, field) → tf; (term, field) → df counter; (doc, field) → length; per block of 1024 ids, (term, field) → max tf and (field) → shortest length; per scope documents, token totals and the highest id | a field edit writes its changed terms' postings and counters and nothing per unchanged term |
| writes read nothing per term | the entries follow from the field's text before and after (the old text is the current value at commit; a list field passes all its values); counters are adds, bounds are blind maxima (`Val::Max`, new in the keyspace) | a read per term at commit costs O(log N) blocks each; an import of 10^6 cards writes ~2·10^9 entries |
| totals | counted while enumerating, up to the work limit; past it an estimate from the share of ids covered | an exact document count per word (design 7.3, "one word = its df") needs to know at commit whether the document holds the term in another field: a read per changed term; and the last word is a prefix in some fields and exact in others, so no one counter answers it |
| tokenizer | runs of `char::is_alphanumeric` (tantivy's `SimpleTokenizer`), each folded as `includesIgnoreCaseAndAccents` (NFD, U+0300–036F dropped, lowercased per character); no length limit | the plan's "folding, otherwise today's boundaries"; tantivy's 40-byte drop is a filter, not a boundary |
| prefix | prefix terms of 2–20 characters in name, creator, tags and tag names; a longer prefix uses its first 20 and is checked on the text; a 1-character last word is exact | Q-F1 |
| phrases | candidates from the exact tokens' postings (each field where all of them are), checked on the field's values; the prefix token contributes no postings | no positions (O-4); a value's text is read through `search_texts` |
| scoring | tantivy's BM25 (k1 1.2, b 0.75), per field idf and average length over the scope's documents, weighted by upstream's Fuse weights, summed over parts in field then token order; tag names don't score cards (answered beside the page, 10-10) | a per-entity resolved-tags length would make a tag rename write every carrier |
| ranking past the limit | blocks in order of their bound (max tf, shortest length) while one can beat the page; documents under the page's last score are skipped before any text is read | block-max (design 7.3); 1024-id blocks: 128 kept 2.5× more bound entries (36 M against 15 M at 10^5 synth) for no better pages |
| work limits | a scan's start 96 entries, a text 128 + bytes / 32; enumeration 120k, ranked 120k, sort walk 120k, tag joins 80k together | measured at 10^6: 13 µs a scan, 0.16 µs an entry, 37 µs a text; ~55 ms worst on the query set |
| sort keys | a `SortKey` the owning structure supplies (5a): matches sorted by their keys when at most √(P·N) of them, else the order walked checking each document | design 7.3 |
| membership | `tagAssign` keeps (tag, entity) → its record, (entity, tag) and a count per tag | the join and the tag filters read it; 5a adds orders and random spaces to the same deriver |
| binding | `Store.search({ scope, clauses, filters?, limit, after? })`, relevance order; clauses as `search-query.js` yields them; sort keys are bound at 5d | |

Measured (`engine/examples/search.rs`, release, NVMe scratchpad, stores removed after; check = the same queries by a
two-pass scan of every card; 21 queries of 1–3 words, phrases, labels, a negation, a tag filter):
- results: every page and total the engine marks exact equals the scan, at 2000, 10^5 and 10^6 synth and 2000 and
  10^5 seedpng (10^6 synth checked with the earlier, larger limits; the final limits were timed on a store of the
  same library);
- writes per one-word field edit: 7–8 entries, 130–151 B (2 changed terms: posting and df each, a bound for the new
  one, the text's head, edit and version), the same at every size; fav 2, tag assign 2–3, a message 24 (its owner's
  chat postings only); a tag rename 49 entries with 442 / 82k / 820k carriers;
- space: seedpng 2000 cards **2.44 MB** of runs against today's 3.68 MB on the same cards (postings 263k entries);
  synth 2000 32 MB, 10^5 0.94 GB, 10^6 9.3 GB of runs for 18 MB / 0.92 GB / 9.2 GB of text (postings 2.6 M / 98 M /
  973 M entries, bounds 0.5 M / 15 M / 147 M). Generic prefix-compressed keys cost ~9 B a posting on disk, against
  tantivy's bit-packed ~1 B without positions;
- load: run bytes written per inserted byte 0.36–1.25 (flush plus merges); 10^6 synth took 40 min (~1 µs an entry
  through the commit path's sorted maps, stage 3's), memory peak 524 MB;
- latency (median of 7, warm):

| | 2000 synth | 10^5 synth | 10^6 synth | today (~380k cards) |
|---|---|---|---|---|
| rare word (detective, saxophone, quokka) | 0.1–0.2 ms | 0.3–6 ms | 1.7–18 ms | 9–57 ms medians, every match scored |
| common word (girl, the, love) | 2–3 ms | 26–29 ms, total `~`, page marked | 40–57 ms, total `~`, page marked | |
| prefix (dr, dra) | 0.3–1.5 ms | 3–7 ms | 28–38 ms | |
| 2–3 words | 0.4–3 ms | 14–30 ms | 41–55 ms | |
| phrase (quoted, ending the query) | 31 ms | 35–38 ms, marked | 50–52 ms, marked | |
| label, negation, tag filter | 0.1–2.6 ms | 2–27 ms | 16–55 ms | |

Found while measuring: a phrase ending the query takes its prefix token in every field, so its candidates are every
field holding its other tokens, each checked on its text (~37 µs): `"dark knight"` reads ~1,000–2,000 texts and
stops at the limit from 2000 cards up, total marked. Common single words past the limit get exact pages from the
bounds at 10^5 only when a few fields carry them (`dragon`, `vampire`); at 10^6 most capped pages are marked.

Compressed (coordinator, 10-04: postings within ~2× of tantivy's, runs well below the text): a term's postings are
one entry per block of 1024 ids, a map (`Val::Map`, new in the keyspace: (slot, value) pairs written blind, varints
or 128-pair bit-packed chunks, whichever is smaller) of document place and field → tf; lengths a map per field per
block and one per 64 ids over all fields; per-block bounds read off the postings blocks (the bound entries are gone).
Measured: seedpng 2000 cards 0.84 MB of runs (postings 413 KB against tantivy's 212 KB `.idx`, 2.0×); synth runs
12 MB / 0.22 GB / 2.1 GB at 2000 / 10^5 / 10^6 cards (0.06 / 0.24 / 0.23 of the text; were 32 MB / 0.94 GB / 9.3 GB);
a one-word edit 6–7 entries, ~120 B; 10^6 load 34 min (was 40), 4 runs. Latency at 10^6 (exact results all equal the
scan): rare words 3.5–15 ms, prefix 11–20 ms, common words 22–67 ms (capped: total `~`, page marked), 2–3 words
24–42 ms, phrases 40–48 ms marked.

Best first (coordinator, 10-04: option A; {{user}}: "relevance ideally", "shouldnt common words be near 0
computation", "who said we always need exact totals"; 9e80e4f81, 142f9f9ef, 5897fa9de, 72320bbaf):
- the rare-word overhead was scoring: each matching document's field length read through a point read of its
  field's 1024-document length block (~43 µs: the block map decoded per run, folded, re-encoded and decoded again;
  100 such reads were 4.3 of `quokka`'s 4.4 ms at 10^6), plus run blocks decoding every value a seek stepped over
  (one-entry scan 14.5 → 4.5 µs once values decode only when read, 9e80e4f81);
- a term's posting per document holds every field's tf and length code (a byte, tantivy's field-norm steps), filed
  by group (has a prefix field / not), score class (BM25 at reference idf and average length per field, 64
  classes 12% apart) and block of 16,384 ids; a directory per term (id order → rank) and a document counter per
  term; body tokens of 2–20 characters also under the prefix terms (one list for the last word). Field weights:
  upstream's Fuse keys (name 20, tags 10, description/example 3, scenario/personality/first message/notes 2,
  creator/card tags/alternate greetings 1), as the old index's BM25 boosts: a name match outranks body matches;
- one word: groups read best first until no later class (nor an unseen member of a matching tag) beats the page;
  matching tags' members listed up to 8,192 carriers, looked up when cheaper than reading on; several words: the
  directories in id order, skipping documents and blocks whose bounds can't beat the page; sort keys: a word with
  more than √(page · documents) documents walks the order, fewer are read and sorted; totals from the term's
  counter where they apply, else counted or estimated (`~`); statistics cached per store until a publish;
- measured (synth): 10^6 cards — rare words 83–290 µs (were 3.5–15 ms), `love`/`dragon` 4–4.4 ms, words matching a
  tag carried by 8–48% of cards (`girl`, `the`, `dr`) ~5 ms with pages marked, 2–3 words 23–73 ms (were 24–42),
  phrases 37–42 ms; 10^5: rare words 42–364 µs, common 0.3–2 ms (`the` 8 ms); runs 9.2 GB at 10^6 (were 2.1),
  0.99 GB at 10^5 (0.22); load 93 min at 10^6 (was 34); a one-word edit 15 entries, ~320 B (was 7, ~130). Every
  page and total marked exact equals the scan at every size.

- member blocks (dd4adede1): a tag's carriers also as a map per 16,384 ids, so a word matching a widely carried tag
  checks its candidates with one block read per range instead of a get each, and lists up to 65,536 carriers from
  the blocks. 10^5: `girl` 1.9 → 0.34 ms, `the` 17 → 6.9 ms, `love` 0.46 → 0.27, `dragon` 0.34 → 0.09,
  `girl -tag:vampire` 4.6 → 1.0, `the [tag love]` 10 → 16 ms (now exact page); runs +6 MB; every page and total
  marked exact equals the scan.

Phrase evaluation (coordinator, 10-04; measured and reported, awaiting {{user}}'s choice; pair postings and pair
filters exist in measurement builds only, `phrase_mode`). Synth, warm, work cap 250k; (end) = the phrase ends the
query, its last word a prefix; (inside) = more words follow. Option 1 none, 2 pair postings (exact pair counters),
3 a 3-probe 8-bit-per-pair filter per field checked before the text.

| | option 1 | option 2 | option 3 |
|---|---|---|---|
| index entry bytes added, 2000 / 10^5 / 10^6 | 0 | 155 MB / 5.8 GB / 50 GB (runs 9.2 → 35 GB at 10^6) | 4.6 MB / 0.20 GB / 2.0 GB |
| a one-word field edit | 15 entries, 314 B | 31 entries, 750 B | 16 entries, 837 B (the field's whole filter) |
| (a) common phrase, 10^6 (end / inside) | 41 / 29 ms, total -2% | 41 / 74 ms, total +0.02% | 41 / 23 ms, total -2% |
| (b) `dark knight`, 10^6 (17 matches) | 30 / 29 ms, 0 and 32~ found | 31 / **1.2 ms exact** | 30 / 24 ms, 0 and 22~ |
| (b) `the dragon`, 10^6 (173) | 30 / 29 ms, 0 and 105~ | 30 / **13 ms exact** | 30 / 24 ms, 0 and 119~ |
| (c) rare phrase, 10^6 (6,534) | 32 / 29 ms, +4% | 32 / 11 ms, +5% | 32 / 24 ms, +8% |
| p99 | within 15% of the median everywhere | | |

At 10^5 the same shape (option 2 inside: 0.2 / 2.5 / 14 ms exact; everything else 17–37 ms, capped); at 2000 every
option is exact for rare phrases (0.03–2 ms) and capped for the common one. Every (end) row is the same in all three:
the prefix last word has no pair data, so each candidate's text is checked until the cap. Text check: 37 µs was the
log read plus tokenizing the whole value into a list; the check now streams tokens and stops at the match (~6 µs, 7.7
collecting); the read is 9 µs at 2000, 19 µs at 10^5 and 194 µs at 10^6 (the 9.3 GB log no longer in page cache), so
at scale the check is the read.

Bulk loads (coordinator, 10-05: {{user}} ">5min is unacceptable"; b61a67c17, fix a062db76b): `Store::loader()`, records
laid out in log files staged in `load/` (numbered after the tail file; commits stay in it meanwhile), derived on a
thread per core but two, each partition's records in order on one worker (`Deriver::partition`: what a record reads
and the non-commutative entries it writes are its partition's), finished partitions combined by key in a sink and
spilled sorted, spills merged in parallel key ranges and the parts' blocks joined into one run; installing holds
commits briefly (buffer flushed, files moved with an install marker, run put in place newest). Crash before the move:
store as before; after: replay derives what the run didn't hold. A commit in a partition the load holds refuses it;
`textEdit` isn't loaded (its commit changes the record). Picked: buffers 1 GiB together (resident peak ~2 GB at 10^6),
partitions to workers in units of 64 ids. 10^6 synth: 183 s (commit path 93 min); split: caller thread 143 s (the
generator ~90 s of it, layout and staged writes the rest), derivation 1,491 s and spilling 336 s of CPU over 22
workers, merge 38 s, install 0.08 s; bound by the caller thread. 10^5: 18 s (282 s), the same derived entries.

Postings, 10-05 (coordinator: best first as the only copy cost 4.4x space; replace with id-ordered postings,
block-max WAND, top lists; d80e03d30, a96badf40): per term one compressed map per 1024 ids, place and
field → counts (prefix fields: whole token and prefix term); per block and field the highest count and the shortest
length as blind maxima (`Val::MaxMap`, new); top lists of 128 for terms with more documents, each entry with its
counts and length codes, scored at the list's own weights times idf and averages (rebuilt past 10% drift), a floor
(score, id) everything else ranks under; writes follow a document in and out of the lists of its changed terms (all
the field's terms when its length code changed); queries build missing lists, kept when nothing was committed
meanwhile; bulk loads mark them stale. Measured, 10^6 synth (bulk-loaded; target / best first):
- runs 2.46 GB (~2.1 / 9.2); one-word edit 9.4 entries, 178 B (~130 + list check / 320); load 183 s (≤ 300 / 93 min);
- one word or prefix, first page: `saxophone` 0.03 ms, `detective` 0.05, `quokka` 0.36 (90 documents, lengths read),
  `dra` 3.4, `vampire` 4.0, `dr` 5.2, `dragon` 7.0, `the` 88 (target ~0.1; best first 0.08–0.29 rare, ~4–5 common);
  `girl` 0.80 s and `love` 0.67 s: their tag-name matches put members outside the list on the page, so the walk
  answers;
- several words: 63–550 ms (`dark knight` 73, `the girl` 549 page cut) (target single-digit ms; best first 23–73);
- every page and total marked exact equals the scan.
Open: ranking a word whose tag names match widely carried tags (tag scores in the lists, maintained on assign and
rename, built over the carriers), and the walk's per-candidate length reads (length codes in posting slots: ~1 GB more
at 10^6 and slot rewrites when a field's length code changes) — reported, not chosen.

Tags, top lists, multi-word, 10-10 (coordinator: tags leave word relevance; lists of 128, one entry per card,
refilled in bounded slices; bulk builds lists on empty-store loads only; no page exact unless proven; item 2 as
briefed):
- behaviour change: the names of the tags a card carries are no longer a field of the card (`resolved_tags` is
  gone; tag-name words no longer rank or match cards, a card matching only through a tag is no longer a word
  result). A library query answers, beside its page, the tags whose names match it (`Found::tags`, binding
  `tags: [{ tag, name, carriers }]`, `tagsExact`): a tag matches when its name matches every positive clause that can
  apply to tags (no field, or the card tags field among its fields) and no negated one; a clause restricted to
  another field means none; at most 5, the whole name being the query's words first, then every word a whole word
  of the name, then prefixes; then more carriers, then the lower id. The chip that filters to a tag is 5d's. A clause
  restricted to the card tags field (`tag:dragon`) is a membership filter, not a text match (coordinator, 10-10):
  the cards carrying a tag whose name matches it (`-tag:` excludes them), found through the tag names under the
  tag work limit (past it the page and total are marked); it adds no score;
- top lists: per term with more than 128 documents, a head (generation, pass position, floor, parameters), one
  entry per listed card keyed by its score at the list's parameters and its id (value: its fields' counts and length
  codes), and a count. A write recomputes the card's old score from its counts and length codes before the change
  (the key to delete) and its new one, and moves only that entry; past 128 + 32 entries the lowest go and the floor
  rises. A query that finds a list missing, stale (a bulk load bumped the term's generation), under 64 entries or
  drifted past 10% asks for a slice: a `Job::Derive` in the commit queue (entries derived without a record, in order
  with commits, published with its group, lost in a crash and built again), at most 16k work, continuing the
  block-max pass over the term's postings in id order; commits follow the partial list for the blocks it has
  passed. Until the pass ends the walk answers. Forward pages read on down the list (seeking past
  entries that rank above `after` by more than the drift); past it, or for several words, the stateless walk from
  `after`;
- bulk loads: a load into a store with no searched documents and no top list, with nothing committed or derived
  while it ran, builds every list from its merged run on the workers' threads into a second run installed after
  the first (a crash between them leaves the lists to slices); any other load bumps the generation of each term it
  changed;
- snapshots (coordinator, 10-10: a read must not mix states, and writes never wait on reads): every read of the
  store's derived data (`Store::derived`: search, `get`, `scan`, `text`, ...) goes through one sequence-number
  snapshot of the keyspace (`Keyspace::snapshot`). Each insert batch takes the next sequence; a buffer entry keeps
  its value's sequence, and an insert keeps the value it replaces only while a live snapshot falls in its window
  (otherwise it folds in place as before; older values go at the key's next insert once unread). A snapshot holds
  the runs and buffers present at its start (merged-away runs stay until it drops) and reads the buffers at its
  sequence. Taking one waits only while an insert batch applies; nothing waits for a snapshot. (An interim
  blocking snapshot, buffers held for reading during a list read, was replaced: it made writes wait on reads.)
  Tests: for each read path (a top list between its head and entries, a word read whole after its first document,
  a walk at its first match) a write is published, on another thread, mid-read and the page and total are those
  of the state before it (each fails with the snapshot off), and a walk stays open across 100 acknowledged
  commits. Overhead, 10^6 synth, same rows: none measurable (single words 43–57 µs, 2–3 words 9.3–18.5 ms,
  `tag:dragon` 2.1 ms, load 263 s, edit 177 B; no writes ran during those reads, so no older values were kept);
- exact marking: the bug found (a word with ≤ 128 documents whose matching tags had more than 65,536 carriers marked
  its page exact without weighing them) went with the joins; every path that marks a page exact was checked: the
  walk only when it ended under the limit, a word's documents read whole, a list only when nothing outside it nor
  any entry not read can beat the page's last hit;
- multi-word (item 2): the ~9 µs per candidate was not the length read alone (4.4 µs, its decode 0.3 µs) but the
  block maps decoded three times per read (a run's map decoded, re-encoded to resolve it, decoded again by the
  query; now reads keep a map's pairs, `Val::settled`), bounds recomputed per document (now per block, with each
  list's next block from its maxima), and the walk stepping every document both words hold (now a block's
  documents are intersected as bits and bounded together at the block's shortest lengths, and only those that can
  beat the page are visited: "dark knight" 47,260 steps → 1,656);
- measured, 10^6 synth bulk-loaded into an empty store (scan check on every query; tag-restricted clauses checked
  against a scan of memberships): load 270 s (lists 64 s of it; ≤ 300), runs 2.53 GB (2.46; lists 5.29 M entries),
  one-word edit 9.4 entries, 177 B (178); one word or prefix, first page, 45–62 µs incl. `girl` 62, `love` 54, `the`
  61 (were 0.67 s / 0.80 s / 88 ms), `quokka` 0.22 ms (85 documents, read whole with their lengths); 2–3 words
  10–19 ms (`dark knight` 9.7, `the girl` 9.8 page cut, `vampire love` 11.5, `the dark knight` 12.6 cut,
  `girl love dragon` 19.3; were 63–550 ms); `tag:dragon` 2.2 ms, 10,371 cards exact (the membership scan's; the
  synthetic generator also puts words in a card's own tags text without assigning the tag, which the old index's
  20,823 counted); every page and total marked exact equals the scan, and the tag matches equal a scan of every
  name. Multi-word stays here ({{user}}: "hard case is hard"; no length codes). Of a 10–20 ms multi-word query,
  length reads are 1.3–3.6 ms (~550 candidates × ~4 µs); the rest is reading and bounding the common words' posting
  blocks (`the` ~8,000 pairs a block). Length codes in posting entries (~1 GB more at 10^6) would remove the length
  reads only: reported, not built.

Not here: the derivers and routes that feed and read search for cards, groups, sessions and world info (5d),
including how `/api/chats/search`'s substring matching (Q-F9) is answered from word postings.

Grouping (answered, coordinator, 10-03, from CLAUDE.md Compat "no side-by-side old and new versions"): no stage
writes to both the engine and SQLite for one action. So the stores whose derived data feeds each other move in one
cutover stage (stage 5): library (characters, cards, tags, groups), chats (message trees, sessions and bookmarks,
stats), search, world info with embedded books. It is built in sub-steps that land behind the cut, staging working on
the old path until the cut commit switches it. The independent stores (settings, presets, themes, quick replies,
personas, saved views) each move in their own stage after it, in an order picked and recorded here.

### stage 5: the library, chats, search and world info cut over

Sub-steps land behind the cut in the order below; each adds record kinds and their Rust derivers, the JS write code
that builds records for the actions, and the read paths, tested against the old path's answers on the synthetic
library; nothing routes to them until 5-cut.

**5a. library records.**
- Record kinds (design 2, 4.1): each card value (every V1 / V2 / V3 field as a field code; `alternate_greetings` and
  `group_only_greetings` as positioned list items; each `data.extensions` key through the escape code; unknown keys
  by path, so nothing a card carries is dropped; the V1 mirrors stored once, as `splitCard()` /
  `assembleCard()` (`src/character-card-storage.js`) already decide); fav (bit); tag definitions (name, colors,
  folder type, manual order), assignments (entity, tag, bit), merges (tag, target); group fields and members; date
  added and card create date (D13); the avatar's content hash (D2). Text values as edits, full value once the edits
  reach its size (4.1).
- Derived (Rust): current values; one order per single filter family × key the UI offers (design 5 / Q-L4: families
  fav, kind (characters / groups / both), world, folder; keys name, create date, date added, fav-then-name, last chat,
  chat size, data size; the list is read off `public/index.html:6220-6234` and the filter code
  `characters.js:2254-2270, 2752-2760` by the sub-step, not chosen); counts per kept space; membership both ways;
  random spaces (dense numbering, a delete moving the last number into the hole: O(1) per change) for the main and
  fav spaces; the content identity hash and its order (Q-L7); versions.
- Per-tag orders and random spaces (corrected, coordinator, 10-03): every derived structure is updated at commit, and
  existing data's are built by the conversion one-off (5-conv). No background build and no first-view walk. So
  there is one order per (tag, key) and one random space per tag, for every tag, all kept at commit. This replaces
  design 4.3's last paragraph ("exist only for tags a view has sorted ... built in background batches"), and answers
  the redesign's stopped step 6. `name_order` has no counterpart: the name order is an ordinary order. Counts are kept
  at commit and built by the one-off.
- JS: one write module per kind of action building records only for values that changed (Data safety); card
  assembly from current values with `assembleCard()`; list rows; `/query` with hash mode keyed by version (the seq of
  the entity's latest record); every route's shape unchanged.
- Avatars: files named by content hash, written once (4.6); routes still take the avatar id and resolve it to the
  hash.
- Measured (behind the cut, on the synthetic library converted into the engine) against design §6's rows and
  redesign 5f's numbers for today: fav flip (today 61.3 frames), tag assign (33.7), unassign (28.4), one-word field
  edit (31.2): record bytes, device bytes per isolated action (one sync), derived bytes amortized over a flush; and
  `/query` pages and counts (O(log N + P)) at the three engine sizes of stage 3.

Status: **done.** Characters, groups, tag assignments and merges, filtered pages and bulk numberings built; the tag
manager on the engine built, its engine side (38e89f5df, 331d897c2) and its JS layer with moves, reorders, restore
and the settings import (see "Tags on the engine, 10-10" and "The tag JS layer, 10-10" below) (699b6c82c, 128d87d59,
52205f041, 65a2fc3fc; 10-10 later: 334c6fdbe filtered pages, ad5e1fb37 `entityUpdate` and two-hash lookups, 5891f55f0
groups and the small writers, 25d235045 bulk numberings; 8eece9c6d, c0aec3c00, d7d16ea86, 84655fbfc, d66314656,
fb6192bb6 the tag JS layer and the two perf items).
Nothing routes to it. Answered (coordinator, 10-10): a tag merge is one record, readers of the target take the merged tags'
orders while the carriers move in bounded steps off the request path, counts of the target marked estimates
meanwhile; the writer computes the create-date sort key, `data_size` and the content identity hash with today's
functions (V8 `Date.parse`, `getCharaCardV2()`'s V1 conversion and `computeContentIdentityHash()` can't be derived
identically in Rust) and records each only when it changed.

Built:
- Record kinds: `entityCreate` (entity, type 0 character / 1 group / 2 tag, key, date added; refused when the key is
  taken), `entityDelete` (everything the entity holds; a tag only after its `tagMerge`), `jsonValue` (JSON text, empty
  = a marker), `valueDelete`, `itemPlace` / `itemDelete` (an item's text is the text value of field
  `1024 + item·8 + list`), `dataSize`, `createDate` (ms, absent for none), `cardHash` (identity, upload content, avatar
  file, avatar identity), `tagMerge` (tag, into?). `fav`, `tagAssign`, `textValue`, `textEdit` gained the library's
  derivations.
- Derived (Rust, `store/library.rs`): entity by (type, key); orders per (scope, sort key, type, fav) for the scopes
  the whole library, each tag, each lorebook, sort keys name (folded as `foldName()`), create date, date added, last
  chat, chat size, data size; a dense numbering and a count per (scope, type, fav); hash lookups; list item places;
  `NEXT_ENTITY` (a maximum) so the writer allocates ids; merges (`MERGE`, `MERGED_INTO`, `FOLD`) and the fold, a
  `Job::Derive` of 256 carriers per step queued after a merge's commit and at open while one waits.
- Reads (`store/library_read.rs`, binding `libraryPage`, `libraryEntities`, `libraryIds`, `libraryByHash`,
  `libraryNextId`): a sorted page merges the (type, fav) parts of the smallest scope holding every match; anything
  else is checked per entity under the work cap (20,000, `SEARCH_WORK_CAP`), each check reading only what the filter
  needs; random pages permute the scope's numbering with `random-order.js`'s Feistel network; totals exact from the
  counts where they answer, else sampled (20 runs of 500, the old budget) and marked; cursors carry on from the last
  place. The keyspace gained reverse scans for descending pages.
- JS (`src/library-engine.js`): cards stored as `splitCard()` splits them, each part a value; a write records only
  what differs (a text as one edit, a list by its changed items placed between neighbours, renumbered when no
  position is free), a new entity's create after its values; writes to one entity serialized. Cards read with
  `assembleCard()`, list rows as `readListRowsSync()`'s, `/query` with `queryEntities()`'s parameters and answer
  shape (hash rows keyed by the entity's version). `tests/library-engine.test.js` checks cards, list rows, every
  sort × filter page through cursors and exact totals, and edits against the old store on a varied synthetic library.
- Filtered pages (334c6fdbe): the driver is the scope with the fewest entities among the whole library, each required
  tag, the tags of which a match carries one (their orders merged, duplicates dropped as they meet) and the lorebook;
  what is left is checked per entity, tags fewest carriers first (excluded and any-of tags most first), each tag
  through its member block (16,384 ids a block, read once a page while the id space's blocks fit in 4,096; point
  reads past that). A range on the page's own sort key narrows its orders to the range's keys; a range on another key
  whose entities in the driver are at most √(page · driver) and the cap is read whole, checked and sorted (its total
  exact); a random page whose driver is within the cap and whose checks read no values reads the numbering in order
  and places each match by the permutation. A `tag:` range is a required or excluded tag (resolved through merges, as
  the tag filters are). Totals: exact when a walk reads its driver to the end from the start, from a lone range's
  entries when at most 10,000, and as the library's count less one excluded tag's; else sampled as before. Ordered
  walks read windows doubling from 64 to 4,096 entries.
- `entityUpdate` (entity, type, key, added; ad5e1fb37): a new key (an avatar rename keeps the character: fav, tags,
  values, date added) or date added; refused for another type or a key taken; it becomes the record `entity_info`
  reads. `libraryByHashes` finds what two card hashes both find (import dedup's identity pair), reading each list from
  the other's last entity on.
- Groups and the small writers (5891f55f0): `writeGroup()` stores a group's own values (name, `avatar_url`,
  `allow_self_responses`, `activation_strategy`, `generation_mode`, `auto_mode_delay`, the join prefix and suffix,
  `hideMutedSprites` by code; any other key as `group:<key>`; `members` and `disabled_members` as lists 3 and 4 when
  non-empty lists of strings, else JSON), fav from the object (`normalizeFav()`, as `writeGroupFile()`), a write
  recording only what changed; `groups()` answers `/api/groups/batch`'s objects; `/query` group rows are hydrated as
  `hydrateEntityRows()` does and hash rows carry the digests of the `groups()` object (the client hashes the same
  object). `setAllowGlobalStyles()`, `updateEntity()`, `findByHash()`, `findByIdentityHashes()`, `query({ wantHidden })`
  (upstream's hidden count, exact from the counts). The test compares each against the old store.
- Bulk numberings (25d235045): a load holding characters or groups goes only into a store with none, nothing
  committed or derived meanwhile (else refused, nothing loaded); it numbers every (scope, type, fav) from its name
  order, read from the load's run in key order, into a run installed before the load's and covering only the log
  before it; the log's end moves past the load only after the load's run is in place, so a failure or crash between
  leaves replay to number the load again. Loader failpoints are per loader (tests in parallel no longer stop each
  other's installs).

Engineering choices (decided from the bounds; each picked and recorded):

| choice | picked | reason |
|---|---|---|
| ids | characters, groups and tags in one integer space, the writer allocating from `NEXT_ENTITY` | one key space for values, memberships and orders |
| order split | every order split by type and fav | the fav and type filters and favourites-first are merges of ≤ 4 parts, no extra orders; a fav flip moves the entity's entries in its scopes |
| ties | a character's avatar, a group's `<id>.json`, characters first, descending reversing all | upstream's and the old store's order; equal keys (0 chats) are common, so it's visible |
| folder | a folder tag is that tag's scope; "no closed folder" a check | an order for it would make a tag's folder-type change rewrite every carrier |
| lorebook scope | the card's `data.extensions.world` text | links by id come with 5c/5e |
| random | one dense numbering per (scope, type, fav), the parts concatenated, `random-order.js`'s permutation keyed by seed and scope | O(1) per change; a different shuffle than the old store's, which is random either way |
| lists | greetings, card tags (and group members) as items, positions 2^20 apart | an insert writes the item, not its neighbours |
| bulk loads | derivation leaves numberings out (shared across partitions); a load of characters or groups numbers every scope after merging, only into a library with none and nothing changed meanwhile | a numbering can't be rebuilt later (unlike a top list); renumbering a populated library would leave stale numbers; 5e writes a new store |
| driver | the fewest entities of: library, each required tag, the any-of tags' union, the lorebook | cost follows the rarest scope; the union's orders merge like a pending merge's |
| membership checks | member blocks, kept while the id space has ≤ 4,096 blocks (≤ 8 MiB a page), point reads past that | a block read costs about a point read; with ids spread over more blocks than a walk examines, blocks are never reused |
| ranges | on the page's sort key: the order's key range; on another key: read whole when ≤ min(cap, √(page · driver)), else checked | search's rule (7.3); the range's set is scanned to its bound first, a sequential read |
| random within the cap | a light filter (tags, ids) over a driver of ≤ cap entities reads its numbering in order | a point read per permutation place costs ~5 µs; the numbering in order ~0.3 µs an entry |
| groups' read-time keys | `id`, `fav`, `tag_ids`, `date_added`, `create_date`, `date_last_chat`, `chat_size`, `chat_id`, `chats` aren't group values | each is the key, a record, the library's or (5b) the sessions' in the group's tree; stored copies would be second copies the reads override |
| key changes | one kind, `entityUpdate`, the `entityCreate` tuple again | `entity_info` reads one record whatever changed; a rename moves the tie in each order (~6 sorts × scopes entries) |

Measured (`engine/examples/library.rs`, release, NVMe btrfs scratchpad, synthetic cards with a 150-word description,
1–3 of 50 tags, a third with a lorebook, a fifth favourites; ~40 entries a card, so 22k / 222k / 2.2M cards are
stage 3's 10^6 / 10^7 / 10^8 entries):

| action (isolated, 222k cards) | today (frames, unsynced) | record | derived entries | device per commit (one sync) |
|---|---|---|---|---|
| fav flip | 61.3 (≈ 250 KB) | 3.9 B | 50 (1.5 KB) | 172 KB, 2.8 ms |
| tag assign / unassign | 33.7 / 28.4 | 3.0 B | 13 / 15 (0.3 KB) | 172 / 169 KB |
| one-word edit, with size and identity hash | 31.2 | 52 B (the edit alone 10 B) | 15 (0.45 KB) | 173 KB |
| rename | | 15 B | 10 (0.3 KB) | 192 KB |

Device bytes are the sync floor (design §0, 75–190 KB), the same at 20k cards (120–164 KB). Derived entries are
written again by flushes and merges 0.36 / 1.76 / 2.26× their bytes at the three sizes (load). A fav flip's 50
entries are its ~3.3 scopes × (6 orders moved, numbering, counts): design §6's estimate for 6 keys × the library and
one tag. Memory peak 254 / 258 / 289 MB.

| page of 500 (median ms) | 22k | 222k | 2.2M |
|---|---|---|---|
| name A–Z / favourites first | 0.12 / 0.12 | 0.14 / 0.14 | 0.24 / 0.25 |
| later pages by cursor | 0.11 | 0.13 | 0.22 |
| descending (Z–A, newest, most tokens) | 0.6–0.7 | 0.8–0.9 | 2.3–2.7 |
| fav only, one tag, lorebook | 0.10–0.13 | 0.11–0.16 | 0.19–0.43 |
| random, random in a tag | 0.6 | 1.2 | 3.4 |
| checked: two tags / a tag excluded / a data-size range | 5 / 15 / 148 | 74 / 23 / 180 | 199 / 70 / 318 |

Single-scope pages grow as log N; descending reads decode whole blocks, so they cost more than ascending. Checked
pages are bounded by the cap, not N; the range case is the cap of 20,000 entities each with its record read (no
match in the synthetic data), plus the count's sample.

Filtered pages after 334c6fdbe (same harness; tags each on ~4% of cards; before → after, median ms, page of 500):

| | 22k | 222k | 2.2M |
|---|---|---|---|
| two tags, by name / newest | 4.5 / 4.8 → 0.25 / 0.59 | 72 / 82 → 2.2 / 3.0 | 153 / 201 → 9.4 / 12.8 |
| two tags, favourites only | 0.85 → 0.08 | 7.9 → 0.50 | 268 → 5.8 |
| three tags | 2.5 → 0.27 | 74 → 2.3 | 166 → 11 |
| any of two tags | 41 → 0.18 | 66 → 0.26 | 165 → 0.41 |
| a tag excluded (total now exact) | 15 → 0.16 | 24 → 0.18 | 52 → 0.37 |
| a tag and an excluded tag | 3.4 → 0.36 | 38 → 1.9 | 101 → 2.8 |
| a size range, no match | 154 → 0.01 | 184 → 0.02 | 267 → 0.08 |
| the same, sorted by size | 168 → 0.21 | 216 → 0.29 | 358 → 0.78 |
| a size range matching ~15% | 62 → 14 | 72 → 74 | 100 → 107 |
| random, two tags | 5.0 → 0.19 | 96 → 1.6 | 248 → 97 |
| descending, whole library | 0.57 → 0.40 | 0.75 → 0.52 | 2.5 → 1.6 |

The ~15% range is bounded by its sampled total (10,000 entities, each with its record read) and, at 2.2M, the
20,000-entry scan that finds the range too wide to read whole. Random with two tags at 2.2M walks the 88k-card
tag's numbering, a point read per place (about 18,000 for a page). After a bulk load (one run) the same pages are
faster still: two tags 7.1 ms, random with two tags 40 ms, at 2.2M. Bulk load of 2.2M cards: 24 s, 6.3 of it
numbering (14.5M entries); 222k: 2.6 s, 0.5 s.

Found: creating an entity before its values left a deletion at the front of the name order per card (A–Z at 2.2M
read 1,300 blocks, 100 ms); fixed by committing the create last (65a2fc3fc). The old store's SQLite text turns a lone
surrogate into U+FFFD (name `a\ud800b` reads `a���b`); the engine keeps it.

Left (handover, 10-10):
- List rows read whole cards; a read of only the listed fields would cut a page's log reads.
- `/query`'s folder case (`applyFolderCase()`) is route code at the cut; the engine reads its `closed_folders` range.
- The identity-pair lookup has no fallback for cards without an avatar identity hash (the old store reads the PNG):
  5e records one for every card it converts.
- Random pages over a driver larger than the cap, and a ~15% size range's total: done (fb6192bb6, below).
- A ~15% size range's page itself (500 rows by name, each entity's data size read: ~21 ms at 2.2M) reads a point per
  checked entity; reading the checked entities' values together (as random pages now read their places) would cut it.
- Last chat and chat size keys are 0 until 5b's message derivers feed them; groups' `chat_id` and `chats` come from 5b.

Tags on the engine, 10-10 (38e89f5df, 331d897c2; `engine/src/store/tags.rs`, tests `tags_tests.rs`):
- A tag is an entity of type 2, key its id. Its name is text field 1 and its folder type text field 40 (JSON for a value
  that isn't a string). Every other key is JSON `tag:<key>`. A definition marker, JSON '' in field 41
  (`tags::DEFINED`), says it has a definition. A tag entity without the marker is a key that only assignments
  name (upstream's `tag_map` may name such a key; the old store keeps the assignments with `defined: false`). It is
  assigned like any tag and listed nowhere until a definition with the marker is written.
- Each defined tag has a place (`TAG_PLACE`: its name folded as `tagNameKey()`, its folder type, its manual order) and
  three orders (`TAG_ORDER`: alphabetical, by entries (carriers most first, then the name), manual (ordered tags by
  order, then the rest by name)). Each order is split by the folder bit and the used bit. Counts are kept per part
  (`TAG_PART_COUNT`). All of these are kept at commit: on names, folder types, orders and carrier counts
  (`tagAssign`, entity deletes, fold steps). Bulk loads leave them out, and the load builds them after its merge,
  only into a library with no characters, groups or tags.
- New kinds: `tagOrder { tag, order? }` (base 33) holds `sort_order` as upstream coerces it (JS `Number()`; null
  is 0; anything else unordered). The writer computes it and records it beside the stored JSON whenever it changes,
  as it does `createDate`. `tagPrune { tag }` (base 35) deletes the tag only if nothing carries it (nor a merged tag
  whose carriers are still moving); otherwise it does nothing, so a prune racing an assign loses nothing.
- Change feeds: `TAG_CHANGE (position, tag)` holds one entry per tag (deleted ones included) at its last definition
  change. `ENTITY_TAG_CHANGE (position, entity)` holds one entry per entity at the last change of its tags. Each feed
  is one entry per item, so it never needs a reset for having lost its history.
- A deleted tag's key stays found (`TAG_GONE_KEY` / `TAG_GONE_ID`): `tagStatus` answers `gone` and the key of the
  live tag its merges lead to.
- Fixed (331d897c2): unassigning a tag merged into another used to also remove the target's membership. An entity
  carrying both lost the target, because the client's delete-and-merge unassigns the merged tag from each carrier.
  Now only the named tag's own membership goes, as in the old store (test `unassigning_a_merged_tag_keeps_its_target`).
- Binding (`Store.*`): `tagPage({ sort: 0 alphabetical | 1 by entries | 2 manual, folders?, used?, folderType?,
  search?, name?, contains?, ids?, after?, limit, cap? })` → `{ ids, more, cursor? }`. Names are folded in Rust; the
  cursor is opaque; a cursor made for another sort rejects with `invalid-cursor`. Also `tagCounts(ids)` →
  `[{ count, approximate }]`, `tagUnused(limit)` → `{ count, ids }`, `tagByNames(names)`, `tagMaxOrder()`,
  `tagStatus(keys)` → `{ id, state: live|undefined|gone, into? }`, `tagKeys(ids)` (the same by id, with the key),
  `tagFeed('tags' | 'entities', after, limit)` → `{ entries: [{ pos, id }], more, end }`, `libraryKeys(ids)`,
  `libraryTagIds(ids)` (tags as they are now, merges resolved), and `tagAssignments(from, limit)` (entities with
  tags in id order, for the backup). `libraryEntities` gains `tagOrder` for tags.

Engineering choices (decided from the bounds; each picked and recorded):

| choice | picked | reason |
|---|---|---|
| tie order | entity id in every tag order | ids are given out in creation order, as the old store's rowids were |
| deleted tag ids | kept for good: `/by-ids` reports `merged` (or `gone`) permanently, and a create with a deleted id is refused `deleted` forever | the old store forgot the mark when its finishing pass ended; keeping it lets a saved filter holding the id be replaced instead of dropped (Data safety), at one entry per deleted tag |
| feed positions | log positions, sent as plain JSON numbers | exact below 2^53, i.e. until about 2 TiB of log (2^17 files of 16 MiB) |
| assignment feed cursors | one feed, so `groupsVersion` = `seq` in `/assignment-changes` and `/manifest` | the old store had two logs; the engine has one ordered feed; read from min(sinceSeq, sinceGroupsVersion) when a client sends both |
| name folding | `tagNameKey()` reimplemented in Rust (NFD, U+0300–036F dropped, lower-cased, a lone surrogate as U+FFFD), with query strings folded in Rust too | stored and queried keys come from one function; it can differ from V8 only where Unicode versions differ |

The tag JS layer, 10-10 (8eece9c6d writer, c0aec3c00 module, d7d16ea86 engine queue and pass, 84655fbfc moves and
reorders, d66314656 restore and the settings import, fb6192bb6 perf; `src/library-engine-tags.js`, tests
`tests/library-engine-tags.test.js`, `engine/src/store/tags_tests.rs`, `engine/src/keyspace/tests.rs`):
- Writer: `writeTag()` writes the definition marker last among a tag's values and `tagOrder` whenever the coerced
  order differs from the recorded one; its records come from `tagRecords()`, so a batch can commit several tags'
  together. `tagDerivedColumns()`, `valuesAfter()` / `valuesBefore()` and `compareNameKeys()` moved to
  `src/tag-order.js`, the settings sources' helpers to `src/settings-tags-source.js`; the old store imports them.
  The codes both library modules use are `src/library-codes.js` (no import cycle).
- `LibraryTags` (`lib.tags`) answers in the old store's shapes: `create`, `edit`, `delete`, `countUnused`, `prune`,
  `query`, `byIds`, `findByNames`, `changes` / `changesSeq`, `entityChanges` / `entityChangesEnd`, `tagIdsFor`,
  `assign`, `unassign`, `copy`, `move` (`/rename-key`), `backupDefinitions` / `backupAssignments`,
  `moveDefinition`, `reorderDefinitions`, `startPass`, `restore`, `importSettingsTags`, `restartSettingsImport`,
  `markSeedPending`. It is an EventEmitter: `tag-changes` (a pass changed definitions), `tag-order-settled` (a pass
  ended), `tag-move-failed` (the old `TagMoveFailedPayload`).
- Engine (d7d16ea86, d66314656): kinds `tagQueue { seq, tag, after, anchor?, value? }` (base 36), `tagQueuePop { seq }`
  (44), `tagPass { pass, mode?, phase?, n?, after? }` (45; no mode once the pass ends), `metaValue { key, json? }`
  (63), `tagPassOrder { tag, order?, pass }` (61; `tagOrder` that stamps the tag with the pass). Reads: `tagPage`
  takes `reverse`, `ordered` (manual: with or without an order) and `unstamped` (tags a pass hasn't written);
  `tagPositions(sort, [{ id, order? }])` gives each tag's cursor, or where an order would put it in the manual order;
  `tagQueue(after, limit)`, `tagPass()` (`{ pass, mode?, phase?, n?, after?, stamped, live }`), `meta(names)`.
  `tagUnused(0)` reads no tags (it walked every unused tag).
- Tests compare against the old store over three seeds: every sort × filter page through cursors (pages of 3 and
  50), counts, by-ids, by-names, `/for`, unused counts, the backup streams and both change feeds as sets; settled
  moves (refusals, ties, spent gaps, unordered anchors) by what they write and the orders after; reorders in both
  modes with moves, values and creates queued behind them, read before the pass and after it; a queued move whose
  anchor was deleted (the same `tag-move-failed` payloads); a pass resumed after a reopen; restores with and
  without overwrite, also while moves queue; the settings import from the legacy file and the key files, and the
  default tags. Engine-only: the drain's reads equal the order it leaves, cursors are refused in another order,
  and tags a by-entries walk passes by get orders after the rest.

Engineering choices (decided from the bounds; each picked and recorded):

| choice | picked | reason |
|---|---|---|
| locks | definition writes in one lane; a character's or group's tag writes take the entities they touch in one order | the next order and free names are read and written with nothing between; two moves naming the same entities never wait on each other |
| the queue | records by `seq` (one past the queue's last), popped by the drain in the same commit as the move it applies | the drain's place survives a stop with nothing applied twice; a cleaned-up record keeps its key |
| the overlay | folded in memory on every manual read (O(queued), tag-actions D16): an entry whose tag or anchor isn't live now does nothing | the old store folded each entry when queued and froze a gap whose anchor's row went at its last place; at read time the tag shows where the drain will leave it (D19: next to a deleted anchor it stays where the pass put it) |
| overlay positions | each moved tag at its anchor's cursor (`tagPositions`, the anchor's queued value's place in the stored order) plus gap side and order; rows from `tagPage` with the filters, moved tags skipped | positions compare as the engine's cursor bytes, so the merge needs no JS copy of the order's keys |
| manual cursors | the engine's cursor (base64url) for the stored order with nothing queued; else `['o', pass id or 0, position, g, i, due]`, refused in any other order (D25.8, D27.4) | a stored-order cursor stays good when moves start to queue; one made under pass N stops when N drains or is replaced |
| missed tags | each pass counts the live tags it has written (`TAG_STAMPED`; a written tag that goes leaves it); the sweep walks the mode's order for tags it hasn't written until the count reaches the live tags, from the start again when it reaches the end | O(1) per change, and nothing missed: a tag that moved behind the walk, or was made meanwhile, is unwritten; with no churn the sweep reads nothing |
| tail numbering | committed before the move's own write (the order shown doesn't change); written back if the move then finds no room | placing reads the committed order; the old store did both in one transaction |
| next order | `max(0, tagMaxOrder) + 1` over live tags | the old store counted a deleted tag's order until its finishing pass; the engine has no such tag |
| starting the pass | the caller starts it (`startPass()`): the route after a reorder, the server after listening for one a stop left recorded | as the old route requested its migration pass; a request never waits for it |
| pass batches | 1000 tags a commit, 10 ms apart, each batch in the lane | Boot and batches; the old pass's sizes |
| restore and import batches | 500 tags a commit, 10 ms apart; an item whose id or name an earlier one of its batch touched waits for that commit | as the old store's batches; a duplicate in a backup sees the first one |
| import marks | `metaValue` `settings_tags_migrated` and `tags_seed_pending` | the same marks as the old store's meta rows, in the same log as the writes they follow |
| seed pending | set by `markSeedPending()` when the server creates a store, and by 5e from the old store's mark | only a new store's first import decides the default tags (D34.7) |
| prune order | alphabetical | the order `tagUnused` reads; the old store pruned by id, so a limit below the unused count deletes other tags first (all go in the end) |
| backup order | definitions alphabetical, `tag_map` by entity id | the engine's orders; the file holds the same tags and assignments |

Perf (fb6192bb6), measured on 2.2M synthetic cards loaded through commits (7 runs), the same store before and after:
- A lone range's estimated total now reads a few blocks per run (`Run::estimate`): the data blocks the range starts
  and ends in are counted, the data blocks between them by their bytes at the entries per byte of four data blocks
  found at even steps through them; buffers are counted. A ~15% data size range: 104.1 → 21.4 ms (the rest is the
  page's own checks), total 496,899 for 494,745 exact (+0.4%; the sample gave 498,520, +0.8%). The estimate counts
  older versions and deletions still in runs.
- Random pages read their permutation places in windows doubling to 4,096, each through `View::get_many` (keys
  sorted; a run's data block found for one key serves the keys after it). Random with two tags: 97.8 → 42.8 ms
  (216k → 5.7k blocks fetched); random 2.64 → 1.25 ms; random in one tag 2.56 → 0.97 ms. The places stay a uniform
  permutation (a block-structured shuffle would read less but clump creation neighbours on a page).

Left for 5-cut (route wiring): `/api/tags/*` call `lib.tags`; `/query`'s `restCount` re-reads with the page's
cursor; `/reorder` calls `startPass()` after answering, and the server once after listening; the three events go
to `/api/characters/changes/stream` as the old ones do; a store the server creates gets `markSeedPending()`.

**5b. chats: trees, positions, state.**

Answered (coordinator, 10-03). {{user}}: chats "doesn't fucking exist. bookmarks are what replaced them but that
doesn't make them the same". The model is trees, sessions and bookmarks (one structure, a pointer plus a movement
mode). Upstream's chat concepts exist only at the compat edge:
- `chat_metadata` is not stored. It is the state at a position in the tree: author's note, variables, scenario
  override, persona lock, chat-bound lorebook, extension state. This follows `2026-10-03-state-layer-1.md`: changes
  hang on the tree, so they branch and roll back with the conversation. {{user}}: "yeah i think". Upstream code
  reading it gets the state at the current session's position; writing it records a change at that position.
- `saveChat()` and every other upstream write path: {{user}}: "thin client. shocking that it ever needed to be asked".
  The client sends only actions, and the compat wrapper on the client turns what upstream code did into actions.
  `2026-10-03-thin-client-audit.md` owns that.
- `getCurrentChatId()`, `characters[].chat`, `group.chat_id` and chat names in events are compat identifiers. They
  come from the current session (the one open in this tab). For a character or group that isn't open, they come from
  the session that landing there would use (the cascade). The name is the session's name, else its id.

Builds:
- Record kinds: message (D6: parent, owner, speaker id, a stored name only where it differs (Q-X3), text, flags,
  extra, time, session, user); message edit (a text edit) and delete; position (D7: pointer, name, mode: session,
  following or pinned); pointer move (D8: session, user, target); fork selection (D9: message, reply, session, user);
  state change and revert (layer 1's change: message, author kind and reference, confidence, op, key, value, the
  change it reverts); itemized prompt and generation time per reply (D14).
- State keys are paths in upstream's `chat_metadata` shape: each top-level key is a key, its value as JSON (an
  extension owns its key's shape, as with `card_extensions`), and `variables.<name>` per variable (layer 1's per-variable
  changes). Upstream code reads `chat_metadata` as that object and can't tell the difference. Keys share no flat
  namespace, so a variable named like a metadata key can't overwrite it (Data safety).
- Derived (Rust, at commit): children of a parent; current values; the per-owner and total stats (Q-C5); the
  library's activity orders (5a); following bookmarks and the session's pointer moving with an append (implied by the
  append, no record of their own); bookmarks per tree; all sessions by last activity; sessions by (tree, last
  meaningful activity); each session's history (session, seq) → target; fork choices (session, message),
  (user, message), (message) → reply; (session, tree) and (user, tree) → last position; session-name postings; a
  message's state changes in order; a message's depth (the session list's message count).
- Reads: open a position (root to pointer, every alternative's text, design 5); the landing cascade; the fork cascade
  below the pointer; the session list and bookmark lists; the state at a message, folded along the path the read
  already loads.
- JS: record building for every chat action; the compat identifiers above; upstream's shapes assembled on read
  (`[header, ...messages]`, `swipes`, `extra`); the token-count cache (Q-C6).

Record shapes (answered, coordinator, 10-10, from "A write costs what actually changed", the stage 2 rule that a
kind's schema is fixed once written to a real store, and compat). Kinds 6–8 (`pointerMove`, `forkSelection`,
`messageAppend`) were revised here, before any real store held them:
- Message ids: integers inside the engine. Converted messages keep their old text ids through a key mapping (as
  `entityCreate` maps an avatar), so browser drafts and send keys holding old ids keep resolving. New messages get no
  mapping record: their external id is the integer's decimal string. Resolving an external id checks the key mapping
  first; only with no mapping is a decimal string read as an integer. This holds whatever the old data contains (see
  the stop below, answered): 5e maps every old id, and starts the message-id counter above the largest old id that
  is a canonical decimal string, so a new message's id never equals an old one.
- `messageAppend` is changed in place. A user message's append carries its send key (16 B) as a slot, which the
  server's repeat check reads. `extra`: each top-level key is its own value (per-key records, as card extensions are),
  written only when it changes; unknown keys are kept as they came (JSON per key).
- Session ids are UUIDs (v7 for a new session, v5 for the deterministic one), mapped to integers by a key record
  written when the session first exists (on its first pointer move). The integer slots stay.
- Users: a handle maps to an integer by a key record in the store, created on that user's first write there. A chat
  lives in one handle's store (the owner's), and other users acting in it are recorded by their handle, mapped in
  that store. The v5 id uses the handle string.
- Positions: separate small kinds, each writing only what changes: create (id, mode, creating session, user,
  starting pointer), name (id, text), mode (id, mode), delete (id). Pointer moves stay `pointerMove`.

Stop (10-10): the coordinator's message-id answer (converted messages keep their text ids through a key mapping;
new messages' external id is the integer's decimal string; the JS layer reads a decimal id as an integer) holds only
if no old id can be a decimal string. The code allowed one. From 7be404771 (08-25) until 27ea2c71b (08-28),
`saveChat` stored a message under its `msg.node_id || newId()`: any string the request's message carried. Since then
ids come only from `newId()` (`crypto.randomUUID()`), or are existing rows' ids. Whether a store written in those
days holds a non-UUID id can only be seen in the user's data, which this work doesn't read. Answered (coordinator,
10-10): the scheme above holds whatever the data holds, without reading it now.

Message shape (answered, coordinator, 10-10; the rule: store exactly what upstream's message holds, so it round-trips
byte for byte through `/api/chats/get`, at the fewest bytes, each value its own record so a later change writes only
that value):
- `flags` holds the top-level booleans upstream defines (`is_user`, `is_system`, `is_name`) as bits; any other
  top-level value, boolean or not, is a value of its own.
- `time` is the server's receive time in ms (what recent-chat orders use). `send_date` is kept as it came, as its own
  value, only when it differs from what the formatter makes from `time`; otherwise it is derived on read.
- Every other top-level key (`force_avatar`, `original_avatar`, `title`, extension keys, ...) is its own value,
  unknown ones as JSON as they came. `gen_started` / `gen_finished` are D14's generation times, stored as values.
- Messages and entities have separate key spaces: the value and text kinds name their holder's space, so a message id
  and an entity id never meet; no duplicate kinds.
- The append holds only its fixed slots; `extra` keys and the other top-level values are separate records in the same
  commit, so later edits use the same kinds.
- One key-mapping kind, with the space it names in (an old message id, a session UUID, a user handle).
- Further questions of this class (internal encoding, decided by the round trip and the byte count): the smallest
  encoding that round-trips exactly, recorded below. Stops are only for behaviour, compat or data safety.

Built, record kinds and their derivers (10-10; `engine/src/log/format.rs`, `engine/src/store/chat.rs`, tests
`engine/src/store/chat_tests.rs`, `engine/store.test.js`):
- Kinds: `messageAppend { id, parent?, owner, speaker?, name?, time, text, flags, session?, user, sendKey? }`,
  `messageParent { message, parent? }` (graft, degraft and swap move a message), `messageDelete { message }`,
  `messageTime { message, field, delta }`, `keyMap { message | session | user, key }`, `positionCreate { id, mode,
  session, user, pointer }`, `positionName { id, name? }`, `positionMode { id, mode }`, `positionDelete { id }`.
  `textEdit`, `textValue`, `jsonValue` and `valueDelete` name their holder as `entity` or `message` (`Ty::Sel`: a
  header bit picks the id space, and the id is coded against that space's previous id). Every kind's header is below
  128, so one byte.
- Derived (Rust, at commit): a message's record (`MESSAGE`), its place among its parent's replies or its owner's
  openings by (time, id) (`CHILD`, `ROOT`), its text (`MSG_TEXT`: the append is the text's first full value, and
  edits and full values follow as for any text), its values and times (`MSG_VALUE`, `MSG_TIME`), a moved message's
  parent (`MESSAGE_PARENT`), send keys per owner (`SEND_KEY`), the owner's chat search postings of its text, outside
  keys both ways (`KEY_MAP`, `KEY_OF`), bookmarks (their record, name, mode; the message each is at, bookmarks per
  message and per tree), and the next message, position and user ids (maxima). A following bookmark at a message
  moves to a reply appended to it, in the append's own derivation.
- Refused: an append whose id is taken, whose parent is missing or in another tree, or whose send key is stored in
  that tree; a move below itself or into another tree; a delete of a message with replies or a bookmark at it (as
  today's `deleteAlternative` refuses a labeled one); values of a missing message; a key naming two ids or an id with
  two keys; a bookmark at a missing message, with a mode other than 1 (following) or 2 (pinned), or on a session's id.
- Tests: a deterministic workload of every chat kind against a model, read back after commits, a clean reopen, a crash
  (replay), and cleaning that copies live messages, values and bookmarks (`relocated_records > 0`); refusals write
  nothing; a message's text replaced or edited leaves its append live and its search follows; record bytes.

| choice | picked | reason |
|---|---|---|
| flags | one varint: `is_user` and `is_system` 2 bits each (false, true, absent, another value), `send_date` present 1 bit, `mes`, `extra` and `name` 2 bits each (the usual shape, absent, another value), `is_name` 2 bits, and 1 bit each for `original_avatar` and `force_avatar` derived from the speaker (`chat::FLAGS`) | the usual messages (a user's or a character's) are 0 or 1: one byte; absent and other values round-trip |
| `send_date` and the generation times | `messageTime { message, field, delta }` from the append's time when the value is a canonical ISO string; JSON otherwise; nothing when equal to the append's time | a delta is 1–3 bytes against 24 for the string; equal costs nothing |
| holder | `Ty::Sel` on the value kinds (one header bit), derived keys under their own structures (`MSG_TEXT`, `MSG_TEXT_EDIT`, `MSG_VALUE`) | no byte per record; ids coded against their own space's previous id |
| message text | the append's `text` is the first full value of field `MES` | the text is written once; an edit is a `textEdit` like any other |
| session on an append | optional | an append made by no session (an import, the conversion, an opening asserted on open) moves no pointer |
| sibling order | (time, id) | today's (created_at, id); 5e numbers converted messages in that order, so ties keep it |
| key map | one kind; the space in the header (`Sel` over message, session, user) | as answered; the id is coded against its space |
| position slots | `id` | the binding adds `position` (the record's log position) to every record it reads |

Measured (`chat_records_round_trip_their_bytes`): a reply appended right after its parent, with a 2-byte text, through
a session: 12 bytes (header 1, id 1, parent 1, owner 1, time 2, text 3, flags 1, session 1, user 1). By the same
encoding a 600-byte reply is 611 bytes, against design §6's ~620 and today's 14.3 frames (~58 KB) in 2 commits.

Answered (coordinator, 10-10), the questions piece 1 found:
- `extra.branches` is upstream's compat field (upstream adds a branch's name to the message it was created from, and
  upstream code and extensions read it), not something our UI shows. A message's `branches` are the names of the
  bookmarks created from that message, recorded at creation (from `positionCreate`'s starting pointer and the name),
  never a subtree walk; bounded per message. Today's subtree walk in `buildPathMessages` goes at the cut.
- `extra.bookmark_link` on a message is the name of the latest bookmark created at that message. It stays on the
  creation message (upstream's checkpoints don't move) and doesn't follow a following bookmark's pointer.
- Deletes: a session's pointer naming a deleted message moves to its nearest surviving ancestor. History keeps the
  entry, marked gone; back and forward skip gone entries. Deleting a session is an explicit action that removes its
  pointer and its history.
- An append moves the session's pointer when it becomes the shown message: a sent message, a generated reply, a newly
  generated swipe, a graft that changes what is shown. Greetings and alternatives added without being shown (editor
  additions, `addOpeningAlternatives`) don't. Routes pass the session accordingly.
- Depth (the session list's message count): stored at the append from the parent's. Graft, degraft and swap rewrite
  the depths of the moved subtree (those values really change; the move is a rare explicit action bounded by the
  subtree), through the bulk path in bounded slices when the subtree is large, the moved messages' depth reads
  consistent via the snapshot.

Stop (10-10), on the last answer: how a large subtree's depth rewrite runs and what a read sees meanwhile. The store has
two bounded paths, and neither fits as named. Bulk loads (`store::bulk`) go only into a store holding none of their
kind, with nothing committed meanwhile. `Job::Derive` slices (the tag fold, search top lists) write derived entries in
the commit queue between commits, so a read between two slices sees the published entries as they are: some moved
messages at their new depth, the rest at their old one. The tag fold covers its gap with a pending-merge entry that
readers fold in, and with counts marked as estimates. For depth, nothing names what the reads between slices answer
(a count marked as an estimate, a pending offset folded in on read, or waiting), or what a snapshot is taken of.
Answered (coordinator, 10-10): the rewrite runs as `Job::Derive` slices in the commit queue, as the tag fold does.
While it is under way the tree carries a pending-rewrite marker, written with the move and cleared by the last slice.
A message-count read for a session in a tree with that marker answers a count marked as an estimate, as tag counts
are marked during a fold: no waiting, no per-read ancestor walk (moves are rare explicit acts, so the window is
short). "The snapshot" meant only that each read sees one consistent state (the sequence-number snapshot); the marker
covers the partial rewrite. A crash mid-rewrite resumes it from the marker.

Stop (10-10), three questions sessions need (behaviour):
- A message opening its tree (it has no parent) is deleted while a session's pointer, or a remembered (session, tree)
  or (user, tree) position, names it: it has no surviving ancestor to move to. Today's `deleteAlternative` refuses
  only the opening that is the anchor's default child; with several sessions, one session's shown opening can be
  another's unshown one.
- After a session is deleted, the (user, tree) entry can still name it as the user's last session in that tree, which
  is what a request with no session header answers (`characters[].chat`, `getCurrentChatId()`).
- Whether an append that moves its session's pointer (a sent message, a generated reply or swipe, a graft) also
  records a fork selection by that session and user. Today the append sets the parent's `default_child_id`, so every
  reader then follows the new reply; under the cascade, a reader with no choice of their own follows "the last choice
  anyone made there", which only a selection record changes.

Answered (coordinator, 10-10; behaviour "maximally intuitive", Data safety "nothing lost silently"):
- Deleting an opening that a session's pointer or a remembered position names: they move to the tree's newest
  surviving opening; if it was the last opening, they are at the tree's root (no message), and landing behaves as for
  a new chat (the card's greeting shown provisionally, nothing written until used). Deleting an opening another
  session is showing is allowed; that session moves as above.
- After a session is deleted, the (user, tree) entry falls back to that user's most recent remaining session in the
  tree, else the derived v5 (user, tree) id, as for a user with no session there.
- An append that moves its session's pointer also records a fork selection by that session and user at the parent
  (continuing on a branch is choosing it), so it updates all three cascade tiers, as today's `default_child_id` does.
- The depth rewrite recomputes each message from its parent top-down, so a reply appended under the moved subtree
  meanwhile comes out right; a second move in the same tree queues behind the first, the marker held until both end.
- Session and user slots on the edit kinds, and two-byte headers for rare kinds: under the encoding rule.

Built, sessions (10-10; `engine/src/store/sessions.rs`, tests in `chat_tests.rs`):
- Kinds: `textEdit`, `textValue`, `jsonValue`, `valueDelete`, `messageDelete`, `messageParent` and `messageTime` take
  an optional `session` and `user` (an edit through a session is activity in the message's tree);
  `forkSelection`'s `message` is optional (absent: a choice among the tree's openings); `positionDelete` deletes a
  session as well as a bookmark. `tagQueue` and `tagPass` have two-byte headers; 119–127 are free.
- Derived at commit, from `pointerMove` and from an append through a session (which moves the session and chooses
  the reply at its parent, both from the append itself): each session's pointer (`SESSION_PTR`, a message or a tree's
  root) and the sessions at each message; its history (`HISTORY` (session, n) → target, gone flag, and for a
  `pointerMove` its record, which stays live while the entry is kept); every session by its last move (`RECENT`);
  (session, tree) and (user, tree) last positions, the latter with its session; each user's sessions per tree by
  their last move there (for the fallback); sessions per tree by last meaningful activity (`TREE_ACTIVITY`: an append
  through the session, a move inside the tree it is already in, a fork choice, a bookmark, an edit, a delete or a
  move of a message made through it). Fork choices per (session, fork), (user, fork) and fork, each pointing at its
  `forkSelection` (a replaced selection dies once no tier points at it). A message's depth at its append; bookmarks
  created at each message (`BRANCH_FROM`, for `branches` and `bookmark_link`).
- A move (`messageParent`) writes a pending rewrite (per move, with the tree's count) and the store runs
  `sessions::depth_step` as `Job::Derive` slices of 256 messages (`DEPTH_SLICE`), queued after the move's commit and
  at open while one is left, as the tag fold is. Each slice walks the moved subtree in order (a reply after its
  parent), setting each depth from its parent's. A message the walk is at that goes, or moves, moves the walk past it.
  `message_count` answers the depth and whether the tree has a rewrite under way (an estimate).
- A message going: sessions and remembered positions at it move (its parent; an opening's to the newest other
  opening, else the root); history entries naming it are marked gone; choices of it go; its depth and branches go.
  A session going: its pointer, history (its `pointerMove` records die), orders, remembered positions and activity
  go; a user whose last move in a tree was through it falls back as answered, else has no entry (the read derives
  the v5 id).
- Reads: `session_pointer`, `session_in_tree`, `user_in_tree`, `landing` (session's last position in the tree, else
  the user's, else the end of the followed path from the root), `followed` (the fork cascade, each tier taken only if
  its reply is still a reply there, else the newest reply), `path_below`, `history`, `recent`, `in_tree`,
  `branches_from`, `message_count`.
- A record naming a session needs the session's key (it exists), and one naming a user needs the user's key.
- Tests: the model workload now has 4 sessions and 2 users moving, appending through sessions, choosing, editing,
  deleting messages and sessions, and checks pointers, histories, both orders, remembered positions, landings for
  every (session, user, tree), choices and depths after commits, a reopen, a crash and cleaning; a 768-message chain
  moved, with a reply appended and a second move queued during its rewrite; a crash right after a move (the rewrite
  resumes on open); deletes of a reply, of an opening another session shows, of the last opening (pointers at the
  root), and of sessions with the user fallback.

| choice | picked | reason |
|---|---|---|
| an append's fork choice | derived from the append (session, user, parent), no `forkSelection` record | the append holds all three; a second record would be a second copy |
| activity and recency positions | log positions | they sort as commit order does; the records carry no time of their own (design 4.1: seq is the position) |
| a session's history entry | (session, n), the target in the entry | back and forward read targets in order; a `pointerMove` record is kept live through it (history is kept in full) |
| depth slices | 256 messages, oldest move first | the tag fold's size; moves in one tree finish in order |

Answered (coordinator, 10-10), two calls the first sessions build made on its own and were overridden:
- A deleted session's UUID mapping goes with it. A request carrying a deleted session's UUID (a stale tab) is
  treated like `X-ST-Session: none` (the cascade), and the tab is told its session is gone so it can land; its next
  pointer move creates a new session with a new integer. If that UUID is the deterministic v5 (user, tree) one,
  re-creating it is fine: a new integer, no history.
- Of a deleted session's fork choices only the session tier goes. The user tier stays (that user made those
  choices), and "the last choice anyone made" stays (it describes the tree, not the session); a later choice anywhere
  replaces it as usual. A `forkSelection` no tier points at any more dies.
Built (10-10): `sessions::session_gone` drops the session's key and its session-tier choices; tests check that the
UUID names nothing, the session can't move until it has a key again, and the user's and anyone's choices stay.

Built, state layer 1's storage (10-10; `engine/src/store/state.rs`, tests `state_tests.rs`):
- Kinds: `stateChange { id, tree | message, time, author, ref?, confidence?, key, value?, session?, user? }`
  (header 152, two bytes) and `stateRevert { id, reverts, time, author, ref?, session?, user? }` (119). `time` is
  when the change was made (ms, delta-coded as other times): a change can come long after its message, and history
  and rollback show when (answered, coordinator, 10-10, overriding the first build's "no time"). `id` is the change's stable id,
  in a new id space (`Space::Change`), given by the writer in order; `author` holds the author kind (user, script,
  model, rule, migration) and a bit for a variable's name; `key` is a field (a known metadata key may get a code); an
  absent `value` deletes the key. A change hangs on a message, or on a tree's root (a position with no message, as a
  new chat's).
- Derived: each change by id, the changes hanging at each place in id order, the reverts of each change.
- Read: `state_at(tree, message)`: the changes on the path from the tree's root down to the message, in order,
  reverted ones skipped (a revert of a revert restores), keys in the order a JavaScript object holds them after the
  changes in turn. O(path + changes on it), within what opening a position already reads; nothing saved.
- A message going takes the changes hanging on it; a moved message takes them along.
- Tests: a random tree with random changes and reverts against a fold of each path, through a crash, a reopen and
  cleaning; moves, reverts of reverts, deletes and refusals.

| choice | picked | reason |
|---|---|---|
| change ids | their own id space, from the writer | stable through cleaning (log positions move); reverts and later layers name them |
| author and variable bit | one varint | one byte for the usual change |
| reverts | their own kind | a change and a revert share no optional values |

Chat size (answered, coordinator, 10-10; a definition change): the stored bytes of the chat's messages, not their
JSON as assembled with a derived speaker name. It is a "how big is this chat" stat and sort key; nothing upstream
depends on its exact byte meaning. So a rename writes only the character. Kept per write like the other stats.

Built, stats (10-10; `engine/src/store/stats.rs`, tests in `chat_tests.rs`):
- Per owner and in total, exact at every write to a message: user and character messages and words, swipes,
  generation time and replies with none, chat size; per owner the earliest user send time and the newest message's
  time. What counts is today's (`message-stats.js`): every user message, every character message not opening its
  tree, no system message; a swipe is each counted character reply beyond the first under one parent; words are runs
  of ASCII letters, digits and `_` (`countWords()`); `is_user` / `is_system` held as another value count by their
  JavaScript truthiness.
- Chat size counts each message's text values (its own text included), JSON values and stored name, in bytes.
- Every record that changes a message (an append, a delete, a move, a time, a value or text of it) goes through
  `stats::Counted`, which reads the message's contribution before and after the record and adds the difference: so
  a value committed after the append in the same commit counts, and a move changes swipes at both parents.
- Send and generation times: a `messageTime` (an ISO string the engine reads exactly) or, for a JSON value, the time
  the writer read with today's `parseTimestamp()`, recorded as `messageTime` of `SEND_AT`, `GEN_STARTED_AT` or
  `GEN_FINISHED_AT` (as 5a records create dates); with neither, a JSON value counts as unreadable (0).
- The library's last chat and chat size sort keys are now these (`library::sort_num`), and a change moves the owner
  in those orders as a fav flip does.
- Message field codes (`chat.rs`): `mes` 1, `is_user` 2, `is_system` 3, `is_name` 4, `name` 5, `send_date` 6,
  `extra` 7, `gen_started` 8, `gen_finished` 9, the read times 20–22; top-level codes stay below 64, `extra`'s known
  keys take 64 on.
- Tests: the chat model workload checks every owner's counters, last time and the totals; a focused test covers
  user, system and odd `is_user` messages, each kind of send date, generation time, a swipe moved away, a delete, and
  the owners' places in the last-chat and chat-size orders.

| choice | picked | reason |
|---|---|---|
| keeping stats | a wrapper reading the message's contribution before and after each record | one place, whatever the record changes; the values of a message's append commit come after it |
| swipes | a counter of counted character replies per parent | O(1) per change; the old count's meaning (each beyond the first) |
| earliest user time and newest time | orders per owner (and every user time for the total), the first or last entry | the minimum and maximum survive deletes without a scan |
| times the engine can't parse | the writer's reading, recorded as a `messageTime` only for a JSON value | as 5a's create dates: V8's `Date.parse` isn't reproduced in Rust |

Where layer 1 goes: inside 5b, on the engine. Its own storage step (SQLite `state_changes`, saved states every 64th
depth rebuilt lazily after an epoch bump) conflicts with the design: a structure caught up when read is what revision
3 dropped (design Q-D7), and its migration step 6 is a background pass (CLAUDE.md: one-off scripts). The design and
CLAUDE.md win. The state at a message is folded along the path that opening a position or generating already reads
(O(L), design 5), so no saved states are needed. Layer 1 steps 2–5, 7 and 8 (actions, where a change hangs, page
compat, global variables, navigation, other tabs) carry over unchanged onto these records. Its step 6 becomes part of
5-conv. Building layer 1 on SQLite first would build what the design rules out.

Where the thin-client audit goes: not ordered by this plan. Stage 5 points every chat route that exists when it is
built at the engine: upstream's (`/api/chats/save`, `/get`, ...) and ours (`/message/*`, `/openings/*`, `/label`,
...; `src/endpoints/chats.js`). An audit item that has already landed by then is moved with the rest; one that lands
after is built on the engine. Either order works. Audit item 10 (chat metadata per key) becomes layer 1's
state-change action, since `chat_metadata` is state; the audit doesn't build it on the old store (its step 9, moved
here, coordinator 10-10). The compat contract it keeps is the audit's step 6 per-key merge: a generate request's
`page_metadata { set, unset }` (and later a metadata save) sets and removes single keys, leaving the others, writes only
a key whose value changed, and answers under the page's ref; the page sends only the keys that differ from what it
last had from the server (`changedMetadataKeys()`, metadata-store.js). Under layer 1 each set or unset is a state
change at the position.

A bookmark's copy of the chat metadata goes (coordinator, 10-10, Storage: stored once): the audit's step 8 copies the
chat's metadata onto a new bookmark's message (`POST /api/chats/bookmark`, `from`), a second copy of the same data.
Under layer 1 a bookmark points at a position and reads the state there, so 5b drops the copy and 5e doesn't convert
such copies as their own state (a label's metadata equal to the state its bookmark already reads adds nothing).

The session at the server (answered, coordinator, 10-03; corrected the same day, design 4.1 standing: {{user}}
"why would a session be attached to a character"):
- The page adds the tab's session to the headers `getRequestHeaders()` already gives every request (picked name:
  `X-ST-Session: <id>`). Upstream code and extensions calling routes through that function carry it too. No route
  body changes.
- A tab opening a character or group keeps its session and moves it into that tree, landing per 4.1's cascade. So
  for a request carrying a session, `characters[].chat`, `group.chat_id` and `getCurrentChatId()` answer the tab's
  own session for every tree. Upstream's select flow opening `characters[B].chat` by name then opens that same
  session.
- A request with no session header (a third-party caller): the user's last session in that tree; if there is none,
  a deterministic identifier derived from (user, tree), the same on every read with nothing written. The session is
  created with exactly that id on its first pointer move.
- A tab with no session yet: the same deterministic (user, tree) identifier for the tree it is in, created on its
  first pointer move.
- Routes taking a chat name resolve it per user as a session name or id; they need no tab. A name matching nothing
  gets upstream's "not found" for a missing chat.

Follows from those:
- The (user, tree) entry holds the session that made the last move as well as the position, so "this user's last
  session in that tree" is one point read.
- A tab with no session and a third-party caller get different answers, so the server has to tell them apart: the
  page always sends the header, and a tab with no session sends the picked value `X-ST-Session: none`.
- Picked: session ids are UUIDs, a new session's a v7 (as character ids are), the deterministic one a v5 of (user
  handle, tree id) under a fixed namespace UUID kept in the code.
- The compat chat list of a character or group (`/api/characters/chats`, `/api/chats/group/info` and the chat
  pickers) lists the sessions with meaningful activity in that tree (the design's (tree, last meaningful activity)
  order, N18's filter by character), most recent first, each named by its session name or id; message count is the
  depth of the session's position in that tree. `/api/chats/recent` is the all-sessions order (design S6). Bookmarks
  are not chats ({{user}}) and are listed per tree by our own routes.

**5c. world info and embedded books.**
- Record kinds (D10): a book (name, its book-level fields); each entry value (every field of upstream's entry shape
  as a field code, unknown keys by path so nothing is dropped, text fields as edits); an entry's order. A character's
  embedded book (`character_book`, D1) is a book owned by that character, in the same entry storage (redesign step
  10); card assembly builds `character_book` from it in upstream's shape.
- Derived: current values; each book's entry order; the books list; entry search postings for every book. A book is
  searched on the server only when it is over the page's resident budget (lorebook-wiki 4c), but that budget is a
  page setting the server doesn't see at commit, and every structure is kept at commit (5a correction), so every
  book's postings are kept: O(terms changed) per entry edit.
- Routes: every upstream world-info route keeps its shape (`/list`, `/get`, `/additional-books`, `/delete`,
  `/import`, `/create`, `/edit`) and ours (`/entry/create`, `/entry/edit`, `/entry/transplant`;
  `src/endpoints/worldinfo.js`). A whole-book `/edit` writes records only for the values that differ from the stored
  book. Upstream's World Info file format is only import and export. A chat-bound lorebook is a state key (5b).
- Generation reads every entry of every active book (design Q-W1).
- Not here: activation records per reply (Q-W2) are the wiki plan's step 2; when built, they are a record kind on the
  engine.
- Measured: device and derived bytes of a one-entry edit, against today's (the book's manifest rewritten and its
  directory listed, O(E), `worldinfo.js:219-257`): O(changed bytes) + one sync, independent of E.

**5d. search wired.**
- Derivers feeding P3 (stage 4): card fields (S1, with the design's weights and prefix fields), card tag names and
  resolved tag names joined through membership (Q-F12), groups (S2: name, member names, tags, id), session names (S6),
  messages per owner (S5), world-info entries (S7).
- `/api/characters/query` with `search`, the group search, `/api/chats/search` (upstream's shape; a session matches
  when every word matches a message on its path in that tree), and the world-info server search, all read P3.
- Measured: as stage 4, now on the real derivers, plus freshness (a write is found by the next query after its
  acknowledgement).

**5e. the conversion one-off** (`src/migrations/convert-to-engine.js`, picked name; `--dry-run` | `--apply
--server-stopped`, refusing while the server holds the files, as the existing one-offs do). It reads today's files as
they are on the user's disk and writes the engine store once: each value as its own record, then every derived structure built from those records
(5a correction). The server is stopped, so it runs in one pass, not in batches.

What it reads, and what each becomes:
- `character-metadata.sqlite` in the blob layout and the old schema the user's file is at (remove-migrations: never
  opened by staging's current code). Cards are split with `splitCard()` / verified with `canonicalCardHash()` as the
  5c converter does, then written as records; fav from the `fav` column (`cardWithStoredFav()`); tags, assignments,
  merges, group rows, saved views as records. Pass-less `tag_pending_moves` entries applied as the 5c converter does,
  with its warnings. Derived and bookkeeping tables are not read (orders, counts, ranks, `name_order`, change logs,
  `activity_pending`, digests): the engine derives them.
- Group JSON files: whichever of file and row today's server reads as the group's truth (the builder reads that from
  the code, not chooses it).
- `message-tree.sqlite` (with the 4 old `message_stats_*` triggers still present: read-only, so they don't matter):
  - each message as a message record (text and flags split out of `content`, `extra` kept, speaker by id where it
    resolves);
  - every old message id mapped to its new integer by a key record; if any old id is a canonical decimal string, the
    message-id counter starts above the largest such value; the dry run and the apply report how many old ids
    weren't UUIDs (a count only);
  - each label as a bookmark, at the latest message below it on the default chain (shim plan answer 10), pinned or
    following by the shim plan's D24 (its wording, then the old chat files, then the backup; otherwise following,
    listed in a warning);
  - each owner's pointer (`characters.active_chat`, the group's) as a pointer move of the deterministic (user, tree)
    session, so a third-party caller and a sessionless tab land where today's server would open that character;
  - each `default_child_id` that isn't the newest reply as a fork selection by that same session (today's choice,
    "the last choice anyone made there"); each `opening_choices` row by materialising that greeting's row and
    selecting it, as the select action would (thin-client audit item 9);
  - token caches are a cache (Q-C6): not converted.
- Chat metadata, on label rows today (answered, coordinator, 10-03, from Data safety): each label's `chat_metadata`
  is recorded as state changes (author kind `migration`) at the message the label is on today (its own node), not
  where its bookmark ends up. Along a shared path the deeper label's values apply below it and the upper one's between
  the two; both are kept, each readable at its own position. Where a deeper label's value shadows an upper label's
  value for the same key below the deeper node, the conversion lists it in a warning: owner kind, label ids, keys,
  counts and hashes, never values or names. This replaces layer 1 step 6's "the message that bookmark points at".
- World info: every book in today's formats (`sidecar-v2`, `sidecar-v1`, upstream's World Info JSON), and every
  embedded `character_book` (a `card_extra` row today), as book and entry records. This is what
  `convert-world-info-to-sidecar.js` would have done, read straight into the engine.
- Speakers by id (answered, coordinator, 10-10): a message names its speaker by the character's (or persona's) id; its
  display name is read from the character, and a name is stored on the message only where it differs from that (Q-X3).
  So renaming a character renames it in every chat, groups included, by writing only the character. Until this lands,
  the thin-client audit's character rename leaves group chats' stored speaker names as they are (a known gap this
  closes); the conversion turns each message's stored name into the speaker id where it matches the character, and
  keeps it as the message's own name where it doesn't.
- Lorebook links by id (answered, coordinator, 10-10, from Storage: a name is a value, not an identity): every link to a
  book is converted from its name to the book's id, so renaming a book writes only the book. That covers the chat-bound
  link in chat metadata (`world_info`, becoming state), a character's primary link (`data.extensions.world`), the
  auxiliary links (`world_info.charLore`), persona lorebooks and the global selection. A name that resolves to no book
  is listed in a warning, each with where it was found. Until then, the thin-client audit's
  `book/rename` retargets the open chat's link only, as today (a known gap this closes).
- Prompt itemizations (thin-client audit step 5): the `itemizations` table of `message-tree.sqlite`, one per message
  node (zstd-compressed JSON, `has_raw_prompt`), each becoming that message's itemized prompt record (D14).
- Prompt itemizations from before step 5: the per-chat files under `<user>/itemized prompts/` (`<chat>.json.zst`),
  folded in here ({{user}}, 10-10: every one-off runs once, together, after the whole backlog, so they are converted
  once, not first onto the table and then again). Until this runs, those replies show no Prompt button; the files are
  untouched. The rules are those of the deleted `convert-itemized-prompts-to-nodes.js` (in 046d913ce, with its test):
  - read both stored formats (one zstd frame; the `IPL1` log of a `full` frame and `append` frames, stopping at the
    first unreadable frame) and every entry form (a plain list, the pooled `{pool, entries}` with `{$r}` references,
    the older `rawPromptDelta` form with `dedup`, decoded with diff-match-patch);
  - a file names its chat by the chat's name or a node id; each entry goes to the message at its position (`mesId`)
    down that chat's current path in `message-tree.sqlite` as it is when this runs, the message the page showed it for;
  - not converted, and listed in a warning (counts and ids, never contents): an entry past the chat's end, a later
    entry for a position that already had one (the page showed the first), an entry for a message that already has a
    row in `itemizations` (the table's is newer), every entry of a file whose chat can't be found or is named by more
    than one character or group, and a file that can't be read;
  - the files are left where they are, as the other old files are.
- Avatars: each character's image file renamed to its content hash (4.6). A rename, not a copy: reflinks and the
  image bytes are untouched. Identical images become one file. Routes taking the avatar id resolve it to the file.
- Folded in, because running them as their own scripts after the conversion would write data the conversion had just
  written and then change it (CLAUDE.md Boot and batches: a cutover "writes only what changes"; {{user}}: "absolute
  minimum disk writes"):
  - the group chat repair (`restore-group-chat-migration-losses.js`, decided: dry run, run, delete): the converter
    reads each damaged chat's `.pre-migration` file and backup as that script does and writes the repaired chat
    (message 1 restored in front of message 2, message 2's alternatives copied, the backup's metadata as state). Its
    refusals and listings carry over into the converter's dry run and warnings;
  - the zztest cleanup (`cleanup-zztest-leftovers.js`): its 3 test records are not converted, and the converter lists
    them, as that script did.
- Messages' `extra.token_count`, stored before the thin-client audit's step 10: derived for display, not converted
  (dropped from each message's content).
- Not read: derived and bookkeeping tables (orders, counts, ranks, `name_order`, change logs, `activity_pending`,
  digests, `chat_stats_pending`, token caches); the tantivy indexes; `chat-metadata.sqlite` (the check below);
  `saved_views` (stage 6's one-off).
- Old files are left where they are and never read by the server again. The user deletes them after a clean start,
  as with the 5c converter's `.pre-fields.sqlite`. The 15,540 `*.pre-migration` files stay too.
- `--dry-run` writes nothing and prints what `--apply` would do: counts per kind, every warning, repaired chats with
  message counts, the zztest records. `--apply` builds the store in a new directory and verifies before it swaps in:
  every card's `canonicalCardHash()` against `cardWithStoredFav(card_json, fav)`; every message, label and book counted
  against the source; every opened position's path against the old default-chain path. Any mismatch stops it, lists
  the ids, and leaves everything as it was. It checks free disk first.
- Measured on the synthetic library (`walrepro/pristine`) and the repo's test data: time, bytes written against the
  live data (each value once plus the derived entries), scaled to 381k cards as redesign 5f did (5f: 16.3 GB written,
  a 13.7 GB file for the fields layout).

**5f. the cut.** One commit switches every library, chat, search and world-info route to the engine and deletes the
old path:
- Deleted from the server: `character-metadata-db.js` and its readers and writers (except `saved_views`, below),
  `character-card-reader.js`'s SQLite parts, `character-store-schema.js`, `message-tree-db.js`, `message-tree-meta.js`,
  `message-stats.js`, the tantivy search indexes and `search-index-worker.js`, `metadata-migration-coordinator.js` and
  `metadata-migration-worker.js`, `sqlite-engine.js`'s statement API (the remove-migrations and rule-violations items
  on it go with it). The coordinator's four ongoing passes become record writes: a tag delete with merge, a tag
  reorder and the settings tag import are records; `/api/stats/recreate` answers as upstream does with nothing to
  recount, since stats are exact at commit.
- `@oxdev03/node-tantivy-binding` leaves `package.json`. `better-sqlite3` stays until stage 6 (saved views) and the
  one-offs that read SQLite are deleted.
- The server opening a user directory whose data isn't in the engine fails at startup with one line naming
  `convert-to-engine.js`.
- One-off scripts deleted unrun in this commit (folded into `convert-to-engine.js` or made pointless by it):
  `convert-character-store-to-fields.js`, `convert-world-info-to-sidecar.js`, `restore-group-chat-migration-losses.js`,
  `cleanup-zztest-leftovers.js`, `upgrade-message-stats.js` (the triggers it drops are in a file the converter only
  reads). `probeConfiguredServer()`, which the others import from `cleanup-zztest-leftovers.js`, moves to
  `src/migrations/probe-server.js` (picked name).
- `check-chat-metadata-cache.js` is rewritten to compare the cache's `chat_metadata_json` against the engine's state at
  each converted label's node, so it runs after the conversion (it read the tree "as the repair left it", and the
  repair is now inside the conversion). `check-tags-json-migrated.js` reads only the old metadata file, which the
  conversion leaves in place: unchanged.
- Tests: suites of deleted modules go; each sub-step's tests cover its replacement (CLAUDE.md Tests: only those
  covering what changed).

**Stage 5 measured against** (design §6 and §8, today = redesign 5f at 5bddd179b; harness `walrepro/measure5f.mjs`
for today, the stage 2 harness for the engine):

| action | today | engine: per isolated action | engine: derived, amortized |
|---|---|---|---|
| fav flip | 61.3 frames, unsynced | record ~5–6 B + one sync | entries × log_δ N per affected structure |
| tag assign / unassign | 33.7 / 28.4 | ~10 B + sync | membership 2 + the tag's orders + counts |
| one-word field edit | 31.2 | ~20–40 B + sync | that field's changed terms; `data_size` orders |
| message append (600 B) | 14.4, 2 commits | ~620 B + sync | children, stats, activity orders, postings |
| world-info entry edit | manifest rewrite + directory listing, O(E) | the edit + sync | the book's order, postings |

Plus: device bytes per sync under concurrent load (shared syncs); boot: the server listens before replay, and the
replay after a kill is bounded by L; the stage 3 read bounds on the real derivers (a library page, a session list, a
bookmark list, opening a position).

**What stage 5 makes obsolete, finishes or leaves**

`2026-10-03-storage-redesign.md`:
- step 5 (fields layout): obsolete. The library leaves SQLite, and its converter is deleted unrun. 5a's
  `splitCard()` / `assembleCard()` / `canonicalCardHash()` are kept and used.
- step 6 (per-tag data on first need): finished by 5a, in the corrected form (every tag, at commit).
- steps 7 (message tree), 8 (tags), 9 (groups; finding a group by chat id becomes a lookup), 10 (world info, embedded
  books): finished by 5b, 5a, 5a and 5c.
- step 11 (settings): stage 7.
- Section 7's activity queue, change-log compaction, counters in the write path, `name_order`, `random_ranks`: obsolete
  (derived at commit).

`2026-10-03-remove-migrations.md`:
- step 7's run order: replaced by section 6 below.
- step 8 (rename the coordinator and worker): obsolete; both are deleted at 5f.
- the four derived fills ("6" in its table): obsolete.
- the `chat-metadata.sqlite` decision ("yes iff no loss"): kept, via the rewritten check.

`2026-10-03-backlog.md`:
- 1a items 1 (run the 5c conversion), 5–9: obsolete or finished as above; item 10 (settings): stage 7; item 2's
  `getEntry()` leftovers go with the module. The non-string name divergence is left: the name order folds a string
  name and sorts any other as ''.
- 1b steps 7–8: as for remove-migrations above.
- 1c: the tantivy writer heap limit, the search plan leftovers (edge n-grams, reclaiming deleted docs, the count
  sampler, `name_sort_key`, the live bench rerun, which stage 4's measurements stand in for), and the rule-violation
  `.all()` sites in `character-metadata-db.js` and `sqlite-engine.js`: obsolete. Left: residency phase 5's client
  items, the characters-dir watcher leftovers, `/api/stats/get`, affected-tests, fast e2e, script.js decomposition,
  the SSOT audit.
- 1c idat dedup: left (its own plan). It works on avatar files, which 5e renames to content-hash names, so its steps
  get re-read against that before it is built.
- 2a, the thin-client audit: not ordered by this plan (5b); item 10 becomes layer 1's state action.
- 2b: the chat-as-bookmark shim is superseded by 5b, except its D24 classification and answer 10, which 5e uses;
  auto-named bookmark cleanup, upstream compat breaks, persona per path, quiet prompt drop, example messages and the
  tokenizer items are left (persona lock and chat-bound settings are state keys from 5b on, which persona per path is
  re-read against).
- 5: the chat ↔ lorebook reverse map reads `messages.metadata` with `json_extract`, which no longer exists: left,
  re-read against 5b / 5c before building. Lorebook wiki: activation records become an engine record kind when its
  step 2 is built.
- 6: state layer 1 is built inside 5b (its storage step and step 6 replaced as above).

### stages 6–11: the independent stores

Each moves one store onto the engine, adds its record kinds, derivers and routes, and adds its one-off. Order picked:
- **6, saved views**: after 5f they are the only thing the server still keeps in SQLite (`saved_views` in
  `character-metadata.sqlite`). Moving them first takes SQLite and `better-sqlite3` out of the server's runtime.
- **7, settings**: today's worst remaining write. A setting change rewrites its whole top-level file and reads every
  settings file (`settings.js:267-301`, design §8). Each settings path becomes a value; upstream's `settings.json`
  stays an import; `/api/settings/get` is assembled on read and streamed. The persona paths inside `power_user` are
  left to stage 8.
- **8, personas**: each persona value (D11), taken out of `power_user`; persona avatar files are left as they are.
- **9, presets; 10, themes; 11, quick replies**: the least frequent writes. Each preset, theme and quick-reply set is
  an item whose values are its own records, by path. CLAUDE.md Storage forbids storing it as an exchange-format blob,
  so "as items" (design D11) can't mean one JSON value. A whole-item save from an upstream route writes records only
  for the paths that changed.

Each adds `src/migrations/convert-<store>-to-engine.js` (picked names: `saved-views`, `settings`, `personas`,
`presets`, `themes`, `quick-replies`), reading today's files as they are on disk, writing records, leaving the old
files in place, with the same `--dry-run` / `--apply --server-stopped` shape and checks as 5e.

Secrets (N27) aren't in the design's base data (D11), so they stay as they are.

Measured: for each, a one-value change costs O(changed bytes) + one sync, against today's whole-file rewrite (and for
settings, the read of every settings file); a whole-item upstream save that changes one path writes one record.

Obsoletes: redesign step 11 (stage 7); backlog 1a item 10 (stage 7).


## 4. answered stops, most recent first

## 4e. tenth stop (answered in 5e): converted labels sharing a message

## 4d. ninth stop (answered above): a tab opening another tree keeps its session

## 4c. eighth stop (answered above): how a request carries its session

The compat identifiers come "from the current session (the one open in this tab)". The session a tab has open is
browser state (design N15; D7: "Which session a tab has open, and the device's default, are browser state"). But the
values are answered by server routes: `chat` in `/api/characters/all`, `/get` and `/batch` rows; `chat_id` in
`/api/groups/all`; and the chat routes that take a chat name (`/api/chats/get`, `/save`, `/rename`, `/delete`,
`/export`, `/group/get`, `/group/save`). Those routes are also called by callers with no tab (Compat: every server
route). Nothing given says how a request tells the server its session, or what these routes answer and resolve when a
request names none.

**Question:** how does a request carry the tab's session to the server (for example a header the page sends on every
request), and what do the routes that answer or take a chat name do for a request that carries none (a third-party
caller, or a tab that has no session yet)?

## 4b. seventh stop (answered above): what upstream sees as the current chat

## 4a. sixth stop (answered above): how the stores are grouped into stages

The store stages come next. Each moves stores from today's files onto the engine, adds its record kinds and
derivers, and adds a one-off to the run order. Today's stores:
- `character-metadata.sqlite`: characters and cards, tags, group rows, saved views, counters, orders, change logs,
  bulk jobs, local import bookkeeping;
- `message-tree.sqlite`: messages, owners, labels, opening choices, message stats, token caches;
- the two tantivy indexes;
- group JSON files;
- world-info books (`sidecar-v2`);
- settings, presets, themes, quick replies and personas files.

Some of them derive into each other in the design:
- a message append updates the library's activity orders and per-owner stats (design 5);
- a character rename updates groups' member-name postings;
- embedded books are card values (D1) in the same entry storage as world books (redesign step 10).

Moving such stores at different times means interim code writing across the engine and SQLite in one action. Moving
them together means one larger stage. Settings, presets, themes, quick replies, personas and saved views derive into
nothing else. Nothing given says how the stores are grouped into stages or in what order.

**Question:** how are the stores grouped into cutover stages, and in what order? For example: everything in one
stage; the library, chats, search and world info together, with the independent stores after; or one store per
stage, and then which first?

## 5. answered stops (in order)

1. Engine language and placement: section 2.
2. Where prebuilds are published: GitHub releases of `pterror/SillyTavern` (section 3, stage 1).
3. What a release is looked up by: the source hash; the wasm is a release asset, not committed (stage 1).
4. Names: section 2's last paragraph.
5. Where the derivation lives: Rust, in `st-engine` (stage 3).
6. How the stores are grouped: one cutover stage for library, chats, search and world info; the independent stores
   one stage each after it (section 3, before stage 5).
7. What upstream sees as the current chat: `chat_metadata` is state at the session's position, writes are client
   actions, the identifiers come from the session (5b). Also corrected: per-tag orders for every tag, at commit (5a).
8. How a request carries its session, and what routes answer without one (5b).
9. A tab opening another tree keeps its session (design 4.1); sessionless requests get the deterministic (user, tree)
   identifier (5b).
10. Converted labels sharing a message: each label's metadata on its own node, shadowed keys listed (5e).

## 6. the one-off run order

Run once, after the whole backlog, with the server stopped ({{user}}: "no reason not to do it after the entire task
queue is done"), each deleted in its own commit once run. The old prompt itemization files have no script of their
own: `convert-to-engine.js` converts them (5e).
1. `check-tags-json-migrated.js`: reads only the old `character-metadata.sqlite`.
2. `convert-to-engine.js` (stage 5): `--dry-run`, then `--apply --server-stopped`.
3. `check-chat-metadata-cache.js` (rewritten at 5f): reads the engine; `--apply` deletes `chat-metadata.sqlite` only
   when nothing is found only there.
4. `convert-saved-views-to-engine.js` (6).
5. `convert-settings-to-engine.js` (7).
6. `convert-personas-to-engine.js` (8): after 5, since the persona paths are left out of the settings conversion.
7. `convert-presets-to-engine.js`, `convert-themes-to-engine.js`, `convert-quick-replies-to-engine.js` (9–11).

Deleted unrun at 5f: `convert-character-store-to-fields.js`, `convert-world-info-to-sidecar.js`,
`restore-group-chat-migration-losses.js` and `cleanup-zztest-leftovers.js` (both folded into 2),
`upgrade-message-stats.js`.

## 7. stages in one line each

1. Crate and prebuilds: `engine/` (`st-engine`), CI releases by source hash, postinstall fetch, loader.
2. Record log: blocks, records, group commit, torn-tail recovery; measured at one sync per isolated commit.
3. Derived keyspace: buffer, runs, tiered merges, cleaning, replay, Rust derivers; measured on synthetic data at
   10^6–10^8 entries.
4. Search: postings, BM25, n-grams, folding, phrases; measured against design 7.5 and today's search medians
   (built).
5. Library, chats (sessions, bookmarks, state), world info and search cut over in one commit after sub-steps 5a–5e;
   one-off `convert-to-engine.js`.
6. Saved views (takes SQLite out of the server).
7. Settings.
8. Personas.
9. Presets. 10. Themes. 11. Quick replies.

