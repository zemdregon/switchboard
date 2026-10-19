#!/bin/sh
# SYNTHETIC, test-only stand-in for bwrap (ADR-0059): drops every argument up to the first `--` and runs the rest in
# the current directory. It confines nothing. Replay tests use it so they run on hosts without a usable bwrap; the
# real wrapper is exercised by src/adapters/cursor/confinement.test.ts. The adapter's confinement probe
# (`probeConfinement`: /bin/sh -c '<script>' sh <marker> <canary>) is answered as a host where the wrapper holds:
# the marker is created and the exit code is 0. Keep the script text in step with CONFINEMENT_PROBE_SCRIPT.
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$#" -gt 0 ] && shift
# shellcheck disable=SC2016 # the literal probe script, compared, never expanded
if [ "$#" -eq 6 ] && [ "$1" = /bin/sh ] && [ "$2" = -c ] && [ "$3" = 'touch "$1" && test ! -e "$2"' ]; then
  touch "$5"
  exit 0
fi
exec "$@"
