//! The Google Tasks tools: reads answered from the tasks cache (`TasksService`), changes
//! through the same writes the Tasks panel makes (straight to the Tasks API, cached once
//! Google confirms).

use super::read::resolve_accounts;
use super::requests::{
    AccountArg, CreateTask, CreateTaskList, ListTasks, TaskArg, UpdateTask, DEFAULT_TASKS,
    MAX_TASKS,
};
use super::write::resolve_account;
use super::{ApiError, LocalApi, Request};
use crate::accounts::AccountInfo;
use crate::tasks::service::{TaskDto, TasksAccountDto};
use crate::tasks::writes::{TaskEdit, TaskRef};
use chrono::NaiveDate;
use serde_json::{json, Value};

pub(super) async fn run(api: &LocalApi, request: Request) -> Result<Value, ApiError> {
    match request {
        Request::ListTaskLists(a) => list_task_lists(api, a).await,
        Request::ListTasks(l) => list_tasks(api, l).await,
        Request::CreateTask(c) => create_task(api, c).await,
        Request::UpdateTask(u) => update_task(api, u).await,
        Request::DeleteTask(t) => delete_task(api, t).await,
        Request::CreateTaskList(l) => create_task_list(api, l).await,
        _ => Err(ApiError::Invalid("That isn't a Google Tasks tool.".into())),
    }
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::Invalid(message.into())
}

fn access_note(a: &TasksAccountDto) -> String {
    match a.access.status.as_str() {
        "on" => "Pheeme reads these tasks.".into(),
        "api_disabled" => format!(
            "can't be read: the Google Tasks API is off in the user's Google Cloud project. They can turn it on at {}.",
            a.access.enable_url.as_deref().unwrap_or("console.cloud.google.com")
        ),
        "error" => format!(
            "can't be read right now: {}",
            a.access.message.as_deref().unwrap_or("the last sync failed.")
        ),
        _ => "hasn't allowed access to its tasks yet. The user can allow it by opening Calendar in Pheeme.".into(),
    }
}

/// Every account's tasks side.
struct Lists(Vec<TasksAccountDto>);

impl Lists {
    async fn load(api: &LocalApi) -> Result<Self, ApiError> {
        Ok(Self(api.tasks.accounts().await?))
    }

    fn account(&self, id: &str) -> Option<&TasksAccountDto> {
        self.0.iter().find(|a| a.account_id == id)
    }

    fn list_name(&self, account_id: &str, list_id: &str) -> Option<String> {
        self.account(account_id)?
            .lists
            .iter()
            .find(|l| l.id == list_id)
            .map(|l| l.title.clone())
    }

    /// Refused unless Pheeme may use the account's tasks.
    fn require_access(&self, account: &AccountInfo) -> Result<&TasksAccountDto, ApiError> {
        match self.account(&account.id) {
            Some(a) if a.access.status == "on" => Ok(a),
            Some(a) => Err(invalid(format!("{} {}", account.email, access_note(a)))),
            None => Err(invalid(format!("{} isn't connected.", account.email))),
        }
    }
}

fn due_date(raw: &str, which: &str) -> Result<(), ApiError> {
    NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| invalid(format!("{which} \"{raw}\" isn't a date like 2026-11-20.")))
}

fn task_row(t: &TaskDto, email: &str, list: Option<&str>) -> Value {
    let mut row = json!({
        "account": email,
        "list_id": t.list_id,
        "task_id": t.id,
        "title": t.title,
    });
    let map = row.as_object_mut().expect("an object");
    if let Some(list) = list {
        map.insert("list".into(), list.into());
    }
    if let Some(parent) = &t.parent {
        map.insert("parent".into(), parent.clone().into());
    }
    if let Some(notes) = t.notes.as_deref().filter(|n| !n.is_empty()) {
        map.insert("notes".into(), notes.into());
    }
    if let Some(due) = &t.due {
        map.insert("due".into(), due.clone().into());
    }
    if t.completed {
        map.insert("completed".into(), true.into());
    }
    row
}

async fn list_task_lists(api: &LocalApi, args: AccountArg) -> Result<Value, ApiError> {
    let ids: Vec<String> = resolve_accounts(api, args.account.as_deref())
        .await?
        .into_iter()
        .map(|a| a.id)
        .collect();
    let lists = Lists::load(api).await?;
    let accounts: Vec<Value> = lists
        .0
        .iter()
        .filter(|a| ids.contains(&a.account_id))
        .map(|a| {
            let lists: Vec<Value> = a
                .lists
                .iter()
                .map(|l| json!({ "list_id": l.id, "title": l.title }))
                .collect();
            let mut row = json!({
                "account": a.email,
                "access": a.access.status,
                "lists": lists,
            });
            if a.access.status != "on" {
                row["note"] = access_note(a).into();
            }
            row
        })
        .collect();
    Ok(json!({ "accounts": accounts }))
}

async fn list_tasks(api: &LocalApi, args: ListTasks) -> Result<Value, ApiError> {
    let ids: Vec<String> = resolve_accounts(api, args.account.as_deref())
        .await?
        .into_iter()
        .map(|a| a.id)
        .collect();
    if let Some(due_by) = &args.due_by {
        due_date(due_by, "due_by")?;
    }
    let only = args
        .list_id
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty());
    let limit = args.limit.unwrap_or(DEFAULT_TASKS).clamp(1, MAX_TASKS) as usize;
    let lists = Lists::load(api).await?;
    let mut rows = Vec::new();
    let mut total = 0;
    let mut notes = Vec::new();
    for account in lists.0.iter().filter(|a| ids.contains(&a.account_id)) {
        if account.access.status != "on" {
            notes.push(json!({
                "account": account.email,
                "access": account.access.status,
                "note": access_note(account),
            }));
            continue;
        }
        for list in account
            .lists
            .iter()
            .filter(|l| only.is_none_or(|o| l.id == o))
        {
            let tasks = api.tasks.tasks(&account.account_id, &list.id).await?;
            for t in tasks
                .iter()
                .filter(|t| !t.hidden && (args.include_completed || !t.completed))
                .filter(|t| match (&args.due_by, &t.due) {
                    (None, _) => true,
                    (Some(by), Some(due)) => due.as_str() <= by.trim(),
                    (Some(_), None) => false,
                })
            {
                total += 1;
                if rows.len() < limit {
                    rows.push(task_row(t, &account.email, Some(&list.title)));
                }
            }
        }
    }
    let mut out = json!({ "tasks": rows });
    if total > rows.len() {
        out["more"] = json!(format!(
            "{} more tasks; name a list_id or raise limit.",
            total - rows.len()
        ));
    }
    if !notes.is_empty() {
        out["tasks_access"] = notes.into();
    }
    Ok(out)
}

/// The one account a change is for, with Pheeme's view of its tasks.
async fn account_lists(
    api: &LocalApi,
    account: Option<&str>,
) -> Result<(AccountInfo, Lists), ApiError> {
    let account = resolve_account(api, account).await?;
    let lists = Lists::load(api).await?;
    lists.require_access(&account)?;
    Ok((account, lists))
}

/// The task as it is after a change, for the answer: its ids alone if the cache can't say.
async fn written(api: &LocalApi, lists: &Lists, email: &str, done: &TaskRef) -> Value {
    let found = api
        .tasks
        .tasks(&done.account_id, &done.list_id)
        .await
        .ok()
        .and_then(|tasks| tasks.into_iter().find(|t| t.id == done.id));
    match found {
        Some(t) => task_row(
            &t,
            email,
            lists.list_name(&done.account_id, &done.list_id).as_deref(),
        ),
        None => json!({ "list_id": done.list_id, "task_id": done.id }),
    }
}

fn text(v: Option<String>) -> Option<String> {
    v.map(|t| t.trim().to_owned())
}

async fn create_task(api: &LocalApi, args: CreateTask) -> Result<Value, ApiError> {
    let (account, lists) = account_lists(api, args.account.as_deref()).await?;
    let list_id = match args
        .list_id
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
    {
        Some(id) => id.to_owned(),
        None => lists
            .account(&account.id)
            .and_then(|a| a.lists.first())
            .map(|l| l.id.clone())
            .ok_or_else(|| {
                invalid(format!(
                    "{} has no task lists; create one with create_task_list.",
                    account.email
                ))
            })?,
    };
    if args.title.trim().is_empty() {
        return Err(invalid("Give the task a title."));
    }
    if let Some(due) = &args.due {
        due_date(due, "due")?;
    }
    let edit = TaskEdit {
        title: Some(args.title.trim().to_owned()),
        notes: text(args.notes).filter(|n| !n.is_empty()),
        due: text(args.due),
    };
    let parent = text(args.parent).filter(|p| !p.is_empty());
    let done = api
        .tasks
        .create_task(&account.id, &list_id, edit, parent, None)
        .await?;
    Ok(json!({ "created": written(api, &lists, &account.email, &done).await }))
}

async fn update_task(api: &LocalApi, args: UpdateTask) -> Result<Value, ApiError> {
    let (account, lists) = account_lists(api, args.account.as_deref()).await?;
    let task_id = args.task_id.trim();
    let list_id = args.list_id.trim();
    if let Some(due) = args.due.as_deref().filter(|d| !d.trim().is_empty()) {
        due_date(due, "due")?;
    }
    let edit = TaskEdit {
        title: text(args.title),
        notes: text(args.notes),
        due: text(args.due),
    };
    let mut changed = Vec::new();
    let mut done = None;
    if edit != TaskEdit::default() {
        done = Some(
            api.tasks
                .update_task(&account.id, list_id, task_id, edit.clone())
                .await?,
        );
        for (name, set) in [
            ("title", edit.title.is_some()),
            ("notes", edit.notes.is_some()),
            ("due", edit.due.is_some()),
        ] {
            if set {
                changed.push(name);
            }
        }
    }
    if let Some(completed) = args.completed {
        done = Some(
            api.tasks
                .set_task_completed(&account.id, list_id, task_id, completed)
                .await?,
        );
        changed.push(if completed {
            "completed"
        } else {
            "not completed"
        });
    }
    if let Some(to) = args
        .move_to_list_id
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
    {
        if to != list_id {
            done = Some(
                api.tasks
                    .move_task_to_list(&account.id, list_id, task_id, to)
                    .await?,
            );
            changed.push("list");
        }
    }
    let Some(done) = done else {
        return Err(invalid("Nothing to change: give at least one field."));
    };
    Ok(json!({
        "changed": changed,
        "task": written(api, &lists, &account.email, &done).await,
    }))
}

async fn delete_task(api: &LocalApi, args: TaskArg) -> Result<Value, ApiError> {
    let (account, lists) = account_lists(api, args.account.as_deref()).await?;
    let (list_id, task_id) = (args.list_id.trim(), args.task_id.trim());
    let before = written(
        api,
        &lists,
        &account.email,
        &TaskRef {
            account_id: account.id.clone(),
            list_id: list_id.to_owned(),
            id: task_id.to_owned(),
        },
    )
    .await;
    api.tasks.delete_task(&account.id, list_id, task_id).await?;
    Ok(json!({ "deleted": before }))
}

async fn create_task_list(api: &LocalApi, args: CreateTaskList) -> Result<Value, ApiError> {
    let (account, _) = account_lists(api, args.account.as_deref()).await?;
    let made = api
        .tasks
        .create_task_list(&account.id, args.title.trim())
        .await?;
    Ok(json!({
        "account": account.email,
        "list_id": made.list_id,
        "title": args.title.trim(),
    }))
}
