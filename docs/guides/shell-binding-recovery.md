# Shell binding recovery

A renderer pane's window holder is distinct from its backend process and host-session registration. Moves transfer binding authority; they do not stop the shell. Explicit closes select a particular run and route to its recorded host (or local PID). API and local fleet closes retain their existing saved-history semantics.

Unheld renderer shells become eligible for a **Recovered terminal** after 30 seconds, on a settled restore sweep. Recovery reuses the original process, leaf and history; it never closes the shell. Active creates, valid restore intents, restore/install transactions, and headless API shells are excluded. A pending startup window is not forcibly declared settled after a timer. The periodic sweep cadence is 60 seconds, not an exact recovery deadline.

Renderer departure notifications retry up to four attempts, with 250/500/1000 ms delays. Backend sweeps also reconcile holder labels and pending restore windows against the live Tauri window inventory, so a missed destruction notification cannot retain a dead window's holder indefinitely.

## Delivery limitation

Window inventory proves whether a window exists, not whether a particular leaf remains inside it. If a window stays alive, its leaf is absent, and **every release attempt fails**, the backend can retain that holder. It deliberately does not expire a healthy window's binding or destroy a potentially wanted shell on that evidence. Close/reopen the affected window to release its claims through inventory reconciliation.

Similarly, a renderer lost mid-restore, or exhaustion of every restore-completion notification, can leave that live window's restore barrier outstanding. Closing the affected window clears it. Recovery-event emission failures remain retryable on later sweeps; successful emission is not proof that a crashed webview displayed the tab. Process-exit and physical-close identity tombstones are retained in memory for the app lifetime to reject late completions and duplicate effects.
