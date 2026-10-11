use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use super::chat::{self, FOLLOWING, MES, PINNED};
use super::chat_read::Js;
use super::kinds::{Holder, key, parse_loc, text_value_of};
use super::sessions::{self, Fork};
use super::*;
use super::{prune, stats};
use crate::log::format::{Value, kind_by_name, wtf8_from_utf16};
use crate::search::Scope;

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-chat-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

const SMALL: StoreConfig = StoreConfig {
    log: log::Config {
        block_size: 256,
        file_target: 4096,
    },
    ks: KsConfig {
        log_bytes: 8 << 10,
        fan_in: 3,
        block_size: 256,
        max_frozen: 1,
    },
    live_fraction: 0.5,
    relocate_bytes: 1024,
};

fn small_pool() -> Arc<Pool> {
    Pool::new(16 << 10, 64 << 10, 4, 1, 2, 2)
}

fn text(s: &str) -> Vec<u8> {
    wtf8_from_utf16(&s.encode_utf16().collect::<Vec<_>>())
}

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn opt(v: Option<u64>) -> Value {
    v.map_or(Value::Absent, Value::Id)
}

const MES_F: FieldRef = FieldRef::Code(MES);

/// Sessions are positions 1..=SESSIONS, users 1..=USERS; bookmarks are numbered after the sessions.
const SESSIONS: u64 = 4;
const USERS: u64 = 2;

/// The records that make sessions and users exist: their outside keys.
fn actors() -> Vec<Record> {
    let mut out = Vec::new();
    for s in 1..=SESSIONS {
        out.push(rec(
            "keyMap",
            vec![
                Value::Sel(chat::KEYED_SESSION, s),
                Value::Bytes(format!("session-{s}").into_bytes()),
            ],
        ));
    }
    for u in 1..=USERS {
        out.push(rec(
            "keyMap",
            vec![
                Value::Sel(chat::KEYED_USER, u),
                Value::Bytes(format!("user-{u}").into_bytes()),
            ],
        ));
    }
    out
}

fn actor_keys() -> BTreeMap<(u8, Vec<u8>), u64> {
    let mut k = BTreeMap::new();
    for s in 1..=SESSIONS {
        k.insert(
            (chat::KEYED_SESSION, format!("session-{s}").into_bytes()),
            s,
        );
    }
    for u in 1..=USERS {
        k.insert((chat::KEYED_USER, format!("user-{u}").into_bytes()), u);
    }
    k
}

#[derive(Clone, Debug)]
struct Msg {
    owner: u64,
    parent: Option<u64>,
    time: i64,
    text: Option<String>,
    values: BTreeMap<String, String>,
    times: BTreeMap<String, i64>,
    send_key: Option<Vec<u8>>,
}

#[derive(Clone, Debug)]
struct Bookmark {
    at: u64,
    created_at: u64,
    mode: u64,
    name: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct Session {
    pointer: Option<(u64, Option<u64>)>,
    history: Vec<(sessions::Target, bool)>,
    cursor: Option<u64>,
    trees: BTreeMap<u64, Option<u64>>,
    openings: BTreeMap<u64, u64>,
}

/// What the derived chat structures must show. `seq` orders events as log positions do.
#[derive(Default, Clone)]
struct Model {
    msgs: BTreeMap<u64, Msg>,
    bookmarks: BTreeMap<u64, Bookmark>,
    keys: BTreeMap<(u8, Vec<u8>), u64>,
    next_msg: u64,
    next_pos: u64,
    sessions: BTreeMap<u64, Session>,
    recent: BTreeMap<u64, u64>,
    activity: BTreeMap<u64, BTreeMap<u64, u64>>,
    user_tree: BTreeMap<(u64, u64), (u64, Option<u64>)>,
    user_order: BTreeMap<(u64, u64), BTreeMap<u64, u64>>,
    choices: BTreeMap<(u8, u64, Fork), u64>,
    branches: BTreeMap<u64, Vec<u64>>,
    itemized: BTreeMap<u64, (bool, Vec<u8>)>,
    seq: u64,
}

fn fork_of(parent: Option<u64>, owner: u64) -> Fork {
    match parent {
        Some(p) => Fork::Message(p),
        None => Fork::Root(owner),
    }
}

impl Model {
    fn new() -> Model {
        Model {
            keys: actor_keys(),
            next_pos: SESSIONS + 1,
            ..Model::default()
        }
    }

    fn children(&self, parent: Option<u64>, owner: u64) -> Vec<u64> {
        let mut c: Vec<(i64, u64)> = self
            .msgs
            .iter()
            .filter(|(_, m)| m.parent == parent && (parent.is_some() || m.owner == owner))
            .map(|(id, m)| (m.time, *id))
            .collect();
        c.sort();
        c.into_iter().map(|(_, id)| id).collect()
    }

    fn below(&self, a: u64, m: u64) -> bool {
        let mut cur = Some(a);
        while let Some(c) = cur {
            if c == m {
                return true;
            }
            cur = self.msgs[&c].parent;
        }
        false
    }

    fn depth(&self, m: u64) -> u64 {
        let mut d = 0;
        let mut cur = Some(m);
        while let Some(c) = cur {
            d += 1;
            cur = self.msgs[&c].parent;
        }
        d
    }

    fn tick(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    fn act(&mut self, s: u64, tree: u64) {
        let q = self.tick();
        self.activity.entry(tree).or_default().insert(s, q);
    }

    fn moved(&mut self, s: u64, u: u64, tree: u64, target: Option<u64>, meaningful: bool) {
        self.pointer_moved(s, u, tree, target, meaningful);
        let ses = self.sessions.get_mut(&s).unwrap();
        ses.history.push((
            target.map_or(sessions::Target::Root(tree), sessions::Target::Message),
            false,
        ));
        ses.cursor = Some(ses.history.len() as u64);
    }

    /// The entry a step from the session's cursor reaches.
    fn step_target(&self, s: u64, back: bool) -> Option<(u64, sessions::Target)> {
        let ses = self.sessions.get(&s)?;
        let c = ses.cursor?;
        let live = |n: u64| {
            let (t, gone) = ses.history[n as usize - 1];
            (!gone).then_some((n, t))
        };
        if back {
            (1..c).rev().find_map(live)
        } else {
            (c + 1..=ses.history.len() as u64).find_map(live)
        }
    }

    fn stepped(&mut self, s: u64, u: u64, n: u64) {
        let t = self.sessions[&s].history[n as usize - 1].0;
        let (tree, target) = match t {
            sessions::Target::Message(m) => (self.msgs[&m].owner, Some(m)),
            sessions::Target::Root(tree) => (tree, None),
        };
        self.pointer_moved(s, u, tree, target, false);
        self.sessions.get_mut(&s).unwrap().cursor = Some(n);
    }

    fn pointer_moved(&mut self, s: u64, u: u64, tree: u64, target: Option<u64>, meaningful: bool) {
        let q = self.tick();
        let ses = self.sessions.entry(s).or_default();
        let entering = ses.pointer.map(|(t, _)| t) != Some(tree);
        ses.pointer = Some((tree, target));
        ses.trees.insert(tree, target);
        self.recent.insert(s, q);
        self.user_tree.insert((u, tree), (s, target));
        self.user_order.entry((u, tree)).or_default().insert(s, q);
        if meaningful || !entering {
            self.activity.entry(tree).or_default().insert(s, q);
        }
    }

    fn choose(&mut self, s: u64, u: u64, f: Fork, reply: u64) {
        if let Fork::Root(tree) = f
            && let Some(ses) = self.sessions.get_mut(&s)
        {
            ses.openings.remove(&tree);
        }
        self.choices.insert((0, s, f), reply);
        self.choices.insert((1, u, f), reply);
        self.choices.insert((2, 0, f), reply);
    }

    fn is_reply_at(&self, reply: u64, f: Fork) -> bool {
        self.msgs
            .get(&reply)
            .is_some_and(|m| fork_of(m.parent, m.owner) == f)
    }

    fn followed(&self, s: Option<u64>, u: Option<u64>, f: Fork, tree: u64) -> Option<u64> {
        for k in [s.map(|s| (0, s, f)), u.map(|u| (1, u, f)), Some((2, 0, f))]
            .into_iter()
            .flatten()
        {
            if let Some(r) = self.choices.get(&k)
                && self.is_reply_at(*r, f)
            {
                return Some(*r);
            }
        }
        let parent = match f {
            Fork::Message(m) => Some(m),
            Fork::Root(_) => None,
        };
        self.children(parent, tree).last().copied()
    }

    fn landing(&self, s: Option<u64>, u: Option<u64>, tree: u64) -> Option<u64> {
        if let Some(s) = s
            && let Some(p) = self.sessions.get(&s).and_then(|x| x.trees.get(&tree))
        {
            return *p;
        }
        if let Some(u) = u
            && let Some((_, p)) = self.user_tree.get(&(u, tree))
        {
            return *p;
        }
        let mut at = None;
        let mut f = Fork::Root(tree);
        while let Some(n) = self.followed(s, u, f, tree) {
            at = Some(n);
            f = Fork::Message(n);
        }
        at
    }

    /// Message `m` goes: what points at it moves, its history entries are gone, its choices go.
    fn message_gone(&mut self, m: u64) {
        let msg = self.msgs.remove(&m).unwrap();
        let to = match msg.parent {
            Some(p) => Some(p),
            None => self.children(None, msg.owner).last().copied(),
        };
        for ses in self.sessions.values_mut() {
            if let Some((t, Some(p))) = ses.pointer
                && p == m
            {
                ses.pointer = Some((t, to));
            }
            for p in ses.trees.values_mut() {
                if *p == Some(m) {
                    *p = to;
                }
            }
            for h in &mut ses.history {
                if h.0 == sessions::Target::Message(m) {
                    h.1 = true;
                }
            }
        }
        for v in self.user_tree.values_mut() {
            if v.1 == Some(m) {
                v.1 = to;
            }
        }
        self.choices.retain(|_, r| *r != m);
        self.branches.remove(&m);
        self.itemized.remove(&m);
        self.keys
            .retain(|(sp, _), v| !(*sp == chat::KEYED_MESSAGE && *v == m));
    }

    /// Message `r` and everything below it go: what is at them moves to `r`'s parent (sessions at an opening's to
    /// the newest other opening), pinned bookmarks and following ones with nowhere to move go.
    fn subtree_gone(&mut self, r: u64) {
        let (tree, parent) = (self.msgs[&r].owner, self.msgs[&r].parent);
        let to = match parent {
            Some(p) => Some(p),
            None => self.children(None, tree).into_iter().rfind(|o| *o != r),
        };
        let doomed: BTreeSet<u64> = self
            .msgs
            .keys()
            .copied()
            .filter(|m| self.below(*m, r))
            .collect();
        for ses in self.sessions.values_mut() {
            if let Some((t, Some(p))) = ses.pointer
                && doomed.contains(&p)
            {
                ses.pointer = Some((t, to));
            }
            if let Some(Some(p)) = ses.trees.get(&tree)
                && doomed.contains(p)
            {
                ses.trees.insert(tree, to);
            }
        }
        for ((_, t), v) in self.user_tree.iter_mut() {
            if *t == tree && v.1.is_some_and(|p| doomed.contains(&p)) {
                v.1 = to;
            }
        }
        let gone: Vec<u64> = self
            .bookmarks
            .iter()
            .filter(|(_, b)| doomed.contains(&b.at))
            .map(|(id, _)| *id)
            .collect();
        for b in gone {
            let bm = self.bookmarks.get_mut(&b).unwrap();
            if bm.mode == FOLLOWING
                && let Some(p) = parent
            {
                bm.at = p;
                continue;
            }
            let bm = self.bookmarks.remove(&b).unwrap();
            if let Some(l) = self.branches.get_mut(&bm.created_at) {
                l.retain(|x| *x != b);
                if l.is_empty() {
                    self.branches.remove(&bm.created_at);
                }
            }
        }
        for m in doomed {
            self.message_gone(m);
        }
    }

    fn session_gone(&mut self, s: u64) {
        self.keys
            .retain(|(sp, _), v| !(*sp == chat::KEYED_SESSION && *v == s));
        self.choices
            .retain(|(tier, who, _), _| !(*tier == 0 && *who == s));
        self.sessions.remove(&s);
        self.recent.remove(&s);
        for a in self.activity.values_mut() {
            a.remove(&s);
        }
        let keys: Vec<(u64, u64)> = self.user_order.keys().copied().collect();
        for k in keys {
            self.user_order.get_mut(&k).unwrap().remove(&s);
            if self.user_tree.get(&k).is_some_and(|(us, _)| *us == s) {
                let next = self.user_order[&k]
                    .iter()
                    .max_by_key(|(_, q)| **q)
                    .map(|(o, _)| *o);
                match next {
                    Some(o) => {
                        let p = self.sessions[&o].trees[&k.1];
                        self.user_tree.insert(k, (o, p));
                    }
                    None => {
                        self.user_tree.remove(&k);
                    }
                }
            }
        }
    }

    fn check(&self, s: &Store) {
        // Depth rewrites and subtree deletes run between commits: wait for them.
        let busy = |v: &View| Ok(sessions::any_pending(v)? || prune::any_pending(v)?);
        for _ in 0..2000 {
            if !s.derived(busy).unwrap() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        s.derived(|v| {
            assert!(!busy(v)?);
            let count = |prefix: Vec<u8>| {
                v.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)
                    .unwrap()
                    .len()
            };
            // The indexes a subtree delete finds positions through, and bookmark names.
            let pointers = self
                .sessions
                .values()
                .filter(|x| matches!(x.pointer, Some((_, Some(_)))))
                .count();
            assert_eq!(
                count(key::of(sessions::PTR_IN_TREE)),
                pointers,
                "pointers by tree"
            );
            for (id, x) in &self.sessions {
                if let Some((t, Some(_))) = x.pointer {
                    assert!(v.get(&key::ids(sessions::PTR_IN_TREE, t, *id))?.is_some());
                }
            }
            let remembered = self
                .sessions
                .values()
                .map(|x| x.trees.values().filter(|p| p.is_some()).count())
                .sum::<usize>()
                + self.user_tree.values().filter(|(_, p)| p.is_some()).count();
            assert_eq!(
                count(key::of(sessions::REMEMBERED_IN)),
                remembered,
                "remembered by tree"
            );
            let named: Vec<(&u64, &Bookmark)> = self
                .bookmarks
                .iter()
                .filter(|(_, b)| b.name.is_some())
                .collect();
            assert_eq!(
                count(key::of(chat::BOOKMARK_NAMED)),
                named.len(),
                "bookmark names"
            );
            for (b, bm) in named {
                let tree = self.msgs[&bm.at].owner;
                assert_eq!(
                    chat::bookmarks_named(v, tree, &text(bm.name.as_deref().unwrap()))?,
                    vec![*b]
                );
            }
            let scan_ids = |prefix: Vec<u8>| -> Vec<u64> {
                v.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)
                    .unwrap()
                    .into_iter()
                    .map(|(k, _)| chat::child_of_key(&k, prefix.len()).unwrap())
                    .collect()
            };
            for (id, m) in &self.msgs {
                let (_, r) = chat::require_message(v, *id)?;
                assert_eq!(chat::parent_of(v, *id, &r)?, m.parent, "parent of {id}");
                assert_eq!(
                    scan_ids(chat::children_prefix(Some(*id), m.owner)),
                    self.children(Some(*id), m.owner),
                    "replies to {id}"
                );
                let t = text_value_of(v, Holder::Message(*id), &MES_F)?;
                assert_eq!(t, m.text.as_deref().map(text), "text of {id}");
                for (k, json) in &m.values {
                    let f = FieldRef::Key(k.as_bytes().to_vec());
                    let b = v.get(&Holder::Message(*id).value_key(&f))?.unwrap();
                    let (vr, _) = v.record(parse_loc(&b)?.pos)?;
                    assert_eq!(vr.values[2], Value::Text(text(json)), "{k} of {id}");
                }
                let vp = key::id(key::MSG_VALUE, *id);
                assert_eq!(
                    v.scan(&vp, &key::prefix_end(&vp), usize::MAX)?.len(),
                    m.values.len(),
                    "values of {id}"
                );
                for (k, d) in &m.times {
                    let f = FieldRef::Key(k.as_bytes().to_vec());
                    let b = v.get(&chat::msg_time_key(*id, &f))?.unwrap();
                    let (tr, _) = v.record(parse_loc(&b)?.pos)?;
                    assert_eq!(tr.values[2], Value::Int(*d), "{k} of {id}");
                }
                if let Some(sk) = &m.send_key {
                    let b = v.get(&chat::send_key_key(m.owner, sk))?.unwrap();
                    assert_eq!(kinds::parse_varints::<1>(&b)?, [*id]);
                }
                assert_eq!(
                    sessions::depth(v, *id)?,
                    Some(self.depth(*id)),
                    "depth of {id}"
                );
                // Its jump is its ancestor at the jump depth, and ancestry through jumps is the model's.
                let d = self.depth(*id);
                let jd = sessions::jump_depth(d);
                let mut want = Some(*id);
                for _ in 0..d - jd {
                    want = want.and_then(|c| self.msgs[&c].parent);
                }
                assert_eq!(
                    sessions::depth_jump(v, *id)?,
                    Some((d, if jd == 0 { None } else { want })),
                    "jump of {id}"
                );
                for other in self.msgs.keys().copied().filter(|o| o % 7 == id % 7) {
                    let mut reads = 0;
                    assert_eq!(
                        sessions::ancestor_or_self(v, other, *id, &mut reads)?,
                        Some(self.below(*id, other)),
                        "{other} above {id}"
                    );
                }
                assert_eq!(
                    sessions::branches_from(v, *id)?,
                    self.branches.get(id).cloned().unwrap_or_default(),
                    "branches at {id}"
                );
                assert_eq!(
                    chat::message_entry(v, *id)?.map(|(_, p)| p),
                    Some(self.msgs[id].parent),
                    "parent of {id} in its entry"
                );
                assert_eq!(
                    chat::shapes(v, &[*id])?[0],
                    chat::shape_scanned(v, *id)?,
                    "shape of {id}"
                );
            }
            let owners: BTreeSet<u64> = self.msgs.values().map(|m| m.owner).collect();
            for o in &owners {
                assert_eq!(
                    scan_ids(chat::children_prefix(None, *o)),
                    self.children(None, *o),
                    "roots of {o}"
                );
            }
            let all = key::of(key::MESSAGE);
            assert_eq!(
                v.scan(&all, &key::prefix_end(&all), usize::MAX)?.len(),
                self.msgs.len()
            );
            let all = key::of(sessions::DEPTH);
            assert_eq!(
                v.scan(&all, &key::prefix_end(&all), usize::MAX)?.len(),
                self.msgs.len()
            );
            for (b, bm) in &self.bookmarks {
                assert_eq!(chat::bookmark_at(v, *b)?, Some(bm.at), "bookmark {b}");
                assert_eq!(chat::bookmark_mode(v, *b)?, Some(bm.mode), "mode of {b}");
                let name = v.get(&key::id(key::POSITION_NAME, *b))?.map(|l| {
                    let (r, _) = v.record(parse_loc(&l).unwrap().pos).unwrap();
                    r.values[1].clone()
                });
                assert_eq!(
                    name,
                    bm.name.as_deref().map(|n| Value::Text(text(n))),
                    "name of {b}"
                );
                assert!(chat::bookmarks_at(v, bm.at)?.contains(b));
                let owner = self.msgs[&bm.at].owner;
                assert!(v.get(&key::ids(key::TREE_BOOKMARK, owner, *b))?.is_some());
            }
            let all = key::of(key::BOOKMARK_AT);
            assert_eq!(
                v.scan(&all, &key::prefix_end(&all), usize::MAX)?.len(),
                self.bookmarks.len()
            );
            for ((space, k), i) in &self.keys {
                assert_eq!(chat::id_by_key(v, *space, k)?, Some(*i));
                assert_eq!(
                    chat::key_by_id(v, *space, *i)?.as_deref(),
                    Some(k.as_slice())
                );
            }
            let all = key::of(key::KEY_OF);
            assert_eq!(
                v.scan(&all, &key::prefix_end(&all), usize::MAX)?.len(),
                self.keys.len()
            );
            // Sessions.
            for s in 1..=SESSIONS {
                let ses = self.sessions.get(&s).cloned().unwrap_or_default();
                assert_eq!(
                    sessions::session_pointer(v, s)?,
                    ses.pointer,
                    "pointer of {s}"
                );
                let h: Vec<(sessions::Target, bool)> = sessions::history(v, s, 0, usize::MAX)?
                    .into_iter()
                    .map(|(_, t, g)| (t, g))
                    .collect();
                assert_eq!(h, ses.history, "history of {s}");
                assert_eq!(sessions::cursor(v, s)?, ses.cursor, "cursor of {s}");
                for back in [true, false] {
                    assert_eq!(
                        sessions::step_target(v, s, back)?,
                        self.step_target(s, back),
                        "step of {s}, back {back}"
                    );
                }
                for t in 1..=3 {
                    assert_eq!(
                        sessions::opening_choice(v, s, t)?,
                        ses.openings.get(&t).copied(),
                        "opening choice of {s} in {t}"
                    );
                }
                for t in &owners {
                    assert_eq!(
                        sessions::session_in_tree(v, s, *t)?,
                        ses.trees.get(t).copied(),
                        "{s} in {t}"
                    );
                }
            }
            let mut recent: Vec<(u64, u64)> = self.recent.iter().map(|(s, q)| (*q, *s)).collect();
            recent.sort_by(|a, b| b.cmp(a));
            let got: Vec<u64> = sessions::recent(v, None, usize::MAX)?
                .into_iter()
                .map(|(_, s)| s)
                .collect();
            assert_eq!(
                got,
                recent.into_iter().map(|(_, s)| s).collect::<Vec<_>>(),
                "recent sessions"
            );
            for t in &owners {
                let mut want: Vec<(u64, u64)> = self
                    .activity
                    .get(t)
                    .map(|a| a.iter().map(|(s, q)| (*q, *s)).collect())
                    .unwrap_or_default();
                want.sort_by(|a, b| b.cmp(a));
                let got: Vec<u64> = sessions::in_tree(v, *t, None, usize::MAX)?
                    .into_iter()
                    .map(|(_, s)| s)
                    .collect();
                assert_eq!(
                    got,
                    want.into_iter().map(|(_, s)| s).collect::<Vec<_>>(),
                    "sessions active in {t}"
                );
                for u in 1..=USERS {
                    assert_eq!(
                        sessions::user_in_tree(v, u, *t)?,
                        self.user_tree.get(&(u, *t)).copied(),
                        "user {u} in {t}"
                    );
                    for s in [None, Some(1), Some(2)] {
                        assert_eq!(
                            sessions::landing(v, s, Some(u), *t)?,
                            self.landing(s, Some(u), *t),
                            "landing of {s:?}, {u} in {t}"
                        );
                    }
                }
                assert_eq!(
                    sessions::landing(v, None, None, *t)?,
                    self.landing(None, None, *t),
                    "landing in {t}"
                );
            }
            for ((tier, who, f), reply) in &self.choices {
                let k = match tier {
                    0 => sessions::fork_key(sessions::FORK_SESSION, Some(*who), *f),
                    1 => sessions::fork_key(sessions::FORK_USER, Some(*who), *f),
                    _ => sessions::fork_key(sessions::FORK_ANY, None, *f),
                };
                let [r, _, _] = kinds::parse_varints::<3>(&v.get(&k)?.unwrap())?;
                assert_eq!(r, *reply, "choice {tier} {who} {f:?}");
            }
            let n: usize = [
                sessions::FORK_SESSION,
                sessions::FORK_USER,
                sessions::FORK_ANY,
            ]
            .iter()
            .map(|s| {
                let p = key::of(*s);
                v.scan(&p, &key::prefix_end(&p), usize::MAX).unwrap().len()
            })
            .sum();
            assert_eq!(n, self.choices.len(), "choices");
            for m in self.msgs.keys() {
                assert_eq!(
                    chat::itemization(v, *m)?,
                    self.itemized.get(m).cloned(),
                    "itemization of {m}"
                );
            }
            let all = key::of(chat::ITEMIZED);
            assert_eq!(
                v.scan(&all, &key::prefix_end(&all), usize::MAX)?.len(),
                self.itemized.len()
            );
            // Read in pages of 3, the itemized messages are the model's, in id order.
            let mut paged = Vec::new();
            let mut after = None;
            loop {
                let Js::Obj(page) = super::chat_read::itemized(v, after, 3)? else {
                    unreachable!()
                };
                let (Js::Arr(ids), Js::Bool(more)) = (&page[0].1, &page[1].1) else {
                    unreachable!()
                };
                for i in ids {
                    let Js::Big(m) = i else { unreachable!() };
                    paged.push(*m);
                    after = Some(*m);
                }
                if !more {
                    break;
                }
            }
            assert_eq!(paged, self.itemized.keys().copied().collect::<Vec<_>>());
            // Stats: every message here is a character's, so the ones with a parent count.
            let mut total = [0i64; stats::COUNTERS];
            for o in &owners {
                let mut want = [0i64; stats::COUNTERS];
                let mut replies: BTreeMap<u64, i64> = BTreeMap::new();
                for m in self.msgs.values().filter(|m| m.owner == *o) {
                    let t = m.text.clone().unwrap_or_default();
                    want[stats::SIZE as usize] += text(&t).len() as i64
                        + m.values.values().map(|j| text(j).len() as i64).sum::<i64>();
                    if let Some(p) = m.parent {
                        want[stats::CHAR_MSGS as usize] += 1;
                        want[stats::CHAR_WORDS as usize] += stats::count_words(&text(&t));
                        want[stats::GEN_UNKNOWN as usize] += 1;
                        *replies.entry(p).or_default() += 1;
                    }
                }
                want[stats::SWIPES as usize] = replies.values().map(|n| (n - 1).max(0)).sum();
                let got = stats::owner_stats(v, *o)?;
                assert_eq!(got.counters, want, "stats of {o}");
                assert_eq!(
                    got.last_at,
                    self.msgs
                        .values()
                        .filter(|m| m.owner == *o)
                        .map(|m| m.time)
                        .max(),
                    "last chat of {o}"
                );
                for i in 0..stats::COUNTERS {
                    total[i] += want[i];
                }
            }
            assert_eq!(stats::total_stats(v)?.counters, total, "total stats");
            let next = v.get(&key::of(key::NEXT_MESSAGE))?;
            assert_eq!(
                next.map(|b| library::parse_uvarint(&b).unwrap()),
                (self.next_msg > 0).then_some(self.next_msg)
            );
            Ok(())
        })
        .unwrap();
    }
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
        self.next() % n.max(1)
    }
}

/// An append, through `session` when given (it moves there and chooses it).
#[allow(clippy::too_many_arguments)]
fn append(
    model: &mut Model,
    owner: u64,
    parent: Option<u64>,
    time: i64,
    t: &str,
    sk: Option<Vec<u8>>,
    session: Option<u64>,
    user: u64,
) -> Record {
    let id = model.next_msg;
    model.next_msg += 1;
    if let Some(p) = parent {
        for b in model.bookmarks.values_mut() {
            if b.at == p && b.mode == FOLLOWING {
                b.at = id;
            }
        }
    }
    model.msgs.insert(
        id,
        Msg {
            owner,
            parent,
            time,
            text: Some(t.to_string()),
            values: BTreeMap::new(),
            times: BTreeMap::new(),
            send_key: sk.clone(),
        },
    );
    if let Some(s) = session {
        model.moved(s, user, owner, Some(id), true);
        model.choose(s, user, fork_of(parent, owner), id);
    }
    rec(
        "messageAppend",
        vec![
            Value::Id(id),
            opt(parent),
            Value::Id(owner),
            Value::Absent,
            Value::Absent,
            Value::Time(time),
            Value::Text(text(t)),
            Value::UInt(0),
            opt(session),
            Value::Id(user),
            sk.map_or(Value::Absent, Value::Bytes),
        ],
    )
}

/// One step of a deterministic chat workload, as one commit (or none when nothing fits).
fn step(model: &mut Model, rng: &mut Rng, i: u64) -> Vec<Record> {
    let ids: Vec<u64> = model.msgs.keys().copied().collect();
    let pick = |rng: &mut Rng| ids[rng.below(ids.len() as u64) as usize];
    let time = 1_700_000_000_000 + (i as i64) * 1000 - (rng.below(3) as i64) * 500;
    let owner = 1 + rng.below(3);
    let session = 1 + rng.below(SESSIONS);
    let user = 1 + rng.below(USERS);
    let through = (rng.below(3) > 0).then_some(session);
    let actor = |rng: &mut Rng| {
        if rng.below(2) == 0 {
            (Value::Id(session), Value::Id(user))
        } else {
            (Value::Absent, Value::Absent)
        }
    };
    match rng.below(18) {
        _ if ids.is_empty() => vec![append(
            model,
            owner,
            None,
            time,
            &format!("opening {i}"),
            None,
            through,
            user,
        )],
        0 => vec![append(
            model,
            owner,
            None,
            time,
            &format!("opening {i}"),
            None,
            through,
            user,
        )],
        1..=4 => {
            let p = pick(rng);
            let o = model.msgs[&p].owner;
            let sk = i.is_multiple_of(3).then(|| i.to_le_bytes().to_vec());
            vec![append(
                model,
                o,
                Some(p),
                time,
                &format!("reply {i} to {p} ünï"),
                sk,
                through,
                user,
            )]
        }
        5 => {
            let m = pick(rng);
            let (sv, uv) = actor(rng);
            if let Value::Id(s) = sv {
                let tree = model.msgs[&m].owner;
                model.act(s, tree);
            }
            let msg = model.msgs.get_mut(&m).unwrap();
            match &mut msg.text {
                Some(t) if !t.is_empty() && !i.is_multiple_of(4) => {
                    let at = t.find(' ').unwrap_or(0);
                    t.replace_range(at..at, " edited");
                    vec![rec(
                        "textEdit",
                        vec![
                            Value::Sel(1, m),
                            Value::Field(MES_F),
                            Value::UInt(at as u64),
                            Value::UInt(0),
                            Value::Text(text(" edited")),
                            sv,
                            uv,
                        ],
                    )]
                }
                _ => {
                    msg.text = Some(format!("rewritten {i}"));
                    vec![rec(
                        "textValue",
                        vec![
                            Value::Sel(1, m),
                            Value::Field(MES_F),
                            Value::Text(text(&format!("rewritten {i}"))),
                            sv,
                            uv,
                        ],
                    )]
                }
            }
        }
        6 => {
            let m = pick(rng);
            let k = format!("extra.k{}", i % 3);
            let json = format!("{{\"n\":{i}}}");
            let msg = model.msgs.get_mut(&m).unwrap();
            msg.times.remove(&k);
            msg.values.insert(k.clone(), json.clone());
            vec![rec(
                "jsonValue",
                vec![
                    Value::Sel(1, m),
                    Value::Field(FieldRef::Key(k.into_bytes())),
                    Value::Text(text(&json)),
                    Value::Absent,
                    Value::Absent,
                ],
            )]
        }
        7 => {
            let m = pick(rng);
            let k = format!("extra.k{}", i % 3);
            let msg = model.msgs.get_mut(&m).unwrap();
            msg.values.remove(&k);
            msg.times.insert(k.clone(), -(i as i64));
            vec![rec(
                "messageTime",
                vec![
                    Value::Id(m),
                    Value::Field(FieldRef::Key(k.into_bytes())),
                    Value::Int(-(i as i64)),
                    Value::Absent,
                    Value::Absent,
                ],
            )]
        }
        8 => {
            // A message nothing replies to and no bookmark is at goes.
            let leaves: Vec<u64> = ids
                .iter()
                .copied()
                .filter(|m| {
                    !model.msgs.values().any(|x| x.parent == Some(*m))
                        && !model.bookmarks.values().any(|b| b.at == *m)
                })
                .collect();
            if leaves.is_empty() {
                return Vec::new();
            }
            let m = leaves[rng.below(leaves.len() as u64) as usize];
            let tree = model.msgs[&m].owner;
            let (sv, uv) = actor(rng);
            if let Value::Id(s) = sv {
                model.act(s, tree);
            }
            model.message_gone(m);
            vec![rec("messageDelete", vec![Value::Id(m), sv, uv])]
        }
        9 => {
            let m = pick(rng);
            let o = model.msgs[&m].owner;
            let cands: Vec<u64> = ids
                .iter()
                .copied()
                .filter(|p| model.msgs[p].owner == o && !model.below(*p, m))
                .collect();
            let new = if cands.is_empty() || rng.below(4) == 0 {
                None
            } else {
                Some(cands[rng.below(cands.len() as u64) as usize])
            };
            model.msgs.get_mut(&m).unwrap().parent = new;
            vec![rec(
                "messageParent",
                vec![Value::Id(m), opt(new), Value::Absent, Value::Absent],
            )]
        }
        10 => {
            let m = pick(rng);
            let b = model.next_pos;
            model.next_pos += 1;
            let mode = if i.is_multiple_of(2) {
                FOLLOWING
            } else {
                PINNED
            };
            model.bookmarks.insert(
                b,
                Bookmark {
                    at: m,
                    created_at: m,
                    mode,
                    name: None,
                },
            );
            model.branches.entry(m).or_default().push(b);
            let tree = model.msgs[&m].owner;
            model.act(session, tree);
            vec![rec(
                "positionCreate",
                vec![
                    Value::Id(b),
                    Value::UInt(mode),
                    Value::Id(session),
                    Value::Id(user),
                    Value::Id(m),
                ],
            )]
        }
        11 if !model.bookmarks.is_empty() => {
            let bs: Vec<u64> = model.bookmarks.keys().copied().collect();
            let b = bs[rng.below(bs.len() as u64) as usize];
            match rng.below(3) {
                0 => {
                    let name = (!i.is_multiple_of(4)).then(|| format!("bookmark {i}"));
                    model.bookmarks.get_mut(&b).unwrap().name = name.clone();
                    vec![rec(
                        "positionName",
                        vec![
                            Value::Id(b),
                            name.map_or(Value::Absent, |n| Value::Text(text(&n))),
                        ],
                    )]
                }
                1 => {
                    let bm = model.bookmarks.get_mut(&b).unwrap();
                    bm.mode = if bm.mode == FOLLOWING {
                        PINNED
                    } else {
                        FOLLOWING
                    };
                    vec![rec(
                        "positionMode",
                        vec![Value::Id(b), Value::UInt(bm.mode)],
                    )]
                }
                _ => {
                    let bm = model.bookmarks.remove(&b).unwrap();
                    if let Some(l) = model.branches.get_mut(&bm.created_at) {
                        l.retain(|x| *x != b);
                        if l.is_empty() {
                            model.branches.remove(&bm.created_at);
                        }
                    }
                    vec![rec("positionDelete", vec![Value::Id(b)])]
                }
            }
        }
        12 => {
            let m = pick(rng);
            if model
                .keys
                .iter()
                .any(|((sp, _), v)| *sp == chat::KEYED_MESSAGE && *v == m)
            {
                return Vec::new();
            }
            let k = format!("old-{m}").into_bytes();
            model.keys.insert((chat::KEYED_MESSAGE, k.clone()), m);
            vec![rec(
                "keyMap",
                vec![Value::Sel(chat::KEYED_MESSAGE, m), Value::Bytes(k)],
            )]
        }
        13 | 14 if rng.below(5) == 0 => {
            let back = rng.below(3) > 0;
            let Some((n, _)) = model.step_target(session, back) else {
                return Vec::new();
            };
            model.stepped(session, user, n);
            vec![rec(
                "historyStep",
                vec![Value::Id(session), Value::Id(user), Value::UInt(n)],
            )]
        }
        13 | 14 if rng.below(6) == 0 => {
            let index = rng.below(4);
            model.act(session, owner);
            model
                .sessions
                .entry(session)
                .or_default()
                .openings
                .insert(owner, index);
            vec![rec(
                "openingChoice",
                vec![
                    Value::Id(session),
                    Value::Id(user),
                    Value::Id(owner),
                    Value::UInt(index),
                ],
            )]
        }
        13 | 14 if rng.below(4) == 0 => {
            model.moved(session, user, owner, None, false);
            vec![rec(
                "pointerRoot",
                vec![Value::Id(session), Value::Id(user), Value::Id(owner)],
            )]
        }
        13 | 14 => {
            let m = pick(rng);
            let tree = model.msgs[&m].owner;
            model.moved(session, user, tree, Some(m), false);
            vec![rec(
                "pointerMove",
                vec![Value::Id(session), Value::Id(user), Value::Id(m)],
            )]
        }
        15 => {
            let r = pick(rng);
            let (parent, tree) = (model.msgs[&r].parent, model.msgs[&r].owner);
            model.choose(session, user, fork_of(parent, tree), r);
            model.act(session, tree);
            vec![rec(
                "forkSelection",
                vec![
                    opt(parent),
                    Value::Id(r),
                    Value::Id(session),
                    Value::Id(user),
                ],
            )]
        }
        17 => {
            let m = pick(rng);
            if rng.below(4) == 0 {
                model.itemized.remove(&m);
                vec![rec(
                    "itemization",
                    vec![Value::Id(m), Value::Bit(false), Value::Absent],
                )]
            } else {
                let data = format!("zstd bytes of {i}").into_bytes();
                let raw = i.is_multiple_of(2);
                model.itemized.insert(m, (raw, data.clone()));
                vec![rec(
                    "itemization",
                    vec![Value::Id(m), Value::Bit(raw), Value::Bytes(data)],
                )]
            }
        }
        16 if i.is_multiple_of(3) => {
            let m = pick(rng);
            let tree = model.msgs[&m].owner;
            let (sv, uv) = actor(rng);
            if let Value::Id(s) = sv {
                model.act(s, tree);
            }
            model.subtree_gone(m);
            vec![rec("subtreeDelete", vec![Value::Id(m), sv, uv])]
        }
        16 if i.is_multiple_of(5) && model.sessions.contains_key(&session) => {
            // The session goes, and the test's tab takes up a new session with the same number.
            model.session_gone(session);
            let k = format!("session-{session}-{i}").into_bytes();
            model.keys.insert((chat::KEYED_SESSION, k.clone()), session);
            vec![
                rec("positionDelete", vec![Value::Id(session)]),
                rec(
                    "keyMap",
                    vec![Value::Sel(chat::KEYED_SESSION, session), Value::Bytes(k)],
                ),
            ]
        }
        _ => {
            let m = pick(rng);
            let msg = model.msgs.get_mut(&m).unwrap();
            if msg.values.is_empty() {
                return Vec::new();
            }
            let k = msg.values.keys().next().unwrap().clone();
            msg.values.remove(&k);
            vec![rec(
                "valueDelete",
                vec![
                    Value::Sel(1, m),
                    Value::Field(FieldRef::Key(k.into_bytes())),
                    Value::Absent,
                    Value::Absent,
                ],
            )]
        }
    }
}

fn workload(s: &Store, model: &mut Model, rng: &mut Rng, from: u64, n: u64) {
    for i in from..from + n {
        let recs = step(model, rng, i);
        if !recs.is_empty() {
            s.commit_wait(recs).unwrap();
        }
    }
}

fn open_with_actors(dir: &std::path::Path) -> (Store, Model) {
    let s = Store::open_in(dir, SMALL, small_pool()).unwrap();
    s.commit_wait(actors()).unwrap();
    (s, Model::new())
}

#[test]
fn chat_structures_follow_commits_reopens_crashes_and_cleaning() {
    let dir = temp_dir("follow");
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let (s, mut model) = open_with_actors(&dir);
    workload(&s, &mut model, &mut rng, 0, 1500);
    model.check(&s);
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
    // As a crash would leave it.
    workload(&s, &mut model, &mut rng, 1500, 400);
    s.abandon();
    std::mem::forget(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
    workload(&s, &mut model, &mut rng, 1900, 1000);
    // Values written over and over leave the files they were first in mostly dead.
    let ids: Vec<u64> = model.msgs.keys().copied().take(5).collect();
    for i in 0..4000u64 {
        let m = ids[(i % 5) as usize];
        if !model.msgs.contains_key(&m) {
            continue;
        }
        let json = format!("{{\"v\":\"{}\"}}", "x".repeat((i % 40) as usize));
        let msg = model.msgs.get_mut(&m).unwrap();
        msg.times.remove("extra.k0");
        msg.values.insert("extra.k0".into(), json.clone());
        s.commit_wait(vec![rec(
            "jsonValue",
            vec![
                Value::Sel(1, m),
                Value::Field(FieldRef::Key(b"extra.k0".to_vec())),
                Value::Text(text(&json)),
                Value::Absent,
                Value::Absent,
            ],
        )])
        .unwrap();
        // Live records among them, so cleaning copies messages, values, positions, moves and choices.
        if i % 40 == 0 {
            let recs = step(&mut model, &mut rng, 5000 + i);
            if !recs.is_empty() {
                s.commit_wait(recs).unwrap();
            }
        }
    }
    for _ in 0..20 {
        s.inner.ks.freeze_at(s.durable_end());
        s.inner.ks.wait_flushed().unwrap();
        s.wake_cleaner();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let st = s.stats();
    assert!(st.cleaned_files > 0 && st.relocated_records > 0, "{st:?}");
    model.check(&s);
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_large_moved_subtree_gets_its_depths_in_slices_marked_meanwhile() {
    let dir = temp_dir("depth");
    let (s, mut model) = open_with_actors(&dir);
    // A chain longer than a slice, under one opening, and a second opening to move it under a new parent.
    let n = (sessions::DEPTH_SLICE * 3) as u64;
    let mut recs = vec![append(&mut model, 1, None, 0, "root", None, None, 1)];
    for i in 1..n {
        recs.push(append(
            &mut model,
            1,
            Some(i - 1),
            i as i64,
            "x",
            None,
            None,
            1,
        ));
    }
    recs.push(append(
        &mut model, 1, None, n as i64, "other", None, None, 1,
    ));
    s.commit_wait(recs).unwrap();
    s.commit_wait(vec![rec(
        "pointerMove",
        vec![Value::Id(1), Value::Id(1), Value::Id(n - 1)],
    )])
    .unwrap();
    model.moved(1, 1, 1, Some(n - 1), false);
    model.check(&s);
    // Move message 1 (and the chain below it) under the second opening: every depth below it goes up by one.
    model.msgs.get_mut(&1).unwrap().parent = Some(n);
    s.commit_wait(vec![rec(
        "messageParent",
        vec![Value::Id(1), Value::Id(n), Value::Absent, Value::Absent],
    )])
    .unwrap();
    // Meanwhile a reply under the chain, and a second move in the same tree, queue behind it.
    s.commit_wait(vec![append(
        &mut model,
        1,
        Some(n - 1),
        n as i64 + 1,
        "late",
        None,
        None,
        1,
    )])
    .unwrap();
    model.msgs.get_mut(&5).unwrap().parent = Some(0);
    s.commit_wait(vec![rec(
        "messageParent",
        vec![Value::Id(5), Value::Id(0), Value::Absent, Value::Absent],
    )])
    .unwrap();
    model.check(&s);
    assert_eq!(
        s.derived(|v| sessions::message_count(v, 1, Some(n - 1)))
            .unwrap(),
        (model.depth(n - 1), false)
    );
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_depth_rewrite_cut_off_by_a_crash_resumes_on_open() {
    let dir = temp_dir("depth-crash");
    let (s, mut model) = open_with_actors(&dir);
    let n = (sessions::DEPTH_SLICE * 4) as u64;
    let mut recs = vec![append(&mut model, 1, None, 0, "root", None, None, 1)];
    for i in 1..n {
        recs.push(append(
            &mut model,
            1,
            Some(i - 1),
            i as i64,
            "x",
            None,
            None,
            1,
        ));
    }
    recs.push(append(
        &mut model, 1, None, n as i64, "other", None, None, 1,
    ));
    s.commit_wait(recs).unwrap();
    model.msgs.get_mut(&1).unwrap().parent = Some(n);
    // Committed through the store's inner path, so no slice is queued: as a crash right after the move.
    let done = std::sync::mpsc::channel();
    let tx = done.0;
    s.inner.submit(Job::Commit(
        vec![rec(
            "messageParent",
            vec![Value::Id(1), Value::Id(n), Value::Absent, Value::Absent],
        )],
        Box::new(move |r| {
            let _ = tx.send(r.map(|_| ()));
        }),
    ));
    done.1.recv().unwrap().unwrap();
    assert!(
        s.derived(|v| sessions::message_count(v, 1, Some(n - 1)))
            .unwrap()
            .1
    );
    s.abandon();
    std::mem::forget(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn deleting_messages_and_sessions_moves_what_named_them() {
    let dir = temp_dir("gone");
    let (s, mut model) = open_with_actors(&dir);
    // Two openings; session 1 shows a reply to the first, session 2 the second opening; user 1 moved through both.
    let recs = vec![
        append(&mut model, 7, None, 1, "a", None, None, 1),
        append(&mut model, 7, None, 2, "b", None, Some(2), 1),
        append(&mut model, 7, Some(0), 3, "a1", None, Some(1), 1),
    ];
    s.commit_wait(recs).unwrap();
    model.check(&s);
    // The reply goes: session 1 moves to its parent; its history keeps the entry, marked gone.
    model.message_gone(2);
    s.commit_wait(vec![rec(
        "messageDelete",
        vec![Value::Id(2), Value::Id(1), Value::Id(1)],
    )])
    .unwrap();
    model.act(1, 7);
    model.check(&s);
    assert_eq!(
        s.derived(|v| sessions::session_pointer(v, 1)).unwrap(),
        Some((7, Some(0)))
    );
    // An opening another session shows goes: that session moves to the newest other opening; the last opening
    // going leaves pointers at the tree's root.
    model.message_gone(1);
    s.commit_wait(vec![rec(
        "messageDelete",
        vec![Value::Id(1), Value::Absent, Value::Absent],
    )])
    .unwrap();
    model.check(&s);
    assert_eq!(
        s.derived(|v| sessions::session_pointer(v, 2)).unwrap(),
        Some((7, Some(0)))
    );
    model.message_gone(0);
    s.commit_wait(vec![rec(
        "messageDelete",
        vec![Value::Id(0), Value::Absent, Value::Absent],
    )])
    .unwrap();
    model.check(&s);
    assert_eq!(
        s.derived(|v| sessions::session_pointer(v, 1)).unwrap(),
        Some((7, None))
    );
    assert_eq!(
        s.derived(|v| sessions::landing(v, Some(1), Some(1), 7))
            .unwrap(),
        None
    );
    // A session goes: user 1's last session in the tree falls back to their other one.
    let recs = vec![
        append(&mut model, 7, None, 10, "c", None, Some(1), 1),
        append(&mut model, 7, Some(3), 11, "c1", None, Some(2), 1),
    ];
    s.commit_wait(recs).unwrap();
    assert_eq!(
        s.derived(|v| sessions::user_in_tree(v, 1, 7)).unwrap(),
        Some((2, Some(4)))
    );
    model.session_gone(2);
    s.commit_wait(vec![rec("positionDelete", vec![Value::Id(2)])])
        .unwrap();
    model.check(&s);
    assert_eq!(
        s.derived(|v| sessions::user_in_tree(v, 1, 7)).unwrap(),
        Some((1, Some(3)))
    );
    model.session_gone(1);
    s.commit_wait(vec![rec("positionDelete", vec![Value::Id(1)])])
        .unwrap();
    model.check(&s);
    assert_eq!(
        s.derived(|v| sessions::user_in_tree(v, 1, 7)).unwrap(),
        None
    );
    // Its UUID is a tombstone, naming nothing; its own choices went and the user's stayed; it can't move until it
    // is a session again.
    assert_eq!(
        s.derived(|v| chat::id_by_key(v, chat::KEYED_SESSION, b"session-1"))
            .unwrap(),
        None
    );
    assert_eq!(
        s.derived(|v| chat::key_state(v, chat::KEYED_SESSION, b"session-1"))
            .unwrap(),
        chat::KeyState::Gone
    );
    s.derived(|v| {
        let f = Fork::Root(7);
        assert!(
            v.get(&sessions::fork_key(sessions::FORK_SESSION, Some(1), f))?
                .is_none()
        );
        assert!(
            v.get(&sessions::fork_key(sessions::FORK_USER, Some(1), f))?
                .is_some()
        );
        assert!(
            v.get(&sessions::fork_key(sessions::FORK_ANY, None, f))?
                .is_some()
        );
        Ok(())
    })
    .unwrap();
    assert!(matches!(
        s.commit_wait(vec![rec(
            "pointerMove",
            vec![Value::Id(1), Value::Id(1), Value::Id(3)]
        )]),
        Err(StoreError::Refused(_))
    ));
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_bookmark_outliving_the_message_it_was_made_at_leaves_nothing_when_it_goes() {
    let dir = temp_dir("stray");
    let (s, mut model) = open_with_actors(&dir);
    // A following bookmark made at 0 moves to the reply 1; 1 moves under the other opening 2, so 0 can go while
    // the bookmark lives on.
    let recs = vec![
        append(&mut model, 1, None, 1, "a", None, None, 1),
        append(&mut model, 1, None, 2, "b", None, None, 1),
    ];
    s.commit_wait(recs).unwrap();
    s.commit_wait(vec![rec(
        "positionCreate",
        vec![
            Value::Id(9),
            Value::UInt(FOLLOWING),
            Value::Id(1),
            Value::Id(1),
            Value::Id(0),
        ],
    )])
    .unwrap();
    let reply = append(&mut model, 1, Some(0), 3, "a1", None, None, 1);
    s.commit_wait(vec![reply]).unwrap();
    s.commit_wait(vec![rec(
        "messageParent",
        vec![Value::Id(2), Value::Id(1), Value::Absent, Value::Absent],
    )])
    .unwrap();
    s.commit_wait(vec![rec(
        "messageDelete",
        vec![Value::Id(0), Value::Absent, Value::Absent],
    )])
    .unwrap();
    s.commit_wait(vec![rec("positionDelete", vec![Value::Id(9)])])
        .unwrap();
    s.derived(|v| {
        assert_eq!(v.get(&key::id(chat::SHAPE, 0))?, None, "a stray shape of 0");
        let p = key::id(sessions::BRANCH_FROM, 0);
        assert!(v.scan(&p, &key::prefix_end(&p), usize::MAX)?.is_empty());
        Ok(())
    })
    .unwrap();
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn chat_writes_that_cant_apply_are_refused_and_write_nothing() {
    let dir = temp_dir("refuse");
    let (s, mut model) = open_with_actors(&dir);
    let a = append(&mut model, 1, None, 10, "a", Some(vec![1; 16]), Some(1), 1);
    let b = append(&mut model, 1, Some(0), 11, "b", None, None, 1);
    let c = append(&mut model, 2, None, 12, "c", None, None, 1);
    s.commit_wait(vec![a, b, c]).unwrap();
    let end = s.durable_end();
    let next = |parent: Option<u64>, sk: Option<Vec<u8>>| {
        append(&mut model.clone(), 1, parent, 13, "x", sk, None, 1)
    };
    let mut taken = next(None, None);
    taken.values[0] = Value::Id(0);
    let mut stranger = next(None, None);
    stranger.values[9] = Value::Id(99);
    let mut no_session = next(None, None);
    no_session.values[8] = Value::Id(50);
    for bad in [
        // The id is taken; the parent is in another tree; no such parent; the send key is stored; no such user;
        // no such session.
        vec![taken],
        vec![next(Some(2), None)],
        vec![next(Some(77), None)],
        vec![next(Some(1), Some(vec![1; 16]))],
        vec![stranger],
        vec![no_session],
        // A message with replies doesn't go; a move below itself or into another tree is refused.
        vec![rec(
            "messageDelete",
            vec![Value::Id(0), Value::Absent, Value::Absent],
        )],
        vec![rec(
            "messageParent",
            vec![Value::Id(0), Value::Id(1), Value::Absent, Value::Absent],
        )],
        vec![rec(
            "messageParent",
            vec![Value::Id(1), Value::Id(2), Value::Absent, Value::Absent],
        )],
        // Values of a message that doesn't exist; a bookmark at one; a mode that isn't one; a name of nothing.
        vec![rec(
            "textValue",
            vec![
                Value::Sel(1, 50),
                Value::Field(MES_F),
                Value::Text(text("x")),
                Value::Absent,
                Value::Absent,
            ],
        )],
        vec![rec(
            "jsonValue",
            vec![
                Value::Sel(1, 50),
                Value::Field(MES_F),
                Value::Text(text("1")),
                Value::Absent,
                Value::Absent,
            ],
        )],
        vec![rec(
            "positionCreate",
            vec![
                Value::Id(9),
                Value::UInt(1),
                Value::Id(1),
                Value::Id(1),
                Value::Id(50),
            ],
        )],
        vec![rec(
            "positionCreate",
            vec![
                Value::Id(9),
                Value::UInt(3),
                Value::Id(1),
                Value::Id(1),
                Value::Id(1),
            ],
        )],
        vec![rec(
            "positionName",
            vec![Value::Id(9), Value::Text(text("n"))],
        )],
        // A move of a session that isn't one; a choice of a reply at another fork.
        vec![rec(
            "pointerMove",
            vec![Value::Id(9), Value::Id(1), Value::Id(1)],
        )],
        vec![rec(
            "forkSelection",
            vec![Value::Id(2), Value::Id(1), Value::Id(1), Value::Id(1)],
        )],
        vec![rec(
            "forkSelection",
            vec![Value::Absent, Value::Id(1), Value::Id(1), Value::Id(1)],
        )],
    ] {
        let r = s.commit_wait(bad);
        assert!(matches!(r, Err(StoreError::Refused(_))), "{r:?}");
    }
    assert_eq!(s.durable_end(), end);
    // A key names one id, and an id has one key.
    for bad in [
        rec(
            "keyMap",
            vec![Value::Sel(1, 6), Value::Bytes(b"session-1".to_vec())],
        ),
        rec(
            "keyMap",
            vec![Value::Sel(1, 1), Value::Bytes(b"other".to_vec())],
        ),
        // A session isn't a bookmark.
        rec(
            "positionCreate",
            vec![
                Value::Id(1),
                Value::UInt(1),
                Value::Id(1),
                Value::Id(1),
                Value::Id(1),
            ],
        ),
    ] {
        assert!(matches!(
            s.commit_wait(vec![bad]),
            Err(StoreError::Refused(_))
        ));
    }
    // A bookmark at a message keeps it from going.
    s.commit_wait(vec![rec(
        "positionCreate",
        vec![
            Value::Id(9),
            Value::UInt(2),
            Value::Id(1),
            Value::Id(1),
            Value::Id(1),
        ],
    )])
    .unwrap();
    model.bookmarks.insert(
        9,
        Bookmark {
            at: 1,
            created_at: 1,
            mode: PINNED,
            name: None,
        },
    );
    model.branches.entry(1).or_default().push(9);
    model.act(1, 1);
    assert!(matches!(
        s.commit_wait(vec![rec(
            "messageDelete",
            vec![Value::Id(1), Value::Absent, Value::Absent]
        )]),
        Err(StoreError::Refused(_))
    ));
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_message_text_lives_in_its_append_until_replaced_and_its_search_follows() {
    let dir = temp_dir("text");
    let (s, mut model) = open_with_actors(&dir);
    s.commit_wait(vec![append(
        &mut model,
        4,
        None,
        1,
        "hello brave world",
        None,
        None,
        1,
    )])
    .unwrap();
    let edit = |off: u64, removed: u64, t: &str| {
        rec(
            "textEdit",
            vec![
                Value::Sel(1, 0),
                Value::Field(MES_F),
                Value::UInt(off),
                Value::UInt(removed),
                Value::Text(text(t)),
                Value::Absent,
                Value::Absent,
            ],
        )
    };
    s.commit_wait(vec![edit(6, 5, "bold")]).unwrap();
    let t = s
        .derived(|v| text_value_of(v, Holder::Message(0), &MES_F))
        .unwrap();
    assert_eq!(t, Some(text("hello bold world")));
    let append_pos = s.derived(|v| chat::message_loc(v, 0)).unwrap().unwrap().pos;
    let file = kinds::file_of(append_pos);
    let dead = |s: &Store| {
        s.derived(|v| v.get(&key::id(key::DEAD, file)))
            .unwrap()
            .and_then(|b| crate::keyspace::val::counter_value(&b))
            .unwrap_or(0)
    };
    let before = dead(&s);
    s.commit_wait(vec![rec(
        "textValue",
        vec![
            Value::Sel(1, 0),
            Value::Field(MES_F),
            Value::Text(text("new")),
            Value::Absent,
            Value::Absent,
        ],
    )])
    .unwrap();
    // The edit died; the append, which still holds the message, didn't.
    assert!(dead(&s) > before);
    assert_eq!(
        s.derived(|v| chat::message_loc(v, 0)).unwrap().unwrap().pos,
        append_pos
    );
    s.derived(|v| {
        assert_eq!(
            kinds::search_texts(v, Scope::chat(4), 0, 0)?,
            vec![text("new")]
        );
        assert!(kinds::search_texts(v, Scope::chat(5), 0, 0)?.is_empty());
        Ok(())
    })
    .unwrap();
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn chat_records_round_trip_their_bytes() {
    // A message's id after its parent's costs one byte.
    let k = kind_by_name("messageAppend").unwrap();
    let r = Record::new(
        k,
        vec![
            Value::Id(1_000_001),
            Value::Id(1_000_000),
            Value::Id(7),
            Value::Absent,
            Value::Absent,
            Value::Time(1_700_000_000_123),
            Value::Text(text("hi")),
            Value::UInt(1),
            Value::Id(3),
            Value::Id(1),
            Value::Absent,
        ],
    )
    .unwrap();
    let mut ctx = crate::log::format::Ctx::default();
    let mut buf = Vec::new();
    crate::log::format::encode(&r, &mut ctx, &mut buf);
    let first = buf.len();
    let mut r2 = r.clone();
    r2.values[0] = Value::Id(1_000_002);
    r2.values[1] = Value::Id(1_000_001);
    r2.values[5] = Value::Time(1_700_000_001_000);
    crate::log::format::encode(&r2, &mut ctx, &mut buf);
    // header 1, id 1, parent 1, owner 1, time 2, text 3, flags 1, session 1, user 1.
    assert_eq!(buf.len() - first, 12);
    let mut ctx = crate::log::format::Ctx::default();
    let mut at = 0;
    for want in [&r, &r2] {
        let h = crate::log::format::get_uvarint(&buf, &mut at).unwrap();
        let (k, bits) = crate::log::format::kind_by_header(h).unwrap();
        assert_eq!(
            &crate::log::format::decode_body(k, bits, &buf, &mut at, &mut ctx).unwrap(),
            want
        );
    }
}

/// A message append with the given flags and name, through no session.
fn append_with(
    id: u64,
    parent: Option<u64>,
    owner: u64,
    time: i64,
    t: &str,
    flags: u64,
    name: Option<&str>,
) -> Record {
    rec(
        "messageAppend",
        vec![
            Value::Id(id),
            opt(parent),
            Value::Id(owner),
            Value::Absent,
            name.map_or(Value::Absent, |n| Value::Text(text(n))),
            Value::Time(time),
            Value::Text(text(t)),
            Value::UInt(flags),
            Value::Absent,
            Value::Id(1),
            Value::Absent,
        ],
    )
}

fn msg_time(m: u64, code: u64, delta: i64) -> Record {
    rec(
        "messageTime",
        vec![
            Value::Id(m),
            Value::Field(FieldRef::Code(code)),
            Value::Int(delta),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn msg_json(m: u64, code: u64, json: &str) -> Record {
    rec(
        "jsonValue",
        vec![
            Value::Sel(1, m),
            Value::Field(FieldRef::Code(code)),
            Value::Text(text(json)),
            Value::Absent,
            Value::Absent,
        ],
    )
}

#[test]
fn stats_count_as_today_and_place_the_owner_in_the_library() {
    let dir = temp_dir("stats");
    let (s, _) = open_with_actors(&dir);
    // Two characters in the library, so the stats place them in the last-chat and chat-size orders.
    let chars: Vec<Record> = [(500, "a.png"), (501, "b.png")]
        .iter()
        .map(|(e, k)| {
            rec(
                "entityCreate",
                vec![
                    Value::Id(*e),
                    Value::UInt(0),
                    Value::Text(text(k)),
                    Value::Time(0),
                ],
            )
        })
        .collect();
    s.commit_wait(chars).unwrap();
    // Send dates are their own values unless said; no `is_system` unless said.
    const USER: u64 = 1;
    const SYSTEM: u64 = 2 << chat::FLAG_IS_SYSTEM;
    const OTHER_USER: u64 = 3;
    const NO_SEND_DATE: u64 = 3 << chat::FLAG_SEND_DATE;
    let t0 = 1_700_000_000_000;
    s.commit_wait(vec![
        // A greeting (doesn't count), two replies to it (one swipe), a user message whose send date is its time,
        // one whose send date is another ISO time, one with an unreadable send date, one with none, a system
        // message, and a message whose `is_user` is a truthy JSON value.
        append_with(0, None, 500, t0, "Hello there", 0, None),
        append_with(1, Some(0), 500, t0 + 1, "one two", 0, Some("Not the name")),
        append_with(2, Some(0), 500, t0 + 2, "three", 0, None),
        msg_time(2, chat::GEN_STARTED, 0),
        msg_time(2, chat::GEN_FINISHED, 1500),
        append_with(
            3,
            Some(1),
            500,
            t0 + 3,
            "u1 w",
            USER | (2 << chat::FLAG_SEND_DATE),
            None,
        ),
        append_with(4, Some(3), 500, t0 + 4, "u2", USER, None),
        msg_time(4, chat::SEND_DATE, -10_000),
        append_with(5, Some(4), 500, t0 + 5, "u3", USER, None),
        msg_json(5, chat::SEND_DATE, "\"yesterday-ish\""),
        append_with(6, Some(5), 500, t0 + 6, "u4", USER | NO_SEND_DATE, None),
        append_with(7, Some(6), 500, t0 + 7, "sys", SYSTEM, None),
        append_with(8, Some(7), 500, t0 + 8, "odd", OTHER_USER, None),
        msg_json(8, chat::IS_USER, "\"yes\""),
        append_with(9, None, 501, t0 + 100, "b's", 0, None),
    ])
    .unwrap();
    let st = s.derived(|v| stats::owner_stats(v, 500)).unwrap();
    let c = st.counters;
    // User: 3, 4, 5, 6, 8; character: 1, 2 (0 opens the tree, 7 is a system message).
    assert_eq!(c[stats::USER_MSGS as usize], 5);
    assert_eq!(c[stats::USER_WORDS as usize], 2 + 1 + 1 + 1 + 1);
    assert_eq!(c[stats::CHAR_MSGS as usize], 2);
    assert_eq!(c[stats::CHAR_WORDS as usize], 3);
    assert_eq!(c[stats::SWIPES as usize], 1);
    assert_eq!(c[stats::GEN_MS as usize], 1500);
    assert_eq!(c[stats::GEN_UNKNOWN as usize], 1);
    // Message 4's send date is 10 s before its time, the earliest; 5's can't be read, 6 has none.
    assert_eq!(st.first_user_at, Some(t0 + 4 - 10_000));
    assert_eq!(st.last_at, Some(t0 + 8));
    let size: i64 = [
        "Hello there",
        "one two",
        "Not the name",
        "three",
        "u1 w",
        "u2",
        "u3",
        "\"yesterday-ish\"",
        "u4",
        "sys",
        "odd",
        "\"yes\"",
    ]
    .iter()
    .map(|t| t.len() as i64)
    .sum();
    assert_eq!(c[stats::SIZE as usize], size);
    // The writer read message 5's send date as earlier still.
    s.commit_wait(vec![msg_time(5, chat::SEND_AT, -20_000)])
        .unwrap();
    assert_eq!(
        s.derived(|v| stats::owner_stats(v, 500))
            .unwrap()
            .first_user_at,
        Some(t0 + 5 - 20_000)
    );
    // A swipe goes away when its sibling moves elsewhere; a greeting moved under a message starts to count.
    s.commit_wait(vec![rec(
        "messageParent",
        vec![Value::Id(2), Value::Id(8), Value::Absent, Value::Absent],
    )])
    .unwrap();
    let c = s.derived(|v| stats::owner_stats(v, 500)).unwrap().counters;
    assert_eq!(c[stats::SWIPES as usize], 0);
    // Deleting the earliest user message brings the next one up.
    s.commit_wait(vec![rec(
        "messageDelete",
        vec![Value::Id(2), Value::Absent, Value::Absent],
    )])
    .unwrap();
    let st = s.derived(|v| stats::owner_stats(v, 500)).unwrap();
    assert_eq!(st.counters[stats::CHAR_MSGS as usize], 1);
    assert_eq!(st.counters[stats::GEN_UNKNOWN as usize], 1);
    // The library orders the characters by these, as their stored places show.
    s.derived(|v| {
        for (e, last, size) in [
            (500u64, t0 + 8, stats::chat_size(v, 500)?),
            (501, t0 + 100, 3),
        ] {
            let st = library::state(v, e)?.unwrap();
            assert_eq!(
                st.nums[(library::LAST_CHAT - 1) as usize],
                Some(last as f64)
            );
            assert_eq!(
                st.nums[(library::CHAT_SIZE - 1) as usize],
                Some(size as f64)
            );
            for sort in [library::LAST_CHAT, library::CHAT_SIZE] {
                let (kind, sk, tie) = library::sort_place(v, e, sort)?.unwrap();
                let mut k = library::order_prefix(&library::Scope::All, sort, kind, false);
                k.extend_from_slice(&sk);
                crate::keyspace::val::put_bytes(&mut k, &tie);
                assert!(v.get(&k)?.is_some(), "{e} in order {sort}");
            }
        }
        Ok(())
    })
    .unwrap();
    let totals = s.derived(stats::total_stats).unwrap();
    assert_eq!(totals.counters[stats::USER_MSGS as usize], 5);
    // A user message whose flags change to a system message's stops counting.
    s.commit_wait(vec![msg_json(
        3,
        chat::FLAGS,
        &(1 | (2 << chat::FLAG_IS_SYSTEM)).to_string(),
    )])
    .unwrap();
    assert_eq!(
        s.derived(stats::total_stats).unwrap().counters[stats::USER_MSGS as usize],
        4
    );
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn history_steps_move_a_cursor_and_opening_choices_last_until_an_opening_is_chosen() {
    let dir = temp_dir("steps");
    let (s, mut model) = open_with_actors(&dir);
    // Session 1 sends a, b, c in a row (history 1..3), then goes to the root of tree 2 (4).
    let recs = vec![
        append(&mut model, 1, None, 1, "a", None, Some(1), 1),
        append(&mut model, 1, Some(0), 2, "b", None, Some(1), 1),
        append(&mut model, 1, Some(1), 3, "c", None, Some(1), 1),
    ];
    s.commit_wait(recs).unwrap();
    model.moved(1, 1, 2, None, false);
    s.commit_wait(vec![rec(
        "pointerRoot",
        vec![Value::Id(1), Value::Id(1), Value::Id(2)],
    )])
    .unwrap();
    let step = |model: &mut Model, back: bool| {
        let (n, _) = model.step_target(1, back).unwrap();
        model.stepped(1, 1, n);
        s.commit_wait(vec![rec(
            "historyStep",
            vec![Value::Id(1), Value::Id(1), Value::UInt(n)],
        )])
        .unwrap();
        n
    };
    // Back twice goes back step by step, adding no entry; forward comes back.
    assert_eq!(step(&mut model, true), 3);
    assert_eq!(step(&mut model, true), 2);
    assert_eq!(step(&mut model, false), 3);
    model.check(&s);
    assert_eq!(
        s.derived(|v| sessions::history(v, 1, 0, usize::MAX))
            .unwrap()
            .len(),
        4
    );
    assert_eq!(
        s.derived(|v| sessions::session_pointer(v, 1)).unwrap(),
        Some((1, Some(2)))
    );
    // A step to a gone entry is refused; a step skips gone entries.
    model.message_gone(2);
    s.commit_wait(vec![rec(
        "messageDelete",
        vec![Value::Id(2), Value::Absent, Value::Absent],
    )])
    .unwrap();
    assert!(
        s.commit_wait(vec![rec(
            "historyStep",
            vec![Value::Id(1), Value::Id(1), Value::UInt(3)],
        )])
        .is_err()
    );
    model.check(&s);
    assert_eq!(step(&mut model, false), 4);
    assert_eq!(step(&mut model, true), 2);
    // A new move after stepping back appends at the end: forward reaches nothing.
    model.moved(1, 1, 1, Some(0), false);
    s.commit_wait(vec![rec(
        "pointerMove",
        vec![Value::Id(1), Value::Id(1), Value::Id(0)],
    )])
    .unwrap();
    model.check(&s);
    assert_eq!(
        s.derived(|v| sessions::step_target(v, 1, false)).unwrap(),
        None
    );
    assert_eq!(s.derived(|v| sessions::cursor(v, 1)).unwrap(), Some(5));
    // A card greeting chosen for tree 2 stays until the session chooses an opening there.
    model.act(1, 2);
    model.sessions.get_mut(&1).unwrap().openings.insert(2, 3);
    s.commit_wait(vec![rec(
        "openingChoice",
        vec![Value::Id(1), Value::Id(1), Value::Id(2), Value::UInt(3)],
    )])
    .unwrap();
    model.check(&s);
    assert_eq!(
        s.derived(|v| sessions::opening_choice(v, 1, 2)).unwrap(),
        Some(3)
    );
    let recs = vec![append(&mut model, 2, None, 5, "greeting", None, Some(1), 1)];
    s.commit_wait(recs).unwrap();
    model.check(&s);
    assert_eq!(
        s.derived(|v| sessions::opening_choice(v, 1, 2)).unwrap(),
        None
    );
    // The structures survive a reopen.
    drop(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
}

#[test]
fn jump_depths_are_myers_skew_binary_and_reach_any_depth_in_log_steps() {
    // The definition: a message jumps to its parent's jump's jump when the parent's two jumps are equally long,
    // else to its parent.
    let mut j = vec![0u64];
    for n in 1..100_000u64 {
        let p = n - 1;
        let (jp, jjp) = (j[p as usize], j[j[p as usize] as usize]);
        j.push(if p - jp == jp - jjp { jjp } else { p });
        assert_eq!(sessions::jump_depth(n), j[n as usize], "{n}");
    }
    // Reaching depth `d` from depth `v`: jumps that don't pass it, else parent steps.
    let mut most = 0;
    for v in (1..100_000u64).step_by(997) {
        for d in (0..v).step_by(331) {
            let (mut at, mut steps) = (v, 0);
            while at > d {
                steps += 1;
                let jd = sessions::jump_depth(at);
                at = if jd >= d { jd } else { at - 1 };
            }
            most = most.max(steps);
        }
    }
    assert!(most <= 3 * 17, "{most}");
}

/// Commits through the store's inner path, so no slice is queued: as a crash right after the commit would leave it.
fn commit_without_slices(s: &Store, recs: Vec<Record>) {
    let (tx, rx) = std::sync::mpsc::channel();
    s.inner.submit(Job::Commit(
        recs,
        Box::new(move |r| {
            let _ = tx.send(r.map(|_| ()));
        }),
    ));
    rx.recv().unwrap().unwrap();
}

#[test]
fn a_subtree_being_deleted_reads_as_deleted_and_its_delete_resumes_after_a_crash() {
    let dir = temp_dir("prune");
    let (s, mut model) = open_with_actors(&dir);
    // An opening, a reply, and below the reply a chain longer than a slice with a side branch.
    let n = (prune::PRUNE_SLICE * 3) as u64;
    let mut recs = vec![
        append(&mut model, 1, None, 0, "root", None, None, 1),
        append(&mut model, 1, Some(0), 1, "kept reply", None, None, 1),
    ];
    for i in 2..n {
        recs.push(append(
            &mut model,
            1,
            Some(i - 1),
            i as i64,
            &format!("chain saxophone {i}"),
            None,
            None,
            1,
        ));
    }
    let side = append(
        &mut model,
        1,
        Some(5),
        n as i64,
        "side saxophone",
        None,
        None,
        1,
    );
    recs.push(side);
    s.commit_wait(recs).unwrap();
    // Session 1 at the chain's end, session 2 on the side branch; a pinned bookmark in the chain, a following one
    // at the chain's end, one at the kept reply.
    let end = n - 1;
    let side = n;
    s.commit_wait(vec![
        rec(
            "pointerMove",
            vec![Value::Id(1), Value::Id(1), Value::Id(end)],
        ),
        rec(
            "pointerMove",
            vec![Value::Id(2), Value::Id(2), Value::Id(side)],
        ),
        rec(
            "positionCreate",
            vec![
                Value::Id(20),
                Value::UInt(PINNED),
                Value::Id(1),
                Value::Id(1),
                Value::Id(9),
            ],
        ),
        rec(
            "positionCreate",
            vec![
                Value::Id(21),
                Value::UInt(FOLLOWING),
                Value::Id(1),
                Value::Id(1),
                Value::Id(end),
            ],
        ),
        rec(
            "positionName",
            vec![Value::Id(21), Value::Text(text("end"))],
        ),
        rec(
            "positionCreate",
            vec![
                Value::Id(22),
                Value::UInt(PINNED),
                Value::Id(1),
                Value::Id(1),
                Value::Id(1),
            ],
        ),
    ])
    .unwrap();
    model.moved(1, 1, 1, Some(end), false);
    model.moved(2, 2, 1, Some(side), false);
    for (b, mode, at) in [(20, PINNED, 9), (21, FOLLOWING, end), (22, PINNED, 1)] {
        model.bookmarks.insert(
            b,
            Bookmark {
                at,
                created_at: at,
                mode,
                name: None,
            },
        );
        model.branches.entry(at).or_default().push(b);
        model.act(1, 1);
    }
    model.bookmarks.get_mut(&21).unwrap().name = Some("end".into());
    model.check(&s);
    // What the delete drops besides messages: the pinned bookmark in it.
    let (bookmarks, _) = s.derived(|v| prune::drops(v, 1, &[2], &[])).unwrap();
    assert_eq!(bookmarks, vec![(20, 9)]);
    // Everything below the kept reply goes; no slice runs, as after a crash.
    model.subtree_gone(2);
    commit_without_slices(
        &s,
        vec![rec(
            "subtreeDelete",
            vec![Value::Id(2), Value::Id(1), Value::Id(1)],
        )],
    );
    model.act(1, 1);
    s.derived(|v| {
        assert!(prune::any_pending(v)?);
        // The positions inside moved at once: the sessions and the following bookmark to the kept reply.
        assert_eq!(sessions::session_pointer(v, 1)?, Some((1, Some(1))));
        assert_eq!(sessions::session_pointer(v, 2)?, Some((1, Some(1))));
        assert_eq!(chat::bookmark_at(v, 21)?, Some(1));
        assert_eq!(chat::bookmark_at(v, 20)?, None);
        // The subtree reads as deleted: no reply of its parent, a path stops above it, messages read as none.
        assert_eq!(
            sessions::followed(v, None, None, Fork::Message(1), 1)?,
            None
        );
        assert_eq!(chat::path_to(v, Some(end))?, vec![0, 1]);
        assert_eq!(chat::shapes(v, &[1])?[0].replies, 0);
        let Js::Arr(read) = super::chat_read::messages(v, &[1, 2, end, side])? else {
            unreachable!()
        };
        assert!(read[0] != Js::Null && read[1..].iter().all(|m| *m == Js::Null));
        // Search drops its messages; stats say they are estimates.
        let clauses = [crate::search::query::Clause {
            text: text("saxophone"),
            fields: None,
            negate: false,
            quoted: false,
        }];
        let found = chat_search::messages(
            v,
            1,
            &clauses,
            chat_search::Start::Index { after: None },
            50,
            chat_search::SCAN_BYTES,
            &Default::default(),
        )?;
        assert!(
            found.hits.is_empty() && found.scanned.is_empty(),
            "{found:?}"
        );
        let Js::Obj(st) = super::chat_read::chat_stats(v, &[1])? else {
            unreachable!()
        };
        let Js::Arr(owners) = &st[0].1 else {
            unreachable!()
        };
        let Js::Obj(o) = &owners[0] else {
            unreachable!()
        };
        assert_eq!(
            o.iter().find(|(k, _)| *k == "estimate").unwrap().1,
            Js::Bool(true)
        );
        // A step back skips entries inside it.
        assert_eq!(sessions::step_target(v, 1, true)?, None);
        Ok(())
    })
    .unwrap();
    // Writes naming its messages are refused.
    for r in [
        append(
            &mut model.clone(),
            1,
            Some(end),
            9_999,
            "late",
            None,
            None,
            1,
        ),
        rec(
            "pointerMove",
            vec![Value::Id(1), Value::Id(1), Value::Id(5)],
        ),
        rec(
            "positionCreate",
            vec![
                Value::Id(30),
                Value::UInt(PINNED),
                Value::Id(1),
                Value::Id(1),
                Value::Id(5),
            ],
        ),
        rec(
            "forkSelection",
            vec![Value::Id(1), Value::Id(2), Value::Id(1), Value::Id(1)],
        ),
        rec(
            "subtreeDelete",
            vec![Value::Id(7), Value::Absent, Value::Absent],
        ),
        rec(
            "messageDelete",
            vec![Value::Id(side), Value::Absent, Value::Absent],
        ),
        rec(
            "textValue",
            vec![
                Value::Sel(1, 3),
                Value::Field(MES_F),
                Value::Text(text("x")),
                Value::Absent,
                Value::Absent,
            ],
        ),
    ] {
        assert!(matches!(
            s.commit_wait(vec![r]),
            Err(StoreError::Refused(_))
        ));
    }
    // A crash: the delete resumes on open and finishes.
    s.abandon();
    std::mem::forget(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
    s.derived(|v| {
        let Js::Obj(st) = super::chat_read::chat_stats(v, &[1])? else {
            unreachable!()
        };
        let Js::Arr(owners) = &st[0].1 else {
            unreachable!()
        };
        let Js::Obj(o) = &owners[0] else {
            unreachable!()
        };
        assert_eq!(
            o.iter().find(|(k, _)| *k == "estimate").unwrap().1,
            Js::Bool(false)
        );
        Ok(())
    })
    .unwrap();
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_delete_beside_a_move_dooms_only_its_subtree_while_depths_are_rewritten() {
    let dir = temp_dir("prune-move");
    let (s, mut model) = open_with_actors(&dir);
    // A chain; its tail moves up above a two-message gap that then goes, as a cut closing a gap does.
    let n = (sessions::DEPTH_SLICE * 3) as u64;
    let mut recs = vec![append(&mut model, 1, None, 0, "root", None, None, 1)];
    for i in 1..n {
        recs.push(append(
            &mut model,
            1,
            Some(i - 1),
            i as i64,
            "x",
            None,
            None,
            1,
        ));
    }
    s.commit_wait(recs).unwrap();
    model.msgs.get_mut(&3).unwrap().parent = Some(0);
    model.subtree_gone(1);
    commit_without_slices(
        &s,
        vec![
            rec(
                "messageParent",
                vec![Value::Id(3), Value::Id(0), Value::Absent, Value::Absent],
            ),
            rec(
                "subtreeDelete",
                vec![Value::Id(1), Value::Absent, Value::Absent],
            ),
        ],
    );
    s.derived(|v| {
        assert!(sessions::depths_pending(v, 1)? && prune::pending_in(v, 1)?);
        // The moved tail's jumps still name the gap; it isn't being deleted.
        for m in [3, n / 2, n - 1] {
            assert!(!prune::doomed(v, 1, m)?, "{m}");
        }
        assert!(prune::doomed(v, 1, 2)?);
        Ok(())
    })
    .unwrap();
    s.commit_wait(vec![append(
        &mut model,
        1,
        Some(n - 1),
        n as i64,
        "after",
        None,
        None,
        1,
    )])
    .unwrap();
    s.abandon();
    std::mem::forget(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_send_key_of_a_message_being_deleted_stores_a_new_message() {
    let dir = temp_dir("prune-send-key");
    let (s, mut model) = open_with_actors(&dir);
    // A chain longer than a slice, its last message sent with a key.
    let n = (prune::PRUNE_SLICE * 2) as u64;
    let key = b"send-key".to_vec();
    let mut recs = vec![append(&mut model, 1, None, 0, "root", None, None, 1)];
    for i in 1..n {
        let sk = (i == n - 1).then(|| key.clone());
        recs.push(append(
            &mut model,
            1,
            Some(i - 1),
            i as i64,
            "x",
            sk,
            None,
            1,
        ));
    }
    s.commit_wait(recs).unwrap();
    let sent = |s: &Store| {
        s.derived(|v| super::chat_read::sent(v, 1, std::slice::from_ref(&key)))
            .unwrap()
    };
    assert_eq!(sent(&s), Js::Arr(vec![Js::Big(n - 1)]));
    model.subtree_gone(1);
    commit_without_slices(
        &s,
        vec![rec(
            "subtreeDelete",
            vec![Value::Id(1), Value::Absent, Value::Absent],
        )],
    );
    // While the delete is pending the key names nothing, and sending it again stores a new message.
    assert_eq!(sent(&s), Js::Arr(vec![Js::Null]));
    s.commit_wait(vec![append(
        &mut model,
        1,
        Some(0),
        n as i64,
        "again",
        Some(key.clone()),
        None,
        1,
    )])
    .unwrap();
    // The delete finishes (on open, as after a crash) and leaves the new message's key.
    s.abandon();
    std::mem::forget(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
    assert_eq!(sent(&s), Js::Arr(vec![Js::Big(n)]));
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_bookmark_at_a_trees_root_is_named_moves_with_a_new_opening_and_goes() {
    let dir = temp_dir("root-bookmark");
    let (s, mut model) = open_with_actors(&dir);
    let root = |b: u64, mode: u64, tree: u64| {
        rec(
            "positionRoot",
            vec![
                Value::Id(b),
                Value::UInt(mode),
                Value::Id(1),
                Value::Id(1),
                Value::Id(tree),
            ],
        )
    };
    let name = |b: u64, n: &str| rec("positionName", vec![Value::Id(b), Value::Text(text(n))]);
    s.commit_wait(vec![
        root(10, FOLLOWING, 7),
        name(10, "empty"),
        root(11, PINNED, 7),
        name(11, "kept"),
        root(12, FOLLOWING, 8),
    ])
    .unwrap();
    // Names are unique in the tree, root bookmarks' as any other's.
    assert!(s.commit_wait(vec![name(11, "empty")]).is_err());
    s.derived(|v| {
        assert_eq!(chat::bookmark_root(v, 10)?, Some(7));
        assert_eq!(chat::bookmark_at(v, 10)?, None);
        assert_eq!(chat::root_bookmarks(v, 7)?, vec![10, 11]);
        assert_eq!(chat::bookmarks_named(v, 7, b"empty")?, vec![10]);
        let Js::Arr(rows) = super::chat_read::tree_bookmarks(v, 7, None, 10)? else {
            panic!("a list");
        };
        assert_eq!(rows.len(), 2);
        Ok(())
    })
    .unwrap();
    // An opening stored in tree 7 takes the following one along; the pinned one stays, and tree 8's is untouched.
    let opening = append(&mut model, 7, None, 5, "hello", None, None, 1);
    s.commit_wait(vec![opening]).unwrap();
    s.derived(|v| {
        assert_eq!(chat::bookmark_root(v, 10)?, None);
        assert_eq!(chat::bookmark_at(v, 10)?, Some(0));
        assert_eq!(chat::root_bookmarks(v, 7)?, vec![11]);
        assert_eq!(chat::root_bookmarks(v, 8)?, vec![12]);
        assert_eq!(chat::bookmarks_named(v, 7, b"empty")?, vec![10]);
        Ok(())
    })
    .unwrap();
    // Deleting it takes its name and places; its name is free again.
    s.commit_wait(vec![rec("positionDelete", vec![Value::Id(11)])])
        .unwrap();
    s.commit_wait(vec![name(10, "kept")]).unwrap();
    drop(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    s.derived(|v| {
        assert!(chat::root_bookmarks(v, 7)?.is_empty());
        assert_eq!(v.get(&key::id(key::BOOKMARK_ROOT, 11))?, None);
        assert_eq!(chat::bookmarks_named(v, 7, b"kept")?, vec![10]);
        let p = key::id(key::TREE_BOOKMARK, 7);
        assert_eq!(v.scan(&p, &key::prefix_end(&p), usize::MAX)?.len(), 1);
        Ok(())
    })
    .unwrap();
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn an_unowned_tree_keeps_its_messages_until_a_character_takes_its_id() {
    use super::library::{self, CHARACTER, CHAT_SIZE, LAST_CHAT, TREE};
    let dir = temp_dir("unowned");
    let (s, mut model) = open_with_actors(&dir);
    let create = |kind: u64, key: &str| {
        rec(
            "entityCreate",
            vec![
                Value::Id(30),
                Value::UInt(kind),
                Value::Text(text(key)),
                Value::Time(1),
            ],
        )
    };
    let a = append(&mut model, 30, None, 5, "hi", None, None, 1);
    let b = append(&mut model, 30, Some(0), 9, "there", None, None, 1);
    s.commit_wait(vec![create(TREE, "gone"), a, b]).unwrap();
    s.derived(|v| {
        // Kept, found by its key, in no library order or count.
        assert_eq!(library::entity_by_key(v, TREE, b"gone")?, Some(30));
        assert_eq!(library::state(v, 30)?, None);
        let counts = key::of(key::COUNT);
        assert!(
            v.scan(&counts, &key::prefix_end(&counts), usize::MAX)?
                .is_empty()
        );
        Ok(())
    })
    .unwrap();
    // A character created with the tree's id takes it over: its messages and their stats are the character's.
    s.commit_wait(vec![
        rec("entityDelete", vec![Value::Id(30)]),
        rec(
            "textValue",
            vec![
                Value::Sel(0, 30),
                Value::Field(FieldRef::Code(library::NAME)),
                Value::Text(text("Back")),
                Value::Absent,
                Value::Absent,
            ],
        ),
        create(CHARACTER, "gone.png"),
    ])
    .unwrap();
    s.derived(|v| {
        assert_eq!(library::entity_by_key(v, TREE, b"gone")?, None);
        assert_eq!(library::entity_by_key(v, CHARACTER, b"gone.png")?, Some(30));
        assert!(library::state(v, 30)?.is_some());
        assert_eq!(
            library::sort_num(v, 30, CHARACTER, Some(1), LAST_CHAT)?,
            Some(9.0)
        );
        assert!(library::sort_num(v, 30, CHARACTER, Some(1), CHAT_SIZE)?.unwrap_or(0.0) > 0.0);
        assert_eq!(chat::path_to(v, Some(1))?, vec![0, 1]);
        Ok(())
    })
    .unwrap();
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}
