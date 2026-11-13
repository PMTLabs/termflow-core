use aes_gcm::{
    aead::{rand_core::RngCore, Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::sync::{Arc, Mutex};

#[derive(Debug)]
pub(crate) struct SecretError;

pub(crate) trait KeySource: Send + Sync {
    fn get(&self) -> Result<Option<[u8; 32]>, SecretError>;
    fn create(&self) -> Result<[u8; 32], SecretError>;
}

#[cfg(not(test))]
struct OsKeySource;
#[cfg(not(test))]
impl OsKeySource {
    fn entry() -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(
            &format!("termflow-automation.{}", crate::profile::current().key()),
            "message-key",
        )
        .map_err(|_| SecretError)
    }
}
#[cfg(not(test))]
impl KeySource for OsKeySource {
    fn get(&self) -> Result<Option<[u8; 32]>, SecretError> {
        Self::run(|| match Self::entry()?.get_password() {
            Ok(value) => STANDARD
                .decode(value)
                .map_err(|_| SecretError)?
                .try_into()
                .map(Some)
                .map_err(|_| SecretError),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(SecretError),
        })
    }
    fn create(&self) -> Result<[u8; 32], SecretError> {
        Self::run(|| {
            let mut key = [0; 32];
            OsRng.fill_bytes(&mut key);
            Self::entry()?
                .set_password(&STANDARD.encode(key))
                .map_err(|_| SecretError)?;
            Ok(key)
        })
    }
}
#[cfg(not(test))]
impl OsKeySource {
    fn run<T: Send + 'static>(
        operation: impl FnOnce() -> Result<T, SecretError> + Send + 'static,
    ) -> Result<T, SecretError> {
        // Secret Service's blocking wrapper must run outside the caller's Tokio runtime.
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::thread::spawn(operation)
                .join()
                .map_err(|_| SecretError)?
        }
        #[cfg(not(all(unix, not(target_os = "macos"))))]
        {
            operation()
        }
    }
}

pub(crate) struct MessageCipher {
    source: Arc<dyn KeySource>,
    key: Mutex<Option<[u8; 32]>>,
}
impl Default for MessageCipher {
    fn default() -> Self {
        #[cfg(test)]
        let source = Arc::new(MemoryKeySource::default());
        #[cfg(not(test))]
        let source = Arc::new(OsKeySource);
        Self::new(source)
    }
}
impl MessageCipher {
    pub(crate) fn new(source: Arc<dyn KeySource>) -> Self {
        Self {
            source,
            key: Mutex::new(None),
        }
    }
    fn key(&self, create: bool) -> Result<[u8; 32], SecretError> {
        let mut cache = self.key.lock().map_err(|_| SecretError)?;
        if let Some(key) = *cache {
            return Ok(key);
        }
        let key = match self.source.get()? {
            Some(key) => key,
            None if create => self.source.create()?,
            None => return Err(SecretError),
        };
        *cache = Some(key);
        Ok(key)
    }
    pub(crate) fn encrypt(&self, text: &str) -> Result<String, SecretError> {
        let cipher = Aes256Gcm::new_from_slice(&self.key(true)?).map_err(|_| SecretError)?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let encrypted = cipher
            .encrypt(&nonce, text.as_bytes())
            .map_err(|_| SecretError)?;
        let mut bytes = nonce.to_vec();
        bytes.extend(encrypted);
        Ok(format!("v1:{}", STANDARD.encode(bytes)))
    }
    pub(crate) fn decrypt(&self, text: &str) -> Result<String, SecretError> {
        let bytes = STANDARD
            .decode(text.strip_prefix("v1:").ok_or(SecretError)?)
            .map_err(|_| SecretError)?;
        if bytes.len() < 28 {
            return Err(SecretError);
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key(false)?).map_err(|_| SecretError)?;
        let plain = cipher
            .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
            .map_err(|_| SecretError)?;
        String::from_utf8(plain).map_err(|_| SecretError)
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryKeySource(Mutex<Option<[u8; 32]>>);
#[cfg(test)]
impl KeySource for MemoryKeySource {
    fn get(&self) -> Result<Option<[u8; 32]>, SecretError> {
        Ok(*self.0.lock().unwrap())
    }
    fn create(&self) -> Result<[u8; 32], SecretError> {
        let mut key = [0; 32];
        OsRng.fill_bytes(&mut key);
        *self.0.lock().unwrap() = Some(key);
        Ok(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct CountingSource {
        gets: std::sync::atomic::AtomicUsize,
        creates: std::sync::atomic::AtomicUsize,
    }
    impl KeySource for CountingSource {
        fn get(&self) -> Result<Option<[u8; 32]>, SecretError> {
            if self.gets.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                return Err(SecretError);
            }
            Ok(None)
        }
        fn create(&self) -> Result<[u8; 32], SecretError> {
            self.creates
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok([7; 32])
        }
    }

    #[test]
    fn failed_fetch_retries_and_concurrent_saves_create_only_one_key() {
        let source = Arc::new(CountingSource {
            gets: std::sync::atomic::AtomicUsize::new(0),
            creates: std::sync::atomic::AtomicUsize::new(0),
        });
        let cipher = Arc::new(MessageCipher::new(source.clone()));
        assert!(cipher.encrypt("first fails").is_err());
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let cipher = cipher.clone();
                std::thread::spawn(move || cipher.encrypt("concurrent secret").unwrap())
            })
            .collect();
        for t in threads {
            assert_eq!(
                cipher.decrypt(&t.join().unwrap()).unwrap(),
                "concurrent secret"
            );
        }
        assert_eq!(source.gets.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(source.creates.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn round_trip_nonce_tamper_and_foreign_key() {
        let cipher = MessageCipher::default();
        let a = cipher.encrypt("secret ${password}").unwrap();
        let b = cipher.encrypt("secret ${password}").unwrap();
        assert_ne!(a, b);
        assert_eq!(cipher.decrypt(&a).unwrap(), "secret ${password}");
        let foreign = MessageCipher::default();
        foreign.encrypt("seed foreign key").unwrap();
        assert!(foreign.decrypt(&a).is_err());
        let mut bytes = STANDARD.decode(a.strip_prefix("v1:").unwrap()).unwrap();
        bytes[12] ^= 1;
        assert!(cipher
            .decrypt(&format!("v1:{}", STANDARD.encode(bytes)))
            .is_err());
    }
}
