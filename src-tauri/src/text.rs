//! Text transformations shared by incoming and outgoing mail.

/// Decode the common named and numeric HTML entities used in snippets and message text.
/// Unknown or malformed references are preserved; decoding is a single pass.
pub(crate) fn decode_html_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let decoded = tail.find(';').filter(|&end| end <= 10).and_then(|end| {
            let entity = &tail[1..end];
            let ch = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                _ => entity.strip_prefix('#').and_then(|n| {
                    let code = match n.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok(),
                        None => n.parse().ok(),
                    };
                    code.and_then(char::from_u32)
                }),
            };
            ch.map(|c| (c, end + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &tail[len..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::decode_html_entities;

    #[test]
    fn decodes_named_and_numeric_entities() {
        assert_eq!(
            decode_html_entities("&amp;&lt;&gt;&quot;&apos;&nbsp;"),
            "&<>\"'\u{a0}"
        );
        assert_eq!(
            decode_html_entities("&#39; &#233; &#xE9; &#XE9; &#x1F600; &#128512;"),
            "' é é é 😀 😀"
        );
    }

    #[test]
    fn preserves_unknown_and_malformed_entities() {
        for text in [
            "AT&T & co",
            "&amp &lt",
            "&unknown; &; &#; &#x;",
            "&#-1; &#xGG; &#4294967296;",
            "&#xD800; &#55296; &#x110000; &#1114112;",
        ] {
            assert_eq!(decode_html_entities(text), text);
        }
    }

    #[test]
    fn preserves_unicode_and_decodes_only_once() {
        assert_eq!(decode_html_entities(""), "");
        assert_eq!(decode_html_entities("café 日本語 😀"), "café 日本語 😀");
        assert_eq!(decode_html_entities("日本語 &amp; café"), "日本語 & café");
        assert_eq!(decode_html_entities("&amp;lt;"), "&lt;");
        assert_eq!(decode_html_entities("&&amp; &bad;&gt;"), "&& &bad;>");
    }
}
