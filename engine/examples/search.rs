//! Measures search (P3) against the design's search cost table (`.plans/2026-10-03-storage-from-needs.md` 7.5) on
//! synthetic libraries, and checks every query's results against a scan of every card.
//!
//!   cargo run --release --features measure --example search -- <dir> <seedpng|synth> <cards> [--no-check]
//!
//! Generators:
//! - `seedpng`: `walrepro/seedpng.mjs`'s cards (a 15-word vocabulary; the cards of the old index's 3.68 MB at
//!   2000), card tags assigned as tags by name, as importing them did.
//! - `synth`: `scripts/bench-search-synth.mjs`'s text generator (30,000-word Zipf vocabulary, its word list placed
//!   at the share of cards per field the live library had), with fixed numbers in place of its live samples
//!   (`SAMPLE`).
//!
//! Prints one JSON object per phase: load, space, writes, and one per query.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use st_engine::log::format::{FieldRef, Record, Value, kind_by_name};
use st_engine::search::Scope;
use st_engine::search::brute::{Checker, Doc, Fields};
use st_engine::search::query::{Clause, Filter, Limits, Order, Query};
use st_engine::search::text::tokens;
use st_engine::store::kinds::{ITEM_SEPARATOR, key, test_codes};
use st_engine::store::{Store, StoreConfig};

/// A card: per library field, its values; and its tags.
struct Card {
    fields: Vec<Vec<String>>,
    tags: Vec<u64>,
}

trait Generator {
    /// Every tag: id, name.
    fn tags(&self) -> &[(u64, String)];
    fn card(&mut self) -> Card;
    /// Words of the text by rank of frequency (synth only).
    fn vocab(&self) -> &[String] {
        &[]
    }
}

const NAME: usize = 0;
const RESOLVED: usize = 1;
const DESCRIPTION: usize = 2;
const MES_EXAMPLE: usize = 3;
const SCENARIO: usize = 4;
const PERSONALITY: usize = 5;
const FIRST_MES: usize = 6;
const CREATOR_NOTES: usize = 7;
const CREATOR: usize = 8;
const TAGS: usize = 9;
const ALTERNATE: usize = 10;
const FIELDS: usize = 11;

fn field_index(name: &str) -> usize {
    Scope::LIBRARY
        .fields()
        .iter()
        .position(|f| f.name == name)
        .unwrap()
}

// ---- seedpng.mjs ----

const SEED_WORDS: [&str; 15] = [
    "the",
    "dragon",
    "girl",
    "love",
    "vampire",
    "detective",
    "night",
    "city",
    "ancient",
    "queen",
    "sword",
    "river",
    "silver",
    "shadow",
    "tavern",
];

struct SeedPng {
    seed: u64,
    i: u64,
    tags: Vec<(u64, String)>,
}

impl SeedPng {
    fn new() -> SeedPng {
        let mut tags: Vec<(u64, String)> = Vec::new();
        for i in 0..1000usize {
            for name in [SEED_WORDS[i % 7], SEED_WORDS[(i * 3) % 11]] {
                if !tags.iter().any(|(_, n)| n == name) {
                    tags.push((tags.len() as u64 + 1, name.to_string()));
                }
            }
        }
        SeedPng {
            seed: 7,
            i: 0,
            tags,
        }
    }

    /// `seed = (seed * 1103515245 + 12345) & 0x7fffffff` in JavaScript's doubles, then `seed / 0x7fffffff`.
    fn rnd(&mut self) -> f64 {
        let x = (self.seed as f64) * 1103515245.0 + 12345.0;
        self.seed = (x as u128 as u64) & 0x7fff_ffff;
        self.seed as f64 / 0x7fff_ffff as f64
    }

    fn text(&mut self, len: f64) -> String {
        let mut s = String::new();
        while (s.len() as f64) < len {
            let w = SEED_WORDS[(self.rnd() * 15.0).floor() as usize];
            s.push_str(w);
            s.push(' ');
        }
        s.truncate(len as usize);
        s
    }
}

impl Generator for SeedPng {
    fn tags(&self) -> &[(u64, String)] {
        &self.tags
    }

    fn card(&mut self) -> Card {
        let i = self.i as usize;
        self.i += 1;
        let name = format!("Char {i} {}", SEED_WORDS[i % 15]);
        let has_book = self.rnd() < 0.6;
        let l = 1000.0 + self.rnd() * 6000.0;
        let description = self.text(l);
        let l = self.rnd() * 800.0;
        let personality = self.text(l);
        let l = self.rnd() * 1500.0;
        let scenario = self.text(l);
        let l = 500.0 + self.rnd() * 3000.0;
        let first_mes = self.text(l);
        let l = self.rnd() * 3000.0;
        let mes_example = self.text(l);
        let l = self.rnd() * 2000.0;
        let creator_notes = self.text(l);
        let greetings = (self.rnd() * 4.0).floor() as usize;
        let alternate: Vec<String> = (0..greetings)
            .map(|_| {
                let l = 1000.0 + self.rnd() * 2000.0;
                self.text(l)
            })
            .collect();
        let card_tags = [SEED_WORDS[i % 7], SEED_WORDS[(i * 3) % 11]];
        if has_book {
            let n = 5 + (self.rnd() * 30.0).floor() as usize;
            for _ in 0..n {
                let l = 300.0 + self.rnd() * 1500.0;
                self.text(l);
            }
        }
        let mut fields = vec![Vec::new(); FIELDS];
        fields[NAME] = vec![name];
        fields[DESCRIPTION] = vec![description];
        fields[PERSONALITY] = vec![personality];
        fields[SCENARIO] = vec![scenario];
        fields[FIRST_MES] = vec![first_mes];
        fields[MES_EXAMPLE] = vec![mes_example];
        fields[CREATOR_NOTES] = vec![creator_notes];
        fields[CREATOR] = vec![format!("creator{}", i % 50)];
        fields[TAGS] = card_tags.iter().map(|t| t.to_string()).collect();
        fields[ALTERNATE] = alternate;
        let mut tags: Vec<u64> = card_tags
            .iter()
            .map(|n| self.tags.iter().find(|(_, t)| t == n).unwrap().0)
            .collect();
        tags.dedup();
        Card { fields, tags }
    }
}

// ---- bench-search-synth.mjs ----

/// Per (term, field): the share of the live library's cards holding it (the kept report of the generator's last
/// run).
const SHARES: &[(&str, &str, f64)] = &[
    ("girl", "name", 0.003622711798412005),
    ("girl", "resolved_tags", 0.07727925662059132),
    ("girl", "description", 0.20364270643143156),
    ("girl", "mes_example", 0.03380145329411579),
    ("girl", "scenario", 0.022296646689572798),
    ("girl", "personality", 0.0029492083703847915),
    ("girl", "first_mes", 0.08823421081709647),
    ("girl", "creator_notes", 0.053767146713250655),
    ("girl", "creator", 0.00032885909571641296),
    ("girl", "tags", 0.07770282713587405),
    ("girl", "alternate_greetings", 0.05356983125582081),
    ("the", "name", 0.030504969718654466),
    ("the", "resolved_tags", 0.015900994996079998),
    ("the", "description", 0.8594666694729309),
    ("the", "mes_example", 0.3071386101625353),
    ("the", "scenario", 0.35344986345770346),
    ("the", "personality", 0.012775518150391211),
    ("the", "first_mes", 0.8446469631835665),
    ("the", "creator_notes", 0.44023183250811626),
    ("the", "creator", 0.007253316215121204),
    ("the", "tags", 0.016037800379898028),
    ("the", "alternate_greetings", 0.2602406722406091),
    ("love", "name", 0.0007945235752508537),
    ("love", "resolved_tags", 0.1921247454630599),
    ("love", "description", 0.2697065524517103),
    ("love", "mes_example", 0.06012333531525749),
    ("love", "scenario", 0.0312889698028424),
    ("love", "personality", 0.0023783089802210987),
    ("love", "first_mes", 0.06758449047887147),
    ("love", "creator_notes", 0.057263576618907554),
    ("love", "creator", 0.0001446980021152217),
    ("love", "tags", 0.19242203408558756),
    ("love", "alternate_greetings", 0.056453267807062314),
    ("dragon", "name", 0.0008392484122682859),
    ("dragon", "resolved_tags", 0.0103709004425128),
    ("dragon", "description", 0.030426043535682526),
    ("dragon", "mes_example", 0.0038621212200935537),
    ("dragon", "scenario", 0.004517208538760648),
    ("dragon", "personality", 0.00023414767615008604),
    ("dragon", "first_mes", 0.009073880169007266),
    ("dragon", "creator_notes", 0.008310927066945188),
    ("dragon", "creator", 0.000415677896985546),
    ("dragon", "tags", 0.010560323281645453),
    ("dragon", "alternate_greetings", 0.006319356383286592),
    ("vampire", "name", 0.0002788725131675182),
    ("vampire", "resolved_tags", 0.007011275920673924),
    ("vampire", "description", 0.012751840295499629),
    ("vampire", "mes_example", 0.0013654229654145465),
    ("vampire", "scenario", 0.002667704984451542),
    ("vampire", "personality", 0.0001394362565837591),
    ("vampire", "first_mes", 0.003485906414593977),
    ("vampire", "creator_notes", 0.0046619065408758705),
    ("vampire", "creator", 0.00003683221872023825),
    ("vampire", "tags", 0.0071112490857717136),
    ("vampire", "alternate_greetings", 0.002486174763616082),
    ("detective", "name", 0.00010260403786352084),
    ("detective", "resolved_tags", 0.000952375941194732),
    ("detective", "description", 0.006427222166681575),
    ("detective", "mes_example", 0.0008366175395025546),
    ("detective", "scenario", 0.0008260940484396294),
    ("detective", "personality", 0.0000684026919090139),
    ("detective", "first_mes", 0.0017626847530399735),
    ("detective", "creator_notes", 0.001360161219883084),
    ("detective", "creator", 0.0),
    ("detective", "tags", 0.000952375941194732),
    ("detective", "alternate_greetings", 0.0011628457624532362),
    ("saxophone", "name", 0.0),
    ("saxophone", "resolved_tags", 0.0000026308727657313035),
    ("saxophone", "description", 0.0002288859306186234),
    ("saxophone", "mes_example", 0.00004209396425170086),
    ("saxophone", "scenario", 0.00001578523659438782),
    ("saxophone", "personality", 0.0),
    ("saxophone", "first_mes", 0.0001341745110522965),
    ("saxophone", "creator_notes", 0.000026308727657313035),
    ("saxophone", "creator", 0.0),
    ("saxophone", "tags", 0.0000026308727657313035),
    ("saxophone", "alternate_greetings", 0.00018153022083545995),
    ("quokka", "name", 0.0000026308727657313035),
    ("quokka", "resolved_tags", 0.000005261745531462607),
    ("quokka", "description", 0.00004209396425170086),
    ("quokka", "mes_example", 0.0),
    ("quokka", "scenario", 0.0000026308727657313035),
    ("quokka", "personality", 0.0),
    ("quokka", "first_mes", 0.000013154363828656518),
    ("quokka", "creator_notes", 0.0000026308727657313035),
    ("quokka", "creator", 0.0),
    ("quokka", "tags", 0.000005261745531462607),
    ("quokka", "alternate_greetings", 0.00001578523659438782),
    ("dr", "name", 0.001583785404970245),
    ("dr", "resolved_tags", 0.00008155705573767041),
    ("dr", "description", 0.011936269738122925),
    ("dr", "mes_example", 0.001689020315599497),
    ("dr", "scenario", 0.0016179867509247517),
    ("dr", "personality", 0.00009997316509778954),
    ("dr", "first_mes", 0.004351463554519576),
    ("dr", "creator_notes", 0.003388564122261919),
    ("dr", "creator", 0.00032622822295068165),
    ("dr", "tags", 0.00008155705573767041),
    ("dr", "alternate_greetings", 0.0024125103261756057),
    ("dark", "name", 0.0007629531020620781),
    ("dark", "resolved_tags", 0.02425927777280835),
    ("dark", "description", 0.3042104487742764),
    ("dark", "mes_example", 0.023946203913686327),
    ("dark", "scenario", 0.02082072706799754),
    ("dark", "personality", 0.0013654229654145465),
    ("dark", "first_mes", 0.09443254705315941),
    ("dark", "creator_notes", 0.025143251022094068),
    ("dark", "creator", 0.0004235705152827399),
    ("dark", "tags", 0.02512220403996822),
    ("dark", "alternate_greetings", 0.06621643664069118),
    ("knight", "name", 0.0005445906625063799),
    ("knight", "resolved_tags", 0.002615087529136916),
    ("knight", "description", 0.016053585616492415),
    ("knight", "mes_example", 0.0026387653840284978),
    ("knight", "scenario", 0.00244144992659865),
    ("knight", "personality", 0.0001446980021152217),
    ("knight", "first_mes", 0.005624805973133527),
    ("knight", "creator_notes", 0.0042777991170790996),
    ("knight", "creator", 0.00018679196636692255),
    ("knight", "tags", 0.00264402712955996),
    ("knight", "alternate_greetings", 0.004125208496666684),
];

const SYLLABLES: [&str; 30] = [
    "ka", "ri", "to", "na", "me", "lo", "sa", "vi", "en", "dor", "th", "ar", "is", "mo", "lu",
    "qu", "ze", "pha", "gr", "el", "ion", "st", "ba", "cy", "ou", "wy", "nd", "fe", "hi", "jo",
];
const TERMS: [&str; 11] = [
    "girl",
    "the",
    "love",
    "dragon",
    "vampire",
    "detective",
    "saxophone",
    "quokka",
    "dr",
    "dark",
    "knight",
];
const VOCAB_SIZE: usize = 30000;
/// The live library's tag count (the kept report of the generator's last run).
const LIVE_TAGS: usize = 68823;

/// The numbers the generator took from live card samples, fixed: text lengths in characters per field, the
/// alternate greetings' count and total length, tags per card, a tag name's length.
struct Sample {
    lens: [(usize, usize); 8],
    greetings: usize,
    greetings_len: usize,
    tags: usize,
    tag_name_len: usize,
}

const SAMPLE: Sample = Sample {
    lens: [
        (NAME, 14),
        (DESCRIPTION, 2600),
        (PERSONALITY, 350),
        (SCENARIO, 500),
        (FIRST_MES, 1400),
        (MES_EXAMPLE, 1300),
        (CREATOR_NOTES, 700),
        (CREATOR, 10),
    ],
    greetings: 2,
    greetings_len: 2200,
    tags: 11,
    tag_name_len: 9,
};

struct Synth {
    state: u32,
    vocab: Vec<String>,
    word_cdf: Vec<f64>,
    tag_cdf: Vec<f64>,
    tags: Vec<(u64, String)>,
    /// Ids of the tags named exactly as each term.
    word_tags: HashMap<&'static str, u64>,
    inserts: Vec<Vec<(usize, &'static str)>>,
    i: usize,
}

fn zipf_cdf(n: usize, s: f64) -> Vec<f64> {
    let mut cdf = Vec::with_capacity(n);
    let mut sum = 0.0;
    for i in 0..n {
        sum += 1.0 / ((i + 1) as f64).powf(s);
        cdf.push(sum);
    }
    for c in &mut cdf {
        *c /= sum;
    }
    cdf
}

impl Synth {
    fn new(cards: usize) -> Synth {
        let mut g = Synth {
            state: 20260926,
            vocab: Vec::new(),
            word_cdf: zipf_cdf(VOCAB_SIZE, 1.0),
            tag_cdf: Vec::new(),
            tags: Vec::new(),
            word_tags: HashMap::new(),
            inserts: vec![Vec::new(); cards],
            i: 0,
        };
        let mut seen = std::collections::HashSet::new();
        while g.vocab.len() < VOCAB_SIZE {
            let w = g.make_word(1, 4);
            if !seen.contains(&w) && !TERMS.iter().any(|t| w.starts_with(t)) {
                seen.insert(w.clone());
                g.vocab.push(w);
            }
        }
        // Which cards get which word in which field: the live share of cards, every card eligible.
        for (term, field, share) in SHARES {
            let f = field_index(field);
            let target = (share * cards as f64).round() as usize;
            let mut pool: Vec<usize> = (0..cards).collect();
            for k in 0..target.min(cards) {
                let j = k + g.rand_int(cards - k);
                pool.swap(k, j);
                g.inserts[pool[k]].push((f, term));
            }
        }
        let mut names: std::collections::HashSet<String> =
            TERMS.iter().map(|t| t.to_string()).collect();
        for _ in 0..LIVE_TAGS - TERMS.len() {
            let len = SAMPLE.tag_name_len.max(2);
            let mut name: String = g
                .text(len)
                .chars()
                .filter(|c| !matches!(c, '.' | '{' | '}'))
                .collect::<String>()
                .trim()
                .to_string();
            if name.is_empty() {
                name = g.make_word(1, 2);
            }
            while names.contains(&name) {
                name = format!("{name} {}", g.make_word(1, 1));
            }
            names.insert(name.clone());
            g.tags.push((g.tags.len() as u64 + 1, name));
        }
        for t in TERMS {
            let id = g.tags.len() as u64 + 1;
            g.tags.push((id, t.to_string()));
            g.word_tags.insert(t, id);
        }
        g.tag_cdf = zipf_cdf(LIVE_TAGS - TERMS.len(), 1.1);
        g
    }

    fn rand(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6D2B79F5);
        let a = self.state;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4294967296.0
    }

    fn rand_int(&mut self, n: usize) -> usize {
        (self.rand() * n as f64) as usize
    }

    fn make_word(&mut self, min: usize, max: usize) -> String {
        let n = min + self.rand_int(max - min + 1);
        (0..n).map(|_| SYLLABLES[self.rand_int(30)]).collect()
    }

    fn zipf(&mut self, cdf_tags: bool) -> usize {
        let u = self.rand();
        let cdf = if cdf_tags {
            &self.tag_cdf
        } else {
            &self.word_cdf
        };
        cdf.partition_point(|&c| c < u).min(cdf.len() - 1)
    }

    fn text(&mut self, len: usize) -> String {
        if len == 0 {
            return String::new();
        }
        let mut parts: Vec<String> = Vec::new();
        let (mut n, mut sentence) = (0, 0);
        while n < len {
            let z = self.zipf(false);
            let mut w = self.vocab[z].clone();
            if sentence == 0 {
                w = w[..1].to_uppercase() + &w[1..];
            }
            let r = self.rand();
            if r < 0.02 {
                w = "{{char}}".into();
            } else if r < 0.03 {
                w = "{{user}}".into();
            }
            sentence += 1;
            if sentence > 8 + self.rand_int(10) {
                w.push('.');
                sentence = 0;
            }
            n += w.len() + 1;
            parts.push(w);
        }
        let mut s = parts.join(" ");
        s.truncate(len);
        s
    }

    fn capitalized(&mut self, len: usize) -> String {
        let t: String = self
            .text(len.max(1))
            .chars()
            .map(|c| {
                if c.is_ascii_alphabetic() || c == ' ' {
                    c
                } else {
                    'a'
                }
            })
            .collect();
        let mut s = t[..1].to_uppercase() + &t[1..];
        s.truncate(len);
        s
    }

    fn insert_token(&mut self, s: &str, term: &str) -> String {
        let mut toks: Vec<&str> = s.split(' ').collect();
        let at = self.rand_int(toks.len() + 1);
        toks.insert(at, term);
        toks.join(" ")
    }
}

impl Generator for Synth {
    fn tags(&self) -> &[(u64, String)] {
        &self.tags
    }

    fn vocab(&self) -> &[String] {
        &self.vocab
    }

    fn card(&mut self) -> Card {
        let i = self.i;
        self.i += 1;
        let inserts = std::mem::take(&mut self.inserts[i]);
        let mut fields = vec![Vec::new(); FIELDS];
        for (f, len) in SAMPLE.lens {
            fields[f] = vec![if f == NAME || f == CREATOR {
                self.capitalized(len)
            } else {
                self.text(len)
            }];
        }
        let each = (SAMPLE.greetings_len / SAMPLE.greetings)
            .saturating_sub(4)
            .max(1);
        fields[ALTERNATE] = (0..SAMPLE.greetings).map(|_| self.text(each)).collect();
        let mut chosen = BTreeSet::new();
        while chosen.len() < SAMPLE.tags {
            chosen.insert(self.zipf(true));
        }
        let mut tags: Vec<u64> = chosen.iter().map(|&t| self.tags[t].0).collect();
        fields[TAGS] = chosen.iter().map(|&t| self.tags[t].1.clone()).collect();
        for (f, term) in inserts {
            match f {
                RESOLVED => tags.push(self.word_tags[term]),
                TAGS => fields[TAGS].push(term.to_string()),
                ALTERNATE => {
                    let g = self.rand_int(fields[ALTERNATE].len());
                    let v = fields[ALTERNATE][g].clone();
                    fields[ALTERNATE][g] = self.insert_token(&v, term);
                }
                _ => {
                    let v = fields[f][0].clone();
                    fields[f][0] = self.insert_token(&v, term);
                }
            }
        }
        tags.sort_unstable();
        tags.dedup();
        Card { fields, tags }
    }
}

fn generator(kind: &str, cards: usize) -> Box<dyn Generator> {
    match kind {
        "seedpng" => Box::new(SeedPng::new()),
        "synth" => Box::new(Synth::new(cards)),
        _ => panic!("generator is seedpng or synth"),
    }
}

// ---- loading ----

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn text_value(e: u64, code: u64, s: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Id(e),
            Value::Field(FieldRef::Code(code)),
            Value::Text(s.as_bytes().to_vec()),
        ],
    )
}

fn card_records(doc: u64, c: &Card) -> Vec<Record> {
    let mut out = Vec::new();
    for (f, vals) in c.fields.iter().enumerate() {
        if f == RESOLVED || vals.is_empty() {
            continue;
        }
        let sep = (ITEM_SEPARATOR as char).to_string();
        let joined = vals.join(&sep);
        if !joined.is_empty() {
            out.push(text_value(doc, test_codes::LIBRARY + f as u64, &joined));
        }
    }
    for &t in &c.tags {
        out.push(rec(
            "tagAssign",
            vec![Value::Id(doc), Value::Id(t), Value::Bit(true)],
        ));
    }
    out
}

/// Commits in flight at once, of `batch` records each.
fn commit_all(s: &Store, recs: impl Iterator<Item = Record>, batch: usize) {
    let inflight = Arc::new((std::sync::Mutex::new(0u32), std::sync::Condvar::new()));
    let mut recs = recs.peekable();
    while recs.peek().is_some() {
        let chunk: Vec<Record> = recs.by_ref().take(batch).collect();
        let (m, cv) = &*inflight;
        let mut n = m.lock().unwrap();
        while *n >= 8 {
            n = cv.wait(n).unwrap();
        }
        *n += 1;
        drop(n);
        let f = inflight.clone();
        s.commit(
            chunk,
            Box::new(move |r| {
                r.unwrap();
                *f.0.lock().unwrap() -= 1;
                f.1.notify_all();
            }),
        );
    }
    let (m, cv) = &*inflight;
    let mut n = m.lock().unwrap();
    while *n > 0 {
        n = cv.wait(n).unwrap();
    }
}

fn settle(s: &Store) {
    let ks = s.keyspace();
    ks.freeze_at(s.durable_end());
    ks.wait_flushed().unwrap();
    ks.wait_merged();
}

fn dir_bytes(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| rd.map(|e| e.unwrap().metadata().unwrap().len()).sum())
        .unwrap_or(0)
}

fn proc_kb(field: &str) -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|l| l.strip_prefix(field))
        .and_then(|v| v.trim().trim_end_matches(" kB").trim().parse().ok())
        .unwrap_or(0)
}

// ---- queries ----

fn c(text: &str) -> Clause {
    Clause {
        text: text.as_bytes().to_vec(),
        fields: None,
        negate: false,
        quoted: false,
    }
}

/// The query set: (label, words typed, clauses, filters). Text as typed: whitespace separates clauses.
fn queries(tags: &[(u64, String)]) -> Vec<(String, usize, Vec<Clause>, Vec<Filter>)> {
    let tag_of = |n: &str| tags.iter().find(|(_, t)| t == n).map(|(id, _)| *id);
    let words = |s: &str| s.split(' ').map(c).collect::<Vec<_>>();
    let mut out = Vec::new();
    for q in [
        "girl",
        "the",
        "love",
        "dragon",
        "vampire",
        "detective",
        "saxophone",
        "quokka",
        "dr",
        "dra",
        "dark knight",
        "the girl",
        "vampire love",
        "the dark knight",
        "girl love dragon",
    ] {
        out.push((q.to_string(), q.split(' ').count(), words(q), Vec::new()));
    }
    for q in ["dark knight", "the dragon"] {
        let mut cl = c(q);
        cl.quoted = true;
        out.push((format!("\"{q}\""), 2, vec![cl], Vec::new()));
    }
    let mut tag = c("dragon");
    tag.fields = Some(vec![RESOLVED as u32, TAGS as u32]);
    out.push(("tag:dragon".into(), 1, vec![tag], Vec::new()));
    let mut name = c("dr");
    name.fields = Some(vec![NAME as u32]);
    out.push(("name:dr".into(), 1, vec![name], Vec::new()));
    let mut neg = c("vampire");
    neg.fields = Some(vec![RESOLVED as u32, TAGS as u32]);
    neg.negate = true;
    out.push((
        "girl -tag:vampire".into(),
        2,
        vec![c("girl"), neg],
        Vec::new(),
    ));
    if let Some(t) = tag_of("love") {
        out.push((
            "the [tag love]".into(),
            1,
            vec![c("the")],
            vec![Filter::AnyTag(vec![t])],
        ));
    }
    out
}

/// The best matches and the number of matches.
type Answer = (Vec<(u64, f64)>, u64);

fn fields_of(card: &Card) -> Fields {
    card.fields
        .iter()
        .map(|vals| vals.iter().map(|v| tokens(v.as_bytes())).collect())
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args[1] == "sum" {
        // The generator's text, to compare with the JavaScript it ports.
        let mut g = generator(&args[2], args[3].parse().unwrap());
        let mut total = 0usize;
        for i in 0..args[3].parse::<usize>().unwrap() {
            let c = g.card();
            if i == 0 {
                eprintln!("{:?}", &c.fields[DESCRIPTION][0][..200]);
            }
            total += c.fields.iter().flatten().map(String::len).sum::<usize>();
        }
        println!("{total}");
        return;
    }
    if args[1] == "phrases" {
        phrases(&args[2..]);
        return;
    }
    let dir = PathBuf::from(&args[1]);
    let kind = args[2].as_str();
    let cards: usize = args[3].parse().unwrap();
    let check = !args.iter().any(|a| a == "--no-check");
    // --reuse: a store an earlier run left with the same library; only the queries run.
    let reuse = args.iter().any(|a| a == "--reuse") && dir.exists();
    if !reuse {
        let _ = std::fs::remove_dir_all(&dir);
    }
    let s = Store::open(&dir, StoreConfig::default()).unwrap();
    s.wait_ready().unwrap();

    let mut g = generator(kind, cards);
    let tags = g.tags().to_vec();
    if !reuse {
        load_and_space(&s, &dir, kind, cards, g.as_mut(), &tags);
    }

    // ---- queries: latency (median of 7 after one warm-up) and reads ----
    let qs = queries(&tags);
    let mut results = Vec::new();
    for (label, words, clauses, filters) in &qs {
        let q = Query {
            scope: Scope::LIBRARY,
            clauses: clauses.clone(),
            filters: filters.clone(),
            order: Order::Relevance,
            limit: 50,
            after: None,
            limits: Limits::default(),
        };
        let first = s.search(&q).unwrap();
        let mut times = Vec::new();
        let ks0 = s.stats().ks;
        for _ in 0..7 {
            let t = Instant::now();
            s.search(&q).unwrap();
            times.push(t.elapsed());
        }
        let ks1 = s.stats().ks;
        times.sort();
        results.push((
            label.clone(),
            *words,
            q,
            first,
            times[3],
            (ks1.blocks - ks0.blocks) / 7,
            (ks1.file_reads - ks0.file_reads) / 7,
        ));
    }

    // ---- the check: every card read twice (statistics, then matches) ----
    let mut checked: Vec<Option<Answer>> = vec![None; results.len()];
    if check {
        let tag_names: BTreeMap<u64, Vec<u8>> = tags
            .iter()
            .map(|(id, n)| (*id, n.as_bytes().to_vec()))
            .collect();
        let mut checkers: Vec<Checker> = results
            .iter()
            .map(|r| Checker::new(&r.2, &tag_names, 50))
            .collect();
        for pass in 0..2 {
            let mut g = generator(kind, cards);
            for i in 0..cards {
                let card = g.card();
                let f = fields_of(&card);
                let d = Doc::new(&f, Scope::LIBRARY);
                let tags: BTreeSet<u64> = card.tags.iter().copied().collect();
                for ch in &mut checkers {
                    if pass == 0 {
                        ch.stats(&d, &tags);
                    } else {
                        ch.matches(i as u64 + 1, &d, &tags);
                    }
                }
            }
        }
        for (i, ch) in checkers.into_iter().enumerate() {
            checked[i] = Some(ch.result());
        }
    }
    for (i, (label, words, _, f, median, blocks, file_reads)) in results.iter().enumerate() {
        let got: Vec<(u64, f64)> = f.hits.iter().map(|h| (h.doc, h.score)).collect();
        let (same_page, same_total) = match &checked[i] {
            Some((want, total)) => (
                format!("{}", got == want[..want.len().min(50)]),
                format!("{}", !f.total_exact || f.total == *total),
            ),
            None => ("null".into(), "null".into()),
        };
        let brute_total = checked[i]
            .as_ref()
            .map_or("null".into(), |(_, t)| t.to_string());
        println!(
            "{{\"phase\":\"query\",\"q\":{:?},\"words\":{words},\"median_ms\":{:.3},\"total\":{},\"total_exact\":{},\
             \"page_exact\":{},\"work\":{},\"scans\":{},\"entries\":{},\"pairs\":{},\"gets\":{},\"texts\":{},\"plan_us\":{},\"blocks\":{blocks},\"file_reads\":{file_reads},\
             \"brute_total\":{brute_total},\"page_equal\":{same_page},\"total_equal\":{same_total}}}",
            label,
            median.as_secs_f64() * 1000.0,
            f.total,
            f.total_exact,
            f.page_exact,
            f.work,
            f.scans,
            f.entries,
            f.pairs,
            f.gets,
            f.texts,
            f.plan_micros,
        );
    }

    if !reuse {
        writes(&s, cards);
    } else {
        probe(&s);
    }
    s.close();
}

fn load_and_space(
    s: &Store,
    dir: &Path,
    kind: &str,
    cards: usize,
    g: &mut dyn Generator,
    tags: &[(u64, String)],
) {
    // ---- load ----
    let started = Instant::now();
    commit_all(
        s,
        tags.iter()
            .map(|(id, name)| text_value(*id, test_codes::TAG_NAME, name)),
        1000,
    );
    let mut text_bytes = 0u64;
    let recs = (0..cards).flat_map(|i| {
        let card = g.card();
        text_bytes += card
            .fields
            .iter()
            .flatten()
            .map(|v| v.len() as u64)
            .sum::<u64>();
        card_records(i as u64 + 1, &card)
    });
    commit_all(s, recs, 200);
    let load = started.elapsed();
    settle(s);
    let st = s.stats();
    let runs = dir_bytes(&dir.join("runs"));
    println!(
        "{{\"phase\":\"load\",\"generator\":\"{kind}\",\"cards\":{cards},\"tags\":{},\"text_bytes\":{text_bytes},\
         \"load_s\":{:.1},\"settled_s\":{:.1},\"inserted\":{},\"inserted_bytes\":{},\"flush_bytes\":{},\
         \"merge_bytes\":{},\"runs\":{},\"runs_disk\":{runs},\"log_bytes\":{},\"hwm_kb\":{}}}",
        tags.len(),
        load.as_secs_f64(),
        started.elapsed().as_secs_f64(),
        st.ks.inserted,
        st.ks.inserted_bytes,
        st.ks.flush_bytes,
        st.ks.merge_bytes,
        st.ks.runs,
        st.log_bytes,
        proc_kb("VmHWM:")
    );

    // ---- space by structure: every entry's key and value bytes ----
    let mut by: BTreeMap<u64, (u64, u64)> = BTreeMap::new();
    for structure in [
        key::SEARCH_POSTING,
        key::SEARCH_DOC_FREQ,
        key::SEARCH_LENGTH,
        key::SEARCH_DIRECTORY,
        key::SEARCH_TERM_DOCS,
        key::SEARCH_FIELD_TOKENS,
        key::SEARCH_DOCS,
        key::SEARCH_MAX_DOC,
        key::MEMBER,
        key::MEMBER_OF,
        key::MEMBER_COUNT,
    ] {
        let start = key::of(structure);
        let end = key::prefix_end(&start);
        let mut from = start.clone();
        loop {
            let page = s.scan(&from, &end, 65536).unwrap();
            let e = by.entry(structure).or_default();
            for (k, v) in &page {
                e.0 += 1;
                e.1 += (k.len() + v.len()) as u64;
            }
            match page.last() {
                Some((k, _)) if page.len() == 65536 => {
                    from = k.clone();
                    from.push(0);
                }
                _ => break,
            }
        }
    }
    let parts: Vec<String> = by
        .iter()
        .map(|(k, (n, b))| format!("\"{k}\":[{n},{b}]"))
        .collect();
    let search_bytes: u64 = by
        .iter()
        .filter(|(k, _)| **k < key::MEMBER)
        .map(|(_, (_, b))| b)
        .sum();
    println!(
        "{{\"phase\":\"space\",\"runs_disk\":{runs},\"search_entry_bytes\":{search_bytes},\"by_structure\":{{{}}}}}",
        parts.join(",")
    );
}

fn writes(s: &Store, cards: usize) {
    // ---- writes per action ----
    let mut r = 12345u64;
    let mut next = || {
        r = r
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        r >> 33
    };
    let code = test_codes::LIBRARY + DESCRIPTION as u64;
    let (mut entries, mut bytes, mut changed, mut n) = (0u64, 0u64, 0u64, 0u64);
    let mut per: Vec<u64> = Vec::new();
    for _ in 0..200 {
        let doc = 1 + next() % cards as u64;
        let Some(old) = s.text(doc, &FieldRef::Code(code)).unwrap() else {
            continue;
        };
        let old = String::from_utf8(old).unwrap();
        // One word replaced by another.
        let spaces: Vec<usize> = old.match_indices(' ').map(|(i, _)| i).collect();
        if spaces.len() < 3 {
            continue;
        }
        let w = (next() as usize) % (spaces.len() - 1);
        let (a, b) = (spaces[w] + 1, spaces[w + 1]);
        let word = ["zebra", "lantern", "ocean", "marble", "thunder"][(next() % 5) as usize];
        let new = format!("{}{}{}", &old[..a], word, &old[b..]);
        let count = |t: &str| {
            let mut m: HashMap<String, i64> = HashMap::new();
            for x in tokens(t.as_bytes()) {
                *m.entry(x).or_default() += 1;
            }
            m
        };
        let (co, cn) = (count(&old), count(&new));
        let terms_changed = co
            .keys()
            .chain(cn.keys())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|t| co.get(*t) != cn.get(*t))
            .count() as u64;
        let before = s.stats().ks;
        s.commit_wait(vec![rec(
            "textEdit",
            vec![
                Value::Id(doc),
                Value::Field(FieldRef::Code(code)),
                Value::UInt(a as u64),
                Value::UInt((b - a) as u64),
                Value::Text(word.as_bytes().to_vec()),
            ],
        )])
        .unwrap();
        let after = s.stats().ks;
        entries += after.inserted - before.inserted;
        bytes += after.inserted_bytes - before.inserted_bytes;
        per.push(after.inserted - before.inserted);
        changed += terms_changed;
        n += 1;
    }
    per.sort_unstable();
    let entries_of = |recs: Vec<Record>| {
        let before = s.stats().ks;
        s.commit_wait(recs).unwrap();
        let after = s.stats().ks;
        (
            after.inserted - before.inserted,
            after.inserted_bytes - before.inserted_bytes,
        )
    };
    let fav = entries_of(vec![rec("fav", vec![Value::Id(1), Value::Bit(true)])]);
    let assign = entries_of(vec![rec(
        "tagAssign",
        vec![Value::Id(1), Value::Id(1), Value::Bit(true)],
    )]);
    let message = entries_of(vec![rec(
        "messageAppend",
        vec![
            Value::Id(1),
            Value::Absent,
            Value::Id(1),
            Value::Absent,
            Value::Absent,
            Value::Time(0),
            Value::Text(b"a short reply about the dragon".to_vec()),
            Value::UInt(0),
            Value::Id(1),
            Value::Id(1),
        ],
    )]);
    // The tag the most cards carry, renamed.
    let carried = s
        .scan(
            &key::of(key::MEMBER_COUNT),
            &key::prefix_end(&key::of(key::MEMBER_COUNT)),
            usize::MAX,
        )
        .unwrap();
    let (top_tag, top_count) = carried
        .iter()
        .map(|(k, v)| {
            let mut at = 0;
            st_engine::keyspace::val::get_u64(k, &mut at).unwrap();
            let t = st_engine::keyspace::val::get_u64(k, &mut at).unwrap();
            (t, st_engine::keyspace::val::counter_value(v).unwrap())
        })
        .max_by_key(|x| x.1)
        .unwrap();
    let rename = entries_of(vec![text_value(
        top_tag,
        test_codes::TAG_NAME,
        "renamed tag",
    )]);
    settle(s);
    let st = s.stats();
    println!(
        "{{\"phase\":\"writes\",\"field_edits\":{n},\"entries_per_edit\":{:.2},\"entries_p50\":{},\"entries_max\":{},\
         \"entry_bytes_per_edit\":{:.1},\"changed_terms_per_edit\":{:.2},\"fav\":{:?},\"tag_assign\":{:?},\
         \"message_append\":{:?},\"tag_rename\":{:?},\"renamed_tag_carriers\":{top_count},\
         \"run_bytes_written_per_inserted_byte\":{:.2}}}",
        entries as f64 / n as f64,
        per[per.len() / 2],
        per.last().unwrap(),
        bytes as f64 / n as f64,
        changed as f64 / n as f64,
        fav,
        assign,
        message,
        rename,
        (st.ks.flush_bytes + st.ks.merge_bytes) as f64 / st.ks.inserted_bytes as f64,
    );
}

/// Times single reads of the store's derived entries: a point read of a counter, and a scan of a term's postings.
fn probe(s: &Store) {
    use st_engine::search::{TermKind, doc_freq, postings};
    let words = ["dragon", "quokka", "saxophone", "girl", "the", "vampire"];
    let n = 2000;
    let t = Instant::now();
    for i in 0..n {
        s.get(&doc_freq(Scope::LIBRARY, TermKind::Exact, words[i % 6], 2))
            .unwrap();
    }
    let get_us = t.elapsed().as_secs_f64() * 1e6 / n as f64;
    let t = Instant::now();
    for i in 0..n {
        let p = postings(Scope::LIBRARY, TermKind::Exact, words[i % 6]);
        s.scan(&p, &key::prefix_end(&p), 1).unwrap();
    }
    let scan_us = t.elapsed().as_secs_f64() * 1e6 / n as f64;
    let st = s.stats().ks;
    println!(
        "{{\"phase\":\"probe\",\"get_us\":{get_us:.1},\"scan1_us\":{scan_us:.1},\"runs\":{}}}",
        st.runs
    );
}

/// The phrase evaluation: `phrases <dir> <cards> [--reuse]` on the synth library, with pair postings and pair
/// filters both written; each phrase query read the three ways (text checks, pairs, filters before text), each
/// as the query's end (its last word a prefix) and inside it (before a negated word that matches nothing).
/// `phrases writes <dir>` measures the entries one-word edits write with each structure on 2000 cards.
fn phrases(args: &[String]) {
    use st_engine::search::phrase_mode;
    if args[0] == "writes" {
        for (label, mode) in [
            ("none", 0),
            ("pairs", phrase_mode::PAIRS),
            ("filters", phrase_mode::FINGERPRINTS),
        ] {
            phrase_mode::set_write(mode);
            let dir = PathBuf::from(&args[1]).join(label);
            let _ = std::fs::remove_dir_all(&dir);
            let s = Store::open(&dir, StoreConfig::default()).unwrap();
            s.wait_ready().unwrap();
            let mut g = generator("synth", 2000);
            let tags = g.tags().to_vec();
            commit_all(
                &s,
                tags.iter()
                    .map(|(id, n)| text_value(*id, test_codes::TAG_NAME, n)),
                1000,
            );
            commit_all(
                &s,
                (0..2000).flat_map(|i| card_records(i as u64 + 1, &g.card())),
                200,
            );
            println!("{{\"phase\":\"phrase-writes\",\"structures\":\"{label}\"}}");
            writes(&s, 2000);
            s.close();
            drop(s);
            let _ = std::fs::remove_dir_all(&dir);
        }
        return;
    }
    phrase_mode::set_write(phrase_mode::PAIRS | phrase_mode::FINGERPRINTS);
    let dir = PathBuf::from(&args[0]);
    let cards: usize = args[1].parse().unwrap();
    let reuse = args.iter().any(|a| a == "--reuse") && dir.exists();
    if !reuse {
        let _ = std::fs::remove_dir_all(&dir);
    }
    let s = Store::open(&dir, StoreConfig::default()).unwrap();
    s.wait_ready().unwrap();
    let mut g = generator("synth", cards);
    let tags = g.tags().to_vec();
    let vocab: Vec<String> = g.vocab().iter().map(|w| w.to_lowercase()).collect();
    if !reuse {
        load_and_space(&s, &dir, "synth", cards, g.as_mut(), &tags);
        // Space of the pair postings (term kind 2) and the pair filters, by structure.
        let mut pair_bytes: BTreeMap<u64, u64> = BTreeMap::new();
        for structure in [
            key::SEARCH_POSTING,
            key::SEARCH_DIRECTORY,
            key::SEARCH_DOC_FREQ,
            key::SEARCH_TERM_DOCS,
            key::SEARCH_FINGERPRINT,
        ] {
            let start = key::of(structure);
            let end = key::prefix_end(&start);
            let mut from = start.clone();
            loop {
                let page = s.scan(&from, &end, 65536).unwrap();
                for (k, v) in &page {
                    let pair = structure == key::SEARCH_FINGERPRINT || k.get(5) == Some(&2);
                    if pair {
                        *pair_bytes.entry(structure).or_default() += (k.len() + v.len()) as u64;
                    }
                }
                match page.last() {
                    Some((k, _)) if page.len() == 65536 => {
                        from = k.clone();
                        from.push(0);
                    }
                    _ => break,
                }
            }
        }
        let parts: Vec<String> = pair_bytes
            .iter()
            .map(|(k, b)| format!("\"{k}\":{b}"))
            .collect();
        println!("{{\"phase\":\"phrase-space\",{}}}", parts.join(","));
    }
    // (a) a common phrase, (b) common words in a rare phrase, (c) a rare phrase.
    let cases = [
        ("common", format!("{} {}", vocab[0], vocab[1])),
        ("rare-of-common", "dark knight".to_string()),
        ("rare-of-common", "the dragon".to_string()),
        ("rare", format!("{} {}", vocab[1500], vocab[0])),
    ];
    let mut qs: Vec<(String, Query)> = Vec::new();
    for (case, text) in &cases {
        for inner in [false, true] {
            let mut cl = c(text);
            cl.quoted = true;
            let mut clauses = vec![cl];
            if inner {
                let mut none = c("zzqqxnothing");
                none.negate = true;
                clauses.push(none);
            }
            let label = format!(
                "{case} {:?}{}",
                text,
                if inner { " (inside)" } else { " (end)" }
            );
            qs.push((
                label,
                Query {
                    scope: Scope::LIBRARY,
                    clauses,
                    filters: Vec::new(),
                    order: Order::Relevance,
                    limit: 50,
                    after: None,
                    limits: Limits::default(),
                },
            ));
        }
    }
    // The scan's answers.
    let tag_names: BTreeMap<u64, Vec<u8>> = tags
        .iter()
        .map(|(id, n)| (*id, n.as_bytes().to_vec()))
        .collect();
    let mut checkers: Vec<Checker> = qs
        .iter()
        .map(|(_, q)| Checker::new(q, &tag_names, 50))
        .collect();
    for pass in 0..2 {
        let mut g = generator("synth", cards);
        for i in 0..cards {
            let card = g.card();
            let f = fields_of(&card);
            let d = Doc::new(&f, Scope::LIBRARY);
            let t: BTreeSet<u64> = card.tags.iter().copied().collect();
            for ch in &mut checkers {
                if pass == 0 {
                    ch.stats(&d, &t);
                } else {
                    ch.matches(i as u64 + 1, &d, &t);
                }
            }
        }
    }
    let answers: Vec<(Vec<(u64, f64)>, u64)> = checkers.into_iter().map(Checker::result).collect();
    for (mode_label, mode) in [
        ("text", 0),
        ("pairs", phrase_mode::PAIRS),
        ("filters", phrase_mode::FINGERPRINTS),
    ] {
        phrase_mode::set_read(mode);
        for ((label, q), (want, total)) in qs.iter().zip(&answers) {
            let f = s.search(q).unwrap();
            let mut times = Vec::new();
            for _ in 0..31 {
                let t = Instant::now();
                s.search(q).unwrap();
                times.push(t.elapsed());
            }
            times.sort();
            let got: Vec<(u64, f64)> = f.hits.iter().map(|h| (h.doc, h.score)).collect();
            println!(
                "{{\"phase\":\"phrase\",\"read\":\"{mode_label}\",\"q\":{label:?},\"median_us\":{:.0},\"p99_us\":{:.0},\
                 \"total\":{},\"total_exact\":{},\"brute_total\":{total},\"page_exact\":{},\"page_equal\":{},\
                 \"texts\":{},\"gets\":{},\"work\":{}}}",
                times[15].as_secs_f64() * 1e6,
                times[30].as_secs_f64() * 1e6,
                f.total,
                f.total_exact,
                f.page_exact,
                got == want[..want.len().min(50)],
                f.texts,
                f.gets,
                f.work
            );
        }
    }
    phrase_mode::set_read(0);
    // The text check itself: reading a field's value, and finding a phrase in it.
    let code = test_codes::LIBRARY + DESCRIPTION as u64;
    let phrase: Vec<String> = vec!["dark".into(), "knight".into()];
    let (mut read, mut check, mut old_check, mut n) = (0.0, 0.0, 0.0, 0);
    for i in 0..2000u64 {
        let doc = 1 + (i * 7919) % cards as u64;
        let t = Instant::now();
        let Some(text) = s.text(doc, &FieldRef::Code(code)).unwrap() else {
            continue;
        };
        read += t.elapsed().as_secs_f64();
        let t = Instant::now();
        std::hint::black_box(st_engine::search::text::phrase_in(
            &text, &phrase, true, false,
        ));
        check += t.elapsed().as_secs_f64();
        let t = Instant::now();
        let toks = tokens(&text);
        std::hint::black_box(
            toks.windows(2)
                .any(|w| w[0] == phrase[0] && w[1].starts_with(phrase[1].as_str())),
        );
        old_check += t.elapsed().as_secs_f64();
        n += 1;
    }
    println!(
        "{{\"phase\":\"text-check\",\"read_us\":{:.1},\"check_us\":{:.1},\"collecting_check_us\":{:.1}}}",
        read * 1e6 / f64::from(n),
        check * 1e6 / f64::from(n),
        old_check * 1e6 / f64::from(n)
    );
    s.close();
}
