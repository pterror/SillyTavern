//! A tree's chats searched (design S5), as two searches; neither reads a whole path:
//!
//! - Messages: the tree's messages a query matches, best first, from the owner's chat postings (whole words; a
//!   closed-quote phrase as a phrase). On top, a substring scan (upstream's match: each clause's text, lower-cased,
//!   inside the message's text; a negated one in none) reads messages newest first, a message's text at a time,
//!   under a cap of text bytes (`SCAN_BYTES`), answering the ones whole words don't match; where it stopped is a
//!   cursor a scan-only read goes on from.
//! - The chat list (a tree's bookmarks, and a tab's session there when no bookmark is at its message): an item
//!   matches by its name (every clause's text inside it, lower-cased, as upstream's file names) or by its path
//!   holding every positive clause in some message and no negated one in any: each clause's matching messages come
//!   from the postings, and a message is on an item's path when it is the item's ancestor at its depth, reached
//!   through jump pointers (`sessions::climb`), the item's climb going down the clause's depths in one pass.
//!
//! Every read counts as work (`query::Ctx` units, about 0.16 µs each; a point read `READ`); past `WORK` a read
//! stops and says it may be incomplete.

use std::collections::{HashMap, HashSet};

use super::StoreError;
use super::chat;
use super::derive::View;
use super::kinds::{self, Holder};
use super::sessions;
use crate::keyspace::val::get_u64;
use crate::log::format::FieldRef;
use crate::search::query::{After, Clause, Limits, Matching, Order, Query, StatsCache};
use crate::search::{LENGTH_BITS, Scope, lengths};

/// Work a read does at most (about 0.3 s).
pub const WORK: u64 = 2_000_000;
/// Work a point read counts.
const READ: u64 = 6;
/// Text bytes a message search's substring scan reads at most per call.
pub const SCAN_BYTES: u64 = 3 << 20;
/// What the scan counts per message read besides its text's bytes.
const SCAN_MESSAGE: u64 = 64;

fn query(scope: Scope, clauses: Vec<Clause>, limit: usize, after: Option<(f64, u64)>) -> Query {
    Query {
        scope,
        clauses,
        filters: Vec::new(),
        order: Order::Relevance,
        limit,
        after: after.map(|(s, d)| After::Score(s, d)),
        limits: Limits::default(),
    }
}

/// The clauses with a word to look up (a clause of punctuation only has none).
fn worded(clauses: &[Clause]) -> Vec<Clause> {
    clauses
        .iter()
        .filter(|c| !crate::search::text::tokens(&c.text).is_empty())
        .map(|c| Clause {
            fields: None,
            ..c.clone()
        })
        .collect()
}

/// The substring clauses: each clause's text lower-cased, and whether it is negated.
fn substrings(clauses: &[Clause]) -> Vec<(bool, String)> {
    clauses
        .iter()
        .filter_map(|c| {
            let t = lower(&c.text).trim().to_string();
            (!t.is_empty()).then_some((c.negate, t))
        })
        .collect()
}

fn lower(b: &[u8]) -> String {
    String::from_utf8_lossy(b).to_lowercase()
}

/// Whether `text` holds every positive substring and no negated one.
fn holds(subs: &[(bool, String)], text: &[u8]) -> bool {
    let t = lower(text);
    subs.iter()
        .all(|(negate, s)| t.contains(s.as_str()) != *negate)
}

// ---- messages ----

/// Where a message search starts: an index page and the scan from the newest message, or the scan alone from below
/// a message (a `Messages::scan` cursor).
#[derive(Debug, Clone, Copy)]
pub enum Start {
    Index { after: Option<(f64, u64)> },
    ScanBelow(u64),
}

#[derive(Debug, Default)]
pub struct Messages {
    /// From the index, best first: (message, score).
    pub hits: Vec<(u64, f64)>,
    /// From the scan, newest first: messages whole words don't match.
    pub scanned: Vec<u64>,
    /// The index has more after the page's last hit.
    pub more: bool,
    pub total: u64,
    pub total_exact: bool,
    /// The scan stopped (at its cap, at `limit` or at `WORK`): messages below this one are still to scan.
    pub scan: Option<u64>,
}

pub fn messages(
    view: &View,
    tree: u64,
    clauses: &[Clause],
    start: Start,
    limit: usize,
    scan_bytes: u64,
    cache: &StatsCache,
) -> Result<Messages, StoreError> {
    let scope = Scope::chat(tree);
    let words = worded(clauses);
    let subs = substrings(clauses);
    let mut out = Messages::default();
    let mut work = 0u64;
    let below = match start {
        Start::Index { after } => {
            if !words.is_empty() {
                let f = crate::search::query::run(
                    view,
                    &query(scope, words.clone(), limit, after),
                    cache,
                )?;
                work += f.work;
                out.more = f.more;
                out.total = f.total;
                out.total_exact = f.total_exact;
                out.hits = f.hits.iter().map(|h| (h.doc, h.score)).collect();
            }
            if after.is_some() {
                // Later index pages read no scan: the first page's cursor goes on with it.
                return Ok(out);
            }
            u64::MAX
        }
        Start::ScanBelow(m) => m,
    };
    if subs.is_empty() {
        return Ok(out);
    }
    let mut words_match = if words.is_empty() {
        None
    } else {
        Some(Matching::new(view, &query(scope, words, 0, None), cache)?)
    };
    // The scope's length entries list the messages with text, LENGTH_BITS of ids an entry; read last first.
    let p = lengths(scope);
    let end = if below == u64::MAX {
        crate::store::kinds::key::prefix_end(&p)
    } else {
        let mut k = p.clone();
        crate::keyspace::val::put_u64(&mut k, below >> LENGTH_BITS);
        crate::store::kinds::key::prefix_end(&k)
    };
    let mut to = end;
    let mut scanned = 0u64;
    loop {
        work += crate::search::query::SEEK;
        let batch = view.scan_vals_rev(&p, &to, 64)?;
        let Some((last, _)) = batch.last() else {
            return Ok(out);
        };
        to = last.clone();
        let full = batch.len() == 64;
        for (k, v) in batch {
            let mut at = p.len();
            let block = get_u64(&k, &mut at)
                .ok_or_else(|| StoreError::Entry("a length key doesn't decode".into()))?;
            let mut docs: Vec<u64> = v
                .into_pairs()
                .unwrap_or_default()
                .into_iter()
                .map(|(slot, _)| {
                    block << LENGTH_BITS | u64::from(slot >> crate::search::FIELD_BITS)
                })
                .filter(|&d| d < below)
                .collect();
            docs.sort_unstable();
            docs.dedup();
            for &m in docs.iter().rev() {
                let spent = work + scanned / 32 + words_match.as_ref().map_or(0, |w| w.work());
                if scanned > scan_bytes || out.scanned.len() == limit || spent > WORK {
                    // `m` isn't read: the next scan starts with it.
                    out.scan = Some(m + 1);
                    return Ok(out);
                }
                let t = kinds::text_value_of(view, Holder::Message(m), &FieldRef::Code(chat::MES))?
                    .unwrap_or_default();
                work += READ;
                scanned += t.len() as u64 + SCAN_MESSAGE;
                if !holds(&subs, &t) {
                    continue;
                }
                // Whole words found it: the index answers it.
                if let Some(w) = &mut words_match
                    && w.matches(m)?
                {
                    continue;
                }
                out.scanned.push(m);
            }
        }
        if !full {
            return Ok(out);
        }
    }
}

// ---- the chat list ----

/// An item of a tree's chat list: a bookmark, or a tab's session; at a message (None: the tree's root).
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub bookmark: Option<u64>,
    pub session: Option<u64>,
    pub at: Option<u64>,
}

#[derive(Debug, Default)]
pub struct ListPage {
    pub hits: Vec<Item>,
    /// Bookmarks follow: read on `after` `next`.
    pub more: bool,
    pub next: Option<u64>,
    /// Every match was weighed (not cut by `WORK`, no depth rewrite under way).
    pub exact: bool,
}

/// A clause's matching messages by depth.
struct Candidates {
    negate: bool,
    /// Depths, deepest first, each with its messages.
    by_depth: Vec<(u64, HashSet<u64>)>,
}

/// The items of the tree's chat list, from bookmark `after` on (the session first, on the first page) whose name
/// or path matches, up to `limit`.
pub fn chat_list(
    view: &View,
    tree: u64,
    clauses: &[Clause],
    session: Option<u64>,
    after: Option<u64>,
    limit: usize,
    cache: &StatsCache,
) -> Result<ListPage, StoreError> {
    let mut out = ListPage {
        exact: !sessions::depths_pending(view, tree)?,
        ..ListPage::default()
    };
    let subs = substrings(clauses);
    let words = worded(clauses);
    let mut work = 0u64;
    let mut reads = 0u64;
    // Each worded clause's matching messages, read once a call.
    let mut cands: Option<Vec<Candidates>> = None;
    let mut items: Vec<(Item, Vec<u8>)> = Vec::new();
    let shown_session = match (after, session) {
        (None, Some(s)) => match sessions::session_in_tree(view, s, tree)? {
            Some(at) => match at {
                Some(m) if !chat::bookmarks_at(view, m)?.is_empty() => None,
                _ => Some((s, at)),
            },
            None => None,
        },
        _ => None,
    };
    if let Some((s, at)) = shown_session {
        reads += 3;
        let name = super::searched::position_name(view, s)?.unwrap_or_default();
        items.push((
            Item {
                bookmark: None,
                session: Some(s),
                at,
            },
            name,
        ));
    }
    let p = kinds::key::id(kinds::key::TREE_BOOKMARK, tree);
    let mut from = match after {
        Some(a) => kinds::key::ids(kinds::key::TREE_BOOKMARK, tree, a + 1),
        None => p.clone(),
    };
    loop {
        let batch = view.scan(&from, &kinds::key::prefix_end(&p), 64)?;
        work += crate::search::query::SEEK + batch.len() as u64;
        let full = batch.len() == 64;
        for (k, _) in &batch {
            let mut at = p.len();
            let b = get_u64(k, &mut at)
                .ok_or_else(|| StoreError::Entry("a bookmark key doesn't decode".into()))?;
            reads += 2;
            let name = super::searched::position_name(view, b)?.unwrap_or_default();
            items.push((
                Item {
                    bookmark: Some(b),
                    session: None,
                    at: chat::bookmark_at(view, b)?,
                },
                name,
            ));
        }
        if let Some((k, _)) = batch.last() {
            from = k.clone();
            from.push(0);
        }
        for (item, name) in items.drain(..) {
            let capped = work + reads * READ > WORK;
            if capped || out.hits.len() == limit {
                out.more = true;
                out.exact &= !capped;
                // The next page starts with this item.
                out.next = item.bookmark.and_then(|b| b.checked_sub(1));
                return Ok(out);
            }
            let by_name = !name.is_empty() && !subs.is_empty() && holds(&subs, &name);
            let hit = clauses.is_empty()
                || by_name
                || (!words.is_empty()
                    && path_holds(
                        view,
                        tree,
                        &words,
                        item.at,
                        &mut cands,
                        &mut work,
                        &mut reads,
                        cache,
                        &mut out.exact,
                    )?);
            if hit {
                out.hits.push(item);
            }
        }
        if !full {
            return Ok(out);
        }
    }
}

/// Whether the path down to `at` holds every positive worded clause in some message and no negated one in any.
#[allow(clippy::too_many_arguments)]
fn path_holds(
    view: &View,
    tree: u64,
    words: &[Clause],
    at: Option<u64>,
    cands: &mut Option<Vec<Candidates>>,
    work: &mut u64,
    reads: &mut u64,
    cache: &StatsCache,
    exact: &mut bool,
) -> Result<bool, StoreError> {
    let Some(at) = at else {
        return Ok(words.iter().all(|c| c.negate));
    };
    if cands.is_none() {
        let mut all = Vec::new();
        for c in words {
            let plain = Clause {
                negate: false,
                ..c.clone()
            };
            let budget = WORK.saturating_sub(*work + *reads * READ);
            let (docs, complete, w) = crate::search::query::matches_upto(
                view,
                &query(Scope::chat(tree), vec![plain], 0, None),
                cache,
                budget,
            )?;
            *work += w;
            *exact &= complete;
            let keys: Vec<Vec<u8>> = docs
                .iter()
                .map(|m| kinds::key::id(sessions::DEPTH, *m))
                .collect();
            *reads += keys.len() as u64;
            let mut by: HashMap<u64, HashSet<u64>> = HashMap::new();
            for (m, b) in docs.iter().zip(view.get_many(&keys)?) {
                if let Some(b) = b {
                    let [d, _] = kinds::parse_varints::<2>(&b)?;
                    by.entry(d).or_default().insert(*m);
                }
            }
            let mut by_depth: Vec<(u64, HashSet<u64>)> = by.into_iter().collect();
            by_depth.sort_unstable_by_key(|x| std::cmp::Reverse(x.0));
            all.push(Candidates {
                negate: c.negate,
                by_depth,
            });
        }
        *cands = Some(all);
    }
    *reads += 1;
    let Some((d0, j0)) = sessions::depth_jump(view, at)? else {
        return Ok(false);
    };
    for c in cands.as_ref().expect("read above") {
        // Down the clause's depths from the item's: its ancestor at each, through one climb.
        let (mut v, mut dv, mut jv) = (at, d0, j0);
        let mut found = false;
        for (d, ms) in &c.by_depth {
            if *d > dv {
                continue;
            }
            let Some((a, ja)) = sessions::climb(view, v, dv, jv, *d, reads)? else {
                break;
            };
            (v, dv, jv) = (a, *d, ja);
            if ms.contains(&a) {
                found = true;
                break;
            }
        }
        if found == c.negate {
            return Ok(false);
        }
    }
    Ok(true)
}
