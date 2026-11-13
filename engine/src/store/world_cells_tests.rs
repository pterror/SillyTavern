use std::collections::BTreeSet;
use std::fs;

use super::chat_read::Js;
use super::relations_tests::{IN, OWES};
use super::world_cells::{AxisFilter, CellAsk, CellsRead, Is};
use super::world_search::{Chip, Depth};
use super::world_search_tests::{SMALL, field, list, pool, text_of, words, world};
use super::*;

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("st-engine-world-cells-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn filter(kind: u64, is: Is) -> AxisFilter {
    AxisFilter { kind, is }
}

struct Read<'a> {
    query: &'a str,
    chips: Vec<Chip>,
    grouping: Option<u64>,
    up_to: usize,
    steps: usize,
}

const PLAIN: Read = Read {
    query: "",
    chips: Vec::new(),
    grouping: None,
    up_to: 1000,
    steps: usize::MAX,
};

fn cells(store: &Store, read: &Read, asked: Vec<(Vec<AxisFilter>, usize)>) -> Vec<Js> {
    let found = store
        .world_cells(&CellsRead {
            book: 1,
            grouping_kind: read.grouping,
            card_text_characters: 5,
            clauses: words(read.query, None),
            chips: read.chips.clone(),
            cells: asked
                .into_iter()
                .map(|(filters, limit)| CellAsk { filters, limit })
                .collect(),
            count_up_to: read.up_to,
            walk_steps: read.steps,
        })
        .unwrap();
    list(&found).to_vec()
}

fn entries_of(cell: &Js) -> Vec<String> {
    list(field(cell, "entries")).iter().map(|card| text_of(field(card, "entry"))).collect()
}

fn count_of(cell: &Js) -> (f64, bool) {
    let Js::Num(count) = field(cell, "count") else { panic!("no count") };
    let Js::Bool(capped) = field(cell, "capped") else { panic!("no capped") };
    (*count, *capped)
}

fn set(entries: &[&str]) -> BTreeSet<String> {
    entries.iter().map(|entry| (*entry).to_string()).collect()
}

#[test]
fn a_cell_holds_the_entries_passing_every_filter_led_by_any_of_them() {
    let dir = temp_dir("filters");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&store);
    let found = cells(
        &store,
        &PLAIN,
        vec![
            (vec![filter(IN, Is::Target(101, Depth::Directly))], 10),
            (vec![filter(IN, Is::Target(101, Depth::AnyDepth))], 10),
            (vec![filter(IN, Is::Any)], 10),
            (vec![filter(IN, Is::No)], 10),
            (vec![filter(OWES, Is::Any), filter(IN, Is::No)], 10),
            (vec![filter(IN, Is::No), filter(OWES, Is::No)], 10),
        ],
    );
    assert_eq!(entries_of(&found[0]), ["102", "103"]);
    assert_eq!(entries_of(&found[1]), ["102", "104", "109", "103", "108"]);
    assert_eq!(entries_of(&found[2]), ["102", "103", "104", "106", "107", "109"]);
    assert_eq!(entries_of(&found[3]), ["101", "105", "108", "111"]);
    assert_eq!(entries_of(&found[4]), ["111"]);
    assert_eq!(entries_of(&found[5]), ["101", "105", "108"]);
    assert_eq!(count_of(&found[2]), (6.0, false));
}

#[test]
fn a_count_stops_at_its_cap_or_its_walk_and_says_so() {
    let dir = temp_dir("counts");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&store);
    let capped = Read { up_to: 2, ..PLAIN };
    let found = cells(&store, &capped, vec![(vec![filter(IN, Is::Any)], 1), (vec![filter(IN, Is::Any)], 0)]);
    assert_eq!(entries_of(&found[0]), ["102"]);
    assert_eq!(count_of(&found[0]), (2.0, true));
    assert_eq!(entries_of(&found[1]), Vec::<String>::new());
    let walked = Read { steps: 3, ..PLAIN };
    let found = cells(&store, &walked, vec![(vec![filter(IN, Is::Any)], 10)]);
    assert_eq!(count_of(&found[0]), (3.0, true));
}

#[test]
fn the_views_filter_narrows_every_cell() {
    let dir = temp_dir("narrowed");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&store);
    let read = Read {
        chips: vec![Chip {
            kind: IN,
            target: 101,
            depth: Depth::AnyDepth,
        }],
        ..PLAIN
    };
    let found = cells(&store, &read, vec![(vec![filter(IN, Is::Target(102, Depth::Directly))], 10)]);
    assert_eq!(entries_of(&found[0]), ["104", "109"]);
    let words = Read { query: "lamp", ..PLAIN };
    let found = cells(&store, &words, vec![(vec![filter(IN, Is::No)], 10)]);
    assert_eq!(entries_of(&found[0]).into_iter().collect::<BTreeSet<_>>(), set(&["105", "108", "111"]));
}

#[test]
fn a_cells_entries_are_drawn_in_their_heads_regions_heads_outside_the_cell_marked() {
    let dir = temp_dir("grouped");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&store);
    let grouped = Read {
        grouping: Some(IN),
        ..PLAIN
    };
    let found = cells(&store, &grouped, vec![(vec![filter(IN, Is::Any)], 10)]);
    let roots = list(field(&found[0], "entries"));
    let shape = |card: &Js| -> (String, bool, Vec<String>) {
        let Js::Bool(in_cell) = field(card, "inCell") else { panic!("no inCell") };
        let members = list(field(card, "region")).iter().map(|member| text_of(field(member, "entry"))).collect();
        (text_of(field(card, "entry")), *in_cell, members)
    };
    assert_eq!(shape(&roots[0]), ("101".into(), false, vec!["102".into(), "103".into()]));
    let in_101 = list(field(&roots[0], "region"));
    assert_eq!(shape(&in_101[0]), ("102".into(), true, vec!["104".into(), "109".into()]));
    assert_eq!(shape(&in_101[1]), ("103".into(), true, vec!["109".into()]));
    assert_eq!(shape(&roots[1]), ("107".into(), true, vec!["106".into()]));
    assert_eq!(roots.len(), 2);
}
