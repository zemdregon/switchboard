/** Compliance manifest JSON Schema (LLD §6, FR-POL-07). LLD §6 owns the fields; this mirrors it exactly. */

export interface ComplianceManifest {
  schema_version: 1;
  provider: string;
  validated_cli_version: string;
  validated_version_range: string;
  validated_on: string;
  auth_modes_allowed: "native_cached_subscription"[];
  automation_surface: ("documented_headless" | "documented_acp" | "documented_service")[];
  credential_export_allowed: false;
  dashboard_scraping_allowed: false;
  network_protocol_reverse_engineering: false;
  commercial_multi_user_status: "requires-review" | "reviewed-permitted" | "reviewed-prohibited";
  source_revision: string;
  notes?: string;
}

/**
 * LLD §6 gives `validated_on` as `format: date`. Ajv core has no `date` format without ajv-formats (not a
 * dependency), so the schema uses an equivalent pattern and `load.ts` additionally checks the calendar date.
 */
export const manifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "provider",
    "validated_cli_version",
    "validated_version_range",
    "validated_on",
    "auth_modes_allowed",
    "automation_surface",
    "credential_export_allowed",
    "dashboard_scraping_allowed",
    "network_protocol_reverse_engineering",
    "commercial_multi_user_status",
    "source_revision",
  ],
  properties: {
    schema_version: { const: 1 },
    provider: { type: "string" },
    validated_cli_version: { type: "string" },
    validated_version_range: { type: "string" },
    validated_on: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    auth_modes_allowed: { type: "array", items: { enum: ["native_cached_subscription"] } },
    automation_surface: {
      type: "array",
      items: { enum: ["documented_headless", "documented_acp", "documented_service"] },
    },
    credential_export_allowed: { const: false },
    dashboard_scraping_allowed: { const: false },
    network_protocol_reverse_engineering: { const: false },
    commercial_multi_user_status: { enum: ["requires-review", "reviewed-permitted", "reviewed-prohibited"] },
    source_revision: { type: "string" },
    notes: { type: "string" },
  },
} as const;
