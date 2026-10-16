//! One-off, deleted with `src/migrations/recompute-search-maxima.js` once that has run: every term's block maxima
//! recomputed from its postings and lengths with this build's reference lengths, so each map holds what a store
//! built from nothing with them holds. Nothing in the server calls it.
//!
//! A pass walks every posting block in key order, a slice per job. Per term, a level-0 map is computed per group
//! of blocks and each level above from the finished maps below it; a map is written (or deleted) only where it
//! differs from the stored one. Stored maps no document is under (between finished groups, past the last, or of a
//! term with no postings) are deleted.

use std::collections::BTreeMap;

use super::index::block_want;
use super::{
    LEVELS, NODE_SLOT_BITS, Scope, block_maxima, block_maxima_at, block_maxima_of, max_slot,
};
use crate::keyspace::val::{get_bytes, get_u64, map_bytes, map_pairs};
use crate::store::StoreError;
use crate::store::derive::{Out, View};
use crate::store::kinds::key;

/// Posting blocks a slice reads at most, as the binding runs it.
pub const SLICE_BLOCKS: usize = 512;

/// Stored maps read per page when deleting.
const PAGE: usize = 256;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Counts {
    pub posting_blocks: u64,
    /// Maxima maps written or deleted (in a dry run, that would be).
    pub entries: u64,
    /// Slots that held less than their documents score: where searches could miss results.
    pub raised: u64,
    /// Slots that held more, or that no document is under.
    pub lowered: u64,
    /// Slots no stored map had.
    pub added: u64,
}

/// A map being built: its group and slots.
type Building = Option<(u64, BTreeMap<u32, u32>)>;

struct Term {
    scope: Scope,
    term: String,
    /// Pair postings (`pairs`) have no maxima.
    pair: bool,
    /// Per level.
    building: Vec<Building>,
    /// Per level: the last group finished.
    finished: Vec<Option<u64>>,
}

pub struct Pass {
    dry: bool,
    /// Posting blocks a slice reads at most.
    slice: usize,
    /// The posting key the next slice starts at.
    from: Vec<u8>,
    /// The first maxima key past the last term finished.
    done_to: Vec<u8>,
    term: Option<Term>,
    pub counts: Counts,
}

fn bad(what: &str) -> StoreError {
    StoreError::Entry(format!("{what} doesn't decode"))
}

/// The scope, term and block of a posting block's key.
fn parse_posting(k: &[u8]) -> Result<(Scope, String, u64), StoreError> {
    let mut at = key::of(key::SEARCH_POSTING).len();
    let kind = get_u64(k, &mut at);
    let owner = get_u64(k, &mut at);
    let term = get_bytes(k, &mut at).and_then(|t| String::from_utf8(t).ok());
    let block = get_u64(k, &mut at);
    match (kind, owner, term, block) {
        (Some(kind), Some(owner), Some(term), Some(block)) if at == k.len() => {
            Ok((Scope { kind, owner }, term, block))
        }
        _ => Err(bad("a posting key")),
    }
}

impl Pass {
    pub fn new(dry: bool, slice: usize) -> Pass {
        Pass {
            dry,
            slice,
            from: key::of(key::SEARCH_POSTING),
            done_to: key::of(key::SEARCH_BLOCK_MAX),
            term: None,
            counts: Counts::default(),
        }
    }

    /// One slice; whether more follow.
    pub fn step(&mut self, view: &View, out: &mut Out) -> Result<bool, StoreError> {
        let end = key::prefix_end(&key::of(key::SEARCH_POSTING));
        let page = view.scan(&self.from, &end, self.slice)?;
        for (k, _) in &page {
            let (scope, term, block) = parse_posting(k)?;
            if self
                .term
                .as_ref()
                .is_none_or(|t| t.scope != scope || t.term != term)
            {
                self.finish_term(view, out)?;
                // The terms between the last one and this hold no postings.
                let (from, to) = (self.done_to.clone(), block_maxima_of(scope, &term));
                self.delete(view, out, from, &to)?;
                self.term = Some(Term {
                    scope,
                    pair: term.contains(super::pairs::SEPARATOR),
                    term,
                    building: vec![None; LEVELS],
                    finished: vec![None; LEVELS],
                });
            }
            self.counts.posting_blocks += 1;
            let t = self.term.as_ref().unwrap();
            if t.pair {
                continue;
            }
            let want = block_want(view, scope, &t.term, block)?;
            if want.is_empty() {
                continue;
            }
            let (group, first) = max_slot(block, false);
            let slots = want.into_iter().map(|(sub, b)| (first + sub, b)).collect();
            self.feed(view, out, 0, group, slots)?;
        }
        // A page may come back short of the limit before the end: only an empty one ends the pass.
        if let Some((k, _)) = page.last() {
            self.from = k.clone();
            self.from.push(0);
            return Ok(true);
        }
        self.finish_term(view, out)?;
        let from = self.done_to.clone();
        self.delete(
            view,
            out,
            from,
            &key::prefix_end(&key::of(key::SEARCH_BLOCK_MAX)),
        )?;
        Ok(false)
    }

    /// Adds slots to the map being built at `level` for `group`, finishing the one before it first.
    fn feed(
        &mut self,
        view: &View,
        out: &mut Out,
        level: usize,
        group: u64,
        slots: Vec<(u32, u32)>,
    ) -> Result<(), StoreError> {
        let building = &mut self.term.as_mut().unwrap().building[level];
        if building.as_ref().is_some_and(|b| b.0 != group) {
            let done = building.take().unwrap();
            self.finish(view, out, level, done)?;
        }
        let building = &mut self.term.as_mut().unwrap().building[level];
        let m = &mut building.get_or_insert_with(|| (group, BTreeMap::new())).1;
        for (s, b) in slots {
            let w = m.entry(s).or_insert(b);
            *w = (*w).max(b);
        }
        Ok(())
    }

    /// Writes a finished map where it differs from the stored one, after deleting its level's stored maps since the
    /// last one finished, and feeds the level-(ℓ+1) node `group` the most of its slots per sub (nothing over group
    /// 0: `top_level`).
    fn finish(
        &mut self,
        view: &View,
        out: &mut Out,
        level: usize,
        (group, m): (u64, BTreeMap<u32, u32>),
    ) -> Result<(), StoreError> {
        let t = self.term.as_ref().unwrap();
        let (scope, term) = (t.scope, t.term.clone());
        let from = match t.finished[level] {
            Some(g) => block_maxima(scope, &term, level as u64, g + 1),
            None => block_maxima_at(scope, &term, level as u64),
        };
        let k = block_maxima(scope, &term, level as u64, group);
        self.delete(view, out, from, &k)?;
        let now: Vec<(u32, u32)> = m.into_iter().collect();
        let stored = match view.get(&k)? {
            Some(b) => map_pairs(&b).ok_or_else(|| bad("a maxima map"))?,
            None => Vec::new(),
        };
        self.compare(out, k, &stored, &now);
        self.term.as_mut().unwrap().finished[level] = Some(group);
        if level + 1 < LEVELS && group != 0 {
            let mut above: BTreeMap<u32, u32> = BTreeMap::new();
            for &(s, b) in &now {
                let w = above.entry(s & ((1 << NODE_SLOT_BITS) - 1)).or_insert(b);
                *w = (*w).max(b);
            }
            let (g, first) = max_slot(group, false);
            let slots = above.into_iter().map(|(sub, b)| (first + sub, b)).collect();
            self.feed(view, out, level + 1, g, slots)?;
        }
        Ok(())
    }

    /// Counts how `stored` differs from `now` and, unless dry, writes `now` (an empty one deletes the map).
    fn compare(&mut self, out: &mut Out, k: Vec<u8>, stored: &[(u32, u32)], now: &[(u32, u32)]) {
        let stored: BTreeMap<u32, u32> = stored.iter().copied().filter(|p| p.1 != 0).collect();
        let now_m: BTreeMap<u32, u32> = now.iter().copied().collect();
        if stored == now_m {
            return;
        }
        for (s, &b) in &now_m {
            match stored.get(s) {
                None => self.counts.added += 1,
                Some(&o) if o < b => self.counts.raised += 1,
                Some(&o) if o > b => self.counts.lowered += 1,
                Some(_) => {}
            }
        }
        self.counts.lowered += stored.keys().filter(|s| !now_m.contains_key(s)).count() as u64;
        self.counts.entries += 1;
        if self.dry {
            return;
        }
        if now.is_empty() {
            out.del(k);
        } else {
            out.put(k, map_bytes(now));
        }
    }

    /// Deletes the stored maxima maps in `[from, to)`.
    fn delete(
        &mut self,
        view: &View,
        out: &mut Out,
        mut from: Vec<u8>,
        to: &[u8],
    ) -> Result<(), StoreError> {
        while from.as_slice() < to {
            let page = view.scan(&from, to, PAGE)?;
            for (k, v) in &page {
                let stored = map_pairs(v).ok_or_else(|| bad("a maxima map"))?;
                self.compare(out, k.clone(), &stored, &[]);
            }
            let Some((k, _)) = page.last() else {
                break;
            };
            from = k.clone();
            from.push(0);
        }
        Ok(())
    }

    /// Finishes each level's map being built, lowest first, then deletes the term's stored maps past each level's
    /// last finished one and at levels no build writes.
    fn finish_term(&mut self, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let Some(t) = self.term.as_ref() else {
            return Ok(());
        };
        let (scope, term) = (t.scope, t.term.clone());
        for level in 0..LEVELS {
            if let Some(b) = self.term.as_mut().unwrap().building[level].take() {
                self.finish(view, out, level, b)?;
            }
        }
        for level in 0..LEVELS {
            let from = match self.term.as_ref().unwrap().finished[level] {
                Some(g) => block_maxima(scope, &term, level as u64, g + 1),
                None => block_maxima_at(scope, &term, level as u64),
            };
            let to = key::prefix_end(&block_maxima_at(scope, &term, level as u64));
            self.delete(view, out, from, &to)?;
        }
        let end = key::prefix_end(&block_maxima_of(scope, &term));
        self.delete(
            view,
            out,
            block_maxima_at(scope, &term, LEVELS as u64),
            &end,
        )?;
        self.done_to = end;
        self.term = None;
        Ok(())
    }
}
