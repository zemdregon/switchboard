# ADR-0003: The controller never handles provider credentials

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12), codifying the stated intent in the original blueprint
- Related: FR-AUTH-01–02, FR-POL-06–07, NFR-SEC-01, NFR-COMP-01

## Context

The original blueprint states the controller "must completely avoid interacting with OAuth flows or other subscription
login interfaces, relying exclusively on the cached host credentials managed by the native CLIs." The [verified
research](../research/headless-ai-coding-controller-verified-2026-10-12.md#compliance-and-authentication-boundary)
confirms this is feasible (Claude `auth status`, Codex saved auth, Antigravity fails fast when unauthenticated, Grok ACP
uses cached tokens) and adds two corrections: documented automation support is not a blanket contractual grant for every
use, and placing credentials and an autonomous agent under the same OS user is not a secret boundary.

## Decision

- The controller never initiates login, submits OAuth, reads or copies tokens, scrapes dashboards, reimplements provider
  protocols, patches CLIs or moves credentials.
- Auth state comes only from the provider's own status command or a harmless headless call; failure yields
  `AUTH_REQUIRED` and the operator logs in natively.
- Each provider has a versioned compliance manifest; without one, the adapter is ineligible.
- For untrusted profiles, arbitrary shell is disabled on adapters that cannot confine agent commands away from the
  credential store.
- Switchboard documentation describes "documented automation surfaces", never "ToS compliant".

## Alternatives considered

- **API-key mode for every provider.** Not chosen as the default: the stated intent is to use existing subscriptions.
  API-key modes may be added per provider later behind the same manifest.
- **Controller-managed credential vault.** Rejected: it is exactly the credential handling the intent forbids.

## Consequences

- Operators must log in to each CLI themselves, and re-login when sessions expire.
- Some providers may be unusable under untrusted profiles until their sandboxing is verified.

## Revisit when

A provider offers a documented, scoped delegation credential intended for third-party automation.
