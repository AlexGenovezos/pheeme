fn main() {
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
