/**
 * Launcher arguments for the one shared replay helper (`replay.mjs`, T4.3). A provider's case file builds its adapter's
 * `launcherArgs` with `replayLauncher` and so never copies the helper; the adapter appends its own argv after `--`.
 */
import { fileURLToPath } from "node:url";

export const REPLAY_SCRIPT = fileURLToPath(new URL("./replay.mjs", import.meta.url));

/** A provider with a dialect file in `replay-dialects/<id>.mjs`. */
export type ReplayProvider = string;

/** `launcherArgs` for an adapter: `<replay.mjs> --provider ID --fixture FILE [extra...] --`. */
export function replayLauncher(provider: ReplayProvider, fixtureFile: string, extra: readonly string[] = []): string[] {
  return [REPLAY_SCRIPT, "--provider", provider, "--fixture", fixtureFile, ...extra, "--"];
}
