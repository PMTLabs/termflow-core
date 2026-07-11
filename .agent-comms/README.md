# Agent Communication Directory

This directory facilitates cross-terminal communication between AI agent teams.

## Structure

```
.agent-comms/
├── requests/        # PM -> Leader Agent requests (REQ-YYYYMMDD-NNN.md)
├── responses/       # Leader Agent -> PM responses (RESP-YYYYMMDD-NNN.md)
├── status/          # Real-time status files (terminal-{id}.status)
├── shared/          # Shared context and cached findings
│   └── findings/    # Research results cache
└── README.md        # This file
```

## Usage

See `docs/023-multi-team-agent-workflow.md` for full protocol documentation.

## Quick Reference

### Create Request (PM)
```bash
cat > requests/REQ-$(date +%Y%m%d)-001.md << 'EOF'
# Research Request
**ID:** REQ-...
**Priority:** HIGH
**Status:** PENDING
## Description
...
EOF
```

### Write Response (Leader Agent)
```bash
cat > responses/RESP-$(date +%Y%m%d)-001.md << 'EOF'
# Research Response
**Request ID:** REQ-...
**Status:** COMPLETE
## Summary
...
EOF
```

## Notes

- Files in this directory are ephemeral communication artifacts
- Clean up periodically to avoid clutter
- Consider adding to .gitignore for production use
