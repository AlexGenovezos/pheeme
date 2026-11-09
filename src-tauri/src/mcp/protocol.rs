//! MCP's JSON-RPC methods, mapped onto the local API. Nothing here decides what a client may
//! do: tool calls go to [`LocalApi::call`], which checks and logs them.

use crate::local_api::{catalog, ApiError, Caller, LocalApi};
use serde_json::{json, Value};

/// Protocol versions this server speaks, newest first.
pub const PROTOCOL_VERSIONS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

const INSTRUCTIONS: &str = "Pheeme is the user's Gmail client. These tools work on their real mailbox \
through Pheeme, exactly as if they had used the app. Reads come from Pheeme's local copy and are fast; \
search_mail with gmail: true covers mail that isn't cached. Thread ids belong to one account, so pass \
the account a result came from when you act on it.";

/// The answer to one JSON-RPC message, or `None` for a notification (or a response the client
/// sent us), which gets no answer.
pub async fn handle(api: &LocalApi, caller: &Caller, message: Value) -> Option<Value> {
    let Some(object) = message.as_object() else {
        return Some(error(
            Value::Null,
            INVALID_REQUEST,
            "Expected one JSON-RPC message.",
        ));
    };
    let id = object.get("id").cloned();
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        // A response or junk without a method: nothing to answer unless it has an id.
        return id.map(|id| error(id, INVALID_REQUEST, "Missing method."));
    };
    let id = id?;
    let params = object.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => result(id, initialize(&params)),
        "ping" => result(id, json!({})),
        "tools/list" => result(id, tools_list()),
        "tools/call" => match tools_call(api, caller, &params).await {
            Ok(value) => result(id, value),
            Err(message) => error(id, INVALID_PARAMS, &message),
        },
        _ => error(
            id,
            METHOD_NOT_FOUND,
            &format!("Pheeme doesn't support {method}."),
        ),
    })
}

/// The reply to a body that isn't JSON at all.
pub fn parse_error() -> Value {
    error(Value::Null, PARSE_ERROR, "That isn't JSON.")
}

fn result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    let version = asked
        .filter(|v| PROTOCOL_VERSIONS.contains(v))
        .unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": {
            "name": "pheeme",
            "title": "Pheeme",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": INSTRUCTIONS,
    })
}

fn tools_list() -> Value {
    let tools: Vec<Value> = catalog()
        .into_iter()
        .map(|t| {
            json!({
                "name": t.name,
                "title": t.title,
                "description": t.description,
                "inputSchema": t.input_schema,
                "annotations": {
                    "title": t.title,
                    "readOnlyHint": t.read_only,
                    "openWorldHint": false,
                },
            })
        })
        .collect();
    json!({ "tools": tools })
}

/// A tool's answer. A tool that fails is still a result (`isError`), so the model reads why;
/// only a malformed call is a protocol error.
async fn tools_call(api: &LocalApi, caller: &Caller, params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("tools/call needs a tool name.")?;
    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
    if !args.is_null() && !args.is_object() {
        return Err("Tool arguments must be an object.".into());
    }
    Ok(match api.call(caller, name, args).await {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": value.to_string() }],
            "isError": false,
        }),
        Err(ApiError::UnknownTool(tool)) => {
            return Err(format!("Pheeme has no tool called {tool}."))
        }
        Err(e) => json!({
            "content": [{ "type": "text", "text": e.to_string() }],
            "isError": true,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_api::tests::setup;
    use crate::sync::fake::{FakeGmail, FakeMsg};

    #[tokio::test]
    async fn initializes_lists_and_calls_tools() {
        let fake = FakeGmail::new();
        fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]));
        let h = setup(fake).await;
        let rpc = |id: i64, method: &str, params: Value| json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });

        let init = handle(
            &h.api,
            &h.caller,
            rpc(1, "initialize", json!({ "protocolVersion": "2025-06-18" })),
        )
        .await
        .unwrap();
        assert_eq!(init["id"], 1);
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(init["result"]["serverInfo"]["name"], "pheeme");
        let unknown_version = handle(
            &h.api,
            &h.caller,
            rpc(2, "initialize", json!({ "protocolVersion": "1999-01-01" })),
        )
        .await
        .unwrap();
        assert_eq!(
            unknown_version["result"]["protocolVersion"],
            PROTOCOL_VERSIONS[0]
        );

        let notification = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert_eq!(handle(&h.api, &h.caller, notification).await, None);

        let list = handle(&h.api, &h.caller, rpc(3, "tools/list", json!({})))
            .await
            .unwrap();
        let names: Vec<_> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"search_mail"), "{names:?}");
        assert_eq!(
            list["result"]["tools"][0]["annotations"]["readOnlyHint"],
            true
        );

        let call = handle(
            &h.api,
            &h.caller,
            rpc(
                4,
                "tools/call",
                json!({ "name": "list_mailbox", "arguments": {} }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(call["result"]["isError"], false);
        let text = call["result"]["content"][0]["text"].as_str().unwrap();
        let body: Value = serde_json::from_str(text).unwrap();
        assert_eq!(body["threads"][0]["thread_id"], "t1");

        let failed = handle(
            &h.api,
            &h.caller,
            rpc(
                5,
                "tools/call",
                json!({ "name": "get_thread", "arguments": { "thread_id": "x" } }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(failed["result"]["isError"], true);

        let unknown = handle(
            &h.api,
            &h.caller,
            rpc(
                6,
                "tools/call",
                json!({ "name": "send_mail", "arguments": {} }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(unknown["error"]["code"], INVALID_PARAMS);

        let bad_args = handle(
            &h.api,
            &h.caller,
            rpc(
                7,
                "tools/call",
                json!({ "name": "list_mailbox", "arguments": [1] }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(bad_args["error"]["code"], INVALID_PARAMS);

        let missing = handle(&h.api, &h.caller, rpc(8, "resources/list", json!({})))
            .await
            .unwrap();
        assert_eq!(missing["error"]["code"], METHOD_NOT_FOUND);

        let ping = handle(&h.api, &h.caller, rpc(9, "ping", Value::Null))
            .await
            .unwrap();
        assert_eq!(ping["result"], json!({}));

        let batch = handle(&h.api, &h.caller, json!([rpc(10, "ping", Value::Null)]))
            .await
            .unwrap();
        assert_eq!(batch["error"]["code"], INVALID_REQUEST);
    }
}
