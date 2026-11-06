fn main() {
    // `.cargo/config.toml` builds the bundled SQLite without SQLITE_ENABLE_MEMORY_MANAGEMENT,
    // whose shared page cache makes the pool's connections read one at a time. Fail a build
    // that misses it rather than ship that.
    println!("cargo:rerun-if-env-changed=LIBSQLITE3_FLAGS");
    let flags = std::env::var("LIBSQLITE3_FLAGS").unwrap_or_default();
    assert!(
        flags
            .split_whitespace()
            .any(|f| f == "-USQLITE_ENABLE_MEMORY_MANAGEMENT"),
        "LIBSQLITE3_FLAGS must include -USQLITE_ENABLE_MEMORY_MANAGEMENT; it is set in \
         .cargo/config.toml, which cargo reads when run inside the repository"
    );
    println!("cargo:rerun-if-changed=src/desktop/notifications.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/desktop/notifications.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("pheeme_notifications");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
    }
    tauri_build::build()
}
