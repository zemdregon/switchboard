/**
 * COMP-MCP: the upstream MCP server over stdio (T2.4; FR-MCP-01, 03–09; ADR-0002; LLD §3). It owns validation and
 * result shaping only; admission, dispatch and cancellation stay in the run lifecycle, and eligibility is the shared
 * stage-1 filter (`src/routing`) reached through `RunLifecycle.checkEligibility`.
 *
 * SDK use: `@modelcontextprotocol/sdk` 1.32.1. Its high-level `McpServer.registerTool` takes zod schemas, so this
 * module uses the lower-level `Server` with `tools/list` and `tools/call` request handlers and publishes the raw JSON
 * Schemas from `./schemas.ts`, validated here with Ajv (TDD §2: Ajv schemas are the source of truth; zod is not a
 * direct dependency).
 *
 * Client identity is fixed per stdio session (`clientId`, bound by `serve --client <id>`, FR-OPS-04, R-9). Proposed
 * (Delegated) choices, all fail-closed:
 * - Validation order follows FRD §7.1: schema (V1, V2, V9) → workspace (V3, V4) → ceiling (V5) → verification (V7) →
 *   routing hints (V8) → idempotency (V10) → eligibility (V11). The first failure is the single error.
 * - `privileged` (T3.3, LLD §3.1, FRD V13/C7/T1/T2): a client whose ceiling is below `privileged` gets
 *   PERMISSION_BLOCKED (V5); then V13 refuses `privileged` without `privileged_scope` and a scope with any other profile
 *   (INVALID_REQUEST, `details.field = "privileged_scope"`). A malformed scope already failed V1 (schema plus the
 *   "present exactly when allowlist" check run right after Ajv). Admission is T2: AWAITING_APPROVAL plus one PENDING
 *   approval row. `continue_task` resolving `privileged` (requested or defaulted, C4) needs the meta-session's APPROVED
 *   approval for this client (C7, checked after the ceiling) and takes the approved scope as is.
 * - Proposed: no adapter compiles `privileged` before T3.5/T3.6, so for a `privileged` request V11 defers the adapter
 *   compile verdict to dispatch: a provider excluded only by PROFILE_UNSUPPORTED or CAPABILITY_MISSING is admissible
 *   (it still has to pass binary, version, manifest, enablement, platform and auth). The run is refused at dispatch
 *   until the adapters compile the scope (`PRIVILEGED_NOT_COMPILABLE` in the lifecycle).
 * - Non-empty `verification_commands` are refused with INVALID_REQUEST until verification (FR-EXE-08) lands in M3,
 *   rather than accepted and silently not run. `minimum_capability` fails ELIGIBILITY_NONE: it is a hard constraint
 *   (BR-4) and no model registry exists before M7.
 * - The idempotency hash covers the validated, defaults-filled input with the workspace canonicalised, excluding
 *   `idempotency_key` and `wait_seconds` (which do not change what runs) and independent of the routed provider.
 * - Provider choice among eligible candidates: `provider_preference` if eligible, else candidate (registration) order
 *   (BR-4 tie-break until M7 scoring).
 * - Runs, meta-sessions and artifacts are visible only to the client that created them; another client's id is
 *   reported as unknown (INVALID_REQUEST), so ids are not an existence oracle across clients.
 * - `continue_task` (M2, same provider) resumes the latest native session of the meta-session's bound provider. A
 *   different provider in `routing` (handoff, M5) and a session with no recorded native session fail INVALID_REQUEST;
 *   an ineligible bound provider fails with its BR-3 code (no handoff fallback in M2).
 * - Unknown tool names return an INVALID_REQUEST tool error (FR-MCP-07) rather than a JSON-RPC protocol error.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { type AdapterRegistry, isIneligible, type ProviderId, type ResolvedProfile } from "../adapters/index.js";
import type { ArtifactStore } from "../artifacts/index.js";
import type { ResolvedConfig } from "../config/index.js";
import type { Ledger, RunRecord, TrustProfile } from "../ledger/index.js";
import { type EligibilityAnswer, type RunLifecycle, type RunPriority, requestHash } from "../lifecycle/index.js";
import { checkScopeLists, type PrivilegedScope, parsePrivilegedScope, resolveTrustProfile } from "../policy/index.js";
import { profileRank, TRUST_PROFILE_ORDER, toRouteDecisionJson } from "../routing/index.js";
import { buildEnvelope, compactEvents, type Envelope } from "./envelope.js";
import { errorEnvelope, invalid, ToolError, toToolError } from "./errors.js";
import {
  inputSchema,
  MCP_ARTIFACT_KINDS,
  SCHEMA_DIALECT,
  TOOL_NAMES,
  TOOL_SCHEMA_VERSION,
  type ToolName,
  toolDescriptors,
} from "./schemas.js";
import { createScrubber } from "./scrub.js";

export const SERVER_NAME = "switchboard";
/** Proposed: tracks package.json `version`. */
export const SERVER_VERSION = "0.0.0";

export interface McpServerDeps {
  readonly lifecycle: RunLifecycle;
  readonly ledger: Ledger;
  readonly artifacts: ArtifactStore;
  readonly registry: AdapterRegistry;
  readonly config: Pick<ResolvedConfig, "allowedRoots" | "mcpClients">;
  /** Configured MCP client this session is bound to (`serve --client <id>`). */
  readonly clientId: string;
  /** Routing candidate order (BR-4 tie-break). Defaults to registry registration order. */
  readonly candidateOrder?: readonly ProviderId[];
}

export interface SwitchboardMcpServer {
  readonly server: Server;
  readonly clientId: string;
  readonly maxTrustProfile: TrustProfile;
  /** Handle one `tools/call` directly (used by the request handler; exposed for tests). */
  callTool(name: string, args: unknown): Promise<CallToolResult>;
  close(): Promise<void>;
}

type Args = Record<string, unknown>;
type Routing = { provider_preference?: string; require_provider?: boolean; minimum_capability?: string };

const INSTRUCTIONS =
  "Switchboard delegates coding tasks to provider CLIs. delegate_task and continue_task are asynchronous: they return " +
  "a run_id at once; poll get_run (or pass wait_seconds, at most 60) until status is SUCCEEDED, FAILED or CANCELLED, " +
  "then read get_artifacts. Errors carry one failure code from the Switchboard taxonomy.";

export function createSwitchboardServer(deps: McpServerDeps): SwitchboardMcpServer {
  const client = deps.config.mcpClients.get(deps.clientId);
  if (!client) throw new Error(`unknown MCP client ${JSON.stringify(deps.clientId)}; add it to mcp_clients in config`);
  if (!deps.lifecycle.gatesEligibility) {
    // NFR-SEC-06: never accept MCP work with a lifecycle that skips the version/manifest/auth gate at dispatch.
    throw new Error("the run lifecycle must be constructed with eligibility dependencies before serving MCP");
  }
  const maxTrustProfile = client.maxTrustProfile;
  const { lifecycle, ledger } = deps;
  const scrub = createScrubber(deps.config.allowedRoots);
  const validators = compileValidators();

  // ---- helpers ------------------------------------------------------------------------------------------------

  const candidates = (): ProviderId[] => {
    const registered = new Set(deps.registry.list().map((a) => a.id));
    const order = deps.candidateOrder ?? [...registered];
    return order.filter((id) => registered.has(id));
  };

  const ownRun = (runId: string): RunRecord => {
    const run = ledger.getRunRecord(runId);
    if (!run || run.client_id !== deps.clientId) throw invalid(`unknown run ${runId}`);
    return run;
  };

  const envelopeOf = (runId: string, extra: Partial<Envelope> = {}): Envelope => ({
    ...buildEnvelope(ledger, ownRun(runId), scrub),
    ...extra,
  });

  /** FRD V5 / C4 / BR-13: `privileged` is requestable only by a client whose ceiling is `privileged`. */
  const checkCeiling = (profile: TrustProfile): void => {
    if (profileRank(profile) > profileRank(maxTrustProfile)) {
      throw new ToolError(
        "PERMISSION_BLOCKED",
        `trust profile ${profile} exceeds this client's maximum ${maxTrustProfile}`,
        { requested: profile, client_max_profile: maxTrustProfile },
      );
    }
  };

  /** FRD V8: provider names must be registered; `require_provider` needs a named provider. */
  const checkRouting = (routing: Routing | undefined): void => {
    if (!routing) return;
    const named = routing.provider_preference;
    if (named !== undefined && !deps.registry.has(named as ProviderId)) {
      throw invalid(`unknown provider ${named}`, { field: "routing.provider_preference" });
    }
    if (routing.require_provider === true && named === undefined) {
      throw invalid("routing.require_provider needs routing.provider_preference", { field: "routing" });
    }
    if (routing.minimum_capability !== undefined) {
      throw new ToolError(
        "ELIGIBILITY_NONE",
        "minimum_capability cannot be evaluated yet (no model registry); omit it",
        { field: "routing.minimum_capability" },
      );
    }
  };

  /** FRD V11 / BR-2 / BR-3: map an exclusion to one taxonomy code with per-provider reasons. */
  const eligibilityError = ({ decision }: EligibilityAnswer): ToolError => {
    const reasons = decision.excluded.map((e) => ({
      provider: e.provider,
      code: e.primary.code,
      detail: e.primary.detail.slice(0, 300),
    }));
    const login = decision.excluded.flatMap((e) => e.reasons).find((r) => r.code === "AUTH_REQUIRED")
      ?.evidence.loginCommand;
    const outcome = decision.outcome;
    if (outcome.kind === "eligible") return new ToolError("TOOL_FAILURE", "eligibility mapping error");
    const message =
      outcome.kind === "required_provider_ineligible" && typeof login === "string"
        ? `${outcome.message}; run \`${login}\` natively`
        : outcome.message;
    return new ToolError(outcome.failureCode, message, {
      eligibility: reasons,
      ...(typeof login === "string" ? { login_command: login } : {}),
    });
  };

  /**
   * Providers a request may be admitted to. For `privileged` (Proposed, T3.3) a provider excluded only by the adapter's
   * compile verdict (PROFILE_UNSUPPORTED, CAPABILITY_MISSING) is admissible: compilation of the scope is deferred to
   * dispatch (T3.5, T3.6), which refuses it until then. Every other exclusion (binary, version, manifest, enablement,
   * platform, auth) still refuses admission.
   */
  const admissible = (answer: EligibilityAnswer, privileged: boolean): ProviderId[] => {
    if (!privileged) return [...answer.decision.eligible];
    const deferred = new Set(
      answer.decision.excluded
        .filter((e) => e.reasons.every((r) => r.code === "PROFILE_UNSUPPORTED" || r.code === "CAPABILITY_MISSING"))
        .map((e) => e.provider),
    );
    const ok = new Set([...answer.decision.eligible, ...deferred]);
    return answer.input.facts.map((f) => f.provider).filter((p) => ok.has(p));
  };

  const selectProvider = (answer: EligibilityAnswer, preference: string | undefined, privileged = false) => {
    const eligible = admissible(answer, privileged);
    const suffix = privileged && !answer.decision.eligible.length ? "; privileged compile deferred to dispatch" : "";
    if (preference !== undefined && eligible.includes(preference as ProviderId)) {
      return { provider: preference as ProviderId, basis: `provider_preference${suffix}` };
    }
    const first = eligible[0];
    if (first === undefined) throw eligibilityError(answer);
    return { provider: first, basis: `configured_order${suffix}` };
  };

  const routeRecord = (answer: EligibilityAnswer, provider: ProviderId, basis: string) => {
    const json = toRouteDecisionJson(answer.input, answer.decision);
    const reasons = { ...(JSON.parse(json.reasons_json) as object), selection: { provider, basis } };
    return { ...json, selected_provider: provider, reasons_json: JSON.stringify(reasons) };
  };

  const waitBounded = async (runId: string, seconds: number | undefined): Promise<void> => {
    if (!seconds) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      lifecycle.waitForTerminal(runId).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, seconds * 1000);
      }),
    ]);
    if (timer) clearTimeout(timer);
  };

  // ---- tools --------------------------------------------------------------------------------------------------

  const delegateTask = async (a: Args): Promise<Envelope> => {
    const routing = a.routing as Routing | undefined;
    const profile = a.trust_profile as TrustProfile;
    const workspace = await lifecycle.canonicalWorkspace(a.workspace_path as string, profile); // V3, V4
    checkCeiling(profile); // V5
    // V13 (after V5): privileged_scope present exactly when the profile is privileged.
    const scopeArg = a.privileged_scope;
    if (profile === "privileged" && scopeArg === undefined) {
      throw invalid("trust_profile privileged requires privileged_scope", { field: "privileged_scope" });
    }
    if (profile !== "privileged" && scopeArg !== undefined) {
      throw invalid(`privileged_scope is allowed only with trust_profile privileged (got ${profile})`, {
        field: "privileged_scope",
      });
    }
    const scope = scopeArg === undefined ? undefined : parsePrivilegedScope(scopeArg);
    if (scope && !scope.ok)
      throw invalid(`invalid privileged_scope: ${scope.field} ${scope.message}`, { field: scope.field });
    if ((a.verification_commands as unknown[]).length > 0) {
      throw invalid("verification_commands are not supported before verification lands (M3)", {
        field: "verification_commands",
      }); // V7
    }
    checkRouting(routing); // V8

    const canonical = {
      tool: "delegate_task",
      objective: a.objective,
      workspace_path: workspace,
      constraints: a.constraints,
      trust_profile: profile,
      verification_commands: a.verification_commands,
      routing: routing ?? {},
      priority: a.priority,
      ...(scope?.ok ? { privileged_scope: scope.scope } : {}),
    };
    const hash = requestHash(canonical);
    const key = a.idempotency_key as string | undefined;
    if (key !== undefined) {
      const prior = lifecycle.findIdempotentRun(deps.clientId, key, hash); // V10
      if (prior) {
        await waitBounded(prior.id, a.wait_seconds as number);
        return envelopeOf(prior.id, { replayed: true });
      }
    }

    const required = routing?.require_provider === true ? (routing.provider_preference as ProviderId) : undefined;
    const privileged = scope?.ok === true;
    const answer = await lifecycle.checkEligibility({
      candidates: candidates(),
      ...(required !== undefined ? { requiredProvider: required } : {}),
      trustProfile: profile,
      clientMaxProfile: maxTrustProfile,
      cwd: workspace,
      ...(scope?.ok ? { profile: eligibilityProfile(scope.scope) } : {}),
    }); // V11
    if (answer.decision.outcome.kind !== "eligible" && admissible(answer, privileged).length === 0) {
      throw eligibilityError(answer);
    }
    if (required !== undefined && !admissible(answer, privileged).includes(required)) throw eligibilityError(answer);
    const { provider, basis } = selectProvider(answer, routing?.provider_preference, privileged);

    const submitted = await lifecycle.submit({
      clientId: deps.clientId,
      objective: a.objective as string,
      workspace,
      trustProfile: profile,
      provider,
      constraints: a.constraints as string[],
      priority: a.priority as RunPriority,
      requestHash: hash,
      routeDecision: routeRecord(answer, provider, basis),
      ...(key !== undefined ? { idempotencyKey: key } : {}),
      ...(scope?.ok ? { privileged: { scope: scope.scope } } : {}),
    });
    await waitBounded(submitted.runId, a.wait_seconds as number);
    return envelopeOf(submitted.runId, submitted.replayed ? { replayed: true } : {});
  };

  const continueTask = async (a: Args): Promise<Envelope> => {
    const sessionId = a.meta_session_id as string;
    const session = ledger.getMetaSession(sessionId);
    const ctx = session ? lifecycle.metaSessionContext(sessionId) : undefined;
    if (!session || !ctx || ctx.clientId !== deps.clientId) throw invalid(`unknown meta-session ${sessionId}`); // C2
    if (session.status !== "ACTIVE") throw invalid(`meta-session ${sessionId} is closed`);
    if (ctx.activeRunId !== undefined) {
      throw invalid(`meta-session ${sessionId} has an active run ${ctx.activeRunId}`, { run_id: ctx.activeRunId });
    }
    const profile = (a.trust_profile as TrustProfile | undefined) ?? ctx.trustProfile; // C4
    const workspace = await lifecycle.canonicalWorkspace(ctx.workspace, profile); // C3
    checkCeiling(profile);
    // C7 (after C4): a privileged continuation runs only under the meta-session's APPROVED approval for this client,
    // with the approved scope as is. The lifecycle re-checks status, ownership and hash in the admission transaction.
    let approval: { id: string; scope: unknown } | undefined;
    if (profile === "privileged") {
      const row = ledger.findApprovalForMetaSession(sessionId, deps.clientId);
      if (row?.status !== "APPROVED") {
        throw invalid(
          `a privileged continuation needs an APPROVED approval for meta-session ${sessionId} (approval is ${
            row?.status ?? "absent"
          }); request a new privileged meta-session with delegate_task`,
          { field: "trust_profile" },
        );
      }
      approval = { id: row.id, scope: JSON.parse(row.scope_json) as unknown };
    }

    const routing = a.routing as Routing | undefined;
    checkRouting(routing); // C5 (as V8)
    const binding = ledger.latestProviderBinding(sessionId);
    const bound = (binding?.provider ?? ctx.provider) as ProviderId;
    if (routing?.provider_preference !== undefined && routing.provider_preference !== bound) {
      throw invalid(`cross-provider continuation (${bound} to ${routing.provider_preference}) is not available yet`, {
        bound_provider: bound,
      });
    }
    if (!binding) throw invalid(`meta-session ${sessionId} has no native session to resume`);

    const approvedScope = approval ? parsePrivilegedScope(approval.scope) : undefined;
    if (approvedScope && !approvedScope.ok) throw invalid(`meta-session ${sessionId} approval holds an invalid scope`);
    const answer = await lifecycle.checkEligibility({
      candidates: [bound],
      requiredProvider: bound,
      trustProfile: profile,
      clientMaxProfile: maxTrustProfile,
      cwd: workspace,
      ...(approvedScope?.ok ? { profile: eligibilityProfile(approvedScope.scope) } : {}),
    });
    if (!admissible(answer, approval !== undefined).includes(bound)) throw eligibilityError(answer); // BR-18 → BR-2/BR-3

    const submitted = await lifecycle.submit({
      clientId: deps.clientId,
      objective: a.instruction as string,
      metaSessionId: sessionId,
      trustProfile: profile,
      provider: bound,
      constraints: [...ctx.constraints],
      priority: ctx.priority,
      resume: { nativeSessionId: binding.native_session_id },
      routeDecision: routeRecord(
        answer,
        bound,
        approval ? "continuation; privileged compile deferred to dispatch" : "continuation",
      ),
      ...(approval ? { privileged: { approvalId: approval.id } } : {}),
    });
    await waitBounded(submitted.runId, a.wait_seconds as number);
    return envelopeOf(submitted.runId);
  };

  const getRun = async (a: Args): Promise<Envelope> => {
    const run = ownRun(a.run_id as string);
    const inc = a.include_events as { after_seq: number; limit: number } | undefined;
    return envelopeOf(run.id, inc ? { events: compactEvents(ledger, run.id, inc.after_seq, inc.limit, scrub) } : {});
  };

  const cancelRun = async (a: Args): Promise<Envelope> => {
    const run = ownRun(a.run_id as string);
    await lifecycle.cancel(run.id, (a.reason as string | undefined) ?? "cancel_run");
    return envelopeOf(run.id);
  };

  const getArtifacts = async (a: Args) => {
    const run = ownRun(a.run_id as string);
    const kinds = new Set<string>((a.kinds as string[] | undefined) ?? MCP_ARTIFACT_KINDS);
    const maxInline = a.max_inline_bytes as number;
    const out = [];
    for (const art of ledger.listArtifactsForRun(run.id)) {
      if (!kinds.has(art.kind)) continue;
      let inline: string | undefined;
      if (art.size_bytes <= maxInline) {
        try {
          inline = (await deps.artifacts.get(art.sha256)).toString("utf8");
        } catch {
          inline = undefined; // missing or failed integrity: report metadata only (fail closed)
        }
      }
      out.push({
        artifact_id: art.id,
        kind: art.kind,
        sha256: art.sha256,
        size_bytes: art.size_bytes,
        ...(inline !== undefined ? { inline_text: inline } : {}),
      });
    }
    return { run_id: run.id, artifacts: out };
  };

  const listCapabilities = async () => {
    const cwd = deps.config.allowedRoots[0] ?? process.cwd();
    const providers = [];
    for (const id of candidates()) {
      const answer = await lifecycle.checkEligibility({
        candidates: [id],
        requiredProvider: id,
        trustProfile: "inspect-untrusted",
        clientMaxProfile: "inspect-untrusted",
        cwd,
      });
      providers.push(describeProvider(answer, id, cwd));
    }
    return {
      schema_version: TOOL_SCHEMA_VERSION,
      schema_dialect: SCHEMA_DIALECT,
      client_max_profile: maxTrustProfile,
      providers,
    };
  };

  const describeProvider = (answer: EligibilityAnswer, id: ProviderId, cwd: string) => {
    const facts = answer.input.facts.find((f) => f.provider === id);
    const adapter = deps.registry.get(id);
    // FRD §6 precedence; compile reasons are per-profile and are reported through supported_profiles instead.
    const status = answer.decision.excluded[0]?.reasons.find(
      (r) => r.code !== "PROFILE_UNSUPPORTED" && r.code !== "CAPABILITY_MISSING",
    );
    const adapterStatus =
      status === undefined
        ? "READY"
        : status.code === "NO_MANIFEST" || status.code === "ADAPTER_VERSION_UNVERIFIED"
          ? status.code
          : status.code === "AUTH_REQUIRED" || status.code === "AUTH_UNKNOWN"
            ? "AUTH_REQUIRED"
            : "DISABLED";
    const probed = facts?.probe?.steps.every((s) => s.ok) === true;
    const supported: TrustProfile[] = [];
    if (adapter && probed) {
      for (const p of TRUST_PROFILE_ORDER) {
        if (p === "privileged") continue; // never grantable through MCP (FR-MCP-06)
        let profile: ResolvedProfile;
        try {
          profile = lifecycle.resolveProfile(p);
        } catch {
          continue; // COMP-POL does not resolve this profile in this version (src/policy): unsupported, fail closed
        }
        const inv = adapter.compile(
          {
            runId: "capability-check",
            objective: "capability check",
            constraints: [],
            workspace: { cwd, writable: p !== "inspect-untrusted" },
          },
          profile,
        );
        if (!isIneligible(inv)) supported.push(p);
      }
    }
    return {
      provider: id,
      adapter_status: adapterStatus,
      ...(status !== undefined ? { status_detail: scrub(`${status.code}: ${status.detail}`).slice(0, 300) } : {}),
      binary_version: facts?.probe?.binaryVersion ?? null,
      validated_range: facts?.gate?.evidence.validatedRange ?? null,
      auth_state: facts?.auth?.state ?? "NOT_CHECKED",
      supported_profiles: supported,
      transports: [...(adapter?.transports ?? [])],
      models: [],
      sandbox_features: [],
      ...(adapter
        ? {
            git_write_control: {
              kind: adapter.gitWriteControl.kind,
              detail: adapter.gitWriteControl.detail,
              remaining_controls: [...adapter.gitWriteControl.remainingControls],
            },
          }
        : {}),
    };
  };

  const handlers: Record<ToolName, (a: Args) => Promise<object>> = {
    delegate_task: delegateTask,
    continue_task: continueTask,
    get_run: getRun,
    cancel_run: cancelRun,
    get_artifacts: getArtifacts,
    list_capabilities: listCapabilities,
  };

  const ok = (value: object): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  });
  const fail = (err: unknown): CallToolResult => {
    const env = errorEnvelope(toToolError(err), scrub);
    return { content: [{ type: "text", text: JSON.stringify(env) }], structuredContent: { ...env }, isError: true };
  };

  const callTool = async (name: string, rawArgs: unknown): Promise<CallToolResult> => {
    try {
      if (!(TOOL_NAMES as readonly string[]).includes(name)) {
        throw invalid(`unknown tool ${JSON.stringify(name.slice(0, 64))}`, { tools: [...TOOL_NAMES] });
      }
      const tool = name as ToolName;
      const args = structuredClone(rawArgs ?? {}) as Args; // defaults are filled in place by Ajv
      const validate = validators[tool];
      if (!validate(args)) throw schemaError(validate.errors ?? []);
      if (tool === "delegate_task" && args.privileged_scope !== undefined) {
        // V1 continued (LLD §3.1): the list-presence rules the JSON Schema cannot express.
        const lists = checkScopeLists(args.privileged_scope as never);
        if (lists) throw invalid(`invalid arguments: ${lists.field} ${lists.message}`, { field: lists.field });
      }
      return ok(await handlers[tool](args));
    } catch (err) {
      return fail(err);
    }
  };

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDescriptors() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(req.params.name, req.params.arguments));

  return {
    server,
    clientId: deps.clientId,
    maxTrustProfile,
    callTool,
    close: () => server.close(),
  };
}

/**
 * Serve MCP over this process's stdin/stdout (FR-MCP-01). stdout carries MCP framing only (TDD §3.3). The caller
 * (`switchboard serve`, T2.6) runs reconciliation and `lifecycle.start()` first and owns shutdown.
 */
export async function startStdioServer(deps: McpServerDeps): Promise<SwitchboardMcpServer> {
  const mcp = createSwitchboardServer(deps);
  await mcp.server.connect(new StdioServerTransport());
  return mcp;
}

/**
 * The snapshot V11 compiles against for a `privileged` request: the scope resolved with placeholder hash and approval
 * ID (the real ones exist only inside the admission transaction). Adapters refuse `privileged` today, which
 * {@link admissible} defers to dispatch; `bypassApproved` is false whatever the scope says.
 */
function eligibilityProfile(scope: PrivilegedScope): ResolvedProfile {
  return resolveTrustProfile("privileged", {
    privileged: {
      scope,
      scopeHash: "0".repeat(64),
      approvalId: "apv_00000000000000000000000000",
    },
  });
}

function compileValidators(): Record<ToolName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
  return Object.fromEntries(TOOL_NAMES.map((n) => [n, ajv.compile(inputSchema(n))])) as Record<
    ToolName,
    ValidateFunction
  >;
}

function schemaError(errors: readonly ErrorObject[]): ToolError {
  const list = errors.slice(0, 10).map((e) => {
    // `$.a.b[0]` notation (as config errors use): JSON pointers would read like filesystem paths.
    let where = e.instancePath
      .split("/")
      .slice(1)
      .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((acc, s) => (/^\d+$/.test(s) ? `${acc}[${s}]` : `${acc}.${s}`), "$");
    if (e.keyword === "required") where += `.${String(e.params.missingProperty)}`;
    if (e.keyword === "additionalProperties") where += `.${String(e.params.additionalProperty)}`;
    return { path: where, message: e.message ?? "invalid" };
  });
  const first = list[0];
  return invalid(`invalid arguments: ${first ? `${first.path} ${first.message}` : "schema validation failed"}`, {
    errors: list,
    ...(first ? { field: first.path } : {}),
  });
}
