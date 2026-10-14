/**
 * `rag` configuration (T12.1; FR-RAG-01, FR-RAG-03, FR-RAG-04, FR-RAG-09, FR-RAG-11, LLD §14.1, ADR-0031).
 *
 * The installation-level `rag` section and the narrowing-only `rag` block of a project and of a context. Like the
 * inner-agent section, the schema is strict (an unknown key aborts startup, NFR-SEC-06), has NO credential field, and a
 * string value that looks like a credential is refused at load without echoing the value (ADR-0003).
 *
 * This file lives in `src/config/` (not `src/retrieval/`) so that `config/schema.ts` and `config/load.ts`, which
 * COMP-POL-side modules import, never import the retrieval service (FR-RAG-07).
 *
 * Off by default (FR-RAG-01, FR-RAG-04): with no `embedding` backend, `auto` (the default) is off and the feature is
 * inert. `mode: "on"` without a backend is a configuration error, not a silent no-op. A project or context can only
 * restrict: `off` wins, caps may only be lowered, and the sharing flags of FR-RAG-09/10 default to false.
 *
 * Values fixed by the T12.0 measurements (TDD §3.13.4): `caps.max_chunks` 25,000 (default and schema maximum),
 * `retrieval.top_k` 8, `retrieval.max_context_tokens` 4,000; `embedding.kind: "local"` is refused (no in-process model
 * exists without a new native dependency). Every other default and bound below is an **Assumption** (Delegated, T12.1):
 * - `max_files` 20,000 (max 100,000); `max_file_bytes` 262,144 (max 4,194,304); `max_total_bytes` 102,400,000, which is
 *   `max_chunks` times the 4,096-byte chunk bound, so it is also the maximum; `max_build_ms` 600,000 (max 3,600,000);
 * - `retrieval.top_k` 1..32, `max_context_tokens` 256..32,000, `max_staleness` "24h" in the retention-interval form,
 *   `admission_timeout_ms` 250 (10..5,000);
 * - `embedding.timeout_ms` 15,000 and `max_concurrency` 2, with the inner agent's bounds (LLD §13.1);
 * - `exclude`: at most 256 relative globs of at most 512 characters, no absolute path and no `..` segment;
 * - `global.sources`: at most 32, each an absolute path under an allowed root (checked lexically here; the build checks
 *   the real path again) with a label of letters, digits, `.`, `_` and `-`.
 */
import path from "node:path";
import { checkBaseUrl, looksLikeCredential } from "./inner-agent.js";

export const RAG_MODES = ["auto", "on", "off"] as const;
export type RagMode = (typeof RAG_MODES)[number];
export const RAG_BACKEND_KINDS = ["local", "http"] as const;
export type RagBackendKind = (typeof RAG_BACKEND_KINDS)[number];

/** Defaults: T12.0-measured where noted, otherwise Assumptions (see the file comment). */
export const RAG_DEFAULTS = {
  caps: {
    maxFiles: 20_000,
    maxFileBytes: 262_144,
    /** T12.0 (TDD §3.13.4). */
    maxChunks: 25_000,
    maxTotalBytes: 102_400_000,
    maxBuildMs: 600_000,
  },
  retrieval: {
    /** T12.0. */
    topK: 8,
    /** T12.0; a controller estimate, not a provider count. */
    maxContextTokens: 4000,
    maxStaleness: "24h",
    admissionTimeoutMs: 250,
  },
  embedding: { timeoutMs: 15_000, maxConcurrency: 2 },
} as const;

/** Schema maxima of the caps; a project or context may only lower the installation value. */
export const RAG_CAP_MAXIMA = {
  max_files: 100_000,
  max_file_bytes: 4_194_304,
  max_chunks: 25_000,
  max_total_bytes: 102_400_000,
  max_build_ms: 3_600_000,
} as const;

export interface RagCapsConfig {
  max_files?: number;
  max_file_bytes?: number;
  max_chunks?: number;
  max_total_bytes?: number;
  max_build_ms?: number;
}

/** The installation-level section (snake_case, as written by the operator). */
export interface RagConfig {
  embedding?: {
    kind: RagBackendKind;
    base_url?: string;
    model: string;
    allow_remote?: boolean;
    allow_source_content?: boolean;
    timeout_ms?: number;
    max_concurrency?: number;
  };
  mode?: RagMode;
  caps?: RagCapsConfig;
  retrieval?: { top_k?: number; max_context_tokens?: number; max_staleness?: string; admission_timeout_ms?: number };
  exclude?: string[];
  global?: { enabled?: boolean; sources?: { path: string; label: string }[] };
}

/** The `rag` block of a project (LLD §14.1). Narrowing only. */
export interface ProjectRagConfig {
  mode?: RagMode;
  exclude?: string[];
  caps?: RagCapsConfig;
  /** FR-RAG-10: read the global index. Default false. */
  use_global?: boolean;
  /** FR-RAG-09: contribute to the global index. Default false. */
  contribute_to_global?: boolean;
}

/** The `rag` block of a context: as a project's, without `use_global` (reading the global index is per project). */
export type ContextRagConfig = Omit<ProjectRagConfig, "use_global">;

const capsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    max_files: { type: "integer", minimum: 1, maximum: RAG_CAP_MAXIMA.max_files },
    max_file_bytes: { type: "integer", minimum: 1024, maximum: RAG_CAP_MAXIMA.max_file_bytes },
    max_chunks: { type: "integer", minimum: 1, maximum: RAG_CAP_MAXIMA.max_chunks },
    max_total_bytes: { type: "integer", minimum: 1024, maximum: RAG_CAP_MAXIMA.max_total_bytes },
    max_build_ms: { type: "integer", minimum: 1000, maximum: RAG_CAP_MAXIMA.max_build_ms },
  },
} as const;

const excludeSchema = {
  type: "array",
  maxItems: 256,
  items: { type: "string", minLength: 1, maxLength: 512 },
} as const;

/** The `rag` subschema of the config file. No credential property exists anywhere in it. */
export const ragSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    embedding: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "model"],
      properties: {
        kind: { enum: [...RAG_BACKEND_KINDS] },
        base_url: { type: "string", minLength: 1, maxLength: 2048 },
        model: { type: "string", minLength: 1, maxLength: 256 },
        allow_remote: { type: "boolean" },
        allow_source_content: { type: "boolean" },
        timeout_ms: { type: "integer", minimum: 100, maximum: 600_000 },
        max_concurrency: { type: "integer", minimum: 1, maximum: 16 },
      },
    },
    mode: { enum: [...RAG_MODES] },
    caps: capsSchema,
    retrieval: {
      type: "object",
      additionalProperties: false,
      properties: {
        top_k: { type: "integer", minimum: 1, maximum: 32 },
        max_context_tokens: { type: "integer", minimum: 256, maximum: 32_000 },
        max_staleness: { type: "string", pattern: "^[1-9][0-9]{0,5}[mhd]$" },
        admission_timeout_ms: { type: "integer", minimum: 10, maximum: 5000 },
      },
    },
    exclude: excludeSchema,
    global: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        sources: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "label"],
            properties: {
              path: { type: "string", minLength: 1, maxLength: 4096 },
              label: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" },
            },
          },
        },
      },
    },
  },
} as const;

/** The project-level `rag` block (also accepted in a dynamic project definition, then limited by its rules). */
export const projectRagSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { enum: [...RAG_MODES] },
    exclude: excludeSchema,
    caps: capsSchema,
    use_global: { type: "boolean" },
    contribute_to_global: { type: "boolean" },
  },
} as const;

/** The context-level `rag` block. */
export const contextRagSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { enum: [...RAG_MODES] },
    exclude: excludeSchema,
    caps: capsSchema,
    contribute_to_global: { type: "boolean" },
  },
} as const;

function collectStrings(value: unknown, at: string, out: { at: string; value: string }[]): void {
  if (typeof value === "string") out.push({ at, value });
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) collectStrings(v, `${at}[${i}]`, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectStrings(v, `${at}.${k}`, out);
  }
}

function credentialErrors(value: unknown, at: string): string[] {
  const strings: { at: string; value: string }[] = [];
  collectStrings(value, at, strings);
  return strings
    .filter((s) => looksLikeCredential(s.value))
    .map((s) => `${s.at}: looks like a credential; Switchboard holds none (FR-RAG-04, ADR-0003)`);
}

function excludeErrors(globs: readonly string[] | undefined, at: string): string[] {
  const errs: string[] = [];
  for (const [i, g] of (globs ?? []).entries()) {
    if (g.startsWith("/") || /^[A-Za-z]:/.test(g) || g.startsWith("\\")) {
      errs.push(`${at}[${i}]: must be relative to the context root`);
    }
    if (g.split(/[\\/]/).includes("..")) errs.push(`${at}[${i}]: must not contain a '..' segment`);
  }
  return errs;
}

function capsErrors(caps: RagCapsConfig | undefined, ceiling: RagCaps, at: string): string[] {
  const errs: string[] = [];
  const pairs: [keyof RagCapsConfig, number][] = [
    ["max_files", ceiling.maxFiles],
    ["max_file_bytes", ceiling.maxFileBytes],
    ["max_chunks", ceiling.maxChunks],
    ["max_total_bytes", ceiling.maxTotalBytes],
    ["max_build_ms", ceiling.maxBuildMs],
  ];
  for (const [k, max] of pairs) {
    const v = caps?.[k];
    if (v !== undefined && v > max) errs.push(`${at}.${k}: may only lower the installation value (${max})`);
  }
  return errs;
}

/** Minimal shape of the parts of a project this module reads (avoids an import cycle with `schema.ts`). */
interface ProjectLike {
  rag?: ProjectRagConfig;
  contexts: { rag?: ContextRagConfig }[];
}

/**
 * Cross-field checks the JSON schema cannot express, for the `rag` section and the project and context blocks. Returns
 * one line per violation, each starting with its JSON path; no message contains the offending value.
 */
export function checkRag(
  cfg: RagConfig | undefined,
  projects: readonly ProjectLike[],
  allowedRoots: readonly string[],
): string[] {
  const errs: string[] = [];
  const at = "$.rag";
  if (cfg !== undefined) {
    errs.push(...credentialErrors(cfg, at));
    const e = cfg.embedding;
    if (e !== undefined) {
      if (e.kind === "local") {
        errs.push(
          `${at}.embedding.kind: "local" is not available in this version (no in-process model, T12.0); ` +
            "run the model behind a loopback http endpoint instead",
        );
      } else if (e.base_url === undefined) {
        errs.push(`${at}.embedding.base_url: required for the http kind`);
      } else {
        errs.push(...checkBaseUrl(e.base_url, `${at}.embedding.base_url`));
      }
    }
    if (cfg.mode === "on" && e === undefined) {
      errs.push(`${at}.mode: "on" needs an embedding backend (fail closed; "auto" with none is off)`);
    }
    errs.push(...excludeErrors(cfg.exclude, `${at}.exclude`));
    for (const [i, s] of (cfg.global?.sources ?? []).entries()) {
      const sat = `${at}.global.sources[${i}].path`;
      if (!path.isAbsolute(s.path)) errs.push(`${sat}: must be absolute`);
      else if (!allowedRoots.some((r) => isUnder(path.resolve(s.path), r))) {
        errs.push(`${sat}: must be under an allowed root (FR-POL-10)`);
      }
    }
    const labels = new Set<string>();
    for (const [i, s] of (cfg.global?.sources ?? []).entries()) {
      if (labels.has(s.label)) errs.push(`${at}.global.sources[${i}].label: duplicate label`);
      labels.add(s.label);
    }
  }
  const installation = resolveRag(cfg);
  for (const [i, p] of projects.entries()) {
    const pat = `$.projects[${i}].rag`;
    if (p.rag !== undefined) errs.push(...checkRagBlock(p.rag, installation, pat));
    for (const [j, c] of p.contexts.entries()) {
      if (c.rag !== undefined) errs.push(...checkRagBlock(c.rag, installation, `$.projects[${i}].contexts[${j}].rag`));
    }
  }
  return errs;
}

/** Checks of one project or context block against the installation settings. */
export function checkRagBlock(block: ProjectRagConfig | ContextRagConfig, installation: RagSettings, at: string) {
  const errs: string[] = [...credentialErrors(block, at), ...excludeErrors(block.exclude, `${at}.exclude`)];
  if (block.mode === "on" && installation.embedding === undefined) {
    errs.push(`${at}.mode: "on" needs an installation embedding backend (rag.embedding)`);
  }
  errs.push(...capsErrors(block.caps, installation.caps, `${at}.caps`));
  return errs;
}

function isUnder(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface RagCaps {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxChunks: number;
  readonly maxTotalBytes: number;
  readonly maxBuildMs: number;
}

/** The resolved, fully defaulted installation settings (camelCase). Always present; inert without `embedding`. */
export interface RagSettings {
  /** As written (`auto` by default). Use {@link effectiveProjectRag} for whether a project is on. */
  readonly mode: RagMode;
  /** Absent means no backend: the feature is inert (FR-RAG-04). */
  readonly embedding:
    | {
        readonly kind: "http";
        readonly baseUrl: string;
        readonly model: string;
        readonly allowRemote: boolean;
        readonly allowSourceContent: boolean;
        readonly timeoutMs: number;
        readonly maxConcurrency: number;
      }
    | undefined;
  readonly caps: RagCaps;
  readonly retrieval: {
    readonly topK: number;
    readonly maxContextTokens: number;
    readonly maxStalenessMs: number;
    readonly admissionTimeoutMs: number;
  };
  readonly exclude: readonly string[];
  readonly global: { readonly enabled: boolean; readonly sources: readonly { path: string; label: string }[] };
}

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
function durationMs(s: string): number {
  return Number(s.slice(0, -1)) * UNIT_MS[s.slice(-1) as keyof typeof UNIT_MS];
}

function resolveCaps(c: RagCapsConfig | undefined, base: RagCaps): RagCaps {
  return {
    maxFiles: Math.min(c?.max_files ?? base.maxFiles, base.maxFiles),
    maxFileBytes: Math.min(c?.max_file_bytes ?? base.maxFileBytes, base.maxFileBytes),
    maxChunks: Math.min(c?.max_chunks ?? base.maxChunks, base.maxChunks),
    maxTotalBytes: Math.min(c?.max_total_bytes ?? base.maxTotalBytes, base.maxTotalBytes),
    maxBuildMs: Math.min(c?.max_build_ms ?? base.maxBuildMs, base.maxBuildMs),
  };
}

/**
 * Resolve the installation section (call {@link checkRag} first). A `local` backend, which the check refuses, never
 * resolves: the result then has no backend (fail closed).
 */
export function resolveRag(cfg: RagConfig | undefined): RagSettings {
  const e = cfg?.embedding;
  const d = RAG_DEFAULTS;
  return {
    mode: cfg?.mode ?? "auto",
    embedding:
      e === undefined || e.kind !== "http" || e.base_url === undefined
        ? undefined
        : {
            kind: "http",
            baseUrl: e.base_url,
            model: e.model,
            allowRemote: e.allow_remote === true,
            allowSourceContent: e.allow_source_content === true,
            timeoutMs: e.timeout_ms ?? d.embedding.timeoutMs,
            maxConcurrency: e.max_concurrency ?? d.embedding.maxConcurrency,
          },
    caps: {
      maxFiles: cfg?.caps?.max_files ?? d.caps.maxFiles,
      maxFileBytes: cfg?.caps?.max_file_bytes ?? d.caps.maxFileBytes,
      maxChunks: cfg?.caps?.max_chunks ?? d.caps.maxChunks,
      maxTotalBytes: cfg?.caps?.max_total_bytes ?? d.caps.maxTotalBytes,
      maxBuildMs: cfg?.caps?.max_build_ms ?? d.caps.maxBuildMs,
    },
    retrieval: {
      topK: cfg?.retrieval?.top_k ?? d.retrieval.topK,
      maxContextTokens: cfg?.retrieval?.max_context_tokens ?? d.retrieval.maxContextTokens,
      maxStalenessMs: durationMs(cfg?.retrieval?.max_staleness ?? d.retrieval.maxStaleness),
      admissionTimeoutMs: cfg?.retrieval?.admission_timeout_ms ?? d.retrieval.admissionTimeoutMs,
    },
    exclude: [...(cfg?.exclude ?? [])],
    global: { enabled: cfg?.global?.enabled === true, sources: [...(cfg?.global?.sources ?? [])] },
  };
}

/** Reason a project's retrieval is off, most general first. */
export type RagOffReason = "NO_BACKEND" | "INSTALLATION_OFF" | "PROJECT_OFF";

/** The effective per-project setting: `off` with a reason, or `on` with the narrowed caps and exclusions. */
export type EffectiveProjectRag =
  | { readonly enabled: false; readonly reason: RagOffReason }
  | {
      readonly enabled: true;
      readonly caps: RagCaps;
      readonly exclude: readonly string[];
      readonly useGlobal: boolean;
      readonly contributeToGlobal: boolean;
    };

/**
 * Whether retrieval is on for a project (FR-RAG-01, LLD §14.1). Off when there is no backend (whatever the modes), when
 * the installation says `off`, or when the project says `off`. Caps are the minimum of the installation and the project;
 * exclusions are the union. `use_global` and `contribute_to_global` are true only when the project sets them (and the
 * global store is enabled). Context blocks are applied by the scanner per context (T12.2), not here.
 */
export function effectiveProjectRag(
  installation: RagSettings,
  project: ProjectRagConfig | undefined,
): EffectiveProjectRag {
  if (installation.embedding === undefined) return { enabled: false, reason: "NO_BACKEND" };
  if (installation.mode === "off") return { enabled: false, reason: "INSTALLATION_OFF" };
  if (project?.mode === "off") return { enabled: false, reason: "PROJECT_OFF" };
  return {
    enabled: true,
    caps: resolveCaps(project?.caps, installation.caps),
    exclude: [...installation.exclude, ...(project?.exclude ?? [])],
    useGlobal: installation.global.enabled && project?.use_global === true,
    contributeToGlobal: installation.global.enabled && project?.contribute_to_global === true,
  };
}
