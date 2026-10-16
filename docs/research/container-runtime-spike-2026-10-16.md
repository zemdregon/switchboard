# Container runtime spike (T10.0), 2026-10-16

- Date: 2026-10-16
- Host: Ampere operator host (`ampere-prod-instance`, `aarch64`, Ubuntu 26.04.1 LTS, kernel 7.0.0-1013-oracle)
- Status: Research input (Delegated agent work, not owner-approved). Runtime, mounts and the ADR-0020 `PATH`
  scan were **observed** on this host. Provider native login and "CLI works without a Git client" were **not**
  live-checked: no provider CLI was installed or run, not even `--version`, inside or outside a container.
  [PR #523](https://github.com/zemdregon/switchboard/pull/523).
- Used by: [ROADMAP](../ROADMAP.md) T10.0, R-13, R-40; [ADR-0013](../adr/0013-projects-environments-and-contexts.md)
  (container mechanism stays Proposed); [ADR-0020](../adr/0020-container-image-without-git-client.md) (rule unchanged);
  [TDD §3.11](../design/TDD.md#311-container-environments).
- Scope: Q-6 / owner decision 24 / FR-PRJ-05 / FR-AUTH-01. **No `src/` or `test/` changes.** Switchboard never
  builds images (ADR-0013).

## Evidence labels

- **Observed:** command run on this host on 2026-10-16; output trimmed below.
- **Documentation only:** cited from this repository (README, TDD, prior research). Credential file contents were
  never read.
- **Unverified: operator (T10.0 live):** needs the operator's native login and/or a provider CLI in a container.
  Not claimed here. No provider is marked `host`-only.

## Primary sources

| ID | Source | Why it matters |
| --- | --- | --- |
| S1 | [TDD §3.11](../design/TDD.md#311-container-environments) | Proposed runtime, mounts, login, network, limits, cleanup |
| S2 | [ADR-0013](../adr/0013-projects-environments-and-contexts.md) | Rootless OCI runtime; in-volume native login; FR-AUTH-01 |
| S3 | [ADR-0020](../adr/0020-container-image-without-git-client.md) | No `git` / `gh` on the image `PATH`; `command -v` check |
| S4 | [FR-PRJ-05](../requirements/SRS.md) | Worktree rw, read-only contexts, no home/data/socket, limits, remove |
| S5 | [README login table](../../README.md#log-in-to-the-providers-natively) | Native login command each adapter reports |
| S6 | Prior live-check notes under `docs/research/live-checks-2026-10-1*.md` | Login directory / env var names (names only) |

## 1. Runtime (rootless Docker)

**Verdict: Observed — rootless Docker fits this host. Podman is not installed. Proposed candidate in ADR-0013
(rootless Podman) is unverified here; the environment port can still sit in front of either CLI (TDD §3.11).**

`docker.service` (user unit) was **disabled** and **inactive**. The client was already pointing at
`unix:///run/user/1001/docker.sock`. This spike started `/usr/bin/dockerd-rootless.sh` as a user process (not via
systemd) so `docker info` could run. Existing restart-policy containers (`muxcore-mvp-*`) came up as a side
effect and were not modified.

```text
$ id -u; id -un
1001
ubuntu
$ grep "^ubuntu:" /etc/subuid /etc/subgid
/etc/subuid:ubuntu:165536:65536
/etc/subgid:ubuntu:165536:65536
$ command -v podman || echo not installed
not installed
$ docker info   # trimmed
Server Version: 29.8.2
Storage Driver: overlayfs
Cgroup Driver: systemd
Cgroup Version: 2
Security Options:
  seccomp
   Profile: builtin
  rootless
  cgroupns
Kernel Version: 7.0.0-1013-oracle
Operating System: Ubuntu 26.04.1 LTS
Architecture: aarch64
Docker Root Dir: /home/ubuntu/.local/share/docker
```

`docker info --format '{{json .SecurityOptions}}'` returned
`["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]`.

### Rootless uid mapping (Observed; matters for FR-PRJ-05 and in-volume login)

Inside the default user namespace, **container uid 0 is the host user** (1001 / `ubuntu`). Any other container
uid is a subordinate id from `subuid` and **cannot write a host bind mount** owned by the host user.

| Run | Inside `id` | Write to bind-mounted worktree | Host file |
| --- | --- | --- | --- |
| default (uid 0) | `uid=0(root) gid=0(root)` | exit 0; created `from-uid0.txt` | owned by host `1001:1001` |
| `--user 1000:1000` | `uid=1000(node) gid=1000(node)` | exit 2; `Permission denied` | file absent |
| `--user 1:1` | `uid=1(daemon) gid=1(daemon)` | exit 2; `Permission denied` | file absent |

A provider process (and an in-volume native login) that must write a host bind mount therefore has to run as
**container uid 0**. A named Docker volume (not a host bind) was writable by uid 0; other uids were not tested
on named volumes.

## 2. Image with no Git client (ADR-0020)

**Verdict: Observed — a small public `-slim` Node image has neither `git` nor `gh` on `PATH`. The ADR-0020
refusal rule is checkable with `command -v` plus a `PATH` directory scan, `--network none`, `--read-only`.**

Image (already present; this spike did not pull or build, and did not remove it):
`node:22-bookworm-slim` (`sha256:43ac6c60b8f8…`, 349 MB).

```text
$ docker run --rm --network none --read-only node:22-bookworm-slim sh -c '
    command -v git; command -v gh
    IFS=:; for d in $PATH; do
      [ -x "$d/git" ] && echo FOUND git=$d/git
      [ -x "$d/gh" ] && echo FOUND gh=$d/gh
    done
  '
command -v git: (empty, not found)
command -v gh:  (empty, not found)
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PATH scan: neither git nor gh executable present
```

No provider CLI was placed in the image. Whether each provider **runs** without a Git client remains
**Unverified: operator (T10.0 live)** — R-40 clause (1). No provider is marked `host`-only.

## 3. Mounts, network, limits, teardown

**Verdict: Observed — rw worktree write holds; ro context write fails; `--network none` blocks egress;
`--memory` / `--pids-limit` round-trip through `docker inspect`; container and volume removed.**

Scratch dirs under `$HOME/.cache/tmp/sb-t100-spike/` (`TMPDIR=$HOME/.cache/tmp`). Container name
`sb-t100-spike-limits`. Flags: `--memory 128m --pids-limit 64 --network none`, binds
`worktree:/wt:rw` and `context:/ctx:ro`.

```text
$ docker inspect sb-t100-spike-limits --format \
    'Memory={{.HostConfig.Memory}} PidsLimit={{.HostConfig.PidsLimit}} NetworkMode={{.HostConfig.NetworkMode}}'
Memory=134217728 PidsLimit=64 NetworkMode=none
# 134217728 == 128 MiB
```

Mounts from inspect (trimmed): `/wt` bind `RW: true`; `/ctx` bind `RW: false`, `Mode: ro`. No home, data
directory, Git credential store or runtime socket was mounted.

| Check | Command (inside) | Observed |
| --- | --- | --- |
| rw worktree | `echo … > /wt/from-limits.txt` | exit 0; host file owned by uid 1001 |
| ro context | `echo … > /ctx/write.txt` | exit 2; `Read-only file system`; host `write.txt` absent |
| DNS, `--network none` | Node `dns.lookup("example.com")` | `EAI_AGAIN`, exec exit 42 |
| TCP, `--network none` | Node connect `1.1.1.1:443` | `ENETUNREACH`, exec exit 43 |
| remove | `docker rm -f sb-t100-spike-limits` | container gone (`docker ps -aq` empty for the name) |

Named volume `sb-t100-spike-login` (stand-in for a project login volume; **no provider CLI**): uid 0 wrote
`/login/marker.txt`; `docker volume rm` removed it. Mountpoint was under
`/home/ubuntu/.local/share/docker/volumes/sb-t100-spike-login/_data` (names only).

`--network none` is the run-time network off mapping in TDD §3.11. A native login that needs the network
cannot use that same invocation; login would be a separate, networked attach (Proposed in TDD §3.11) sharing
the volume. Not demonstrated with a provider CLI.

## 4. Provider CLIs and native login (documentation only)

**No provider CLI was installed or run.** Every per-provider cell is
`Unverified: operator (T10.0 live)`. None is marked `host`-only.

In-volume login (Proposed, ADR-0013, FR-AUTH-01): the operator runs the provider's own login inside the
project's container volume; the controller copies nothing. Plausibility below is **inference from documented
file/env locations plus the uid-0 bind-mount finding**, not a live result.

A login that writes a **host bind mount** must run as container uid 0 (section 1). Device-code / URL logins
need network during login, then the run container can use `--network none` with the same volume.

| Provider | Native login (docs) | Directory / env (docs; contents not read) | In-volume login plausible? | Cell |
| --- | --- | --- | --- | --- |
| Claude Code | `claude auth login` ([README](../../README.md#log-in-to-the-providers-natively)) | Default `~/.claude/`; `CLAUDE_CONFIG_DIR` relocates config **and** credentials ([TDD §4.1](../design/TDD.md#41-claude-code-m2), [verified research](headless-ai-coding-controller-verified-2026-10-12.md)) | File store. A volume at `HOME/.claude` or `CLAUDE_CONFIG_DIR`, login as uid 0 with network, then a run container with the same volume, is the Proposed shape. | Unverified: operator (T10.0 live) |
| Codex | `codex login`; status `codex login status` (README; live-checks 2026-10-13) | `~/.codex/auth.json`; `CODEX_HOME` isolates config but needs its own login ([TDD §4.2](../design/TDD.md#42-codex-m2), [verified research](headless-ai-coding-controller-verified-2026-10-12.md)) | File store. Volume as `CODEX_HOME` or `HOME/.codex`. | Unverified: operator (T10.0 live) |
| Grok Build | `grok login` / `grok login --device-code` (README; [live-checks-2026-10-14-grok](live-checks-2026-10-14-grok.md)) | `~/.grok/` including a file named `auth.json`; `GROK_HOME` relocates config, auth and sessions (same note; documented as Assumption on that check) | File store. Volume as `GROK_HOME`. Device-code may complete without a browser **in** the container if the operator finishes the flow elsewhere. | Unverified: operator (T10.0 live) |
| Antigravity | Launch `agy` with no arguments (README; [live-checks-2026-10-14-antigravity](live-checks-2026-10-14-antigravity.md)) | Token **file** named `antigravity-oauth-token` (mode 600, contents not read) under the CLI state directory; selected by `$HOME` or `--gemini_dir`. Live check: **not** a keyring; `DBUS_SESSION_BUS_ADDRESS` unset still worked. TDD §4.4's keyring wording is contradicted by that check and is not re-litigated here. | File store under `HOME` / `--gemini_dir`. A volume plus networked login that prints a URL is the Proposed shape. Not marked `host`-only. | Unverified: operator (T10.0 live) |
| Cursor CLI | `cursor-agent login` (README); live check also names `agent login` ([live-checks-2026-10-14-cursor](live-checks-2026-10-14-cursor.md)) | Login follows `HOME` / `~/.cursor`. `CURSOR_CONFIG_DIR` alone does **not** isolate the login (same note, row 11). | Volume must cover `HOME` (or whatever store a later check shows), not only `CURSOR_CONFIG_DIR`. | Unverified: operator (T10.0 live) |
| OpenCode | `opencode auth login` (README; [live-checks-2026-10-14-opencode](live-checks-2026-10-14-opencode.md)) | Default `run` / `auth list` talk to a **background user service**. Scratch `HOME`/`XDG_*` without `--standalone` failed (service-port-in-use). `--standalone` plus scratch dirs listed only environment connections. Binary under `~/.opencode/bin/`. | Unclear: a container has no host user service. `--standalone` plus a `HOME` volume may be the path; the host service must not be mounted. | Unverified: operator (T10.0 live) |
| Kimi Code | `kimi login` (device-code) (README; [kimi-code spike](kimi-code-spike-2026-10-13.md) K10) | `$KIMI_CODE_HOME/credentials/` (0700/0600); default `~/.kimi-code/`. `KIMI_CODE_HOME` relocates config, sessions, logs and credentials. | File store. Volume as `KIMI_CODE_HOME`. Device-code as Grok. | Unverified: operator (T10.0 live) |
| Muse Code (Should) | `muse login` ([muse-code research](muse-code-2026-10-13.md)) | `~/.config/muse/auth.json`; settings `~/.config/muse/settings.json` | File store under XDG. Volume as `XDG_CONFIG_HOME` / `HOME/.config/muse`. | Unverified: operator (T10.0 live) |

### Operator-only follow-up (exact checks; not run)

Do not copy credential files. Do not print token contents. Use a throwaway volume, then destroy it.

1. **Claude Code.** In a Git-free image that already contains `claude`, with a named volume mounted at
   `CLAUDE_CONFIG_DIR` (or as `HOME/.claude`) and **network on**, run the native `claude auth login` as
   **uid 0**. In a second container, same volume, `--network none`, run the adapter's auth preflight
   (`claude auth status` as documented). Record exit code and `OK` vs `AUTH_REQUIRED` only. Then a
   one-line non-model probe (no prompt that needs Git) to see whether the CLI starts with no `git`/`gh`
   on `PATH`.
2. **Codex.** Same pattern with volume as `CODEX_HOME` (or `HOME/.codex`), `codex login` then
   `codex login status` (exit 0 vs 1). Then a non-model `codex exec` probe without Git on `PATH`.
3. **Grok Build.** Volume as `GROK_HOME`. `grok login --device-code` (complete from another device). Then
   `grok models` first-line auth text. Then a `-p` probe without Git on `PATH`.
4. **Antigravity.** Volume as `HOME` or `--gemini_dir`. Launch `agy` to sign in (URL on stderr; do not
   paste tokens). Then `agy models` as the documented preflight. Then a `-p` probe without Git on `PATH`.
   Confirm the token file name exists (name and mode only).
5. **Cursor CLI.** Volume as `HOME` (not `CURSOR_CONFIG_DIR` alone). `cursor-agent login`, then
   `cursor-agent status --format json` and key on `isAuthenticated`. Then a `-p` probe without Git on
   `PATH`.
6. **OpenCode.** Volume as `HOME` plus XDG dirs; **`--standalone`**; do not mount a host OpenCode service
   socket. `opencode auth login`, then `opencode auth list --format json --standalone`. Then `opencode run
   --standalone` without Git on `PATH`. Record whether the user service is required.
7. **Kimi Code.** Volume as `KIMI_CODE_HOME`. `kimi login` (device-code). Then the documented ACP
   `initialize` / `session/new` auth probe (no `session/prompt`). Then a non-model probe without Git on
   `PATH`.
8. **Muse Code (Should).** Volume as `HOME/.config/muse`. `muse login`, then a documented logged-in vs
   logged-out probe without Git on `PATH`.

A provider whose in-volume login cannot complete, or whose CLI refuses to start without `git`/`gh`, is
marked `host`-only in that operator note and in R-13 / R-40 — not before.

## Docker objects

| Object | Created by this spike? | Removed? |
| --- | --- | --- |
| Containers `sb-t100-spike-path`, `-uid0`, `-uid1000`, `-uid1`, `-vol` | yes (`--rm`) | yes (removed on exit) |
| Container `sb-t100-spike-limits` | yes | yes (`docker rm -f`) |
| Container `sb-t100-spike-net` | yes | yes (`docker rm -f`) |
| Volume `sb-t100-spike-login` | yes | yes (`docker volume rm`) |
| Image `node:22-bookworm-slim` | **no** (already present; not pulled) | **not removed** |
| Host scratch `$HOME/.cache/tmp/sb-t100-spike/` | yes | removed after this note was written |
| `dockerd-rootless.sh` | started (socket was absent) | left running; `docker.service` still disabled |

After teardown, `docker ps -aq --filter name=sb-t100-spike` and
`docker volume ls --filter name=sb-t100-spike` were empty.

## Verdicts for T10.0

| Clause | Result |
| --- | --- |
| Rootless runtime on this host | **Observed:** Docker Engine 29.8.2, `Security Options: rootless`. Podman not installed. |
| Image with no Git client; ADR-0020 check | **Observed:** `command -v git gh` empty; `PATH` scan finds neither. |
| Mounts, `--network none`, `--memory` / `--pids-limit`, remove | **Observed** (section 3). |
| uid 0 vs other uids on bind mounts | **Observed:** only uid 0 can write host binds. Recorded for FR-PRJ-05 and login. |
| In-volume native login per provider | **Unverified: operator (T10.0 live).** Documentation table only. |
| Each provider CLI without a Git client | **Unverified: operator (T10.0 live).** No CLI was run. |
| Mark a provider `host`-only | **Not done** (no evidence). |

T10.0 is therefore **Partial**, not Done. T10.1 can implement the environment port against rootless Docker
on this host using the mount/limit/PATH-scan behaviours above; login and Git-free CLI behaviour stay on the
operator checklist.
