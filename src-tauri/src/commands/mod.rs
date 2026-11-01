pub mod accounts;
pub mod auth;
pub mod labels;
pub mod messages;
pub mod search;
pub mod settings;
pub mod threads;

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Pheeme is ready.", name)
}
