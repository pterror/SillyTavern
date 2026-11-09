use std::collections::HashSet;
use std::fs;

use super::chat_read::Js;
use super::relations_tests::{IN, drop_value, set_json, set_text, soft_delete};
use super::world_bulk::{self, BulkAction, BulkRead};
use super::world_search::{Selected, walk_selected};
use super::world_search_tests::{SMALL, field, list, pool, set_code_text, text_of, words, world};
use super::*;
use crate::log::format::FieldRef;
use crate::search::query::StatsCache;

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "st-engine-world-bulk-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn opened(name: &str) -> Store {
    let store = Store::open_in(&temp_dir(name), SMALL, pool()).unwrap();
    world(&store);
    store
}

fn job_field(job: &str) -> FieldRef {
    FieldRef::Key(format!("\x01bulkJob:{job}").into_bytes())
}

fn walk(
    store: &Store,
    selected: &Selected,
    cursor: Option<String>,
    limit: usize,
) -> (Vec<u64>, Option<String>) {
    let cache = StatsCache::default();
    let walked = store
        .chat_read(|view| walk_selected(view, &cache, 1, selected, cursor.as_deref(), limit))
        .unwrap();
    (walked.entries, walked.next)
}

fn walk_all(store: &Store, selected: &Selected, limit: usize) -> Vec<u64> {
    let (mut all, mut cursor) = walk(store, selected, None, limit);
    while let Some(next) = cursor {
        let (more, after) = walk(store, selected, Some(next), limit);
        all.extend(more);
        cursor = after;
    }
    all
}

fn lamp() -> Selected {
    Selected::Filter {
        clauses: words("lamp", None),
        chips: Vec::new(),
    }
}

fn chunk(store: &Store, selected: Selected, action: BulkAction) -> Js {
    let cache = StatsCache::default();
    let read = BulkRead {
        book: 1,
        selected,
        except: HashSet::new(),
        cursor: None,
        limit: 100,
        action,
    };
    store
        .chat_read(|view| world_bulk::bulk_chunk(view, &cache, &read))
        .unwrap()
}

fn count(store: &Store, selected: &Selected, except: &[u64], cap: usize) -> (f64, bool) {
    let counted = store
        .world_selection_count(1, selected, &except.iter().copied().collect(), cap)
        .unwrap();
    let Js::Num(matching) = field(&counted, "matching") else {
        panic!("no count")
    };
    let Js::Bool(capped) = field(&counted, "capped") else {
        panic!("no capped")
    };
    (*matching, *capped)
}

fn rewrites(chunk: &Js) -> Vec<(u64, String)> {
    list(field(chunk, "rewrites"))
        .iter()
        .map(|rewrite| {
            let Js::Big(entity) = field(rewrite, "entity") else {
                panic!("no entity")
            };
            (*entity, text_of(field(rewrite, "json")))
        })
        .collect()
}

fn position_of(json: &str, target: u64) -> String {
    let at = json.find(&format!("\"targetEntry\":\"{target}\"")).unwrap();
    let from = json[at..].find("\"position\":\"").unwrap() + at + 12;
    json[from..from + json[from..].find('"').unwrap()].to_string()
}

#[test]
fn a_bulk_job_is_found_by_its_marker_while_its_field_says_it_runs() {
    let store = opened("marker");
    let running = || store.chat_read(world_bulk::running_jobs).unwrap();
    store
        .commit_wait(vec![
            set_text(1, job_field("3"), "{}"),
            set_text(1, job_field("03"), "{}"),
        ])
        .unwrap();
    let jobs = running();
    assert_eq!(
        list(&jobs).len(),
        1,
        "a field whose number isn't written as one is no job"
    );
    assert!(matches!(field(&list(&jobs)[0], "job"), Js::Num(job) if *job == 3.0));
    store
        .commit_wait(vec![set_json(1, job_field("3"), "{}")])
        .unwrap();
    assert!(
        list(&running()).is_empty(),
        "a JSON value is no job's field"
    );
    store
        .commit_wait(vec![set_text(1, job_field("3"), "{}")])
        .unwrap();
    store
        .commit_wait(vec![drop_value(1, job_field("3"))])
        .unwrap();
    assert!(list(&running()).is_empty());
    store.close();
}

#[test]
fn the_whole_world_is_walked_by_its_entries_keys_and_a_walk_goes_on_past_what_changed_meanwhile() {
    let store = opened("world");
    assert_eq!(
        walk_all(&store, &Selected::World, 3),
        vec![101, 111, 102, 103, 104, 105, 106, 107, 108, 109],
        "in its keys' order, the deleted entry left out"
    );
    let (first, cursor) = walk(&store, &Selected::World, None, 3);
    assert_eq!(first, vec![101, 111, 102]);
    store
        .commit_wait(vec![soft_delete(104, 60), soft_delete(101, 61)])
        .unwrap();
    let (mut rest, mut cursor) = walk(&store, &Selected::World, cursor, 3);
    while let Some(next) = cursor {
        let (more, after) = walk(&store, &Selected::World, Some(next), 3);
        rest.extend(more);
        cursor = after;
    }
    assert_eq!(rest, vec![103, 105, 106, 107, 108, 109]);
    store.close();
}

#[test]
fn words_are_walked_in_entity_order_each_entry_as_it_is_when_the_walk_reaches_it() {
    let store = opened("words");
    assert_eq!(
        walk_all(&store, &lamp(), 2),
        vec![102, 103, 104, 105, 106, 108, 109, 111]
    );
    let (first, cursor) = walk(&store, &lamp(), None, 2);
    assert_eq!(first, vec![102, 103]);
    store
        .commit_wait(vec![
            set_code_text(108, 103, "Weak"),
            set_code_text(102, 104, "no more"),
            set_code_text(107, 103, "Loop lamp two"),
        ])
        .unwrap();
    let mut rest = Vec::new();
    let mut cursor = cursor;
    while let Some(next) = cursor {
        let (more, after) = walk(&store, &lamp(), Some(next), 2);
        rest.extend(more);
        cursor = after;
    }
    assert_eq!(rest, vec![104, 105, 106, 107, 109, 111]);
    store.close();
}

#[test]
fn picked_entries_are_walked_in_their_order_leaving_out_those_no_longer_in_the_world() {
    let store = opened("picked");
    let picked = Selected::Entries(vec![109, 110, 201, 102, 103]);
    assert_eq!(
        walk(&store, &picked, None, 2),
        (vec![109, 102], Some("i4".to_string()))
    );
    assert_eq!(walk_all(&store, &picked, 2), vec![109, 102, 103]);
    store.close();
}

#[test]
fn move_to_replaces_relations_of_its_kind_and_also_put_in_adds_one_each_new_one_last_in_order() {
    let store = opened("relations");
    let picked = Selected::Entries(vec![105, 104, 109, 103, 108]);
    let moved = rewrites(&chunk(
        &store,
        picked,
        BulkAction::MoveTo {
            kind: IN,
            target: 103,
        },
    ));
    let entities: Vec<u64> = moved.iter().map(|(entity, _)| *entity).collect();
    assert_eq!(
        entities,
        vec![105, 104, 109],
        "the target isn't put in itself, and one already only in it is left"
    );
    let (new_one, moved_one) = (&moved[0].1, &moved[1].1);
    assert!(!new_one.contains("\"102\"") && new_one.contains("\"targetEntry\":\"103\""));
    assert!(
        position_of(new_one, 103).as_str() > "c",
        "after the region's last"
    );
    assert!(
        position_of(moved_one, 103) > position_of(new_one, 103),
        "each later than the one before it"
    );
    assert_eq!(
        moved[2].1,
        r#"[{"kind":1,"targetEntry":"103","position":"c"}]"#
    );

    let added = rewrites(&chunk(
        &store,
        Selected::Entries(vec![109, 105]),
        BulkAction::AlsoPutIn {
            kind: IN,
            target: 103,
        },
    ));
    assert_eq!(
        added.iter().map(|(entity, _)| *entity).collect::<Vec<_>>(),
        vec![105]
    );
    assert!(
        added[0]
            .1
            .starts_with("[{\"kind\":1,\"targetEntry\":\"103\"")
    );

    let ended = chunk(
        &store,
        Selected::World,
        BulkAction::MoveTo {
            kind: IN,
            target: 110,
        },
    );
    assert_eq!(
        text_of(field(&ended, "ended")),
        "The target isn't an entry of this world."
    );
    let ended = chunk(
        &store,
        Selected::World,
        BulkAction::AlsoPutIn {
            kind: 9,
            target: 103,
        },
    );
    assert_eq!(
        text_of(field(&ended, "ended")),
        "This world has no such relation kind."
    );
    store.close();
}

#[test]
fn a_count_leaves_out_the_exceptions_and_stops_at_its_cap() {
    let store = opened("count");
    assert_eq!(count(&store, &lamp(), &[], 100), (8.0, false));
    assert_eq!(count(&store, &lamp(), &[102, 999], 100), (7.0, false));
    assert_eq!(count(&store, &lamp(), &[102], 3), (3.0, true));
    assert_eq!(
        count(&store, &Selected::World, &[101, 110, 999], 3),
        (9.0, false),
        "the whole world's count is kept"
    );
    let chip = Selected::Filter {
        clauses: Vec::new(),
        chips: vec![super::world_search::Chip {
            kind: IN,
            target: 101,
            depth: super::world_search::Depth::AnyDepth,
        }],
    };
    assert_eq!(
        count(&store, &chip, &[], 100),
        (5.0, false),
        "an entry in two places of the region counts once"
    );
    store.close();
}
