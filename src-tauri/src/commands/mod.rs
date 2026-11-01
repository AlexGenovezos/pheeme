pub mod auth;
pub mod messages;
pub mod labels;
pub mod threads;
pub mod search;
pub mod accounts;
pub mod settings;

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Gmail Client is ready.", name)
}
