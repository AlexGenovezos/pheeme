//! The write tools. Each is a call the UI makes too: thread changes go through
//! `MailService` (the outbox, so they're applied locally at once and sent to Gmail in order),
//! labels through `LabelService`, filters through `FilterService`, drafts through
//! `ComposeService`. Nothing sends mail.

use super::read::resolve_accounts;
use super::requests::{
    ChangeLabels, CreateDraft, CreateFilter, CreateLabel, DeleteFilter, ThreadsArg, Unsubscribe,
    MAX_THREADS,
};
use super::{ApiError, LocalApi, Request};
use crate::accounts::AccountInfo;
use crate::compose::build::text_to_html;
use crate::compose::{ComposeDraft, ComposeMode};
use crate::gmail::mime::{parse_addresses, EmailAddress};
use crate::gmail::types::{Filter, FilterAction, FilterCriteria};
use crate::mail::LabelDto;
use serde_json::{json, Value};

pub(super) async fn run(api: &LocalApi, request: Request) -> Result<Value, ApiError> {
    let labels = |add: &[&str], remove: &[&str]| {
        (
            add.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            remove.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
    };
    match request {
        Request::Archive(t) => modify(api, t, labels(&[], &["INBOX"])).await,
        Request::MoveToInbox(t) => modify(api, t, labels(&["INBOX"], &[])).await,
        Request::MarkRead(t) => modify(api, t, labels(&[], &["UNREAD"])).await,
        Request::MarkUnread(t) => modify(api, t, labels(&["UNREAD"], &[])).await,
        Request::Star(t) => modify(api, t, labels(&["STARRED"], &[])).await,
        Request::Unstar(t) => modify(api, t, labels(&[], &["STARRED"])).await,
        Request::Trash(t) => trash(api, t).await,
        Request::ChangeLabels(c) => change_labels(api, c).await,
        Request::CreateLabel(l) => create_label(api, l).await,
        Request::CreateFilter(f) => create_filter(api, f).await,
        Request::DeleteFilter(d) => delete_filter(api, d).await,
        Request::CreateDraft(d) => create_draft(api, d).await,
        Request::Unsubscribe(u) => unsubscribe(api, u).await,
        _ => Err(ApiError::Invalid("That tool only reads.".into())),
    }
}

/// The one account a change is for: `account`, or the only account there is.
async fn resolve_account(api: &LocalApi, account: Option<&str>) -> Result<AccountInfo, ApiError> {
    let mut found = resolve_accounts(api, account).await?;
    if found.len() > 1 {
        let emails: Vec<&str> = found.iter().map(|a| a.email.as_str()).collect();
        return Err(ApiError::Invalid(format!(
            "Say which account: {}.",
            emails.join(", ")
        )));
    }
    Ok(found.remove(0))
}

/// The account and which of the requested threads it has cached (the rest are reported as
/// not found; nothing is changed for them).
async fn targets(
    api: &LocalApi,
    account: Option<&str>,
    thread_ids: &[String],
) -> Result<(AccountInfo, Vec<String>, Vec<String>), ApiError> {
    let ids: Vec<String> = thread_ids
        .iter()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() {
        return Err(ApiError::Invalid("Give at least one thread_id.".into()));
    }
    if ids.len() > MAX_THREADS {
        return Err(ApiError::Invalid(format!(
            "At most {MAX_THREADS} conversations at a time."
        )));
    }
    let account = resolve_account(api, account).await?;
    let found = api.mail.cached_threads(&account.id, &ids).await?;
    let missing: Vec<String> = ids.into_iter().filter(|id| !found.contains(id)).collect();
    if found.is_empty() {
        return Err(ApiError::Invalid(format!(
            "None of those conversations are in {}.",
            account.email
        )));
    }
    Ok((account, found, missing))
}

fn changed(account: &AccountInfo, found: &[String], missing: &[String]) -> Value {
    json!({
        "account": account.email,
        "changed": found,
        "not_found": missing,
    })
}

async fn modify(
    api: &LocalApi,
    args: ThreadsArg,
    (add, remove): (Vec<String>, Vec<String>),
) -> Result<Value, ApiError> {
    let (account, found, missing) = targets(api, args.account.as_deref(), &args.thread_ids).await?;
    api.mail
        .modify_threads(&account.id, &found, &add, &remove)
        .await?;
    Ok(changed(&account, &found, &missing))
}

async fn trash(api: &LocalApi, args: ThreadsArg) -> Result<Value, ApiError> {
    let (account, found, missing) = targets(api, args.account.as_deref(), &args.thread_ids).await?;
    api.mail.trash_threads(&account.id, &found).await?;
    Ok(changed(&account, &found, &missing))
}

/// The user label `wanted` names (its name, any case, or its id).
fn user_label<'a>(labels: &'a [LabelDto], wanted: &str) -> Result<&'a LabelDto, ApiError> {
    let wanted = wanted.trim();
    labels
        .iter()
        .find(|l| l.label_type == "user" && (l.id == wanted || l.name.eq_ignore_ascii_case(wanted)))
        .ok_or_else(|| {
            ApiError::Invalid(format!(
                "There's no user label called {wanted}. list_labels shows them; create_label makes one. \
                 Use archive, move_to_inbox, star, mark_read and trash for Gmail's own labels."
            ))
        })
}

async fn change_labels(api: &LocalApi, args: ChangeLabels) -> Result<Value, ApiError> {
    if args.add.is_empty() && args.remove.is_empty() {
        return Err(ApiError::Invalid("Give labels to add or remove.".into()));
    }
    let query = args
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty());
    if query.is_some() != args.thread_ids.is_empty() {
        return Err(ApiError::Invalid("Give either thread_ids or query.".into()));
    }
    let (account, found, missing) = match query {
        Some(_) => (
            resolve_account(api, args.account.as_deref()).await?,
            Vec::new(),
            Vec::new(),
        ),
        None => targets(api, args.account.as_deref(), &args.thread_ids).await?,
    };
    let labels = api.mail.list_labels(&account.id).await?;
    let ids = |names: &[String]| -> Result<Vec<String>, ApiError> {
        names
            .iter()
            .map(|n| user_label(&labels, n).map(|l| l.id.clone()))
            .collect()
    };
    let (add, remove) = (ids(&args.add)?, ids(&args.remove)?);
    if let Some(query) = query {
        api.mail
            .modify_matching(&account.id, query, &add, &remove)
            .await?;
        return Ok(json!({
            "account": account.email,
            "query": query,
            "queued": true,
            "note": "Gmail changes every message the search finds; Pheeme shows it after its next sync.",
        }));
    }
    api.mail
        .modify_threads(&account.id, &found, &add, &remove)
        .await?;
    Ok(changed(&account, &found, &missing))
}

async fn create_label(api: &LocalApi, args: CreateLabel) -> Result<Value, ApiError> {
    let account = resolve_account(api, args.account.as_deref()).await?;
    let label = api
        .labels
        .create_label(&account.id, &args.name, None)
        .await?;
    Ok(json!({ "account": account.email, "name": label.name, "id": label.id }))
}

fn category_id(name: &str) -> Result<&'static str, ApiError> {
    Ok(match name.trim().to_lowercase().as_str() {
        "primary" => "CATEGORY_PERSONAL",
        "social" => "CATEGORY_SOCIAL",
        "promotions" => "CATEGORY_PROMOTIONS",
        "updates" => "CATEGORY_UPDATES",
        "forums" => "CATEGORY_FORUMS",
        other => {
            return Err(ApiError::Invalid(format!(
                "{other} isn't an inbox tab. Use primary, social, promotions, updates or forums."
            )))
        }
    })
}

async fn create_filter(api: &LocalApi, args: CreateFilter) -> Result<Value, ApiError> {
    let account = resolve_account(api, args.account.as_deref()).await?;
    let text = |v: &Option<String>| {
        v.as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let mut criteria = FilterCriteria {
        from: text(&args.from),
        ..Default::default()
    };
    for (key, value) in [
        ("to", text(&args.to)),
        ("subject", text(&args.subject)),
        ("query", text(&args.query)),
        ("negatedQuery", text(&args.negated_query)),
    ] {
        if let Some(v) = value {
            criteria.other.insert(key.into(), v.into());
        }
    }
    if args.has_attachment == Some(true) {
        criteria.other.insert("hasAttachment".into(), true.into());
    }
    if criteria.from.is_none() && criteria.other.is_empty() {
        return Err(ApiError::Invalid(
            "Give at least one criterion: from, to, subject, query, negated_query or has_attachment."
                .into(),
        ));
    }

    let mut action = FilterAction::default();
    if let Some(name) = text(&args.add_label) {
        let labels = api.mail.list_labels(&account.id).await?;
        action
            .add_label_ids
            .push(user_label(&labels, &name)?.id.clone());
    }
    if let Some(category) = text(&args.category) {
        action.add_label_ids.push(category_id(&category)?.into());
    }
    let mut add = |on: bool, id: &str| {
        if on {
            action.add_label_ids.push(id.into());
        }
    };
    add(args.star, "STARRED");
    add(args.trash, "TRASH");
    add(args.important == Some(true), "IMPORTANT");
    let mut remove = |on: bool, id: &str| {
        if on {
            action.remove_label_ids.push(id.into());
        }
    };
    remove(args.skip_inbox, "INBOX");
    remove(args.mark_read, "UNREAD");
    remove(args.never_spam, "SPAM");
    remove(args.important == Some(false), "IMPORTANT");
    if action.add_label_ids.is_empty() && action.remove_label_ids.is_empty() {
        return Err(ApiError::Invalid(
            "Give at least one action: add_label, category, skip_inbox, mark_read, star, trash, never_spam or important."
                .into(),
        ));
    }
    let created = api
        .filters
        .create(
            &account.id,
            &Filter {
                id: None,
                criteria,
                action,
            },
        )
        .await?;
    Ok(json!({
        "account": account.email,
        "filter": serde_json::to_value(created).map_err(|e| ApiError::Invalid(e.to_string()))?,
        "note": "Gmail applies it to mail that arrives from now on, not to mail already there.",
    }))
}

async fn delete_filter(api: &LocalApi, args: DeleteFilter) -> Result<Value, ApiError> {
    let account = resolve_account(api, args.account.as_deref()).await?;
    let id = args.filter_id.trim();
    api.filters.delete(&account.id, id).await?;
    Ok(json!({ "account": account.email, "deleted": id }))
}

/// Addresses from a list of `a@x.com` / `Name <a@x.com>` strings.
fn addresses(field: &str, values: &[String]) -> Result<Vec<EmailAddress>, ApiError> {
    let mut out = Vec::new();
    for value in values {
        let parsed = parse_addresses(field, value);
        if parsed.is_empty() || parsed.iter().any(|a| !a.address.contains('@')) {
            return Err(ApiError::Invalid(format!(
                "{value} isn't an email address ({field})."
            )));
        }
        out.extend(parsed);
    }
    Ok(out)
}

async fn create_draft(api: &LocalApi, args: CreateDraft) -> Result<Value, ApiError> {
    let account = resolve_account(api, args.account.as_deref()).await?;
    let (to, cc, bcc) = (
        addresses("To", &args.to)?,
        addresses("Cc", &args.cc)?,
        addresses("Bcc", &args.bcc)?,
    );
    let body_html = text_to_html(&args.body);
    let draft = match args.reply_to_message_id.as_deref().map(str::trim) {
        Some(message_id) if !message_id.is_empty() => {
            let mode = if args.reply_all {
                ComposeMode::ReplyAll
            } else {
                ComposeMode::Reply
            };
            let mut draft = api.compose.template(&account.id, message_id, mode).await?;
            draft.to.extend(to);
            draft.cc.extend(cc);
            draft.bcc.extend(bcc);
            draft.body_html = body_html;
            draft
        }
        _ => ComposeDraft {
            to,
            cc,
            bcc,
            subject: args.subject.unwrap_or_default(),
            body_html,
            ..Default::default()
        },
    };
    let saved = api.compose.save_draft(&account.id, &draft).await;
    // A reply's template staged the quoted images; the saved draft carries them now.
    let staged: Vec<String> = draft.attachments.iter().map(|a| a.id.clone()).collect();
    api.compose.discard_attachments(&staged).await;
    let saved = saved?;
    Ok(json!({
        "account": account.email,
        "draft_id": saved.draft_id,
        "message_id": saved.message_id,
        "thread_id": saved.thread_id,
        "note": "Saved in Drafts. The user reviews and sends it from Pheeme.",
    }))
}

async fn unsubscribe(api: &LocalApi, args: Unsubscribe) -> Result<Value, ApiError> {
    let account = resolve_account(api, args.account.as_deref()).await?;
    let thread = api
        .mail
        .get_thread(&account.id, args.thread_id.trim(), false)
        .await?;
    let message = match args.message_id.as_deref().map(str::trim) {
        Some(id) if !id.is_empty() => thread
            .messages
            .iter()
            .find(|m| m.id == id)
            .ok_or(ApiError::Mail(crate::mail::MailError::NotFound))?,
        _ => thread
            .messages
            .iter()
            .rev()
            .find(|m| {
                m.from_address
                    .as_deref()
                    .is_some_and(|a| !a.eq_ignore_ascii_case(&account.email))
            })
            .ok_or_else(|| {
                ApiError::Invalid("Everything in that conversation is from the user.".into())
            })?,
    };
    let sender = message.from_address.clone();
    let headers = api.mail.message_headers(&account.id, &message.id).await?;
    let options = crate::senders::options(&headers);
    if let Some(url) = &options.one_click {
        crate::senders::one_click(url).await?;
        return Ok(json!({
            "sender": sender,
            "unsubscribed": true,
            "method": "one_click",
            "note": "The sender confirmed the request. Some lists take a few days to stop.",
        }));
    }
    let note = match options.kind() {
        "link" => "This sender has no one-click unsubscribe. Give the user the link to open.",
        "email" => "This sender unsubscribes by email. Assistants can't send mail: give the user the address, or draft the email with create_draft for them to send.",
        _ => "This message has no unsubscribe header. Suggest a filter instead.",
    };
    Ok(json!({
        "sender": sender,
        "unsubscribed": false,
        "web": options.web,
        "mailto": options.mailto,
        "note": note,
    }))
}
