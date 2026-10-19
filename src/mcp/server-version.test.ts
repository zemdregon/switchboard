/**
 * Release plumbing: `SERVER_VERSION` is the single version source of truth and
 * must track the root `package.json` version at runtime (from `src/`, from
 * `dist/` and inside the packed tarball).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_NAME, SERVER_VERSION } from "./server.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function packageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  if (typeof parsed === "object" && parsed !== null) {
    const version = (parsed as { readonly version?: unknown }).version;
    if (typeof version === "string" && version !== "") {
      return version;
    }
  }
  throw new Error("package.json has no string version");
}

describe("SERVER_VERSION", () => {
  it("equals the root package.json version", () => {
    expect(SERVER_VERSION).toBe(packageVersion());
  });

  it("keeps the exported server name", () => {
    expect(SERVER_NAME).toBe("switchboard");
  });
});
