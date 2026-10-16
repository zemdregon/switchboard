# Version canary (T8.5)

Switchboard records each enabled provider's installed CLI version under the data directory (`version-canary.json`).
A scheduled check compares the probed version to the last recorded value (or to the manifest's `validated_cli_version`
when no row exists yet). When the version changes, the adapter is treated as `ADAPTER_VERSION_UNVERIFIED` until you run
`switchboard adapters validate <provider>` successfully. The controller does not auto-validate or route the new version.

## Operator command

```bash
switchboard adapters version-canary
```

Exit code `0` when every enabled provider matches its baseline; `1` when any version bump is detected. Bumps are also
printed on stderr as `[version-canary]` lines. `switchboard doctor` applies the same rule during adapter preflight.

After `adapters validate` succeeds, the validated binary version is written into `version-canary.json` automatically.

## Schedule shape (Delegated)

Run the check on a timer on the operator host (not in CI). Examples:

**cron** (every six hours):

```cron
0 */6 * * * /usr/bin/env bash -lc 'switchboard adapters version-canary --config "$SWITCHBOARD_CONFIG" >>/var/log/switchboard-version-canary.log 2>&1'
```

**systemd timer** (`/etc/systemd/system/switchboard-version-canary.service`):

```ini
[Unit]
Description=Switchboard adapter version canary (T8.5)

[Service]
Type=oneshot
Environment=SWITCHBOARD_CONFIG=/etc/switchboard/config.json
ExecStart=/usr/local/bin/switchboard adapters version-canary
```

`/etc/systemd/system/switchboard-version-canary.timer`:

```ini
[Unit]
Description=Run Switchboard version canary every six hours

[Timer]
OnCalendar=*-*-* 00,06,12,18:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with `systemctl enable --now switchboard-version-canary.timer`.

**Operator-only proof:** upgrading a real provider CLI on the host and seeing `[version-canary]` / `doctor` report
`ADAPTER_VERSION_UNVERIFIED` is not run in CI; record one successful dry run on the operator machine when you adopt the
timer.

## References

- [ROADMAP §6.15 T8.5](../ROADMAP.md#615-m8-hardening-tasks)
- FR-ADP-03, NFR-PERF-02, FR-OPS-02
- Implementation: `src/adapters/version-canary.ts`, `src/cli/adapters-version-canary.ts`
