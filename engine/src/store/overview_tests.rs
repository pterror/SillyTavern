use std::fs;

use super::books::ENTRY;
use super::chat_read::Js;
use super::overview::{self, Grouping, OverviewLayout, OverviewStep, RegionLayout};
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

const IN: Grouping = Grouping {
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
    assert_eq!(text_of(field_of(&relations_line[0], "target")), "101");
    assert_eq!(
        text_of(field_of(&relations_line[0], "targetTitle")),
        "The Lantern House"
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
            Grouping {
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
            Grouping {
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
