//! A tree's chats searched (design S5), as two searches; neither reads a whole path:
//!
//! - Messages: the tree's messages a query matches, best first, from the owner's chat postings (whole words; a
//!   closed-quote phrase as a phrase). On top, a substring scan (upstream's match: each clause's text, lower-cased,
//!   inside the message's text; a negated one in none) reads messages newest first, a message's text at a time,
//!   under a cap of text bytes (`SCAN_BYTES`), answering the ones whole words don't match; where it stopped is a
//!   cursor a scan-only read goes on from.
//! - The chat list (a tree's bookmarks, and a tab's session there when it has no current chat there): an item
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

fn query(
    scope: Scope,
    clauses: Vec<Clause>,
    limit: usize,
    after: Option<(f64, u64)>,
    weights: Option<Vec<f64>>,
) -> Query {
    Query {
        scope,
        clauses,
        filters: Vec::new(),
        order: Order::Relevance,
        limit,
        after: after.map(|(s, d)| After::Score(s, d)),
        weights,
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

/// The substring clauses: each clause's text as the scan matches it (`scan_text`), and whether it is negated.
fn substrings(clauses: &[Clause]) -> Vec<(bool, String)> {
    clauses
        .iter()
        .filter_map(|c| {
            let t = scan_text(c);
            (!t.is_empty()).then_some((c.negate, t))
        })
        .collect()
}

/// A clause's text as a substring: lower-cased and trimmed, a leading dash dropped (a chat query has no negation:
/// the index reads `-foo` as the word `foo`). A phrase's quotes aren't in its text.
fn scan_text(c: &Clause) -> String {
    let t = lower(&c.text);
    let t = t.trim();
    t.strip_prefix('-').unwrap_or(t).trim().to_string()
}

/// The chat list scan's substrings: the positive clauses' texts as one (the query without its search syntax),
/// and each negated one's.
fn list_substrings(clauses: &[Clause]) -> Vec<(bool, String)> {
    let whole: Vec<String> = clauses
        .iter()
        .filter(|c| !c.negate)
        .map(scan_text)
        .filter(|t| !t.is_empty())
        .collect();
    let mut out = Vec::new();
    if !whole.is_empty() {
        out.push((false, whole.join(" ")));
    }
    out.extend(substrings(clauses).into_iter().filter(|s| s.0));
    out
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
#[derive(Debug, Clone)]
pub enum Start {
    /// `after`: the last hit before, and `weights` the idfs ranked by, as `Messages::next` gives them.
    Index {
        after: Option<(f64, u64)>,
        weights: Option<Vec<f64>>,
    },
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
    /// With `more`, a later index page's `after`: the last hit's rank (`query::Hit::rank`) and message, and the
    /// idfs ranked by (`query::Found::weights`).
    pub next: Option<(f64, u64)>,
    pub weights: Option<Vec<f64>>,
    pub total: u64,
    pub total_exact: bool,
    /// The scan stopped (at its cap, at `limit` or at `WORK`): messages below this one are still to scan.
    pub scan: Option<u64>,
    /// The search's reports of blocks with maxima too high (`query::Found::tighten`).
    pub tighten: Vec<crate::search::query::Tighten>,
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
    // Messages of a subtree being deleted read as deleted.
    let pending = super::prune::pending_in(view, tree)?;
    let below = match start {
        Start::Index { after, weights } => {
            if !words.is_empty() {
                let f = crate::search::query::run(
                    view,
                    &query(scope, words.clone(), limit, after, weights),
                    cache,
                    &Default::default(),
                )?;
                work += f.work;
                out.more = f.more;
                out.total = f.total;
                out.total_exact = f.total_exact;
                out.tighten = f.tighten;
                let mut hits = f.hits;
                if pending {
                    let mut kept = Vec::new();
                    for h in hits {
                        if !super::prune::doomed(view, tree, h.doc)? {
                            kept.push(h);
                        }
                    }
                    hits = kept;
                    out.total_exact = false;
                }
                out.next = hits.last().filter(|_| out.more).map(|h| (h.rank, h.doc));
                out.weights = out.next.and(f.weights);
                out.hits = hits.iter().map(|h| (h.doc, h.score)).collect();
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
    let words_match = if words.is_empty() {
        None
    } else {
        Some(Matching::new(
            view,
            &query(scope, words, 0, None, None),
            cache,
            crate::search::query::Take::All,
            &Default::default(),
        )?)
    };
    let mut sink = MessageSink {
        view,
        tree,
        subs,
        pending,
        words_match,
        limit,
        scanned: Vec::new(),
    };
    out.scan = scan_texts(view, tree, below, scan_bytes, &mut work, &mut sink)?;
    out.scanned = sink.scanned;
    Ok(out)
}

/// What a text scan (`scan_texts`) feeds: it is asked for each message's text, newest first.
trait ScanSink {
    /// Work the sink itself has spent.
    fn extra_work(&self) -> u64;
    /// Whether the sink wants no more messages.
    fn full(&self) -> bool;
    fn take(&mut self, message: u64, text: &[u8]) -> Result<(), StoreError>;
}

/// Reads the tree's messages' texts below `below`, newest first, a message at a time, under a cap of text bytes
/// (`scan_bytes`), `WORK` and the sink's wish, handing each to the sink. Returns where it stopped early (the
/// cursor: messages below it are still to read), or None when it read them all.
fn scan_texts(
    view: &View,
    tree: u64,
    below: u64,
    scan_bytes: u64,
    work: &mut u64,
    sink: &mut dyn ScanSink,
) -> Result<Option<u64>, StoreError> {
    // The scope's length entries list the messages with text, LENGTH_BITS of ids an entry; read last first.
    let p = lengths(Scope::chat(tree));
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
        *work += crate::search::query::SEEK;
        let batch = view.scan_vals_rev(&p, &to, 64)?;
        let Some((last, _)) = batch.last() else {
            return Ok(None);
        };
        to = last.clone();
        let full = batch.len() == 64;
        for (k, v) in batch {
            let mut at = p.len();
            let block = get_u64(&k, &mut at)
                .ok_or_else(|| StoreError::Entry("a length key doesn't decode".into()))?;
            let mut docs: Vec<u64> = v
                .into_pairs(&k)
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
                let spent = *work + scanned / 32 + sink.extra_work();
                if scanned > scan_bytes || sink.full() || spent > WORK {
                    // `m` isn't read: the next scan starts with it.
                    return Ok(Some(m + 1));
                }
                let t = kinds::text_value_of(view, Holder::Message(m), &FieldRef::Code(chat::MES))?
                    .unwrap_or_default();
                *work += READ;
                scanned += t.len() as u64 + SCAN_MESSAGE;
                sink.take(m, &t)?;
            }
        }
        if !full {
            return Ok(None);
        }
    }
}

/// A message search's scan: the messages holding every positive substring and no negated one that whole words
/// don't match.
struct MessageSink<'a> {
    view: &'a View<'a>,
    tree: u64,
    subs: Vec<(bool, String)>,
    pending: bool,
    words_match: Option<Matching<'a>>,
    limit: usize,
    scanned: Vec<u64>,
}

impl ScanSink for MessageSink<'_> {
    fn extra_work(&self) -> u64 {
        self.words_match.as_ref().map_or(0, |w| w.work())
    }
    fn full(&self) -> bool {
        self.scanned.len() == self.limit
    }
    fn take(&mut self, m: u64, text: &[u8]) -> Result<(), StoreError> {
        if !holds(&self.subs, text)
            || (self.pending && super::prune::doomed(self.view, self.tree, m)?)
        {
            return Ok(());
        }
        // Whole words found it: the index answers it.
        if let Some(w) = &mut self.words_match
            && w.matches(m)?
        {
            return Ok(());
        }
        self.scanned.push(m);
        Ok(())
    }
}

// ---- the chat list ----

/// An item of a tree's chat list: a bookmark, or a tab's session; at a message (None: the tree's root).
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub bookmark: Option<u64>,
    pub session: Option<u64>,
    pub at: Option<u64>,
    /// Its place in the list: (time key, bookmark), the session's (time key, `u64::MAX`).
    pub key: (u64, u64),
}

#[derive(Debug, Default)]
pub struct ListPage {
    pub hits: Vec<Item>,
    /// Items follow: read on `after` `next`.
    pub more: bool,
    pub next: Option<(u64, u64)>,
    /// Every match was weighed (not cut by `WORK`, no depth rewrite under way).
    pub exact: bool,
    /// From the scan, newest messages first: items whose path holds the query's text, that the index and names
    /// don't match.
    pub scanned: Vec<Item>,
    /// The scan stopped (at its cap, or at `WORK`): messages below this one are still to scan.
    pub scan: Option<u64>,
}

/// Where a chat list search starts: the items, from after a key (and the scan from the newest message when that
/// is the first page), or the scan alone from below a message (a `ListPage::scan` cursor).
#[derive(Debug, Clone, Copy)]
pub enum ListStart {
    Items { after: Option<(u64, u64)> },
    ScanBelow(u64),
}

/// The substring scan of a chat list search: the cap of text bytes it reads.
#[derive(Debug, Clone)]
pub struct ListScan {
    pub bytes: u64,
}

/// A clause's matching messages by depth.
struct Candidates {
    negate: bool,
    /// Depths, deepest first, each with its messages.
    by_depth: Vec<(u64, HashSet<u64>)>,
}

/// The items of the tree's chat list whose name or path matches, up to `limit`, newest first: the tree's bookmarks
/// by the receive time of the message each is at (one at the root by when it was made), and the tab's session by its
/// pointer's message's (at the root: by when it got there) when it is in the tree and has no current chat there
/// (`sessions::current_chat`; before bookmarks of the same time). `start` is where to read from (`Item::key` of the
/// last item read before).
///
/// With a `scan`, a first page (or the scan alone, `ListStart::ScanBelow`) also scans the tree's messages' texts
/// for the query's text without its search syntax as a substring (`list_substrings`, `scan_texts`); every item whose path holds a message found, that the
/// index and names didn't match, is in `scanned` (all of them, under `WORK`).
#[allow(clippy::too_many_arguments)]
pub fn chat_list(
    view: &View,
    tree: u64,
    clauses: &[Clause],
    session: Option<u64>,
    start: ListStart,
    limit: usize,
    scan: Option<ListScan>,
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
    let mut index_hit = |item: &Item,
                         name: &[u8],
                         work: &mut u64,
                         reads: &mut u64,
                         exact: &mut bool|
     -> Result<bool, StoreError> {
        let by_name = !name.is_empty() && !subs.is_empty() && holds(&subs, name);
        Ok(clauses.is_empty()
            || by_name
            || (!words.is_empty()
                && path_holds(
                    view, tree, &words, item.at, &mut cands, work, reads, cache, exact,
                )?))
    };
    let after = match start {
        ListStart::Items { after } => after,
        ListStart::ScanBelow(_) => None,
    };
    if matches!(start, ListStart::Items { .. }) {
        walk(
            view,
            tree,
            session,
            after,
            limit,
            &mut work,
            &mut reads,
            &mut out,
            &mut index_hit,
        )?;
    }
    let scan_subs = list_substrings(clauses);
    let Some(scan) = scan.filter(|_| scan_subs.iter().any(|s| !s.0) && after.is_none()) else {
        return Ok(out);
    };
    let below = match start {
        ListStart::ScanBelow(m) => m,
        ListStart::Items { .. } => u64::MAX,
    };
    let mut sink = TextSink {
        view,
        tree,
        subs: scan_subs,
        pending: super::prune::pending_in(view, tree)?,
        found: Vec::new(),
    };
    let mut swork = work + reads * READ;
    out.scan = scan_texts(view, tree, below, scan.bytes, &mut swork, &mut sink)?;
    if sink.found.is_empty() {
        return Ok(out);
    }
    let mut sreads = 0u64;
    let by_depth = by_depth(view, &sink.found, &mut sreads)?;
    let found = [Candidates {
        negate: false,
        by_depth,
    }];
    let mut mapped = ListPage {
        exact: out.exact,
        ..ListPage::default()
    };
    walk(
        view,
        tree,
        session,
        None,
        usize::MAX,
        &mut swork,
        &mut sreads,
        &mut mapped,
        &mut |item, name, work, reads, exact| {
            let Some(at) = item.at else {
                return Ok(false);
            };
            // Matched by the index or its name: that answer has it.
            Ok(holds_any(view, at, &found, reads)? && !index_hit(item, name, work, reads, exact)?)
        },
    )?;
    out.exact &= mapped.exact;
    out.scanned = mapped.hits;
    Ok(out)
}

/// A chat list search's scan: the messages holding the query's text, newest first.
struct TextSink<'a> {
    view: &'a View<'a>,
    tree: u64,
    subs: Vec<(bool, String)>,
    pending: bool,
    found: Vec<u64>,
}

impl ScanSink for TextSink<'_> {
    fn extra_work(&self) -> u64 {
        0
    }
    fn full(&self) -> bool {
        false
    }
    fn take(&mut self, m: u64, text: &[u8]) -> Result<(), StoreError> {
        if holds(&self.subs, text)
            && !(self.pending && super::prune::doomed(self.view, self.tree, m)?)
        {
            self.found.push(m);
        }
        Ok(())
    }
}

/// Whether an item is a hit: its place, its name, then work, reads and whether the answer is exact so far.
type Hit<'a> =
    dyn FnMut(&Item, &[u8], &mut u64, &mut u64, &mut bool) -> Result<bool, StoreError> + 'a;

/// Walks the tree's chat list from after `after`, newest first, putting the items `hit` accepts in `out.hits` up to
/// `limit` (then `out.more` and `out.next`), or until `WORK` is spent (then `out.exact` is false too).
#[allow(clippy::too_many_arguments)]
fn walk(
    view: &View,
    tree: u64,
    session: Option<u64>,
    after: Option<(u64, u64)>,
    limit: usize,
    work: &mut u64,
    reads: &mut u64,
    out: &mut ListPage,
    hit: &mut Hit,
) -> Result<(), StoreError> {
    let mut items: Vec<(Item, Vec<u8>)> = Vec::new();
    let mut shown_session = match session {
        Some(s) if sessions::current_chat(view, s, tree)?.is_some() => None,
        Some(s) => match sessions::session_tree_entry(view, s, tree)? {
            Some((Some(m), _)) => {
                let tk = sessions::time_key(chat::message_time(view, m)?);
                Some((s, Some(m), (tk, u64::MAX)))
            }
            Some((None, tk)) => {
                let tk =
                    tk.ok_or_else(|| StoreError::Entry("a session at a root has no time".into()))?;
                Some((s, None, (tk, u64::MAX)))
            }
            None => None,
        },
        None => None,
    }
    .filter(|(_, _, key)| after.is_none_or(|a| *key < a));
    let mut last = after;
    let p = kinds::key::id(kinds::key::TREE_BOOKMARK_TIME, tree);
    let mut end = match after {
        Some((tk, b)) => {
            let mut k = kinds::key::ids(kinds::key::TREE_BOOKMARK_TIME, tree, tk);
            crate::keyspace::val::put_u64(&mut k, b);
            k
        }
        None => kinds::key::prefix_end(&p),
    };
    loop {
        let batch = view.scan_vals_rev(&p, &end, 64)?;
        *work += crate::search::query::SEEK + batch.len() as u64;
        let full = batch.len() == 64;
        for (k, _) in &batch {
            let mut at = p.len();
            let bad = || StoreError::Entry("a bookmark time key doesn't decode".into());
            let tk = get_u64(k, &mut at).ok_or_else(bad)?;
            let b = get_u64(k, &mut at).ok_or_else(bad)?;
            if let Some((s, sat, key)) = shown_session
                && key > (tk, b)
            {
                *reads += 3;
                let name = super::searched::position_name(view, s)?.unwrap_or_default();
                items.push((
                    Item {
                        bookmark: None,
                        session: Some(s),
                        at: sat,
                        key,
                    },
                    name,
                ));
                shown_session = None;
            }
            *reads += 2;
            let name = super::searched::position_name(view, b)?.unwrap_or_default();
            items.push((
                Item {
                    bookmark: Some(b),
                    session: None,
                    at: chat::bookmark_at(view, b)?,
                    key: (tk, b),
                },
                name,
            ));
        }
        if !full && let Some((s, sat, key)) = shown_session.take() {
            *reads += 3;
            let name = super::searched::position_name(view, s)?.unwrap_or_default();
            items.push((
                Item {
                    bookmark: None,
                    session: Some(s),
                    at: sat,
                    key,
                },
                name,
            ));
        }
        if let Some((k, _)) = batch.last() {
            end = k.clone();
        }
        for (item, name) in items.drain(..) {
            let capped = *work + *reads * READ > WORK;
            if capped || out.hits.len() == limit {
                out.more = true;
                out.exact &= !capped;
                // The next page starts with this item.
                out.next = last;
                return Ok(());
            }
            last = Some(item.key);
            if hit(&item, &name, work, reads, &mut out.exact)? {
                out.hits.push(item);
            }
        }
        if !full {
            return Ok(());
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
                &query(Scope::chat(tree), vec![plain], 0, None, None),
                cache,
                budget,
            )?;
            *work += w;
            *exact &= complete;
            let by_depth = by_depth(view, &docs, reads)?;
            all.push(Candidates {
                negate: c.negate,
                by_depth,
            });
        }
        *cands = Some(all);
    }
    holds_any(view, at, cands.as_ref().expect("read above"), reads)
}

/// Messages grouped by depth, deepest first.
fn by_depth(
    view: &View,
    docs: &[u64],
    reads: &mut u64,
) -> Result<Vec<(u64, HashSet<u64>)>, StoreError> {
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
    Ok(by_depth)
}

/// Whether the path down to `at` holds, for each of `cands`, a message of it (or none, if it is negated).
fn holds_any(
    view: &View,
    at: u64,
    cands: &[Candidates],
    reads: &mut u64,
) -> Result<bool, StoreError> {
    *reads += 1;
    let Some((d0, j0)) = sessions::depth_jump(view, at)? else {
        return Ok(false);
    };
    for c in cands {
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
