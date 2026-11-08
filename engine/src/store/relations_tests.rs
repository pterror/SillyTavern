use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::books::{BOOK, ENTRY, EntryKey};
use super::chat_read::Js;
use super::relations::{
    self, DELETION_IN_PROGRESS_BY_ENTITY, DELETION_IN_PROGRESS_BY_KEY, KINDS_BEING_MERGED,
    RELATION_COUNT_BY_KIND_AND_TARGET, RELATIONS_BY_TARGET, RELATIONS_OF_ENTRY,
    RELATIONS_REMOVED_BY_DELETION,
};
use super::world_order_tree::{self as tree, ORDER_TREE_COUNT, ORDER_TREE_EDGE, ORDER_TREE_HELD};
use super::*;
use crate::log::format::{FieldRef, Record, Value, kind_by_name};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-relations-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

const SMALL: StoreConfig = StoreConfig {
    log: log::Config {
        block_size: 256,
        file_target: 8192,
    },
    ks: KsConfig {
        log_bytes: 16 << 10,
        fan_in: 3,
        block_size: 512,
        max_frozen: 1,
    },
    live_fraction: 0.5,
    relocate_bytes: 1024,
};

fn pool() -> Arc<Pool> {
    Pool::new(64 << 10, 256 << 10, 4, 1, 2, 2)
}

pub(super) fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

pub(super) fn text(text_literal: &str) -> Value {
    Value::Text(text_literal.as_bytes().to_vec())
}

pub(super) fn create(entity: u64, kind: u64, key: &str) -> Record {
    rec(
        "entityCreate",
        vec![
            Value::Id(entity),
            Value::UInt(kind),
            text(key),
            Value::F64(0.0),
        ],
    )
}

pub(super) fn set_json(entity: u64, field: FieldRef, json: &str) -> Record {
    rec(
        "jsonValue",
        vec![
            Value::Sel(0, entity),
            Value::Field(field),
            text(json),
            Value::Absent,
            Value::Absent,
        ],
    )
}

pub(super) fn set_text(entity: u64, field: FieldRef, text_literal: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Sel(0, entity),
            Value::Field(field),
            text(text_literal),
            Value::Absent,
            Value::Absent,
        ],
    )
}

pub(super) fn drop_value(entity: u64, field: FieldRef) -> Record {
    rec(
        "valueDelete",
        vec![
            Value::Sel(0, entity),
            Value::Field(field),
            Value::Absent,
            Value::Absent,
        ],
    )
}

pub(super) fn index(entity: u64, book: u64, display_index: Option<f64>) -> Record {
    rec(
        "entryIndex",
        vec![
            Value::Id(entity),
            Value::Id(book),
            display_index.map_or(Value::Absent, Value::F64),
        ],
    )
}

pub(super) const IN: u64 = 1;
pub(super) const OWES: u64 = 2;

pub(super) fn json_of(rels: &[(u64, u64, &str, bool)]) -> String {
    let items: Vec<String> = rels
        .iter()
        .map(|(kind, target, position, weak)| {
            let weak_suffix = if *weak { r#","weak":true"# } else { "" };
            format!(r#"{{"kind":{kind},"target":{target},"position":"{position}"{weak_suffix}}}"#)
        })
        .collect();
    format!("[{}]", items.join(","))
}

pub(super) fn strong(rels: &[(u64, u64, &str)]) -> String {
    let with_strength: Vec<_> = rels
        .iter()
        .map(|(kind, target, position)| (*kind, *target, *position, false))
        .collect();
    json_of(&with_strength)
}

pub(super) fn book(store: &Store, id: u64, key: &str) {
    store
        .commit_wait(vec![
            create(id, BOOK, key),
            set_json(id, FieldRef::Code(books::DEFINED), ""),
            set_text(id, relations::relation_kind_field(IN), "in"),
            set_text(id, relations::relation_kind_field(OWES), "owes"),
        ])
        .unwrap();
}

fn read<T>(store: &Store, field: impl FnOnce(&derive::View) -> StoreResult<T>) -> T {
    store.chat_read(field).unwrap()
}

const B: u64 = 1;

type SourcesByPosition = Vec<(Vec<u8>, u64)>;

#[derive(Clone, Default)]
struct Ent {
    own_key: u64,
    index: Option<f64>,
    rels: Option<String>,
}

#[derive(Default)]
struct Model {
    entries: BTreeMap<u64, Ent>,
}

impl Model {
    fn set(&self, entity: u64) -> relations::RelationSet {
        self.entries[&entity]
            .rels
            .as_deref()
            .map(|json| relations::parse_relations_field(json.as_bytes()))
            .unwrap_or_default()
    }

    fn top(&self, kind: Option<u64>) -> Vec<u64> {
        let mut ordered: Vec<(u64, u64)> = self
            .entries
            .iter()
            .filter(|(entity, _)| {
                kind.is_none_or(|kind| {
                    !relations::strong_kinds(&self.set(**entity)).contains(&kind)
                })
            })
            .map(|(entity, entry_state)| {
                (
                    relations::world_order_value(
                        entry_state.index,
                        &EntryKey::Int(entry_state.own_key),
                    ),
                    *entity,
                )
            })
            .collect();
        ordered.sort();
        ordered.into_iter().map(|(_, entity)| entity).collect()
    }

    fn groups(&self) -> BTreeMap<(u64, Vec<u8>), SourcesByPosition> {
        let mut groups_by_target: BTreeMap<_, Vec<_>> = BTreeMap::new();
        for entity in self.entries.keys() {
            for ((kind, target), relation) in self.set(*entity) {
                groups_by_target
                    .entry((kind, target))
                    .or_default()
                    .push((relation.position, *entity));
            }
        }
        for sources in groups_by_target.values_mut() {
            sources.sort();
        }
        groups_by_target
    }

    fn uids(&self) -> Vec<u64> {
        self.entries
            .values()
            .map(|entry_state| entry_state.own_key)
            .collect()
    }

    fn check(&self, store: &Store) {
        let book_tree = relations::order_tree_space(B);
        for kind in [None, Some(IN), Some(OWES), Some(9)] {
            let want = self.top(kind);
            read(store, |view| {
                assert_eq!(
                    tree::top_level_count(view, &book_tree, kind)?,
                    want.len() as u64,
                    "{kind:?}"
                );
                let all: Vec<u64> =
                    tree::top_level_from_rank(view, &book_tree, kind, 0, usize::MAX)?
                        .iter()
                        .map(tree::entity_of_order_key)
                        .collect();
                assert_eq!(all, want, "{kind:?}");
                for skip in [1, 3, 7] {
                    let got: Vec<u64> = tree::top_level_from_rank(view, &book_tree, kind, skip, 3)?
                        .iter()
                        .map(tree::entity_of_order_key)
                        .collect();
                    let from = (skip as usize).min(want.len());
                    assert_eq!(
                        got,
                        want[from..(from + 3).min(want.len())],
                        "{kind:?} at {skip}"
                    );
                }
                for (step_number, entity) in want.iter().enumerate() {
                    let entry_state = relations::order_key_of_entry(
                        view,
                        *entity,
                        &EntryKey::Int(self.entries[entity].own_key),
                    )?;
                    assert_eq!(
                        tree::top_level_rank(view, &book_tree, &entry_state, kind)?,
                        step_number as u64,
                        "{kind:?} rank of {entity}"
                    );
                }
                Ok(())
            });
        }
        let groups = self.groups();
        read(store, |view| {
            for ((kind, target), sources) in &groups {
                assert_eq!(
                    relations::count_of_relations_of_kind_targeting(view, B, *kind, target)?,
                    sources.len() as u64
                );
                let prefix = relations::relations_of_kind_targeting_prefix(B, *kind, target);
                let got: Vec<u64> = view
                    .scan(&prefix, &kinds::key::prefix_end(&prefix), usize::MAX)?
                    .iter()
                    .map(|(key, _)| {
                        relations::position_and_source_of_relation_of_kind_targeting(&prefix, key)
                            .map(|(_, source)| source)
                    })
                    .collect::<Result<_, _>>()?;
                let want: Vec<u64> = sources.iter().map(|(_, entity)| *entity).collect();
                assert_eq!(got, want);
            }
            for entity in self.entries.keys() {
                assert_eq!(
                    relations::relations_of_entry(view, *entity)?,
                    self.set(*entity),
                    "entry {entity}"
                );
            }
            Ok(())
        });
    }

    fn pointers_rewritten(&self, gone: u64) -> Vec<(u64, String)> {
        let target = self.entries[&gone].own_key;
        let mut out = Vec::new();
        for (entity, entry_state) in &self.entries {
            if *entity == gone {
                continue;
            }
            let set = self.set(*entity);
            if !set
                .keys()
                .any(|(_, target_key)| *target_key == target.to_string().into_bytes())
            {
                continue;
            }
            let kept: Vec<(u64, u64, String, bool)> = set
                .iter()
                .filter(|((_, target_key), _)| *target_key != target.to_string().into_bytes())
                .map(|((kind, target_key), relation)| {
                    (
                        *kind,
                        String::from_utf8(target_key.clone())
                            .unwrap()
                            .parse()
                            .unwrap(),
                        String::from_utf8(relation.position.clone()).unwrap(),
                        relation.weak,
                    )
                })
                .collect();
            let _ = entry_state;
            let with_strength: Vec<_> = kept
                .iter()
                .map(|(kind, target, position, weak)| (*kind, *target, position.as_str(), *weak))
                .collect();
            out.push((*entity, json_of(&with_strength)));
        }
        out
    }
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
}

fn random_rels(rng: &mut Rng, targets: &[u64]) -> String {
    if targets.is_empty() {
        return "[]".into();
    }
    let count = rng.below(4);
    let mut rels = Vec::new();
    for _ in 0..count {
        let kind = [IN, OWES, IN][rng.below(3) as usize];
        let target = targets[rng.below(targets.len() as u64) as usize];
        let position = ["a", "b", "m", "mm", "z", ""][rng.below(6) as usize];
        rels.push((kind, target, position, rng.below(4) == 0));
    }
    json_of(&rels)
}

fn random_index(rng: &mut Rng) -> Option<f64> {
    [
        None,
        Some(0.0),
        Some(1.0),
        Some(2.5),
        Some(-1.0),
        Some(1e12),
        Some(-0.0),
    ][rng.below(7) as usize]
}

fn dump(store: &Store) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut out = Vec::new();
    for structure in [
        ORDER_TREE_EDGE,
        ORDER_TREE_COUNT.id(),
        ORDER_TREE_HELD.id(),
        RELATIONS_OF_ENTRY,
        RELATIONS_BY_TARGET,
        RELATION_COUNT_BY_KIND_AND_TARGET,
        DELETION_IN_PROGRESS_BY_KEY,
        DELETION_IN_PROGRESS_BY_ENTITY,
        RELATIONS_REMOVED_BY_DELETION,
        KINDS_BEING_MERGED,
        commit_checks::COMMIT_CHECK,
    ] {
        let prefix = kinds::key::of(structure);
        out.extend(read(store, |view| {
            view.scan(&prefix, &kinds::key::prefix_end(&prefix), usize::MAX)
        }));
    }
    out
}

fn step(store: &Store, model: &mut Model, rng: &mut Rng, next: &mut u64) {
    let entity_ids: Vec<u64> = model.entries.keys().copied().collect();
    let pick = |rng: &mut Rng| entity_ids[rng.below(entity_ids.len() as u64) as usize];
    let relations_field_of = relations::relations_field;
    match rng.below(10) {
        0..=2 => {
            let own_key = rng.below(20);
            if model
                .entries
                .values()
                .any(|display_index| display_index.own_key == own_key)
            {
                return;
            }
            let (entity, own_key) = (*next, own_key);
            *next += 1;
            let mut records = vec![create(entity, ENTRY, &format!("{B}:{own_key}"))];
            let mut ent = Ent {
                own_key,
                ..Ent::default()
            };
            if rng.below(2) == 0 {
                let mut targets = model.uids();
                targets.push(own_key);
                let json = random_rels(rng, &targets);
                records.push(set_json(entity, relations_field_of(), &json));
                ent.rels = Some(json);
            }
            if rng.below(2) == 0 {
                ent.index = random_index(rng);
                records.push(index(entity, B, ent.index));
            }
            store.commit_wait(records).unwrap();
            model.entries.insert(entity, ent);
        }
        3 | 4 if !entity_ids.is_empty() => {
            let entity = pick(rng);
            let json = random_rels(rng, &model.uids());
            store
                .commit_wait(vec![set_json(entity, relations_field_of(), &json)])
                .unwrap();
            model.entries.get_mut(&entity).unwrap().rels = Some(json);
        }
        5 if !entity_ids.is_empty() => {
            let entity = pick(rng);
            let display_index = random_index(rng);
            store
                .commit_wait(vec![index(entity, B, display_index)])
                .unwrap();
            model.entries.get_mut(&entity).unwrap().index = display_index;
        }
        6 if !entity_ids.is_empty() => {
            let entity = pick(rng);
            let rewrites = model.pointers_rewritten(entity);
            let mut records: Vec<Record> = rewrites
                .iter()
                .map(|(pointer, json)| set_json(*pointer, relations_field_of(), json))
                .collect();
            records.push(rec("entityDelete", vec![Value::Id(entity)]));
            store.commit_wait(records).unwrap();
            for (pointer, json) in rewrites {
                model.entries.get_mut(&pointer).unwrap().rels = Some(json);
            }
            model.entries.remove(&entity);
        }
        7 if !entity_ids.is_empty() => {
            let entity = pick(rng);
            let (records, json) = match rng.below(3) {
                0 => (drop_value(entity, relations_field_of()), None),
                1 => (
                    set_json(
                        entity,
                        relations_field_of(),
                        r#"[{"kind":1,"target":1.5,"position":"a"}]"#,
                    ),
                    Some("[]".into()),
                ),
                _ => (
                    set_text(entity, relations_field_of(), "in: somewhere"),
                    None,
                ),
            };
            if model.entries[&entity].rels.is_none() && json.is_none() {
                return;
            }
            store.commit_wait(vec![records]).unwrap();
            model.entries.get_mut(&entity).unwrap().rels = json;
        }
        8 if entity_ids.len() >= 2 => {
            let (first_entry, second_entry) = (pick(rng), pick(rng));
            let json_for_both = random_rels(rng, &model.uids());
            let index_for_second = random_index(rng);
            store
                .commit_wait(vec![
                    set_json(first_entry, relations_field_of(), &json_for_both),
                    index(second_entry, B, index_for_second),
                    set_json(second_entry, relations_field_of(), &json_for_both),
                ])
                .unwrap();
            model.entries.get_mut(&first_entry).unwrap().rels = Some(json_for_both.clone());
            model.entries.get_mut(&second_entry).unwrap().index = index_for_second;
            model.entries.get_mut(&second_entry).unwrap().rels = Some(json_for_both);
        }
        _ => {}
    }
}

fn fresh(model: &Model) -> Vec<(Vec<u8>, Vec<u8>)> {
    let dir = temp_dir("fresh");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&store, B, "one");
    let mut records = Vec::new();
    for (entity, entry_state) in model.entries.iter().rev() {
        if let Some(json) = &entry_state.rels {
            records.push(set_json(*entity, relations::relations_field(), json));
        }
        records.push(create(
            *entity,
            ENTRY,
            &format!("{B}:{}", entry_state.own_key),
        ));
        if entry_state.index.is_some() {
            records.push(index(*entity, B, entry_state.index));
        }
    }
    store.commit_wait(records).unwrap();
    let built = dump(&store);
    store.close();
    let _ = fs::remove_dir_all(&dir);
    built
}

#[test]
fn every_write_keeps_the_top_the_groups_and_the_counts_and_the_tree_is_the_one_a_fresh_store_builds()
 {
    let seeds: u64 = std::env::var("ST_MODEL_SEEDS")
        .ok()
        .and_then(|view| view.parse().ok())
        .unwrap_or(3);
    let steps: usize = std::env::var("ST_MODEL_STEPS")
        .ok()
        .and_then(|view| view.parse().ok())
        .unwrap_or(300);
    for seed in 0..seeds {
        let dir = temp_dir("model");
        let mut model = Model::default();
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15 ^ (seed + 1).wrapping_mul(0x2545_f491_4f6c_dd1d));
        let mut next = 100;
        {
            let store = Store::open_in(&dir, SMALL, pool()).unwrap();
            book(&store, B, "one");
            for step_number in 0..steps {
                step(&store, &mut model, &mut rng, &mut next);
                if step_number % 10 == 0 {
                    model.check(&store);
                }
            }
            model.check(&store);
            assert_eq!(
                dump(&store),
                fresh(&model),
                "seed {seed}: the tree depends on its history"
            );
            store.close();
        }
        let store = Store::open_in(&dir, SMALL, pool()).unwrap();
        model.check(&store);
        for _ in 0..steps / 3 {
            step(&store, &mut model, &mut rng, &mut next);
        }
        model.check(&store);
        assert_eq!(dump(&store), fresh(&model), "seed {seed} after a reopen");
        store.close();
        let _ = fs::remove_dir_all(&dir);
    }
}

#[test]
fn a_value_that_isnt_a_list_of_relations_holds_none_and_a_repeated_pair_counts_once() {
    let none = |json: &str| {
        assert!(
            relations::parse_relations_field(json.as_bytes()).is_empty(),
            "{json}"
        )
    };
    none("{}");
    none("[1]");
    none(r#"[{"kind":1,"target":3}]"#);
    none(r#"[{"kind":0,"target":3,"position":"a"}]"#);
    none(r#"[{"kind":"in","target":3,"position":"a"}]"#);
    none(r#"[{"kind":1.5,"target":3,"position":"a"}]"#);
    none(r#"[{"relation":"in","target":3,"position":"a"}]"#);
    none(r#"[{"kind":1,"target":3,"position":"a"},{"kind":1}]"#);
    none(r#"[{"kind":1,"target":-3,"position":"a"}]"#);
    none(r#"[{"kind":1,"target":3e2,"position":"a"}]"#);
    none(r#"[{"kind":1,"target":3,"position":"a","weak":1}]"#);
    none(r#"[{"kind":1,"target":3,"position":"a"}"#);
    let got = relations::parse_relations_field(
        r#" [ {"kind":1,"target":3,"position":"b","note":{"x":[1,2]}},
              {"kind":1,"target":"3","position":"a"},
              {"kind":7,"target":"Inn","position":"é😀","weak":true} ] "#
            .as_bytes(),
    );
    let got: Vec<(u64, Vec<u8>, Vec<u8>, bool)> = got
        .into_iter()
        .map(|((kind, target), relation)| (kind, target, relation.position, relation.weak))
        .collect();
    assert_eq!(
        got,
        vec![
            (1, b"3".to_vec(), b"b".to_vec(), false),
            (7, b"Inn".to_vec(), "é😀".as_bytes().to_vec(), true),
        ]
    );
}

#[test]
fn a_position_between_two_is_strictly_between_them() {
    let cases: [(Option<&str>, Option<&str>); 9] = [
        (None, None),
        (Some("a"), None),
        (None, Some("a")),
        (Some("a"), Some("b")),
        (Some("a"), Some("a0")),
        (Some("z"), Some("z1")),
        (Some("m"), Some("mm")),
        (Some(""), Some("0")),
        (Some("é"), Some("ê")),
    ];
    for (low, high) in cases {
        let position = relations::position_between(low.map(str::as_bytes), high.map(str::as_bytes))
            .unwrap_or_else(|| panic!("{low:?} {high:?}"));
        assert!(std::str::from_utf8(&position).is_ok());
        assert!(
            low.is_none_or(|l| l.as_bytes() < position.as_slice()),
            "{low:?} {position:?}"
        );
        assert!(
            high.is_none_or(|h| position.as_slice() < h.as_bytes()),
            "{high:?} {position:?}"
        );
    }
    assert_eq!(
        relations::position_between(Some(b"a"), Some(b"a\x00")),
        None
    );
    assert_eq!(relations::position_between(Some(b"b"), Some(b"a")), None);
}

#[test]
fn history_writes_restores_and_a_target_written_before_it_exists_keep_the_groups() {
    let dir = temp_dir("history");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    let user = 1;
    store
        .commit_wait(vec![rec(
            "keyMap",
            vec![
                Value::Sel(chat::KEYED_USER, user),
                Value::Bytes(b"user-1".to_vec()),
            ],
        )])
        .unwrap();
    book(&store, B, "one");
    let meta = |change: u64| {
        vec![
            Value::Id(change),
            Value::Time(1_700_000_000_000 + change as i64),
            Value::Absent,
            Value::Id(user),
        ]
    };
    let hist_set = |change: u64, entity: u64, json: &str| {
        let mut view = vec![
            Value::Id(entity),
            Value::Field(relations::relations_field()),
            text(json),
            Value::Bit(true),
        ];
        view.extend(meta(change));
        rec("histSet", view)
    };
    let hist_edit = |change: u64, entity: u64, at: u64, removed: u64, target: &str| {
        let mut view = vec![
            Value::Id(entity),
            Value::Field(relations::relations_field()),
            Value::UInt(at),
            Value::UInt(removed),
            text(target),
            Value::Bit(true),
        ];
        view.extend(meta(change));
        rec("histEdit", view)
    };
    let first_json = strong(&[(IN, 2, "m")]);
    store
        .commit_wait(vec![
            hist_set(1, 10, &first_json),
            create(10, ENTRY, "1:1"),
            hist_set(2, 11, &strong(&[(IN, 1, "a")])),
            create(11, ENTRY, "1:2"),
            create(12, ENTRY, "1:3"),
        ])
        .unwrap();
    let book_tree = relations::order_tree_space(B);
    let top = |store: &Store| -> Vec<u64> {
        read(store, |view| {
            Ok(
                tree::top_level_from_rank(view, &book_tree, Some(IN), 0, usize::MAX)?
                    .iter()
                    .map(tree::entity_of_order_key)
                    .collect(),
            )
        })
    };
    assert_eq!(top(&store), vec![12]);
    let at = first_json.find("\"m\"").unwrap() as u64 + 1;
    store
        .commit_wait(vec![hist_edit(3, 10, at, 1, "c")])
        .unwrap();
    assert_eq!(
        read(&store, |view| relations::relations_of_entry(view, 10)),
        relations::parse_relations_field(strong(&[(IN, 2, "c")]).as_bytes())
    );
    let mut del = vec![Value::Id(11)];
    del.extend(meta(4));
    store
        .commit_wait(vec![rec("histEntityDelete", del)])
        .unwrap();
    assert_eq!(top(&store), vec![11, 12], "the deleted entry's place holds what still targets it");
    assert!(read(&store, |view| relations::deletion_in_progress(view, B, b"2")).is_some());
    let chunk = read(&store, |view| {
        relations::rewrites_removing_relations_targeting(view, B, &[b"2".to_vec()], 1)
    });
    let (rewrites, more) = rewrites_of(&chunk);
    assert_eq!((rewrites.len(), more), (1, false));
    assert_eq!(rewrites[0].0, 10);
    store
        .commit_wait(vec![hist_set(5, 10, &rewrites[0].1)])
        .unwrap();
    assert_eq!(top(&store), vec![10, 12]);
    assert!(read(&store, |view| relations::deletion_in_progress(view, B, b"2")).is_none());
    assert_eq!(
        read(&store, |view| relations::count_of_relations_of_kind_targeting(view, B, IN, b"1")),
        0,
        "the deleted entry's own relations went with it"
    );
    let mut restore = vec![
        Value::Id(11),
        Value::UInt(ENTRY),
        text("1:2"),
        Value::F64(0.0),
    ];
    restore.extend(meta(6));
    store
        .commit_wait(vec![rec("histRestore", restore)])
        .unwrap();
    assert_eq!(top(&store), vec![10, 12]);
    let chunk = read(&store, |view| {
        relations::rewrites_restoring_relations_removed_by_deletion(view, B, 11, 10)
    });
    let (rewrites, more) = rewrites_of(&chunk);
    assert_eq!((rewrites.len(), more), (1, false));
    assert_eq!(
        relations::parse_relations_field(rewrites[0].1.as_bytes()),
        relations::parse_relations_field(strong(&[(IN, 2, "c")]).as_bytes()),
        "the restore puts back the relation as it was"
    );
    store
        .commit_wait(vec![hist_set(7, 10, &rewrites[0].1)])
        .unwrap();
    assert_eq!(top(&store), vec![12]);
    let (rewrites, _) = rewrites_of(&read(&store, |view| {
        relations::rewrites_restoring_relations_removed_by_deletion(view, B, 11, 10)
    }));
    assert!(rewrites.is_empty(), "nothing is left to restore");
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_commit_that_ends_with_a_relation_to_a_missing_entry_or_kind_is_refused_and_loops_import_in_any_order()
 {
    let dir = temp_dir("checks");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&store, B, "one");
    let relations_field_of = relations::relations_field;
    store
        .commit_wait(vec![
            set_json(10, relations_field_of(), &strong(&[(IN, 2, "a")])),
            create(10, ENTRY, "1:1"),
            set_json(11, relations_field_of(), &strong(&[(IN, 1, "a")])),
            create(11, ENTRY, "1:2"),
        ])
        .expect("a loop written in one commit");
    let refused = |records: StoreResult<Vec<u64>>| matches!(records, Err(StoreError::Refused(_)));
    assert!(refused(store.commit_wait(vec![
        create(12, ENTRY, "1:3"),
        set_json(12, relations_field_of(), &strong(&[(IN, 9, "a")])),
    ])));
    assert!(refused(store.commit_wait(vec![
        create(12, ENTRY, "1:3"),
        set_json(12, relations_field_of(), &strong(&[(5, 1, "a")])),
    ])));
    assert!(refused(store.commit_wait(vec![drop_value(
        B,
        relations::relation_kind_field(IN)
    )])));
    store
        .commit_wait(vec![drop_value(B, relations::relation_kind_field(OWES))])
        .expect("a kind nothing uses goes");
    store
        .commit_wait(vec![rec("entityDelete", vec![Value::Id(10)])])
        .expect("a delete is never refused for what targets the entry");
    assert!(read(&store, |view| relations::deletion_in_progress(view, B, b"1")).is_some());
    assert!(
        refused(store.commit_wait(vec![create(13, ENTRY, "1:1")])),
        "the key of an entry still being deleted can't be taken"
    );
    store
        .commit_wait(vec![rec("entityDelete", vec![Value::Id(11)])])
        .expect("the last relation targeting it goes with its source");
    assert!(read(&store, |view| relations::deletion_in_progress(view, B, b"1")).is_none());
    store
        .commit_wait(vec![create(13, ENTRY, "1:1")])
        .expect("then its key is free");
    assert!(
        dump(&store)
            .iter()
            .all(|(kind, _)| !commit_checks::is_check(kind))
    );
    store.close();
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    assert!(
        dump(&store)
            .iter()
            .all(|(kind, _)| !commit_checks::is_check(kind)),
        "replay drops them"
    );
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

fn edit(store: &Store, entity: relations::RelationEdit) -> Result<String, String> {
    let answer = read(store, |view| relations::relation_edit(view, B, &entity));
    let Js::Obj(fields) = answer else { panic!() };
    let get = |count: &str| {
        fields
            .iter()
            .find(|(kind, _)| *kind == count)
            .map(|(_, view)| view.clone())
    };
    match (get("refused"), get("json")) {
        (Some(Js::Text(refusal_text)), _) => Err(String::from_utf8(refusal_text).unwrap()),
        (_, Some(Js::Text(answer))) => Ok(String::from_utf8(answer).unwrap()),
        other => panic!("{other:?}"),
    }
}

#[test]
fn relation_edits_place_keep_other_items_as_written_and_refuse_what_cant_be() {
    let dir = temp_dir("edits");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&store, B, "one");
    let relations_field_of = relations::relations_field;
    let mut records = Vec::new();
    for (entity, own_key) in [(10, 1), (11, 2), (12, 3), (13, 4)] {
        records.push(create(entity, ENTRY, &format!("1:{own_key}")));
    }
    records.push(set_json(11, relations_field_of(), &strong(&[(IN, 1, "b")])));
    records.push(set_json(12, relations_field_of(), &strong(&[(IN, 1, "d")])));
    records.push(set_json(
        13,
        relations_field_of(),
        r#"[{"kind":2,"target":2,"position":"a","note":"kept"}]"#,
    ));
    store.commit_wait(records).unwrap();
    let base = |change| relations::RelationEdit {
        entry: 13,
        kind: IN,
        target: 10,
        change,
        after: None,
        before: None,
    };
    let last = edit(&store, base(relations::RelationChange::Add { weak: false })).unwrap();
    let set = relations::parse_relations_field(last.as_bytes());
    let position = &set[&(IN, b"1".to_vec())].position;
    assert!(position.as_slice() > b"d".as_slice());
    assert!(last.starts_with(r#"[{"kind":2,"target":2,"position":"a","note":"kept"},"#));
    let between = edit(
        &store,
        relations::RelationEdit {
            after: Some(11),
            before: Some(12),
            ..base(relations::RelationChange::Add { weak: true })
        },
    )
    .unwrap();
    let set = relations::parse_relations_field(between.as_bytes());
    let placed = &set[&(IN, b"1".to_vec())];
    assert!(
        placed.weak
            && placed.position.as_slice() > b"b".as_slice()
            && placed.position.as_slice() < b"d".as_slice()
    );
    let first = edit(
        &store,
        relations::RelationEdit {
            before: Some(11),
            ..base(relations::RelationChange::Add { weak: false })
        },
    )
    .unwrap();
    let set = relations::parse_relations_field(first.as_bytes());
    assert!(set[&(IN, b"1".to_vec())].position.as_slice() < b"b".as_slice());
    assert_eq!(
        edit(
            &store,
            relations::RelationEdit {
                kind: 9,
                ..base(relations::RelationChange::Remove)
            }
        ),
        Err("This world has no such relation kind.".into())
    );
    assert_eq!(
        edit(&store, base(relations::RelationChange::Remove)),
        Err("The entry has no such relation.".into())
    );
    store
        .commit_wait(vec![set_json(13, relations_field_of(), &last)])
        .unwrap();
    assert_eq!(
        edit(&store, base(relations::RelationChange::Add { weak: false })),
        Err("The entry already has that relation.".into())
    );
    let weak = edit(&store, base(relations::RelationChange::SetWeak(true))).unwrap();
    assert!(relations::parse_relations_field(weak.as_bytes())[&(IN, b"1".to_vec())].weak);
    let moved = edit(
        &store,
        base(relations::RelationChange::Move { new_target: 11 }),
    )
    .unwrap();
    let set = relations::parse_relations_field(moved.as_bytes());
    assert!(set.contains_key(&(IN, b"2".to_vec())) && !set.contains_key(&(IN, b"1".to_vec())));
    let owes = |change| relations::RelationEdit {
        kind: OWES,
        target: 11,
        ..base(change)
    };
    let weak_kept = edit(&store, owes(relations::RelationChange::SetWeak(true))).unwrap();
    assert!(
        weak_kept.contains(r#"{"kind":2,"target":2,"position":"a","note":"kept","weak":true}"#),
        "{weak_kept}"
    );
    let moved_kept = edit(
        &store,
        owes(relations::RelationChange::Move { new_target: 12 }),
    )
    .unwrap();
    let moved_set = relations::parse_relations_field(moved_kept.as_bytes());
    assert!(moved_set.contains_key(&(OWES, b"3".to_vec())));
    assert!(moved_kept.contains(r#""note":"kept""#), "{moved_kept}");
    let removed = edit(&store, base(relations::RelationChange::Remove)).unwrap();
    assert_eq!(
        removed,
        r#"[{"kind":2,"target":2,"position":"a","note":"kept"}]"#
    );
    store
        .commit_wait(vec![set_text(10, relations_field_of(), "in: somewhere")])
        .unwrap();
    assert!(
        edit(
            &store,
            relations::RelationEdit {
                entry: 10,
                target: 11,
                ..base(relations::RelationChange::Add { weak: false })
            }
        )
        .is_err()
    );
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_loop_check_finds_an_entry_only_a_loop_holds_and_says_nothing_past_its_limit_or_when_the_top_holds_it()
 {
    let dir = temp_dir("loops");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&store, B, "one");
    let relations_field_of = relations::relations_field;
    let mut records = Vec::new();
    for (entity, own_key) in [(10, 1), (11, 2), (12, 3), (13, 4)] {
        records.push(create(entity, ENTRY, &format!("1:{own_key}")));
    }
    records.push(set_json(10, relations_field_of(), &strong(&[(IN, 2, "a")])));
    records.push(set_json(11, relations_field_of(), &strong(&[(IN, 3, "a")])));
    records.push(set_json(12, relations_field_of(), &strong(&[(IN, 1, "a")])));
    records.push(set_json(13, relations_field_of(), &strong(&[(IN, 1, "a")])));
    store.commit_wait(records).unwrap();
    let unreached = |entities: &[u64], limit| {
        read(&store, |view| {
            relations::unreached_among(view, B, entities, limit)
        })
        .into_iter()
        .map(|found| {
            let mut entries = found.entries;
            entries.sort();
            (found.entry, found.kind, entries)
        })
        .collect::<Vec<_>>()
    };
    assert_eq!(unreached(&[13], 10), vec![(13, IN, vec![10, 11, 12, 13])]);
    assert_eq!(
        unreached(&[13, 10, 11], 10),
        vec![(13, IN, vec![10, 11, 12, 13])],
        "the entries the first walk found aren't walked again"
    );
    assert_eq!(
        unreached(&[13], 3),
        vec![],
        "past the limit it says nothing"
    );
    store
        .commit_wait(vec![set_json(
            12,
            relations_field_of(),
            &json_of(&[(IN, 1, "a", true)]),
        )])
        .unwrap();
    assert_eq!(unreached(&[13], 10), vec![], "the weak one is at the top");
    let book_tree = relations::order_tree_space(B);
    let top: Vec<u64> = read(&store, |view| {
        Ok(
            tree::top_level_from_rank(view, &book_tree, Some(IN), 0, 10)?
                .iter()
                .map(tree::entity_of_order_key)
                .collect(),
        )
    });
    assert_eq!(top, vec![12]);
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

fn rewrites_of(chunk: &Js) -> (Vec<(u64, String)>, bool) {
    let Js::Obj(fields) = chunk else {
        panic!("not a chunk: {chunk:?}")
    };
    let field = |name: &str| &fields.iter().find(|(key_name, _)| *key_name == name).unwrap().1;
    let Js::Arr(rewrites) = field("rewrites") else {
        panic!()
    };
    let rewrites = rewrites
        .iter()
        .map(|rewrite| {
            let Js::Obj(parts) = rewrite else { panic!() };
            let part = |name: &str| &parts.iter().find(|(key_name, _)| *key_name == name).unwrap().1;
            let (Js::Big(entity), Js::Text(json)) = (part("entity"), part("json")) else {
                panic!()
            };
            (*entity, String::from_utf8(json.clone()).unwrap())
        })
        .collect();
    (rewrites, field("more") == &Js::Bool(true))
}

fn derive_job<T: Send + 'static>(
    store: &Store,
    field: impl FnOnce(&derive::View, &mut derive::Out) -> StoreResult<T> + Send + 'static,
) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    let got = Arc::new(std::sync::Mutex::new(None));
    let put = got.clone();
    store.inner.submit(Job::Derive(
        Box::new(move |view, out| {
            *put.lock().unwrap() = Some(field(view, out)?);
            Ok(())
        }),
        Box::new(move |records| {
            let _ = tx.send(records);
        }),
    ));
    store.inner.ks.pool().exec.recv(&rx).unwrap().unwrap();
    got.lock().unwrap().take().unwrap()
}

#[test]
fn the_conversion_builds_for_a_store_written_before_the_tree_what_its_writes_would_have() {
    let dir = temp_dir("conversion");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&store, B, "one");
    let mut model = Model::default();
    let mut rng = Rng(77);
    let mut next = 100;
    for _ in 0..120 {
        step(&store, &mut model, &mut rng, &mut next);
    }
    let want = dump(&store);
    assert!(!want.is_empty());
    derive_job(&store, |view, out| {
        for structure in [
            ORDER_TREE_EDGE,
            ORDER_TREE_COUNT.id(),
            ORDER_TREE_HELD.id(),
            RELATIONS_OF_ENTRY,
            RELATIONS_BY_TARGET,
            RELATION_COUNT_BY_KIND_AND_TARGET,
        ] {
            let prefix = kinds::key::of(structure);
            for (kind, _) in view.scan(&prefix, &kinds::key::prefix_end(&prefix), usize::MAX)? {
                out.del(kind);
            }
        }
        Ok(())
    });
    assert!(dump(&store).is_empty());
    let mut after: Option<Vec<u8>> = None;
    let mut jobs = 0;
    loop {
        let from = after.clone();
        after = derive_job(&store, move |view, out| {
            relations::world_order_conversion_step(view, out, from.as_deref(), 3)
        });
        jobs += 1;
        if after.is_none() {
            break;
        }
    }
    assert!(jobs > 1);
    assert_eq!(dump(&store), want);
    derive_job(&store, |view, out| {
        relations::world_order_conversion_step(view, out, None, 1000)
    });
    assert_eq!(dump(&store), want);
    model.check(&store);
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

fn history_meta(change: u64) -> Vec<Value> {
    vec![
        Value::Id(change),
        Value::Time(1_700_000_000_000 + change as i64),
        Value::Absent,
        Value::Id(1),
    ]
}

fn history_user(store: &Store) {
    store
        .commit_wait(vec![rec(
            "keyMap",
            vec![Value::Sel(chat::KEYED_USER, 1), Value::Bytes(b"user-1".to_vec())],
        )])
        .unwrap();
}

fn top_of(store: &Store, kind: Option<u64>) -> Vec<u64> {
    let book_tree = relations::order_tree_space(B);
    read(store, |view| {
        Ok(tree::top_level_from_rank(view, &book_tree, kind, 0, usize::MAX)?
            .iter()
            .map(tree::entity_of_order_key)
            .collect())
    })
}

#[test]
fn a_large_delete_goes_at_once_and_its_relations_go_in_chunks_and_a_restore_midway_puts_back_what_went() {
    let dir = temp_dir("chunked");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    history_user(&store);
    book(&store, B, "one");
    let mut records = vec![create(10, ENTRY, "1:1")];
    for source in 11..16 {
        records.push(create(source, ENTRY, &format!("1:{}", source - 9)));
        records.push(set_json(
            source,
            relations::relations_field(),
            &json_of(&[(IN, 1, "a", false), (OWES, 1, "b", true)]),
        ));
    }
    store.commit_wait(records).unwrap();
    assert_eq!(top_of(&store, Some(IN)), vec![10]);
    let mut delete = vec![Value::Id(10)];
    delete.extend(history_meta(1));
    store
        .commit_wait(vec![rec("histEntityDelete", delete)])
        .unwrap();
    assert_eq!(top_of(&store, Some(IN)), vec![10], "the place of the deleted entry holds them");
    assert_eq!(top_of(&store, Some(OWES)), vec![10, 11, 12, 13, 14, 15]);
    assert_eq!(top_of(&store, None), vec![11, 12, 13, 14, 15], "ungrouped, it is gone");
    let chunk = |store: &Store| {
        rewrites_of(&read(store, |view| {
            relations::rewrites_removing_relations_targeting(view, B, &[b"1".to_vec()], 2)
        }))
    };
    let (first, more) = chunk(&store);
    assert_eq!((first.len(), more), (2, true));
    store
        .commit_wait(
            first
                .iter()
                .map(|(source, json)| set_json(*source, relations::relations_field(), json))
                .collect(),
        )
        .unwrap();
    assert_eq!(top_of(&store, Some(IN)), vec![10, 11, 12]);
    let mut restore = vec![Value::Id(10), Value::UInt(ENTRY), text("1:1"), Value::F64(0.0)];
    restore.extend(history_meta(2));
    store
        .commit_wait(vec![rec("histRestore", restore)])
        .unwrap();
    assert!(read(&store, |view| relations::deletion_in_progress(view, B, b"1")).is_none());
    assert_eq!(top_of(&store, Some(IN)), vec![10, 11, 12]);
    assert_eq!(top_of(&store, None), vec![10, 11, 12, 13, 14, 15]);
    let (back, more) = rewrites_of(&read(&store, |view| {
        relations::rewrites_restoring_relations_removed_by_deletion(view, B, 10, 100)
    }));
    assert_eq!((back.len(), more), (2, false));
    store
        .commit_wait(
            back.iter()
                .map(|(source, json)| set_json(*source, relations::relations_field(), json))
                .collect(),
        )
        .unwrap();
    assert_eq!(top_of(&store, Some(IN)), vec![10]);
    assert_eq!(
        read(&store, |view| relations::relations_of_entry(view, 11)),
        relations::parse_relations_field(
            json_of(&[(IN, 1, "a", false), (OWES, 1, "b", true)]).as_bytes()
        ),
        "the relations of both kinds came back as they were"
    );
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn merging_a_kind_rewrites_its_relations_in_chunks_folding_twins_into_one_and_then_the_kind_can_go() {
    let dir = temp_dir("merge");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&store, B, "one");
    let mut records = vec![create(10, ENTRY, "1:1"), create(11, ENTRY, "1:2")];
    records.push(create(12, ENTRY, "1:3"));
    records.push(set_json(
        12,
        relations::relations_field(),
        r#"[{"kind":2,"target":1,"position":"a","note":"kept"},{"kind":1,"target":1,"position":"b","weak":true}]"#,
    ));
    records.push(create(13, ENTRY, "1:4"));
    records.push(set_json(13, relations::relations_field(), &json_of(&[(OWES, 2, "a", false)])));
    store.commit_wait(records).unwrap();
    store
        .commit_wait(vec![set_text(B, relations::relation_kind_merge_field(OWES), "1")])
        .unwrap();
    let edit = relations::RelationEdit {
        entry: 11,
        kind: OWES,
        target: 10,
        change: relations::RelationChange::Add { weak: false },
        after: None,
        before: None,
    };
    let refused = read(&store, |view| relations::relation_edit(view, B, &edit));
    assert!(
        matches!(&refused, Js::Obj(fields) if fields.iter().any(|(name, _)| *name == "refused")),
        "a kind being merged can't be picked for a new relation"
    );
    let pending = read(&store, relations::pending_worldbuilding_jobs);
    assert!(format!("{pending:?}").contains("merges\", Arr([Obj"));
    let mut rounds = 0;
    loop {
        let (rewrites, more) = rewrites_of(&read(&store, |view| {
            relations::rewrites_merging_relation_kind(view, B, OWES, IN, 1)
        }));
        if rewrites.is_empty() {
            break;
        }
        rounds += 1;
        store
            .commit_wait(
                rewrites
                    .iter()
                    .map(|(source, json)| set_json(*source, relations::relations_field(), json))
                    .collect(),
            )
            .unwrap();
        if !more {
            break;
        }
    }
    assert_eq!(rounds, 2);
    assert!(!read(&store, |view| relations::relation_kind_in_use(view, B, OWES)));
    let folded = read(&store, |view| relations::relations_of_entry(view, 12));
    assert_eq!(folded.len(), 1);
    let relation = &folded[&(IN, b"1".to_vec())];
    assert!(!relation.weak, "a strong relation folded into a weak twin keeps it held");
    assert!(String::from_utf8_lossy(&relation.item).contains(r#""note":"kept""#));
    assert!(read(&store, |view| relations::relations_of_entry(view, 13)).contains_key(&(IN, b"2".to_vec())));
    assert!(matches!(
        store.commit_wait(vec![drop_value(B, relations::relation_kind_field(IN))]),
        Err(StoreError::Refused(_))
    ));
    store
        .commit_wait(vec![
            drop_value(B, relations::relation_kind_field(OWES)),
            drop_value(B, relations::relation_kind_merge_field(OWES)),
        ])
        .unwrap();
    let pending = read(&store, relations::pending_worldbuilding_jobs);
    assert!(format!("{pending:?}").contains("merges\", Arr([])"));
    store.close();
    let _ = fs::remove_dir_all(&dir);
}
