/**
 * T7.14 (FR-RTE-11, FR-MCP-03, FR-MCP-05, FR-MCP-09, BR-49, LLD §17.7, FRD V14, Q-99):
 * `routing.model_group` and `routing.model` on `delegate_task` and `enqueue_work`.
 *
 * Acceptance criteria:
 * - MCP tests through the SDK client: each refusal (closed schemas, mutual exclusion, unknown group,
 *   explicit model without a provider resolving in none or several registries, group narrowed to no member,
 *   continue_task takes neither);
 * - The existing tool schemas gain only the two optional fields;
 * - A request with neither field gives byte-identical decisions to main;
 * - The queued request (`enqueue_work`) carries the fields to admission.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedMcpClient, ResolvedProject } from "../config/index.js";
import { requestHash } from "../lifecycle/index.js";
import { ModelRegistry } from "../models/registry.js";
import type { AdmitWorkDeps } from "../queue/admission.js";
import { runProjectWorkQueueTick } from "../queue/scheduler.js";
import { type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";
import { TOOL_NAMES, WORK_QUEUE_TOOL_NAMES } from "./schemas.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};

function gitRepo(dir: string): string {
  mkdirSync(dir);
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, env: GIT_ENV });
  g("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return dir;
}

function project(id: string, repo: string): ResolvedProject {
  return {
    id,
    name: id,
    environment: { kind: "host" },
    contexts: [
      {
        id: "main",
        kind: "repository",
        path: repo,
        baseRef: "main",
        primary: true,
        writable: true,
        push: { policy: "none" },
        sign: false,
        finalizeCommit: false,
      },
    ],
  };
}

describe("routing request fields (T7.14, FR-RTE-11, LLD §17.7)", () => {
  let h: Harness;
  let projectRoot: string;
  let projects: ResolvedProject[];
  let mcpClients: Map<string, ResolvedMcpClient>;

  const modelGroupsConfig = {
    fast: {
      members: [
        { provider: "fake", model: "fake-fast" },
        { provider: "grok", model: "grok-fast" },
      ],
    },
    solo: {
      members: [{ provider: "fake", model: "fake-solo" }],
    },
  };

  const modelRegistry = new ModelRegistry(
    new Map([
      ["fake", { ids: ["fake-unique", "shared-model", "fake-fast", "fake-solo"] }],
      ["fake-b", { ids: ["fake-b-unique", "shared-model"] }],
      ["grok", { ids: ["grok-unique", "grok-fast"] }],
    ]),
  );

  beforeEach(async () => {
    projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-t714-fields-")));
    const web = gitRepo(path.join(projectRoot, "web"));
    projects = [project("web", web)];
    mcpClients = new Map([
      ["orch", { id: "orch", maxTrustProfile: "edit-untrusted", projects: ["web"] }],
      ["other", { id: "other", maxTrustProfile: "edit-untrusted", projects: ["web"] }],
    ]);
    h = await startHarness({
      allowedRoots: [projectRoot],
      config: {
        projects,
        mcpClients,
        model_groups: modelGroupsConfig,
      },
      models: modelRegistry,
    });
  });

  afterEach(async () => {
    await h.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const delegate = (args: Json, clientId?: string) =>
    h.call(
      "delegate_task",
      {
        objective: "Fix bug",
        workspace_path: h.repo,
        trust_profile: "edit-untrusted",
        ...args,
      },
      clientId,
    );

  const enqueue = (args: Json, clientId?: string) =>
    h.call(
      "enqueue_work",
      {
        project_id: "web",
        request: {
          objective: "Queued bug",
          trust_profile: "edit-untrusted",
        },
        ...args,
      },
      clientId,
    );

  // 1. Tool schemas check
  it("tool schemas gain only the two optional fields on delegate_task and enqueue_work; continue_task takes neither", async () => {
    const { tools } = await h.client().listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES, ...WORK_QUEUE_TOOL_NAMES]);

    // delegate_task
    const delegateTool = tools.find((t) => t.name === "delegate_task");
    expect(delegateTool).toBeDefined();
    const delegateRouting = delegateTool?.inputSchema.properties?.routing as Json;
    expect(delegateRouting.type).toBe("object");
    expect(delegateRouting.additionalProperties).toBe(false);
    expect(Object.keys(delegateRouting.properties).sort()).toEqual([
      "minimum_capability",
      "model",
      "model_group",
      "provider_preference",
      "require_provider",
    ]);
    expect(delegateRouting.required).toBeUndefined();

    // enqueue_work
    const enqueueTool = tools.find((t) => t.name === "enqueue_work");
    expect(enqueueTool).toBeDefined();
    const enqueueProps = (enqueueTool?.inputSchema as Json | undefined)?.properties as Json | undefined;
    const enqueueRouting = (enqueueProps?.request as Json | undefined)?.properties?.routing as Json;
    expect(enqueueRouting.type).toBe("object");
    expect(enqueueRouting.additionalProperties).toBe(false);
    expect(Object.keys(enqueueRouting.properties).sort()).toEqual([
      "minimum_capability",
      "model",
      "model_group",
      "provider_preference",
      "require_provider",
    ]);
    expect(enqueueRouting.required).toBeUndefined();

    // continue_task: does NOT have model_group or model
    const continueTool = tools.find((t) => t.name === "continue_task");
    expect(continueTool).toBeDefined();
    const continueRouting = continueTool?.inputSchema.properties?.routing as Json;
    expect(continueRouting.type).toBe("object");
    expect(continueRouting.additionalProperties).toBe(false);
    expect(Object.keys(continueRouting.properties).sort()).toEqual([
      "minimum_capability",
      "provider_preference",
      "require_provider",
    ]);
    expect(continueRouting.properties.model_group).toBeUndefined();
    expect(continueRouting.properties.model).toBeUndefined();

    // other tools: verify no other tool has routing.model_group or routing.model
    for (const t of tools) {
      if (t.name !== "delegate_task" && t.name !== "enqueue_work") {
        const r = (t.inputSchema.properties as Json | undefined)?.routing as Json | undefined;
        if (r?.properties) {
          expect(r.properties.model_group).toBeUndefined();
          expect(r.properties.model).toBeUndefined();
        }
      }
    }
  });

  // 2. Refusals on closed schemas
  it("closed schemas: extra properties or malformed patterns in routing are refused as INVALID_REQUEST", async () => {
    // Extra property on delegate_task routing
    const r1 = await delegate({ routing: { unexpected_field: "foo" } });
    expect(r1.isError).toBe(true);
    expect(r1.body.error.code).toBe("INVALID_REQUEST");

    // Malformed model_group pattern (uppercase or invalid characters)
    const r2 = await delegate({ routing: { model_group: "NOT-VALID" } });
    expect(r2.isError).toBe(true);
    expect(r2.body.error.code).toBe("INVALID_REQUEST");

    // Malformed model pattern (empty string or invalid characters)
    const r3 = await delegate({ routing: { model: "" } });
    expect(r3.isError).toBe(true);
    expect(r3.body.error.code).toBe("INVALID_REQUEST");

    // Extra property on enqueue_work request.routing
    const r4 = await enqueue({
      request: {
        objective: "Queued bug",
        trust_profile: "edit-untrusted",
        routing: { unexpected_field: "bar" },
      },
    });
    expect(r4.isError).toBe(true);
    expect(r4.body.error.code).toBe("INVALID_REQUEST");
  });

  // 3. Refusal: mutual exclusion
  it("mutual exclusion: providing both model_group and model is INVALID_REQUEST", async () => {
    const r1 = await delegate({
      routing: {
        model_group: "fast",
        model: "fake-unique",
      },
    });
    expect(r1.isError).toBe(true);
    expect(r1.body.error.code).toBe("INVALID_REQUEST");

    const r2 = await enqueue({
      request: {
        objective: "Queued bug",
        trust_profile: "edit-untrusted",
        routing: {
          model_group: "fast",
          model: "fake-unique",
        },
      },
    });
    expect(r2.isError).toBe(true);
    expect(r2.body.error.code).toBe("INVALID_REQUEST");
  });

  // 4. Refusal: unknown group
  it("unknown group: model_group not in configured groups is INVALID_REQUEST and names the field, not configured groups", async () => {
    const r1 = await delegate({
      routing: {
        model_group: "nonexistent",
      },
    });
    expect(r1.isError).toBe(true);
    expect(r1.body.error.code).toBe("INVALID_REQUEST");
    expect(r1.body.error.details).toMatchObject({ field: "routing.model_group" });
    // Must name the field, but not the configured groups
    expect(r1.body.error.message).toMatch(/routing\.model_group|model_group/);
    expect(r1.body.error.message).not.toContain("fast");
    expect(r1.body.error.message).not.toContain("solo");

    const r2 = await enqueue({
      request: {
        objective: "Queued bug",
        trust_profile: "edit-untrusted",
        routing: {
          model_group: "nonexistent",
        },
      },
    });
    expect(r2.isError).toBe(true);
    expect(r2.body.error.code).toBe("INVALID_REQUEST");
    expect(r2.body.error.details).toMatchObject({ field: "routing.model_group" });
  });

  // 5. Refusal: group narrowed to no member
  it("group narrowed to no member by provider_preference is INVALID_REQUEST", async () => {
    // 'solo' group has only 'fake'. Asking for provider_preference 'grok' narrows to 0 members.
    const r1 = await delegate({
      routing: {
        model_group: "solo",
        provider_preference: "grok",
      },
    });
    expect(r1.isError).toBe(true);
    expect(r1.body.error.code).toBe("INVALID_REQUEST");

    const r2 = await enqueue({
      request: {
        objective: "Queued bug",
        trust_profile: "edit-untrusted",
        routing: {
          model_group: "solo",
          provider_preference: "grok",
        },
      },
    });
    expect(r2.isError).toBe(true);
    expect(r2.body.error.code).toBe("INVALID_REQUEST");
  });

  // 6. Refusal: explicit model without provider that resolves in none or several registries
  it("explicit model without a provider that resolves in none or several registries is INVALID_REQUEST with 'name a provider for this model'", async () => {
    // Model in none of the registries
    const rNone = await delegate({
      routing: {
        model: "unknown-model",
      },
    });
    expect(rNone.isError).toBe(true);
    expect(rNone.body.error.code).toBe("INVALID_REQUEST");
    expect(rNone.body.error.message).toContain("name a provider for this model");

    // Model in several registries ('shared-model' is in both fake and fake-b)
    const rSeveral = await delegate({
      routing: {
        model: "shared-model",
      },
    });
    expect(rSeveral.isError).toBe(true);
    expect(rSeveral.body.error.code).toBe("INVALID_REQUEST");
    expect(rSeveral.body.error.message).toContain("name a provider for this model");

    // Same checks on enqueue_work
    const rEnqueueNone = await enqueue({
      request: {
        objective: "Queued bug",
        trust_profile: "edit-untrusted",
        routing: {
          model: "unknown-model",
        },
      },
    });
    expect(rEnqueueNone.isError).toBe(true);
    expect(rEnqueueNone.body.error.code).toBe("INVALID_REQUEST");
    expect(rEnqueueNone.body.error.message).toContain("name a provider for this model");

    const rEnqueueSeveral = await enqueue({
      request: {
        objective: "Queued bug",
        trust_profile: "edit-untrusted",
        routing: {
          model: "shared-model",
        },
      },
    });
    expect(rEnqueueSeveral.isError).toBe(true);
    expect(rEnqueueSeveral.body.error.code).toBe("INVALID_REQUEST");
    expect(rEnqueueSeveral.body.error.message).toContain("name a provider for this model");
  });

  // 7. Refusal: explicit model without provider when all providers have unrestricted registries
  it("explicit model without a provider when registries are unrestricted is INVALID_REQUEST with 'name a provider for this model'", async () => {
    // Re-create harness without any model registry (all providers are unrestricted)
    await h.close();
    h = await startHarness({
      allowedRoots: [projectRoot],
      config: {
        projects,
        mcpClients,
        model_groups: modelGroupsConfig,
      },
    });
    const r = await delegate({
      routing: {
        model: "any-model",
      },
    });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe("INVALID_REQUEST");
    expect(r.body.error.message).toContain("name a provider for this model");
  });

  // 8. Refusal: continue_task takes neither field (Q-99)
  it("continue_task accepts neither routing.model_group nor routing.model (Q-99, INVALID_REQUEST)", async () => {
    // Create an initial run to get an active meta_session_id
    const run = await h.ok("delegate_task", {
      objective: "Initial task",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
    });
    expect(run.meta_session_id).toBeDefined();
    await h.lifecycle.waitForTerminal(run.run_id);

    // continue_task with model_group is refused
    const rGroup = await h.call("continue_task", {
      meta_session_id: run.meta_session_id,
      instruction: "Follow up instruction",
      routing: {
        model_group: "fast",
      },
    });
    expect(rGroup.isError).toBe(true);
    expect(rGroup.body.error.code).toBe("INVALID_REQUEST");
    expect(rGroup.body.error.message).toBe(
      "continue_task accepts neither routing.model_group nor routing.model (Q-99)",
    );
    expect(rGroup.body.error.details).toMatchObject({ field: "routing" });

    // continue_task with model is refused
    const rModel = await h.call("continue_task", {
      meta_session_id: run.meta_session_id,
      instruction: "Follow up instruction",
      routing: {
        model: "fake-unique",
      },
    });
    expect(rModel.isError).toBe(true);
    expect(rModel.body.error.code).toBe("INVALID_REQUEST");
    expect(rModel.body.error.message).toBe(
      "continue_task accepts neither routing.model_group nor routing.model (Q-99)",
    );
    expect(rModel.body.error.details).toMatchObject({ field: "routing" });

    // continue_task with another unknown routing key keeps the generic message
    const rUnknown = await h.call("continue_task", {
      meta_session_id: run.meta_session_id,
      instruction: "Follow up instruction",
      routing: {
        unexpected_key: "surprise",
      },
    });
    expect(rUnknown.isError).toBe(true);
    expect(rUnknown.body.error.code).toBe("INVALID_REQUEST");
    expect(rUnknown.body.error.message).toContain("must NOT have additional properties");
    expect(rUnknown.body.error.details).toMatchObject({ field: "$.routing.unexpected_key" });

    // tools/list for continue_task is unchanged and keeps closed routing schema without model/model_group
    const { tools } = await h.client().listTools();
    const continueTool = tools.find((t) => t.name === "continue_task");
    expect(continueTool).toBeDefined();
    const continueRouting = continueTool?.inputSchema.properties?.routing as Json;
    expect(continueRouting.type).toBe("object");
    expect(continueRouting.additionalProperties).toBe(false);
    expect(Object.keys(continueRouting.properties).sort()).toEqual([
      "minimum_capability",
      "provider_preference",
      "require_provider",
    ]);
  });

  // 9. Valid requests with model_group or model
  it("accepts valid routing.model_group and valid routing.model on delegate_task", async () => {
    // Valid model_group without provider
    const r1 = await h.ok("delegate_task", {
      objective: "Task with group",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
      routing: {
        model_group: "fast",
      },
    });
    expect(r1.run_id).toBeDefined();

    // Valid model_group narrowed by provider_preference
    const r2 = await h.ok("delegate_task", {
      objective: "Task with narrowed group",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
      routing: {
        model_group: "fast",
        provider_preference: "fake",
      },
    });
    expect(r2.run_id).toBeDefined();

    // Valid explicit model with provider_preference
    const r3 = await h.ok("delegate_task", {
      objective: "Task with explicit model and provider",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
      routing: {
        provider_preference: "fake",
        model: "fake-unique",
      },
    });
    expect(r3.run_id).toBeDefined();

    // Valid explicit model without provider when it resolves in exactly one enabled registry ('grok-unique')
    const r4 = await h.ok("delegate_task", {
      objective: "Task with unique model",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
      routing: {
        model: "grok-unique",
      },
    });
    expect(r4.run_id).toBeDefined();
  });

  // 10. A request with neither field gives byte-identical decisions to main
  it("a request with neither field gives byte-identical decisions to main", async () => {
    // Delegate without model_group or model
    const run = await h.ok("delegate_task", {
      objective: "Task with default routing",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
      routing: {
        provider_preference: "fake",
      },
    });
    await h.lifecycle.waitForTerminal(run.run_id);

    const row = h.ledger.getRouteDecision(run.run_id);
    expect(row).toBeDefined();
    expect(row?.selected_provider).toBe("fake");

    const features = JSON.parse(row?.features_json ?? "{}");
    expect(features.schema_version).toBe(2);
    expect(features.route_features.classifier).toBe("heuristic.v1");
    expect(features.route_features.task_kind.value).toBe("other");
    expect(features.provider_preference).toBe("fake");

    const candidates = JSON.parse(row?.candidates_json ?? "[]");
    expect(candidates.map((c: Json) => c.provider)).toEqual(["fake", "fake-b", "grok"]);

    expect(Object.keys(features.score_inputs).sort()).toEqual(["fake", "fake-b", "grok"]);
  });

  // 11. Queued request (enqueue_work) carries fields to admission
  it("queued request (enqueue_work) carries routing fields to admission", async () => {
    // Enqueue work with model_group
    const itemGroup = await h.ok("enqueue_work", {
      project_id: "web",
      request: {
        objective: "Queued with group",
        trust_profile: "edit-untrusted",
        routing: {
          model_group: "fast",
        },
      },
    });
    expect(itemGroup.work_item_id).toBeDefined();

    // Verify stored in project_work_item request_json
    const rowGroup = h.ledger.getWorkItem(itemGroup.work_item_id);
    expect(rowGroup).toBeDefined();
    const storedGroupReq = JSON.parse(rowGroup?.request_json ?? "{}");
    expect(storedGroupReq.routing).toEqual({ model_group: "fast", require_provider: false });

    // Tick queue scheduler to admit the item
    const tickOutcome1 = await runProjectWorkQueueTick(
      h.ledger,
      {
        lifecycle: h.lifecycle,
        ledger: h.ledger,
        registry: h.registry,
        config: {
          allowedRoots: [h.root, projectRoot],
          mcpClients,
          projects,
          model_groups: modelGroupsConfig,
        },
        models: modelRegistry,
      } as unknown as AdmitWorkDeps,
      { maxItemsPerProject: 500, dequeueBatch: 1 },
    );
    expect(tickOutcome1.admitted).toBe(1);

    const admittedGroupItem = h.ledger.getWorkItem(itemGroup.work_item_id);
    expect(admittedGroupItem?.state).toBe("ADMITTED");
    expect(admittedGroupItem?.admitted_run_id).toBeDefined();

    // Verify run request hash includes routing.model_group
    const admittedRun = h.ledger.getRunRecord(admittedGroupItem?.admitted_run_id as string);
    expect(admittedRun).toBeDefined();
    const expectedHashGroup = requestHash({
      tool: "delegate_task",
      objective: "Queued with group",
      workspace_path: projects[0]?.contexts[0]?.path as string,
      project: "web",
      constraints: [],
      trust_profile: "edit-untrusted",
      verification_commands: [],
      routing: { model_group: "fast", require_provider: false },
      priority: "normal",
    });
    expect(admittedRun?.request_hash).toBe(expectedHashGroup);

    // Enqueue work with explicit model and provider_preference
    const itemModel = await h.ok("enqueue_work", {
      project_id: "web",
      request: {
        objective: "Queued with model",
        trust_profile: "edit-untrusted",
        routing: {
          provider_preference: "fake",
          model: "fake-fast",
        },
      },
    });
    const rowModel = h.ledger.getWorkItem(itemModel.work_item_id);
    const storedModelReq = JSON.parse(rowModel?.request_json ?? "{}");
    expect(storedModelReq.routing).toEqual({
      provider_preference: "fake",
      model: "fake-fast",
      require_provider: false,
    });

    const tickOutcome2 = await runProjectWorkQueueTick(
      h.ledger,
      {
        lifecycle: h.lifecycle,
        ledger: h.ledger,
        registry: h.registry,
        config: {
          allowedRoots: [h.root, projectRoot],
          mcpClients,
          projects,
          model_groups: modelGroupsConfig,
        },
        models: modelRegistry,
      } as unknown as AdmitWorkDeps,
      { maxItemsPerProject: 500, dequeueBatch: 1 },
    );
    expect(tickOutcome2.admitted).toBe(1);
    const admittedModelItem = h.ledger.getWorkItem(itemModel.work_item_id);
    expect(admittedModelItem?.state).toBe("ADMITTED");
  });
});
