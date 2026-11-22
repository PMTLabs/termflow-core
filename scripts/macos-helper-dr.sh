#!/bin/bash
# Exact check of the TermFlow Host helper's designated requirement (plan 060 Task 7).
# TCC stores the DR with a grant, so any extra clause (a cdhash, a path) makes every release a new
# identity. This is the default DR codesign gives a Developer ID Application signature (checked
# against a real signed bundle, plan 060 Task 0).
#
# Usage: macos-helper-dr.sh <host-bundle-id> <team-id>   (reads `codesign -d -r-` output on stdin)
# Exits 0 only when stdin has exactly one `designated =>` line and it equals the expected DR.
set -uo pipefail
host_id="$1"
team="$2"
expected="designated => identifier \"$host_id\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"$team\""
lines="$(grep '^designated => ' || true)"
[ -n "$lines" ] || exit 1
[ "$(printf '%s\n' "$lines" | wc -l | tr -d ' ')" = 1 ] || exit 1
[ "$lines" = "$expected" ]
