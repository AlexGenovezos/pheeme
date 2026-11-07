//! One-use, explicitly approved transfers over a Noise NNpsk0 connection.
//! The 256-bit invitation key is shared out of band, never over the LAN socket.
//! Only OAuth client credentials cross the connection; no account tokens or mail.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::TryRng;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::AbortHandle;
use zeroize::{Zeroize, Zeroizing};

use crate::gmail::auth::ClientCredentials;

const TTL: Duration = Duration::from_secs(300);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_FRAME: usize = 8192;
const PROLOGUE: &[u8] = b"Pheeme OAuth client transfer v1";

#[derive(Debug, thiserror::Error)]
pub enum TransferError {
    #[error("Use the complete transfer code shown by Pheeme on the other device.")]
    Invalid,
    #[error("A transfer is already open. Cancel it before starting another.")]
    Busy,
    #[error("This transfer expired or was cancelled. Start a new transfer.")]
    Expired,
    #[error(
        "Couldn't connect securely. Check the code, local network and firewall, then try again."
    )]
    Connection,
    #[error("The other device did not confirm receipt. Start a new transfer and try again.")]
    Unconfirmed,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStatus {
    pub phase: String,
    pub peer: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOffer {
    pub transfer_id: String,
    pub invitation: String,
    pub expires_in_seconds: u64,
}

struct Session {
    id: String,
    status: TransferStatus,
    approve: Option<oneshot::Sender<()>>,
    task: Option<AbortHandle>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

#[derive(Clone, Default)]
pub struct TransferService(Arc<Mutex<Transfers>>);

#[derive(Default)]
struct Transfers {
    session: Option<Session>,
    /// IPC cancellation can arrive before its asynchronous receive command starts.
    cancelled: VecDeque<String>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn is_lan(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}

pub fn interfaces() -> Result<Vec<String>, TransferError> {
    let mut ips: Vec<_> = if_addrs::get_if_addrs()
        .map_err(|_| TransferError::Connection)?
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) if is_lan(ip) => Some(ip.to_string()),
            _ => None,
        })
        .collect();
    ips.sort();
    ips.dedup();
    Ok(ips)
}

fn parse_invitation(text: &str) -> Result<(SocketAddr, Zeroizing<[u8; 32]>), TransferError> {
    if text.len() > 160 {
        return Err(TransferError::Invalid);
    }
    let (address, key) = text
        .trim()
        .strip_prefix("pheeme-transfer-v1:")
        .and_then(|text| text.split_once('/'))
        .ok_or(TransferError::Invalid)?;
    let address: SocketAddr = address.parse().map_err(|_| TransferError::Invalid)?;
    if !matches!(address.ip(), IpAddr::V4(ip) if is_lan(ip)) || address.port() == 0 {
        return Err(TransferError::Invalid);
    }
    let bytes = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(key)
            .map_err(|_| TransferError::Invalid)?,
    );
    let mut key = Zeroizing::new([0; 32]);
    if bytes.len() != key.len() {
        return Err(TransferError::Invalid);
    }
    key.copy_from_slice(&bytes);
    Ok((address, key))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    version: u8,
    client_id: String,
    client_secret: String,
}

impl Drop for Credentials {
    fn drop(&mut self) {
        self.client_secret.zeroize();
    }
}

impl TransferService {
    fn install(
        &self,
        id: String,
        approve: Option<oneshot::Sender<()>>,
    ) -> Result<(), TransferError> {
        let mut transfers = lock(&self.0);
        if transfers.cancelled.contains(&id) {
            return Err(TransferError::Expired);
        }
        if transfers
            .session
            .as_ref()
            .is_some_and(|s| !matches!(s.status.phase.as_str(), "completed" | "failed"))
        {
            return Err(TransferError::Busy);
        }
        transfers.session = Some(Session {
            id,
            status: TransferStatus {
                phase: "waiting".into(),
                peer: None,
                error: None,
            },
            approve,
            task: None,
        });
        Ok(())
    }

    fn task(&self, id: &str, task: AbortHandle) {
        if let Some(session) = lock(&self.0).session.as_mut().filter(|s| s.id == id) {
            session.task = Some(task);
        } else {
            task.abort();
        }
    }

    fn update(&self, id: &str, phase: &str, peer: Option<String>, error: Option<String>) {
        if let Some(session) = lock(&self.0).session.as_mut().filter(|s| s.id == id) {
            session.status = TransferStatus {
                phase: phase.into(),
                peer,
                error,
            };
        }
    }

    pub fn status(&self, id: &str) -> Result<TransferStatus, TransferError> {
        lock(&self.0)
            .session
            .as_ref()
            .filter(|s| s.id == id)
            .map(|s| s.status.clone())
            .ok_or(TransferError::Expired)
    }

    pub fn approve(&self, id: &str) -> Result<(), TransferError> {
        let mut session = lock(&self.0);
        let session = session
            .session
            .as_mut()
            .filter(|s| s.id == id && s.status.phase == "approval")
            .ok_or(TransferError::Expired)?;
        session
            .approve
            .take()
            .ok_or(TransferError::Expired)?
            .send(())
            .map_err(|_| TransferError::Expired)
    }

    pub fn cancel(&self, id: &str) {
        let mut transfers = lock(&self.0);
        if id.len() <= 64 && !transfers.cancelled.iter().any(|cancelled| cancelled == id) {
            transfers.cancelled.push_back(id.to_owned());
            // Bound bookkeeping even if a webview submits arbitrary cancellations.
            if transfers.cancelled.len() > 64 {
                transfers.cancelled.pop_front();
            }
        }
        if transfers.session.as_ref().is_some_and(|s| s.id == id) {
            transfers.session = None;
        }
    }

    pub async fn offer(
        &self,
        address: &str,
        creds: ClientCredentials,
    ) -> Result<TransferOffer, TransferError> {
        if !interfaces()?.iter().any(|ip| ip == address) {
            return Err(TransferError::Invalid);
        }
        let ip: Ipv4Addr = address.parse().map_err(|_| TransferError::Invalid)?;
        let listener = TcpListener::bind((ip, 0))
            .await
            .map_err(|_| TransferError::Connection)?;
        self.offer_on(listener, creds, TTL).await
    }

    async fn offer_on(
        &self,
        listener: TcpListener,
        creds: ClientCredentials,
        ttl: Duration,
    ) -> Result<TransferOffer, TransferError> {
        let address = listener
            .local_addr()
            .map_err(|_| TransferError::Connection)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut key = Zeroizing::new([0; 32]);
        rand::rngs::SysRng
            .try_fill_bytes(key.as_mut())
            .map_err(|_| TransferError::Connection)?;
        let invitation = format!(
            "pheeme-transfer-v1:{address}/{}",
            URL_SAFE_NO_PAD.encode(key.as_ref())
        );
        let payload = Credentials {
            version: 1,
            client_id: creds.client_id,
            client_secret: creds.client_secret,
        };
        let (approve, approval) = oneshot::channel();
        self.install(id.clone(), Some(approve))?;
        let service = self.clone();
        let task_id = id.clone();
        let task = tokio::spawn(async move {
            let send = async {
                // Wrong keys and stalled handshakes do not consume the invitation.
                let (mut stream, mut noise, peer) = loop {
                    let (mut stream, peer) = listener
                        .accept()
                        .await
                        .map_err(|_| TransferError::Connection)?;
                    if !matches!(peer.ip(), IpAddr::V4(ip) if is_lan(ip) || cfg!(test) && ip.is_loopback())
                    {
                        continue;
                    }
                    if let Ok(Ok(noise)) =
                        tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(&mut stream, &key, false))
                            .await
                    {
                        break (stream, noise, peer);
                    }
                };
                drop(listener);
                key.zeroize();
                service.update(&task_id, "approval", Some(peer.ip().to_string()), None);
                approval.await.map_err(|_| TransferError::Expired)?;
                service.update(&task_id, "sending", Some(peer.ip().to_string()), None);
                let json = Zeroizing::new(
                    serde_json::to_vec(&payload).map_err(|_| TransferError::Invalid)?,
                );
                send_encrypted(&mut stream, &mut noise, &json).await?;
                drop(json);
                drop(payload);
                let ack = receive_encrypted(&mut stream, &mut noise)
                    .await
                    .map_err(|_| TransferError::Unconfirmed)?;
                if ack.as_slice() != b"received" {
                    return Err(TransferError::Unconfirmed);
                }
                Ok(())
            };
            let result = tokio::time::timeout(ttl, send)
                .await
                .unwrap_or(Err(TransferError::Expired));
            match result {
                Ok(()) => service.update(&task_id, "completed", None, None),
                Err(error) => service.update(&task_id, "failed", None, Some(error.to_string())),
            }
        });
        self.task(&id, task.abort_handle());
        Ok(TransferOffer {
            transfer_id: id,
            invitation,
            expires_in_seconds: ttl.as_secs(),
        })
    }

    pub async fn receive(
        &self,
        id: &str,
        invitation: &str,
    ) -> Result<ClientCredentials, TransferError> {
        uuid::Uuid::parse_str(id).map_err(|_| TransferError::Invalid)?;
        let (address, key) = parse_invitation(invitation)?;
        self.receive_from(id, address, key, TTL).await
    }

    async fn receive_from(
        &self,
        id: &str,
        address: SocketAddr,
        key: Zeroizing<[u8; 32]>,
        ttl: Duration,
    ) -> Result<ClientCredentials, TransferError> {
        self.install(id.to_owned(), None)?;
        let task = tokio::spawn(async move {
            tokio::time::timeout(ttl, async {
                let mut stream =
                    tokio::time::timeout(HANDSHAKE_TIMEOUT, TcpStream::connect(address))
                        .await
                        .map_err(|_| TransferError::Connection)?
                        .map_err(|_| TransferError::Connection)?;
                let mut noise =
                    tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(&mut stream, &key, true))
                        .await
                        .map_err(|_| TransferError::Connection)??;
                let json = receive_encrypted(&mut stream, &mut noise).await?;
                let mut payload: Credentials =
                    serde_json::from_slice(&json).map_err(|_| TransferError::Invalid)?;
                if payload.version != 1
                    || payload.client_id.len() > 1024
                    || !payload.client_id.ends_with(".apps.googleusercontent.com")
                    || payload.client_id.contains(char::is_whitespace)
                    || payload.client_secret.trim().is_empty()
                    || payload.client_secret.len() > 4096
                {
                    return Err(TransferError::Invalid);
                }
                send_encrypted(&mut stream, &mut noise, b"received").await?;
                Ok(ClientCredentials {
                    client_id: std::mem::take(&mut payload.client_id),
                    client_secret: std::mem::take(&mut payload.client_secret),
                })
            })
            .await
            .unwrap_or(Err(TransferError::Expired))
        });
        self.task(id, task.abort_handle());
        let result = task.await.unwrap_or(Err(TransferError::Expired));
        self.update(
            id,
            if result.is_ok() {
                "completed"
            } else {
                "failed"
            },
            None,
            result.as_ref().err().map(ToString::to_string),
        );
        result
    }
}

async fn read_frame(stream: &mut TcpStream) -> Result<Vec<u8>, TransferError> {
    let len = stream
        .read_u16()
        .await
        .map_err(|_| TransferError::Connection)? as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(TransferError::Connection);
    }
    let mut buffer = vec![0; len];
    stream
        .read_exact(&mut buffer)
        .await
        .map_err(|_| TransferError::Connection)?;
    Ok(buffer)
}

async fn write_frame(stream: &mut TcpStream, bytes: &[u8]) -> Result<(), TransferError> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(TransferError::Invalid);
    }
    stream
        .write_u16(bytes.len() as u16)
        .await
        .map_err(|_| TransferError::Connection)?;
    stream
        .write_all(bytes)
        .await
        .map_err(|_| TransferError::Connection)
}

async fn handshake(
    stream: &mut TcpStream,
    key: &[u8; 32],
    initiator: bool,
) -> Result<snow::TransportState, TransferError> {
    let builder = snow::Builder::new(
        "Noise_NNpsk0_25519_ChaChaPoly_BLAKE2s"
            .parse()
            .map_err(|_| TransferError::Connection)?,
    )
    .prologue(PROLOGUE)
    .map_err(|_| TransferError::Connection)?
    .psk(0, key)
    .map_err(|_| TransferError::Connection)?;
    let mut noise = if initiator {
        builder.build_initiator()
    } else {
        builder.build_responder()
    }
    .map_err(|_| TransferError::Connection)?;
    let mut buffer = [0; MAX_FRAME];
    if initiator {
        let len = noise
            .write_message(&[], &mut buffer)
            .map_err(|_| TransferError::Connection)?;
        write_frame(stream, &buffer[..len]).await?;
    }
    let message = read_frame(stream).await?;
    let len = noise
        .read_message(&message, &mut buffer)
        .map_err(|_| TransferError::Connection)?;
    if len != 0 {
        return Err(TransferError::Connection);
    }
    if !initiator {
        let len = noise
            .write_message(&[], &mut buffer)
            .map_err(|_| TransferError::Connection)?;
        write_frame(stream, &buffer[..len]).await?;
    }
    noise
        .into_transport_mode()
        .map_err(|_| TransferError::Connection)
}

async fn send_encrypted(
    stream: &mut TcpStream,
    noise: &mut snow::TransportState,
    plaintext: &[u8],
) -> Result<(), TransferError> {
    let mut buffer = vec![0; MAX_FRAME];
    let len = noise
        .write_message(plaintext, &mut buffer)
        .map_err(|_| TransferError::Connection)?;
    write_frame(stream, &buffer[..len]).await
}

async fn receive_encrypted(
    stream: &mut TcpStream,
    noise: &mut snow::TransportState,
) -> Result<Zeroizing<Vec<u8>>, TransferError> {
    let message = read_frame(stream).await?;
    let mut buffer = Zeroizing::new(vec![0; MAX_FRAME]);
    let len = noise
        .read_message(&message, &mut buffer)
        .map_err(|_| TransferError::Connection)?;
    buffer.truncate(len);
    Ok(buffer)
}

#[cfg(test)]
mod tests;
