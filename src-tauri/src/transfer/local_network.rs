//! macOS Local Network privacy (Apple TN3179). Connecting to the sending device
//! is an outgoing connection to a local network address, so macOS refuses it
//! until the user allows Pheeme; listening for the receiver needs no permission.
//! There is no API to ask for the permission or read it, but a TCP connection to
//! a local network address does both: it brings up the alert, and while access
//! is off or the alert is still open it fails at once with `EHOSTUNREACH`, before
//! anything is sent. (A UDP `connect` succeeds either way, so it can't tell.)
use serde::Serialize;
use std::net::Ipv4Addr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalNetworkAccess {
    Granted,
    Blocked,
}

/// Asks for (on first use) and reports Local Network access. Other platforms
/// have no such permission.
pub fn access() -> LocalNetworkAccess {
    if cfg!(target_os = "macos") {
        probe(&targets())
    } else {
        LocalNetworkAccess::Granted
    }
}

/// A probe target: an address on one Wi-Fi or Ethernet network, and that
/// network's interface.
struct Target {
    ip: Ipv4Addr,
    interface: u32,
}

/// One random address on each Wi-Fi or Ethernet network. Without a network there
/// is nothing to ask about yet; the connection itself asks once there is.
fn targets() -> Vec<Target> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| match interface.addr {
            if_addrs::IfAddr::V4(addr) => Some(Target {
                ip: host_on(addr.ip, addr.prefixlen, addr.broadcast, random())?,
                interface: interface.index?,
            }),
            if_addrs::IfAddr::V6(_) => None,
        })
        .collect()
}

fn random() -> u32 {
    let mut bytes = [0; 4];
    rand::TryRng::try_fill_bytes(&mut rand::rngs::SysRng, &mut bytes).unwrap_or_default();
    u32::from_ne_bytes(bytes)
}

/// Another host address on `ip`'s network, picked by `random`. A fresh address
/// each time means no failed lookup from an earlier probe can answer for it.
/// Only broadcast-capable interfaces are local networks to macOS (a VPN is
/// not), and their address must be private.
fn host_on(
    ip: Ipv4Addr,
    prefixlen: u8,
    broadcast: Option<Ipv4Addr>,
    random: u32,
) -> Option<Ipv4Addr> {
    broadcast?;
    if !super::is_lan(ip) || !(8..=30).contains(&prefixlen) {
        return None;
    }
    let mask = u32::MAX << (32 - prefixlen);
    let own = u32::from(ip);
    let (network, last) = (own & mask, own | !mask);
    (0..4)
        .map(|step| network | (random.wrapping_add(step) & !mask))
        .find(|&host| host != network && host != last && host != own)
        .map(Ipv4Addr::from)
}

/// Port 9 is the discard service. The socket is tied to the network's interface,
/// so a VPN route to the same address can't stand in for the local network.
#[cfg(unix)]
fn probe(targets: &[Target]) -> LocalNetworkAccess {
    use socket2::{Domain, Protocol, SockAddr, Socket, Type};
    use std::net::SocketAddrV4;
    use std::num::NonZeroU32;
    use std::time::Duration;

    let refused = |target: &Target| {
        let Ok(socket) = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)) else {
            return false;
        };
        if socket
            .bind_device_by_index_v4(NonZeroU32::new(target.interface))
            .is_err()
        {
            return false;
        }
        socket
            .connect_timeout(
                &SockAddr::from(SocketAddrV4::new(target.ip, 9)),
                Duration::from_millis(200),
            )
            .is_err_and(|error| error.kind() == std::io::ErrorKind::HostUnreachable)
    };
    if !targets.is_empty() && targets.iter().all(refused) {
        LocalNetworkAccess::Blocked
    } else {
        LocalNetworkAccess::Granted
    }
}

#[cfg(not(unix))]
fn probe(_: &[Target]) -> LocalNetworkAccess {
    LocalNetworkAccess::Granted
}

#[cfg(test)]
mod tests {
    use super::*;

    const BCAST: Option<Ipv4Addr> = Some(Ipv4Addr::BROADCAST);

    fn ip(text: &str) -> Ipv4Addr {
        text.parse().unwrap()
    }

    #[test]
    fn probes_another_host_on_the_same_network() {
        assert_eq!(
            host_on(ip("192.168.1.10"), 24, BCAST, 0x1234_5678),
            Some(ip("192.168.1.120"))
        );
        // Never the network, broadcast or own address.
        assert_eq!(
            host_on(ip("192.168.1.10"), 24, BCAST, 0),
            Some(ip("192.168.1.1"))
        );
        assert_eq!(
            host_on(ip("192.168.1.10"), 24, BCAST, 255),
            Some(ip("192.168.1.1"))
        );
        assert_eq!(
            host_on(ip("192.168.1.10"), 24, BCAST, 10),
            Some(ip("192.168.1.11"))
        );
        assert_eq!(host_on(ip("10.0.0.1"), 30, BCAST, 0), Some(ip("10.0.0.2")));
        assert_eq!(host_on(ip("10.0.0.1"), 30, BCAST, 3), Some(ip("10.0.0.2")));
        assert_eq!(
            host_on(ip("169.254.7.9"), 16, BCAST, 0x0102_0304),
            Some(ip("169.254.3.4"))
        );
    }

    #[test]
    fn only_private_broadcast_networks_are_probed() {
        // A VPN tunnel is point-to-point, not a local network.
        assert_eq!(host_on(ip("10.8.0.2"), 24, None, 7), None);
        assert_eq!(host_on(ip("8.8.4.4"), 24, BCAST, 7), None);
        assert_eq!(host_on(ip("192.168.1.10"), 31, BCAST, 7), None);
        assert_eq!(host_on(ip("10.1.2.3"), 0, BCAST, 7), None);
    }

    #[test]
    fn no_network_is_not_a_refusal() {
        assert_eq!(probe(&[]), LocalNetworkAccess::Granted);
    }
}
