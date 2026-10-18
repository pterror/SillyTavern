# Engine core: contract and quality bar

What the core promises its users, how each promise is checked, and the bar the code is held to. The core is the
record log, the derived keyspace and the derivation framework. SillyTavern's derivers (library, tags, books,
history, chat, sessions) and the search index are users of the core: nothing in the core knows a card, a book or a
chat. Where today's code doesn't keep that boundary, it is listed under known violations.

Marks: **[verified]** read in the code or checked by a test or measurement on 2026-10-18; **[reasoned]** follows
from the code but nothing checks it; **UNTESTED** a guarantee no test checks.

## Concepts

- **Record log** (`src/log/`). Records are appended in commit order by one writer. A record's position (file index
  and offset) is how derived entries name it. Commits that arrive while a sync runs join the next sync (group
  commit). Files are cleaned once their live share falls below `LIVE_FRACTION`: live records are copied to the log's
  end after a `moved` marker, derived entries are repointed through the commit path, then the file is removed.
  Opening replays the log past the newest run's covered position. [verified]
- **Derived keyspace** (`src/keyspace/`). One shared in-memory buffer of sorted entries, flushed into immutable
  runs; runs merged in tiers of `fan_in`. A value is a `Val`: `Put`, `Del`, or an associative operand (`Add`, `Max`,
  `Map`, `MaxMap`, `AddMap`) folded with what is below it on read and on merge (`val::fold`). Deletions are dropped
  only by a merge that includes the oldest run. [verified]
- **Derivers** (`src/store/derive.rs`). One deriver per record kind, run at commit and at replay by the same code,
  so both produce the same entries. A deriver reads through a `View` (published entries plus the commit's own
  unpublished layers) and emits entries. Target, not yet true: derive plus an associative combine of partial
  results, one implementation at every batch size, writes that don't read first. [reasoned]
- **Reads.** Point gets, sorted multi-gets, forward and reverse limited scans (pages) over `[start, end)`, all
  against a consistent snapshot of buffers and runs. [verified]
- **Search** (`src/search/`) is a user of the core: its postings, term counts and block maxima are derived entries.

## API surface used by the SillyTavern layer

`Store::open(dir, cfg)`; `Store::commit(records, done)`, whose `done` runs once its group is durable and
published; reads through a `View`: `get`, `scan_vals`, `scan_vals_rev`, `estimate` (and `Keyspace::get` and the
scans underneath); `Store::stats`; `Store::close` (flushes so runs cover the log). Derivers implement `Deriver`
(`derive`, `partition`, and optionally `prepare` and `expand`, which may change a record before it is laid out).
[verified in `store/mod.rs`, `store/derive.rs`, `keyspace/mod.rs`. `store_binding.rs` adds SillyTavern-specific
reads on top, which belong outside the core]

## Guarantees

| # | Guarantee | Checked by |
|---|---|---|
| G1 | **Durability.** When `commit` resolves, its records are synced; a crash after that never loses them. | `log::tests::concurrent_commits_share_syncs_and_each_resolves_after_its_own`, `store::tests::after_a_crash_replay_restores_every_acknowledged_commit` [verified] |
| G2 | **No invented data.** After a crash, opening yields exactly the whole groups written; a torn or damaged tail is dropped, damage before whole groups refuses to open and changes nothing. | `log::tests::every_truncation_point_reopens_to_exactly_the_whole_groups`, `damage_with_whole_groups_after_it_refuses_to_open_and_changes_nothing`, `a_corrupted_last_group_is_dropped` [verified] |
| G3 | **A failed write or sync stops the store**: no later commit is acknowledged until reopen (`LogError::Failed`, `StoreError::Failed`). | **UNTESTED** (no test injects a write or sync failure) |
| G4 | **Merging, flushing and cleaning are invisible**: every read returns the same values before, during and after them. | `keyspace::tests::reads_merge_buffers_and_runs_through_flushes_and_merges`, `added_maps_survive_flushes_merges_and_a_reopen`, `store::tests::derived_values_follow_commits_through_flushes_merges_and_reopens`, `cleaning_drops_replaced_records_and_keeps_every_live_one`, `history_tests::commits_that_read_what_they_change_stay_right_while_the_log_is_cleaned_flushed_and_merged`, `carriers_tests::queries_while_carriers_move_equal_the_queries_once_everything_settles`; randomized: `keyspace::model_tests::random_writes_flushes_merges_and_reopens_read_as_the_model_says` (every value kind, commits of random sizes, gets, pages up and down, snapshots held across writes, flushes, merges and reopens at random points, against a plain model), `history_tests::random_history_reads_as_the_model_says_through_flushes_cleaning_and_reopens` (with cleaning), and the seedable `chat_tests`/`tags_tests` model runs. Operation sequences are seeded and replayable; the interleaving of background flushes and merges with them is still real-thread timing. [verified, partially] |
| G5 | **A limited scan returns fewer than `limit` entries only when the range holds no more.** | `keyspace::tests::a_scan_reads_on_past_a_buffers_cut_page_whatever_the_runs_hold_beyond_it` (50d22b76c), `removed_maps_in_a_buffer_hide_a_runs_maps_past_a_page_in_every_scan`; randomized: `keyspace::model_tests` churns never-used keys (values set then undone in one commit) and pages over them before a flush — with 50d22b76c reverted it fails at seed 1, step 11 [verified] |
| G6 | **A commit sees only what came before it**: derivers read published entries plus earlier groups and the commit's own earlier records; a commit's per-job read memo never serves a value changed since. | `store::tests::concurrent_commits_share_syncs_and_each_sees_the_ones_before`, `history_tests::commits_that_read_what_they_change_…` (6fe84eccf) [verified] |
| G7 | **A commit that can't apply writes nothing.** | `store::tests::a_commit_that_cant_apply_writes_nothing` [verified] |
| G8 | **Memory is bounded by constants** independent of data: buffer B, block cache C, one top index block per run. | `keyspace::tests::keyspaces_sharing_a_pool_stay_within_its_budget_together`, `tests/bulk_budget.rs` (bulk path only). Top blocks per run and the cache's bound under load: **UNTESTED** |
| G9 | **Space is bounded**: total bytes ≤ k × live bytes. | **UNTESTED, and violated**: 35% of the baseline's runs were dead (measured); no bound is stated or enforced until the merge triggers land. |
| G10 | **Cost bounds**: a point get reads O(levels) blocks per run; a page reads O(limit) entries plus a few blocks per run; commit cost per record is flat in commit size. | `a_narrow_page_down_reads_few_blocks_in_each_run`, `a_range_estimate_reads_few_blocks_and_comes_near_the_count`, `store::tests::a_page_reads_a_commits_own_entries_only_as_far_as_it_goes` (61748e3c2). Point-get blocks per run, log record read cost: **UNTESTED** |
| G11 | **A batch never costs more per item than single writes.** | Measured only (`examples/commitsize.rs`, 61748e3c2: 44–49 µs/record from 500 to 32k records). No test asserts it across sizes beyond G10's page bound: **UNTESTED** as a test |
| G12 | **Replay derives exactly what commits derived.** | Same deriver code at both (`derive.rs`); `after_a_crash_replay_…`, `a_bulk_load_derives_what_commits_derive` [verified] |
| G13 | **Opening is bounded**: footers and top blocks plus the log tail. | Stated in `store/mod.rs`; the tail can reach `LOG_BYTES` (64 MB), measured at ~4.3 s per 1.6 MB replayed, so up to minutes after a crash [reasoned]. **UNTESTED** as a bound |

## Quality bar

| Practice | Today | Missing |
|---|---|---|
| Deterministic simulation of concurrency and crashes (seeded scheduler driving commits, flush, merge, clean, crash) | None. Concurrency tests rely on real threads and timing (`carriers_tests` failed 1 in 7 only with other merge timing). | A simulator over the engine's activities (`keyspace/exec.rs`) and I/O, replaying any failing seed exactly. |
| Model-based tests against a trivial reference model | Fixed scripts in places (`keyspace/tests.rs`, `store/tests.rs`, `library_tests.rs`, `tags_tests.rs`, `books_tests.rs`, `carriers_tests.rs`, `searched_tests.rs`, `state_tests.rs`); seeded random sequences in `keyspace::model_tests` and `history_tests::random_history_…`; `chat_tests` and `tags_tests` models take `ST_MODEL_SEED`. `ST_MODEL_SEEDS`/`ST_MODEL_BASE`/`ST_MODEL_STEPS` lengthen runs. | Random models for books, library and search; crashes (not only clean reopens) at random points. |
| Fault injection | Truncation and corruption of log files (`log/tests.rs`), missing runs (`a_missing_or_damaged_run_refuses_to_open`, `a_log_whose_runs_are_missing_after_cleaning_refuses_to_open`), a crash during bulk install. | Failed `write`/`fsync`, full disk, a crash between every pair of steps (flush, run rename, merge install, cleaning removal), torn run files. |
| Fuzzing every decoder | Seeded byte-mutation harnesses (no cargo-fuzz on this toolchain): `keyspace::fuzz_tests` (values and map/count encodings round-trip; blocks, also with the checksum recomputed over the damage, under every cursor; whole runs and footers), `log::tests::fuzz_damaged_log_files_never_panic_and_an_opened_log_reads_whole` (item-by-item scans decoding and stepping over, and opening). `ST_FUZZ_SECS` sets the length. | Coverage-guided fuzzing (cargo-fuzz needs nightly); the encodings decoded above `log::format` (chat and session values, JSON fields). |
| Cost bounds as tests | Some: blocks per page, range estimate, reads per page of a commit's own entries. | Point gets, commit reads per record by kind, log record read cost, opening cost. |
| Benchmarks tracked over time | `examples/` and `tests/` measurement programs (`commitsize`, `measure`, `edits`, `chat`, `library`, `search`), run by hand. | Recorded baselines on realistic data and a regression check. |
| No known correctness bug ships | Not met until 50d22b76c: the scan bug was in production. | A rule enforced at review. |
| Every fix with a deterministic regression test | 50d22b76c, 61748e3c2 and today's keyspace/store/log fixes each added one. | Not yet a rule; G4's test only fails 1 in 7 without the fix. |

## Known violations and open items

- **No per-run filters.** Every point get probes every run (14 on the baseline); ~70% of gets find nothing in any
  run (measured). Partitioned filters through the block cache would bound it; resident filters would cost ~520 MB.
- **No block compression.** The same data takes 10.5 GB in RocksDB with LZ4/ZSTD against 18.1 GB here (measured).
- **Record identity is unstable under cleaning.** Positions change when records move; change ids and feed cursors
  can't be positions. Design: a stable sequence number per record and one index to its current position.
- **Garbage collection.** Merges are size-tiered only and rarely reach the oldest run, so deletions and old
  versions stay (35% of runs dead, measured). Size-ratio and deletion-density triggers are built but not committed:
  full merges must first run in bounded steps.
- **Three current-value heads** (TEXT, JSON_HEAD, VALUE) where one typed head would do; together ~33% of history's
  derived writes (measured).
- **Keys built from mutable values** (library orders, free-uid ranges, session recency indexes) churn tombstones:
  FREE holds 21× more dead keys than live (measured).
- **Search layout.** 5.5 GB live: block maxima for one-document terms, a dictionary per lorebook, stored prefixes
  (measured). Standard layouts store bounds only for terms with ≥128 documents (sourced; estimate reasoned).
- **The boundary.** History, books, library and tags logic live in `src/store/` beside the core, and `bulk.rs`
  duplicates the write path (2,254 lines); `store_binding.rs` carries SillyTavern reads.
