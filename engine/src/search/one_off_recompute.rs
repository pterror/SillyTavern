//! One-off, deleted with `src/migrations/recompute-search-maxima.js` once that has run: every term's block maxima
//! recomputed from its postings and lengths with this build's reference lengths, so each map holds what a store
//! built from nothing with them holds. Nothing in the server calls it.
//!
//! One pass reads every posting block in key order, from the keyspace as it stood when the pass began (`Src`).
//! Per term, a level-0 map is computed per group of blocks and each level above from the finished maps below it; a
//! map is written (or deleted) only where it differs from the stored one. Stored maps no document is under
//! (between finished groups, past the last, or of a term with no postings) are deleted.
//!
//! Every read goes through a forward cursor (`Cur`) whose keys each structure is asked for in ascending order:
//! the postings; the lengths, from each term's first document on; the stored maxima of each level (level 0's also
//! taking the ranges between terms and past the last level); and per term kind, the tag carriers and heavy and
//! moving tags by term. Only the member blocks of heavy and moving tags are point reads.

use std::collections::BTreeMap;
use std::sync::Arc;

use super::index::want_of;
use super::{
    BLOCK_BITS, LEVELS, NODE_SLOT_BITS, Scope, TermKind, block_maxima, block_maxima_at,
    block_maxima_of, length_block, max_slot, readings, tag_field,
};
use crate::keyspace::run::{Merge, Run, RunIter, Source};
use crate::keyspace::val::{Val, fold, get_bytes, get_u64, map_bytes, put_u64};
use crate::keyspace::{Keyspace, KsResult};
use crate::store::StoreError;
use crate::store::kinds::key;

/// Bytes of changed maps a write holds at most, as the binding runs it.
pub const BATCH_BYTES: usize = 8 << 20;

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

/// Maps to write, each with its new value (None deletes it).
pub type Batch = Vec<(Vec<u8>, Option<Vec<u8>>)>;

fn bad(what: &str) -> StoreError {
    StoreError::Entry(format!("{what} doesn't decode"))
}

/// The structures the pass reads.
fn read_prefixes() -> [Vec<u8>; 7] {
    [
        key::of(key::SEARCH_POSTING),
        key::of(key::SEARCH_LENGTH),
        key::of(key::SEARCH_BLOCK_MAX),
        key::TAG_CARRIERS.prefix(),
        key::of(key::TERM_HEAVY),
        key::of(key::TERM_MOVING),
        key::of(key::MEMBER_BLOCK),
    ]
}

/// The keyspace as it stood once: its runs, and copies of its buffers' entries in the structures the pass reads
/// (newest buffer first). Writes made after it was taken are not read.
pub struct Src<'a> {
    ks: &'a Keyspace,
    mems: Vec<Arc<Vec<(Vec<u8>, Val)>>>,
    runs: Vec<Arc<Run>>,
}

impl<'a> Src<'a> {
    pub fn new(ks: &'a Keyspace) -> Src<'a> {
        let v = ks.version();
        let mems = v
            .mems
            .iter()
            .map(|m| {
                let m = m.read().unwrap();
                let mut out = Vec::new();
                for p in read_prefixes() {
                    let end = key::prefix_end(&p);
                    out.extend(m.range(&p, &end).map(|(k, v)| (k.to_vec(), v)));
                }
                out.sort_by(|a, b| a.0.cmp(&b.0));
                Arc::new(out)
            })
            .collect();
        Src {
            ks,
            mems,
            runs: v.runs.clone(),
        }
    }

    /// The settled value of `key`.
    fn get(&self, key: &[u8]) -> KsResult<Option<Val>> {
        let mut vals = Vec::new();
        for m in &self.mems {
            if let Ok(i) = m.binary_search_by(|e| e.0.as_slice().cmp(key)) {
                let v = m[i].1.clone();
                let done = !v.is_partial();
                vals.push(v);
                if done {
                    return Ok(fold(key, vals).and_then(|v| v.settled(key)));
                }
            }
        }
        for r in &self.runs {
            if let Some(v) = r.get(key, self.ks.cache(), &self.ks.counts)? {
                let done = !v.is_partial();
                vals.push(v);
                if done {
                    break;
                }
            }
        }
        Ok(fold(key, vals).and_then(|v| v.settled(key)))
    }
}

/// A buffer's copied entries from a key on.
struct MemSource {
    entries: Arc<Vec<(Vec<u8>, Val)>>,
    at: usize,
}

impl Source for MemSource {
    fn key(&self) -> Option<&[u8]> {
        self.entries.get(self.at).map(|e| e.0.as_slice())
    }

    fn val(&self) -> KsResult<Val> {
        Ok(self.entries[self.at].1.clone())
    }

    fn advance(&mut self) -> KsResult<()> {
        self.at += 1;
        Ok(())
    }

    fn seek(&mut self, target: &[u8]) -> KsResult<()> {
        self.at += self.entries[self.at.min(self.entries.len())..]
            .partition_point(|e| e.0.as_slice() < target);
        Ok(())
    }
}

/// A forward cursor over a `Src`: seeking ahead stays in the blocks it holds where it can; a seek behind where it
/// stands opens it again there.
struct Cur<'a> {
    src: &'a Src<'a>,
    merge: Merge<'a>,
    /// Nothing before it is left in `merge`.
    at: Vec<u8>,
    /// The last key `get` read, and what it found.
    got: Option<(Vec<u8>, Option<Val>)>,
}

impl<'a> Cur<'a> {
    fn open(src: &'a Src<'a>, from: &[u8]) -> KsResult<Cur<'a>> {
        Ok(Cur {
            src,
            merge: Self::merge(src, from)?,
            at: from.to_vec(),
            got: None,
        })
    }

    fn merge(src: &'a Src<'a>, from: &[u8]) -> KsResult<Merge<'a>> {
        let mut sources: Vec<Box<dyn Source + 'a>> = Vec::new();
        for m in &src.mems {
            let at = m.partition_point(|e| e.0.as_slice() < from);
            sources.push(Box::new(MemSource {
                entries: m.clone(),
                at,
            }));
        }
        for r in &src.runs {
            if from <= r.max_key.as_slice() {
                sources.push(Box::new(RunIter::new(
                    r.clone(),
                    from,
                    Some(src.ks.cache()),
                    Some(&src.ks.counts),
                )?));
            }
        }
        Ok(Merge::new(sources))
    }

    fn seek(&mut self, target: &[u8]) -> KsResult<()> {
        if target < self.at.as_slice() {
            self.merge = Self::merge(self.src, target)?;
        } else {
            self.merge.seek(target)?;
        }
        self.at.clear();
        self.at.extend_from_slice(target);
        Ok(())
    }

    /// The next key before `end` that has a value, with its value settled.
    fn next_until(&mut self, end: &[u8]) -> KsResult<Option<(Vec<u8>, Val)>> {
        while self.merge.peek().is_some_and(|k| k < end) {
            let (k, v) = self.merge.next_entry()?.unwrap();
            self.at.clone_from(&k);
            self.at.push(0);
            if let Some(v) = v.settled(&k) {
                return Ok(Some((k, v)));
            }
        }
        Ok(None)
    }

    /// The settled value of `key`.
    fn get(&mut self, key: &[u8]) -> KsResult<Option<Val>> {
        self.seek(key)?;
        let mut end = key.to_vec();
        end.push(0);
        Ok(self.next_until(&end)?.map(|(_, v)| v))
    }

    /// `get`, kept for a `key` asked for again.
    fn get_kept(&mut self, key: &[u8]) -> KsResult<Option<Val>> {
        if let Some((k, v)) = &self.got
            && k.as_slice() == key
        {
            return Ok(v.clone());
        }
        let v = self.get(key)?;
        self.got = Some((key.to_vec(), v.clone()));
        Ok(v)
    }
}

/// A settled map's pairs.
fn pairs_of(k: &[u8], v: Option<Val>, what: &str) -> Result<Vec<(u32, u32)>, StoreError> {
    match v {
        Some(v) => v.into_pairs(k).ok_or_else(|| bad(what)),
        None => Ok(Vec::new()),
    }
}

/// A map being built: its group and slots.
type Building = Option<(u64, BTreeMap<u32, u32>)>;

/// Per reading of a term, the heavy and moving tags whose names hold it, each with the last member block of it
/// read (its block, and the documents there that carry it).
type Heavy = Vec<(u64, Option<(u64, Vec<u64>)>)>;

struct Term {
    scope: Scope,
    term: String,
    /// Pair postings (`pairs`) have no maxima.
    pair: bool,
    /// Per level.
    building: Vec<Building>,
    /// Per level: the last group finished.
    finished: Vec<Option<u64>>,
    /// Per reading (`readings`), read at the term's first block when its scope has a tag field.
    heavy: Option<Vec<(bool, Heavy)>>,
}

/// Per term kind (`TermKind as usize`): the tag carriers, heavy and moving tags by term.
struct TagCurs<'a> {
    carriers: [Cur<'a>; 2],
    heavy: [Cur<'a>; 2],
    moving: [Cur<'a>; 2],
}

struct Pass<'a, E> {
    src: &'a Src<'a>,
    dry: bool,
    /// Bytes of maps a write holds at most.
    batch: usize,
    emit: E,
    out: Batch,
    out_bytes: usize,
    /// The first maxima key past the last term finished.
    done_to: Vec<u8>,
    term: Option<Term>,
    /// Per level, the stored maxima; level 0's also reads the ranges no level's holds.
    maxima: Vec<Cur<'a>>,
    lengths: Cur<'a>,
    tags: TagCurs<'a>,
    counts: Counts,
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

fn term_kind(as_prefix: bool) -> TermKind {
    if as_prefix {
        TermKind::Gram
    } else {
        TermKind::Exact
    }
}

/// Recomputes every term's block maxima over `src`, handing each batch of changed maps to `emit` (none when `dry`)
/// once it holds `batch` bytes, and the rest at the end.
pub fn run<'a>(
    src: &'a Src<'a>,
    dry: bool,
    batch: usize,
    emit: impl FnMut(Batch) -> Result<(), StoreError>,
) -> Result<Counts, StoreError> {
    let posting_start = key::of(key::SEARCH_POSTING);
    let maxima_start = key::of(key::SEARCH_BLOCK_MAX);
    let cur = |p: &[u8]| Cur::open(src, p);
    let kinds = |s: u64| -> KsResult<[Cur<'a>; 2]> {
        Ok([
            cur(&key::term_key(s, TermKind::Exact, ""))?,
            cur(&key::term_key(s, TermKind::Gram, ""))?,
        ])
    };
    let carriers_at = |kind: TermKind| key::tag_carriers_of(kind, "");
    let mut p = Pass {
        src,
        dry,
        batch,
        emit,
        out: Vec::new(),
        out_bytes: 0,
        done_to: maxima_start.clone(),
        term: None,
        maxima: (0..LEVELS)
            .map(|_| cur(&maxima_start))
            .collect::<KsResult<_>>()?,
        lengths: cur(&key::of(key::SEARCH_LENGTH))?,
        tags: TagCurs {
            carriers: [
                cur(&carriers_at(TermKind::Exact))?,
                cur(&carriers_at(TermKind::Gram))?,
            ],
            heavy: kinds(key::TERM_HEAVY)?,
            moving: kinds(key::TERM_MOVING)?,
        },
        counts: Counts::default(),
    };
    let mut postings = cur(&posting_start)?;
    let end = key::prefix_end(&posting_start);
    while let Some((k, v)) = postings.next_until(&end)? {
        let (scope, term, block) = parse_posting(&k)?;
        if p.term
            .as_ref()
            .is_none_or(|t| t.scope != scope || t.term != term)
        {
            p.finish_term()?;
            // The terms between the last one and this hold no postings.
            let (from, to) = (p.done_to.clone(), block_maxima_of(scope, &term));
            p.delete(0, from, &to)?;
            p.term = Some(Term {
                scope,
                pair: term.contains(super::pairs::SEPARATOR),
                term,
                building: vec![None; LEVELS],
                finished: vec![None; LEVELS],
                heavy: None,
            });
        }
        p.counts.posting_blocks += 1;
        if p.term.as_ref().unwrap().pair {
            continue;
        }
        let posting = pairs_of(&k, Some(v), "a search block")?;
        let tagged = p.tagged(block)?;
        let t = p.term.as_ref().unwrap();
        let lengths = &mut p.lengths;
        let want = want_of(scope, &t.term, block, &posting, &tagged, |lblock| {
            let k = length_block(scope, lblock);
            pairs_of(&k, lengths.get(&k)?, "a search block")
        })?;
        if want.is_empty() {
            continue;
        }
        let (group, first) = max_slot(block, false);
        let slots = want.into_iter().map(|(sub, b)| (first + sub, b)).collect();
        p.feed(0, group, slots)?;
    }
    p.finish_term()?;
    let from = p.done_to.clone();
    p.delete(0, from, &key::prefix_end(&maxima_start))?;
    p.flush()?;
    Ok(p.counts)
}

impl<'a, E: FnMut(Batch) -> Result<(), StoreError>> Pass<'a, E> {
    /// Per reading of the term, the documents of block `block` that may carry a tag whose name holds it (as
    /// `index::carried` reads them); none when its scope has no tag field.
    fn tagged(&mut self, block: u64) -> Result<Vec<(bool, Vec<u64>)>, StoreError> {
        let t = self.term.as_mut().unwrap();
        if tag_field(t.scope).is_none() {
            return Ok(Vec::new());
        }
        let term = t.term.clone();
        if t.heavy.is_none() {
            let mut per = Vec::new();
            for &r in readings(&term) {
                let kind = term_kind(r);
                let mut tags: Heavy = Vec::new();
                for (structure, c) in [
                    (key::TERM_HEAVY, &mut self.tags.heavy[kind as usize]),
                    (key::TERM_MOVING, &mut self.tags.moving[kind as usize]),
                ] {
                    let prefix = key::term_key(structure, kind, &term);
                    c.seek(&prefix)?;
                    while let Some((tk, _)) = c.next_until(&key::prefix_end(&prefix))? {
                        let tag = get_u64(&tk, &mut { prefix.len() }).ok_or_else(|| {
                            StoreError::Entry("a term's tag key doesn't decode".into())
                        })?;
                        tags.push((tag, None));
                    }
                }
                per.push((r, tags));
            }
            self.term.as_mut().unwrap().heavy = Some(per);
        }
        let (first, end) = (block << BLOCK_BITS, (block + 1) << BLOCK_BITS);
        let member = first >> key::MEMBER_BITS;
        let places = |k: &[u8], v: Option<Val>, out: &mut Vec<u64>| -> Result<(), StoreError> {
            let Some(v) = v else {
                return Ok(());
            };
            let p = v
                .into_pairs(k)
                .ok_or_else(|| StoreError::Entry("a carrier block doesn't decode".into()))?;
            for (slot, n) in p {
                let d = member << key::MEMBER_BITS | u64::from(slot);
                if n != 0 && (first..end).contains(&d) {
                    out.push(d);
                }
            }
            Ok(())
        };
        let src = self.src;
        let t = self.term.as_mut().unwrap();
        let mut out = Vec::new();
        for (r, tags) in t.heavy.as_mut().unwrap() {
            let kind = term_kind(*r);
            let mut docs = Vec::new();
            let mut k = key::tag_carriers_of(kind, &term);
            put_u64(&mut k, member);
            let v = self.tags.carriers[kind as usize].get_kept(&k)?;
            places(&k, v, &mut docs)?;
            for (tag, last) in tags.iter_mut() {
                if last.as_ref().is_none_or(|l| l.0 != member) {
                    let k = key::member_block(*tag, first);
                    let mut at = Vec::new();
                    // Every document of the member block that carries the tag; `places` keeps this block's.
                    let v = src.get(&k)?;
                    if let Some(v) = v {
                        let p = v.into_pairs(&k).ok_or_else(|| {
                            StoreError::Entry("a carrier block doesn't decode".into())
                        })?;
                        at.extend(
                            p.into_iter()
                                .filter(|&(_, n)| n != 0)
                                .map(|(slot, _)| member << key::MEMBER_BITS | u64::from(slot)),
                        );
                    }
                    *last = Some((member, at));
                }
                let held = &last.as_ref().unwrap().1;
                docs.extend(held.iter().copied().filter(|d| (first..end).contains(d)));
            }
            docs.sort_unstable();
            docs.dedup();
            out.push((*r, docs));
        }
        Ok(out)
    }

    /// Adds slots to the map being built at `level` for `group`, finishing the one before it first.
    fn feed(&mut self, level: usize, group: u64, slots: Vec<(u32, u32)>) -> Result<(), StoreError> {
        let building = &mut self.term.as_mut().unwrap().building[level];
        if building.as_ref().is_some_and(|b| b.0 != group) {
            let done = building.take().unwrap();
            self.finish(level, done)?;
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
        self.delete(level, from, &k)?;
        let now: Vec<(u32, u32)> = m.into_iter().collect();
        let v = self.maxima[level].get(&k)?;
        let stored = pairs_of(&k, v, "a maxima map")?;
        self.compare(k, &stored, &now)?;
        self.term.as_mut().unwrap().finished[level] = Some(group);
        if level + 1 < LEVELS && group != 0 {
            let mut above: BTreeMap<u32, u32> = BTreeMap::new();
            for &(s, b) in &now {
                let w = above.entry(s & ((1 << NODE_SLOT_BITS) - 1)).or_insert(b);
                *w = (*w).max(b);
            }
            let (g, first) = max_slot(group, false);
            let slots = above.into_iter().map(|(sub, b)| (first + sub, b)).collect();
            self.feed(level + 1, g, slots)?;
        }
        Ok(())
    }

    /// Counts how `stored` differs from `now` and, unless dry, writes `now` (an empty one deletes the map).
    fn compare(
        &mut self,
        k: Vec<u8>,
        stored: &[(u32, u32)],
        now: &[(u32, u32)],
    ) -> Result<(), StoreError> {
        let stored: BTreeMap<u32, u32> = stored.iter().copied().filter(|p| p.1 != 0).collect();
        let now_m: BTreeMap<u32, u32> = now.iter().copied().collect();
        if stored == now_m {
            return Ok(());
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
            return Ok(());
        }
        let v = (!now.is_empty()).then(|| map_bytes(now));
        self.out_bytes += k.len() + v.as_ref().map_or(0, Vec::len);
        self.out.push((k, v));
        if self.out_bytes >= self.batch {
            self.flush()?;
        }
        Ok(())
    }

    /// Hands the maps waiting to `emit`.
    fn flush(&mut self) -> Result<(), StoreError> {
        if self.out.is_empty() {
            return Ok(());
        }
        self.out_bytes = 0;
        (self.emit)(std::mem::take(&mut self.out))
    }

    /// Deletes the stored maxima maps in `[from, to)`, read by level `level`'s cursor.
    fn delete(&mut self, level: usize, from: Vec<u8>, to: &[u8]) -> Result<(), StoreError> {
        if from.as_slice() >= to {
            return Ok(());
        }
        self.maxima[level].seek(&from)?;
        while let Some((k, v)) = self.maxima[level].next_until(to)? {
            let stored = pairs_of(&k, Some(v), "a maxima map")?;
            self.compare(k, &stored, &[])?;
        }
        Ok(())
    }

    /// Finishes each level's map being built, lowest first, then deletes the term's stored maps past each level's
    /// last finished one and at levels no build writes.
    fn finish_term(&mut self) -> Result<(), StoreError> {
        let Some(t) = self.term.as_ref() else {
            return Ok(());
        };
        let (scope, term) = (t.scope, t.term.clone());
        for level in 0..LEVELS {
            if let Some(b) = self.term.as_mut().unwrap().building[level].take() {
                self.finish(level, b)?;
            }
        }
        for level in 0..LEVELS {
            let from = match self.term.as_ref().unwrap().finished[level] {
                Some(g) => block_maxima(scope, &term, level as u64, g + 1),
                None => block_maxima_at(scope, &term, level as u64),
            };
            let to = key::prefix_end(&block_maxima_at(scope, &term, level as u64));
            self.delete(level, from, &to)?;
        }
        let end = key::prefix_end(&block_maxima_of(scope, &term));
        self.delete(0, block_maxima_at(scope, &term, LEVELS as u64), &end)?;
        self.done_to = end;
        self.term = None;
        Ok(())
    }
}
