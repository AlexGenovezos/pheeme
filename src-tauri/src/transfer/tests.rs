use super::*;

fn credentials() -> ClientCredentials {
    ClientCredentials {
        client_id: "test.apps.googleusercontent.com".into(),
        client_secret: "secret-only-in-encrypted-payload".into(),
    }
}

async fn offer(service: &TransferService, ttl: Duration) -> TransferOffer {
    service
        .offer_on(
            TcpListener::bind("127.0.0.1:0").await.unwrap(),
            credentials(),
            ttl,
        )
        .await
        .unwrap()
}

fn connection(offer: &TransferOffer) -> (SocketAddr, Zeroizing<[u8; 32]>) {
    let (address, key) = offer
        .invitation
        .strip_prefix("pheeme-transfer-v1:")
        .unwrap()
        .split_once('/')
        .unwrap();
    let bytes = URL_SAFE_NO_PAD.decode(key).unwrap();
    (
        address.parse().unwrap(),
        Zeroizing::new(bytes.try_into().unwrap()),
    )
}

async fn phase(service: &TransferService, id: &str, expected: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if service.status(id).unwrap().phase == expected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn invitations_only_accept_literal_lan_ipv4_and_full_keys() {
    let key = URL_SAFE_NO_PAD.encode([7; 32]);
    for host in [
        "192.168.1.1:1234",
        "10.0.0.2:65535",
        "172.16.0.1:1234",
        "169.254.1.2:1234",
    ] {
        assert!(parse_invitation(&format!("pheeme-transfer-v1:{host}/{key}")).is_ok());
    }
    for host in [
        "127.0.0.1:1234",
        "0.0.0.0:1234",
        "8.8.8.8:1234",
        "192.168.1.2:0",
        "example.com:1234",
        "[::1]:1234",
        "172.32.0.1:1234",
    ] {
        assert!(parse_invitation(&format!("pheeme-transfer-v1:{host}/{key}")).is_err());
    }
    for bad in [
        "",
        "http://192.168.1.2:1234",
        "pheeme-transfer-v1:192.168.1.2:1234/short",
    ] {
        assert!(parse_invitation(bad).is_err());
    }
}

#[tokio::test]
async fn transfer_requires_approval_then_closes_listener_and_cannot_be_reused() {
    let sender = TransferService::default();
    let receiver = TransferService::default();
    let offer = offer(&sender, Duration::from_secs(5)).await;
    assert!(sender.approve(&offer.transfer_id).is_err());
    let (address, key) = connection(&offer);
    let id = uuid::Uuid::new_v4().to_string();
    let receive = tokio::spawn(async move {
        receiver
            .receive_from(&id, address, key, Duration::from_secs(5))
            .await
    });
    phase(&sender, &offer.transfer_id, "approval").await;
    assert!(
        !receive.is_finished(),
        "no credentials before explicit sender approval"
    );
    assert!(
        TcpStream::connect(address).await.is_err(),
        "listener closes after authenticated pairing"
    );
    sender.approve(&offer.transfer_id).unwrap();
    assert_eq!(receive.await.unwrap().unwrap(), credentials());
    phase(&sender, &offer.transfer_id, "completed").await;
    assert!(sender.approve(&offer.transfer_id).is_err());
    assert!(TcpStream::connect(address).await.is_err());
}

#[tokio::test]
async fn wrong_key_is_rejected_without_consuming_invitation() {
    let sender = TransferService::default();
    let offer = offer(&sender, Duration::from_secs(5)).await;
    let (address, _) = connection(&offer);
    let receiver = TransferService::default();
    let result = receiver
        .receive_from(
            "bad",
            address,
            Zeroizing::new([0; 32]),
            Duration::from_secs(2),
        )
        .await;
    assert!(result.is_err());
    assert_eq!(sender.status(&offer.transfer_id).unwrap().phase, "waiting");
    let (address, key) = connection(&offer);
    let receive = tokio::spawn(async move {
        receiver
            .receive_from("good", address, key, Duration::from_secs(3))
            .await
    });
    phase(&sender, &offer.transfer_id, "approval").await;
    sender.approve(&offer.transfer_id).unwrap();
    assert!(receive.await.unwrap().is_ok());
}

#[tokio::test]
async fn cancellation_closes_connection_and_stale_cancel_cannot_cancel_new_session() {
    let sender = TransferService::default();
    let first = offer(&sender, Duration::from_secs(5)).await;
    let (address, key) = connection(&first);
    let receiver = TransferService::default();
    let receive = tokio::spawn(async move {
        receiver
            .receive_from("receive", address, key, Duration::from_secs(3))
            .await
    });
    phase(&sender, &first.transfer_id, "approval").await;
    sender.cancel(&first.transfer_id);
    assert!(receive.await.unwrap().is_err());
    assert!(sender.status(&first.transfer_id).is_err());
    let second = offer(&sender, Duration::from_secs(5)).await;
    sender.cancel(&first.transfer_id);
    assert_eq!(sender.status(&second.transfer_id).unwrap().phase, "waiting");
    sender.cancel(&second.transfer_id);
}

#[tokio::test]
async fn expiry_closes_idle_listener_and_receiver_can_be_cancelled() {
    let sender = TransferService::default();
    let offer = offer(&sender, Duration::from_millis(30)).await;
    let (address, _) = connection(&offer);
    phase(&sender, &offer.transfer_id, "failed").await;
    assert!(TcpStream::connect(address).await.is_err());
    assert!(sender.approve(&offer.transfer_id).is_err());

    let offer = self::offer(&sender, Duration::from_secs(5)).await;
    let (address, key) = connection(&offer);
    let receiver = TransferService::default();
    let pending = receiver.clone();
    let receive = tokio::spawn(async move {
        pending
            .receive_from("receiver", address, key, Duration::from_secs(5))
            .await
    });
    phase(&sender, &offer.transfer_id, "approval").await;
    receiver.cancel("receiver");
    assert!(receive.await.unwrap().is_err());
    sender.cancel(&offer.transfer_id);
}

#[tokio::test]
async fn oversized_frames_and_tampered_ciphertext_fail_closed() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut client = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (mut server, _) = listener.accept().await.unwrap();
    client.write_u16((MAX_FRAME + 1) as u16).await.unwrap();
    assert!(read_frame(&mut server).await.is_err());

    let key = [1; 32];
    let (sender, receiver) = tokio::join!(
        handshake(&mut server, &key, false),
        handshake(&mut client, &key, true)
    );
    let mut sender = sender.unwrap();
    let mut receiver = receiver.unwrap();
    let mut ciphertext = vec![0; MAX_FRAME];
    let len = sender.write_message(b"secret", &mut ciphertext).unwrap();
    ciphertext[0] ^= 1;
    write_frame(&mut server, &ciphertext[..len]).await.unwrap();
    assert!(receive_encrypted(&mut client, &mut receiver).await.is_err());
}

#[tokio::test]
async fn public_entrypoints_bind_only_to_a_local_interface_and_transfer() {
    let sender = TransferService::default();
    assert!(sender.offer("0.0.0.0", credentials()).await.is_err());
    assert!(sender.offer("8.8.8.8", credentials()).await.is_err());
    let Some(address) = interfaces().unwrap().into_iter().next() else {
        return;
    };
    let offer = sender.offer(&address, credentials()).await.unwrap();
    let receiver = TransferService::default();
    let invitation = offer.invitation.clone();
    let receive = tokio::spawn(async move {
        receiver
            .receive(&uuid::Uuid::new_v4().to_string(), &invitation)
            .await
    });
    phase(&sender, &offer.transfer_id, "approval").await;
    sender.approve(&offer.transfer_id).unwrap();
    assert_eq!(receive.await.unwrap().unwrap(), credentials());
    phase(&sender, &offer.transfer_id, "completed").await;
}

#[tokio::test]
async fn expiry_while_waiting_for_approval_never_sends_credentials() {
    let sender = TransferService::default();
    let offer = offer(&sender, Duration::from_millis(250)).await;
    let (address, key) = connection(&offer);
    let receiver = TransferService::default();
    let receive = tokio::spawn(async move {
        receiver
            .receive_from("waiting", address, key, Duration::from_secs(3))
            .await
    });
    phase(&sender, &offer.transfer_id, "approval").await;
    assert!(receive.await.unwrap().is_err());
    phase(&sender, &offer.transfer_id, "failed").await;
    assert!(sender.approve(&offer.transfer_id).is_err());
}

#[tokio::test]
async fn cancellation_before_receive_starts_is_remembered() {
    let receiver = TransferService::default();
    let id = uuid::Uuid::new_v4().to_string();
    receiver.cancel(&id);
    let result = receiver
        .receive_from(
            &id,
            "127.0.0.1:1".parse().unwrap(),
            Zeroizing::new([0; 32]),
            Duration::from_secs(1),
        )
        .await;
    assert!(matches!(result, Err(TransferError::Expired)));
    assert!(receiver.status(&id).is_err());
}

#[tokio::test]
async fn receiver_rejects_other_versions_and_account_tokens() {
    for json in [
        br#"{"version":2,"client_id":"a.apps.googleusercontent.com","client_secret":"secret"}"#.as_slice(),
        br#"{"version":1,"client_id":"a.apps.googleusercontent.com","client_secret":"secret","refresh_token":"must-not-import"}"#.as_slice(),
        br#"{"version":1,"client_id":"a.apps.googleusercontent.com","client_secret":""}"#.as_slice(),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let json = json.to_vec();
        let sender = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut noise = handshake(&mut stream, &[3; 32], false).await.unwrap();
            send_encrypted(&mut stream, &mut noise, &json).await.unwrap();
        });
        let receiver = TransferService::default();
        assert!(matches!(receiver.receive_from("malformed", address, Zeroizing::new([3; 32]), Duration::from_secs(2)).await, Err(TransferError::Invalid)));
        sender.await.unwrap();
    }
}
