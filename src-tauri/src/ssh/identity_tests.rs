use super::*;

fn parse(text: &str) -> Result<Identity, SessionError> {
    parse_identity(Zeroizing::new(text.to_owned()))
}

macro_rules! fixture {
    ($name:literal) => {
        (
            include_str!(concat!("fixtures/key_formats/", $name)),
            include_str!(concat!("fixtures/key_formats/", $name, ".pub")),
        )
    };
}

#[test]
fn plain_keys_match_public_fixtures() {
    for (text, public) in [
        fixture!("rsa_pem"),
        fixture!("rsa_pkcs8"),
        fixture!("ecdsa_pem"),
        fixture!("ecdsa_pkcs8"),
        fixture!("ed25519_openssh"),
        (
            include_str!("fixtures/client_rsa"),
            include_str!("fixtures/client_rsa.pub"),
        ),
    ] {
        let public = ssh_key::PublicKey::from_openssh(public).unwrap();
        let identity = parse(text).unwrap();
        assert!(!identity.needs_passphrase());
        assert_eq!(
            identity.fingerprint(),
            public.fingerprint(HashAlg::Sha256).to_string()
        );
        assert_eq!(
            identity.unlock("").unwrap().public_key().key_data(),
            public.key_data()
        );
    }
}

#[test]
fn encrypted_pem_binds_before_unlock() {
    let mut fingerprints = std::collections::HashSet::new();
    for (text, public) in [
        fixture!("rsa_pem_enc"),
        fixture!("rsa_pkcs8_enc"),
        fixture!("ecdsa_pkcs8_enc"),
    ] {
        let public = ssh_key::PublicKey::from_openssh(public).unwrap();
        let identity = parse(text).unwrap();
        assert!(identity.needs_passphrase());
        let fingerprint = identity.fingerprint();
        assert!(fingerprint.starts_with("SHA256-FILE:"));
        assert_eq!(fingerprint, parse(text).unwrap().fingerprint());
        let crlf = text.replace("\r\n", "\n").replace('\n', "\r\n");
        assert_eq!(fingerprint, parse(&crlf).unwrap().fingerprint());
        assert_eq!(
            fingerprint,
            parse(&format!("\u{feff}{text}")).unwrap().fingerprint()
        );
        assert!(fingerprints.insert(fingerprint));
        assert!(matches!(
            identity.unlock("wrong"),
            Err(SessionError::AuthRejected)
        ));
        assert_eq!(
            identity
                .unlock("fixture-pass")
                .unwrap()
                .public_key()
                .key_data(),
            public.key_data()
        );
    }
}

#[test]
fn openssh_remember_binding_is_unchanged() {
    for text in [
        include_str!("fixtures/client_enc"),
        include_str!("fixtures/client_rsa"),
        fixture!("ed25519_openssh").0,
    ] {
        let old = PrivateKey::from_openssh(text).unwrap();
        let identity = parse(text).unwrap();
        assert_eq!(identity.needs_passphrase(), old.is_encrypted());
        assert_eq!(
            identity.fingerprint(),
            old.public_key().fingerprint(HashAlg::Sha256).to_string()
        );
    }
}

#[test]
fn rejects_unreadable_identities() {
    let encrypted_ec = fixture!("rsa_pem_enc")
        .0
        .replace("RSA PRIVATE KEY", "EC PRIVATE KEY");
    let encrypted_pkcs8 = encrypted_ec.replace("EC PRIVATE KEY", "PRIVATE KEY");
    let pkcs8 = fixture!("rsa_pkcs8_enc").0.replace("\r\n", "\n");
    let truncated_pkcs8 = pkcs8[..pkcs8.find("-----END ").unwrap()].to_owned();
    let corrupt_pkcs8 = pkcs8.replacen("\nM", "\n!M", 1);
    let empty_pkcs8 =
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\n-----END ENCRYPTED PRIVATE KEY-----\n".to_owned();
    let pem = fixture!("rsa_pem_enc").0.replace("\r\n", "\n");
    let truncated_pem = pem[..pem.find("-----END ").unwrap()].to_owned();
    // The untouched sources stay Locked, so each mutation above is what makes them unreadable.
    assert!(matches!(parse(&pkcs8), Ok(Identity::Locked { .. })));
    assert!(matches!(parse(&pem), Ok(Identity::Locked { .. })));
    for text in [
        include_str!("fixtures/key_formats/rsa_pem_des3"),
        &encrypted_ec,
        &encrypted_pkcs8,
    ] {
        assert!(matches!(
            parse(text),
            Err(SessionError::IdentityEncryptionUnsupported)
        ));
    }
    for text in [
        "",
        "garbage",
        "-----BEGIN RSA PRIVATE KEY-----\nA!\n-----END RSA PRIVATE KEY-----\n",
        // Locked keys are checked for armour before any passphrase prompt.
        &truncated_pkcs8,
        &corrupt_pkcs8,
        &empty_pkcs8,
        &truncated_pem,
    ] {
        assert!(matches!(parse(text), Err(SessionError::IdentityUnreadable)));
    }
    let path = std::env::temp_dir().join(format!("tf-identity-{}", uuid::Uuid::new_v4()));
    for bytes in [&[0xff, 0xfe, b'-', 0][..], &[0xc3, 0x28][..]] {
        std::fs::write(&path, bytes).unwrap();
        let result = read_identity(&path);
        std::fs::remove_file(&path).unwrap();
        assert!(matches!(result, Err(SessionError::IdentityUnreadable)));
    }
}

#[test]
fn resaved_pkcs8_changes_binding_but_not_public_key() {
    let (original, public) = fixture!("rsa_pkcs8_enc");
    let resaved = parse(include_str!("fixtures/key_formats/rsa_pkcs8_enc_resaved")).unwrap();
    assert_ne!(
        parse(original).unwrap().fingerprint(),
        resaved.fingerprint()
    );
    let public = ssh_key::PublicKey::from_openssh(public).unwrap();
    assert_eq!(
        resaved
            .unlock("fixture-pass")
            .unwrap()
            .public_key()
            .key_data(),
        public.key_data()
    );
}

#[test]
fn plain_pem_accepts_bom_and_crlf() {
    let text = fixture!("rsa_pem").0;
    let original = parse(text).unwrap().fingerprint();
    let crlf = text.replace("\r\n", "\n").replace('\n', "\r\n");
    assert_eq!(original, parse(&crlf).unwrap().fingerprint());
    assert_eq!(
        original,
        parse(&format!("\u{feff}{text}")).unwrap().fingerprint()
    );
}
