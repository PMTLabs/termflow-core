# Hidden automation messages

Tick **Hide message** in **Send to terminal** to mask its editor, preview, canvas, list and Test output. **Reveal** is temporary and resets when switching rules or turning Hide back on. Copy and cut are blocked while hidden. The terminal still receives the original message, with the same substitution and Enter behaviour.

Newly hidden messages are stored using AES-256-GCM. A profile-specific encryption key lives in Windows Credential Manager, macOS Keychain, or Linux Secret Service. If the keystore is unavailable, hiding cannot be saved; unhidden messages still work. An unreadable message stays encrypted and cannot run. Retype it to recover; unrelated edits do not discard it.

## Limits and downgrade

Plaintext remains in process memory and local IPC, and the terminal may echo it. A message previously saved **without** Hide may remain in SQLite free pages, WAL, backups or older copies. Hiding does not erase those copies.

Hidden rules use schema version 4. Older builds reject these rules rather than sending an empty message. Unhiding returns the rule to the schema version required by its remaining features.

## Native verification (test profile only)

1. Create a rule with a unique password message; tick Hide and save.
2. Check the textarea renders dots in the native WebView (`-webkit-text-security`), and the preview, canvas, Settings row and Test pane contain only fixed dots.
3. Try copy/cut while hidden, then Reveal and try again. Toggle Hide off/on and switch rules: Reveal must reset.
4. Fire into a disposable terminal; confirm the exact message arrives.
5. Inspect the saved graph: the message is empty and `messageCipher` begins `v1:`.
6. Close the test instance. Remove only its `termflow-automation.<profile-key>` / `message-key` credential, then restart that test profile. The rule must show “type it again” and send nothing, not even Enter.
7. Make an unrelated edit and save: ciphertext must remain intact. Retype the message, or insert a token/snippet, to recover.

Never run this credential-deletion test against a production profile.
