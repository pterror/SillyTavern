//! Tags' carriers by name term against what the member blocks and the tags' names give afresh, through assigns,
//! unassigns, merges, renames, definition markers coming and going, deletes, keys named once they have carriers,
//! the scale growing and shrinking, a bulk load, flushes and merges; and the added maps of a bulk load's sinks
//! and of a view's slot ranges.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::carriers::{Flight, Reside, TagMap, Term, j_of, name_terms, want};
use super::library::{CHARACTER, FOLD_SLICE, NAME, TAG};
use super::tags::DEFINED;
use super::*;
use crate::keyspace::val::{Val, counter_value, get_bytes, get_u64, map_bytes, map_pairs};
use crate::log::format::{FieldRef, Record, Value, kind_by_name};
use crate::search::query::{After, Clause, Limits, Order, Query};
use crate::search::{Scope, TermKind};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-carriers-{}-{name}-{}",
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

fn set(e: u64, f: u64, s: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Sel(0, e),
            Value::Field(FieldRef::Code(f)),
            text(s),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn mark(t: u64) -> Record {
    rec(
        "jsonValue",
        vec![
            Value::Sel(0, t),
            Value::Field(FieldRef::Code(DEFINED)),
            text(""),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn unmark(t: u64) -> Record {
    rec(
        "valueDelete",
        vec![
            Value::Sel(0, t),
            Value::Field(FieldRef::Code(DEFINED)),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn create(e: u64, kind: u64, key: &str) -> Record {
    rec(
        "entityCreate",
        vec![Value::Id(e), Value::UInt(kind), text(key), Value::Time(0)],
    )
}

fn assign(e: u64, t: u64, on: bool) -> Record {
    rec(
        "tagAssign",
        vec![Value::Id(e), Value::Id(t), Value::Bit(on)],
    )
}

fn delete(e: u64) -> Record {
    rec("entityDelete", vec![Value::Id(e)])
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn pick<T: Copy>(&mut self, v: &[T]) -> Option<T> {
        (!v.is_empty()).then(|| v[self.below(v.len() as u64) as usize])
    }
}

const NAMES: &[&str] = &[
    "dark elf",
    "Dark",
    "elven queen",
    "queen",
    "dragon rider",
    "",
    "Ölaf the elf",
    "x",
    "dark-elf!",
    "the riders of the dark",
];

#[derive(Debug, Clone, Default)]
struct T {
    name: String,
    marked: bool,
    /// Deleted (alone, or merged away).
    gone: bool,
}

/// The tags and cards as the commits left them.
struct Model {
    tags: BTreeMap<u64, T>,
    cards: BTreeSet<u64>,
    carriers: BTreeMap<u64, BTreeSet<u64>>,
    next_tag: u64,
    next_card: u64,
    rng: Rng,
    /// Tags' names are drawn from these; cards are named by these in turn.
    names: &'static [&'static str],
    card_names: &'static [&'static str],
    /// The id of the `i`th card made.
    ids: fn(u64) -> u64,
}

fn card_id(i: u64) -> u64 {
    // Spread over many member blocks, several cards in each.
    1_000_000 + i * 997
}

/// `card_id`'s spread in runs of 100 cards, each run `1 << 29` ids after the last: the block maxima's nodes over
/// them are of several level-1 nodes and of level-2 nodes 0 to 2 (`search::node_of`).
fn spread_card_id(i: u64) -> u64 {
    card_id(i % 100) + (i / 100 << 29)
}

impl Model {
    fn new(seed: u64) -> Model {
        Model {
            tags: BTreeMap::new(),
            cards: BTreeSet::new(),
            carriers: BTreeMap::new(),
            next_tag: 1,
            next_card: 0,
            rng: Rng(seed),
            names: NAMES,
            card_names: &["c"],
            ids: card_id,
        }
    }

    fn indexed(&self, t: u64) -> String {
        match self.tags.get(&t) {
            Some(x) if x.marked && !x.gone => x.name.clone(),
            _ => String::new(),
        }
    }

    fn pairs(&self) -> usize {
        self.carriers.values().map(BTreeSet::len).sum()
    }

    fn live_tags(&self) -> Vec<u64> {
        self.tags
            .iter()
            .filter(|(_, t)| !t.gone)
            .map(|(id, _)| *id)
            .collect()
    }

    /// The live tag most assignments go to.
    fn big(&self) -> Option<u64> {
        self.live_tags().into_iter().next()
    }

    fn name(&mut self) -> String {
        self.names[self.rng.below(self.names.len() as u64) as usize].to_string()
    }

    fn new_tag(&mut self, defined: bool) -> Vec<Record> {
        let t = self.next_tag;
        self.next_tag += 1;
        let mut r = Vec::new();
        let mut x = T::default();
        if defined {
            x.name = self.name();
            x.marked = true;
            r.push(set(t, NAME, &x.name));
            r.push(mark(t));
        }
        r.push(create(t, TAG, &format!("t{t}")));
        self.tags.insert(t, x);
        r
    }

    fn new_card(&mut self) -> Vec<Record> {
        let e = (self.ids)(self.next_card);
        let name = self.card_names[self.next_card as usize % self.card_names.len()];
        self.next_card += 1;
        self.cards.insert(e);
        vec![
            set(e, NAME, name),
            create(e, CHARACTER, &format!("c{e}.png")),
        ]
    }

    fn assign(&mut self, big_share: u64) -> Vec<Record> {
        let live = self.live_tags();
        let cards: Vec<u64> = self.cards.iter().copied().collect();
        let t = if self.rng.below(100) < big_share {
            self.big()
        } else {
            self.rng.pick(&live)
        };
        let (Some(t), Some(e)) = (t, self.rng.pick(&cards)) else {
            return Vec::new();
        };
        self.carriers.entry(t).or_default().insert(e);
        vec![assign(e, t, true)]
    }

    fn unassign(&mut self, big_share: u64) -> Vec<Record> {
        let t = match self.big() {
            Some(b) if self.rng.below(100) < big_share && self.carriers.contains_key(&b) => b,
            _ => {
                let with: Vec<u64> = self.carriers.keys().copied().collect();
                match self.rng.pick(&with) {
                    Some(t) => t,
                    None => return Vec::new(),
                }
            }
        };
        let es: Vec<u64> = self.carriers[&t].iter().copied().collect();
        let e = self.rng.pick(&es).unwrap();
        self.drop_carrier(t, e);
        vec![assign(e, t, false)]
    }

    fn drop_carrier(&mut self, t: u64, e: u64) {
        let c = self.carriers.get_mut(&t).unwrap();
        c.remove(&e);
        if c.is_empty() {
            self.carriers.remove(&t);
        }
    }

    /// One change that isn't an assignment; true when it was a merge.
    fn other(&mut self) -> (Vec<Record>, bool) {
        let live = self.live_tags();
        let big = self.big();
        let small: Vec<u64> = live.iter().copied().filter(|t| Some(*t) != big).collect();
        match self.rng.below(9) {
            0 | 1 => {
                let Some(t) = self.rng.pick(&live) else {
                    return (Vec::new(), false);
                };
                let n = self.name();
                self.tags.get_mut(&t).unwrap().name = n.clone();
                (vec![set(t, NAME, &n)], false)
            }
            2 => {
                let Some(t) = self.rng.pick(&live) else {
                    return (Vec::new(), false);
                };
                let x = self.tags.get_mut(&t).unwrap();
                x.marked = !x.marked;
                (vec![if x.marked { mark(t) } else { unmark(t) }], false)
            }
            3 => {
                // A key only assignments named gets its definition: name and marker, in either order.
                let keys: Vec<u64> = live
                    .iter()
                    .copied()
                    .filter(|t| !self.tags[t].marked)
                    .collect();
                let Some(t) = self.rng.pick(&keys) else {
                    return (self.new_tag(false), false);
                };
                let n = self.name();
                let x = self.tags.get_mut(&t).unwrap();
                x.name = n.clone();
                x.marked = true;
                let mut r = vec![set(t, NAME, &n), mark(t)];
                if self.rng.below(2) == 0 {
                    r.reverse();
                }
                (r, false)
            }
            4 => {
                let defined = self.rng.below(3) != 0;
                (self.new_tag(defined), false)
            }
            5 | 6 => {
                // A tag is deleted with a merge, into another tag or none.
                let Some(t) = self.rng.pick(&small) else {
                    return (Vec::new(), false);
                };
                let into = if self.rng.below(5) == 0 {
                    None
                } else {
                    self.rng.pick(&live).filter(|i| *i != t)
                };
                self.tags.get_mut(&t).unwrap().gone = true;
                if let Some(old) = self.carriers.remove(&t)
                    && let Some(i) = into
                {
                    self.carriers.entry(i).or_default().extend(old);
                }
                (
                    vec![
                        rec(
                            "tagMerge",
                            vec![Value::Id(t), into.map_or(Value::Absent, Value::Id)],
                        ),
                        delete(t),
                    ],
                    true,
                )
            }
            7 => {
                let cards: Vec<u64> = self.cards.iter().copied().collect();
                let Some(e) = self.rng.pick(&cards) else {
                    return (Vec::new(), false);
                };
                self.cards.remove(&e);
                let tags: Vec<u64> = self.carriers.keys().copied().collect();
                for t in tags {
                    if self.carriers[&t].contains(&e) {
                        self.drop_carrier(t, e);
                    }
                }
                (vec![delete(e)], false)
            }
            _ => (self.new_card(), false),
        }
    }
}

/// What the structures hold, read in one state.
#[derive(Debug, PartialEq, Default)]
struct Held {
    pairs: i64,
    reside: Reside,
    term_carriers: BTreeMap<Term, i64>,
    tag_carriers: BTreeMap<(Term, u64), Vec<(u32, u32)>>,
    term_heavy: BTreeSet<(Term, u64)>,
    term_moving: BTreeSet<(Term, u64)>,
    moving: BTreeSet<u64>,
    maps: BTreeMap<u64, TagMap>,
    members: BTreeMap<u64, BTreeSet<u64>>,
    folds: bool,
}

fn term_of(k: &[u8], at: &mut usize) -> Term {
    let kind = match get_u64(k, at).unwrap() {
        0 => TermKind::Exact,
        1 => TermKind::Gram,
        other => panic!("term kind {other}"),
    };
    (kind, String::from_utf8(get_bytes(k, at).unwrap()).unwrap())
}

fn read(s: &Store) -> Held {
    s.derived(|v| {
        let all = |st: u64| -> StoreResult<Vec<(Vec<u8>, Vec<u8>)>> {
            let p = key::of(st);
            v.scan(&p, &key::prefix_end(&p), usize::MAX)
        };
        let mut h = Held {
            pairs: v
                .get(&key::of(key::CARRIER_PAIRS))?
                .map_or(0, |b| counter_value(&b).unwrap()),
            reside: super::carriers::reside(v)?,
            ..Held::default()
        };
        // Every structure read here has a two-byte id.
        let skip = key::of(key::MEMBER_BLOCK).len();
        assert!(
            [key::TERM_CARRIERS, key::RESIDE]
                .iter()
                .all(|x| key::of(*x).len() == skip)
        );
        for (k, b) in all(key::TERM_CARRIERS)? {
            let n = counter_value(&b).unwrap();
            if n != 0 {
                h.term_carriers.insert(term_of(&k, &mut { skip }), n);
            }
        }
        for (k, b) in {
            let p = key::TAG_CARRIERS.prefix();
            v.scan(&p, &key::prefix_end(&p), usize::MAX)?
        } {
            let mut at = skip;
            let t = term_of(&k, &mut at);
            let block = get_u64(&k, &mut at).unwrap();
            h.tag_carriers.insert((t, block), map_pairs(&b).unwrap());
        }
        for (st, set) in [
            (key::TERM_HEAVY, &mut h.term_heavy),
            (key::TERM_MOVING, &mut h.term_moving),
        ] {
            for (k, _) in all(st)? {
                let mut at = skip;
                let t = term_of(&k, &mut at);
                set.insert((t, get_u64(&k, &mut at).unwrap()));
            }
        }
        for (k, _) in all(key::MOVING)? {
            h.moving.insert(get_u64(&k, &mut { skip }).unwrap());
        }
        for (k, b) in all(key::TAG_MAP)? {
            h.maps.insert(
                get_u64(&k, &mut { skip }).unwrap(),
                TagMap::parse(&b).unwrap(),
            );
        }
        for (k, b) in all(key::MEMBER_BLOCK)? {
            let mut at = skip;
            let tag = get_u64(&k, &mut at).unwrap();
            let block = get_u64(&k, &mut at).unwrap();
            for (slot, n) in map_pairs(&b).unwrap() {
                if n != 0 {
                    h.members
                        .entry(tag)
                        .or_default()
                        .insert((block << key::MEMBER_BITS) | u64::from(slot));
                }
            }
        }
        h.folds = !all(key::FOLD)?.is_empty();
        Ok(h)
    })
    .unwrap()
}

fn terms(name: &str) -> BTreeSet<Term> {
    name_terms(name.as_bytes())
}

/// The structures as the member blocks, the tags' names and their sides and moves (`maps`) give them afresh.
fn fresh(h: &Held, m: &Model) -> Held {
    let mut f = Held {
        reside: h.reside.clone(),
        maps: h.maps.clone(),
        members: h.members.clone(),
        folds: h.folds,
        ..Held::default()
    };
    for (&t, es) in &h.members {
        let indexed = m.indexed(t);
        f.pairs += es.len() as i64;
        for term in terms(&indexed) {
            *f.term_carriers.entry(term).or_default() += es.len() as i64;
        }
        for &e in es {
            let (heavy, name) = match h.maps.get(&t) {
                None => (false, indexed.clone()),
                Some(TagMap {
                    heavy,
                    flight: None,
                }) => (*heavy, indexed.clone()),
                Some(TagMap {
                    heavy,
                    flight: Some(fl),
                }) => {
                    if e < fl.cursor {
                        (
                            fl.target_heavy,
                            String::from_utf8(fl.target_name.clone()).unwrap(),
                        )
                    } else {
                        (*heavy, String::from_utf8(fl.mapped_name.clone()).unwrap())
                    }
                }
            };
            if !heavy {
                for term in terms(&name) {
                    let slots = f
                        .tag_carriers
                        .entry((term, e >> key::MEMBER_BITS))
                        .or_default();
                    let slot = key::member_slot(e);
                    match slots.iter_mut().find(|x| x.0 == slot) {
                        Some(x) => x.1 += 1,
                        None => slots.push((slot, 1)),
                    }
                }
            }
        }
    }
    for v in f.tag_carriers.values_mut() {
        v.sort_unstable();
    }
    f.term_carriers.retain(|_, n| *n != 0);
    for (&t, map) in &h.maps {
        let name = |b: &[u8]| String::from_utf8(b.to_vec()).unwrap();
        match &map.flight {
            None => {
                assert!(map.heavy, "tag {t}: a settled map is heavy");
                for term in terms(&m.indexed(t)) {
                    f.term_heavy.insert((term, t));
                }
            }
            Some(Flight {
                mapped_name,
                target_name,
                ..
            }) => {
                f.moving.insert(t);
                if map.heavy {
                    for term in terms(&name(mapped_name)) {
                        f.term_heavy.insert((term, t));
                    }
                }
                let mut all = terms(&name(mapped_name));
                all.extend(terms(&name(target_name)));
                all.extend(terms(&m.indexed(t)));
                for term in all {
                    f.term_moving.insert((term, t));
                }
            }
        }
    }
    f
}

/// Checks every structure against its fresh value; returns what was read.
fn check(s: &Store, m: &Model, at: &str) -> Held {
    let h = read(s);
    let f = fresh(&h, m);
    assert_eq!(h.pairs, f.pairs, "{at}: pairs");
    assert_eq!(h.term_carriers, f.term_carriers, "{at}: term carriers");
    assert_eq!(h.tag_carriers, f.tag_carriers, "{at}: tag carriers");
    assert_eq!(h.term_heavy, f.term_heavy, "{at}: heavy tags by term");
    assert_eq!(h.term_moving, f.term_moving, "{at}: moving tags by term");
    assert_eq!(h.moving, f.moving, "{at}: move queue");
    // The scale was set at m_set, and the pairs haven't left the hysteresis band since, or j would have been
    // set again (unless that set it to what it was).
    let r = &h.reside;
    let m_now = h.pairs.max(0) as u64;
    assert_eq!(r.j, j_of(r.m_set), "{at}: j {r:?}");
    let outside = u128::from(m_now) >= 4 * u128::from(r.m_set)
        || 4 * u128::from(m_now) <= u128::from(r.m_set);
    assert!(!outside || j_of(m_now) == r.j, "{at}: pairs {m_now}, {r:?}");
    h
}

/// Waits until no fold, move or re-siding is left; returns the state then, checked, also against the model's
/// carriers and the band.
fn settle(s: &Store, m: &Model, at: &str) -> Held {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let h = read(s);
        if !h.folds && h.moving.is_empty() && h.reside.scan.is_none() {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{at}: never settled");
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let h = check(s, m, at);
    assert_eq!(h.members, m.carriers, "{at}: carriers");
    let k = h.reside.k();
    for (&t, es) in &h.members {
        if m.indexed(t).is_empty() {
            continue;
        }
        let heavy = h.maps.get(&t).is_some_and(|x| x.heavy);
        assert_eq!(
            want(es.len() as i64, heavy, k),
            heavy,
            "{at}: tag {t} with {} carriers, heavy {heavy}, K {k}",
            es.len()
        );
    }
    h
}

/// What a run went through.
#[derive(Default, Debug)]
struct Seen {
    j_up: bool,
    j_down: bool,
    heavy: BTreeSet<u64>,
    demoted: bool,
    in_flight: bool,
}

impl Seen {
    fn note(&mut self, before: &Held, after: &Held) {
        self.j_up |= after.reside.j > before.reside.j;
        self.j_down |= after.reside.j < before.reside.j;
        self.in_flight |= !after.moving.is_empty();
        for (t, map) in &after.maps {
            if map.heavy && map.flight.is_none() {
                self.heavy.insert(*t);
            }
        }
        for t in before.maps.keys() {
            if before.maps[t].heavy
                && before.maps[t].flight.is_none()
                && !after.maps.contains_key(t)
            {
                self.demoted = true;
            }
        }
    }
}

/// Commits random changes with the pairs swinging between `low` and `high` `cycles` times, checking every
/// structure after each commit and once everything settles.
fn swing(s: &Store, m: &mut Model, cycles: usize, low: usize, high: usize, seen: &mut Seen) {
    let mut last = settle(s, m, "start");
    let mut n = 0;
    for cycle in 0..cycles * 2 {
        let growing = cycle % 2 == 0;
        let mut commits = 0;
        while if growing {
            m.pairs() < high
        } else {
            m.pairs() > low
        } {
            commits += 1;
            assert!(
                commits < 4000,
                "cycle {cycle} never reached its pairs: {}",
                m.pairs()
            );
            let mut recs = Vec::new();
            let mut merged = false;
            // Room to grow: enough tags and cards for the pairs wanted.
            if growing && m.live_tags().len() < 6 {
                recs.extend(m.new_tag(true));
            }
            if growing && m.cards.len() < 550 {
                recs.extend(m.new_card());
            }
            for _ in 0..1 + m.rng.below(5) {
                let r = m.rng.below(100);
                if r < 94 {
                    let main = m.rng.below(100) < 85;
                    recs.extend(match (growing, main) {
                        (true, true) | (false, false) => m.assign(50),
                        _ => m.unassign(50),
                    });
                } else {
                    let (r, merge) = m.other();
                    recs.extend(r);
                    merged |= merge;
                    if merge {
                        break;
                    }
                }
            }
            if recs.is_empty() {
                continue;
            }
            s.commit_wait(recs).unwrap();
            n += 1;
            let h = if merged {
                // Assignments name tags as the folds leave them.
                settle(s, m, &format!("commit {n}, a merge"))
            } else {
                check(s, m, &format!("commit {n}"))
            };
            seen.note(&last, &h);
            last = h;
        }
        let h = settle(s, m, &format!("cycle {cycle}"));
        seen.note(&last, &h);
        last = h;
    }
}

#[test]
fn carriers_by_term_follow_every_change_and_equal_a_fresh_computation() {
    for seed in [0x9e37_79b9_7f4a_7c15u64, 7] {
        let dir = temp_dir("follow");
        let s = Store::open_in(&dir, SMALL, pool()).unwrap();
        let mut m = Model::new(seed);
        let mut recs = Vec::new();
        for i in 0..8 {
            recs.extend(m.new_tag(i % 4 != 3));
        }
        for _ in 0..600 {
            recs.extend(m.new_card());
        }
        s.commit_wait(recs).unwrap();
        let mut seen = Seen::default();
        swing(&s, &mut m, 2, 6, 640, &mut seen);
        assert!(
            seen.j_up && seen.j_down && !seen.heavy.is_empty() && seen.demoted && seen.in_flight,
            "{seen:?}"
        );
        // Reopened, everything is as it was.
        let before = read(&s);
        s.close();
        drop(s);
        let s = Store::open_in(&dir, SMALL, pool()).unwrap();
        s.wait_ready().unwrap();
        assert_eq!(read(&s), before);
        s.close();
        let _ = fs::remove_dir_all(&dir);
    }
}

#[test]
fn a_bulk_load_builds_the_carriers_by_term_and_commits_go_on_from_them() {
    let dir = temp_dir("bulk");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut m = Model::new(11);
    let mut l = s.loader().unwrap();
    // Tags 4 and 8 are keys only assignments name.
    for i in 0..8 {
        l.add(m.new_tag(i % 4 != 3)).unwrap();
    }
    for _ in 0..600 {
        let mut r = m.new_card();
        let e = card_id(m.next_card - 1);
        // Every card carries the first tag (heavy), some the others (light).
        r.push(assign(e, 1, true));
        m.carriers.entry(1).or_default().insert(e);
        for t in 2..=8 {
            if m.rng.below(10) == 0 {
                r.push(assign(e, t, true));
                m.carriers.entry(t).or_default().insert(e);
            }
        }
        l.add(r).unwrap();
    }
    l.finish().unwrap();
    let h = settle(&s, &m, "loaded");
    assert_eq!(h.reside.m_set, m.pairs() as u64);
    assert!(h.maps.get(&1).is_some_and(|x| x.heavy), "{:?}", h.maps);
    assert!(h.tag_carriers.len() > 1);
    let mut seen = Seen::default();
    swing(&s, &mut m, 1, 6, 1000, &mut seen);
    assert!(seen.j_down && seen.demoted, "{seen:?}");
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_views_slot_range_adds_added_maps_onto_the_published_map() {
    let dir = temp_dir("range");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    s.wait_ready().unwrap();
    let (k1, k2, k3) = (
        key::test_add_map(1),
        key::test_add_map(2),
        key::test_add_map(3),
    );
    s.inner.ks.insert(
        [
            (
                k1.bytes().to_vec(),
                Val::Put(map_bytes(&[(1, 2), (5, 1), (9, 3)])),
            ),
            (k3.bytes().to_vec(), Val::Put(map_bytes(&[(4, 4)]))),
        ],
        None,
    );
    let mut older = std::collections::BTreeMap::new();
    let mut o = derive::Out::default();
    o.add_map(k1.clone(), vec![(1, -2), (6, 1), (9, 1)]);
    o.add_map(k2.clone(), vec![(2, 1), (3, 1)]);
    o.del(k3.clone());
    o.add_map(k3.clone(), vec![(8, 2)]);
    o.apply(&mut older);
    let mut newer = std::collections::BTreeMap::new();
    let mut o = derive::Out::default();
    o.add_map(k1.clone(), vec![(5, -1), (6, 2), (12, 7)]);
    o.add_map(k2.clone(), vec![(3, -1)]);
    o.apply(&mut newer);
    s.derived(|v| {
        let lv = v.with_layer(&older);
        let v = lv.with_layer(&newer);
        assert_eq!(
            v.map_range(k1.bytes(), 0, 100, true)?,
            vec![(6, 3), (9, 4), (12, 7)]
        );
        assert_eq!(v.map_range(k1.bytes(), 6, 10, true)?, vec![(6, 3), (9, 4)]);
        // Nothing published at k2: the same either way.
        assert_eq!(v.map_range(k2.bytes(), 0, 100, true)?, vec![(2, 1)]);
        assert_eq!(v.map_range(k2.bytes(), 0, 100, false)?, vec![(2, 1)]);
        // A delete below hides the published map.
        assert_eq!(v.map_range(k3.bytes(), 0, 100, true)?, vec![(8, 2)]);
        // A range reads what a whole read gives within it.
        for k in [&k1, &k2, &k3] {
            let whole = v
                .get_val(k.bytes())?
                .and_then(|x| x.into_pairs(k.bytes()))
                .unwrap_or_default();
            let within: Vec<_> = whole
                .into_iter()
                .filter(|x| (3..10).contains(&x.0))
                .collect();
            assert_eq!(v.map_range(k.bytes(), 3, 10, true)?, within);
        }
        Ok(())
    })
    .unwrap();
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

/// With K large (many pairs, most of them of tags without names), a light tag with more carriers than a move's
/// slice moves in several steps, a cursor between them, whatever it is renamed to meanwhile.
#[test]
fn a_light_tags_move_takes_several_slices() {
    let dir = temp_dir("slices");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut m = Model::new(5);
    let mut l = s.loader().unwrap();
    // Tags 1 and 2 named, 3..=12 keys only.
    l.add(m.new_tag(true)).unwrap();
    l.add(m.new_tag(true)).unwrap();
    for _ in 0..10 {
        l.add(m.new_tag(false)).unwrap();
    }
    for i in 0..7000u64 {
        let mut r = m.new_card();
        let e = card_id(i);
        for t in 3..=12 {
            r.push(assign(e, t, true));
            m.carriers.entry(t).or_default().insert(e);
        }
        for (t, every) in [(1, 11), (2, 23)] {
            if i % every == 0 {
                r.push(assign(e, t, true));
                m.carriers.entry(t).or_default().insert(e);
            }
        }
        l.add(r).unwrap();
    }
    l.finish().unwrap();
    let h = settle(&s, &m, "loaded");
    assert!(h.reside.k() >= 512 && h.maps.is_empty(), "{:?}", h.reside);
    assert!(m.carriers[&1].len() > 2 * FOLD_SLICE);
    let mut in_flight = false;
    for (i, step) in [
        vec![set(1, NAME, "dragon rider")],
        vec![set(1, NAME, "dark elf"), set(2, NAME, "dark")],
        vec![unmark(1)],
        vec![mark(1)],
        vec![set(1, NAME, "the riders of the dark")],
    ]
    .into_iter()
    .enumerate()
    {
        for r in &step {
            if r.kind.name == "textValue"
                && let Some(Value::Text(n)) = r.values.get(2)
                && let Value::Sel(_, t) = r.values[0]
            {
                m.tags.get_mut(&t).unwrap().name = String::from_utf8(n.clone()).unwrap();
            }
        }
        if i == 2 {
            m.tags.get_mut(&1).unwrap().marked = false;
        }
        if i == 3 {
            m.tags.get_mut(&1).unwrap().marked = true;
        }
        s.commit_wait(step).unwrap();
        in_flight |= !check(&s, &m, &format!("step {i}")).moving.is_empty();
        if i % 2 == 1 {
            settle(&s, &m, &format!("step {i} settled"));
        }
    }
    assert!(in_flight);
    settle(&s, &m, "end");
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

// ---- queries while carriers move ----

/// Tag names most of which share "dark" and its prefix terms; one has a token longer than the prefix terms.
const DARK_NAMES: &[&str] = &[
    "dark elf",
    "Dark",
    "dark queen",
    "darkling",
    "the riders of the dark",
    "dark-elf!",
    "elven queen",
    "dragon rider",
    "Ölaf the elf",
    "x",
    "supercalifragilisticexpialidocious dark",
    "dark dragon",
    "Darkwood x",
    "into the dark",
    "",
];

const CARD_NAMES: &[&str] = &[
    "c",
    "dark knight",
    "elf",
    "queen of the dark",
    "dragon",
    "x marks",
];

/// Queries of every clause kind that matches tag names: a word as a prefix term (the carrier maps') or whole,
/// a prefix past the prefix terms and phrases (found by name), the tags field alone, negated clauses.
fn carrier_queries() -> Vec<Query> {
    let tags_field = Scope::LIBRARY
        .fields()
        .iter()
        .position(|d| d.name == "tags")
        .unwrap() as u32;
    let c = |t: &str| Clause {
        text: t.as_bytes().to_vec(),
        fields: None,
        negate: false,
        quoted: false,
    };
    let tagged = |t: &str| Clause {
        fields: Some(vec![tags_field]),
        ..c(t)
    };
    let not = |cl: Clause| Clause { negate: true, ..cl };
    // No work limit: every page is exact, so every one must be the same.
    let q = |clauses: Vec<Clause>| Query {
        scope: Scope::LIBRARY,
        clauses,
        filters: Vec::new(),
        order: Order::Relevance,
        limit: 1000,
        after: None,
        weights: None,
        limits: Limits {
            enumerate: u64::MAX,
            ranked: u64::MAX,
            walked: u64::MAX,
            tags: u64::MAX,
        },
    };
    vec![
        q(vec![c("x")]),
        q(vec![c("d")]),
        q(vec![c("da")]),
        q(vec![c("dark")]),
        q(vec![c("el")]),
        q(vec![c("th")]),
        q(vec![c("supercalifragilisticexpi")]),
        q(vec![c("dark"), c("kn")]),
        q(vec![c("elf"), c("c")]),
        q(vec![c("x"), c("dr")]),
        q(vec![c("dark elf")]),
        q(vec![Clause {
            quoted: true,
            ..c("the dark")
        }]),
        q(vec![tagged("da")]),
        q(vec![tagged("dark")]),
        q(vec![tagged("elf"), c("c")]),
        q(vec![c("c"), not(tagged("dar"))]),
        q(vec![c("c"), not(c("dark"))]),
        q(vec![not(tagged("x")), c("el")]),
    ]
}

/// A page apart from the work it took: hits (document, score bits), total, whether that and the page are
/// exact, more, the tied score's bits.
type Page = (Vec<(u64, u64)>, u64, bool, bool, bool, Option<u64>);

/// What the queries give in one state.
struct Answers {
    /// Per query: its whole page, then its first two pages of 7.
    pages: Vec<Vec<Page>>,
}

fn answers(v: &derive::View) -> StoreResult<Answers> {
    use crate::search::query::{StatsCache, TagNames, run};
    let page = |q: &Query| -> StoreResult<(Page, Option<After>)> {
        let f = run(v, q, &StatsCache::default(), &TagNames::default())?;
        let after = f
            .hits
            .last()
            .filter(|_| f.more)
            .map(|h| After::Score(h.rank, h.doc));
        Ok((
            (
                f.hits.iter().map(|h| (h.doc, h.score.to_bits())).collect(),
                f.total,
                f.total_exact,
                f.page_exact,
                f.more,
                f.tied.map(f64::to_bits),
            ),
            after,
        ))
    };
    let mut pages = Vec::new();
    for q in carrier_queries() {
        let mut got = vec![page(&q)?.0];
        let mut q = Query { limit: 7, ..q };
        for _ in 0..2 {
            let (p, after) = page(&q)?;
            got.push(p);
            match after {
                Some(a) => q.after = Some(a),
                None => break,
            }
        }
        pages.push(got);
    }
    Ok(Answers { pages })
}

/// Whether two pages are the same: their totals only when both are exact (an estimate, or a count the work
/// limit cut short, follows the work done).
fn same_page(p: &Page, q: &Page) -> bool {
    (&p.0, p.3, p.4, p.5) == (&q.0, q.3, q.4, q.5) && (!(p.2 && q.2) || p.1 == q.1)
}

/// Where two answers differ (empty: nowhere).
fn differ(a: &Answers, b: &Answers) -> String {
    let qs = carrier_queries();
    assert_eq!(a.pages.len(), b.pages.len());
    for (i, (x, y)) in a.pages.iter().zip(&b.pages).enumerate() {
        if x.len() != y.len() {
            return format!("query {:?}: {} pages, {}", qs[i].clauses, x.len(), y.len());
        }
        for (j, (p, q)) in x.iter().zip(y).enumerate() {
            if !same_page(p, q) {
                let docs = |p: &Page| p.0.iter().map(|h| h.0).collect::<BTreeSet<u64>>();
                return format!(
                    "query {:?} page {j}: only in the first {:?}, only in the second {:?}; same hits {}; \
                     (total, exact, page exact, more, tied) {:?} {:?}",
                    qs[i].clauses,
                    docs(p).difference(&docs(q)).collect::<Vec<_>>(),
                    docs(q).difference(&docs(p)).collect::<Vec<_>>(),
                    p.0 == q.0,
                    (p.1, p.2, p.3, p.4, p.5),
                    (q.1, q.2, q.3, q.4, q.5),
                );
            }
        }
    }
    String::new()
}

/// What the states queried had in flight.
#[derive(Default, Debug)]
struct Flown {
    states: usize,
    moving: bool,
    /// A move with its cursor among its carriers.
    split: bool,
    /// A move whose tag's indexed name or band changed since it began.
    pending: bool,
    /// A move to another name, and to none (a tag deleted or its marker removed).
    renamed: bool,
    emptied: bool,
    promoting: bool,
    demoting: bool,
    residing: bool,
    /// The map, heavy and moving tags of "da" past `TAGS_WALKED` cursors, so a walk scoring their carriers alone
    /// reads the documents' own tags.
    many: bool,
}

impl Flown {
    fn note(&mut self, v: &derive::View) -> StoreResult<()> {
        self.states += 1;
        let p = key::of(key::TAG_MAP);
        for (_, b) in v.scan(&p, &key::prefix_end(&p), usize::MAX)? {
            let m = TagMap::parse(&b)?;
            let Some(f) = m.flight else { continue };
            self.moving = true;
            self.split |= f.cursor > 0;
            self.pending |= f.pending;
            self.renamed |= name_terms(&f.mapped_name) != name_terms(&f.target_name);
            self.emptied |= !f.mapped_name.is_empty() && f.target_name.is_empty();
            self.promoting |= !m.heavy && f.target_heavy;
            self.demoting |= m.heavy && !f.target_heavy;
        }
        self.residing |= super::carriers::reside(v)?.scan.is_some();
        let mut da = BTreeSet::new();
        for st in [key::TERM_HEAVY, key::TERM_MOVING] {
            let p = key::term_key(st, TermKind::Gram, "da");
            for (k, _) in v.scan(&p, &key::prefix_end(&p), usize::MAX)? {
                da.insert(get_u64(&k, &mut p.len()).unwrap());
            }
        }
        self.many |= 1 + da.len() > crate::search::query::TAGS_WALKED;
        Ok(())
    }
}

/// With carrier moves and re-siding held: the answers in the store's state, which equal those in the states
/// stepping its moves and re-siding leads to until none is left: the first ten, then ever sparser (a step in
/// `1 + steps / 10`), and the last.
fn answers_through_steps(s: &Store, flown: &mut Flown) -> Answers {
    s.derived(|v| {
        let first = answers(v)?;
        flown.note(v)?;
        let mut layer = BTreeMap::new();
        let (mut steps, mut next) = (0, 1);
        loop {
            let mut out = derive::Out::default();
            let lv = v.with_layer(&layer);
            let stepped =
                carriers::move_step(&lv, &mut out)? || carriers::reside_step(&lv, &mut out)?;
            if stepped {
                out.apply(&mut layer);
                steps += 1;
            }
            if steps > 0 && (steps == next || !stepped) {
                next = steps + 1 + steps / 10;
                let lv = v.with_layer(&layer);
                flown.note(&lv)?;
                let d = differ(&answers(&lv)?, &first);
                assert!(d.is_empty(), "after {steps} steps: {d}");
            }
            if !stepped {
                return Ok(first);
            }
        }
    })
    .unwrap()
}

/// Waits until no tag fold is left.
fn wait_folds(s: &Store) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while read(s).folds {
        assert!(std::time::Instant::now() < deadline, "folds never ended");
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

/// Holds carrier moves and re-siding while `commit` commits; then checks the answers through the steps the
/// moves and re-siding take (`answers_through_steps`) against the answers once everything settled.
fn held_round(
    s: &Store,
    m: &mut Model,
    flown: &mut Flown,
    at: &str,
    commit: impl FnOnce(&Store, &mut Model),
) {
    s.hold_carriers(true);
    commit(s, m);
    wait_folds(s);
    let held = answers_through_steps(s, flown);
    s.hold_carriers(false);
    settle(s, m, at);
    let settled = s.derived(answers).unwrap();
    let d = differ(&held, &settled);
    assert!(d.is_empty(), "{at}: {d}");
}

#[test]
fn queries_while_carriers_move_equal_the_queries_once_everything_settles() {
    let dir = temp_dir("queries");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut m = Model::new(0x5eed_cafe);
    m.names = DARK_NAMES;
    m.card_names = CARD_NAMES;
    let mut recs = Vec::new();
    for _ in 0..14 {
        recs.extend(m.new_tag(true));
    }
    for _ in 0..300 {
        recs.extend(m.new_card());
    }
    s.commit_wait(recs).unwrap();
    let mut flown = Flown::default();
    // Pairs up to `high` and back down to `low`; queried every `every` commits, with the carriers held since the
    // last query.
    let (low, high, every) = (40, 1300, 200);
    let mut round = 0;
    for growing in [true, false] {
        let mut commits = 0;
        while if growing {
            m.pairs() < high
        } else {
            m.pairs() > low
        } {
            held_round(&s, &mut m, &mut flown, &format!("round {round}"), |s, m| {
                for _ in 0..every {
                    commits += 1;
                    assert!(commits < 8000, "the pairs never reached {}", m.pairs());
                    let mut recs = Vec::new();
                    let mut merged = false;
                    if growing && m.live_tags().len() < 12 {
                        recs.extend(m.new_tag(true));
                    }
                    for _ in 0..1 + m.rng.below(5) {
                        if m.rng.below(100) < 96 {
                            let main = m.rng.below(100) < 85;
                            recs.extend(match (growing, main) {
                                (true, true) | (false, false) => m.assign(10),
                                _ => m.unassign(10),
                            });
                        } else {
                            let (r, merge) = m.other();
                            recs.extend(r);
                            merged |= merge;
                            if merge {
                                break;
                            }
                        }
                    }
                    if !recs.is_empty() {
                        s.commit_wait(recs).unwrap();
                    }
                    if merged {
                        // Assignments name tags as the folds leave them.
                        wait_folds(s);
                    }
                }
            });
            round += 1;
        }
    }
    assert!(
        flown.moving
            && flown.pending
            && flown.renamed
            && flown.emptied
            && flown.promoting
            && flown.demoting
            && flown.residing
            && flown.many,
        "{flown:?}"
    );
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

/// With K large (many pairs of tags without names), light tags with more carriers than a move's slice move in
/// several steps: the queries are the same with a move's cursor among its carriers.
#[test]
fn queries_while_a_move_is_split_equal_the_queries_once_it_ends() {
    let dir = temp_dir("split");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut m = Model::new(5);
    m.names = DARK_NAMES;
    m.card_names = CARD_NAMES;
    let mut l = s.loader().unwrap();
    // Tags 1 to 3 named, 4..=13 keys only.
    for t in 0..13 {
        l.add(m.new_tag(t < 3)).unwrap();
    }
    for i in 0..7000u64 {
        let mut r = m.new_card();
        let e = card_id(i);
        for t in 4..=13 {
            r.push(assign(e, t, true));
            m.carriers.entry(t).or_default().insert(e);
        }
        for (t, every) in [(1, 11), (2, 13), (3, 23)] {
            if i % every == 0 {
                r.push(assign(e, t, true));
                m.carriers.entry(t).or_default().insert(e);
            }
        }
        l.add(r).unwrap();
    }
    l.finish().unwrap();
    let h = settle(&s, &m, "loaded");
    assert!(h.reside.k() >= 512 && h.maps.is_empty(), "{:?}", h.reside);
    assert!(m.carriers[&1].len() > 2 * FOLD_SLICE);
    let mut flown = Flown::default();
    let renames: [&[(u64, &str)]; 4] = [
        &[(1, "dark elf"), (2, "elven queen")],
        &[(1, "dragon rider"), (3, "dark")],
        &[(2, "x"), (3, "")],
        &[(1, "the riders of the dark")],
    ];
    for (i, step) in renames.into_iter().enumerate() {
        held_round(&s, &mut m, &mut flown, &format!("rename {i}"), |s, m| {
            for &(t, n) in step {
                m.tags.get_mut(&t).unwrap().name = n.to_string();
                s.commit_wait(vec![set(t, NAME, n)]).unwrap();
            }
        });
    }
    // A tag's marker removed while it moves, and put back.
    held_round(&s, &mut m, &mut flown, "marker", |s, m| {
        s.commit_wait(vec![set(1, NAME, "darkling")]).unwrap();
        m.tags.get_mut(&1).unwrap().name = "darkling".into();
        s.commit_wait(vec![unmark(1)]).unwrap();
        m.tags.get_mut(&1).unwrap().marked = false;
    });
    held_round(&s, &mut m, &mut flown, "marker back", |s, m| {
        s.commit_wait(vec![mark(1)]).unwrap();
        m.tags.get_mut(&1).unwrap().marked = true;
    });
    assert!(flown.split && flown.pending && flown.emptied, "{flown:?}");
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

/// A store after a bulk load of characters and tags, then creates, edits, deletes, assignments, renames,
/// markers and merges, settled; with postings written.
fn churned(name: &str) -> (Store, PathBuf) {
    churned_checking(name, false, |_, _| {})
}

/// `churned`, calling `check` after the bulk load and after each commit; with `hold`, carrier moves and re-siding are
/// held for 50 commits in each 100, so commits and checks meet moves mid-flight.
fn churned_checking(
    name: &str,
    hold: bool,
    mut check: impl FnMut(&Store, &str),
) -> (Store, PathBuf) {
    const DESCRIPTION: u64 = 10;
    let dir = temp_dir(name);
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut m = Model::new(23);
    m.names = DARK_NAMES;
    m.card_names = CARD_NAMES;
    m.ids = spread_card_id;
    let mut l = s.loader().unwrap();
    for i in 0..8 {
        l.add(m.new_tag(i % 4 != 3)).unwrap();
    }
    for _ in 0..400 {
        let mut r = m.new_card();
        let e = spread_card_id(m.next_card - 1);
        r.push(set(e, DESCRIPTION, "the dark knight rides a dragon"));
        for t in 1..=8 {
            if m.rng.below(4) == 0 {
                r.push(assign(e, t, true));
                m.carriers.entry(t).or_default().insert(e);
            }
        }
        l.add(r).unwrap();
    }
    l.finish().unwrap();
    check(&s, "bulk");
    for i in 0..600 {
        if hold {
            s.hold_carriers(i % 100 < 50);
        }
        let r = match i % 4 {
            0 => m.assign(30),
            1 => m.unassign(30),
            2 => m.other().0,
            _ => {
                let cards: Vec<u64> = m.cards.iter().copied().collect();
                let Some(e) = m.rng.pick(&cards) else {
                    continue;
                };
                let name = CARD_NAMES[m.rng.below(CARD_NAMES.len() as u64) as usize];
                let words = m.rng.below(8) as usize;
                vec![
                    set(e, NAME, name),
                    set(e, DESCRIPTION, &"dark elf ".repeat(words)),
                ]
            }
        };
        if !r.is_empty() {
            s.commit_wait(r).unwrap();
            check(&s, &format!("commit {i}"));
        }
    }
    s.hold_carriers(false);
    settle(&s, &m, "end");
    let postings = key::of(key::SEARCH_POSTING);
    assert!(
        !s.scan(&postings, &key::prefix_end(&postings), 1)
            .unwrap()
            .is_empty()
    );
    (s, dir)
}

/// No key of the removed top lists' structures (46 to 49) is written by a bulk load, nor by creates, edits,
/// deletes and tag changes after it.
#[test]
fn no_top_list_key_is_written() {
    let (s, dir) = churned("no-lists");
    for structure in 46..=49 {
        let start = key::of(structure);
        assert!(
            s.scan(&start, &key::prefix_end(&start), 1)
                .unwrap()
                .is_empty(),
            "structure {structure}"
        );
    }
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

/// No key of the removed field token counters (structure 37) is written by a bulk load, nor by creates, edits,
/// deletes and tag changes after it; and every term's counts hold the document count's slot alone.
#[test]
fn only_document_counts_are_written() {
    let (s, dir) = churned("doc-counts");
    let start = key::of(37);
    assert!(
        s.scan(&start, &key::prefix_end(&start), 1)
            .unwrap()
            .is_empty()
    );
    let start = key::of(key::SEARCH_TERM_COUNTS.id());
    let counts = s
        .scan(&start, &key::prefix_end(&start), usize::MAX)
        .unwrap();
    assert!(!counts.is_empty());
    for (k, v) in counts {
        let slots: Vec<u32> = crate::keyspace::val::map_counts(&v)
            .unwrap()
            .into_iter()
            .map(|c| c.0)
            .collect();
        assert!(
            slots.iter().all(|&x| x == crate::search::DOCS_SLOT),
            "{k:?}: {slots:?}"
        );
    }
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

/// The name terms a library document's tags have its block maxima raised for: each tag's indexed name's that the
/// name its map holds the document by holds too (a moving tag's target name below its cursor, its mapped name at
/// or above it). A query bounds a moving tag's other carriers apart.
fn raised_terms(v: &derive::View, d: u64) -> StoreResult<BTreeSet<Term>> {
    let p = key::id(key::MEMBER_OF, d);
    let mut out = BTreeSet::new();
    for (k, _) in v.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let tag = get_u64(&k, &mut { p.len() }).unwrap();
        let indexed = super::carriers::indexed_name(v, tag)?;
        let by = match super::carriers::tag_map(v, tag)? {
            Some(TagMap {
                flight: Some(f), ..
            }) => {
                if d < f.cursor {
                    f.target_name
                } else {
                    f.mapped_name
                }
            }
            _ => indexed.clone(),
        };
        out.extend(name_terms(&indexed).intersection(&name_terms(&by)).cloned());
    }
    Ok(out)
}

/// Each level-0 block maximum is at least what each document in its block scores for the term in that reading
/// (`search::local_r`, with `TAG_WEIGHT` in a library document's where its tags have the term raised,
/// `raised_terms`), and each one-field maximum what it scores in that field (`search::field_texts`), from the
/// postings, lengths and tags the store holds. Returns how many documents were checked with a tag part.
fn maxima_cover_their_blocks(s: &Store, at: &str) -> u64 {
    use crate::search::{
        LENGTH_BITS, block_maxima, field_max_slot, field_texts, length_block, local_r, local_text,
        max_slot, max_value, pairs, readings, unpack, unslot,
    };
    s.derived(|v| {
        let p = key::of(key::SEARCH_POSTING);
        let (mut checked, mut fields_checked, mut tagged) = (0, 0, 0u64);
        let mut raised: BTreeMap<u64, BTreeSet<Term>> = BTreeMap::new();
        for (k, b) in v.scan(&p, &key::prefix_end(&p), usize::MAX)? {
            let mut i = p.len();
            let scope = Scope {
                kind: get_u64(&k, &mut i).unwrap(),
                owner: get_u64(&k, &mut i).unwrap(),
            };
            let term = String::from_utf8(get_bytes(&k, &mut i).unwrap()).unwrap();
            let block = get_u64(&k, &mut i).unwrap();
            // A pair's postings have no maxima.
            if term.contains(pairs::SEPARATOR) {
                continue;
            }
            let defs = scope.fields();
            let mut docs: BTreeMap<u64, Vec<(u32, crate::search::FieldHit)>> = BTreeMap::new();
            for (sl, n) in map_pairs(&b).unwrap() {
                if n != 0 {
                    let (d, f) = unslot(block, sl);
                    docs.entry(d)
                        .or_default()
                        .push((f, unpack(defs[f as usize].prefix, n)));
                }
            }
            let maxima = v
                .get(&block_maxima(scope, &term, 0, max_slot(block, false).0))?
                .map_or_else(Vec::new, |b| map_pairs(&b).unwrap());
            for (d, hits) in docs {
                let mut lens = [0u64; 16];
                for (sl, len) in v
                    .get(&length_block(scope, d >> LENGTH_BITS))?
                    .map_or_else(Vec::new, |b| map_pairs(&b).unwrap())
                {
                    let (x, f) = crate::search::unslot_in(LENGTH_BITS, d >> LENGTH_BITS, sl);
                    if x == d {
                        lens[f as usize] = u64::from(len);
                    }
                }
                let got = |sl: u32| {
                    maxima
                        .binary_search_by_key(&sl, |x| x.0)
                        .map_or(0.0, |j| max_value(maxima[j].1))
                };
                let terms = match scope {
                    Scope::LIBRARY => match raised.get(&d) {
                        Some(t) => t.clone(),
                        None => {
                            let t = raised_terms(v, d)?;
                            raised.insert(d, t.clone());
                            t
                        }
                    },
                    _ => BTreeSet::new(),
                };
                for &r in readings(&term) {
                    let kind = if r { TermKind::Gram } else { TermKind::Exact };
                    let carries = terms.contains(&(kind, term.clone()));
                    let want = if local_text(scope, &hits, &lens, r) > 0.0 {
                        local_r(scope, &hits, &lens, r, carries)
                    } else {
                        0.0
                    };
                    tagged += u64::from(carries && want > 0.0);
                    let all = got(max_slot(block, r).1);
                    assert!(
                        all >= want,
                        "{at}: {scope:?} {term:?} block {block}, document {d}, prefix {r}: {all} < {want}"
                    );
                    checked += 1;
                    for (f, want) in field_texts(scope, &hits, &lens, r) {
                        let one = got(field_max_slot(block, f, r).1);
                        assert!(
                            one >= want,
                            "{at}: {scope:?} {term:?} block {block}, document {d}, field {f}, prefix {r}: \
                             {one} < {want}"
                        );
                        fields_checked += 1;
                    }
                }
            }
        }
        assert!(checked > 0 && fields_checked > 0, "{at}");
        Ok(tagged)
    })
    .unwrap()
}

/// Each maximum of a node above level 0 is at least each of its children's in that reading and field, and no map above
/// level 0 holds node 0. Returns the maps above level 0 by level and key.
fn nodes_cover_their_children(s: &Store, at: &str) -> BTreeMap<(u64, Vec<u8>), Vec<(u32, u32)>> {
    use crate::search::{
        GROUP_BITS, block_maxima, field_max_slot, max_slot, max_value, unmax_slot,
    };
    s.derived(|v| {
        let p = key::of(key::SEARCH_BLOCK_MAX);
        let mut maps: BTreeMap<((u64, u64), String, u64, u64), Vec<(u32, u32)>> = BTreeMap::new();
        for (k, b) in v.scan(&p, &key::prefix_end(&p), usize::MAX)? {
            let mut i = p.len();
            let scope = Scope {
                kind: get_u64(&k, &mut i).unwrap(),
                owner: get_u64(&k, &mut i).unwrap(),
            };
            let term = String::from_utf8(get_bytes(&k, &mut i).unwrap()).unwrap();
            let level = get_u64(&k, &mut i).unwrap();
            let group = get_u64(&k, &mut i).unwrap();
            maps.insert(((scope.kind, scope.owner), term, level, group), map_pairs(&b).unwrap());
        }
        let mut above = BTreeMap::new();
        for ((sc, term, level, group), m) in &maps {
            let scope = &Scope {
                kind: sc.0,
                owner: sc.1,
            };
            if *level > 0 {
                assert!(
                    *group != 0 || m.iter().all(|x| unmax_slot(*group, x.0).0 != 0),
                    "{at}: {scope:?} {term:?} level {level} holds node 0"
                );
                above.insert(
                    (*level, block_maxima(*scope, term, *level, *group)),
                    m.clone(),
                );
            }
            // Group 0's node above is node 0, which holds no maximum.
            if *group == 0 {
                continue;
            }
            let fields = (0..scope.fields().len() as u32).map(Some);
            for (field, r) in std::iter::once(None)
                .chain(fields)
                .flat_map(|f| [(f, false), (f, true)])
            {
                let Some(child) = m
                    .iter()
                    .filter(|x| {
                        let (_, f, p) = unmax_slot(*group, x.0);
                        (f, p) == (field, r)
                    })
                    .map(|x| max_value(x.1))
                    .reduce(f64::max)
                else {
                    continue;
                };
                let (pg, sl) = match field {
                    Some(f) => field_max_slot(*group, f, r),
                    None => max_slot(*group, r),
                };
                let parent = maps
                    .get(&(*sc, term.clone(), level + 1, pg))
                    .and_then(|pm| pm.binary_search_by_key(&sl, |x| x.0).ok().map(|j| max_value(pm[j].1)))
                    .unwrap_or(0.0);
                assert!(
                    parent >= child,
                    "{at}: {scope:?} {term:?} level {} node {group} (of {} per node), field {field:?}, \
                     prefix {r}: {parent} < {child}",
                    level + 1,
                    1u64 << GROUP_BITS
                );
            }
        }
        Ok(above)
    })
    .unwrap()
}

/// After a bulk load, and after each of the creates, edits, deletes and tag changes that follow it, every
/// level-0 block maximum covers its block's documents with their tag parts, and every node's maximum its
/// children's; with carrier moves held for stretches of commits and let go, and once everything settled. Levels 1
/// and 2 are written by the load and changed by the commits. After each check, queries over every field, in one
/// field, and of two words queue their tightening jobs, which run before the next commit, while tags move.
#[test]
fn block_maxima_cover_their_blocks_through_every_change() {
    let mut last = BTreeMap::new();
    let mut written = BTreeSet::new();
    let mut changed = BTreeSet::new();
    let c = |t: &str, fields: Option<Vec<u32>>, quoted: bool| Clause {
        text: t.as_bytes().to_vec(),
        fields,
        negate: false,
        quoted,
    };
    let queries: Vec<Query> = [
        vec![c("dark", None, true)],
        vec![c("da", None, false)],
        vec![c("elf", None, false)],
        vec![c("dra", Some(vec![0]), false)],
        vec![c("dark", Some(vec![1]), true)],
        vec![c("dark", None, false), c("el", None, false)],
    ]
    .into_iter()
    .map(|clauses| Query {
        scope: Scope::LIBRARY,
        clauses,
        filters: Vec::new(),
        order: Order::Relevance,
        limit: 3,
        after: None,
        weights: None,
        limits: Limits::default(),
    })
    .collect();
    let mut reported = 0;
    // Documents checked with a tag part; checks with a move in flight.
    let (mut tagged, mut in_flight) = (0, 0);
    let (s, dir) = churned_checking("maxima", true, |s, at| {
        tagged += maxima_cover_their_blocks(s, at);
        in_flight += u64::from(!read(s).moving.is_empty());
        let now = nodes_cover_their_children(s, at);
        for (k, m) in &now {
            if at == "bulk" {
                written.insert(k.0);
            } else if last.get(k) != Some(m) {
                changed.insert(k.0);
            }
        }
        last = now;
        for q in &queries {
            reported += s.search(q).unwrap().tighten.len();
        }
    });
    assert!(written.contains(&1) && written.contains(&2), "{written:?}");
    assert!(changed.contains(&1) && changed.contains(&2), "{changed:?}");
    assert!(reported > 0 && s.tightened() > 0, "{reported} reported, {} wrote", s.tightened());
    tagged += maxima_cover_their_blocks(&s, "settled");
    nodes_cover_their_children(&s, "settled");
    assert!(
        tagged > 0 && in_flight > 0,
        "{tagged} tagged, {in_flight} in flight"
    );
    eprintln!(
        "{reported} reported, {} jobs wrote, {tagged} tagged documents checked, {in_flight} checks with a move in flight",
        s.tightened()
    );
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

/// Two light tags renamed to gain a term, both moving over the same card: the first move to reach the card meets
/// the other one's carriers not yet raised, and the second meets the first's settled; after both, the card's block
/// maximum over every field holds its score with the tag part.
#[test]
fn two_tags_gaining_a_term_over_one_card_raise_its_block() {
    use crate::search::{TAG_WEIGHT, block_maxima, max_slot, max_value};
    let dir = temp_dir("two-gains");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let e = card_id(0);
    let mut recs = Vec::new();
    for t in [1, 2] {
        recs.extend([set(t, NAME, "x"), mark(t), create(t, TAG, &format!("t{t}"))]);
    }
    recs.extend([set(e, NAME, "dark knight"), create(e, CHARACTER, "c.png")]);
    recs.extend([assign(e, 1, true), assign(e, 2, true)]);
    s.commit_wait(recs).unwrap();
    let stored = |s: &Store| {
        let block = e >> crate::search::BLOCK_BITS;
        let (group, sl) = max_slot(block, false);
        s.get(&block_maxima(Scope::LIBRARY, "dark", 0, group))
            .unwrap()
            .map_or(0.0, |b| {
                let m = map_pairs(&b).unwrap();
                m.binary_search_by_key(&sl, |x| x.0)
                    .map_or(0.0, |i| max_value(m[i].1))
            })
    };
    let text = stored(&s);
    assert!(text > 0.0);
    s.hold_carriers(true);
    s.commit_wait(vec![set(1, NAME, "dark"), set(2, NAME, "dark")])
        .unwrap();
    assert_eq!(read(&s).moving, BTreeSet::from([1, 2]));
    s.hold_carriers(false);
    let mut m = Model::new(1);
    for t in [1, 2] {
        m.tags.insert(
            t,
            T {
                name: "dark".into(),
                marked: true,
                gone: false,
            },
        );
        m.carriers.entry(t).or_default().insert(e);
    }
    settle(&s, &m, "both moved");
    // Stored rounded up from the text alone, then from the text and the tag part.
    assert!(
        stored(&s) > text + TAG_WEIGHT / 2.0,
        "{} for {text} and the tag",
        stored(&s)
    );
    assert!(maxima_cover_their_blocks(&s, "both moved") > 0);
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

/// A tightening job run while a raise of the same maxima map waits unpublished (in a layer of its view, as a
/// commit queued ahead of it leaves it): the map it puts back keeps the published slots of the other blocks it
/// holds, and the waiting raise.
#[test]
fn a_tightening_job_keeps_published_slots_under_a_raise_not_yet_published() {
    use crate::search::index::{tighten, whole};
    use crate::search::{BLOCK_BITS, block_maxima, max_slot};
    let dir = temp_dir("unpublished-raise");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let base = 5u64 << 30;
    let block = base >> BLOCK_BITS;
    let card = |e: u64, name: &str| {
        vec![
            set(e, NAME, name),
            create(e, CHARACTER, &format!("c{e}.png")),
        ]
    };
    // Block `block` and the next one, under the same level-0 map.
    let mut recs = card(base + 1, "omega");
    recs.extend(card(base + 2, "omega knight knight knight"));
    recs.extend(card(base + (1 << BLOCK_BITS), "omega knight"));
    s.commit_wait(recs).unwrap();
    s.commit_wait(vec![delete(base + 1)]).unwrap();
    let (group, _) = max_slot(block, false);
    let k = block_maxima(Scope::LIBRARY, "omega", 0, group);
    let next = node_at(&s, "omega", block + 1, 0);
    assert!(!next.is_empty());
    s.derived(|v| {
        // A card scoring between the two left in `block`, its entries not published.
        let mut raised = BTreeMap::new();
        let mut out = derive::Out::default();
        let name: &[&[u8]] = &[b"omega knight"];
        whole(v, &mut out, Scope::LIBRARY, base + 3, &[(0, name)], true)?;
        out.apply(&mut raised);
        let lv = v.with_layer(&raised);
        let mut out = derive::Out::default();
        tighten(&lv, &mut out, Scope::LIBRARY, "omega", block)?;
        let mut job = raised.clone();
        out.apply(&mut job);
        let after = v.with_layer(&job);
        let m = after
            .get(&k)?
            .map_or_else(Vec::new, |b| map_pairs(&b).unwrap());
        let next_slots: BTreeMap<u32, u32> = m
            .iter()
            .filter(|p| u64::from(p.0 >> crate::search::NODE_SLOT_BITS) == (block + 1) & 1023)
            .map(|&(sl, v)| (sl & ((1 << crate::search::NODE_SLOT_BITS) - 1), v))
            .collect();
        assert_eq!(next_slots, next, "the next block's published slots");
        let ours: BTreeMap<u32, u32> = m
            .iter()
            .filter(|p| u64::from(p.0 >> crate::search::NODE_SLOT_BITS) == block & 1023)
            .map(|&(sl, v)| (sl & ((1 << crate::search::NODE_SLOT_BITS) - 1), v))
            .collect();
        let waiting = raised.get(&k).cloned();
        let Some(crate::keyspace::val::Val::MaxMap(w)) = waiting else {
            panic!("no raise waits: {waiting:?}");
        };
        for (sl, v) in w
            .iter()
            .filter(|p| u64::from(p.0 >> crate::search::NODE_SLOT_BITS) == block & 1023)
        {
            let sub = sl & ((1 << crate::search::NODE_SLOT_BITS) - 1);
            assert!(
                ours.get(&sub).is_some_and(|x| x >= v),
                "the waiting raise at sub {sub}: {ours:?}"
            );
        }
        Ok(())
    })
    .unwrap();
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

/// Each slot `term`'s maxima map holds at `level` for the node over block `block`, by sub.
fn node_at(s: &Store, term: &str, block: u64, level: u64) -> BTreeMap<u32, u32> {
    use crate::search::{GROUP_BITS, NODE_SLOT_BITS, block_maxima, node_of};
    let node = node_of(block, level);
    s.get(&block_maxima(Scope::LIBRARY, term, level, node >> GROUP_BITS))
        .unwrap()
        .map_or_else(Vec::new, |b| map_pairs(&b).unwrap())
        .into_iter()
        .filter(|p| u64::from(p.0 >> NODE_SLOT_BITS) == node & ((1 << GROUP_BITS) - 1))
        .map(|(sl, v)| (sl & ((1 << NODE_SLOT_BITS) - 1), v))
        .collect()
}

/// The most each slot of `term`'s node over block `block` covers (`max_bits`), by sub, from the postings and
/// lengths the store holds, with no tag part.
fn node_truth(s: &Store, term: &str, block: u64) -> BTreeMap<u32, u32> {
    use crate::search::{
        LENGTH_BITS, field_texts, length_block, local_text, max_bits, posting_block, readings,
        unpack, unslot, unslot_in,
    };
    let scope = Scope::LIBRARY;
    let defs = scope.fields();
    let mut docs: BTreeMap<u64, Vec<(u32, crate::search::FieldHit)>> = BTreeMap::new();
    for (sl, v) in s
        .get(&posting_block(scope, term, block))
        .unwrap()
        .map_or_else(Vec::new, |b| map_pairs(&b).unwrap())
    {
        if v != 0 {
            let (d, f) = unslot(block, sl);
            docs.entry(d)
                .or_default()
                .push((f, unpack(defs[f as usize].prefix, v)));
        }
    }
    let mut out = BTreeMap::new();
    let mut most = |sub: u32, v: f64| {
        let b = max_bits(v);
        let e = out.entry(sub).or_insert(b);
        *e = (*e).max(b);
    };
    for (d, hits) in docs {
        let mut lens = [0u64; 16];
        for (sl, len) in s
            .get(&length_block(scope, d >> LENGTH_BITS))
            .unwrap()
            .map_or_else(Vec::new, |b| map_pairs(&b).unwrap())
        {
            let (x, f) = unslot_in(LENGTH_BITS, d >> LENGTH_BITS, sl);
            if x == d {
                lens[f as usize] = u64::from(len);
            }
        }
        for &r in readings(term) {
            let text = local_text(scope, &hits, &lens, r);
            if text > 0.0 {
                most(u32::from(r), text);
            }
            for (f, x) in field_texts(scope, &hits, &lens, r) {
                most((f + 1) << 1 | u32::from(r), x);
            }
        }
    }
    out
}

/// A tightening job interleaved with commits that raise the same maxima map, at every level the block feeds
/// (its ids put it under levels 1 and 2): a raise committed between the query's report and its job is kept, and
/// one committed right after the job (queued behind it) folds over the job's put. Either way each level holds
/// what the documents left score, no more.
#[test]
fn a_tightening_job_keeps_the_raises_committed_around_it() {
    let dir = temp_dir("interleave");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let base = 5u64 << 30;
    let block = base >> crate::search::BLOCK_BITS;
    assert_eq!(crate::search::top_level(block), 2);
    let card = |e: u64, name: &str| vec![set(e, NAME, name), create(e, CHARACTER, &format!("c{e}.png"))];
    let mut recs = card(base + 1, "omega");
    for i in 2..5 {
        recs.extend(card(base + i, "omega knight knight knight"));
    }
    s.commit_wait(recs).unwrap();
    let q = Query {
        scope: Scope::LIBRARY,
        clauses: vec![Clause {
            text: b"omega".to_vec(),
            fields: None,
            negate: false,
            quoted: true,
        }],
        filters: Vec::new(),
        order: Order::Relevance,
        limit: 1,
        after: None,
        weights: None,
        limits: Limits::default(),
    };
    let levels_hold_the_truth = |at: &str| {
        let truth = node_truth(&s, "omega", block);
        for level in 0..=2 {
            assert_eq!(node_at(&s, "omega", block, level), truth, "{at}: level {level}");
        }
        maxima_cover_their_blocks(&s, at);
        nodes_cover_their_children(&s, at);
    };
    levels_hold_the_truth("fresh");

    // The best card goes; a query reports its block; a card scoring between commits, then the job runs.
    s.commit_wait(vec![delete(base + 1)]).unwrap();
    let stale = node_at(&s, "omega", block, 0);
    let reports = s.search_unqueued(&q).unwrap().tighten;
    assert!(reports.iter().any(|t| t.term == "omega" && t.block == block), "{reports:?}");
    s.commit_wait(card(base + 5, "omega knight")).unwrap();
    s.tighten_queue(&reports);
    s.jobs_wait();
    assert_ne!(node_at(&s, "omega", block, 0), stale);
    levels_hold_the_truth("raised before the job");

    // That card goes; the job is queued, and a card scoring highest commits behind it.
    s.commit_wait(vec![delete(base + 5)]).unwrap();
    let reports = s.search_unqueued(&q).unwrap().tighten;
    assert!(reports.iter().any(|t| t.term == "omega" && t.block == block), "{reports:?}");
    let written = s.tightened();
    s.tighten_queue(&reports);
    s.commit_wait(card(base + 6, "omega")).unwrap();
    assert!(s.tightened() > written, "the job wrote nothing");
    levels_hold_the_truth("raised after the job");
    assert_eq!(
        s.search(&q).unwrap().hits.first().map(|h| h.doc),
        Some(base + 6)
    );
    s.close();
    let _ = fs::remove_dir_all(&dir);
}
