# Container runtime spike (T10.0), 2026-10-16

- Date: 2026-10-16
- Host: Ampere operator host (`ampere-prod-instance`, `aarch64`, Ubuntu 26.04.1 LTS, kernel 7.0.0-1013-oracle)
- Status: Research input (Delegated agent work, not owner-approved). Runtime, mounts and the ADR-0020 `PATH`
  scan were **observed** on this host. Provider native login and "CLI works without a Git client" were **not**
  live-checked: no provider CLI was installed or run, not even `--version`, inside or outside a container.
  [PR #523](https://github.com/zemdregon/switchboard/pull/523).
  *Update 2026-10-18 (operator live, Delegated write-up):* the operator completed each provider's native login inside
  its own named volume in a Git-free image, and every login is **Observed**; one real prompt per provider ran from
  that volume (six replied, Grok Build is Deferred-until-reset on a usage-balance limit). See
  [§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18). Sections 1 to 5 are kept as written; their
  `Unverified` cells for the seven providers are superseded by §6.
- Used by: [ROADMAP](../ROADMAP.md) T10.0, R-13, R-40; [ADR-0013](../adr/0013-projects-environments-and-contexts.md)
  (container mechanism Accepted 2026-10-18 on §6); [ADR-0020](../adr/0020-container-image-without-git-client.md) (rule unchanged);
  [TDD §3.11](../design/TDD.md#311-container-environments).
- Scope: Q-6 / owner decision 24 / FR-PRJ-05 / FR-AUTH-01. **No `src/` or `test/` changes.** Switchboard never
  builds images (ADR-0013).

## Evidence labels

- **Observed:** command run on this host on 2026-10-16; output trimmed below.
- **Documentation only:** cited from this repository (README, TDD, prior research). Credential file contents were
  never read.
- **Unverified: operator (T10.0 live):** needs the operator's native login and/or a provider CLI in a container.
  Not claimed here. No provider is marked `host`-only.
- **Observed (operator, 2026-10-18):** run on this host by the operator on 2026-10-18 from the per-provider login
  volumes (§6). Output redacted; credential contents never read, printed or copied.

## Primary sources

| ID | Source | Why it matters |
| --- | --- | --- |
| S1 | [TDD §3.11](../design/TDD.md#311-container-environments) | Proposed runtime, mounts, login, network, limits, cleanup |
| S2 | [ADR-0013](../adr/0013-projects-environments-and-contexts.md) | Rootless OCI runtime; in-volume native login; FR-AUTH-01 |
| S3 | [ADR-0020](../adr/0020-container-image-without-git-client.md) | No `git` / `gh` on the image `PATH`; `command -v` check |
| S4 | [FR-PRJ-05](../requirements/SRS.md) | Worktree rw, read-only contexts, no home/data/socket, limits, remove |
| S5 | [README login table](../guide/getting-started.md#log-in-to-the-providers-natively) | Native login command each adapter reports |
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
**Unverified: operator (T10.0 live)** — R-40 clause (1). No provider is marked `host`-only. *Update 2026-10-18:*
Observed for all seven providers from their login volumes in Git-free images
([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)).

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

**No provider CLI was installed or run** on 2026-10-16; every per-provider cell was then
`Unverified: operator (T10.0 live)`. *Update 2026-10-18:* the seven provider cells below are now Observed from the
operator's in-volume logins ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)); Muse Code stays
Unverified (skipped, owner decision 16). None is marked `host`-only.

In-volume login (Proposed, ADR-0013, FR-AUTH-01): the operator runs the provider's own login inside the
project's container volume; the controller copies nothing. Plausibility below is **inference from documented
file/env locations plus the uid-0 bind-mount finding**, not a live result.

A login that writes a **host bind mount** must run as container uid 0 (section 1). Device-code / URL logins
need network during login, then the run container can use `--network none` with the same volume.

| Provider | Native login (docs) | Directory / env (docs; contents not read) | In-volume login plausible? | Cell |
| --- | --- | --- | --- | --- |
| Claude Code | `claude auth login` ([README](../guide/getting-started.md#log-in-to-the-providers-natively)) | Default `~/.claude/`; `CLAUDE_CONFIG_DIR` relocates config **and** credentials ([TDD §4.1](../design/TDD.md#41-claude-code-m2), [verified research](headless-ai-coding-controller-verified-2026-10-12.md)) | File store. A volume at `HOME/.claude` or `CLAUDE_CONFIG_DIR`, login as uid 0 with network, then a run container with the same volume, is the Proposed shape. | Observed (operator, 2026-10-18): in-volume login, status probe and prompt ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)) |
| Codex | `codex login`; status `codex login status` (README; live-checks 2026-10-13) | `~/.codex/auth.json`; `CODEX_HOME` isolates config but needs its own login ([TDD §4.2](../design/TDD.md#42-codex-m2), [verified research](headless-ai-coding-controller-verified-2026-10-12.md)) | File store. Volume as `CODEX_HOME` or `HOME/.codex`. | Observed (operator, 2026-10-18): in-volume login, status probe and prompt ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)) |
| Grok Build | `grok login` / `grok login --device-code` (README; [live-checks-2026-10-14-grok](live-checks-2026-10-14-grok.md)) | `~/.grok/` including a file named `auth.json`; `GROK_HOME` relocates config, auth and sessions (same note; documented as Assumption on that check) | File store. Volume as `GROK_HOME`. Device-code may complete without a browser **in** the container if the operator finishes the flow elsewhere. | Observed (operator, 2026-10-18): in-volume login and status probe; prompt Deferred-until-reset (402 usage balance) ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)) |
| Antigravity | Launch `agy` with no arguments (README; [live-checks-2026-10-14-antigravity](live-checks-2026-10-14-antigravity.md)) | Token **file** named `antigravity-oauth-token` (mode 600, contents not read) under the CLI state directory; selected by `$HOME` or `--gemini_dir`. Live check: **not** a keyring; `DBUS_SESSION_BUS_ADDRESS` unset still worked. TDD §4.4's keyring wording is contradicted by that check and is not re-litigated here. | File store under `HOME` / `--gemini_dir`. A volume plus networked login that prints a URL is the Proposed shape. Not marked `host`-only. | Observed (operator, 2026-10-18): in-volume login, status probe and prompt ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)) |
| Cursor CLI | `cursor-agent login` (README); live check also names `agent login` ([live-checks-2026-10-14-cursor](live-checks-2026-10-14-cursor.md)) | Login follows `HOME` / `~/.cursor`. `CURSOR_CONFIG_DIR` alone does **not** isolate the login (same note, row 11). | Volume must cover `HOME` (or whatever store a later check shows), not only `CURSOR_CONFIG_DIR`. | Observed (operator, 2026-10-18): in-volume login, status probe and prompt ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)) |
| OpenCode | `opencode auth login` (README; [live-checks-2026-10-14-opencode](live-checks-2026-10-14-opencode.md)) | Default `run` / `auth list` talk to a **background user service**. Scratch `HOME`/`XDG_*` without `--standalone` failed (service-port-in-use). `--standalone` plus scratch dirs listed only environment connections. Binary under `~/.opencode/bin/`. | Unclear: a container has no host user service. `--standalone` plus a `HOME` volume may be the path; the host service must not be mounted. | Observed (operator, 2026-10-18): in-volume login (`--standalone`, no user service), status probe and prompt ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)) |
| Kimi Code | `kimi login` (device-code) (README; [kimi-code spike](kimi-code-spike-2026-10-13.md) K10) | `$KIMI_CODE_HOME/credentials/` (0700/0600); default `~/.kimi-code/`. `KIMI_CODE_HOME` relocates config, sessions, logs and credentials. | File store. Volume as `KIMI_CODE_HOME`. Device-code as Grok. | Observed (operator, 2026-10-18): in-volume login, ACP status probe and prompt ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)) |
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
| In-volume native login per provider | **Observed (operator, 2026-10-18)** for Claude Code, Codex, Grok Build, Antigravity, Cursor CLI, OpenCode and Kimi Code (§6). Muse Code skipped (owner decision 16). |
| Each provider CLI without a Git client | **Observed (operator, 2026-10-18):** all seven start and report logged in with no `git`/`gh` on `PATH` and `--network none`; six answered a real prompt; Grok Build reached the API and was refused for billing (402), prompt Deferred-until-reset (§6). |
| Mark a provider `host`-only | **None** (no provider failed login in the volume or needed a Git client). |

On 2026-10-16 T10.0 was **Partial**. With the 2026-10-18 operator results (§6) every clause above is met, so T10.0
is **Done**. T10.1 implements the environment port against rootless Docker on this host using the mount/limit/PATH-scan
behaviours above.

## 5. Operator login runbook (2026-10-18, documentation only)

Status: research input (Delegated agent work, not owner-approved). Nothing below was executed: no provider
CLI was invoked, no login was attempted, no credential was read, mounted or copied. Muse Code is skipped
(Should per owner decision 16; Q-27 on Meta access stays open), so the seven providers below are
Claude Code, Codex, Grok Build, Antigravity, Cursor CLI,
OpenCode and Kimi Code. Every per-provider cell was still `Unverified: operator (T10.0 live)` when this section
was written; no provider is marked `host`-only. *Update 2026-10-18:* the operator ran this runbook's login and state
probe for all seven (§6); the last column of the table records what is still open.

### Why Cursor and Kimi are still not covered (no new run on 2026-10-18)

The 2026-10-17 login-state check ([live checks](live-checks-2026-10-17-claude-codex.md) §4) ran five
providers and recorded `Cursor, Kimi Code | not run | No standalone binary to mount without a package
install`. The reason is that the check never included them, not a failure: per the channel,
`c_login_state` in `~/operator-runs/live-run-ext.sh` builds bind-mount and probe entries only for `claude`,
`codex`, `opencode`, `grok` and `agy` (unverified here: the script is outside this repository), then prints
`not covered (no binary that runs standalone in this image, or interactive-only login): cursor-agent, kimi`.
The channel therefore does not cover them now either, so the
conditional live run was **not** performed (on exit 75 do not retry; not reached).

Host-only observation on 2026-10-18 (directory listings and `readlink`/`file`, nothing executed): a
`cursor-agent` binary is present via a versioned symlink (`~/.local/bin/cursor-agent` points into
`~/.local/share/cursor-agent/versions/2026.10.16-e3cb207/`), and a `kimi` ELF is present at
`~/.kimi-code/bin/kimi`. Whether either runs standalone in `node:22-bookworm-slim` (cursor-agent's
versioned directory may need more than the one file; Kimi's only documented auth probe is an ACP
`initialize` / `session/new` exchange, [TDD §4.7](../design/TDD.md#47-kimi-code-m4-blocked-by-b-1)) is
untested. Extending `c_login_state` is operator/steward lane (the script was not edited).

Exact operator command once the channel covers them (budget check first, single run, no model call, no
login, no credential, `--network none` is inside the check):

```sh
~/operator-runs/live-usage.sh
~/operator-runs/live-run-ext.sh login-state --task-id <operator-task-id> --reason "T10.0 login-state coverage for cursor and kimi"
```

### Operator steps (common skeleton; per-provider differences are in the table)

Do not copy credential files. Do not print token contents or account identifiers. Record exit codes and
`OK` vs `AUTH_REQUIRED` (or the documented equivalent) only. Use a throwaway volume per provider, then
destroy it. The image is operator-supplied and pinned by digest (the controller never builds images); it
must contain the provider CLI, or the host binary may be bind-mounted read-only exactly as the 2026-10-17
check did (no credential path mounted).

```sh
docker volume create sb-t100-login-<provider>
# Step 1, login: network ON (device-code / URL flows need it), uid 0, volume as HOME.
docker run --rm -it --user 0 -e HOME=/root -v sb-t100-login-<provider>:/root <image> bash
# Inside: export the row's env var if any, run the row's native login command, exit.
# Step 2, state probe: same volume, --network none.
docker run --rm --network none --user 0 -e HOME=/root -v sb-t100-login-<provider>:/root <image> \
  bash -c '<state probe>; echo "git on PATH: $(command -v git || echo none)"'
# Step 3, cleanup after recording:
docker volume rm sb-t100-login-<provider>
```

Step 4 (common, after step 2 shows a login): through Switchboard, in a `container` project using the same
volume as the login store, `delegate_task` under `inspect-untrusted` with one scoped read-only prompt
(for example, list and explain the worktree files; no writes, no shell beyond the profile), poll to its
terminal state, confirm no Git write occurred, then remove the project and the container. A provider whose
login cannot complete in the volume, or whose CLI refuses to start without `git`/`gh` on `PATH`, is marked
`host`-only in that operator note and in R-13 / R-40, not before.

| Provider | Login env (export inside step 1) | Native login in the volume (TDD §4) | State probe and Git-free check (step 2) | Step 4 Switchboard task | What to record | Prior evidence (still standing on 2026-10-18) | Remaining operator cell |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR=/root/.claude` (or default `~/.claude`) | `claude auth login` ([TDD §4.1](../design/TDD.md#41-claude-code-m2): `claude auth --help` lists `login`, `logout`, `status`; [README](../guide/getting-started.md#log-in-to-the-providers-natively)) | `claude auth status` (exit code; `OK` vs `AUTH_REQUIRED`), then `command -v git` empty | Step 4 (common) with `claude` | `login works`, or `fails` → `host`-only | 2026-10-17: 2.1.294, `--version` exit 0, logged out (`loggedIn: false`) in a fresh volume with no `git` on `PATH` | In-volume native login: Observed 2026-10-18 ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)). Step 4 Switchboard container task: not run (the container backend mounts no login volume yet, T10.1 limitation (4)); tracked under M10, outside the T10.0 Done-when |
| Codex | `CODEX_HOME=/root/.codex` (or default `~/.codex`) | `codex login` ([TDD §4.2](../design/TDD.md#42-codex-m2): status is `codex login status`; [README](../guide/getting-started.md#log-in-to-the-providers-natively)) | `codex login status` (exit 0 logged in, 1 logged out), then `command -v git` empty | Step 4 (common) with `codex` | `login works`, or `fails` → `host`-only | 2026-10-17: codex-cli 0.162.0, `--version` exit 0, `Not logged in` in a fresh volume with no `git` on `PATH` | In-volume native login: Observed 2026-10-18 ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)). Step 4 Switchboard container task: not run (the container backend mounts no login volume yet, T10.1 limitation (4)); tracked under M10, outside the T10.0 Done-when |
| Grok Build | `GROK_HOME=/root/.grok` | `grok login --device-code`, completing the flow from another device ([TDD §4.3](../design/TDD.md#43-grok-build-m4); [README](../guide/getting-started.md#log-in-to-the-providers-natively)) | `grok models` first line (`You are logged in` vs `You are not authenticated`), then `command -v git` empty | Step 4 (common) with `grok` | `login works`, or `fails` → `host`-only | 2026-10-17: 1.0.50, `--version` exit 0, `You are not authenticated.` in a fresh volume with no `git` on `PATH` | In-volume native login: Observed 2026-10-18 ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)). Step 4 Switchboard container task: not run (the container backend mounts no login volume yet, T10.1 limitation (4)); tracked under M10, outside the T10.0 Done-when |
| Antigravity | `HOME=/root` (volume root) or `--gemini_dir` pointing into the volume | Launch `agy` with no arguments and complete the browser sign-in (no tokens pasted) ([TDD §4.4](../design/TDD.md#44-antigravity-agy-m4); [README](../guide/getting-started.md#log-in-to-the-providers-natively)) | `agy models` (exit 0 with `<slug>\t<name>` lines vs exit 1 `Error: Please sign in`), then `command -v git` empty; confirm the token file name exists (name and mode only) | Step 4 (common) with `agy` | `login works`, or `fails` → `host`-only | 2026-10-17: 1.4.0, `--version` exit 0, `Error: Please sign in …` in a fresh volume with no `git` on `PATH` | In-volume native login: Observed 2026-10-18 ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)). Step 4 Switchboard container task: not run (the container backend mounts no login volume yet, T10.1 limitation (4)); tracked under M10, outside the T10.0 Done-when |
| Cursor CLI | `HOME=/root` (`CURSOR_CONFIG_DIR` alone does not isolate the login, [TDD §4.5](../design/TDD.md#45-cursor-cli-m4)) | `cursor-agent login` ([TDD §4.5](../design/TDD.md#45-cursor-cli-m4); [README](../guide/getting-started.md#log-in-to-the-providers-natively)) | `cursor-agent status --format json`, key on `isAuthenticated`, then `command -v git` empty | Step 4 (common) with `cursor` | `login works`, or `fails` → `host`-only | 2026-10-17 host check: 2026.10.16-e3cb207, probe ok, auth OK; container login-state: not run (no mount lines in `c_login_state`) | In-volume native login: Observed 2026-10-18 ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)). Step 4 Switchboard container task: not run (the container backend mounts no login volume yet, T10.1 limitation (4)); tracked under M10, outside the T10.0 Done-when |
| OpenCode | `HOME=/root` plus XDG dirs; always pass `--standalone` and never mount the host user service | `opencode auth login` ([TDD §4.6](../design/TDD.md#46-opencode-m4); [README](../guide/getting-started.md#log-in-to-the-providers-natively)) | `opencode auth list --format json --standalone` (any non-`environment` connection type is logged in), then `command -v git` empty; record whether the user service was required | Step 4 (common) with `opencode` | `login works`, or `fails` → `host`-only | 2026-10-17: v2.0.23, `--version` exit 0, `No authenticated integrations` in a fresh volume with no `git` on `PATH` | In-volume native login: Observed 2026-10-18 ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)). Step 4 Switchboard container task: not run (the container backend mounts no login volume yet, T10.1 limitation (4)); tracked under M10, outside the T10.0 Done-when |
| Kimi Code | `KIMI_CODE_HOME=/root/.kimi-code` | `kimi login` (device-code) ([TDD §4.7](../design/TDD.md#47-kimi-code-m4-blocked-by-b-1); [README](../guide/getting-started.md#log-in-to-the-providers-natively); never `kimi acp --login`) | ACP `initialize` then `session/new` (a `sessionId` is logged in, JSON-RPC `-32000` is logged out; no `session/prompt`), then `command -v git` empty | Step 4 (common) with `kimi` | `login works`, or `fails` → `host`-only | 2026-10-17 host check: 2.1.1, auth `UNKNOWN`; 2026-10-15 ACP probe observed; container login-state: not run (no mount lines in `c_login_state`) | In-volume native login: Observed 2026-10-18 ([§6](#6-operator-in-volume-login-and-prompt-results-2026-10-18)). Step 4 Switchboard container task: not run (the container backend mounts no login volume yet, T10.1 limitation (4)); tracked under M10, outside the T10.0 Done-when |

## 6. Operator in-volume login and prompt results (2026-10-18)

Status: **Observed (operator, 2026-10-18)** on the Ampere host; write-up is Delegated agent work. Muse Code is
skipped (owner decision 16). No credential file was read, printed, copied or committed; outputs below are redacted
status lines only.

**Images and volumes.** One operator-built image per provider, `FROM node:22-bookworm-slim@sha256:43ac6c60b8f8…`
(pinned by digest), with the provider CLI the host already pins and **no `git` or `gh`** (every probe and prompt
printed `git=none gh=none`). Switchboard did not build them (ADR-0013). One named volume per provider holds its login,
mounted at the store the section 4 table names: `CLAUDE_CONFIG_DIR=/root/.claude`, `CODEX_HOME=/root/.codex`,
`GROK_HOME=/root/.grok`, `KIMI_CODE_HOME=/root/.kimi-code`, and the whole `HOME=/root` for Antigravity, Cursor CLI
and OpenCode (no relocation variable isolates their login). Every container ran as uid 0 (section 1).

**Login (step 1).** 2026-10-18 22:29–23:15Z: the provider's own login command in a networked container with the volume
attached; the operator finished each flow in a browser (device code for Codex, Grok Build, OpenCode and Kimi Code;
hosted-page code pasted back for Claude Code and Antigravity; polling for Cursor CLI). No `localhost` callback was
needed. OpenCode used `opencode auth login --standalone opencode` (no user service in the container).

**State probe (step 2)**, same volume, `--network none`, 2026-10-18 23:16–23:18Z (Antigravity with network, below):

| Provider | CLI | Probe | Result |
| --- | --- | --- | --- |
| Claude Code | 2.1.294 | `claude auth status` | exit 0, `loggedIn=true authMethod=claude.ai` |
| Codex | 0.162.0 | `codex login status` | exit 0, `Logged in using ChatGPT` |
| Grok Build | 1.0.50 | `grok models` | exit 0, `You are logged in with grok.com.` |
| Antigravity | 1.4.2 | `agy models` | with `--network none`: exit 1 `Fetching available models...` (needs network; token file present, mode 600, name only). With network: models listed |
| Cursor CLI | 2026.10.16-e3cb207 | `cursor-agent status --format json` | exit 0, `isAuthenticated=true` |
| OpenCode | v2.0.23 | `opencode auth list --format json --standalone` | exit 0, one non-`environment` connection (`opencode`) |
| Kimi Code | 2.1.1 | ACP `initialize` then `session/new` (no `session/prompt`) | `sessionId` returned (logged in) |

**One real prompt (Git-free check)**, same volume, network on, empty working directory, prompt `Reply with the
single word ok.`, cheapest model from the operator's model list, 2026-10-18 23:20–23:21Z:

| Provider | Model | Exit | Result | Verdict |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-haiku-5-5` (`-p --output-format json`) | 0 | `subtype: success`, `result: ok` | Observed |
| Codex | `gpt-6-luna`, effort low (`exec --sandbox read-only --skip-git-repo-check`) | 0 | `ok` (warns that no system bubblewrap is installed and uses the bundled one) | Observed |
| Grok Build | `grok-4.7` (`-p`) | 1 | `API error (status 402 Payment Required): Grok Build usage balance exhausted` | **Deferred-until-reset** (weekly balance; no reset time printed). The CLI started, authenticated and reached the API with no Git client |
| Antigravity | `gemini-3.8-flash-low` (`-p`) | 0 | `ok` | Observed |
| Cursor CLI | `auto` (`-p --trust`) | 0 | `ok`. `composer-2.5` first returned `ActionRequiredError … You're out of usage` (exit 1); `--trust` trusts the empty workspace only (not `--force`) | Observed |
| OpenCode | `opencode-go/deepseek-v4.1-flash` (`run --standalone`) | 0 | `ok` | Observed |
| Kimi Code | `kimi-code/kimi-for-coding` (`-p`) | 0 | `ok` | Observed |

**Verdict.** In-volume native login works for all seven providers, and no provider needs a Git client to start,
authenticate or (six of seven, Grok pending its balance reset) answer a prompt. No provider is marked `host`-only.
Not covered here, and outside the T10.0 Done-when: a Switchboard `container` project using these volumes (runbook
step 4), because the container backend mounts no login volume yet (T10.1 limitation (4)); that stays under M10.
