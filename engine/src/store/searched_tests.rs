//! Search entries of the library's, books' and sessions' values against a store holding only the final state,
//! and words found against a model of the values.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use super::books::{BOOK, ENTRY, OWNED};
use super::chat;
use super::library::{CHARACTER, GROUP, TAG, item_field};
use super::*;
use crate::keyspace::val::{counter_value, map_pairs};
use crate::log::format::{Value, kind_by_name};
use crate::search::query::{Limits, Order, Query};
use crate::search::text::tokens;
use crate::search::{BOOK_FIELDS, LIBRARY_FIELDS, Scope};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-searched-{}-{name}-{}",
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

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn text(s: &str) -> Value {
    Value::Text(s.as_bytes().to_vec())
}

fn code(c: u64) -> Value {
    Value::Field(FieldRef::Code(c))
}

fn set(e: u64, f: u64, s: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Sel(0, e),
            code(f),
            text(s),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn json(e: u64, f: u64, s: &str) -> Record {
    rec(
        "jsonValue",
        vec![
            Value::Sel(0, e),
            code(f),
            text(s),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn unset(e: u64, f: u64) -> Record {
    rec(
        "valueDelete",
        vec![Value::Sel(0, e), code(f), Value::Absent, Value::Absent],
    )
}

fn create(e: u64, kind: u64, key: &str) -> Record {
    rec(
        "entityCreate",
        vec![Value::Id(e), Value::UInt(kind), text(key), Value::Time(0)],
    )
}

const WORDS: &[&str] = &[
    "dark", "knight", "dragon", "drab", "love", "the", "quokka", "élan", "o'neil", "foo-bar", "12",
    "east",
];

/// An entity's values: text by field code (list items by their item field), JSON by code.
#[derive(Clone, Debug, Default)]
struct Ent {
    kind: u64,
    key: String,
    texts: BTreeMap<u64, String>,
    jsons: BTreeMap<u64, String>,
    /// An item's field → its position.
    items: BTreeMap<u64, u64>,
}

/// Which codes and lists an entity of each type is given.
fn fields_of(kind: u64) -> (&'static [u64], &'static [u64]) {
    match kind {
        CHARACTER => (&[1, 2, 10, 11, 12, 13, 14, 15, 16], &[0, 1, 2]),
        GROUP => (&[1, 30], &[3]),
        TAG => (&[1], &[]),
        _ => (&[103, 104, 127, 134, 151, 170, 177], &[0, 1, 3, 4]),
    }
}

/// Live sessions' names.
type Sessions = BTreeMap<u64, Option<String>>;

struct Model {
    ents: BTreeMap<u64, Ent>,
    sessions: Sessions,
    seed: u64,
    next: u64,
    next_session: u64,
}

const WORLD: u64 = 500;
const CHAR_BOOK: u64 = 501;
const ORIGINAL: u64 = 502;

impl Model {
    fn rand(&mut self) -> u64 {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        self.seed
    }

    fn words(&mut self) -> String {
        let n = self.rand() % 4 + 1;
        (0..n)
            .map(|_| WORDS[(self.rand() % WORDS.len() as u64) as usize])
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn pick(&mut self, xs: &[u64]) -> u64 {
        xs[(self.rand() % xs.len() as u64) as usize]
    }

    /// The records creating entity `e` with some values.
    fn make(&mut self, e: u64, kind: u64, key: String) -> Vec<Record> {
        let mut ent = Ent {
            kind,
            key,
            ..Default::default()
        };
        let (codes, lists) = fields_of(kind);
        let mut out = Vec::new();
        for &c in codes {
            if !self.rand().is_multiple_of(3) {
                let w = self.words();
                out.push(set(e, c, &w));
                ent.texts.insert(c, w);
            }
        }
        for &l in lists {
            for i in 0..self.rand() % 3 {
                let w = self.words();
                out.push(set(e, ITEM_F(l, i), &w));
                out.push(place(e, l, i, i * 10));
                ent.texts.insert(ITEM_F(l, i), w);
                ent.items.insert(ITEM_F(l, i), i * 10);
            }
        }
        if kind == ENTRY && self.rand().is_multiple_of(3) {
            let u = format!("\"{}\"", self.words());
            out.push(json(e, 100, &u));
            ent.jsons.insert(100, u);
        }
        let k = ent.key.clone();
        self.ents.insert(e, ent);
        out.push(create(e, kind, &k));
        out
    }

    fn step(&mut self) -> Vec<Record> {
        let ids: Vec<u64> = self.ents.keys().copied().filter(|e| *e < WORLD).collect();
        match self.rand() % 12 {
            0 => {
                let e = self.next;
                self.next += 1;
                let kind = self.pick(&[CHARACTER, CHARACTER, GROUP, TAG, ENTRY]);
                let key = if kind == ENTRY {
                    let b = self.pick(&[WORLD, CHAR_BOOK, ORIGINAL]);
                    format!("{b}:{e}")
                } else {
                    format!("k{e}")
                };
                self.make(e, kind, key)
            }
            1 if !ids.is_empty() => {
                let e = self.pick(&ids);
                let ent = self.ents.remove(&e).unwrap();
                let mut out = Vec::new();
                if ent.kind == TAG {
                    out.push(rec("tagMerge", vec![Value::Id(e), Value::Absent]));
                }
                out.push(rec("entityDelete", vec![Value::Id(e)]));
                out
            }
            2..=4 if !ids.is_empty() => {
                // A whole text value, or (at random) a list item's.
                let e = self.pick(&ids);
                let (codes, lists) = fields_of(self.ents[&e].kind);
                let w = self.words();
                if !lists.is_empty() && self.rand().is_multiple_of(2) {
                    let l = self.pick(lists);
                    let item = self.rand() % 4;
                    let f = ITEM_F(l, item);
                    let ent = self.ents.get_mut(&e).unwrap();
                    ent.texts.insert(f, w.clone());
                    let mut out = vec![set(e, f, &w)];
                    if let std::collections::btree_map::Entry::Vacant(v) = ent.items.entry(f) {
                        v.insert(100 + item);
                        out.push(place(e, l, item, 100 + item));
                    }
                    return out;
                }
                let c = self.pick(codes);
                self.ents.get_mut(&e).unwrap().texts.insert(c, w.clone());
                vec![set(e, c, &w)]
            }
            5 | 6 if !ids.is_empty() => {
                // An edit appending a word to a text the entity has.
                let e = self.pick(&ids);
                let fs: Vec<u64> = self.ents[&e].texts.keys().copied().collect();
                if fs.is_empty() {
                    return Vec::new();
                }
                let f = self.pick(&fs);
                let w = format!(" {}", self.words());
                let old = self.ents[&e].texts[&f].clone();
                self.ents
                    .get_mut(&e)
                    .unwrap()
                    .texts
                    .insert(f, format!("{old}{w}"));
                vec![rec(
                    "textEdit",
                    vec![
                        Value::Sel(0, e),
                        code(f),
                        Value::UInt(old.len() as u64),
                        Value::UInt(0),
                        text(&w),
                        Value::Absent,
                        Value::Absent,
                    ],
                )]
            }
            7 if !ids.is_empty() => {
                // A value or an item goes.
                let e = self.pick(&ids);
                let fs: Vec<u64> = self.ents[&e].texts.keys().copied().collect();
                if fs.is_empty() {
                    return Vec::new();
                }
                let f = self.pick(&fs);
                let ent = self.ents.get_mut(&e).unwrap();
                ent.texts.remove(&f);
                if f >= 1024 {
                    let (l, item) = ((f - 1024) % 8, (f - 1024) / 8);
                    if ent.items.remove(&f).is_some() {
                        return vec![rec(
                            "itemDelete",
                            vec![Value::Id(e), Value::UInt(l), Value::UInt(item)],
                        )];
                    }
                }
                vec![unset(e, f)]
            }
            8 if !ids.is_empty() => {
                // An entry's uid, its no-uid marker, or a character book entry's id.
                let e = self.pick(&ids);
                if self.ents[&e].kind != ENTRY {
                    return Vec::new();
                }
                let c = self.pick(&[100, 97, 153]);
                let ent = self.ents.get_mut(&e).unwrap();
                if ent.jsons.remove(&c).is_some() {
                    return vec![unset(e, c)];
                }
                let v = if c == 97 {
                    String::new()
                } else {
                    format!("{}", self.seed % 1000)
                };
                self.ents.get_mut(&e).unwrap().jsons.insert(c, v.clone());
                vec![json(e, c, &v)]
            }
            9 if !ids.is_empty() => {
                // A group's id changes.
                let e = self.pick(&ids);
                if self.ents[&e].kind != GROUP {
                    return Vec::new();
                }
                let key = format!("k{} {}", self.rand() % 1000, self.words());
                if self.ents.values().any(|x| x.kind == GROUP && x.key == key) {
                    return Vec::new();
                }
                self.ents.get_mut(&e).unwrap().key = key.clone();
                vec![rec(
                    "entityUpdate",
                    vec![Value::Id(e), Value::UInt(GROUP), text(&key), Value::Time(0)],
                )]
            }
            10 => {
                // A session made, named or unnamed.
                let ids: Vec<u64> = self.sessions.keys().copied().collect();
                if ids.is_empty() || self.rand().is_multiple_of(3) {
                    let s = self.next_session;
                    self.next_session += 1;
                    self.sessions.insert(s, None);
                    return vec![rec(
                        "keyMap",
                        vec![
                            Value::Sel(chat::KEYED_SESSION, s),
                            Value::Bytes(format!("session-{s}").into_bytes()),
                        ],
                    )];
                }
                let s = self.pick(&ids);
                let name = (!self.rand().is_multiple_of(3)).then(|| self.words());
                self.sessions.insert(s, name.clone());
                vec![rec(
                    "positionName",
                    vec![Value::Id(s), name.map_or(Value::Absent, |n| text(&n))],
                )]
            }
            11 => {
                let ids: Vec<u64> = self.sessions.keys().copied().collect();
                if ids.is_empty() {
                    return Vec::new();
                }
                let s = self.pick(&ids);
                self.sessions.remove(&s);
                vec![rec("positionDelete", vec![Value::Id(s)])]
            }
            _ => Vec::new(),
        }
    }

    /// Records making the model's state from nothing: the books, the entities, the sessions.
    fn records_of_state(&self) -> Vec<Record> {
        let mut out = books();
        for (&e, ent) in self.ents.iter().filter(|(e, _)| **e < WORLD) {
            for (c, t) in &ent.texts {
                out.push(set(e, *c, t));
            }
            for (f, p) in &ent.items {
                out.push(place(e, (f - 1024) % 8, (f - 1024) / 8, *p));
            }
            for (c, j) in &ent.jsons {
                out.push(json(e, *c, j));
            }
            out.push(create(e, ent.kind, &ent.key));
        }
        for (s, name) in &self.sessions {
            out.push(rec(
                "keyMap",
                vec![
                    Value::Sel(chat::KEYED_SESSION, *s),
                    Value::Bytes(format!("session-{s}").into_bytes()),
                ],
            ));
            if let Some(n) = name {
                out.push(rec("positionName", vec![Value::Id(*s), text(n)]));
            }
        }
        out
    }
}

#[allow(non_snake_case)]
fn ITEM_F(list: u64, item: u64) -> u64 {
    match item_field(list, item) {
        FieldRef::Code(c) => c,
        FieldRef::Key(_) => unreachable!(),
    }
}

fn place(e: u64, list: u64, item: u64, position: u64) -> Record {
    rec(
        "itemPlace",
        vec![
            Value::Id(e),
            Value::UInt(list),
            Value::UInt(item),
            Value::UInt(position),
        ],
    )
}

/// A world book, a character's own book and a book's `originalData`.
fn books() -> Vec<Record> {
    vec![
        json(WORLD, 41, ""),
        create(WORLD, BOOK, "lore"),
        create(CHAR_BOOK, OWNED, "1:c"),
        create(ORIGINAL, OWNED, "500:o"),
    ]
}

/// The search entries that follow from the current values alone (maxima, which only rise, and top lists, built
/// by queries, are left out); zero counters and removed slots dropped.
fn search_entries(s: &Store) -> Vec<(Vec<u8>, String)> {
    let mut out = Vec::new();
    for st in [
        key::SEARCH_POSTING,
        key::SEARCH_DOC_FREQ,
        key::SEARCH_LENGTH,
        key::SEARCH_TERM_DOCS,
        key::SEARCH_FIELD_TOKENS,
        key::SEARCH_DOCS,
    ] {
        let p = key::of(st);
        for (k, v) in s.scan(&p, &key::prefix_end(&p), usize::MAX).unwrap() {
            let v = if st == key::SEARCH_POSTING || st == key::SEARCH_LENGTH {
                let pairs: Vec<_> = map_pairs(&v)
                    .unwrap()
                    .into_iter()
                    .filter(|p| p.1 != 0)
                    .collect();
                if pairs.is_empty() {
                    continue;
                }
                format!("{pairs:?}")
            } else {
                let n = counter_value(&v).unwrap();
                if n == 0 {
                    continue;
                }
                n.to_string()
            };
            out.push((k, v));
        }
    }
    out
}

fn query(scope: Scope, word: &str, fields: Option<Vec<u32>>) -> Query {
    Query {
        scope,
        clauses: vec![crate::search::query::Clause {
            text: word.as_bytes().to_vec(),
            fields,
            negate: false,
            quoted: false,
        }],
        filters: Vec::new(),
        order: Order::Relevance,
        limit: 1000,
        after: None,
        limits: Limits::default(),
    }
}

/// Whether a value holds the one-token `word` as a query's last word: a whole token, or in a prefix field a token's prefix of
/// two characters or more.
fn holds(values: &[String], word: &str, prefix: bool) -> bool {
    let w = &tokens(word.as_bytes())[0];
    values.iter().any(|v| {
        tokens(v.as_bytes())
            .iter()
            .any(|t| t == w || (prefix && w.chars().count() >= 2 && t.starts_with(w.as_str())))
    })
}

impl Model {
    /// The documents of `scope` whose field `field` holds `word`, from the model.
    fn expected(&self, scope: Scope, field: u32, word: &str) -> BTreeSet<u64> {
        let mut out = BTreeSet::new();
        if scope == Scope::SESSIONS {
            for (s, n) in &self.sessions {
                if let Some(n) = n
                    && holds(std::slice::from_ref(n), word, true)
                {
                    out.insert(*s);
                }
            }
            return out;
        }
        for (&e, ent) in &self.ents {
            let values = |codes: &[u64]| -> Vec<String> {
                codes
                    .iter()
                    .filter_map(|c| ent.texts.get(c).cloned())
                    .collect()
            };
            let list = |l: u64| -> Vec<String> {
                ent.items
                    .keys()
                    .filter(|f| (*f - 1024) % 8 == l)
                    .filter_map(|f| ent.texts.get(f).cloned())
                    .collect()
            };
            let (in_scope, vals, prefix) = match (ent.kind, scope.kind) {
                (CHARACTER | GROUP, crate::search::LIBRARY) => {
                    let p = LIBRARY_FIELDS[field as usize].prefix;
                    let v = match (ent.kind, field) {
                        (_, 0) => values(&[1]),
                        (CHARACTER, 1) => values(&[10]),
                        (CHARACTER, 2) => values(&[14]),
                        (CHARACTER, 3) => values(&[12]),
                        (CHARACTER, 4) => values(&[11]),
                        (CHARACTER, 5) => values(&[13]),
                        (CHARACTER, 6) => values(&[15]),
                        (CHARACTER, 7) => values(&[2]),
                        (CHARACTER, 8) => list(2),
                        (CHARACTER, 9) => list(0),
                        (GROUP, 10) => list(3),
                        (GROUP, 11) => vec![ent.key.clone()],
                        _ => Vec::new(),
                    };
                    (true, v, p)
                }
                (TAG, crate::search::TAGS) => (true, values(&[1]), true),
                (ENTRY, crate::search::BOOK) => {
                    let book: u64 = ent.key.split(':').next().unwrap().parse().unwrap();
                    if book != scope.owner || book == ORIGINAL {
                        (false, Vec::new(), false)
                    } else {
                        let world = book == WORLD;
                        let p = BOOK_FIELDS[field as usize].prefix;
                        let uid = || -> Vec<String> {
                            let c = if world { 100 } else { 153 };
                            match ent.jsons.get(&c) {
                                Some(j) => vec![j.clone()],
                                None if world && !ent.jsons.contains_key(&97) => {
                                    vec![ent.key.split(':').nth(1).unwrap().to_string()]
                                }
                                None => Vec::new(),
                            }
                        };
                        let v = match (world, field) {
                            (true, 0) => list(0),
                            (false, 0) => list(3),
                            (true, 1) => values(&[127]),
                            (false, 1) => values(&[170]),
                            (_, 2) => values(&[103]),
                            (true, 3) => list(1),
                            (false, 3) => list(4),
                            (_, 4) => values(&[104]),
                            (_, 5) => uid(),
                            (true, 6) => values(&[134]),
                            (false, 6) => values(&[177]),
                            _ => Vec::new(),
                        };
                        (true, v, p)
                    }
                }
                _ => (false, Vec::new(), false),
            };
            if in_scope && holds(&vals, word, prefix) {
                out.insert(e);
            }
        }
        out
    }
}

fn found(s: &Store, q: &Query) -> BTreeSet<u64> {
    let f = s.search(q).unwrap();
    assert!(f.page_exact && f.total_exact, "{:?}", q.clauses);
    f.hits.iter().map(|h| h.doc).collect()
}

#[test]
fn searched_values_follow_every_change_and_equal_a_fresh_store() {
    for seed in [0x9e37_79b9_7f4a_7c15, 7, 0x1234_5678] {
        follow(seed);
    }
}

fn follow(seed: u64) {
    let (da, db) = (temp_dir("changes"), temp_dir("fresh"));
    let a = Store::open_in(&da, SMALL, pool()).unwrap();
    a.commit_wait(books()).unwrap();
    let mut m = Model {
        ents: BTreeMap::new(),
        sessions: BTreeMap::new(),
        seed,
        next: 1,
        next_session: 1000,
    };
    for _ in 0..40 {
        let e = m.next;
        m.next += 1;
        let kind = [CHARACTER, GROUP, TAG, ENTRY, ENTRY][(e % 5) as usize];
        let key = if kind == ENTRY {
            format!("{}:{e}", [WORLD, CHAR_BOOK, ORIGINAL][(e % 3) as usize])
        } else {
            format!("k{e}")
        };
        let r = m.make(e, kind, key);
        a.commit_wait(r).unwrap();
    }
    for i in 0..600 {
        let r = m.step();
        if !r.is_empty() {
            a.commit_wait(r).unwrap();
        }
        if i % 150 == 149 {
            check(&a, &m);
        }
    }
    let b = Store::open_in(&db, SMALL, pool()).unwrap();
    b.commit_wait(m.records_of_state()).unwrap();
    let (ea, eb) = (search_entries(&a), search_entries(&b));
    let (sa, sb): (BTreeSet<_>, BTreeSet<_>) =
        (ea.iter().cloned().collect(), eb.iter().cloned().collect());
    let only_a: Vec<_> = sa.difference(&sb).take(8).collect();
    let only_b: Vec<_> = sb.difference(&sa).take(8).collect();
    assert!(
        only_a.is_empty() && only_b.is_empty(),
        "after changes only: {only_a:?}\nfresh only: {only_b:?}"
    );
    check(&b, &m);
    drop((a, b));
    fs::remove_dir_all(&da).unwrap();
    fs::remove_dir_all(&db).unwrap();
}

fn check(s: &Store, m: &Model) {
    let scopes: Vec<(Scope, u32)> = [
        // A clause restricted to the card tags field is a tag membership filter, not a text match.
        (0..LIBRARY_FIELDS.len() as u32)
            .filter(|f| *f != 8)
            .map(|f| (Scope::LIBRARY, f))
            .collect::<Vec<_>>(),
        vec![(Scope::TAGS, 0), (Scope::SESSIONS, 0)],
        [WORLD, CHAR_BOOK, ORIGINAL]
            .iter()
            .flat_map(|b| (0..BOOK_FIELDS.len() as u32).map(move |f| (Scope::book(*b), f)))
            .collect(),
    ]
    .concat();
    for (scope, field) in scopes {
        for w in ["dark", "dr", "quokka", "12", "élan", "elan", "k1"] {
            let q = query(scope, w, Some(vec![field]));
            assert_eq!(
                found(s, &q),
                m.expected(scope, field, w),
                "{scope:?} field {field} {w}"
            );
        }
    }
}
