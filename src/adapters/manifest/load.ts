/** Manifest loader (LLD §6): reads versioned data from the repository, Ajv-validates, fails closed. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ProviderId } from "../types.js";
import { type ComplianceManifest, manifestSchema } from "./schema.js";

export class ManifestError extends Error {
  override readonly name = "ManifestError";
}

export interface LoadedManifest {
  manifest: ComplianceManifest;
  /** sha256 of the manifest file bytes; recorded in `adapter_version.manifest_hash` (LLD §6). */
  hash: string;
  path: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile<ComplianceManifest>(manifestSchema);

export const MANIFEST_DIR = fileURLToPath(new URL("../manifests/", import.meta.url));

/** Validates already-parsed JSON. Throws ManifestError listing every violation. */
export function validateManifest(data: unknown): ComplianceManifest {
  if (!validate(data)) {
    const detail = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`).join("; ");
    throw new ManifestError(`invalid compliance manifest: ${detail}`);
  }
  const d = new Date(`${data.validated_on}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== data.validated_on) {
    throw new ManifestError(`invalid compliance manifest: validated_on is not a calendar date: ${data.validated_on}`);
  }
  return data;
}

/** Parses and validates manifest text. */
export function parseManifest(text: string): ComplianceManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new ManifestError(`compliance manifest is not valid JSON: ${(e as Error).message}`);
  }
  return validateManifest(data);
}

/** Loads `<dir>/<provider>.json`. Missing, unreadable or invalid files throw (callers treat that as ineligible). */
export function loadManifest(provider: ProviderId, dir: string = MANIFEST_DIR): LoadedManifest {
  const path = `${dir}${dir.endsWith("/") ? "" : "/"}${provider}.json`;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new ManifestError(`no compliance manifest for ${provider}: ${(e as Error).message}`);
  }
  const manifest = parseManifest(bytes.toString("utf8"));
  if (manifest.provider !== provider) {
    throw new ManifestError(`manifest ${path} declares provider ${manifest.provider}, expected ${provider}`);
  }
  return { manifest, hash: createHash("sha256").update(bytes).digest("hex"), path };
}

/** Loads a manifest, returning undefined (fail closed) when absent or invalid; the error is returned for reporting. */
export function tryLoadManifest(
  provider: ProviderId,
  dir?: string,
): { loaded: LoadedManifest; error?: undefined } | { loaded?: undefined; error: ManifestError } {
  try {
    return { loaded: loadManifest(provider, dir) };
  } catch (e) {
    return { error: e instanceof ManifestError ? e : new ManifestError(String(e)) };
  }
}
