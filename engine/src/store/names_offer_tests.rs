use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use super::books::ENTRY;
use super::chat_read::Js;
use super::entry_label::{self, COMMENT, ShownAs};
use super::kinds::key;
use super::names_offer::{self, NAMES_OFFER_COUNTS, NAMES_STATE_OF_ENTRY, OFFER_MARKS, OFFERED_ENTRIES};
use super::relations;
use super::relations_tests::{book, create, derive_job, history_user, rec, set_text, text};
use super::*;
use crate::log::format::{FieldRef, Record, Value};

const B: u64 = 1;

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("st-engine-names-offer-{}-{name}", std::process::id()));
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

struct Changes(u64);

impl Changes {
    fn meta(&mut self) -> Vec<Value> {
        self.0 += 1;
        vec![
            Value::Id(self.0),
            Value::Time(1_700_000_000_000 + self.0 as i64),
            Value::Absent,
            Value::Id(1),
        ]
    }

    fn set(&mut self, entity: u64, field: FieldRef, value: &str, json: bool) -> Record {
        let mut values = vec![Value::Id(entity), Value::Field(field), text(value), Value::Bit(json)];
        values.extend(self.meta());
        rec("histSet", values)
    }

    fn delete(&mut self, entity: u64, field: FieldRef) -> Record {
        let mut values = vec![Value::Id(entity), Value::Field(field)];
        values.extend(self.meta());
        rec("histDelete", values)
    }

    fn place(&mut self, entity: u64, item: u64, position: Option<u64>) -> Record {
        let mut values = vec![
            Value::Id(entity),
            Value::UInt(0),
            Value::UInt(item),
            position.map_or(Value::Absent, Value::UInt),
        ];
        values.extend(self.meta());
        rec("histPlace", values)
    }

    fn soft_delete(&mut self, entity: u64) -> Record {
        let mut values = vec![Value::Id(entity)];
        values.extend(self.meta());
        rec("histEntityDelete", values)
    }

    fn restore(&mut self, entity: u64, own_key: &str) -> Record {
        let mut values = vec![Value::Id(entity), Value::UInt(ENTRY), text(own_key), Value::F64(0.0)];
        values.extend(self.meta());
        rec("histRestore", values)
    }
}

fn key_field(item: u64) -> FieldRef {
    FieldRef::Code(library::ITEM_BASE + item * library::LISTS)
}

fn title_field() -> FieldRef {
    FieldRef::Code(COMMENT)
}

fn mark(entity: u64, names: &str) -> Record {
    rec("namesOfferMark", vec![Value::Id(entity), text(names)])
}

#[derive(Clone, Default, Debug)]
struct Entry {
    title: Option<String>,
    keys: BTreeMap<u64, String>,
    names: Option<String>,
    live: bool,
}

fn listed(names: &Option<String>) -> Option<BTreeSet<String>> {
    match names {
        None => Some(BTreeSet::new()),
        Some(json) => relations::json_strings_of_list(json.as_bytes())
            .map(|list| list.into_iter().map(|name| String::from_utf8(name).unwrap()).collect()),
    }
}

impl Entry {
    fn state(&self) -> (bool, bool) {
        if !self.live {
            return (false, false);
        }
        let Some(marked) = listed(&self.names) else {
            return (false, false);
        };
        let named = self.keys.values().any(|k| marked.contains(k));
        let title = self.title.as_deref().map(str::trim).unwrap_or("");
        let offered = !title.is_empty() && self.keys.values().any(|k| k.trim() == title && !marked.contains(k));
        (named, offered)
    }
}

fn count(store: &Store, part: u64) -> i64 {
    store.chat_read(|view| library::counter(view, &key::ids(NAMES_OFFER_COUNTS, B, part))).unwrap()
}

fn offered_index(store: &Store) -> BTreeSet<u64> {
    let prefix = key::id(OFFERED_ENTRIES, B);
    store
        .chat_read(|view| view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX))
        .unwrap()
        .into_iter()
        .map(|(k, _)| {
            let mut at = prefix.len();
            crate::keyspace::val::get_u64(&k, &mut at).unwrap()
        })
        .collect()
}

fn check(store: &Store, model: &BTreeMap<u64, Entry>, when: &str) {
    let mut named = 0;
    let mut offered = BTreeSet::new();
    for (entity, entry) in model {
        let (is_named, is_offered) = entry.state();
        named += i64::from(is_named);
        if is_offered {
            offered.insert(*entity);
        }
        let stored = store.chat_read(|view| view.get(&key::id(NAMES_STATE_OF_ENTRY, *entity))).unwrap();
        let want = u8::from(is_named) | (u8::from(is_offered) << 1);
        assert_eq!(stored.map_or(0, |b| b[0]), want, "entry {entity} {entry:?} after {when}");
    }
    assert_eq!(count(store, 0), named, "named entries after {when}");
    assert_eq!(count(store, 1), offered.len() as i64, "offered entries after {when}");
    assert_eq!(offered_index(store), offered, "the offered index after {when}");
}

const TITLES: [&str; 5] = ["Gerold Venn", " Gerold Venn ", "Ilse", "", "  "];
const KEYS: [&str; 5] = ["Gerold Venn", "Gerold Venn ", "Ilse", "lamp", "ilse"];
const NAMES: [&str; 6] = [r#"["Gerold Venn"]"#, r#"["Ilse","lamp"]"#, r#"{"x":1}"#, "[]", r#"["Gerold Venn "]"#, r#"["ilse"]"#];

struct Rng(u64);

impl Rng {
    fn below(&mut self, bound: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % bound
    }

    fn pick<'a>(&mut self, from: &[&'a str]) -> &'a str {
        from[self.below(from.len() as u64) as usize]
    }
}

fn fields_of_new(changes: &mut Changes, rng: &mut Rng, entity: u64, entry: &mut Entry) -> Vec<Record> {
    let mut records = Vec::new();
    if rng.below(3) > 0 {
        let title = rng.pick(&TITLES);
        records.push(changes.set(entity, title_field(), title, false));
        entry.title = Some(title.into());
    }
    for item in 0..rng.below(4) {
        let key_text = rng.pick(&KEYS);
        records.push(changes.set(entity, key_field(item), key_text, false));
        records.push(changes.place(entity, item, Some(item + 1)));
        entry.keys.insert(item, key_text.into());
    }
    if rng.below(2) == 0 {
        let names = rng.pick(&NAMES);
        records.push(changes.set(entity, entry_label::names_field(), names, true));
        entry.names = Some(names.into());
    }
    records
}

#[test]
fn every_write_of_an_entry_keeps_whether_it_is_named_or_offered_and_the_conversion_builds_the_same() {
    let dir = temp_dir("model");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    history_user(&store);
    book(&store, B, "one");
    let mut changes = Changes(0);
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut model: BTreeMap<u64, Entry> = BTreeMap::new();
    let mut next = 100;
    let mut reached = (0, 0);
    for round in 0..400 {
        let entities: Vec<u64> = model.keys().copied().collect();
        let live: Vec<u64> = model.iter().filter(|(_, e)| e.live).map(|(id, _)| *id).collect();
        let what = if live.is_empty() { 0 } else { rng.below(10) };
        let entity = if what == 0 {
            next += 1;
            next
        } else if what == 9 {
            entities[rng.below(entities.len() as u64) as usize]
        } else {
            live[rng.below(live.len() as u64) as usize]
        };
        let own_key = format!("{B}:{}", entity - 100);
        let mut records = Vec::new();
        let entry = model.entry(entity).or_default();
        match what {
            0 => {
                entry.live = true;
                let fields = fields_of_new(&mut changes, &mut rng, entity, entry);
                if rng.below(2) == 0 {
                    records.extend(fields);
                    records.push(create(entity, ENTRY, &own_key));
                } else {
                    records.push(create(entity, ENTRY, &own_key));
                    records.extend(fields);
                }
            }
            1 => {
                let title = rng.pick(&TITLES);
                if entry.title.as_deref() == Some(title) {
                    continue;
                }
                records.push(changes.set(entity, title_field(), title, false));
                entry.title = Some(title.into());
            }
            2 if entry.title.is_some() => {
                records.push(changes.delete(entity, title_field()));
                entry.title = None;
            }
            3 | 2 => {
                let item = rng.below(4);
                let key_text = rng.pick(&KEYS);
                if entry.keys.get(&item).map(String::as_str) == Some(key_text) {
                    continue;
                }
                records.push(changes.set(entity, key_field(item), key_text, false));
                if !entry.keys.contains_key(&item) {
                    records.push(changes.place(entity, item, Some(item + 1)));
                }
                entry.keys.insert(item, key_text.into());
            }
            4 if !entry.keys.is_empty() => {
                let item = *entry.keys.keys().nth(rng.below(entry.keys.len() as u64) as usize).unwrap();
                records.push(changes.place(entity, item, None));
                records.push(changes.delete(entity, key_field(item)));
                entry.keys.remove(&item);
            }
            4 | 5 => {
                let names = rng.pick(&NAMES);
                if entry.names.as_deref() == Some(names) {
                    continue;
                }
                records.push(changes.set(entity, entry_label::names_field(), names, true));
                entry.names = Some(names.into());
            }
            6 if entry.names.is_some() => {
                records.push(changes.delete(entity, entry_label::names_field()));
                entry.names = None;
            }
            6 | 7 => {
                records.push(changes.soft_delete(entity));
                entry.live = false;
            }
            _ if !entry.live => {
                records.push(changes.restore(entity, &own_key));
                entry.live = true;
            }
            _ => {
                let title = rng.pick(&TITLES);
                if entry.title.as_deref() == Some(title) {
                    continue;
                }
                records.push(changes.set(entity, title_field(), title, false));
                entry.title = Some(title.into());
            }
        }
        store.commit_wait(records).unwrap();
        check(&store, &model, &format!("round {round}"));
        reached.0 = reached.0.max(count(&store, 0));
        reached.1 = reached.1.max(count(&store, 1));
    }
    assert!(reached.0 > 1 && reached.1 > 1, "the rounds reach both states: {reached:?}");

    derive_job(&store, |view, out| {
        for structure in [NAMES_STATE_OF_ENTRY, OFFERED_ENTRIES, NAMES_OFFER_COUNTS] {
            let prefix = key::of(structure);
            for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
                out.del(stored_key);
            }
        }
        Ok(())
    });
    assert!(offered_index(&store).is_empty());
    for _ in 0..2 {
        let mut after: Option<Vec<u8>> = None;
        loop {
            let from = after.clone();
            after = derive_job(&store, move |view, out| relations::world_order_conversion_step(view, out, from.as_deref(), 7));
            if after.is_none() {
                break;
            }
        }
        check(&store, &model, "the conversion");
    }
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

fn field<'a>(fields: &'a Js, name: &str) -> &'a Js {
    let Js::Obj(field) = fields else { panic!("not an object: {fields:?}") };
    &field.iter().find(|(key_name, _)| *key_name == name).unwrap_or_else(|| panic!("no {name}")).1
}

fn texts(list: &Js) -> Vec<String> {
    let Js::Arr(items) = list else { panic!("not a list: {list:?}") };
    items
        .iter()
        .map(|item| match item {
            Js::Text(t) => String::from_utf8(t.clone()).unwrap(),
            other => panic!("not text: {other:?}"),
        })
        .collect()
}

fn chunk(store: &Store) -> Vec<(u64, Vec<String>, Vec<String>)> {
    let read = store.chat_read(|view| names_offer::job_chunk(view, B, 1000)).unwrap();
    let Js::Arr(entries) = field(&read, "entries") else { panic!() };
    entries
        .iter()
        .map(|e| {
            let Js::Big(entity) = field(e, "entity") else { panic!() };
            (*entity, texts(field(e, "names")), texts(field(e, "marked")))
        })
        .collect()
}

fn offer(store: &Store) -> Js {
    store.chat_read(|view| names_offer::read_offer(view, B)).unwrap()
}

fn marks(store: &Store) -> BTreeSet<u64> {
    let prefix = key::id(OFFER_MARKS, B);
    store
        .chat_read(|view| view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX))
        .unwrap()
        .into_iter()
        .map(|(k, _)| {
            let mut at = prefix.len();
            crate::keyspace::val::get_u64(&k, &mut at).unwrap()
        })
        .collect()
}

fn names_json(names: &[String]) -> String {
    let quoted: Vec<String> = names.iter().map(|name| format!("\"{name}\"")).collect();
    format!("[{}]", quoted.join(","))
}

#[test]
fn the_offers_marks_last_until_the_entrys_names_are_written_again_and_its_jobs_read_their_chunks_from_the_kept_indexes() {
    let dir = temp_dir("marks");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    history_user(&store);
    book(&store, B, "one");
    let mut changes = Changes(0);
    let mut records = Vec::new();
    for (entity, title, keys) in [
        (101, "Gerold Venn", vec!["Gerold", " Gerold Venn", "Venn"]),
        (102, "Ilse", vec!["Ilse", "lamp"]),
        (103, "The Pale Choir", vec!["choir"]),
        (104, "Saltmarrow", vec!["Saltmarrow"]),
    ] {
        records.push(create(entity, ENTRY, &format!("{B}:{}", entity - 100)));
        records.push(changes.set(entity, title_field(), title, false));
        for (item, key_text) in keys.iter().enumerate() {
            records.push(changes.set(entity, key_field(item as u64), key_text, false));
            records.push(changes.place(entity, item as u64, Some(item as u64 + 1)));
        }
    }
    store.commit_wait(records).unwrap();
    assert_eq!(field(&offer(&store), "offeredEntries"), &Js::Num(3.0));
    assert_eq!(field(&offer(&store), "namedEntries"), &Js::Num(0.0));
    assert_eq!(field(&offer(&store), "state"), &Js::Null);
    let read = offer(&store);
    let Js::Obj(example) = field(&read, "example") else { panic!() };
    assert_eq!(example[1].1, Js::Text(b"Gerold Venn".to_vec()), "the example is the first offered entry, by its label");
    assert_eq!(chunk(&store), vec![], "no job runs");

    store.commit_wait(vec![set_text(B, names_offer::offer_field(), "marking")]).unwrap();
    let pending = store.chat_read(relations::pending_worldbuilding_jobs).unwrap();
    assert_eq!(texts_of_books(field(&pending, "namesOffers")), vec![B]);
    let marking = chunk(&store);
    assert_eq!(
        marking,
        vec![
            (101, vec![" Gerold Venn".into()], vec![" Gerold Venn".into()]),
            (102, vec!["Ilse".into()], vec!["Ilse".into()]),
            (104, vec!["Saltmarrow".into()], vec!["Saltmarrow".into()]),
        ]
    );
    let mut step = Vec::new();
    for (entity, names, marked) in &marking {
        step.push(changes.set(*entity, entry_label::names_field(), &names_json(names), true));
        step.push(mark(*entity, &names_json(marked)));
    }
    step.push(set_text(B, names_offer::offer_field(), "done"));
    store.commit_wait(step).unwrap();
    assert_eq!(field(&offer(&store), "offeredEntries"), &Js::Num(0.0));
    assert_eq!(field(&offer(&store), "namedEntries"), &Js::Num(3.0));
    assert_eq!(field(&offer(&store), "marks"), &Js::Num(3.0));
    assert_eq!(marks(&store), BTreeSet::from([101, 102, 104]));
    let pending = store.chat_read(relations::pending_worldbuilding_jobs).unwrap();
    assert_eq!(texts_of_books(field(&pending, "namesOffers")), Vec::<u64>::new());
    let label = store.chat_read(|view| entry_label::named(view, Some(0), 101)).unwrap();
    assert_eq!(label.shown_as, ShownAs::Name, "a name with the title's words shows the title as a name");

    store
        .commit_wait(vec![changes.set(102, entry_label::names_field(), r#"["Ilse","lamp"]"#, true)])
        .unwrap();
    assert_eq!(marks(&store), BTreeSet::from([101, 104]), "the author's own names write drops the mark");
    store.commit_wait(vec![changes.soft_delete(104)]).unwrap();
    assert_eq!(marks(&store), BTreeSet::from([101]), "a deleted entry has no mark");
    assert_eq!(field(&offer(&store), "marks"), &Js::Num(1.0));

    store.commit_wait(vec![set_text(B, names_offer::offer_field(), "undoing")]).unwrap();
    assert_eq!(chunk(&store), vec![(101, vec![], vec![])]);
    store
        .commit_wait(vec![changes.set(101, entry_label::names_field(), "[]", true), mark(101, "[]")])
        .unwrap();
    assert!(marks(&store).is_empty());
    assert_eq!(field(&offer(&store), "marks"), &Js::Num(0.0));
    assert_eq!(field(&offer(&store), "offeredEntries"), &Js::Num(1.0));
    store.commit_wait(vec![mark(102, r#"["Ilse"]"#), mark(102, "[]")]).unwrap();
    assert!(marks(&store).is_empty(), "[] takes a mark away, with no names write");
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

fn texts_of_books(list: &Js) -> Vec<u64> {
    let Js::Arr(items) = list else { panic!() };
    items
        .iter()
        .map(|item| match field(item, "book") {
            Js::Big(book) => *book,
            other => panic!("{other:?}"),
        })
        .collect()
}
