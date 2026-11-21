//! Test-only peer adapter. russh 0.65.1's server ties plain-key and
//! certificate advertisement to the same key list, so its server config
//! cannot advertise a certificate without also advertising its signing key.
use super::{BoxFuture, BoxStream, Ordering, Server, SessionError, SessionHop, StreamFactory};
use std::sync::{atomic::AtomicBool, Arc};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream};

pub(super) struct CertificateOnly {
    pub server: Server,
    pub advertised: Arc<AtomicBool>,
}

impl StreamFactory for CertificateOnly {
    fn connect<'a>(&'a self, _: &'a SessionHop) -> BoxFuture<'a, Result<BoxStream, SessionError>> {
        Box::pin(async move {
            let (peer, server) = tokio::io::duplex(64 * 1024);
            self.server.clone().start(Box::new(peer));
            let (client, relay) = tokio::io::duplex(64 * 1024);
            tokio::spawn(offer_certificate_only(server, relay, self.advertised.clone()));
            Ok(Box::new(client) as BoxStream)
        })
    }
}

async fn offer_certificate_only(server: DuplexStream, client: DuplexStream, advertised: Arc<AtomicBool>) {
    let mut server = BufReader::new(server);
    let mut client = BufReader::new(client);
    let mut version = Vec::new();
    server.read_until(b'\n', &mut version).await.unwrap();
    assert!(version.starts_with(b"SSH-2.0-"));
    client.write_all(&version).await.unwrap();
    version.clear();
    client.read_until(b'\n', &mut version).await.unwrap();
    assert!(version.starts_with(b"SSH-2.0-"));
    server.write_all(&version).await.unwrap();

    // Change only the server's host-key name-list in the first unencrypted
    // KEXINIT. At this boundary the stock client should find no common host
    // key algorithm and disconnect before signatures or authentication.
    let len = server.read_u32().await.unwrap() as usize;
    let mut packet = vec![0u8; len];
    server.read_exact(&mut packet).await.unwrap();
    let padding = packet[0] as usize;
    let mut payload = packet[1..len - padding].to_vec();
    assert_eq!(payload[0], 20, "SSH_MSG_KEXINIT");
    let name_list_len = |offset: usize| {
        u32::from_be_bytes(payload[offset..offset + 4].try_into().unwrap()) as usize
    };
    let kex = 1 + 16; // message byte and cookie
    let host_key = kex + 4 + name_list_len(kex);
    let end = host_key + 4 + name_list_len(host_key);
    let advertised_names = std::str::from_utf8(&payload[host_key + 4..end]).unwrap();
    const CERT: &str = "ssh-ed25519-cert-v01@openssh.com";
    assert!(advertised_names.split(',').any(|name| name == CERT));
    assert!(advertised_names.split(',').any(|name| name == "ssh-ed25519"));
    let list = (CERT.len() as u32).to_be_bytes().into_iter().chain(CERT.bytes());
    drop(payload.splice(host_key..end, list));
    let padding = 4 + (8 - (4 + 1 + payload.len() + 4) % 8) % 8;
    client.write_u32((1 + payload.len() + padding) as u32).await.unwrap();
    client.write_u8(padding as u8).await.unwrap();
    client.write_all(&payload).await.unwrap();
    client.write_all(&[0; 12][..padding]).await.unwrap();
    advertised.store(true, Ordering::SeqCst);
    // Do not manufacture EOF as the refusal. Let the real client reject the
    // offer; if it unexpectedly continues, the test requires prompt refusal.
    let _ = tokio::io::copy_bidirectional(&mut server, &mut client).await;
}
