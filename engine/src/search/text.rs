//! Tokens: a token is a run of alphanumeric characters (tantivy's default tokenizer's boundaries), folded as
//! upstream's `includesIgnoreCaseAndAccents` folds: decomposed (NFD), combining marks U+0300–U+036F dropped,
//! lowercased (character by character, so a final sigma folds as any sigma). No token is dropped for its length.

use unicode_normalization::UnicodeNormalization;

/// Prefix terms are a token's first 2 to 20 characters.
pub const GRAM_MIN: usize = 2;
pub const GRAM_MAX: usize = 20;

/// The characters of WTF-8 text; a lone surrogate, or a byte that isn't WTF-8, is `None` (a boundary).
fn chars(b: &[u8]) -> impl Iterator<Item = Option<char>> + '_ {
    let mut i = 0;
    std::iter::from_fn(move || {
        let b0 = *b.get(i)?;
        let len = match b0 {
            0..0x80 => 1,
            0xc0..0xe0 => 2,
            0xe0..0xf0 => 3,
            0xf0..0xf8 => 4,
            _ => {
                i += 1;
                return Some(None);
            }
        };
        let Some(seq) = b.get(i..i + len) else {
            i = b.len();
            return Some(None);
        };
        i += len;
        let c = match std::str::from_utf8(seq) {
            Ok(s) => s.chars().next(),
            Err(_) => None,
        };
        Some(c)
    })
}

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

/// The folded tokens of `text`, in order.
pub fn tokens(text: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut raw = String::new();
    let mut flush = |raw: &mut String| {
        if !raw.is_empty() {
            let t = fold(raw);
            if !t.is_empty() {
                out.push(t);
            }
            raw.clear();
        }
    };
    for c in chars(text) {
        match c {
            Some(c) if c.is_alphanumeric() => raw.push(c),
            _ => flush(&mut raw),
        }
    }
    flush(&mut raw);
    out
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
