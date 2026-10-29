//! Tokens: a token is a run of alphanumeric characters (tantivy's default tokenizer's boundaries), folded as
//! upstream's `includesIgnoreCaseAndAccents` folds: decomposed (NFD), combining marks U+0300–U+036F dropped,
//! lowercased (character by character, so a final sigma folds as any sigma). No token is dropped for its length.

use unicode_normalization::UnicodeNormalization;

/// Prefix terms are a token's first 2 to 20 characters.
pub const GRAM_MIN: usize = 2;
pub const GRAM_MAX: usize = 20;

/// Folds one token. Can be empty (a token of combining marks only).
pub fn fold(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.nfd() {
        if ('\u{300}'..='\u{36f}').contains(&c) {
            continue;
        }
        out.extend(c.to_lowercase());
    }
    out
}

/// Calls `f` with each folded token of `text`, in order. A token of ASCII letters and digits is lowercased in
/// place, with no allocation; any other is decomposed and folded.
pub fn for_each_token(text: &[u8], mut f: impl FnMut(&str)) {
    let mut raw = String::new();
    let mut ascii = true;
    let mut flush = |raw: &mut String, ascii: &mut bool| {
        if !raw.is_empty() {
            if *ascii {
                f(raw);
            } else {
                let t = fold(raw);
                if !t.is_empty() {
                    f(&t);
                }
            }
            raw.clear();
        }
        *ascii = true;
    };
    let mut i = 0;
    while i < text.len() {
        let b = text[i];
        if b < 0x80 {
            if b.is_ascii_alphanumeric() {
                raw.push(b.to_ascii_lowercase() as char);
            } else {
                flush(&mut raw, &mut ascii);
            }
            i += 1;
            continue;
        }
        let len = match b {
            0xc0..0xe0 => 2,
            0xe0..0xf0 => 3,
            0xf0..0xf8 => 4,
            _ => 1,
        };
        let c = text
            .get(i..i + len)
            .and_then(|seq| std::str::from_utf8(seq).ok())
            .and_then(|s| s.chars().next());
        i += len;
        match c {
            Some(c) if c.is_alphanumeric() => {
                raw.push(c);
                ascii = false;
            }
            _ => flush(&mut raw, &mut ascii),
        }
    }
    flush(&mut raw, &mut ascii);
}

/// The folded tokens of `text`, in order.
pub fn tokens(text: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    for_each_token(text, |t| out.push(t.to_string()));
    out
}

/// Whether `phrase` occurs in `text` (its tokens adjacent and in order, the last one a prefix when `prefix`), and
/// how many of the text's tokens match the last one (by prefix when `prefix_count`, else whole).
pub fn phrase_in(text: &[u8], phrase: &[String], prefix: bool, prefix_count: bool) -> (bool, u64) {
    let n = phrase.len();
    if n == 0 || n > 64 {
        return (false, 0);
    }
    let last = &phrase[n - 1];
    // Bit i: the phrase's first i + 1 tokens end at the current token.
    let (mut state, mut found, mut count) = (0u64, false, 0u64);
    for_each_token(text, |t| {
        let mut m = 0u64;
        for (i, p) in phrase.iter().enumerate() {
            let hit = if i == n - 1 && prefix {
                t.starts_with(p.as_str())
            } else {
                t == p
            };
            if hit {
                m |= 1 << i;
            }
        }
        state = ((state << 1) | 1) & m;
        found |= state >> (n - 1) & 1 == 1;
        if prefix_count {
            count += u64::from(t.starts_with(last.as_str()));
        } else {
            count += u64::from(t == last);
        }
    });
    (found, count)
}

/// How many times `phrase` occurs in `text` (its tokens adjacent and in order, the last one a prefix when
/// `prefix`), overlapping occurrences each counted: a phrase's count in one value, as a word's is its tokens'.
pub fn phrase_count(text: &[u8], phrase: &[String], prefix: bool) -> u64 {
    let n = phrase.len();
    if n == 0 || n > 64 {
        return 0;
    }
    // Bit i: the phrase's first i + 1 tokens end at the current token.
    let (mut state, mut count) = (0u64, 0u64);
    for_each_token(text, |t| {
        let mut m = 0u64;
        for (i, p) in phrase.iter().enumerate() {
            let hit = if i == n - 1 && prefix {
                t.starts_with(p.as_str())
            } else {
                t == p
            };
            if hit {
                m |= 1 << i;
            }
        }
        state = ((state << 1) | 1) & m;
        count += state >> (n - 1) & 1;
    });
    count
}

/// A token's prefix terms: its first `GRAM_MIN..=GRAM_MAX` characters.
pub fn grams(token: &str) -> impl Iterator<Item = &str> {
    token
        .char_indices()
        .map(|(i, c)| i + c.len_utf8())
        .take(GRAM_MAX)
        .skip(GRAM_MIN - 1)
        .map(move |end| &token[..end])
}

/// A string's first `n` characters.
pub fn first_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

pub fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// A token of a text, folded, with where it is in the text in UTF-16 units (JavaScript's string positions).
#[derive(Debug, Clone, PartialEq)]
pub struct Spanned {
    pub token: String,
    pub start: u32,
    pub end: u32,
}

/// The folded tokens of `text` with their places, by the same boundaries and folding as `for_each_token`.
pub fn spanned_tokens(text: &str) -> Vec<Spanned> {
    let mut out = Vec::new();
    let mut raw = String::new();
    let mut start = 0u32;
    let mut at = 0u32;
    let flush = |raw: &mut String, start: u32, end: u32, out: &mut Vec<Spanned>| {
        if !raw.is_empty() {
            let token = fold(raw);
            if !token.is_empty() {
                out.push(Spanned { token, start, end });
            }
            raw.clear();
        }
    };
    for c in text.chars() {
        let width = c.len_utf16() as u32;
        if c.is_alphanumeric() {
            if raw.is_empty() {
                start = at;
            }
            raw.push(c);
        } else {
            flush(&mut raw, start, at, &mut out);
        }
        at += width;
    }
    flush(&mut raw, start, at, &mut out);
    out
}

/// One clause of a search, as the chat search reads it: its words (folded here), whether the last one is a prefix
/// (the query's last word, not in closed quotes), and whether the text must not have it.
#[derive(Debug, Clone)]
pub struct MatchClause {
    pub text: String,
    pub prefix: bool,
    pub negate: bool,
}

/// Whether `text` matches every clause (each positive one's words occur together and in order; no negated one's
/// do), and if so the places of the words the positive clauses matched, as `[start, end)` in UTF-16 units, in
/// order. A clause with no words matches anything. None: it doesn't match.
pub fn match_spans(text: &str, clauses: &[MatchClause]) -> Option<Vec<(u32, u32)>> {
    let spanned = spanned_tokens(text);
    let mut spans: Vec<(u32, u32)> = Vec::new();
    for clause in clauses {
        let words = tokens(clause.text.as_bytes());
        if words.is_empty() {
            continue;
        }
        let n = words.len();
        // A one-character last word would match nearly everything as a prefix: it's matched whole, as the chat
        // search's prefix terms start at `GRAM_MIN` characters.
        let prefix = clause.prefix && char_len(&words[n - 1]) >= GRAM_MIN;
        let mut found = false;
        if spanned.len() >= n {
            for i in 0..=spanned.len() - n {
                let hit = (0..n).all(|k| {
                    let t = &spanned[i + k].token;
                    if k == n - 1 && prefix {
                        t.starts_with(words[k].as_str())
                    } else {
                        *t == words[k]
                    }
                });
                if hit {
                    found = true;
                    if clause.negate {
                        break;
                    }
                    spans.extend((0..n).map(|k| (spanned[i + k].start, spanned[i + k].end)));
                }
            }
        }
        if found == clause.negate {
            return None;
        }
    }
    spans.sort_unstable();
    spans.dedup();
    Some(spans)
}

#[cfg(test)]
mod tests {
    #[test]
    fn spans_are_in_utf16_units_and_tokens_folded() {
        let got = spanned_tokens("Héllo, 😀 Wörld");
        let t: Vec<_> = got.iter().map(|s| (s.token.as_str(), s.start, s.end)).collect();
        assert_eq!(t, [("hello", 0, 5), ("world", 10, 15)]);
    }

    #[test]
    fn a_text_matches_every_clause_and_answers_the_matched_words() {
        let c = |text: &str, prefix: bool, negate: bool| MatchClause { text: text.into(), prefix, negate };
        let text = "The big Sister went home. A big dog.";
        assert_eq!(match_spans(text, &[c("big sister", false, false)]), Some(vec![(4, 7), (8, 14)]));
        assert_eq!(match_spans(text, &[c("big", false, false)]), Some(vec![(4, 7), (28, 31)]));
        // The last word a prefix only when the clause says so.
        assert_eq!(match_spans(text, &[c("sis", false, false)]), None);
        assert_eq!(match_spans(text, &[c("sis", true, false)]), Some(vec![(8, 14)]));
        // A one-character prefix is a whole word.
        assert_eq!(match_spans(text, &[c("a", true, false)]), Some(vec![(26, 27)]));
        // Every clause, and none of the negated.
        assert_eq!(match_spans(text, &[c("big", false, false), c("cat", false, false)]), None);
        assert_eq!(match_spans(text, &[c("home", false, false), c("dog", false, true)]), None);
        assert_eq!(match_spans(text, &[c("home", false, false), c("cat", false, true)]), Some(vec![(20, 24)]));
        // Words in order and together.
        assert_eq!(match_spans(text, &[c("sister big", false, false)]), None);
        // Accents and case fold as the search's do.
        assert_eq!(match_spans("Café crème", &[c("CAFE creme", false, false)]), Some(vec![(0, 4), (5, 10)]));
        // No words: anything matches.
        assert_eq!(match_spans(text, &[c("...", false, false)]), Some(vec![]));
    }

    use super::*;
    use crate::log::format::wtf8_from_utf16;

    fn t(s: &str) -> Vec<String> {
        tokens(s.as_bytes())
    }

    #[test]
    fn tokens_split_on_non_alphanumerics_and_fold_case_and_accents() {
        assert_eq!(t("Héllo, Wörld!"), ["hello", "world"]);
        assert_eq!(
            t("foo-bar o'neil {{char}}"),
            ["foo", "bar", "o", "neil", "char"]
        );
        assert_eq!(t("ÇA ÉTÉ 2024x"), ["ca", "ete", "2024x"]);
        // A combining mark isn't alphanumeric: decomposed accents are boundaries.
        assert_eq!(t("e\u{301}t\u{301}e"), ["e", "t", "e"]);
        assert_eq!(t("東京タワー tower"), ["東京タワー", "tower"]);
        let long = "a".repeat(60);
        assert_eq!(t(&long), std::slice::from_ref(&long));
    }

    #[test]
    fn phrases_are_found_without_collecting_tokens() {
        let p = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let text = "The Dark  Knight rises; dark knightly Élodie".as_bytes();
        assert_eq!(
            phrase_in(text, &p(&["dark", "knight"]), false, false),
            (true, 1)
        );
        assert_eq!(
            phrase_in(text, &p(&["dark", "knight"]), true, true),
            (true, 2)
        );
        assert_eq!(
            phrase_in(text, &p(&["knight", "dark"]), false, false),
            (false, 2)
        );
        assert_eq!(
            phrase_in(text, &p(&["knightly", "elodie"]), false, false),
            (true, 1)
        );
        assert_eq!(
            phrase_in(text, &p(&["the", "dark", "knight", "rises"]), false, false),
            (true, 1)
        );
        assert_eq!(
            phrase_in(text, &p(&["dark", "dark"]), false, false),
            (false, 2)
        );
    }

    #[test]
    fn lone_surrogates_are_boundaries() {
        let units: Vec<u16> = "ab"
            .encode_utf16()
            .chain([0xd800])
            .chain("cd".encode_utf16())
            .collect();
        assert_eq!(tokens(&wtf8_from_utf16(&units)), ["ab", "cd"]);
    }

    #[test]
    fn grams_are_the_first_2_to_20_characters() {
        assert_eq!(grams("a").count(), 0);
        assert_eq!(
            grams("dragon").collect::<Vec<_>>(),
            ["dr", "dra", "drag", "drago", "dragon"]
        );
        let long = "é".repeat(30);
        let g: Vec<&str> = grams(&long).collect();
        assert_eq!(g.len(), 19);
        assert_eq!(char_len(g.last().unwrap()), 20);
        assert_eq!(first_chars(&long, 20), *g.last().unwrap());
    }
}
