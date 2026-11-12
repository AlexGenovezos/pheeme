//! One D-Bus connection and signal listener for all notification clicks, without blocked threads.
use super::super::{activate, join_call, NotifyTarget};
use futures::StreamExt;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, OnceLock};
use tauri::AppHandle;
use tokio::sync::{mpsc, oneshot};
use zbus::{Connection, Proxy};

struct Delivery {
    target: NotifyTarget,
    title: String,
    body: String,
    /// A video call: the notification gets a Join button.
    join: Option<String>,
    result: oneshot::Sender<anyhow::Result<()>>,
}
static SEND: OnceLock<mpsc::Sender<Delivery>> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<Delivery>(128);
    if SEND.set(tx).is_err() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(serve(
        rx,
        None,
        Arc::new(move |clicked| match clicked {
            Clicked::Open(target) => activate(&app, target),
            Clicked::Join(url) => join_call(&url),
        }),
    ));
}

/// What the user clicked: the notification, or its Join button.
#[derive(Debug, PartialEq)]
enum Clicked {
    Open(NotifyTarget),
    Join(String),
}

async fn serve(
    mut rx: mpsc::Receiver<Delivery>,
    address: Option<String>,
    on_click: Arc<dyn Fn(Clicked) + Send + Sync>,
) {
    // A notification daemon may start late or restart. Reconnect on the next delivery.
    while let Some(first) = rx.recv().await {
        let connected = match &address {
            Some(address) => match zbus::connection::Builder::address(address.as_str()) {
                Ok(builder) => builder.build().await,
                Err(error) => Err(error),
            },
            None => Connection::session().await,
        };
        let connection = match connected {
            Ok(c) => c,
            Err(e) => {
                let _ = first.result.send(Err(e.into()));
                continue;
            }
        };
        let proxy = match Proxy::new(
            &connection,
            "org.freedesktop.Notifications",
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        )
        .await
        {
            Ok(p) => p,
            Err(e) => {
                let _ = first.result.send(Err(e.into()));
                continue;
            }
        };
        let mut actions = match proxy.receive_signal("ActionInvoked").await {
            Ok(s) => s,
            Err(e) => {
                let _ = first.result.send(Err(e.into()));
                continue;
            }
        };
        let mut closed = match proxy.receive_signal("NotificationClosed").await {
            Ok(s) => s,
            Err(e) => {
                let _ = first.result.send(Err(e.into()));
                continue;
            }
        };
        // The desktop owns notification history. Bound our in-process routing map too.
        let mut targets = BTreeMap::<u32, (NotifyTarget, Option<String>)>::new();
        let mut next = Some(first);
        loop {
            if let Some(delivery) = next.take() {
                // Notification bodies are Pango markup on some desktops; mail is plain text.
                let body = escape_markup(&delivery.body);
                let (icon, action) = presentation(&delivery.target);
                let mut buttons = vec!["default", action];
                if delivery.join.is_some() {
                    buttons.extend(["join", "Join"]);
                }
                let mut hints: HashMap<&str, zbus::zvariant::Value<'_>> = HashMap::from([(
                    "desktop-entry",
                    zbus::zvariant::Value::from(crate::identity::APP_IDENTIFIER),
                )]);
                // The spec has a category for new mail but none for event reminders.
                if matches!(delivery.target, NotifyTarget::Thread(_)) {
                    hints.insert("category", zbus::zvariant::Value::from("email.arrived"));
                }
                let result: zbus::Result<u32> = proxy
                    .call(
                        "Notify",
                        &(
                            "Pheeme",
                            0u32,
                            icon,
                            delivery.title.as_str(),
                            body,
                            buttons,
                            hints,
                            -1i32,
                        ),
                    )
                    .await;
                match result {
                    Ok(id) => {
                        if targets.len() >= 256 {
                            if let Some(id) = targets.keys().next().copied() {
                                targets.remove(&id);
                            }
                        }
                        targets.insert(id, (delivery.target, delivery.join));
                        let _ = delivery.result.send(Ok(()));
                    }
                    Err(error) => {
                        let _ = delivery.result.send(Err(error.into()));
                        break;
                    }
                }
            }
            tokio::select! {
                biased;
                signal = actions.next() => match signal {
                    Some(signal) => if let Ok((id, action)) = signal.body().deserialize::<(u32, String)>() {
                        match action.as_str() {
                            "default" => if let Some((target, _)) = targets.remove(&id) { on_click(Clicked::Open(target)); },
                            "join" => if let Some((_, Some(url))) = targets.remove(&id) { on_click(Clicked::Join(url)); },
                            _ => {}
                        }
                    },
                    None => break,
                },
                signal = closed.next() => match signal {
                    Some(signal) => if let Ok((id, _)) = signal.body().deserialize::<(u32, u32)>() { targets.remove(&id); },
                    None => break,
                },
                delivery = rx.recv() => match delivery { Some(delivery) => next = Some(delivery), None => return },
            }
        }
    }
}

pub async fn permission(_: bool) -> anyhow::Result<String> {
    Ok("system".into())
}
/// The icon and the click action's label for a notification.
fn presentation(target: &NotifyTarget) -> (&'static str, &'static str) {
    match target {
        NotifyTarget::Thread(_) => ("mail-unread", "Open conversation"),
        NotifyTarget::Event(_) => ("x-office-calendar", "Open event"),
    }
}

pub async fn show(
    _app: &AppHandle,
    target: NotifyTarget,
    title: String,
    body: String,
    join: Option<String>,
) -> anyhow::Result<()> {
    let (result, rx) = oneshot::channel();
    let sender = SEND
        .get()
        .ok_or_else(|| anyhow::anyhow!("Notification service not initialized"))?;
    sender
        .send(Delivery {
            target,
            title,
            body,
            join,
            result,
        })
        .await?;
    rx.await?
}

pub async fn tray_available() -> bool {
    let Ok(connection) = Connection::session().await else {
        return false;
    };
    tray_host_registered(&connection).await
}

async fn tray_host_registered(connection: &Connection) -> bool {
    let Ok(proxy) = Proxy::new(
        connection,
        "org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        "org.kde.StatusNotifierWatcher",
    )
    .await
    else {
        return false;
    };
    proxy
        .get_property::<bool>("IsStatusNotifierHostRegistered")
        .await
        .unwrap_or(false)
}

fn escape_markup(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    #[test]
    fn mail_cannot_inject_notification_markup() {
        assert_eq!(
            super::escape_markup("<b>Hi</b> & bye"),
            "&lt;b&gt;Hi&lt;/b&gt; &amp; bye"
        );
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicU32, Ordering};
    use zbus::object_server::SignalEmitter;

    struct Bus(Child);
    impl Drop for Bus {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn private_bus() -> (Bus, String) {
        let mut child = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("dbus-daemon installed with Linux desktop dependencies");
        let mut address = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        (Bus(child), address.trim().to_owned())
    }

    struct FakeWatcher(Arc<std::sync::atomic::AtomicBool>);
    #[zbus::interface(name = "org.kde.StatusNotifierWatcher")]
    impl FakeWatcher {
        #[zbus(property, name = "IsStatusNotifierHostRegistered")]
        fn host_registered(&self) -> bool {
            self.0.load(Ordering::Relaxed)
        }
    }

    #[tokio::test]
    async fn tray_requires_registered_host_not_just_a_watcher() {
        let (_bus, address) = private_bus();
        let client = zbus::connection::Builder::address(address.as_str())
            .unwrap()
            .build()
            .await
            .unwrap();
        assert!(
            !tray_host_registered(&client).await,
            "no watcher must not hide the app"
        );
        let registered = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let server = zbus::connection::Builder::address(address.as_str())
            .unwrap()
            .name("org.kde.StatusNotifierWatcher")
            .unwrap()
            .serve_at("/StatusNotifierWatcher", FakeWatcher(registered.clone()))
            .unwrap()
            .build()
            .await
            .unwrap();
        assert!(
            !tray_host_registered(&client).await,
            "watcher without a panel must not hide the app"
        );
        registered.store(true, Ordering::Relaxed);
        assert!(
            tray_host_registered(&client).await,
            "registered host enables tray behavior"
        );
        registered.store(false, Ordering::Relaxed);
        assert!(
            !tray_host_registered(&client).await,
            "removing the panel restores normal close behavior"
        );
        server
            .object_server()
            .remove::<FakeWatcher, _>("/StatusNotifierWatcher")
            .await
            .unwrap();
        assert!(
            !tray_host_registered(&client).await,
            "missing property must fail closed"
        );
    }

    struct FakeDesktop {
        next: AtomicU32,
        calls: mpsc::UnboundedSender<(String, String, Vec<String>)>,
    }
    #[zbus::interface(name = "org.freedesktop.Notifications")]
    impl FakeDesktop {
        #[allow(clippy::too_many_arguments)]
        fn notify(
            &self,
            _app: &str,
            _replace: u32,
            _icon: &str,
            title: &str,
            body: &str,
            actions: Vec<String>,
            _hints: HashMap<String, zbus::zvariant::OwnedValue>,
            _expire: i32,
        ) -> u32 {
            let _ = self.calls.send((title.into(), body.into(), actions));
            self.next.fetch_add(1, Ordering::Relaxed)
        }
        #[zbus(signal)]
        async fn action_invoked(
            emitter: &SignalEmitter<'_>,
            id: u32,
            action: &str,
        ) -> zbus::Result<()>;
        #[zbus(signal)]
        async fn notification_closed(
            emitter: &SignalEmitter<'_>,
            id: u32,
            reason: u32,
        ) -> zbus::Result<()>;
    }

    #[tokio::test]
    async fn private_bus_checks_delivery_markup_and_account_specific_clicks() {
        // An isolated test bus and fake daemon: never displays mail on the user's desktop.
        let (_bus, address) = private_bus();
        let (calls_tx, mut calls) = mpsc::unbounded_channel();
        let server = zbus::connection::Builder::address(address.as_str())
            .unwrap()
            .name("org.freedesktop.Notifications")
            .unwrap()
            .serve_at(
                "/org/freedesktop/Notifications",
                FakeDesktop {
                    next: AtomicU32::new(1),
                    calls: calls_tx,
                },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let (tx, rx) = mpsc::channel(4);
        let (clicked, mut clicks) = mpsc::unbounded_channel();
        let worker = tokio::spawn(serve(
            rx,
            Some(address),
            Arc::new(move |click| {
                let _ = clicked.send(click);
            }),
        ));
        let event = NotifyTarget::Event(crate::calendar::reminders::EventTarget {
            account_id: "b".into(),
            calendar_id: "b@example.com".into(),
            event_id: "review".into(),
        });
        let thread = NotifyTarget::Thread(crate::desktop::ThreadTarget {
            account_id: "a".into(),
            thread_id: "same-thread-id".into(),
        });
        let call = "https://acme.zoom.us/j/42";
        for (target, join, actions) in [
            (&thread, None, vec!["default", "Open conversation"]),
            (&event, None, vec!["default", "Open event"]),
            (
                &event,
                Some(call.to_owned()),
                vec!["default", "Open event", "join", "Join"],
            ),
        ] {
            let (result, done) = oneshot::channel();
            tx.send(Delivery {
                target: target.clone(),
                title: "Sender".into(),
                body: "<b>Subject</b> & snippet".into(),
                join,
                result,
            })
            .await
            .unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), done)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let (title, body, got_actions) = calls.recv().await.unwrap();
            assert_eq!(title, "Sender");
            assert_eq!(body, "&lt;b&gt;Subject&lt;/b&gt; &amp; snippet");
            assert_eq!(got_actions, actions);
        }
        let fake = server
            .object_server()
            .interface::<_, FakeDesktop>("/org/freedesktop/Notifications")
            .await
            .unwrap();
        FakeDesktop::action_invoked(fake.signal_emitter(), 2, "default")
            .await
            .unwrap();
        FakeDesktop::notification_closed(fake.signal_emitter(), 2, 2)
            .await
            .unwrap();
        let target = tokio::time::timeout(std::time::Duration::from_secs(5), clicks.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target, Clicked::Open(event.clone()));
        // Join on the reminder for a call opens the call, not the event.
        FakeDesktop::action_invoked(fake.signal_emitter(), 3, "join")
            .await
            .unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(5), clicks.recv())
                .await
                .unwrap()
                .unwrap(),
            Clicked::Join(call.to_owned())
        );
        FakeDesktop::action_invoked(fake.signal_emitter(), 1, "default")
            .await
            .unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(5), clicks.recv())
                .await
                .unwrap()
                .unwrap(),
            Clicked::Open(thread)
        );
        drop(tx);
        worker.await.unwrap();
    }
}
