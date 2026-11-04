# Transfer your Google Cloud client to another device

Pheeme can send your Google OAuth **client ID and client secret** directly to
another Pheeme installation on your local network. You still sign in to Google
on the receiving device. Account sign-ins, refresh tokens and cached mail are
not transferred.

1. Connect both devices to the same Wi-Fi or Ethernet network.
2. On the device already set up, open **Settings → Accounts**. Under
   **Transfer client credentials**, choose the Google Cloud app and its local
   network address, then click **Send to another device**. If several addresses
   appear, choose the one belonging to your Wi-Fi or Ethernet connection.
3. On the new device's setup screen, choose **Receive from another device**.
   This is also available when adding an account or entering client credentials.
4. Copy or type the complete transfer code into the receiving device and choose
   **Connect securely**. Keep the code private.
5. Return to the sending device and choose **Approve transfer** when your other
   device connects. Cancel an unexpected request.
6. Finish Google sign-in on the receiving device. Pheeme saves the credentials
   in that device's system keychain as part of the normal sign-in process.

Each transfer expires after five minutes and accepts one receiving device.
Closing the sending settings page, leaving receiving setup, or cancelling stops
that transfer. To try again, generate a fresh code.

If the connection fails, check the selected address and allow Pheeme through the
sending device's firewall. Guest networks often prevent devices from contacting
each other. On macOS, allow Pheeme's local-network access when prompted (or in
System Settings → Privacy & Security → Local Network). This version supports
private IPv4 and IPv4 link-local addresses;
it does not discover nearby devices or support IPv6-only networks. VPN interfaces
may also appear, so choose the intended local network explicitly.

## How the connection is protected

The invitation contains a random 256-bit key and the sender's local address.
Pheeme uses the Noise `NNpsk0_25519_ChaChaPoly_BLAKE2s` protocol, implemented by
`snow`, to authenticate and encrypt the connection with that key. The invitation
key is never sent over the transfer socket. Fresh ephemeral keys are generated
for each handshake, and the protocol is bound to Pheeme's versioned transfer
context.

The sender listens only while a transfer is open, bound to the selected local
interface. Unauthenticated or stalled handshakes cannot authorize a transfer.
After authenticated pairing, the listener closes and the sender waits for your
explicit approval before sending any client credentials. Messages have bounded
sizes and time limits; malformed or modified messages fail closed. The receiver
acknowledges receipt over the encrypted connection.

The transfer uses no cloud relay. Client secrets stay in the native process,
with temporary transfer plaintext and pairing-key buffers cleared when released;
they are not returned to the webview or written to export files or logs. The
subsequent Google sign-in uses Google's normal online OAuth flow.
