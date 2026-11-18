//! The email on screen, added to a diagnostics bundle only when the user ticks "Include the email on
//! screen": its cached messages (headers, the body as stored and as shown after sanitizing, attachment
//! metadata) and what the window saw of each image. Unlike the logs it isn't scrubbed; that's the point
//! of including it. Written under `email/` in the zip.

use super::{image_probe, SupportError};
use crate::accounts::AccountInfo;
use crate::db::{attachments, messages};
use crate::render;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;

/// Each body file is cut to this; the rest of a huge newsletter rarely matters, and the zip must stay
/// under the Worker's limit with room for the logs.
pub const MAX_BODY_FILE_BYTES: usize = 1_000_000;

/// The conversation to include, as the window names it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailRequest {
    pub account_id: String,
    pub thread_id: String,
    /// Every image in the expanded messages' frames, as the window saw it when Send was pressed.
    #[serde(default)]
    pub images: Vec<ImageState>,
    /// `navigator.onLine` when Send was pressed (older windows don't send it).
    #[serde(default)]
    pub online: Option<bool>,
}

/// One `<img>` in an email frame (`src/settings/emailOnScreen.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageState {
    /// The message whose frame holds it.
    pub message_id: Option<String>,
    pub src: String,
    /// What the browser chose to load (differs from `src` with `srcset`).
    pub current_src: String,
    pub complete: bool,
    /// Zero once complete means it failed.
    pub natural_width: u32,
    pub natural_height: u32,
    pub loading: String,
    /// How many times the window fetched it again after it failed (`src/mail/imageRetry.ts`).
    #[serde(default)]
    pub retries: u32,
}

pub struct EmailFiles {
    /// Paths in the zip and their contents.
    pub files: Vec<(String, Vec<u8>)>,
    /// One line for the notification email, without the subject or addresses.
    pub highlight: String,
}

/// Read the conversation from the cache. Only an account that is signed in here can be read.
/// With a `probe` client, the images that failed in the window are fetched again from here
/// ([`image_probe`]); tests leave it out.
pub async fn collect(
    db: &SqlitePool,
    accounts: &[AccountInfo],
    request: &EmailRequest,
    probe: Option<&reqwest::Client>,
) -> Result<EmailFiles, SupportError> {
    let account_index = accounts
        .iter()
        .position(|a| a.id == request.account_id)
        .ok_or_else(|| SupportError::Invalid("That email's account isn't signed in.".into()))?;
    let rows =
        messages::get_messages_for_thread(db, &request.account_id, &request.thread_id).await?;
    if rows.is_empty() {
        return Err(SupportError::Invalid(
            "That email is no longer on this computer. Open it again, or send without it.".into(),
        ));
    }

    let mut files = Vec::new();
    let mut described = Vec::with_capacity(rows.len());
    for m in &rows {
        let dir = format!("email/{}", path_safe(&m.id));
        let atts = attachments::get_attachments_for_message(db, &request.account_id, &m.id).await?;
        let mut entry = json!({
            "id": m.id,
            "date": m.date,
            "subject": m.subject,
            "fromName": m.from_name,
            "fromAddress": m.from_address,
            "to": parse_json(m.to_addresses.as_deref()),
            "cc": parse_json(m.cc_addresses.as_deref()),
            "labelIds": m.labels(),
            "sizeEstimate": m.size_estimate,
            "fullyFetched": m.fully_fetched != 0,
            "rfc822MessageId": m.rfc822_message_id,
            "rawHeaders": parse_json(m.raw_headers.as_deref()),
            "attachments": atts.iter().map(|a| json!({
                "filename": a.filename,
                "mimeType": a.mime_type,
                "size": a.size,
                "contentId": a.content_id,
                "inline": a.is_inline != 0,
            })).collect::<Vec<_>>(),
        });
        let fields = entry.as_object_mut().expect("an object");
        if let Some(html) = &m.body_html {
            let shown = render::sanitize_email_html(html, &request.account_id, &m.id);
            fields.insert("hasRemoteContent".into(), shown.has_remote_content.into());
            fields.insert("declaresDarkMode".into(), shown.declares_dark_mode.into());
            fields.insert("bodyHtmlBytes".into(), html.len().into());
            files.push((format!("{dir}/original.html"), capped(html)));
            files.push((format!("{dir}/shown.html"), capped(&shown.html)));
        }
        if let Some(text) = &m.body_text {
            fields.insert("bodyTextBytes".into(), text.len().into());
            files.push((format!("{dir}/body.txt"), capped(text)));
        }
        described.push(entry);
    }

    let images = &request.images;
    let failed = images
        .iter()
        .filter(|i| i.complete && i.natural_width == 0)
        .count();
    let loading = images.iter().filter(|i| !i.complete).count();
    let retried = images.iter().filter(|i| i.retries > 0).count();
    let probes = match probe {
        Some(client) => {
            let targets = image_probe::probe_targets(
                images
                    .iter()
                    .filter(|i| i.complete && i.natural_width == 0)
                    .map(|i| i.src.as_str()),
            );
            image_probe::probe_all(client, targets).await
        }
        None => Vec::new(),
    };
    let thread = json!({
        "accountIndex": account_index,
        "threadId": request.thread_id,
        "online": request.online,
        "messages": described,
        "images": images,
        "imageProbes": probes,
    });
    let thread =
        serde_json::to_vec_pretty(&thread).map_err(|e| SupportError::Internal(e.to_string()))?;
    files.insert(0, ("email/thread.json".into(), thread));

    let plural = |n: usize, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
    let mut highlight = format!(
        "Includes the email on screen: {}, {}",
        plural(rows.len(), "message"),
        plural(images.len(), "image")
    );
    if failed > 0 || loading > 0 {
        highlight.push_str(&format!(" ({failed} failed, {loading} still loading)"));
    }
    if retried > 0 {
        highlight.push_str(&format!(", {} fetched again", plural(retried, "image")));
    }
    if !probes.is_empty() {
        let loaded = probes.iter().filter(|p| p.loaded()).count();
        highlight.push_str(&format!(
            "; of the failed, {loaded} of {} load from the app now",
            probes.len()
        ));
    }
    if request.online == Some(false) {
        highlight.push_str("; the window was offline");
    }
    Ok(EmailFiles { files, highlight })
}

fn parse_json(text: Option<&str>) -> Value {
    text.and_then(|t| serde_json::from_str(t).ok())
        .unwrap_or(Value::Null)
}

/// Gmail ids are hex; anything else is replaced so the id can't climb out of `email/`.
fn path_safe(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(64)
        .collect();
    if safe.is_empty() {
        "_".into()
    } else {
        safe
    }
}

/// At most [`MAX_BODY_FILE_BYTES`], with a note saying where it was cut.
fn capped(text: &str) -> Vec<u8> {
    if text.len() <= MAX_BODY_FILE_BYTES {
        return text.as_bytes().to_vec();
    }
    let mut end = MAX_BODY_FILE_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n[pheeme: cut at {end} of {} bytes]\n",
        &text[..end],
        text.len()
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::attachments::{insert_attachment, DbAttachment};
    use crate::db::messages::{upsert_message, DbMessage};
    use crate::db::test_support::TestDb;

    fn message(id: &str, html: Option<&str>, text: Option<&str>) -> DbMessage {
        DbMessage {
            id: id.into(),
            account_id: "a1".into(),
            thread_id: "t1".into(),
            label_ids: Some(r#"["INBOX"]"#.into()),
            from_address: Some("shop@ammo.example".into()),
            from_name: Some("Shop".into()),
            to_addresses: Some(r#"[{"name":null,"email":"me@example.com"}]"#.into()),
            cc_addresses: None,
            subject: Some("In stock tonight".into()),
            snippet: None,
            body_html: html.map(Into::into),
            body_text: text.map(Into::into),
            date: Some(1),
            size_estimate: Some(1234),
            has_attachment: 0,
            is_read: 1,
            is_starred: 0,
            raw_headers: Some(r#"[{"name":"Content-Type","value":"text/html"}]"#.into()),
            fully_fetched: 1,
            rfc822_message_id: None,
        }
    }

    fn image(src: &str, complete: bool, width: u32) -> ImageState {
        ImageState {
            message_id: Some("m1".into()),
            src: src.into(),
            current_src: src.into(),
            complete,
            natural_width: width,
            natural_height: width,
            loading: "".into(),
            retries: 0,
        }
    }

    async fn accounts(db: &TestDb) -> Vec<AccountInfo> {
        crate::db::accounts::list_accounts(&db.pool)
            .await
            .unwrap()
            .into_iter()
            .map(Into::into)
            .collect()
    }

    fn file<'a>(out: &'a EmailFiles, path: &str) -> &'a str {
        let (_, bytes) = out.files.iter().find(|(p, _)| p == path).expect(path);
        std::str::from_utf8(bytes).unwrap()
    }

    #[tokio::test]
    async fn includes_each_message_as_stored_and_as_shown_with_the_images_seen() {
        let db = TestDb::with_account("a1").await;
        let html = r#"<p>Hi</p><img src="http://shop.example/a.jpg"><script>x()</script>"#;
        upsert_message(&db.pool, &message("m1", Some(html), None))
            .await
            .unwrap();
        upsert_message(&db.pool, &message("m2", None, Some("plain reply")))
            .await
            .unwrap();
        insert_attachment(
            &db.pool,
            &DbAttachment {
                id: "x1".into(),
                message_id: "m1".into(),
                account_id: "a1".into(),
                filename: Some("logo.png".into()),
                mime_type: Some("image/png".into()),
                size: Some(10),
                attachment_id: Some("att".into()),
                content_id: Some("logo".into()),
                is_inline: 1,
            },
        )
        .await
        .unwrap();
        let request = EmailRequest {
            account_id: "a1".into(),
            thread_id: "t1".into(),
            images: vec![
                image("http://shop.example/a.jpg", true, 0),
                image("https://cdn.example/b.jpg", true, 40),
                image("https://cdn.example/c.jpg", false, 0),
            ],
            online: None,
        };

        let out = collect(&db.pool, &accounts(&db).await, &request, None)
            .await
            .unwrap();

        assert_eq!(
            out.highlight,
            "Includes the email on screen: 2 messages, 3 images (1 failed, 1 still loading)"
        );
        assert_eq!(file(&out, "email/m1/original.html"), html);
        let shown = file(&out, "email/m1/shown.html");
        assert!(
            shown.contains("http://shop.example/a.jpg") && !shown.contains("script"),
            "{shown}"
        );
        assert_eq!(file(&out, "email/m2/body.txt"), "plain reply");
        let thread: Value = serde_json::from_str(file(&out, "email/thread.json")).unwrap();
        assert_eq!(thread["accountIndex"], 0);
        assert_eq!(thread["messages"][0]["subject"], "In stock tonight");
        assert_eq!(thread["messages"][0]["hasRemoteContent"], true);
        assert_eq!(
            thread["messages"][0]["rawHeaders"][0]["name"],
            "Content-Type"
        );
        assert_eq!(thread["messages"][0]["attachments"][0]["contentId"], "logo");
        assert_eq!(thread["images"][2]["complete"], false);
    }

    #[tokio::test]
    async fn says_which_images_were_fetched_again_and_whether_the_window_was_offline() {
        let db = TestDb::with_account("a1").await;
        upsert_message(&db.pool, &message("m1", Some("<p>Hi</p>"), None))
            .await
            .unwrap();
        let mut again = image("https://cdn.example/a.png", true, 0);
        again.retries = 2;
        let request = EmailRequest {
            account_id: "a1".into(),
            thread_id: "t1".into(),
            images: vec![again, image("https://cdn.example/b.png", true, 40)],
            online: Some(false),
        };

        let out = collect(&db.pool, &accounts(&db).await, &request, None)
            .await
            .unwrap();

        assert_eq!(
            out.highlight,
            "Includes the email on screen: 1 message, 2 images (1 failed, 0 still loading), \
             1 image fetched again; the window was offline"
        );
        let thread: Value = serde_json::from_str(file(&out, "email/thread.json")).unwrap();
        assert_eq!(thread["online"], false);
        assert_eq!(thread["images"][0]["retries"], 2);
        assert_eq!(thread["imageProbes"], json!([]));
    }

    #[tokio::test]
    async fn refuses_an_account_that_isnt_signed_in_or_an_email_not_cached() {
        let db = TestDb::with_account("a1").await;
        let accounts = accounts(&db).await;
        let mut request = EmailRequest {
            account_id: "other".into(),
            thread_id: "t1".into(),
            images: vec![],
            online: None,
        };
        let err = collect(&db.pool, &accounts, &request, None)
            .await
            .err()
            .unwrap();
        assert_eq!(err.code(), "invalid_input");
        request.account_id = "a1".into();
        let err = collect(&db.pool, &accounts, &request, None)
            .await
            .err()
            .unwrap();
        assert_eq!(err.code(), "invalid_input");
    }

    #[test]
    fn huge_bodies_are_cut_and_ids_stay_inside_the_folder() {
        let big = "é".repeat(MAX_BODY_FILE_BYTES);
        let cut = String::from_utf8(capped(&big)).unwrap();
        assert!(cut.len() < MAX_BODY_FILE_BYTES + 100);
        assert!(
            cut.ends_with(&format!("of {} bytes]\n", big.len())),
            "{}",
            &cut[cut.len() - 60..]
        );
        assert_eq!(path_safe("../../etc"), "______etc");
        assert_eq!(path_safe(""), "_");
        assert_eq!(path_safe("19a1f0"), "19a1f0");
    }
}
