use std::fs;

use super::books::ENTRY;
use super::chat_read::Js;
use super::entry_label;
use super::entry_page;
use super::references;
use super::relations;
use super::relations_tests::{IN, book, create, derive_job, history_user, index, rec, set_json, soft_delete, strong, text};
use super::*;
use crate::log::format::{FieldRef, Value};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("st-engine-entry-page-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn pool() -> Arc<Pool> {
    Pool::new(64 << 10, 256 << 10, 4, 1, 2, 2)
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

fn set_code_text(entity: u64, field: u64, text_literal: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Sel(0, entity),
            Value::Field(FieldRef::Code(field)),
            text(text_literal),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn key_item(entity: u64, item: u64, key_text: &str) -> [Record; 2] {
    [
        set_code_text(entity, library::ITEM_BASE + item * library::LISTS, key_text),
        rec(
            "itemPlace",
            vec![Value::Id(entity), Value::UInt(0), Value::UInt(item), Value::UInt(item + 1)],
        ),
    ]
}

fn entry(entity: u64, display_index: f64) -> [Record; 2] {
    [create(entity, ENTRY, &format!("1:{}", entity - 100)), index(entity, 1, Some(display_index))]
}

fn field<'a>(fields: &'a Js, name: &str) -> &'a Js {
    let Js::Obj(field) = fields else {
        panic!("not an object: {fields:?}")
    };
    &field.iter().find(|(key_name, _)| *key_name == name).unwrap_or_else(|| panic!("no {name}")).1
}

fn read<T>(store: &Store, read_with: impl FnOnce(&derive::View) -> StoreResult<T>) -> T {
    store.chat_read(read_with).unwrap()
}

fn also_brings_up(store: &Store, entity: u64) -> Vec<(String, f64)> {
    let entry_read = read(store, |view| entry_page::read_entry(view, 1, entity));
    let Js::Arr(keys) = field(&entry_read, "keys") else { panic!("no keys") };
    keys.iter()
        .map(|key_cell| {
            let (Js::Text(key_text), Js::Num(also)) = (field(key_cell, "text"), field(key_cell, "alsoBringsUp")) else {
                panic!("a key reads as text and a count")
            };
            (String::from_utf8(key_text.clone()).unwrap(), *also)
        })
        .collect()
}

fn counted(store: &Store, key_text: &str) -> Option<Vec<u8>> {
    read(store, |view| view.get(&references::key_items_by_text_key(1, key_text.as_bytes())))
}

#[test]
fn a_key_says_how_many_other_entries_of_the_world_it_brings_up_from_a_count_kept_by_their_writes() {
    let dir = temp_dir("keys");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&store, 1, "one");
    history_user(&store);
    let mut records = Vec::new();
    for (entity, display_index) in [(101, 0.0), (102, 1.0), (103, 2.0)] {
        records.extend(entry(entity, display_index));
    }
    records.extend(key_item(101, 0, "Ilse"));
    records.extend(key_item(101, 1, "lamp"));
    records.extend(key_item(102, 0, "Ilse"));
    records.extend(key_item(103, 0, "Ilse"));
    records.extend(key_item(103, 1, "Ilse"));
    records.push(set_json(101, entry_label::names_field(), r#"["Ilse"]"#));
    store.commit_wait(records).unwrap();
    assert_eq!(also_brings_up(&store, 101), [("Ilse".into(), 3.0), ("lamp".into(), 0.0)]);
    let entry_read = read(&store, |view| entry_page::read_entry(view, 1, 101));
    let Js::Arr(keys) = field(&entry_read, "keys") else { panic!() };
    assert_eq!(field(&keys[0], "isName"), &Js::Bool(true));
    assert_eq!(field(&keys[1], "isName"), &Js::Bool(false));
    assert_eq!(field(&entry_read, "deleted"), &Js::Bool(false));

    store.commit_wait(vec![set_code_text(102, library::ITEM_BASE, "Varro")]).unwrap();
    assert_eq!(also_brings_up(&store, 101)[0], ("Ilse".into(), 2.0));
    store.commit_wait(vec![soft_delete(103, 1)]).unwrap();
    assert_eq!(also_brings_up(&store, 101)[0], ("Ilse".into(), 0.0));
    assert_eq!(also_brings_up(&store, 102), [("Varro".into(), 0.0)]);
    assert_eq!(read(&store, |view| entry_page::read_entry(view, 1, 103)), Js::Obj(vec![("deleted", Js::Bool(true))]));
    assert_eq!(read(&store, |view| entry_page::read_entry(view, 1, 999)), Js::Null);
    assert_eq!(counted(&store, "Varro").is_some(), true);
    store.commit_wait(vec![rec("valueDelete", vec![Value::Sel(0, 102), Value::Field(FieldRef::Code(library::ITEM_BASE)), Value::Absent, Value::Absent])]).unwrap();
    assert_eq!(counted(&store, "Varro"), None, "a count that reaches nothing is no key at all");

    let before = counted(&store, "Ilse");
    let indexes = [references::KEY_ENTRIES_BY_TEXT, references::NAMES_BY_FOLD, references::NAMES_CHECKED_ONE_BY_ONE];
    let dump = |store: &Store| {
        read(store, |view| {
            let mut all = Vec::new();
            for structure in indexes {
                let prefix = key::of(structure);
                all.extend(view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)?);
            }
            Ok(all)
        })
    };
    let built = dump(&store);
    assert_eq!(built.len(), 3, "{built:?}");
    derive_job(&store, move |view, out| {
        for structure in indexes {
            let prefix = key::of(structure);
            for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
                out.del(stored_key);
            }
        }
        out.put(key::ids(references::UNINDEXED_BEFORE_NAMES_INDEX, 1, 101), Vec::new());
        Ok(())
    });
    assert!(dump(&store).is_empty());
    let mut after: Option<Vec<u8>> = None;
    loop {
        let from = after.clone();
        after = derive_job(&store, move |view, out| relations::world_order_conversion_step(view, out, from.as_deref(), 2));
        if after.is_none() {
            break;
        }
    }
    assert_eq!(counted(&store, "Ilse"), before, "the conversion counts every key again, the same");
    assert_eq!(dump(&store), built, "the conversion lists every key's entries and every name again, the same");
    let unindexed = key::of(references::UNINDEXED_BEFORE_NAMES_INDEX);
    assert!(read(&store, |view| view.scan(&unindexed, &key::prefix_end(&unindexed), 1)).is_empty());
    assert_eq!(also_brings_up(&store, 101)[0], ("Ilse".into(), 0.0));
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

fn placement(store: &Store, after: Option<u64>) -> (f64, Vec<(u64, f64)>) {
    let placed = read(store, |view| entry_page::place_after(view, 1, after));
    let Js::Num(display_index) = field(&placed, "displayIndex") else { panic!() };
    let Js::Arr(moved) = field(&placed, "moved") else { panic!() };
    (
        *display_index,
        moved
            .iter()
            .map(|m| {
                let (Js::Big(entity), Js::Num(index)) = (field(m, "entry"), field(m, "displayIndex")) else { panic!() };
                (*entity, *index)
            })
            .collect(),
    )
}

#[test]
fn a_new_entry_goes_right_after_another_in_the_worlds_order_by_the_smallest_change() {
    let dir = temp_dir("place");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&store, 1, "one");
    assert_eq!(placement(&store, None), (0.0, vec![]));
    let mut records = Vec::new();
    for (entity, display_index) in [(101, 0.0), (102, 1.0), (103, 3.0), (104, 5.0), (105, 5.0), (106, 5.0), (107, 7.0)] {
        records.extend(entry(entity, display_index));
    }
    store.commit_wait(records).unwrap();
    assert_eq!(placement(&store, Some(101)), (0.5, vec![]));
    assert_eq!(placement(&store, Some(102)), (2.0, vec![]));
    assert_eq!(placement(&store, Some(107)), (8.0, vec![]));
    assert_eq!(placement(&store, None), (8.0, vec![]));
    assert_eq!(placement(&store, Some(104)), (5.0, vec![(105, 6.0), (106, 6.0)]));
    assert_eq!(placement(&store, Some(106)), (6.0, vec![]));
    let refused = read(&store, |view| entry_page::place_after(view, 1, Some(999)));
    assert_eq!(field(&refused, "refused"), &Js::Text(b"That entry isn't in this world.".to_vec()));
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_new_entrys_relation_goes_last_among_the_relations_of_its_kind_to_its_target() {
    let dir = temp_dir("new relation");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&store, 1, "one");
    let mut records = Vec::new();
    for (entity, display_index) in [(101, 0.0), (102, 1.0)] {
        records.extend(entry(entity, display_index));
    }
    records.push(set_json(102, relations::relations_field(), &strong(&[(IN, 101, "m")])));
    store.commit_wait(records).unwrap();
    let made = read(&store, |view| relations::relations_of_new_entry(view, 1, IN, 101));
    let Js::Text(json) = field(&made, "json") else { panic!() };
    let parsed = relations::parse_relations_field(json);
    let position = &parsed.get(&(IN, 101)).unwrap().position;
    assert!(position.as_slice() > b"m".as_slice());
    let refused = read(&store, |view| relations::relations_of_new_entry(view, 1, 77, 101));
    assert_eq!(field(&refused, "refused"), &Js::Text(b"This world has no such relation kind.".to_vec()));
    let missing = read(&store, |view| relations::relations_of_new_entry(view, 1, IN, 999));
    assert_eq!(field(&missing, "refused"), &Js::Text(b"The target isn't an entry of this world.".to_vec()));
    store.close();
    let _ = fs::remove_dir_all(&dir);
}
