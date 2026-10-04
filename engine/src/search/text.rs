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

#[cfg(test)]
mod tests {
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
