//! An in-memory Google Tasks for tests: lists, tasks with an `updated` clock so `updatedMin`
//! returns only what changed, Google's positions and subtasks, deleted tasks kept as
//! `deleted: true`, and switches for failures.

use super::TasksApi;
use crate::gmail::tasks::{
    ApiTask, ApiTaskList, TaskListsPage, TaskPlacement, TasksPage, TasksQuery,
};
use crate::gmail::GmailError;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

/// Items per `list_tasks` page, small so tests cross pages.
const PAGE: usize = 2;

/// The fake's clock: `seq` seconds after this.
const EPOCH_MS: i64 = 1_793_491_200_000; // 2026-11-01T00:00:00Z

fn stamp(seq: u64) -> String {
    super::convert::rfc3339(EPOCH_MS + i64::try_from(seq).unwrap_or_default() * 1000)
}

/// One write the fake received.
#[derive(Debug, Clone, PartialEq)]
pub struct FakeWrite {
    /// `insert`, `patch`, `delete`, `move`, `insert_list`, `patch_list` or `delete_list`.
    pub method: &'static str,
    pub list_id: String,
    pub task_id: Option<String>,
    pub body: Value,
    pub parent: Option<String>,
    pub previous: Option<String>,
    pub destination: Option<String>,
}

#[derive(Clone, Copy)]
enum Plan {
    Fail(fn() -> GmailError),
    FailAfterApply(fn() -> GmailError),
}

#[derive(Default)]
struct State {
    lists: Vec<Value>,
    /// Per list: every task Google has, deleted ones (`deleted: true`) too.
    tasks: HashMap<String, Vec<Value>>,
    seq: u64,
    fail: Option<fn() -> GmailError>,
    /// `list_tasks` calls: (list, updatedMin, showDeleted).
    reads: Vec<(String, Option<String>, bool)>,
    writes: Vec<FakeWrite>,
    write_count: usize,
    plans: HashMap<usize, Plan>,
}

fn not_found() -> GmailError {
    GmailError::Api {
        status: 404,
        reason: Some("notFound".into()),
        message: "Not Found".into(),
    }
}

fn bad_request(message: &str) -> GmailError {
    GmailError::Api {
        status: 400,
        reason: Some("invalid".into()),
        message: message.into(),
    }
}

fn reply_lost() -> GmailError {
    GmailError::Network("reply lost".into())
}

impl State {
    fn tick(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    /// Stamp a new version of a task: `updated` from the clock, etag `"v{seq}"`.
    fn touch(&mut self, task: &mut Value) {
        let seq = self.tick();
        task["updated"] = json!(stamp(seq));
        task["etag"] = json!(format!("\"v{seq}\""));
    }

    fn list_exists(&self, list_id: &str) -> bool {
        self.lists.iter().any(|l| l["id"] == list_id)
    }

    fn live(&self, list_id: &str, id: &str) -> Option<usize> {
        self.tasks
            .get(list_id)?
            .iter()
            .position(|t| t["id"] == id && t["deleted"] != true)
    }

    /// Put `id` right after `previous` among the tasks under `parent`, then number the
    /// siblings again (as Google may), stamping every task whose position changed.
    fn place(&mut self, list_id: &str, id: &str, parent: Option<&str>, previous: Option<&str>) {
        let mut tasks = self.tasks.remove(list_id).unwrap_or_default();
        let parent_of = |t: &Value| t["parent"].as_str().map(str::to_owned);
        let mut siblings: Vec<(String, String)> = tasks
            .iter()
            .filter(|t| t["deleted"] != true && t["id"] != id)
            .filter(|t| parent_of(t).as_deref() == parent)
            .map(|t| {
                (
                    t["position"].as_str().unwrap_or_default().to_owned(),
                    t["id"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        siblings.sort();
        let mut order: Vec<String> = siblings.into_iter().map(|(_, id)| id).collect();
        let at = previous
            .and_then(|p| order.iter().position(|o| o == p))
            .map_or(0, |i| i + 1);
        order.insert(at, id.to_owned());
        for (i, sibling) in order.iter().enumerate() {
            let position = format!("{i:020}");
            if let Some(t) = tasks.iter_mut().find(|t| t["id"] == sibling.as_str()) {
                let parent_changed = sibling == id && parent_of(t).as_deref() != parent;
                if t["position"] != position.as_str() || parent_changed {
                    t["position"] = json!(position);
                    match parent {
                        Some(p) if sibling == id => t["parent"] = json!(p),
                        None if sibling == id => {
                            t.as_object_mut().map(|o| o.remove("parent"));
                        }
                        _ => {}
                    }
                    self.touch(t);
                }
            }
        }
        self.tasks.insert(list_id.to_owned(), tasks);
    }

    /// Mark a task and its subtasks deleted, as Google reports them.
    fn delete(&mut self, list_id: &str, id: &str) {
        let mut tasks = self.tasks.remove(list_id).unwrap_or_default();
        for t in tasks
            .iter_mut()
            .filter(|t| t["deleted"] != true && (t["id"] == id || t["parent"] == id))
        {
            let keep = json!({"id": t["id"].clone(), "deleted": true});
            *t = keep;
            self.touch(t);
        }
        self.tasks.insert(list_id.to_owned(), tasks);
    }
}

#[derive(Default)]
pub struct FakeTasks {
    state: Mutex<State>,
}

/// A task JSON with a title and Google's defaults.
pub fn task(id: &str, title: &str) -> Value {
    json!({"id": id, "title": title, "status": "needsAction"})
}

fn api_task(v: Value) -> Result<ApiTask, GmailError> {
    ApiTask::try_from(v)
}

fn api_list(v: &Value) -> ApiTaskList {
    serde_json::from_value(v.clone()).expect("fake list")
}

impl FakeTasks {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    pub fn add_list(&self, id: &str, title: &str) {
        let mut s = self.lock();
        let seq = s.tick();
        s.lists.push(
            json!({"id": id, "title": title, "etag": format!("\"l{seq}\""),
                            "updated": stamp(seq)}),
        );
        s.tasks.entry(id.into()).or_default();
    }

    /// Change a list as someone else would (a rename on the website).
    pub fn rename_list(&self, id: &str, title: &str) {
        let mut s = self.lock();
        let seq = s.tick();
        if let Some(l) = s.lists.iter_mut().find(|l| l["id"] == id) {
            l["title"] = json!(title);
            l["etag"] = json!(format!("\"l{seq}\""));
        }
    }

    /// Remove a list, as deleting it on the website does.
    pub fn remove_list(&self, id: &str) {
        let mut s = self.lock();
        s.lists.retain(|l| l["id"] != id);
        s.tasks.remove(id);
    }

    /// Add or change a task (merging `fields` into it), as another device would. A new task
    /// goes last among its siblings unless it names a `position`.
    pub fn put(&self, list_id: &str, fields: Value) {
        let mut s = self.lock();
        let id = fields["id"].as_str().expect("task id").to_owned();
        let tasks = s.tasks.entry(list_id.into()).or_default();
        let index = match tasks.iter().position(|t| t["id"] == id.as_str()) {
            Some(i) => i,
            None => {
                let count = tasks
                    .iter()
                    .filter(|t| t["deleted"] != true && t["parent"] == fields["parent"])
                    .count();
                tasks.push(json!({"id": id, "status": "needsAction", "title": "",
                                  "position": format!("{count:020}")}));
                tasks.len() - 1
            }
        };
        let mut t = tasks[index].take();
        for (k, v) in fields.as_object().expect("task object") {
            if v.is_null() {
                t.as_object_mut().map(|o| o.remove(k));
            } else {
                t[k] = v.clone();
            }
        }
        s.touch(&mut t);
        s.tasks.get_mut(list_id).expect("list")[index] = t;
    }

    /// Delete a task (and its subtasks) as Google reports it: `deleted: true`.
    pub fn remove(&self, list_id: &str, id: &str) {
        self.lock().delete(list_id, id);
    }

    /// Forget a task without a trace (only a full listing notices it's gone).
    pub fn forget(&self, list_id: &str, id: &str) {
        if let Some(tasks) = self.lock().tasks.get_mut(list_id) {
            tasks.retain(|t| t["id"] != id);
        }
    }

    /// The current version of a task (a deleted one too), for assertions.
    pub fn task(&self, list_id: &str, id: &str) -> Option<Value> {
        self.lock()
            .tasks
            .get(list_id)?
            .iter()
            .find(|t| t["id"] == id)
            .cloned()
    }

    /// The live tasks of a list as (id, parent, title), in Google's order (parents by
    /// position, each followed by its subtasks).
    pub fn outline(&self, list_id: &str) -> Vec<(String, Option<String>, String)> {
        let s = self.lock();
        let live: Vec<&Value> = s
            .tasks
            .get(list_id)
            .map(|t| t.iter().filter(|t| t["deleted"] != true).collect())
            .unwrap_or_default();
        let key = |t: &&Value| t["position"].as_str().unwrap_or_default().to_owned();
        let mut top: Vec<&Value> = live
            .iter()
            .copied()
            .filter(|t| t["parent"].is_null())
            .collect();
        top.sort_by_key(key);
        let row = |t: &Value| {
            (
                t["id"].as_str().unwrap_or_default().to_owned(),
                t["parent"].as_str().map(str::to_owned),
                t["title"].as_str().unwrap_or_default().to_owned(),
            )
        };
        let mut out = Vec::new();
        for p in top {
            out.push(row(p));
            let mut subs: Vec<&Value> = live
                .iter()
                .copied()
                .filter(|t| t["parent"] == p["id"])
                .collect();
            subs.sort_by_key(key);
            out.extend(subs.into_iter().map(row));
        }
        out
    }

    pub fn list_titles(&self) -> Vec<String> {
        self.lock()
            .lists
            .iter()
            .map(|l| l["title"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    /// Every call fails with `make()` until [`Self::succeed`].
    pub fn fail_with(&self, make: fn() -> GmailError) {
        self.lock().fail = Some(make);
    }

    pub fn succeed(&self) {
        self.lock().fail = None;
    }

    /// `list_tasks` calls so far: (list, updatedMin, showDeleted).
    pub fn reads(&self) -> Vec<(String, Option<String>, bool)> {
        std::mem::take(&mut self.lock().reads)
    }

    pub fn writes(&self) -> Vec<FakeWrite> {
        self.lock().writes.clone()
    }

    /// The `n`-th write from now (0-based) fails with `make()` without applying.
    pub fn fail_write(&self, n: usize, make: fn() -> GmailError) {
        let mut s = self.lock();
        let at = s.write_count + n;
        s.plans.insert(at, Plan::Fail(make));
    }

    /// The `n`-th write from now (0-based) applies, then its reply is lost.
    pub fn lose_reply(&self, n: usize) {
        let mut s = self.lock();
        let at = s.write_count + n;
        s.plans.insert(at, Plan::FailAfterApply(reply_lost));
    }

    /// Record a write; `Err` if it must fail unapplied, `Some(error)` if it applies and then
    /// answers that error.
    #[allow(clippy::type_complexity)]
    fn begin(&self, write: FakeWrite) -> Result<Option<fn() -> GmailError>, GmailError> {
        let mut s = self.lock();
        if let Some(make) = s.fail {
            return Err(make());
        }
        let at = s.write_count;
        s.write_count += 1;
        s.writes.push(write);
        match s.plans.remove(&at) {
            Some(Plan::Fail(make)) => Err(make()),
            Some(Plan::FailAfterApply(make)) => Ok(Some(make)),
            None => Ok(None),
        }
    }
}

fn reply<T>(
    lost: Option<fn() -> GmailError>,
    result: Result<T, GmailError>,
) -> Result<T, GmailError> {
    match (lost, result) {
        (Some(make), Ok(_)) => Err(make()),
        (_, r) => r,
    }
}

fn write(method: &'static str, list_id: &str, task_id: Option<&str>, body: Value) -> FakeWrite {
    FakeWrite {
        method,
        list_id: list_id.into(),
        task_id: task_id.map(str::to_owned),
        body,
        parent: None,
        previous: None,
        destination: None,
    }
}

#[async_trait::async_trait]
impl TasksApi for FakeTasks {
    async fn list_task_lists(&self, page_token: Option<&str>) -> Result<TaskListsPage, GmailError> {
        let s = self.lock();
        if let Some(make) = s.fail {
            return Err(make());
        }
        let start: usize = page_token.and_then(|p| p.parse().ok()).unwrap_or(0);
        let end = (start + PAGE).min(s.lists.len());
        Ok(TaskListsPage {
            items: s.lists[start..end].iter().map(api_list).collect(),
            next_page_token: (end < s.lists.len()).then(|| end.to_string()),
        })
    }

    async fn insert_task_list(&self, title: &str) -> Result<ApiTaskList, GmailError> {
        let lost = self.begin(write("insert_list", "", None, json!({"title": title})))?;
        let mut s = self.lock();
        let seq = s.tick();
        let list = json!({"id": format!("l{seq}"), "title": title, "etag": format!("\"l{seq}\""),
                          "updated": stamp(seq)});
        s.lists.push(list.clone());
        s.tasks.entry(format!("l{seq}")).or_default();
        reply(lost, Ok(api_list(&list)))
    }

    async fn patch_task_list(&self, list_id: &str, title: &str) -> Result<ApiTaskList, GmailError> {
        let lost = self.begin(write("patch_list", list_id, None, json!({"title": title})))?;
        let mut s = self.lock();
        let seq = s.tick();
        let list = s
            .lists
            .iter_mut()
            .find(|l| l["id"] == list_id)
            .ok_or_else(not_found)?;
        list["title"] = json!(title);
        list["etag"] = json!(format!("\"l{seq}\""));
        reply(lost, Ok(api_list(list)))
    }

    async fn delete_task_list(&self, list_id: &str) -> Result<(), GmailError> {
        let lost = self.begin(write("delete_list", list_id, None, Value::Null))?;
        let mut s = self.lock();
        s.lists.retain(|l| l["id"] != list_id);
        s.tasks.remove(list_id);
        reply(lost, Ok(()))
    }

    async fn list_tasks(
        &self,
        list_id: &str,
        query: TasksQuery<'_>,
    ) -> Result<TasksPage, GmailError> {
        let mut s = self.lock();
        if let Some(make) = s.fail {
            return Err(make());
        }
        if !s.list_exists(list_id) {
            return Err(not_found());
        }
        if query.page_token.is_none() {
            s.reads.push((
                list_id.to_owned(),
                query.updated_min.map(str::to_owned),
                query.show_deleted,
            ));
        }
        let min = query.updated_min.and_then(|m| super::convert::ms(Some(m)));
        let matching: Vec<Value> = s.tasks[list_id]
            .iter()
            .filter(|t| query.show_deleted || t["deleted"] != true)
            .filter(|t| {
                min.is_none_or(|m| {
                    super::convert::ms(t["updated"].as_str()).is_some_and(|u| u >= m)
                })
            })
            .cloned()
            .collect();
        let start: usize = query.page_token.and_then(|p| p.parse().ok()).unwrap_or(0);
        let end = (start + PAGE).min(matching.len());
        Ok(TasksPage {
            items: matching[start..end]
                .iter()
                .cloned()
                .map(api_task)
                .collect::<Result<_, _>>()?,
            next_page_token: (end < matching.len()).then(|| end.to_string()),
        })
    }

    async fn insert_task(
        &self,
        list_id: &str,
        body: Value,
        placement: TaskPlacement<'_>,
    ) -> Result<ApiTask, GmailError> {
        let mut w = write("insert", list_id, None, body.clone());
        w.parent = placement.parent.map(str::to_owned);
        w.previous = placement.previous.map(str::to_owned);
        let lost = self.begin(w)?;
        let mut s = self.lock();
        if !s.list_exists(list_id) {
            return Err(not_found());
        }
        if let Some(p) = placement.parent {
            s.live(list_id, p)
                .ok_or_else(|| bad_request("Invalid parent"))?;
        }
        let seq = s.tick();
        let id = format!("t{seq}");
        let mut task = json!({"id": id, "title": "", "status": "needsAction", "position": ""});
        for (k, v) in body.as_object().cloned().unwrap_or_default() {
            if !v.is_null() {
                task[k] = v;
            }
        }
        if task["status"] == "completed" {
            task["completed"] = json!(stamp(seq));
        }
        s.touch(&mut task);
        s.tasks.entry(list_id.into()).or_default().push(task);
        s.place(list_id, &id, placement.parent, placement.previous);
        let i = s.live(list_id, &id).expect("inserted");
        reply(lost, api_task(s.tasks[list_id][i].clone()))
    }

    async fn patch_task(
        &self,
        list_id: &str,
        task_id: &str,
        body: Value,
    ) -> Result<ApiTask, GmailError> {
        let lost = self.begin(write("patch", list_id, Some(task_id), body.clone()))?;
        let mut s = self.lock();
        let i = s.live(list_id, task_id).ok_or_else(not_found)?;
        let mut t = s.tasks.get_mut(list_id).expect("list")[i].take();
        for (k, v) in body.as_object().cloned().unwrap_or_default() {
            if v.is_null() {
                t.as_object_mut().map(|o| o.remove(&k));
            } else {
                t[k] = v;
            }
        }
        if t["status"] == "completed" && t["completed"].is_null() {
            t["completed"] = json!(stamp(s.seq + 1));
        } else if t["status"] == "needsAction" {
            t.as_object_mut().map(|o| o.remove("completed"));
        }
        s.touch(&mut t);
        s.tasks.get_mut(list_id).expect("list")[i] = t.clone();
        reply(lost, api_task(t))
    }

    async fn delete_task(&self, list_id: &str, task_id: &str) -> Result<(), GmailError> {
        let lost = self.begin(write("delete", list_id, Some(task_id), Value::Null))?;
        // Like the client: a task that is already gone counts as deleted.
        self.lock().delete(list_id, task_id);
        reply(lost, Ok(()))
    }

    async fn move_task(
        &self,
        list_id: &str,
        task_id: &str,
        placement: TaskPlacement<'_>,
        destination: Option<&str>,
    ) -> Result<ApiTask, GmailError> {
        let mut w = write("move", list_id, Some(task_id), Value::Null);
        w.parent = placement.parent.map(str::to_owned);
        w.previous = placement.previous.map(str::to_owned);
        w.destination = destination.map(str::to_owned);
        let lost = self.begin(w)?;
        let mut s = self.lock();
        let i = s.live(list_id, task_id).ok_or_else(not_found)?;
        if let Some(p) = placement.parent {
            if p == task_id {
                return Err(bad_request("Invalid parent"));
            }
            s.live(list_id, p)
                .ok_or_else(|| bad_request("Invalid parent"))?;
        }
        match destination.filter(|d| *d != list_id) {
            None => {
                s.place(list_id, task_id, placement.parent, placement.previous);
                let i = s.live(list_id, task_id).expect("moved");
                reply(lost, api_task(s.tasks[list_id][i].clone()))
            }
            Some(dest) => {
                if !s.list_exists(dest) {
                    return Err(not_found());
                }
                // The task (and its subtasks) leaves the list and arrives in `dest` with new
                // ids, at the top.
                let moving = s.tasks[list_id][i].clone();
                let subtasks: Vec<Value> = s.tasks[list_id]
                    .iter()
                    .filter(|t| t["deleted"] != true && t["parent"] == task_id)
                    .cloned()
                    .collect();
                s.delete(list_id, task_id);
                let new_id = format!("t{}", s.tick());
                let mut moved = moving;
                moved["id"] = json!(new_id);
                moved.as_object_mut().map(|o| o.remove("parent"));
                s.touch(&mut moved);
                s.tasks.entry(dest.into()).or_default().push(moved);
                s.place(dest, &new_id, None, None);
                for mut sub in subtasks {
                    sub["id"] = json!(format!("t{}", s.tick()));
                    sub["parent"] = json!(new_id);
                    s.touch(&mut sub);
                    s.tasks.get_mut(dest).expect("dest").push(sub);
                }
                let i = s.live(dest, &new_id).expect("moved");
                reply(lost, api_task(s.tasks[dest][i].clone()))
            }
        }
    }
}
