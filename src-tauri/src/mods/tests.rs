use super::*;
use std::{collections::HashMap, time::Instant};

#[derive(Default)]
struct MemoryKeychain(Mutex<HashMap<String, String>>);
impl Keychain for MemoryKeychain {
    fn read(&self, name: &str) -> keyring::Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }
    fn write(&self, name: &str, value: &str) -> keyring::Result<()> {
        self.0.lock().unwrap().insert(name.into(), value.into());
        Ok(())
    }
    fn delete(&self, name: &str) -> keyring::Result<()> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
}

async fn service(root: &Path) -> Arc<ModService> {
    ModService::open(
        root.to_path_buf(),
        Arc::new(MemoryKeychain::default()),
        false,
        Arc::new(|| {}),
        Arc::new(|_| Ok(())),
    )
    .await
    .unwrap()
}

fn counter(folder: &Path, id: &str) {
    fs::create_dir_all(folder).unwrap();
    let mut manifest: Value =
        serde_json::from_str(include_str!("../../../examples/mods/counter/manifest.json")).unwrap();
    manifest["id"] = json!(id);
    fs::write(folder.join("manifest.json"), manifest.to_string()).unwrap();
    fs::write(
        folder.join("main.js"),
        include_str!("../../../examples/mods/counter/main.js"),
    )
    .unwrap();
}

async fn wait_for(service: &ModService, predicate: impl Fn(&Snapshot) -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if predicate(&service.snapshot()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("mod state did not settle");
}

#[tokio::test]
async fn real_package_actions_storage_restart_disable_and_remove() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    counter(&source, "example.counter");
    let installed = root.path().join("installed");
    let mods = service(&installed).await;
    let prepared = mods.prepare(&source).unwrap();
    assert!(
        mods.snapshot().mods.is_empty(),
        "inspection must not execute code"
    );
    mods.install(&prepared.ticket).await.unwrap();
    wait_for(&mods, |s| s.mods[0].views.compact.len() == 2).await;
    mods.action("example.counter", "increment", Value::Null)
        .unwrap();
    wait_for(
        &mods,
        |s| matches!(&s.mods[0].views.compact[0], Block::Text {text} if text.ends_with(": 1")),
    )
    .await;
    mods.enable("example.counter", false).await.unwrap();
    assert!(mods
        .action("example.counter", "increment", Value::Null)
        .is_err());
    assert!(mods.snapshot().mods[0].views.compact.is_empty());
    mods.enable("example.counter", true).await.unwrap();
    wait_for(&mods, |s| {
        s.mods[0]
            .views
            .compact
            .first()
            .is_some_and(|b| matches!(b, Block::Text {text} if text.ends_with(": 1")))
    })
    .await;
    drop(mods);
    let mods = service(&installed).await;
    wait_for(&mods, |s| {
        s.mods[0]
            .views
            .panel
            .first()
            .is_some_and(|b| matches!(b, Block::Text {text} if text.ends_with(": 1")))
    })
    .await;
    mods.remove("example.counter", false).await.unwrap();
    assert!(mods.snapshot().mods.is_empty());
    assert!(!installed.join("data/example.counter.json").exists());
}

#[tokio::test]
async fn failed_update_restores_previous_package_and_safe_mode_never_runs_code() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    counter(&source, "example.counter");
    let installed = root.path().join("installed");
    let mods = service(&installed).await;
    let first = mods.prepare(&source).unwrap();
    mods.install(&first.ticket).await.unwrap();
    fs::write(source.join("main.js"), "while (true) {}").unwrap();
    let update = mods.prepare(&source).unwrap();
    assert!(update.replacing);
    let start = Instant::now();
    assert!(mods.install(&update.ticket).await.is_err());
    assert!(start.elapsed() < Duration::from_secs(3));
    wait_for(&mods, |s| {
        s.mods[0].running && !s.mods[0].views.panel.is_empty()
    })
    .await;
    assert!(mods.snapshot().mods[0].error.is_some());
    drop(mods);
    let safe = ModService::open(
        installed,
        Arc::new(MemoryKeychain::default()),
        true,
        Arc::new(|| {}),
        Arc::new(|_| panic!("safe mode opened browser")),
    )
    .await
    .unwrap();
    assert!(safe.snapshot().safe_mode);
    assert!(!safe.snapshot().mods[0].running);
    assert!(safe.enable("example.counter", true).await.is_err());
}

#[tokio::test]
async fn runtime_has_no_ambient_capabilities_and_interrupts_adversarial_scripts() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    counter(&source, "sandbox.test");
    let mods = service(&root.path().join("installed")).await;
    fs::write(source.join("main.js"), r#"
      for (const name of ["window", "document", "fetch", "XMLHttpRequest", "WebSocket", "process", "require", "std", "os", "__TAURI_INTERNALS__", "__host"]) {
        if (typeof globalThis[name] !== "undefined") throw new Error("ambient capability: " + name);
      }
      pheeme.render("panel", [{ type: "text", text: "isolated" }]);
    "#).unwrap();
    let prepared = mods.prepare(&source).unwrap();
    mods.install(&prepared.ticket).await.unwrap();
    wait_for(&mods, |s| !s.mods[0].views.panel.is_empty()).await;
    for script in [
        "while(true) {}",
        "function again() { Promise.resolve().then(again); } again();",
        "const a = []; while(true) a.push(new Uint8Array(1024 * 1024));",
        "throw new Error('failure')",
        "for(let i=0;i<1000;i++) pheeme.render('panel', []);",
    ] {
        fs::write(source.join("main.js"), script).unwrap();
        let prepared = mods.prepare(&source).unwrap();
        let start = Instant::now();
        assert!(
            mods.install(&prepared.ticket).await.is_err(),
            "script should fail: {script}"
        );
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}

#[tokio::test]
async fn session_identity_storage_isolation_and_disable_cancel_late_work() {
    let root = tempfile::tempdir().unwrap();
    let mods = service(&root.path().join("installed")).await;
    for id in ["one", "two"] {
        let source = root.path().join(id);
        counter(&source, id);
        let prepared = mods.prepare(&source).unwrap();
        mods.install(&prepared.ticket).await.unwrap();
    }
    wait_for(&mods, |s| s.mods.iter().all(|m| !m.views.panel.is_empty())).await;
    let generation = mods.state.lock().unwrap().sessions["one"]
        .generation
        .clone();
    let call = |method: &str, args| runtime::Call {
        id: 1,
        method: method.into(),
        args,
    };
    mods.handle(
        "one",
        &generation,
        call("storage.set", json!({"key":"private", "value":"one"})),
    )
    .await
    .unwrap();
    let two_generation = mods.state.lock().unwrap().sessions["two"]
        .generation
        .clone();
    assert!(mods
        .handle(
            "two",
            &two_generation,
            call("storage.get", json!({"key":"private"}))
        )
        .await
        .unwrap()
        .is_null());
    assert!(mods
        .handle(
            "one",
            &generation,
            call("storage.set", json!({"key":"../two", "value":"bad"}))
        )
        .await
        .is_err());
    mods.enable("one", false).await.unwrap();
    assert!(mods
        .handle(
            "one",
            &generation,
            call("storage.set", json!({"key":"private", "value":"late"}))
        )
        .await
        .is_err());
    assert!(!mods.snapshot().mods[0].running);
    assert!(mods.snapshot().mods[1].running);
}

#[test]
fn validation_rejects_escaping_paths_unknown_permissions_and_limits() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    counter(&source, "example.counter");
    for entry in ["../main.js", "/main.js", "dir/../../main.js", "C:\\main.js"] {
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(source.join("manifest.json")).unwrap())
                .unwrap();
        manifest["entry"] = json!(entry);
        fs::write(source.join("manifest.json"), manifest.to_string()).unwrap();
        let target = root.path().join(uuid::Uuid::new_v4().to_string());
        assert!(package::stage(&source, &target).is_err());
    }
    counter(&source, "example.counter");
    fs::write(
        source.join("large.bin"),
        vec![0; package::MAX_PACKAGE as usize + 1],
    )
    .unwrap();
    assert!(package::stage(&source, &root.path().join("oversized")).is_err());
    let mut manifest: Value =
        serde_json::from_str(include_str!("../../../examples/mods/counter/manifest.json")).unwrap();
    manifest["permissions"]["mail"] = json!(true);
    assert!(serde_json::from_value::<Manifest>(manifest).is_err());
    assert!(validate_blocks(&vec![Block::Text { text: "a".into() }; 5], true).is_err());
}

#[cfg(unix)]
#[test]
fn package_rejects_symlinks() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    counter(&source, "example.counter");
    std::os::unix::fs::symlink("/etc/passwd", source.join("secret")).unwrap();
    assert!(package::stage(&source, &root.path().join("copy")).is_err());
}

#[tokio::test]
async fn declared_origins_do_not_grant_local_network_access() {
    let mut manifest: Manifest =
        serde_json::from_str(include_str!("../../../examples/mods/spotify/manifest.json")).unwrap();
    manifest.validate().unwrap();
    let request = |url: &str, connection: Option<&str>| network::Request {
        url: url.into(),
        method: "GET".into(),
        body: None,
        content_type: None,
        connection: connection.map(str::to_owned),
    };
    assert!(network::allowed(
        &manifest,
        &request("https://api.spotify.com/v1/me", Some("spotify"))
    )
    .is_ok());
    for url in [
        "https://api.spotify.com.evil.test/v1",
        "http://api.spotify.com/v1",
        "https://evil.test/v1",
        "https://api.spotify.com@evil.test/v1",
    ] {
        assert!(network::allowed(&manifest, &request(url, Some("spotify"))).is_err());
    }
    assert!(network::allowed(&manifest, &request("https://api.spotify.com/v1/me", None)).is_err());
    for ip in [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "224.0.0.1",
        "198.18.0.1",
        "192.0.2.1",
        "::1",
        "fc00::1",
        "fe80::1",
        "::ffff:127.0.0.1",
        "2001:db8::1",
        "2002:7f00:1::",
        "3fff::1",
    ] {
        assert!(!network::public_ip(ip.parse().unwrap()), "{ip}");
    }
    for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
        assert!(network::public_ip(ip.parse().unwrap()));
    }
    manifest
        .permissions
        .network
        .push("https://127.0.0.1".into());
    let url = network::allowed(&manifest, &request("https://127.0.0.1", None)).unwrap();
    assert!(network::client(&url).await.is_err());
}

#[test]
fn tokens_are_namespaced_and_disconnect_preserves_other_connections() {
    let store = MemoryKeychain::default();
    let tokens = oauth::Tokens {
        access_token: "access-secret".into(),
        refresh_token: Some("refresh-secret".into()),
        expires_at: i64::MAX,
        client_id: "client".into(),
    };
    oauth::commit(&store, "one", "spotify", &tokens).unwrap();
    oauth::commit(&store, "two", "spotify", &tokens).unwrap();
    assert!(oauth::read(&store, "one", "other").unwrap().is_none());
    oauth::disconnect(&store, "one", "spotify").unwrap();
    assert!(oauth::read(&store, "one", "spotify").unwrap().is_none());
    assert!(oauth::read(&store, "two", "spotify").unwrap().is_some());
}

#[tokio::test]
async fn disable_cancels_browser_login_and_no_credential_is_saved() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    counter(&source, "login.test");
    let mut manifest: Value =
        serde_json::from_str(&fs::read_to_string(source.join("manifest.json")).unwrap()).unwrap();
    manifest["permissions"]["connections"] = json!([{
        "id":"test", "name":"Test", "authorizationUrl":"https://8.8.8.8/authorize", "tokenUrl":"https://8.8.8.8/token", "scopes":["read"], "apiOrigins":["https://8.8.8.8"]
    }]);
    fs::write(source.join("manifest.json"), manifest.to_string()).unwrap();
    let (opened, mut browser) = tokio::sync::mpsc::unbounded_channel();
    let keychain = Arc::new(MemoryKeychain::default());
    let mods = ModService::open(
        root.path().join("installed"),
        keychain.clone(),
        false,
        Arc::new(|| {}),
        Arc::new(move |url| {
            opened.send(url.to_owned()).unwrap();
            Ok(())
        }),
    )
    .await
    .unwrap();
    let prepared = mods.prepare(&source).unwrap();
    mods.install(&prepared.ticket).await.unwrap();
    let service = mods.clone();
    let login = tokio::spawn(async move { service.connect("login.test", "test", "client").await });
    let url = tokio::time::timeout(Duration::from_secs(3), browser.recv())
        .await
        .unwrap()
        .unwrap();
    let url = reqwest::Url::parse(&url).unwrap();
    assert!(url
        .query_pairs()
        .any(|(key, value)| key == "code_challenge_method" && value == "S256"));
    assert!(url
        .query_pairs()
        .any(|(key, value)| key == "state" && value.len() >= 32));
    mods.enable("login.test", false).await.unwrap();
    assert!(login.await.unwrap().is_err());
    assert!(keychain.0.lock().unwrap().is_empty());
}
