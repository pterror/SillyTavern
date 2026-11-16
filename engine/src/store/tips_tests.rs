use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use super::chat;
use super::sessions::Convo::{self, Bookmark, Session};
use super::tips::{self, Entry};
use super::*;
use crate::log::format::{Value, kind_by_name, wtf8_from_utf16};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-tips-{}-{name}-{}",
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

fn pool() -> Arc<Pool> {
    Pool::new(16 << 10, 64 << 10, 4, 1, 2, 2)
}

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn opt(v: Option<u64>) -> Value {
    v.map_or(Value::Absent, Value::Id)
}

const USER: u64 = 1;

/// A store with sessions 1 to 4 and user 1, and the messages it has written, by id: (tree, parent).
struct Chats {
    s: Store,
    dir: PathBuf,
    next: u64,
    time: i64,
    msgs: HashMap<u64, (u64, Option<u64>)>,
}

impl Chats {
    fn open(name: &str) -> Chats {
        let dir = temp_dir(name);
        let s = Store::open_in(&dir, SMALL, pool()).unwrap();
        let mut recs = Vec::new();
        for ses in 1..=4u64 {
            recs.push(rec(
                "keyMap",
                vec![
                    Value::Sel(chat::KEYED_SESSION, ses),
                    Value::Bytes(format!("session-{ses}").into_bytes()),
                ],
            ));
        }
        recs.push(rec(
            "keyMap",
            vec![
                Value::Sel(chat::KEYED_USER, USER),
                Value::Bytes(b"user".to_vec()),
            ],
        ));
        s.commit_wait(recs).unwrap();
        Chats {
            s,
            dir,
            next: 100,
            time: 1_700_000_000_000,
            msgs: HashMap::new(),
        }
    }

    fn append_rec(&mut self, ses: Option<u64>, tree: u64, parent: Option<u64>) -> (u64, Record) {
        let m = self.next;
        self.next += 1;
        self.time += 1;
        self.msgs.insert(m, (tree, parent));
        let text: Vec<u8> = wtf8_from_utf16(&format!("m{m}").encode_utf16().collect::<Vec<_>>());
        (
            m,
            rec(
                "messageAppend",
                vec![
                    Value::Id(m),
                    opt(parent),
                    Value::Id(tree),
                    Value::Absent,
                    Value::Absent,
                    Value::Time(self.time),
                    Value::Text(text),
                    Value::UInt(0),
                    opt(ses),
                    Value::Id(USER),
                    Value::Absent,
                ],
            ),
        )
    }

    /// Sends a message as session `ses`, which moves there.
    fn send(&mut self, ses: u64, tree: u64, parent: Option<u64>) -> u64 {
        let (m, r) = self.append_rec(Some(ses), tree, parent);
        self.s.commit_wait(vec![r]).unwrap();
        m
    }

    /// A chain of `n` messages below `parent`, sent by no session; the last of them.
    fn chain(&mut self, tree: u64, parent: Option<u64>, n: usize) -> u64 {
        let mut at = parent;
        let mut recs = Vec::new();
        for _ in 0..n {
            let (m, r) = self.append_rec(None, tree, at);
            recs.push(r);
            at = Some(m);
        }
        self.s.commit_wait(recs).unwrap();
        at.unwrap()
    }

    fn go(&self, ses: u64, m: u64) {
        self.s
            .commit_wait(vec![rec(
                "pointerMove",
                vec![Value::Id(ses), Value::Id(USER), Value::Id(m)],
            )])
            .unwrap();
    }

    fn entries(&self, chat: Option<Convo>) -> Vec<Entry> {
        self.s
            .derived(|v| tips::entries(v, chat, None, usize::MAX))
            .unwrap()
            .into_iter()
            .map(|(_, e)| e)
            .collect()
    }

    fn tips(&self, chat: Convo, split: Option<u64>) -> Vec<u64> {
        self.s
            .derived(|v| tips::group_tips(v, chat, split, None, usize::MAX))
            .unwrap()
            .into_iter()
            .map(|(_, m, _)| m)
            .collect()
    }

    fn naive_common(&self, a: u64, b: u64) -> Option<u64> {
        let mut above = Vec::new();
        let mut cur = Some(a);
        while let Some(c) = cur {
            above.push(c);
            cur = self.msgs[&c].1;
        }
        let mut cur = Some(b);
        while let Some(c) = cur {
            if above.contains(&c) {
                return Some(c);
            }
            cur = self.msgs[&c].1;
        }
        None
    }

    fn close(self) {
        drop(self.s);
        fs::remove_dir_all(&self.dir).unwrap();
    }
}

/// What an entry shows, without its activity: where the chat is, or a group's split, latest tip and count.
#[derive(Debug, PartialEq)]
enum Shown {
    At(Convo, u64),
    Group(Convo, Option<u64>, u64, u64),
}

fn shown(entries: Vec<Entry>) -> Vec<Shown> {
    entries
        .into_iter()
        .map(|e| match e {
            Entry::At { chat, at, .. } => Shown::At(chat, at),
            Entry::Group {
                chat,
                split,
                latest,
                tips,
                ..
            } => Shown::Group(chat, split, latest, tips),
        })
        .collect()
}

#[test]
fn a_swipe_of_the_last_message_is_no_tip_and_a_line_left_is_one_split_off_at_the_closest_common_message()
 {
    let mut c = Chats::open("swipes");
    let me = Session(1, 1);
    let g = c.send(1, 1, None);
    let u = c.send(1, 1, Some(g));
    let r1 = c.send(1, 1, Some(u));
    let r2 = c.send(1, 1, Some(u));
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, r2)],
        "a swipe leaves no tip"
    );
    c.go(1, r1);
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, r1)],
        "nor does going back to one"
    );
    let u2 = c.send(1, 1, Some(r1));
    let r3 = c.send(1, 1, Some(u2));
    c.go(1, r2);
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, r2), Shown::Group(me, Some(u), r3, 1)],
        "the line left ends at r3, which branches off u"
    );
    let u3 = c.send(1, 1, Some(r2));
    let r4 = c.send(1, 1, Some(u3));
    c.go(1, r3);
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, r3), Shown::Group(me, Some(u), r4, 1)],
        "the place gone back to is no tip while the chat is at it"
    );
    c.go(1, r4);
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, r4), Shown::Group(me, Some(u), r3, 1)]
    );
    let r5 = c.send(1, 1, Some(u2));
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, r5), Shown::Group(me, Some(u), r4, 2)],
        "r4 is left for r5, which branches off u too"
    );
    assert_eq!(c.tips(me, Some(u)), vec![r4, r3]);
    c.close();
}

#[test]
fn going_on_below_a_tip_ends_it_there_and_going_up_leaves_one_split_off_where_it_went() {
    let mut c = Chats::open("continue");
    let me = Session(1, 1);
    let g = c.send(1, 1, None);
    let a = c.send(1, 1, Some(g));
    let b = c.send(1, 1, Some(a));
    let d = c.send(1, 1, Some(b));
    c.go(1, a);
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, a), Shown::Group(me, Some(a), d, 1)]
    );
    c.go(1, d);
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, d)],
        "back at the tip, it is where the chat is"
    );
    let e = c.send(1, 1, Some(d));
    c.go(1, b);
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, b), Shown::Group(me, Some(b), e, 1)],
        "the line went on to e"
    );
    let x = c.send(1, 1, None);
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![
            Shown::At(me, x),
            Shown::Group(me, None, b, 1),
            Shown::Group(me, Some(b), e, 1)
        ],
        "another opening splits off at the tree's root"
    );
    c.close();
}

#[test]
fn a_jump_between_distant_messages_splits_off_at_their_closest_common_message() {
    let mut c = Chats::open("distant");
    let me = Session(1, 1);
    let fork = c.chain(1, None, 37);
    let left = c.chain(1, Some(fork), 61);
    let right = c.chain(1, Some(fork), 45);
    c.go(1, left);
    c.go(1, right);
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, right), Shown::Group(me, Some(fork), left, 1)]
    );
    let mut seed = 7u64;
    let mut next = |n: u64| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) % n
    };
    for _ in 0..300 {
        let ids: Vec<u64> = c.msgs.keys().copied().collect();
        let parent = ids[next(ids.len() as u64) as usize];
        c.chain(1, Some(parent), 1 + next(4) as usize);
    }
    let ids: Vec<u64> = c.msgs.keys().copied().collect();
    for _ in 0..400 {
        let (a, b) = (
            ids[next(ids.len() as u64) as usize],
            ids[next(ids.len() as u64) as usize],
        );
        let found = c.s.derived(|v| tips::closest_common(v, 1, a, b)).unwrap();
        assert_eq!(found, c.naive_common(a, b), "{a} and {b}");
    }
    c.close();
}

#[test]
fn a_deleted_tip_leaves_its_group_and_a_chat_at_a_deleted_message_is_at_its_parent() {
    let mut c = Chats::open("deletes");
    let me = Session(1, 1);
    let g = c.send(1, 1, None);
    let u = c.send(1, 1, Some(g));
    let a = c.chain(1, Some(u), 2);
    let b = c.chain(1, Some(u), 2);
    let d = c.chain(1, Some(u), 2);
    c.go(1, a);
    c.go(1, b);
    c.go(1, d);
    assert_eq!(c.tips(me, Some(u)), vec![b, a]);
    let delete = |m: u64| {
        rec(
            "messageDelete",
            vec![Value::Id(m), Value::Absent, Value::Absent, Value::Time(1)],
        )
    };
    c.s.commit_wait(vec![delete(b)]).unwrap();
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, d), Shown::Group(me, Some(u), a, 1)]
    );
    c.s.commit_wait(vec![delete(a)]).unwrap();
    assert_eq!(shown(c.entries(Some(me))), vec![Shown::At(me, d)]);
    let above = c.msgs[&d].1.unwrap();
    c.s.commit_wait(vec![delete(d)]).unwrap();
    assert_eq!(shown(c.entries(Some(me))), vec![Shown::At(me, above)]);
    c.close();
}

#[test]
fn a_split_taken_out_from_between_its_neighbours_hands_its_groups_to_its_parent() {
    let mut c = Chats::open("degraft");
    let me = Session(1, 1);
    let g = c.send(1, 1, None);
    let u = c.send(1, 1, Some(g));
    let mid = c.send(1, 1, Some(u));
    let a = c.chain(1, Some(mid), 3);
    let b = c.chain(1, Some(mid), 2);
    let elsewhere = c.chain(1, Some(u), 3);
    c.go(1, a);
    c.go(1, b);
    c.go(1, elsewhere);
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![
            Shown::At(me, elsewhere),
            Shown::Group(me, Some(u), b, 1),
            Shown::Group(me, Some(mid), a, 1)
        ]
    );
    let below: Vec<u64> = c
        .msgs
        .iter()
        .filter(|(_, (_, p))| *p == Some(mid))
        .map(|(m, _)| *m)
        .collect();
    let mut recs: Vec<Record> = below
        .iter()
        .map(|m| {
            rec(
                "messageParent",
                vec![Value::Id(*m), Value::Id(u), Value::Absent, Value::Absent],
            )
        })
        .collect();
    recs.push(rec(
        "messageDelete",
        vec![Value::Id(mid), Value::Absent, Value::Absent, Value::Time(1)],
    ));
    c.s.commit_wait(recs).unwrap();
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, elsewhere), Shown::Group(me, Some(u), b, 2)]
    );
    assert_eq!(c.tips(me, Some(u)), vec![b, a]);
    c.close();
}

#[test]
fn every_chats_entries_merge_by_their_latest_activity_and_read_a_page_at_a_time() {
    let mut c = Chats::open("all");
    let (one, two) = (Session(1, 1), Session(2, 2));
    let g1 = c.send(1, 1, None);
    let a1 = c.chain(1, Some(g1), 2);
    let g2 = c.send(2, 2, None);
    let a2 = c.chain(2, Some(g2), 2);
    c.go(1, a1);
    let b1 = c.send(1, 1, Some(g1));
    c.go(2, a2);
    let b2 = c.send(2, 2, Some(g2));
    assert_eq!(
        shown(c.entries(None)),
        vec![
            Shown::At(two, b2),
            Shown::Group(two, Some(g2), a2, 1),
            Shown::At(one, b1),
            Shown::Group(one, Some(g1), a1, 1),
        ]
    );
    c.go(1, a1);
    assert_eq!(
        shown(c.entries(None)),
        vec![
            Shown::At(one, a1),
            Shown::At(two, b2),
            Shown::Group(two, Some(g2), a2, 1)
        ],
        "b1 is an alternative of where it went, and a1 no tip while the chat is at it"
    );
    let all =
        c.s.derived(|v| tips::entries(v, None, None, usize::MAX))
            .unwrap();
    let mut paged = Vec::new();
    let mut before: Option<Vec<u8>> = None;
    loop {
        let page =
            c.s.derived(|v| tips::entries(v, None, before.as_deref(), 1))
                .unwrap();
        let Some((k, e)) = page.into_iter().next() else {
            break;
        };
        paged.push(e);
        before = Some(k);
    }
    assert_eq!(paged, all.into_iter().map(|(_, e)| e).collect::<Vec<_>>());
    let one_only =
        c.s.derived(|v| tips::entries(v, Some(two), None, usize::MAX))
            .unwrap();
    assert!(
        c.s.derived(|v| tips::entries(v, Some(one), Some(&one_only[0].0), 1))
            .is_err()
    );
    c.close();
}

#[test]
fn a_bookmark_opened_takes_the_moves_and_the_conversation_it_replaced_goes_with_its_entries() {
    let mut c = Chats::open("bookmarks");
    let g = c.send(1, 1, None);
    let a = c.chain(1, Some(g), 2);
    let b = c.chain(1, Some(g), 2);
    c.go(1, a);
    c.go(1, b);
    assert_eq!(c.entries(None).len(), 2);
    c.s.commit_wait(vec![
        rec(
            "positionCreate",
            vec![
                Value::Id(9),
                Value::UInt(chat::PINNED),
                Value::Id(1),
                Value::Id(USER),
                Value::Id(a),
            ],
        ),
        rec(
            "currentChat",
            vec![Value::Id(1), Value::Id(USER), Value::Id(1), Value::Id(9)],
        ),
    ])
    .unwrap();
    assert_eq!(
        c.entries(None),
        vec![],
        "the session's own conversation is gone"
    );
    c.go(1, a);
    c.go(1, b);
    let mark = Bookmark(9);
    assert_eq!(
        shown(c.entries(None)),
        vec![Shown::At(mark, b), Shown::Group(mark, Some(g), a, 1)]
    );
    c.s.commit_wait(vec![rec("positionDelete", vec![Value::Id(9)])])
        .unwrap();
    assert_eq!(c.entries(None), vec![]);
    c.go(1, a);
    c.go(1, b);
    c.s.commit_wait(vec![rec("positionDelete", vec![Value::Id(1)])])
        .unwrap();
    c.s.derived(|v| {
        for space in tips::TIP_AT..=tips::TIP_ALL {
            let p = key::of(space);
            assert!(
                v.scan(&p, &key::prefix_end(&p), usize::MAX)?.is_empty(),
                "{space}"
            );
        }
        Ok(())
    })
    .unwrap();
    c.close();
}

fn convert(s: &Store, batch: usize) {
    let mut from: Option<Vec<u8>> = None;
    loop {
        let (tx, rx) = std::sync::mpsc::channel();
        s.recent_history_conversion_step(from.clone(), batch, Box::new(move |r| drop(tx.send(r))));
        match rx.recv().unwrap().unwrap() {
            Some(next) => from = Some(next),
            None => return,
        }
    }
}

#[test]
fn the_conversion_builds_from_the_kept_moves_what_the_moves_built_and_again_the_same() {
    let mut c = Chats::open("conversion");
    let g = c.send(1, 1, None);
    let u = c.send(1, 1, Some(g));
    let a = c.chain(1, Some(u), 3);
    let b = c.chain(1, Some(u), 2);
    let _ = c.send(1, 1, Some(b));
    c.go(1, a);
    c.go(1, g);
    let h = c.send(2, 2, None);
    let x = c.chain(2, Some(h), 4);
    c.go(2, x);
    c.go(2, h);
    let _ = c.send(2, 2, Some(h));
    c.go(1, b);
    let read = |s: &Store| {
        s.derived(|v| {
            let all = tips::entries(v, None, None, usize::MAX)?;
            let mut groups = Vec::new();
            for (_, e) in &all {
                if let Entry::Group { chat, split, .. } = e {
                    groups.push(tips::group_tips(v, *chat, *split, None, usize::MAX)?);
                }
            }
            Ok((all, groups))
        })
        .unwrap()
    };
    let built = read(&c.s);
    assert!(built.0.len() >= 4);
    convert(&c.s, 3);
    assert_eq!(read(&c.s), built);
    convert(&c.s, 1000);
    assert_eq!(read(&c.s), built, "safe to run twice");
    c.close();
}

#[test]
fn a_message_and_its_reply_sent_in_one_commit_go_on_from_where_the_chat_was() {
    let mut c = Chats::open("one-commit");
    let me = Session(1, 1);
    let g = c.send(1, 1, None);
    let a = c.chain(1, Some(g), 2);
    c.go(1, a);
    let (u, ur) = c.append_rec(Some(1), 1, Some(g));
    let (r, rr) = c.append_rec(Some(1), 1, Some(u));
    c.s.commit_wait(vec![ur, rr]).unwrap();
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![Shown::At(me, r), Shown::Group(me, Some(g), a, 1)]
    );
    c.s.commit_wait(vec![rec(
        "pointerRoot",
        vec![
            Value::Id(1),
            Value::Id(USER),
            Value::Id(1),
            Value::Time(c.time),
        ],
    )])
    .unwrap();
    assert_eq!(
        shown(c.entries(Some(me))),
        vec![
            Shown::Group(me, None, r, 1),
            Shown::Group(me, Some(g), a, 1)
        ],
        "at the tree's root the chat shows no message of its own"
    );
    c.close();
}
