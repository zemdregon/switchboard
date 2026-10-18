/**
 * T7.14 fix (FR-RTE-10, FR-MCP-04, LLD §3 envelope, LLD §17.7 Run fields; follow-up from the
 * 20261017T220033Z MCP report, note 2): run envelopes report the requested model that ran.
 *
 * `provider.model` is the requested/resolved model recorded at admission (`run.model`, from
 * `request_json.model`); it is null only when no model was requested, so the adapter default
 * applies. Through the SDK client on the fake adapter, so every result is checked against the
 * published output schemas. Nothing live.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";

let h: Harness;
beforeEach(async () => {
  // No model registry: providers are unrestricted, as on the MCP dev server in the report, so the
  // requested model passes through and the adapter's compile decides.
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe("envelope provider.model reports the requested model (T7.14 fix)", () => {
  it("get_run, list_runs and explain_route report routing.model fake-model-1 on required fake; null when none was requested", async () => {
    const withModel = await h.ok("delegate_task", {
      objective: "ok",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
      routing: { model: "fake-model-1", provider_preference: "fake", require_provider: true },
    });
    await h.lifecycle.waitForTerminal(withModel.run_id);

    const got = await h.ok("get_run", { run_id: withModel.run_id });
    expect(got.status).toBe("SUCCEEDED");
    expect(got.provider).toMatchObject({ adapter: "fake", model: "fake-model-1" });

    const listed = await h.ok("list_runs", {});
    const row = (listed.runs as Json[]).find((r) => r.run_id === withModel.run_id);
    expect(row?.provider).toMatchObject({ adapter: "fake", model: "fake-model-1" });

    const explained = await h.ok("explain_route", { run_id: withModel.run_id });
    expect(explained.selected_provider).toBe("fake");
    expect((explained.deciding_factors as string[]).join("\n")).toContain("requested model fake-model-1");

    const plain = await h.ok("delegate_task", {
      objective: "ok",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
    });
    await h.lifecycle.waitForTerminal(plain.run_id);
    const gotPlain = await h.ok("get_run", { run_id: plain.run_id });
    expect(gotPlain.status).toBe("SUCCEEDED");
    expect(gotPlain.provider.model).toBeNull();
  });
});
