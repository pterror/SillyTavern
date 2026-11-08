use std::fs;

use super::books::ENTRY;
use super::chat_read::Js;
use super::overview::{self, Grouping, Move};
use super::relations;
use super::relations_tests::{book, create, index, json_of, rec, set_json, text};
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

fn set_text(e: u64, f: u64, t: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Sel(0, e),
            Value::Field(FieldRef::Code(f)),
            text(t),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn get<'a>(o: &'a Js, name: &str) -> &'a Js {
    let Js::Obj(f) = o else {
        panic!("not an object: {o:?}")
    };
    &f.iter()
        .find(|(k, _)| *k == name)
        .unwrap_or_else(|| panic!("no {name}"))
        .1
}

fn s(j: &Js) -> String {
    match j {
        Js::Text(t) => String::from_utf8(t.clone()).unwrap(),
        other => panic!("not a text: {other:?}"),
    }
}

fn n(j: &Js) -> f64 {
    match j {
        Js::Num(x) => *x,
        other => panic!("not a number: {other:?}"),
    }
}

fn arr(j: &Js) -> &[Js] {
    match j {
        Js::Arr(a) => a,
        other => panic!("not a list: {other:?}"),
    }
}

fn outline(item: &Js, out: &mut Vec<String>) {
    let key = s(get(item, "key"));
    if s(get(item, "kind")) == "more" {
        out.push(format!("{key}={}", n(get(item, "more"))));
        return;
    }
    let repeat = get(item, "repeat") == &Js::Bool(true);
    out.push(if repeat { format!("{key}!") } else { key });
    for c in arr(get(item, "children")) {
        outline(c, out);
    }
}

const IN: Grouping = Grouping {
    book: 1,
    relation: Some(b"in"),
};

fn world(s: &Store) {
    book(s, 1, "one");
    let e = |uid: u64| 100 + uid;
    let entry = |uid: u64, at: f64, rels: &[(&str, u64, &str)]| {
        let mut r = vec![
            create(e(uid), ENTRY, &format!("1:{uid}")),
            index(e(uid), 1, Some(at)),
        ];
        if !rels.is_empty() {
            r.push(set_json(e(uid), relations::field(), &json_of(rels)));
        }
        r
    };
    let mut r = Vec::new();
    r.extend(entry(11, -1.0, &[]));
    r.extend(entry(1, 0.0, &[]));
    r.extend(entry(2, 1.0, &[("in", 1, "a")]));
    r.extend(entry(3, 2.0, &[("in", 1, "b")]));
    r.extend(entry(4, 3.0, &[("in", 1, "c")]));
    r.extend(entry(5, 4.0, &[("in", 1, "d"), ("owes", 8, "a")]));
    r.extend(entry(6, 5.0, &[("in", 2, "a")]));
    r.extend(entry(7, 6.0, &[("in", 6, "a")]));
    r.extend(entry(8, 7.0, &[]));
    r.extend(entry(9, 8.0, &[("in", 8, "a"), ("in", 9, "a")]));
    r.push(set_text(e(1), 103, "The Lantern House"));
    r.push(set_text(e(1), 104, &"word ".repeat(100)));
    r.push(set_text(e(1), library::ITEM_BASE, "lantern"));
    r.push(rec(
        "itemPlace",
        vec![
            Value::Id(e(1)),
            Value::UInt(0),
            Value::UInt(0),
            Value::UInt(1),
        ],
    ));
    s.commit_wait(r).unwrap();
}

fn read<T>(s: &Store, f: impl FnOnce(&derive::View) -> StoreResult<T>) -> T {
    s.chat_read(f).unwrap()
}

fn moved(st: &Store, g: Grouping, from: Option<&str>, how: Move) -> Option<(String, f64)> {
    let j = read(st, |v| overview::moved(v, g, from, how));
    (j != Js::Null).then(|| (s(get(&j, "key")), n(get(&j, "rank"))))
}

#[test]
fn the_overview_is_the_top_with_each_region_cut_short_a_count_per_cut_and_repeats_closed() {
    let dir = temp_dir("window");
    let st = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&st);
    let w = read(&st, |v| overview::window(v, IN, 0, 10, Some("101/102/999")));
    assert_eq!(n(get(&w, "count")), 3.0);
    let mut o = Vec::new();
    for item in arr(get(&w, "items")) {
        outline(item, &mut o);
    }
    assert_eq!(
        o,
        [
            "111",
            "101",
            "101/102",
            "101/102/106",
            "101/102/106/+=1",
            "101/103",
            "101/104",
            "101/+=1",
            "108",
            "108/109",
            "108/109/109!",
        ]
    );
    let a = &arr(get(&w, "items"))[1];
    assert_eq!(n(get(a, "rank")), 1.0);
    assert_eq!(n(get(a, "members")), 4.0);
    assert_eq!(s(get(a, "title")), "The Lantern House");
    assert_eq!(get(a, "cut"), &Js::Bool(true));
    assert_eq!(s(get(a, "text")).len(), overview::TEXT);
    assert_eq!(arr(get(a, "keys")), [Js::Text(b"lantern".to_vec())]);
    let b = &arr(get(a, "children"))[0];
    let rels = arr(get(b, "relations"));
    assert_eq!(s(get(&rels[0], "relation")), "in");
    assert_eq!(s(get(&rels[0], "entry")), "101");
    assert_eq!(s(get(&rels[0], "title")), "The Lantern House");
    assert_eq!(s(get(get(&w, "active"), "key")), "101/102");
    let second = read(&st, |v| overview::window(v, IN, 2, 3, None));
    assert_eq!(n(get(&second, "from")), 2.0);
    assert_eq!(s(get(&arr(get(&second, "items"))[0], "key")), "108");
    let plain = read(&st, |v| {
        overview::window(
            v,
            Grouping {
                book: 1,
                relation: None,
            },
            0,
            100,
            None,
        )
    });
    assert_eq!(n(get(&plain, "count")), 10.0);
    assert!(
        arr(get(&plain, "items"))
            .iter()
            .all(|i| arr(get(i, "children")).is_empty())
    );
    let owes = read(&st, |v| {
        overview::window(
            v,
            Grouping {
                book: 1,
                relation: Some(b"owes"),
            },
            0,
            100,
            None,
        )
    });
    assert_eq!(n(get(&owes, "count")), 9.0);
    let mut o = Vec::new();
    let h = arr(get(&owes, "items"))
        .iter()
        .find(|i| s(get(i, "key")) == "108")
        .unwrap();
    outline(h, &mut o);
    assert_eq!(o, ["108", "108/105"]);
    st.close();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_move_steps_through_reading_order_across_top_level_entries_and_hops_to_parents_and_children() {
    let dir = temp_dir("move");
    let st = Store::open_in(&dir, SMALL, pool()).unwrap();
    world(&st);
    let m = |from: Option<&str>, how: Move| moved(&st, IN, from, how);
    let at = |k: &str, r: f64| Some((k.to_string(), r));
    assert_eq!(m(None, Move::By(1)), at("111", 0.0));
    assert_eq!(m(None, Move::By(2)), at("101", 1.0));
    assert_eq!(m(None, Move::By(-1)), at("108/109/109", 2.0));
    assert_eq!(m(Some("101/102"), Move::By(1)), at("101/102/106", 1.0));
    assert_eq!(m(Some("101/102/106/+"), Move::By(3)), at("101/+", 1.0));
    assert_eq!(m(Some("101/+"), Move::By(1)), at("108", 2.0));
    assert_eq!(m(Some("108"), Move::By(-1)), at("101/+", 1.0));
    assert_eq!(m(Some("111"), Move::By(9)), at("108/109", 2.0));
    assert_eq!(m(Some("111"), Move::By(100)), at("108/109/109", 2.0));
    assert_eq!(m(Some("108/109"), Move::By(-100)), at("111", 0.0));
    assert_eq!(m(Some("101/102/106"), Move::Parent), at("101/102", 1.0));
    assert_eq!(m(Some("101/+"), Move::Parent), at("101", 1.0));
    assert_eq!(m(Some("101"), Move::Parent), at("101", 1.0));
    assert_eq!(m(Some("101"), Move::Child), at("101/102", 1.0));
    assert_eq!(
        m(Some("101/102/106"), Move::Child),
        at("101/102/106/+", 1.0)
    );
    assert_eq!(m(Some("108/109/109"), Move::Child), at("108/109/109", 2.0));
    assert_eq!(m(Some("101/104/77"), Move::By(0)), at("101/104", 1.0));
    assert_eq!(m(Some("102"), Move::By(0)), None);
    assert!(read(&st, |v| Ok(overview::moved(
        v,
        IN,
        Some("1//2"),
        Move::By(1)
    )
    .is_err())));
    st.commit_wait(vec![rec("entityDelete", vec![Value::Id(101)])])
        .unwrap();
    let w = read(&st, |v| overview::window(v, IN, 0, 10, None));
    let keys: Vec<String> = arr(get(&w, "items"))
        .iter()
        .map(|i| s(get(i, "key")))
        .collect();
    assert_eq!(keys, ["111", "108"]);
    st.close();
    let _ = fs::remove_dir_all(&dir);
}
