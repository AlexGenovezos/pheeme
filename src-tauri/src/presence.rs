//! Whether the user could see Pheeme, and what the computer was doing, for the diagnostics log.
//! A slow stretch reads differently when the window was hidden behind other apps (macOS slows a
//! hidden app's timers on purpose: App Nap), the displays were asleep, Low Power Mode was on or
//! the chip was hot. Changes are logged as they happen, and [`snapshot`] goes on every stall line.
//!
//! Focus comes from the main window's Tauri events on every platform. Visibility, sleeping
//! displays, Low Power Mode and the thermal state come from macOS; elsewhere they're unknown.

use std::sync::atomic::{AtomicU8, Ordering};

const UNKNOWN: u8 = 0;
const NO: u8 = 1;
const YES: u8 = 2;

static FOCUSED: AtomicU8 = AtomicU8::new(UNKNOWN);
static VISIBLE: AtomicU8 = AtomicU8::new(UNKNOWN);
static DISPLAYS_ASLEEP: AtomicU8 = AtomicU8::new(UNKNOWN);

fn read(flag: &AtomicU8) -> Option<bool> {
    match flag.load(Ordering::Relaxed) {
        YES => Some(true),
        NO => Some(false),
        _ => None,
    }
}

/// Store `on`; true when it changed.
fn store(flag: &AtomicU8, on: bool) -> bool {
    flag.swap(if on { YES } else { NO }, Ordering::Relaxed) != if on { YES } else { NO }
}

/// The main window gained or lost focus.
pub fn set_focused(on: bool) {
    if store(&FOCUSED, on) {
        tracing::info!(focused = on, "window focus changed");
    }
}

/// Some part of a Pheeme window is on screen (macOS: the app's occlusion state).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn set_visible(on: bool) {
    if store(&VISIBLE, on) {
        tracing::info!(visible = on, "window visibility changed");
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn set_displays_asleep(on: bool) {
    if store(&DISPLAYS_ASLEEP, on) {
        tracing::info!(asleep = on, "displays asleep changed");
    }
}

/// The state at one moment, for a log line.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub focused: Option<bool>,
    pub visible: Option<bool>,
    pub displays_asleep: Option<bool>,
    pub low_power: Option<bool>,
    /// `nominal`, `fair`, `serious` or `critical`.
    pub thermal: Option<&'static str>,
}

pub fn snapshot() -> Snapshot {
    Snapshot {
        focused: read(&FOCUSED),
        visible: read(&VISIBLE),
        displays_asleep: read(&DISPLAYS_ASLEEP),
        low_power: power::low_power(),
        thermal: power::thermal(),
    }
}

/// Start hearing the system's changes. Call once, on the main thread, after the app is running.
pub fn watch() {
    #[cfg(target_os = "macos")]
    mac::watch();
}

#[cfg(target_os = "macos")]
mod power {
    use objc2_foundation::{NSProcessInfo, NSProcessInfoThermalState};

    pub fn low_power() -> Option<bool> {
        Some(NSProcessInfo::processInfo().isLowPowerModeEnabled())
    }

    pub fn thermal() -> Option<&'static str> {
        Some(match NSProcessInfo::processInfo().thermalState() {
            NSProcessInfoThermalState::Nominal => "nominal",
            NSProcessInfoThermalState::Fair => "fair",
            NSProcessInfoThermalState::Serious => "serious",
            NSProcessInfoThermalState::Critical => "critical",
            _ => "unknown",
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod power {
    pub fn low_power() -> Option<bool> {
        None
    }

    pub fn thermal() -> Option<&'static str> {
        None
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSApplicationDidChangeOcclusionStateNotification,
        NSApplicationOcclusionState, NSWorkspace, NSWorkspaceDidWakeNotification,
        NSWorkspaceScreensDidSleepNotification, NSWorkspaceScreensDidWakeNotification,
        NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::{
        NSNotification, NSNotificationCenter, NSNotificationName,
        NSProcessInfoPowerStateDidChangeNotification,
        NSProcessInfoThermalStateDidChangeNotification,
    };
    use std::ptr::NonNull;

    /// Run `then` each time `center` posts `name`. The observer lives as long as the app.
    fn observe(
        center: &NSNotificationCenter,
        name: &NSNotificationName,
        then: impl Fn() + 'static,
    ) {
        let block = RcBlock::new(move |_: NonNull<NSNotification>| then());
        // SAFETY: no object filter and no queue (the block runs on the posting thread); the
        // block only stores flags and logs, which any thread may do.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        // Never removed: Pheeme listens until it quits.
        std::mem::forget(token);
    }

    fn app_visible(mtm: MainThreadMarker) -> bool {
        NSApplication::sharedApplication(mtm)
            .occlusionState()
            .contains(NSApplicationOcclusionState::Visible)
    }

    pub fn watch() {
        let Some(mtm) = MainThreadMarker::new() else {
            tracing::warn!("presence watch started off the main thread; visibility not tracked");
            return;
        };
        super::set_visible(app_visible(mtm));
        // SAFETY: the notification names are AppKit's and Foundation's own constants.
        unsafe {
            let center = NSNotificationCenter::defaultCenter();
            observe(
                &center,
                NSApplicationDidChangeOcclusionStateNotification,
                move || {
                    super::set_visible(app_visible(mtm));
                },
            );
            observe(
                &center,
                NSProcessInfoPowerStateDidChangeNotification,
                || {
                    tracing::info!(low_power = ?super::power::low_power(), "Low Power Mode changed");
                },
            );
            observe(
                &center,
                NSProcessInfoThermalStateDidChangeNotification,
                || {
                    tracing::info!(thermal = ?super::power::thermal(), "thermal state changed");
                },
            );
            let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
            observe(&workspace, NSWorkspaceWillSleepNotification, || {
                tracing::info!("computer going to sleep");
            });
            observe(&workspace, NSWorkspaceDidWakeNotification, || {
                tracing::info!("computer woke");
            });
            observe(&workspace, NSWorkspaceScreensDidSleepNotification, || {
                super::set_displays_asleep(true);
            });
            observe(&workspace, NSWorkspaceScreensDidWakeNotification, || {
                super::set_displays_asleep(false);
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flag_reports_only_changes() {
        let flag = AtomicU8::new(UNKNOWN);
        assert_eq!(read(&flag), None);
        assert!(store(&flag, true));
        assert!(!store(&flag, true));
        assert_eq!(read(&flag), Some(true));
        assert!(store(&flag, false));
        assert_eq!(read(&flag), Some(false));
    }
}
