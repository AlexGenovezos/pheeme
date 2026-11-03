//! Email HTML sanitizer. The output is a fragment rendered in a sandboxed, CSP-locked
//! iframe, so this is defence in depth: scripts, handlers, dangerous URLs and the app's
//! internal attachment protocol never survive, and anything that would load remote content
//! is reported through `has_remote_content` so the UI can hold it back.

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use ammonia::{Builder, Url, UrlRelative};
use hmac::{Hmac, Mac};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

/// URI scheme the webview serves `cid:` images through.
pub const ATTACHMENT_SCHEME: &str = "pheeme-att";

/// Host Windows webviews use for custom schemes (`http://<scheme>.localhost/`).
const WINDOWS_ATTACHMENT_HOST: &str = "pheeme-att.localhost";

const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SanitizedBody {
    pub html: String,
    pub has_remote_content: bool,
    pub declares_dark_mode: bool,
}

type HmacSha256 = Hmac<sha2::Sha256>;

/// Process-wide random key, so only URLs minted by [`attachment_url`] in this run resolve.
fn token_key() -> &'static [u8; 32] {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    KEY.get_or_init(rand::random)
}

fn token_mac(account_id: &str, message_id: &str, content_id: &str) -> HmacSha256 {
    let mut mac = HmacSha256::new_from_slice(token_key()).expect("HMAC takes any key length");
    // Length-prefix every field so no two distinct triples share the same signed bytes.
    for field in [account_id, message_id, content_id] {
        mac.update(&(field.len() as u64).to_be_bytes());
        mac.update(field.as_bytes());
    }
    mac
}

fn attachment_token(account_id: &str, message_id: &str, content_id: &str) -> String {
    token_mac(account_id, message_id, content_id)
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Whether `token` was minted by [`attachment_url`] for exactly this attachment. The protocol
/// handler refuses every request without a valid token, so an author-written `pheeme-att` URL
/// (in an attribute, in CSS, escaped or not) can never resolve.
pub fn verify_attachment_token(
    account_id: &str,
    message_id: &str,
    content_id: &str,
    token: &str,
) -> bool {
    let Some(bytes) = decode_hex(token) else {
        return false;
    };
    token_mac(account_id, message_id, content_id)
        .verify_slice(&bytes)
        .is_ok()
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Parses a protocol request URI (`/{account}/{message}/{cid}?t={token}`, segments
/// percent-encoded) into the decoded triple, or `None` unless it has exactly those three
/// non-empty segments and a token minted by [`attachment_url`] for them. Pure and checked
/// first, so an unsigned request never reaches the database, the disk cache or Gmail.
pub fn parse_attachment_request(uri: &str) -> Option<(String, String, String)> {
    let url = Url::parse(uri).ok()?;
    let mut segments = url.path_segments()?;
    let (account, message, cid) = (segments.next()?, segments.next()?, segments.next()?);
    if segments.next().is_some() {
        return None;
    }
    let decode = |s: &str| -> Option<String> {
        let decoded = percent_decode_str(s).decode_utf8().ok()?;
        (!decoded.is_empty()).then(|| decoded.into_owned())
    };
    let (account, message, cid) = (decode(account)?, decode(message)?, decode(cid)?);
    let mut tokens = url.query_pairs().filter(|(key, _)| key == "t");
    let token = tokens.next()?.1;
    if tokens.next().is_some() {
        return None;
    }
    verify_attachment_token(&account, &message, &cid, &token).then_some((account, message, cid))
}

/// URL the webview resolves to an attachment's bytes, signed with `?t=<token>`.
pub fn attachment_url(account_id: &str, message_id: &str, content_id: &str) -> String {
    let base = if cfg!(windows) {
        format!("http://{WINDOWS_ATTACHMENT_HOST}/")
    } else {
        format!("{ATTACHMENT_SCHEME}://localhost/")
    };
    format!(
        "{base}{}/{}/{}?t={}",
        utf8_percent_encode(account_id, SEGMENT),
        utf8_percent_encode(message_id, SEGMENT),
        utf8_percent_encode(content_id, SEGMENT),
        attachment_token(account_id, message_id, content_id),
    )
}

pub fn sanitize_email_html(html: &str, account_id: &str, message_id: &str) -> SanitizedBody {
    let declares_dark_mode = declares_dark_mode(html);
    let remote = Arc::new(AtomicBool::new(false));

    let mut builder = Builder::default();
    builder
        .add_tags(["style", "center", "font"])
        .add_generic_attributes([
            "style",
            "class",
            "id",
            "align",
            "valign",
            "bgcolor",
            "background",
            "width",
            "height",
            "border",
            "cellpadding",
            "cellspacing",
            "color",
            "face",
            "size",
            "dir",
        ])
        .rm_clean_content_tags(["style"])
        // `<title>` is not an allowed tag, but its text would otherwise be kept as body text.
        .add_clean_content_tags(["title"])
        .url_relative(UrlRelative::Deny)
        .link_rel(Some("noopener noreferrer"))
        .url_schemes(HashSet::from(["http", "https", "mailto", "cid", "data"]));

    let (account, message) = (account_id.to_owned(), message_id.to_owned());
    let flag = Arc::clone(&remote);
    builder.attribute_filter(move |element, attr, value| {
        filter_attribute(&account, &message, &flag, element, attr, value)
    });

    let out = builder.clean(html).to_string();

    let has_remote_content = remote.load(Ordering::Relaxed) || style_blocks_load_remote(&out);
    SanitizedBody {
        html: out,
        has_remote_content,
        declares_dark_mode,
    }
}

/// Runs on every attribute that survived ammonia's allow-list and scheme check, seeing the
/// author's original value, so author-supplied internal-protocol URLs can be told apart from
/// the ones we rewrite below (which ammonia does not re-check).
fn filter_attribute<'a>(
    account_id: &str,
    message_id: &str,
    remote: &AtomicBool,
    element: &str,
    attr: &str,
    value: &'a str,
) -> Option<Cow<'a, str>> {
    match attr {
        "style" => {
            if mentions_internal_scheme(value) {
                return None;
            }
            if css_loads_remote(value) {
                remote.store(true, Ordering::Relaxed);
            }
            Some(Cow::Borrowed(value))
        }
        "src" | "href" | "background" => {
            let url = Url::parse(value).ok()?;
            if is_internal_url(&url) {
                return None;
            }
            let scheme = url.scheme();
            let is_web = matches!(scheme, "http" | "https");
            match (attr, element) {
                ("href", _) => (is_web || scheme == "mailto").then_some(Cow::Borrowed(value)),
                ("background", _) => {
                    if is_web {
                        remote.store(true, Ordering::Relaxed);
                        Some(Cow::Borrowed(value))
                    } else {
                        None
                    }
                }
                ("src", "img") if is_web => {
                    remote.store(true, Ordering::Relaxed);
                    Some(Cow::Borrowed(value))
                }
                ("src", "img") if scheme == "cid" => {
                    let raw = value.trim().split_once(':').map_or("", |(_, rest)| rest);
                    let content_id = percent_decode_str(raw).decode_utf8_lossy();
                    Some(Cow::Owned(attachment_url(
                        account_id,
                        message_id,
                        &content_id,
                    )))
                }
                ("src", "img") if scheme == "data" => {
                    let is_image = value
                        .trim_start()
                        .get(..11)
                        .is_some_and(|p| p.eq_ignore_ascii_case("data:image/"));
                    is_image.then_some(Cow::Borrowed(value))
                }
                _ => None,
            }
        }
        _ => Some(Cow::Borrowed(value)),
    }
}

fn is_internal_url(url: &Url) -> bool {
    if url.scheme() == ATTACHMENT_SCHEME {
        return true;
    }
    url.host_str().is_some_and(|host| {
        let host = host.trim_end_matches('.');
        host == WINDOWS_ATTACHMENT_HOST || host.ends_with(".pheeme-att.localhost")
    })
}

fn mentions_internal_scheme(css: &str) -> bool {
    css.to_ascii_lowercase().contains("pheeme-att")
}

/// Whether CSS text refers to something on the network (`url(http…)`, `@import`, protocol-relative
/// URLs, `image-set`). A heuristic that only drives the "Load images" bar; the iframe CSP is what
/// actually blocks the request.
fn css_loads_remote(css: &str) -> bool {
    let squashed: String = css
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '"' && *c != '\'')
        .collect::<String>()
        .to_ascii_lowercase();
    squashed.contains("url(http")
        || squashed.contains("url(//")
        || squashed.contains("@import")
        || squashed.contains("image-set(")
}

/// `<style>` blocks of already-sanitized HTML (their text is raw, so `</style` always ends one).
fn style_blocks_load_remote(sanitized: &str) -> bool {
    let lower = sanitized.to_ascii_lowercase();
    let mut rest = lower.as_str();
    while let Some(start) = rest.find("<style") {
        let after = &rest[start..];
        let Some(open_end) = after.find('>') else {
            break;
        };
        let body = &after[open_end + 1..];
        let end = body.find("</style").unwrap_or(body.len());
        if css_loads_remote(&body[..end]) {
            return true;
        }
        rest = &body[end..];
    }
    false
}

/// Whether the message brings its own dark styling: a `prefers-color-scheme: dark` media query,
/// or a `color-scheme` meta tag / CSS property that includes `dark`.
fn declares_dark_mode(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    let squashed: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    if squashed.contains("prefers-color-scheme:dark") {
        return true;
    }
    // <meta name="color-scheme" content="light dark"> in either attribute order.
    let mut rest = lower.as_str();
    while let Some(start) = rest.find("<meta") {
        let tag = &rest[start..];
        let end = tag.find('>').unwrap_or(tag.len());
        if tag[..end].contains("color-scheme") && tag[..end].contains("dark") {
            return true;
        }
        rest = &tag[end..];
    }
    // color-scheme: light dark;
    let mut rest = lower.as_str();
    while let Some(start) = rest.find("color-scheme") {
        let tail = &rest[start + "color-scheme".len()..];
        let end = tail.find([';', '}', ')', '<', '>']).unwrap_or(tail.len());
        if tail[..end].contains("dark") {
            return true;
        }
        rest = &tail[end..];
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(html: &str) -> SanitizedBody {
        sanitize_email_html(html, "a1", "m1")
    }

    #[test]
    fn strips_scripts_and_handlers() {
        let out =
            clean("<p onclick=x>hi</p><script>alert(1)</script><img src=x onerror=alert(1)>").html;
        assert!(!out.contains("script"), "{out}");
        assert!(!out.contains("onclick"), "{out}");
        assert!(!out.contains("onerror"), "{out}");
        assert!(out.contains("hi"), "{out}");
    }

    #[test]
    fn drops_dangerous_urls() {
        let out =
            clean(r#"<a href="javascript:alert(1)">a</a><a href="data:text/html,x">b</a>"#).html;
        assert!(!out.contains("href"), "{out}");
        assert!(out.contains('a') && out.contains('b'), "{out}");
    }

    #[test]
    fn strips_meta_base_form_iframe_svg_script() {
        let out = clean(
            r#"<meta http-equiv="refresh" content="0;url=http://evil"><base href="http://evil/">
            <form action="http://evil"><input name=x></form><iframe src="http://evil"></iframe>
            <svg><script>alert(1)</script><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>
            <script>alert(1)</script>"#,
        )
        .html;
        for banned in [
            "<meta", "<base", "<form", "<iframe", "<script", "<svg", "<input",
        ] {
            assert!(!out.contains(banned), "{banned} in {out}");
        }
        assert!(!out.contains("javascript"), "{out}");
    }

    #[test]
    fn style_breakout_is_inert() {
        for hostile in [
            "<style>p{}</style><script>alert(1)</script><style>",
            "<style></style><script>x</script>",
            "<style><!--</style><script>alert(1)</script>-->",
            "<svg></p><style><a id=\"</style><img src=1 onerror=alert(1)>\">",
            "<math><style><img src=x onerror=alert(1)></style></math>",
            "<svg><style><img src=x onerror=alert(1)></style></svg>",
            "<style>\u{0}</style><script>alert(1)</script>",
        ] {
            let out = clean(hostile).html;
            assert!(!out.contains("<script"), "{hostile} -> {out}");
            assert!(!out.contains("onerror"), "{hostile} -> {out}");
        }
        // Whatever ammonia smuggles through a namespace change is still filtered, and flagged.
        let smuggled = clean("<svg></p><style><a id=\"</style><img src=https://evil/x>\">");
        assert!(
            !smuggled.html.contains("https://evil") || smuggled.has_remote_content,
            "{}",
            smuggled.html
        );
    }

    #[test]
    fn keeps_email_layout() {
        let out = clean(
            r##"<table bgcolor="#fff" width="600"><tr><td style="color:red" align="center">x</td></tr></table><style>.a{color:red}</style>"##,
        )
        .html;
        for kept in [
            r##"bgcolor="#fff""##,
            r#"width="600""#,
            r#"style="color:red""#,
            r#"align="center""#,
            "<style>.a{color:red}</style>",
        ] {
            assert!(out.contains(kept), "{kept} missing from {out}");
        }
    }

    #[test]
    fn keeps_style_selectors_with_child_combinators() {
        let out = clean("<style>a > b { color: red }</style><p>x</p>").html;
        assert!(out.contains("a > b"), "{out}");
    }

    #[test]
    fn drops_title_text() {
        let out =
            clean("<html><head><title>Subject line</title></head><body>hi</body></html>").html;
        assert!(!out.contains("Subject line"), "{out}");
        assert!(out.contains("hi"), "{out}");
    }

    #[test]
    #[cfg(not(windows))]
    fn rewrites_cid_images() {
        let out = clean(r#"<img src="cid:logo@x">"#).html;
        assert!(
            out.contains(r#"src="pheeme-att://localhost/a1/m1/logo%40x?t="#),
            "{out}"
        );
    }

    #[test]
    #[cfg(windows)]
    fn rewrites_cid_images() {
        let out = clean(r#"<img src="cid:logo@x">"#).html;
        assert!(
            out.contains(r#"src="http://pheeme-att.localhost/a1/m1/logo%40x?t="#),
            "{out}"
        );
    }

    #[test]
    fn cid_rewrite_does_not_double_encode() {
        let out = clean(r#"<img src="CID:logo%40x">"#).html;
        assert!(out.contains("/a1/m1/logo%40x?t="), "{out}");
    }

    #[test]
    fn attachment_url_encodes_each_segment() {
        let url = attachment_url("a/b", "m 1", "x@y/z");
        assert!(url.contains("/a%2Fb/m%201/x%40y%2Fz?t="), "{url}");
    }

    #[test]
    fn flags_remote_content() {
        for remote in [
            r#"<img src="https://t.co/p.gif">"#,
            r#"<table><tr><td background="http://x/y.png">x</td></tr></table>"#,
            r#"<div style="background:url(https://x/y)">x</div>"#,
            r#"<div style="background: url( 'https://x/y' )">x</div>"#,
            "<style>a{background:url(https://x)}</style>",
            "<style>@import 'https://x/a.css';</style>",
        ] {
            assert!(clean(remote).has_remote_content, "{remote}");
        }
        for local in [
            r#"<img src="cid:a">"#,
            r#"<img src="data:image/png;base64,AA==">"#,
            r#"<a href="https://x">link</a>"#,
            "<p>plain</p>",
        ] {
            assert!(!clean(local).has_remote_content, "{local}");
        }
    }

    #[test]
    fn data_urls_only_survive_on_image_src() {
        let out = clean(r#"<img src="data:image/png;base64,AA==">"#).html;
        assert!(out.contains("data:image/png;base64,AA=="), "{out}");
        let out = clean(
            r#"<img src="data:text/html,<b>x</b>"><table><tr><td background="data:image/png;base64,AA==">x</td></tr></table>"#,
        )
        .html;
        assert!(!out.contains("data:"), "{out}");
    }

    /// Every `pheeme-att` URL in `html`, as (segments, token) checked with `verify_attachment_token`.
    fn internal_urls_in(html: &str) -> Vec<bool> {
        let base = attachment_url("", "", "");
        let base = &base[..base
            .find("///")
            .map_or(base.find("//").unwrap() + 2, |i| i + 2)];
        let base = base.trim_end_matches('/');
        let mut results = Vec::new();
        let mut rest = html;
        while let Some(i) = rest.find(base) {
            let url = &rest[i + base.len()..];
            let end = url.find([')', '"', '\'', ' ', '<']).unwrap_or(url.len());
            let (path, token) = url[..end].split_once("?t=").unwrap_or((&url[..end], ""));
            let segments: Vec<String> = path
                .trim_start_matches('/')
                .split('/')
                .map(|s| percent_decode_str(s).decode_utf8_lossy().into_owned())
                .collect();
            results.push(match segments.as_slice() {
                [a, m, c] => verify_attachment_token(a, m, c, token),
                _ => false,
            });
            rest = &url[end..];
        }
        results
    }

    #[test]
    fn attachment_tokens_are_bound_to_one_attachment() {
        let url = attachment_url("a1", "m1", "logo@x");
        let token = url.rsplit_once("?t=").unwrap().1;
        assert!(verify_attachment_token("a1", "m1", "logo@x", token));
        assert!(!verify_attachment_token("a1", "m2", "logo@x", token));
        assert!(!verify_attachment_token("a2", "m1", "logo@x", token));
        assert!(!verify_attachment_token("a1", "m1", "other", token));
        let mut tampered = token.to_owned();
        tampered.replace_range(..1, if token.starts_with('0') { "1" } else { "0" });
        assert!(!verify_attachment_token("a1", "m1", "logo@x", &tampered));
        for bad in [
            "",
            "zz",
            &token[..token.len() - 2],
            "é",
            &format!("{token}00"),
        ] {
            assert!(!verify_attachment_token("a1", "m1", "logo@x", bad), "{bad}");
        }
    }

    #[test]
    fn tokens_do_not_confuse_delimiter_containing_fields() {
        let (a, b) = (("a1", "m1\nextra", "logo@x"), ("a1", "m1", "extra\nlogo@x"));
        let token = |t: (&str, &str, &str)| {
            attachment_url(t.0, t.1, t.2)
                .rsplit_once("?t=")
                .unwrap()
                .1
                .to_owned()
        };
        let (ta, tb) = (token(a), token(b));
        assert_ne!(ta, tb);
        assert!(verify_attachment_token(a.0, a.1, a.2, &ta));
        assert!(verify_attachment_token(b.0, b.1, b.2, &tb));
        assert!(!verify_attachment_token(a.0, a.1, a.2, &tb));
        assert!(!verify_attachment_token(b.0, b.1, b.2, &ta));
    }

    #[test]
    fn rewritten_cid_urls_verify() {
        let out = clean(r#"<img src="cid:logo@x">"#).html;
        assert_eq!(internal_urls_in(&out), [true], "{out}");
    }

    #[test]
    fn author_written_internal_urls_in_css_never_verify() {
        for hostile in [
            "<style>p{background:url(pheeme-att://localhost/b/c/d)}</style><p>x</p>",
            "<style>p{background:url(http://pheeme-att.localhost/b/c/d)}</style><p>x</p>",
            r#"<style>p{background:url("pheeme-att://localhost/b/c/d?t=00")}</style><p>x</p>"#,
            r#"<p style="background:url(pheeme\2d att://localhost/b/c/d)">x</p>"#,
            r#"<p style="background:url(pheeme-att://localhost/b/c/d)">x</p>"#,
        ] {
            let out = clean(hostile).html;
            assert!(
                internal_urls_in(&out).iter().all(|ok| !ok),
                "{hostile} -> {out}"
            );
        }
        // The helper does see a URL that the style block let through, so the test is not vacuous.
        let out = clean("<style>p{background:url(pheeme-att://localhost/b/c/d)}</style>").html;
        assert_eq!(internal_urls_in(&out), [false], "{out}");
    }

    #[test]
    fn rejects_internal_protocol_urls() {
        for hostile in [
            r#"<img src="http://pheeme-att.localhost/b/c/d">"#,
            r#"<img src="https://PHEEME-ATT.localhost./b/c/d">"#,
            r#"<img src="pheeme-att://localhost/b/c/d">"#,
            r#"<img src="PHEEME-ATT://localhost/b/c/d">"#,
            r#"<a href="pheeme-att://localhost/b/c/d">x</a>"#,
            r#"<table><tr><td background="http://pheeme-att.localhost/b/c/d">x</td></tr></table>"#,
            r#"<div style="background:url(pheeme-att://localhost/b/c/d)">x</div>"#,
        ] {
            let out = clean(hostile).html;
            assert!(
                !out.to_lowercase().contains("pheeme-att"),
                "{hostile} -> {out}"
            );
        }
    }

    #[test]
    fn adds_noopener_to_links() {
        let out = clean(r#"<a href="https://x">x</a>"#).html;
        assert!(out.contains(r#"rel="noopener noreferrer""#), "{out}");
    }

    #[test]
    fn detects_dark_declaration() {
        for dark in [
            "<style>@media (prefers-color-scheme: dark){}</style>",
            "<style>@media(prefers-color-scheme:DARK){}</style>",
            r#"<meta name="color-scheme" content="light dark">"#,
            r#"<meta content="dark" name="color-scheme">"#,
            "<style>:root { color-scheme: light dark; }</style>",
        ] {
            assert!(clean(dark).declares_dark_mode, "{dark}");
        }
        for plain in [
            "<p>hello</p>",
            r#"<meta name="color-scheme" content="light"><p>dark chocolate</p>"#,
            "<style>@media (prefers-color-scheme: light){} p{color:darkred}</style>",
        ] {
            assert!(!clean(plain).declares_dark_mode, "{plain}");
        }
    }

    #[test]
    fn protocol_request_needs_a_valid_signed_url() {
        let url = attachment_url("acc 1", "m/1", "logo@x.com");
        assert_eq!(
            parse_attachment_request(&url),
            Some(("acc 1".into(), "m/1".into(), "logo@x.com".into()))
        );
        let (path, query) = url.split_once('?').unwrap();
        let token = query.strip_prefix("t=").unwrap();

        // Missing, empty, wrong, doubled and non-hex tokens.
        assert_eq!(parse_attachment_request(path), None);
        assert_eq!(parse_attachment_request(&format!("{path}?t=")), None);
        let wrong = if token.starts_with('0') { "1" } else { "0" };
        assert_eq!(
            parse_attachment_request(&format!("{path}?t={wrong}{}", &token[1..])),
            None
        );
        assert_eq!(
            parse_attachment_request(&format!("{path}?t={token}&t={token}")),
            None
        );
        assert_eq!(parse_attachment_request(&format!("{path}?t=zz")), None);
        assert_eq!(parse_attachment_request(&format!("{path}?x={token}")), None);

        // A token only fits the triple it was minted for.
        for other in [
            attachment_url("acc 2", "m/1", "logo@x.com"),
            attachment_url("acc 1", "m/2", "logo@x.com"),
            attachment_url("acc 1", "m/1", "other"),
        ] {
            let (other_path, _) = other.split_once('?').unwrap();
            assert_eq!(
                parse_attachment_request(&format!("{other_path}?t={token}")),
                None
            );
        }

        // Extra or missing segments, even with a token that is valid for the first three.
        assert_eq!(
            parse_attachment_request(&format!("{path}/extra?t={token}")),
            None
        );
        assert_eq!(
            parse_attachment_request(&format!("{path}/?t={token}")),
            None
        );
        let short = path.rsplit_once('/').unwrap().0;
        assert_eq!(
            parse_attachment_request(&format!("{short}?t={token}")),
            None
        );
        assert_eq!(parse_attachment_request("not a url"), None);
    }
}
