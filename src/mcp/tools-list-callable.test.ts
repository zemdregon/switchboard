/**
 * tools/list is the discovery contract: for every client configuration, the names `tools/list` returns must equal the
 * set of tools the client can call (a name answered with anything other than the unknown-tool INVALID_REQUEST), and
 * every listed `inputSchema` / `outputSchema` must be a valid JSON Schema to both a draft-07 and a 2020-12 validator.
 *
 * Why (prod 2026-10-20, 973a82c): grok-bot was granted `manage_projects`, `approval_proxy` and `max_push_policy:
 * branch`; `create_project`, `publish_run` and `decide_approval` worked by name, yet its MCP client kept showing the 21
 * tools of the previous release. The server listed all 28, but get_digest's output schema had become invalid JSON
 * Schema for draft-07 validators (`ref_events[].code` listed `merged` twice, #797), so a client that checks the
 * published schemas when it lists tools could not accept the new list and kept its last good one. The schema check
 * below covers every tool of every configuration, so no tool's schema can break discovery of the others again.
 */
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedMcpClient } from "../config/index.js";
import { APPROVAL_PROXY_TOOL_NAMES } from "../control/approval-proxy.js";
import { createIdGenerator } from "../ids/index.js";
import { DynamicProjectStore } from "../projects/index.js";
import { type Harness, startHarness } from "../routing/fixtures/harness.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_NAMES,
  DEFAULT_MAX_PER_RUN,
  DEFAULT_MAX_RUN_BYTES,
} from "../skills/index.js";
import { DECIDE_TOOL_NAMES, DECISION_TOOL_NAMES } from "./decision-tools.js";
import {
  PROJECT_TOOL_NAMES,
  PUBLISH_TOOL_NAMES,
  SEARCH_TOOL_NAMES,
  SKILL_TOOL_NAMES,
  TOOL_NAMES,
  WORK_QUEUE_TOOL_NAMES,
} from "./schemas.js";

/** Every tool name the server knows, whether or not a given client is offered it. */
const ALL_TOOL_NAMES: readonly string[] = [
  ...TOOL_NAMES,
  ...WORK_QUEUE_TOOL_NAMES,
  ...PUBLISH_TOOL_NAMES,
  ...SEARCH_TOOL_NAMES,
  ...SKILL_TOOL_NAMES,
  ...PROJECT_TOOL_NAMES,
  ...APPROVAL_PROXY_TOOL_NAMES,
  ...DECISION_TOOL_NAMES,
  ...DECIDE_TOOL_NAMES,
];

type Client = Omit<ResolvedMcpClient, "id">;

/** The server ports `serve` wires in prod, so every gated tool can exist; none of them is reached by these calls. */
const fullDeps = ({ db, dataDir }: { db: import("better-sqlite3").Database; dataDir: string }) => ({
  projectStore: new DynamicProjectStore(db, { ids: createIdGenerator() }),
  decisions: {},
  skills: {
    db,
    dataDir,
    settings: {
      enabled: true,
      defaults: [],
      roles: {},
      delivery: "native_preferred" as const,
      allowDraftInTrusted: false,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      maxPerRun: DEFAULT_MAX_PER_RUN,
      maxRunBytes: DEFAULT_MAX_RUN_BYTES,
      maxNames: DEFAULT_MAX_NAMES,
    },
  },
  publish: {
    pusher: {
      push: async () => {
        throw new Error("not reached: publish_run is only called with invalid arguments here");
      },
    },
    resolveContext: () => undefined,
    pulls: {} as never,
  },
  // ADR-0070: the gh merge port behind merge_run_pr (never reached: merge_run_pr is called with invalid arguments).
  mergeRun: {
    db,
    merge: {} as never,
    targets: () => [],
    resolveRemote: async () => undefined,
  },
});

interface Setup {
  readonly name: string;
  readonly orch: Client;
  readonly other: Client;
  readonly deps?: typeof fullDeps;
  /** Tools `orch` must be offered (and so able to call) in this setup. */
  readonly orchMust?: readonly string[];
  /** Tools `orch` must neither list nor be able to call. */
  readonly orchMustNot?: readonly string[];
}

const SETUPS: readonly Setup[] = [
  {
    name: "no optional ports: plain orchestrator and console clients",
    orch: { maxTrustProfile: "edit-untrusted" },
    other: { maxTrustProfile: "edit-untrusted", toolProfile: "console" },
    orchMustNot: ["create_project", "publish_run", "decide_approval", "list_pending_approvals", "decide"],
  },
  {
    name: "prod grok-bot (manage_projects, approval_proxy on itself, push branch) and a console approver",
    orch: {
      maxTrustProfile: "privileged",
      privilegedApproval: "required",
      toolProfile: "orchestrator",
      manageProjects: true,
      maxPushPolicy: "branch",
      approvalProxy: true,
      approvalProxyTargets: ["orch"],
      approvalProxyKinds: ["dynamic_project", "push_revision"],
    },
    other: {
      maxTrustProfile: "inspect-untrusted",
      toolProfile: "console",
      approvalProxy: true,
      approvalProxyTargets: ["orch"],
    },
    deps: fullDeps,
    orchMust: [
      "create_project",
      "update_project",
      "delete_project",
      "publish_run",
      "merge_run_pr",
      "list_pending_approvals",
      "decide_approval",
      "decide",
      "request_decision",
      "list_decisions",
      "list_skills",
      "get_skill",
    ],
  },
  {
    name: "prod linus (privileged, no proxy, no push) next to a project manager without push",
    orch: {
      maxTrustProfile: "privileged",
      privilegedApproval: "not_required",
      toolProfile: "orchestrator",
      allowLight: true,
    },
    other: { maxTrustProfile: "edit-untrusted", manageProjects: true, maxPushPolicy: "none" },
    deps: fullDeps,
    orchMust: ["request_decision", "list_decisions", "list_skills"],
    orchMustNot: [
      "create_project",
      "publish_run",
      "merge_run_pr",
      "decide_approval",
      "list_pending_approvals",
      "decide",
    ],
  },
];

/** Duplicate `enum` items anywhere in a schema document, as `path: item` strings. */
function duplicateEnums(schema: unknown, at = "#"): string[] {
  if (Array.isArray(schema)) return schema.flatMap((s, i) => duplicateEnums(s, `${at}/${i}`));
  if (schema === null || typeof schema !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(schema)) {
    if (k === "enum" && Array.isArray(v)) {
      const seen = new Set<string>();
      for (const item of v) {
        const key = JSON.stringify(item);
        if (seen.has(key)) out.push(`${at}/enum: ${key}`);
        seen.add(key);
      }
    }
    out.push(...duplicateEnums(v, `${at}/${k}`));
  }
  return out;
}

/** Compile errors of one schema under a draft-07 and a 2020-12 validator, each checking it against its meta-schema. */
function schemaErrors(schema: object): string[] {
  const errors: string[] = [];
  for (const [dialect, ajv] of [
    ["draft-07", new Ajv({ strict: false, validateSchema: true, logger: false })],
    ["2020-12", new Ajv2020({ strict: false, validateSchema: true, logger: false })],
  ] as const) {
    try {
      ajv.compile(schema);
    } catch (err) {
      errors.push(`${dialect}: ${(err as Error).message.slice(0, 300)}`);
    }
  }
  return errors;
}

const isUnknownTool = (body: { error?: { code?: string; message?: string } }): boolean =>
  body.error?.code === "INVALID_REQUEST" && /^unknown tool "/.test(body.error.message ?? "");

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("tools/list matches the callable tools for each client configuration", () => {
  for (const setup of SETUPS) {
    it(setup.name, async () => {
      h = await startHarness({
        config: {
          mcpClients: new Map<string, ResolvedMcpClient>([
            ["orch", { id: "orch", ...setup.orch }],
            ["other", { id: "other", ...setup.other }],
          ]),
        },
        ...(setup.deps !== undefined ? { deps: setup.deps } : {}),
      });
      for (const clientId of ["orch", "other"]) {
        const { tools } = await h.client(clientId).listTools();
        const listed = tools.map((t) => t.name);
        expect(new Set(listed).size, `${clientId}: duplicate names in tools/list`).toBe(listed.length);
        // Callable: anything but the unknown-tool refusal. Empty arguments, so a callable tool is refused by its own
        // input schema (or answers a read-only listing) and nothing is created, pushed or decided.
        const callable: string[] = [];
        for (const name of ALL_TOOL_NAMES) {
          const r = await h.call(name, {}, clientId);
          if (!(r.isError && isUnknownTool(r.body))) callable.push(name);
        }
        expect([...listed].sort(), `${clientId}: tools/list vs callable tools`).toEqual([...callable].sort());
        for (const t of tools) {
          for (const [kind, schema] of [
            ["inputSchema", t.inputSchema],
            ["outputSchema", t.outputSchema],
          ] as const) {
            if (schema === undefined) continue;
            expect(duplicateEnums(schema), `${clientId} ${t.name}.${kind}: duplicate enum items`).toEqual([]);
            expect(schemaErrors(schema), `${clientId} ${t.name}.${kind}: invalid JSON Schema`).toEqual([]);
          }
        }
        if (clientId === "orch") {
          expect(listed).toEqual(expect.arrayContaining([...(setup.orchMust ?? [])]));
          for (const name of setup.orchMustNot ?? []) expect(listed).not.toContain(name);
        }
      }
    });
  }
});
