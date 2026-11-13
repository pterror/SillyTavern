use std::fs;

use super::books::ENTRY;
use super::chat_read::Js;
use super::overview::{self, Grouping, OverviewLayout, OverviewStep, RegionLayout};
use super::entry_label;
use super::relations;
use super::relations_tests::{history_user, soft_delete, 
    IN as IN_KIND, OWES, book, create, index, rec, set_json, strong, text,
};
use super::*;
use crate::log::format::{FieldRef, Value};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("st-engine-overview-{}-{name}", std::process::id()));
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

fn field_of<'a>(fields: &'a Js, name: &str) -> &'a Js {
    let Js::Obj(field) = fields else {
        panic!("not an object: {fields:?}")
    };
    &field
        .iter()
        .find(|(key_name, _)| *key_name == name)
        .unwrap_or_else(|| panic!("no {name}"))
        .1
}

fn text_of(value: &Js) -> String {
    match value {
        Js::Text(text_literal) => String::from_utf8(text_literal.clone()).unwrap(),
        other => panic!("not a text: {other:?}"),
    }
}

fn number_of(value: &Js) -> f64 {
    match value {
        Js::Num(number) => *number,
        other => panic!("not a number: {other:?}"),
    }
}

fn list_of(value: &Js) -> &[Js] {
    match value {
        Js::Arr(lantern_house) => lantern_house,
        other => panic!("not a list: {other:?}"),
    }
}

fn named(thing: &str, shown: &str, shown_as: &str) -> Js {
    Js::Obj(vec![
        ("thing", Js::Text(thing.as_bytes().to_vec())),
        ("text", Js::Text(shown.as_bytes().to_vec())),
        ("shownAs", Js::Text(shown_as.as_bytes().to_vec())),
    ])
}

fn outline(item: &Js, out: &mut Vec<String>) {
    let occurrence = text_of(field_of(item, "occurrence"));
    if text_of(field_of(item, "cell")) == "notShownTile" {
        out.push(format!(
            "{occurrence}={}",
            number_of(field_of(item, "groupingKindRelationsTargetingRegionEntryNotShown"))
        ));
        return;
    }
    let repeat = field_of(item, "alreadyOpenAbove") == &Js::Bool(true);
    out.push(if repeat {
        format!("{occurrence}!")
    } else {
        occurrence
    });
    for cell in list_of(field_of(item, "region")) {
        outline(cell, out);
    }
}

const IN: Grouping = Grouping::World {
    book: 1,
    kind: Some(IN_KIND),
};

const TWO_BY_TWO_THEN_ONE: [RegionLayout; 2] = [
    RegionLayout {
        columns: 2,
        rows: 2,
    },
    RegionLayout {
        columns: 1,
        rows: 1,
    },
];

const LAYOUT: OverviewLayout = OverviewLayout {
    regions_by_nesting_level: &TWO_BY_TWO_THEN_ONE,
    card_text_characters: 400,
};

fn world(store: &Store) {
    book(store, 1, "one");
    let entity_of_uid = |own_key: u64| 100 + own_key;
    let entry = |own_key: u64, landing: f64, relations_line: &[(u64, u64, &str)]| {
        let mut records = vec![
            create(entity_of_uid(own_key), ENTRY, &format!("1:{own_key}")),
            index(entity_of_uid(own_key), 1, Some(landing)),
        ];
        if !relations_line.is_empty() {
            records.push(set_json(
                entity_of_uid(own_key),
                relations::relations_field(),
                &strong(
                    &relations_line
                        .iter()
                        .map(|(kind, target, position)| (*kind, entity_of_uid(*target), *position))
                        .collect::<Vec<_>>(),
                ),
            ));
        }
        records
    };
    let mut records = Vec::new();
    records.extend(entry(11, -1.0, &[]));
    records.extend(entry(1, 0.0, &[]));
    records.extend(entry(2, 1.0, &[(IN_KIND, 1, "a")]));
    records.extend(entry(3, 2.0, &[(IN_KIND, 1, "b")]));
    records.extend(entry(4, 3.0, &[(IN_KIND, 1, "c")]));
    records.extend(entry(5, 4.0, &[(IN_KIND, 1, "d"), (OWES, 8, "a")]));
    records.extend(entry(6, 5.0, &[(IN_KIND, 2, "a")]));
    records.extend(entry(7, 6.0, &[(IN_KIND, 6, "a")]));
    records.extend(entry(8, 7.0, &[]));
    records.extend(entry(9, 8.0, &[(IN_KIND, 8, "a"), (IN_KIND, 9, "a")]));
    records.extend(entry(10, 9.0, &[(IN_KIND, 1, "e")]));
    records.push(set_code_text(entity_of_uid(1), 103, "The Lantern House"));
    records.push(set_code_text(entity_of_uid(1), 104, &"word ".repeat(100)));
    records.push(set_code_text(
        entity_of_uid(1),
        library::ITEM_BASE,
        "lantern",
    ));
    records.push(rec(
        "itemPlace",
        vec![
            Value::Id(entity_of_uid(1)),
            Value::UInt(0),
            Value::UInt(0),
            Value::UInt(1),
        ],
    ));
    store.commit_wait(records).unwrap();
}

fn read<T>(store: &Store, read_with: impl FnOnce(&derive::View) -> StoreResult<T>) -> T {
    store.chat_read(read_with).unwrap()
}

fn stepped(
    store: &Store,
    grouping: Grouping,
    from: Option<&str>,
    step: OverviewStep,
) -> Option<(String, f64)> {
    let landing_js = read(store, |view| {
        overview::step_in_reading_order(view, grouping, &TWO_BY_TWO_THEN_ONE, from, step)
    });
    (landing_js != Js::Null).then(|| {
        (
            text_of(field_of(&landing_js, "occurrence")),
            number_of(field_of(&landing_js, "topLevelRank")),
        )
    })
}

#[test]
fn the_overview_is_the_top_with_each_region_cut_short_a_count_per_cut_and_repeats_closed() {
    let dir = temp_dir("window");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&store);
    let overview_read = read(&store, |view| {
        overview::read_overview(view, IN, &LAYOUT, 0, 10, Some("101/102/999"))
    });
    assert_eq!(number_of(field_of(&overview_read, "topLevelCount")), 3.0);
    let mut fields = Vec::new();
    for item in list_of(field_of(&overview_read, "entries")) {
        outline(item, &mut fields);
    }
    assert_eq!(
        fields,
        [
            "111",
            "101",
            "101/102",
            "101/102/106",
            "101/103",
            "101/104",
            "101/+=2",
            "108",
            "108/109",
            "108/109/109!",
        ]
    );
    let lantern_house = &list_of(field_of(&overview_read, "entries"))[1];
    assert_eq!(number_of(field_of(lantern_house, "topLevelRank")), 1.0);
    assert_eq!(number_of(field_of(lantern_house, "groupingKindRelationsTargetingThis")), 5.0);
    assert_eq!(
        text_of(field_of(lantern_house, "title")),
        "The Lantern House"
    );
    assert_eq!(field_of(lantern_house, "textCut"), &Js::Bool(true));
    assert_eq!(text_of(field_of(lantern_house, "text")).len(), 400);
    assert_eq!(
        list_of(field_of(lantern_house, "keys")),
        [Js::Text(b"lantern".to_vec())]
    );
    let first_related = &list_of(field_of(lantern_house, "region"))[0];
    let relations_line = list_of(field_of(first_related, "relations"));
    assert_eq!(text_of(field_of(&relations_line[0], "kind")), "1");
    assert_eq!(text_of(field_of(&relations_line[0], "kindName")), "in");
    assert_eq!(text_of(field_of(&relations_line[0], "targetEntry")), "101");
    assert_eq!(
        field_of(&relations_line[0], "target"),
        &named("101", "The Lantern House", "title")
    );
    assert_eq!(
        field_of(lantern_house, "label"),
        &named("101", "The Lantern House", "title")
    );
    assert_eq!(
        text_of(field_of(
            field_of(&overview_read, "stepLanding"),
            "occurrence"
        )),
        "101/102"
    );
    let second_range = read(&store, |view| {
        overview::read_overview(view, IN, &LAYOUT, 2, 3, None)
    });
    assert_eq!(number_of(field_of(&second_range, "firstRank")), 2.0);
    assert_eq!(
        text_of(field_of(
            &list_of(field_of(&second_range, "entries"))[0],
            "occurrence"
        )),
        "108"
    );
    let ungrouped = read(&store, |view| {
        overview::read_overview(
            view,
            Grouping::World {
                book: 1,
                kind: None,
            },
            &LAYOUT,
            0,
            100,
            None,
        )
    });
    assert_eq!(number_of(field_of(&ungrouped, "topLevelCount")), 11.0);
    assert!(
        list_of(field_of(&ungrouped, "entries"))
            .iter()
            .all(|entry_cell| list_of(field_of(entry_cell, "region")).is_empty())
    );
    let by_owes = read(&store, |view| {
        overview::read_overview(
            view,
            Grouping::World {
                book: 1,
                kind: Some(OWES),
            },
            &LAYOUT,
            0,
            100,
            None,
        )
    });
    assert_eq!(number_of(field_of(&by_owes, "topLevelCount")), 10.0);
    let mut fields = Vec::new();
    let holder = list_of(field_of(&by_owes, "entries"))
        .iter()
        .find(|entry_cell| text_of(field_of(entry_cell, "occurrence")) == "108")
        .unwrap();
    outline(holder, &mut fields);
    assert_eq!(fields, ["108", "108/105"]);
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_move_steps_through_reading_order_across_top_level_entries_and_hops_to_parents_and_children() {
    let dir = temp_dir("move");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&store);
    let step_from = |from: Option<&str>, step: OverviewStep| stepped(&store, IN, from, step);
    let landing = |key_name: &str, records: f64| Some((key_name.to_string(), records));
    assert_eq!(
        step_from(None, OverviewStep::InReadingOrder(1)),
        landing("111", 0.0)
    );
    assert_eq!(
        step_from(None, OverviewStep::InReadingOrder(2)),
        landing("101", 1.0)
    );
    assert_eq!(
        step_from(None, OverviewStep::InReadingOrder(-1)),
        landing("108/109/109", 2.0)
    );
    assert_eq!(
        step_from(Some("101/102"), OverviewStep::InReadingOrder(1)),
        landing("101/102/106", 1.0)
    );
    assert_eq!(
        step_from(Some("101/102/106/+"), OverviewStep::InReadingOrder(3)),
        landing("101/+", 1.0)
    );
    assert_eq!(
        step_from(Some("101/+"), OverviewStep::InReadingOrder(1)),
        landing("108", 2.0)
    );
    assert_eq!(
        step_from(Some("108"), OverviewStep::InReadingOrder(-1)),
        landing("101/+", 1.0)
    );
    assert_eq!(
        step_from(Some("111"), OverviewStep::InReadingOrder(9)),
        landing("108/109/109", 2.0)
    );
    assert_eq!(
        step_from(Some("111"), OverviewStep::InReadingOrder(8)),
        landing("108/109", 2.0)
    );
    assert_eq!(
        step_from(Some("111"), OverviewStep::InReadingOrder(100)),
        landing("108/109/109", 2.0)
    );
    assert_eq!(
        step_from(Some("108/109"), OverviewStep::InReadingOrder(-100)),
        landing("111", 0.0)
    );
    assert_eq!(
        step_from(Some("101/102/106"), OverviewStep::ToParent),
        landing("101/102", 1.0)
    );
    assert_eq!(
        step_from(Some("101/+"), OverviewStep::ToParent),
        landing("101", 1.0)
    );
    assert_eq!(
        step_from(Some("101"), OverviewStep::ToParent),
        landing("101", 1.0)
    );
    assert_eq!(
        step_from(Some("101"), OverviewStep::ToFirstChild),
        landing("101/102", 1.0)
    );
    assert_eq!(
        step_from(Some("101/102/106"), OverviewStep::ToFirstChild),
        landing("101/102/106", 1.0)
    );
    assert_eq!(
        step_from(Some("108/109/109"), OverviewStep::ToFirstChild),
        landing("108/109/109", 2.0)
    );
    assert_eq!(
        step_from(Some("101/104/77"), OverviewStep::InReadingOrder(0)),
        landing("101/104", 1.0)
    );
    assert_eq!(
        step_from(Some("102"), OverviewStep::InReadingOrder(0)),
        None
    );
    assert!(read(&store, |view| Ok(overview::step_in_reading_order(
        view,
        IN,
        &TWO_BY_TWO_THEN_ONE,
        Some("1//2"),
        OverviewStep::InReadingOrder(1)
    )
    .is_err())));
    history_user(&store);
    store.commit_wait(vec![soft_delete(101, 1)]).unwrap();
    let overview_read = read(&store, |view| {
        overview::read_overview(view, IN, &LAYOUT, 0, 10, None)
    });
    let keys: Vec<String> = list_of(field_of(&overview_read, "entries"))
        .iter()
        .map(|entry_cell| text_of(field_of(entry_cell, "occurrence")))
        .collect();
    assert_eq!(keys, ["111", "102", "103", "104", "105", "108", "110"]);
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

fn key_item(entity: u64, item: u64, key_text: &str) -> [Record; 2] {
    [
        set_code_text(entity, library::ITEM_BASE + item * library::LISTS, key_text),
        rec(
            "itemPlace",
            vec![
                Value::Id(entity),
                Value::UInt(0),
                Value::UInt(item),
                Value::UInt(item + 1),
            ],
        ),
    ]
}

#[test]
fn every_card_is_labelled_by_its_title_else_its_first_name_else_its_opening() {
    let dir = temp_dir("label");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&store, 1, "one");
    let mut records = Vec::new();
    for (entity, landing) in [(201, 0.0), (202, 1.0), (203, 2.0), (204, 3.0), (205, 4.0)] {
        records.push(create(entity, ENTRY, &format!("1:{}", entity - 200)));
        records.push(index(entity, 1, Some(landing)));
    }
    records.extend(key_item(201, 0, "Ilse"));
    records.extend(key_item(201, 1, "Varro"));
    records.push(set_json(201, entry_label::names_field(), r#"["Varro","Ilse","Varro","not a key"]"#));
    records.push(set_code_text(201, 103, "Varro"));
    records.extend(key_item(202, 0, "lamp"));
    records.extend(key_item(202, 1, "The Pale Choir"));
    records.push(set_json(202, entry_label::names_field(), r#"["The Pale Choir"]"#));
    records.push(set_code_text(202, 103, "A choir"));
    records.push(set_json(203, entry_label::names_field(), r#"["Saltmarrow"]"#));
    records.extend(key_item(203, 0, "Saltmarrow"));
    records.push(set_json(203, relations::relations_field(), &strong(&[(IN_KIND, 201, "a")])));
    records.extend(key_item(204, 0, "Saltmarrow"));
    records.push(set_json(204, entry_label::names_field(), r#"{"third":"party"}"#));
    records.push(set_code_text(204, 104, &format!("\n  {}  \nsecond line", "é".repeat(130))));
    records.push(set_code_text(205, 103, "   "));
    for (entity, picture) in [(201, "abc.png"), (202, "")] {
        records.push(rec(
            "textValue",
            vec![
                Value::Sel(0, entity),
                Value::Field(FieldRef::Key(entry_label::PICTURE_FIELD.to_vec())),
                text(picture),
                Value::Absent,
                Value::Absent,
            ],
        ));
    }
    store.commit_wait(records).unwrap();
    let overview_read = read(&store, |view| {
        overview::read_overview(
            view,
            Grouping::World {
                book: 1,
                kind: None,
            },
            &LAYOUT,
            0,
            10,
            None,
        )
    });
    let cards = list_of(field_of(&overview_read, "entries"));
    let names = |card: &Js| -> Vec<String> { list_of(field_of(card, "names")).iter().map(text_of).collect() };
    assert_eq!(names(&cards[0]), ["Ilse", "Varro"]);
    assert_eq!(field_of(&cards[0], "label"), &named("201", "Varro", "name"));
    assert_eq!(field_of(&cards[1], "label"), &named("202", "A choir", "title"));
    assert_eq!(field_of(&cards[2], "label"), &named("203", "Saltmarrow", "name"));
    let relation = &list_of(field_of(&cards[2], "relations"))[0];
    assert_eq!(field_of(relation, "target"), &named("201", "Varro", "name"));
    assert!(names(&cards[3]).is_empty());
    assert_eq!(field_of(&cards[3], "label"), &named("204", &"é".repeat(120), "opening"));
    assert_eq!(field_of(&cards[4], "label"), &named("205", "", "opening"));
    assert_eq!(field_of(&cards[0], "picture"), &Js::Text(b"abc.png".to_vec()));
    assert_eq!(field_of(&cards[1], "picture"), &Js::Null, "an empty picture is none");
    assert_eq!(field_of(&cards[3], "picture"), &Js::Null);
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

fn pointing_at(entry: u64) -> Grouping {
    Grouping::PointingAt {
        book: 1,
        kind: IN_KIND,
        entry,
    }
}

fn outlined(read_js: &Js) -> Vec<String> {
    let mut fields = Vec::new();
    for item in list_of(field_of(read_js, "entries")) {
        outline(item, &mut fields);
    }
    fields
}

#[test]
fn what_points_at_an_entry_is_its_sources_ranked_each_drawn_with_its_region_the_entry_itself_a_repeat() {
    let dir = temp_dir("pointing-at");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&store);
    let at_lantern_house = read(&store, |view| {
        overview::read_overview(view, pointing_at(101), &LAYOUT, 0, 10, Some("1@101/102/106"))
    });
    assert_eq!(number_of(field_of(&at_lantern_house, "topLevelCount")), 5.0);
    assert_eq!(
        outlined(&at_lantern_house),
        ["1@101/102", "1@101/102/106", "1@101/102/106/107", "1@101/103", "1@101/104", "1@101/105", "1@101/110"]
    );
    assert_eq!(
        text_of(field_of(field_of(&at_lantern_house, "stepLanding"), "occurrence")),
        "1@101/102/106"
    );
    let middle = read(&store, |view| overview::read_overview(view, pointing_at(101), &LAYOUT, 2, 4, None));
    assert_eq!(outlined(&middle), ["1@101/104", "1@101/105"]);
    assert_eq!(
        number_of(field_of(&list_of(field_of(&middle, "entries"))[1], "topLevelRank")),
        3.0
    );
    let itself = read(&store, |view| overview::read_overview(view, pointing_at(109), &LAYOUT, 0, 10, None));
    assert_eq!(outlined(&itself), ["1@109/109!"]);
    let holder = read(&store, |view| overview::read_overview(view, pointing_at(108), &LAYOUT, 0, 10, None));
    assert_eq!(outlined(&holder), ["1@108/109", "1@108/109/109!"]);

    let step = |from: Option<&str>, step: OverviewStep| stepped(&store, pointing_at(101), from, step);
    let landing = |occurrence: &str, rank: f64| Some((occurrence.to_string(), rank));
    assert_eq!(step(Some("1@101/103"), OverviewStep::InReadingOrder(1)), landing("1@101/104", 2.0));
    assert_eq!(step(Some("1@101/102/106/107"), OverviewStep::InReadingOrder(1)), landing("1@101/103", 1.0));
    assert_eq!(step(Some("1@101/110"), OverviewStep::InReadingOrder(-5)), landing("1@101/102/106", 0.0));
    assert_eq!(step(None, OverviewStep::InReadingOrder(1)), landing("1@101/102", 0.0));
    assert_eq!(step(None, OverviewStep::InReadingOrder(-1)), landing("1@101/110", 4.0));
    assert_eq!(step(Some("1@101/102"), OverviewStep::ToParent), landing("1@101/102", 0.0));
    assert_eq!(step(Some("1@101/102/106"), OverviewStep::ToParent), landing("1@101/102", 0.0));
    assert_eq!(step(Some("1@101/102"), OverviewStep::ToFirstChild), landing("1@101/102/106", 0.0));
    assert_eq!(step(Some("1@108/109"), OverviewStep::InReadingOrder(1)), None, "another list's occurrence");
    assert_eq!(step(Some("1@101/111"), OverviewStep::InReadingOrder(1)), None, "not a source of this list");
    let refused = store.chat_read(|view| {
        overview::step_in_reading_order(view, pointing_at(101), &TWO_BY_TWO_THEN_ONE, Some("102"), OverviewStep::ToParent)
    });
    assert!(matches!(refused, Err(StoreError::Refused(_))), "a key of the world's overview names no list here");
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

fn sections_of(read_js: &Js) -> Vec<(String, f64, f64, Vec<String>)> {
    list_of(field_of(read_js, "sections"))
        .iter()
        .map(|section| {
            (
                text_of(field_of(section, "kindName")),
                number_of(field_of(section, "count")),
                number_of(field_of(section, "firstRank")),
                outlined(section),
            )
        })
        .collect()
}

#[test]
fn an_entrys_page_reads_a_section_per_kind_pointing_at_it_and_cuts_the_ranges_asked_longest_ago_to_one_reads_budget() {
    let dir = temp_dir("sections");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&store);
    let flat = OverviewLayout {
        regions_by_nesting_level: &[],
        card_text_characters: 10,
    };
    let sections = |entry: u64, held: Vec<overview::HeldRange>, first_shown: u64, max_cards: u64| {
        read(&store, move |view| {
            overview::read_pointing_at(view, 1, entry, &flat, &held, first_shown, max_cards)
        })
    };
    let both = sections(108, Vec::new(), 10, 100);
    assert_eq!(
        sections_of(&both),
        [
            ("in".to_string(), 1.0, 0.0, vec!["1@108/109".to_string()]),
            ("owes".to_string(), 1.0, 0.0, vec!["2@108/105".to_string()]),
        ]
    );
    let held = |kind: u64, first_rank: u64, end_rank: u64| overview::HeldRange {
        kind,
        first_rank,
        end_rank,
        step_landed_on: None,
    };
    let owes_asked = sections(108, vec![held(OWES, 0, 1)], 10, 1);
    assert_eq!(
        sections_of(&owes_asked),
        [
            ("in".to_string(), 1.0, 0.0, Vec::new()),
            ("owes".to_string(), 1.0, 0.0, vec!["2@108/105".to_string()]),
        ],
        "the range asked last is read first; what is left of the budget goes to the rest"
    );
    let lantern = sections(101, vec![held(IN_KIND, 1, 3), held(OWES, 0, 5)], 10, 100);
    assert_eq!(
        sections_of(&lantern),
        [("in".to_string(), 5.0, 1.0, vec!["1@101/103".to_string(), "1@101/104".to_string()])],
        "a held range of a kind that no longer points at it reads nothing"
    );
    assert_eq!(sections(111, Vec::new(), 10, 100), Js::Obj(vec![("sections", Js::Arr(Vec::new()))]));
    assert_eq!(sections(999, Vec::new(), 10, 100), Js::Null);
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn thousands_of_sources_are_read_and_stepped_from_any_rank_in_their_positions_order() {
    let dir = temp_dir("many-sources");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&store, 1, "one");
    let target = 10;
    let mut records = vec![create(target, ENTRY, "1:1")];
    let mut position = relations::position_between(None, None).unwrap();
    let sources = 3000u64;
    for at in 0..sources {
        let source = 100 + (at * 7919) % sources;
        records.push(create(source, ENTRY, &format!("1:{}", 2 + at)));
        let written = String::from_utf8(position.clone()).unwrap();
        records.push(set_json(source, relations::relations_field(), &strong(&[(IN_KIND, target, &written)])));
        position = relations::position_between(Some(&position), None).unwrap();
    }
    store.commit_wait(records).unwrap();
    let order: Vec<u64> = (0..sources).map(|at| 100 + (at * 7919) % sources).collect();
    let flat = OverviewLayout {
        regions_by_nesting_level: &[],
        card_text_characters: 0,
    };
    let range = |first: u64, end: u64| {
        let read_js = read(&store, |view| overview::read_overview(view, pointing_at(target), &flat, first, end, None));
        list_of(field_of(&read_js, "entries"))
            .iter()
            .map(|cell| text_of(field_of(cell, "entry")).parse::<u64>().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(range(1500, 1504), order[1500..1504]);
    assert_eq!(range(2998, 3010), order[2998..]);
    let from = format!("1@{target}/{}", order[1234]);
    let landed = read(&store, |view| {
        overview::step_in_reading_order(view, pointing_at(target), &[], Some(&from), OverviewStep::InReadingOrder(700))
    });
    assert_eq!(text_of(field_of(&landed, "occurrence")), format!("1@{target}/{}", order[1934]));
    assert_eq!(number_of(field_of(&landed, "topLevelRank")), 1934.0);
    store.close();
    let _ = fs::remove_dir_all(&dir);
}
