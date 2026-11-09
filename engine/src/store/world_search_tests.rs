use std::collections::BTreeSet;
use std::fs;

use super::books::ENTRY;
use super::chat_read::Js;
use super::relations;
use super::relations_tests::{IN, OWES, book, create, history_user, index, json_of, rec, soft_delete, text};
use super::world_search::{Chip, Depth, ResultsRead, TEST_BOUNDS};
use super::*;
use crate::log::format::{FieldRef, Value};
use crate::search::query::Clause;

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("st-engine-world-search-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

pub(super) fn pool() -> Arc<Pool> {
    Pool::new(64 << 10, 256 << 10, 4, 1, 2, 2)
}

pub(super) const SMALL: StoreConfig = StoreConfig {
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

pub(super) fn set_code_text(entity: u64, field: u64, text_literal: &str) -> Record {
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

pub(super) fn entry(
    entity: u64,
    world: u64,
    title: &str,
    content: &str,
    relations_line: &[(u64, u64, &str, bool)],
) -> Vec<Record> {
    let mut records = vec![
        create(entity, ENTRY, &format!("{world}:{}", entity % 100)),
        index(entity, world, Some((entity % 100) as f64)),
        set_code_text(entity, 103, title),
    ];
    if !content.is_empty() {
        records.push(set_code_text(entity, 104, content));
    }
    if !relations_line.is_empty() {
        records.push(rec(
            "jsonValue",
            vec![
                Value::Sel(0, entity),
                Value::Field(relations::relations_field()),
                text(&json_of(relations_line)),
                Value::Absent,
                Value::Absent,
            ],
        ));
    }
    records
}

pub(super) fn world(store: &Store) {
    history_user(store);
    book(store, 1, "one");
    book(store, 2, "two");
    let mut records = Vec::new();
    records.extend(entry(101, 1, "Saltmarrow", "a city by the sea", &[]));
    records.extend(entry(102, 1, "The Docks", "lamp oil and nets", &[(IN, 101, "a", false)]));
    records.extend(entry(103, 1, "Lamp Street", "the lamps", &[(IN, 101, "b", false)]));
    records.extend(entry(104, 1, "Old Lamp", "a lamp", &[(IN, 102, "a", false)]));
    records.extend(entry(105, 1, "Far Lamp", "a lamp far away", &[]));
    records.extend(entry(106, 1, "Loop lamp one", "", &[(IN, 107, "a", false)]));
    records.extend(entry(107, 1, "Loop two", "", &[(IN, 106, "a", false)]));
    records.extend(entry(108, 1, "Weak lamp", "", &[(IN, 103, "a", true)]));
    records.extend(entry(109, 1, "Doubly lamp", "", &[(IN, 102, "b", false), (IN, 103, "c", false)]));
    records.extend(entry(110, 1, "Gone lamp", "", &[(IN, 101, "c", false)]));
    records.extend(entry(111, 1, "Owed lamp", "", &[(OWES, 101, "a", false)]));
    records.extend(entry(201, 2, "Lamp elsewhere", "", &[]));
    store.commit_wait(records).unwrap();
    store.commit_wait(vec![soft_delete(110, 1)]).unwrap();
}

pub(super) fn words(text_literal: &str, fields: Option<Vec<u32>>) -> Vec<Clause> {
    text_literal
        .split_whitespace()
        .map(|word| Clause {
            text: word.as_bytes().to_vec(),
            fields: fields.clone(),
            negate: false,
            quoted: false,
        })
        .collect()
}

pub(super) fn field<'a>(fields: &'a Js, name: &str) -> &'a Js {
    let Js::Obj(fields) = fields else {
        panic!("not an object: {fields:?}")
    };
    &fields.iter().find(|(key_name, _)| *key_name == name).unwrap_or_else(|| panic!("no {name}")).1
}

pub(super) fn list(value: &Js) -> &[Js] {
    match value {
        Js::Arr(items) => items,
        other => panic!("not a list: {other:?}"),
    }
}

pub(super) fn text_of(value: &Js) -> String {
    match value {
        Js::Text(bytes) => String::from_utf8(bytes.clone()).unwrap(),
        other => panic!("not a text: {other:?}"),
    }
}

fn next_of(page: &Js) -> Option<String> {
    match field(page, "next") {
        Js::Null => None,
        next => Some(text_of(next)),
    }
}

fn directly(target: u64) -> Chip {
    Chip {
        kind: IN,
        target,
        depth: Depth::Directly,
    }
}

fn any_depth(target: u64) -> Chip {
    Chip {
        kind: IN,
        target,
        depth: Depth::AnyDepth,
    }
}

fn results(store: &Store, query: &str, chips: &[Chip], from: Option<String>, pages: usize, limit: usize) -> Js {
    store
        .world_results(&ResultsRead {
            book: 1,
            grouping_kind: Some(IN),
            card_text_characters: 5,
            clauses: words(query, None),
            chips: chips.to_vec(),
            from,
            pages,
            limit,
        })
        .unwrap()
}

fn one_page(store: &Store, query: &str, chips: &[Chip], cursor: Option<String>, limit: usize) -> (Vec<String>, Option<String>) {
    let read = results(store, query, chips, cursor, 1, limit);
    let page = &list(field(&read, "pages"))[0];
    let occurrences = list(field(page, "entries"))
        .iter()
        .map(|card| text_of(field(card, "occurrence")))
        .collect();
    (occurrences, next_of(page))
}

fn all_pages(store: &Store, query: &str, chips: &[Chip], limit: usize) -> Vec<Vec<String>> {
    let mut pages = Vec::new();
    let mut cursor = None;
    loop {
        let (occurrences, next) = one_page(store, query, chips, cursor.clone(), limit);
        assert_eq!(
            one_page(store, query, chips, cursor, limit),
            (occurrences.clone(), next.clone()),
            "reading a cursor again reads the same page"
        );
        pages.push(occurrences);
        match next {
            Some(next) => cursor = Some(next),
            None => return pages,
        }
    }
}

fn found(store: &Store, query: &str, chips: &[Chip]) -> BTreeSet<String> {
    all_pages(store, query, chips, 100).concat().into_iter().collect()
}

fn set(entities: &[&str]) -> BTreeSet<String> {
    entities.iter().map(|entity| entity.to_string()).collect()
}

#[test]
fn a_search_finds_the_live_entries_of_its_world_only_a_page_at_a_time_in_relevance_order() {
    let dir = temp_dir("book");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&store);
    assert_eq!(
        found(&store, "lamp", &[]),
        set(&["102", "103", "104", "105", "106", "108", "109", "111"])
    );
    let whole = all_pages(&store, "lamp", &[], 100).concat();
    let paged = all_pages(&store, "lamp", &[], 3);
    assert!(paged.len() >= 3);
    assert_eq!(paged.concat(), whole);
    let run = results(&store, "lamp", &[], None, paged.len() + 1, 3);
    let run_pages = list(field(&run, "pages"));
    let occurrences_of = |page: &Js| -> Vec<String> {
        let cards = list(field(page, "entries"));
        cards.iter().map(|card| text_of(field(card, "occurrence"))).collect()
    };
    let read_in_a_run: Vec<Vec<String>> = run_pages.iter().map(occurrences_of).collect();
    assert_eq!(read_in_a_run, paged, "a run is the pages one after another, to the end");
    assert_eq!(field(&run_pages[0], "cursor"), &Js::Null);
    assert_eq!(next_of(&run_pages[0]), Some(text_of(field(&run_pages[1], "cursor"))));
    let later = results(&store, "lamp", &[], next_of(&run_pages[0]), 2, 3);
    assert_eq!(list(field(&later, "pages")), &run_pages[1..3], "a run from a later cursor reads the same pages");
    let (_, next) = one_page(&store, "lamp the", &[], None, 1);
    assert!(next.unwrap().contains('.'), "a cursor of several words carries their weights");
    let read = results(&store, "lamp", &[], None, 1, 1);
    let card = &list(field(&list(field(&read, "pages"))[0], "entries"))[0];
    assert_eq!(text_of(field(card, "cell")), "entry");
    assert!(list(field(card, "region")).is_empty());
    store.close();
}

#[test]
fn a_chip_narrows_a_search_to_a_region_directly_or_at_any_depth_through_weak_relations_and_past_loops() {
    let dir = temp_dir("chips");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&store);
    assert_eq!(found(&store, "lamp", &[directly(101)]), set(&["102", "103"]));
    assert_eq!(
        found(&store, "lamp", &[any_depth(101)]),
        set(&["102", "103", "104", "108", "109"])
    );
    assert_eq!(found(&store, "lamp", &[any_depth(101), directly(102)]), set(&["104", "109"]));
    assert_eq!(found(&store, "loop", &[any_depth(106)]), set(&["107"]), "the target itself is never in its region");
    assert_eq!(found(&store, "loop", &[any_depth(101)]), set(&[]), "a loop nothing above holds ends the walk");
    assert_eq!(found(&store, "old", &[any_depth(101)]), set(&["104"]));
    TEST_BOUNDS.with(|bounds| bounds.set(Some((1, usize::MAX))));
    assert_eq!(found(&store, "old", &[any_depth(101)]), set(&[]), "a walk past the bound answers no");
    TEST_BOUNDS.with(|bounds| bounds.set(None));
    store.close();
}

#[test]
fn with_no_words_a_chip_reads_its_region_in_drawing_order_by_cursor() {
    let dir = temp_dir("regions");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&store);
    assert_eq!(all_pages(&store, "", &[directly(101)], 1), [["101/102"], ["101/103"]]);
    let drawn = [
        "101/102",
        "101/102/104",
        "101/102/109",
        "101/103",
        "101/103/108",
        "101/103/109",
    ];
    assert_eq!(all_pages(&store, "", &[any_depth(101)], 100).concat(), drawn);
    let paged = all_pages(&store, "", &[any_depth(101)], 4);
    assert_eq!(paged[0].len(), 4);
    assert_eq!(paged.concat(), drawn);
    assert_eq!(all_pages(&store, "", &[any_depth(106)], 100).concat(), ["106/107"]);
    assert_eq!(
        all_pages(&store, "", &[any_depth(101), directly(102)], 100).concat(),
        ["102/104", "102/109"],
        "a directly chip leads, the others check"
    );
    TEST_BOUNDS.with(|bounds| bounds.set(Some((usize::MAX, 2))));
    let stepped = all_pages(&store, "", &[any_depth(101)], 100);
    assert!(stepped.len() > 1, "a page stops at its steps' bound and its cursor goes on");
    assert_eq!(stepped.concat(), drawn);
    TEST_BOUNDS.with(|bounds| bounds.set(None));
    assert_eq!(
        one_page(&store, "", &[any_depth(102)], Some("w0000000000000065".into()), 10),
        (Vec::<String>::new(), None),
        "a cursor that isn't this search's reads an empty last page"
    );
    assert_eq!(one_page(&store, "lamp", &[], Some("rnot a cursor".into()), 10), (Vec::<String>::new(), None));
    store.close();
}

#[test]
fn the_chips_are_read_with_their_targets_labels_and_finding_matches_names_and_titles() {
    let dir = temp_dir("find");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&store);
    let read = results(&store, "", &[directly(101), any_depth(110)], None, 0, 10);
    let chips = list(field(&read, "chips"));
    assert_eq!(text_of(field(&chips[0], "kindName")), "in");
    assert_eq!(text_of(field(field(&chips[0], "target"), "text")), "Saltmarrow");
    assert_eq!(field(&chips[1], "target"), &Js::Null);
    let titles_and_keys = Some(vec![0, 2]);
    let found = store.world_find(1, &words("lamp", titles_and_keys.clone()), 20).unwrap();
    let things: BTreeSet<String> = list(field(&found, "entries"))
        .iter()
        .map(|named| text_of(field(named, "thing")))
        .collect();
    assert_eq!(things, set(&["103", "104", "105", "106", "108", "109", "111"]));
    let first = store.world_find(1, &words("lamp", titles_and_keys), 2).unwrap();
    assert_eq!(list(field(&first, "entries")).len(), 2);
    assert!(next_of(&first).is_some());
    let none = store.world_find(1, &[], 20).unwrap();
    assert!(list(field(&none, "entries")).is_empty());
    store.close();
}
