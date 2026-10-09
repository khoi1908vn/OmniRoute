---
title: "Antigravity Enterprise Local Preview"
version: 3.8.52
lastUpdated: 2026-10-04
---

# Antigravity Enterprise local preview

The `agy-enterprise` provider uses Google OAuth and a selected US or EU Enterprise license.
It has its own connections; personal `agy` and `antigravity` accounts remain separate.
Its dashboard icon reuses the AGY brand in both color and monochrome modes.

## Connect

Open **Dashboard → Providers → Antigravity Enterprise** and open the Google sign-in
link. After sign-in, Google's hosted Antigravity callback at
`https://antigravity.google/oauth-callback` displays an authorization code. Copy that
code and paste it into OmniRoute, then click **Connect**. This manual code-paste flow
works on localhost, LAN and remote dashboards. If the browser window is blocked,
use the sign-in link in the modal. OmniRoute does not host or automatically receive
the hosted callback. A full callback URL is also accepted when its host, path and
state match this sign-in.

Review the discovered project, location and tier. Click **Save** to validate the
selected configuration and persist the connection. OAuth exchange alone does not
save an account. Locations other than US and EU are visible but disabled.

OmniRoute creates a fresh PKCE challenge for each sign-in and retains the verifier
in an owner-bound server session for 15 minutes. Exchange uses the stored verifier,
callback and issuing client; browser fields cannot override them. The authorization
is consumed once before token exchange. If exchange fails, click **Try again** to
start a fresh sign-in. Codes from another AGY login cannot be exchanged with this
session's verifier. Server restart also requires a new sign-in.

Enterprise uses the public hosted-callback OAuth client verified in AGY CLI 1.2.16,
separate from personal Antigravity. Leave `AGY_ENTERPRISE_OAUTH_CLIENT_ID` and
`AGY_ENTERPRISE_OAUTH_CLIENT_SECRET` unset for the embedded defaults. Set both only
to override the matching client pair; the callback remains fixed. Personal
`ANTIGRAVITY_OAUTH_CLIENT_ID` and `ANTIGRAVITY_OAUTH_CLIENT_SECRET` do not configure
Enterprise. Override clients must support that registered callback and the required
scopes.

Refresh uses the client recorded when the tokens were issued. Legacy Enterprise
connections marked `builtin`, connections without an issuer, and tokens issued by
a client that no longer matches configuration require reauthorization. Restore the
issuing client configuration or sign in again; OmniRoute never refreshes these
tokens with the personal client. Reauthorizing an existing connection retains its
account/project/region identity checks. It preserves saved connection controls and
request settings while replacing verified account/license metadata. An omitted
refresh token retains the existing token.

If discovery fails, retry within the same setup. Pending credentials remain in
server memory for 15 minutes from exchange. Expiry or server restart requires a
new Google sign-in. Closing setup cancels an uncommitted save. A save that has
already committed remains saved.

**Verify project** explicitly requests license assignment for the entered Google
Cloud project and selected region (US by default). Cancelling setup cannot undo an
upstream assignment. Discovery and retry never request assignment. The server rejects
an assignment response for another project or region.

Saved license metadata records `licenseSource` as `discovered` or `custom` from the
server's verification path. Browser fields cannot supply it. Existing connections
without this field remain readable; their historical source is not inferred.

Connections are distinct by Google account, project and region. Reauthorization
cannot replace a connection with another region. Inference uses the saved context;
request payloads cannot override it.

## Local behavior

- **Test Connection** sends `Explicitly reply with '1'` to `gemini-3.5-flash-lite`
  using the saved project, region and tier, with temperature `0` and a maximum of
  `8` output tokens. It consumes a small inference request; it does not discover
  or assign a license. Invalid saved license context is rejected before token
  refresh or any upstream request. Success means HTTP 2xx acceptance, not verification of the
  generated text or later SSE events. The accepted stream is cancelled promptly.
  Tests retain the existing `connection-test` log label and do not report measured
  inference token totals.
- Model refresh uses an authenticated POST with body `{}` to
  `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`.
  Only `groups[0].buckets[]` supplies model IDs and display names. Duplicate IDs are
  collapsed, missing names use the ID, and exhausted buckets remain listed.
- Discovery uses the existing per-connection sync cache. Explicit refresh replaces
  it; a valid empty result clears stale entries. Malformed data or failed requests
  preserve cached models. Automatic discovery respects the connection's auto-fetch
  setting; explicit refresh still works when auto-fetch is disabled. Custom model
  metadata takes precedence and hidden-model filtering remains available.
- `agy-enterprise/gemini-3.5-flash-lite`, the experience visible in the supplied
  screenshots, remains the offline catalog fallback. Custom text experience IDs
  are also accepted (nonblank, at most 200 characters). The selected ID is sent
  unchanged as `aicode.experience`; listing a bucket does not prove entitlement or
  tool, vision or pricing capabilities. Unsupported experiences may fail upstream.
- Chat Completions and Responses support streaming and JSON responses. The upstream
  always uses Gemini SSE on the saved region's Enterprise endpoint.
- US resource RPCs use `https://businessaicode.us.rep.googleapis.com` with
  `/v1beta/projects/{projectId}/locations/us`. EU uses
  `https://businessaicode.eu.rep.googleapis.com` and `/locations/eu` in that resource
  path. Assignment, config and inference share this mapping; no cross-region fallback
  occurs. Automatic license discovery always uses
  `GET https://businessaicode.googleapis.com/v1beta:fetchLicenses` without a body or
  region parameter, and model discovery keeps its fixed Cloud Code endpoint.
- Captured sequential function calls and inline PNG user input are implemented locally
  through Chat Completions, Responses and Anthropic Messages, streamed or buffered.
  The original capture covers the US `gemini-3.8-flash-high` experience. Full Claude Code
  and upstream acceptance remain incomplete; catalog capability flags remain unpromoted.
- Automatic tool selection omits `toolConfig`. Explicit none/required/named choices,
  remote images, other MIME types, structured tool outputs and tool-result media remain
  unverified and return local HTTP 400. Locations other than US/EU are unsupported.
  Request validation errors do not cause connection cooldown or provider-breaker penalties.
- Replay uses bounded server metadata scoped to provider, connection and experience.
  Tool IDs retain their native signatures; signed visible text remains text. Missing
  or conflicting replay metadata returns HTTP 400. Imported history, rewritten signed
  text, connection/model changes and missing persisted metadata require fresh history.
  Do not treat synthetic fixture signatures as live replay credentials.
  Observed unsigned text before a signed tool call is retained only with that exact
  native call turn and dispatched history; it is replayed without inventing a text
  signature. Older turns lacking this record may require regeneration.
  Live parallel-call evidence includes groups with only the first call signed.
  Unsigned siblings retain their native shape only when every call matches the
  recorded group, order and origin history; signatures are never copied between calls.
  Teammate resumes can rebuild hook context. When the current history key misses,
  an immutable native call can recover its unique recorded origin within the same
  connection and experience. Changed names/arguments or ambiguous origins still fail.
  Text alongside such calls must match that original turn. Standalone signed text
  continues to require its exact history key.
  Replay errors include lookup kind, reason, experience, call ID or text length,
  and history fingerprint. Schema errors include field paths and validation codes.
- Buffered Gemini safety blocks preserve `content_filter` in Chat Completions and
  `incomplete` with a filtering reason in Responses. An upstream error takes
  precedence even when it follows a block in a wrapped SSE event.
- OAuth requests Cloud Platform, user-info email/profile, cclog,
  experimentsandconfigs and `openid` scopes using PKCE S256. Enterprise transport
  uses the shared CLI User-Agent helper with `auth_method=gcp`. Its version comes
  from the shared CLI version cache and its platform tokens are pinned to Darwin/ARM64.
  Enterprise calls alone do not refresh that cache; until another caller warms it,
  the helper uses its configured fallback. Acceptance of this fingerprint by live
  Enterprise upstream remains unverified.
- Usage refresh shows Google account quota buckets as advisory observations with
  source and observation time. Their scope for the selected license is unverified.
  A full fraction does not mean unlimited. Observations do not control routing,
  cooldowns, cutoffs or recovery of inference errors. Routing quota preflight does
  not invoke this advisory RPC; explicit dashboard usage refresh remains available.

## Native web search

For `agy-enterprise`, Claude hosted search declarations (`web_search_20250305`,
other dated `web_search` declarations), Claude Code's `WebSearch`, OpenAI
`web_search` / `web_search_preview`, and native `enterpriseWebSearch` declarations
enable Enterprise search. Translation sends `tools: [{ enterpriseWebSearch: {} }]`
on the selected connection's existing Enterprise inference request. Other declared
functions remain available; there is no additional search service or API key.
Existing explicit provider/model search interception settings still take precedence
for hosted search declarations.

For example, the following Messages request is covered by the local transport tests:

```json
{
  "model": "agy-enterprise/gemini-3.5-flash-lite",
  "max_tokens": 1024,
  "stream": true,
  "messages": [{ "role": "user", "content": "Search Wikipedia shutdown rumors" }],
  "tools": [{ "type": "web_search_20250305", "name": "web_search" }]
}
```

Search is selected by the upstream model. As with ordinary Enterprise functions,
explicit required/named/none tool choices remain unsupported. The supplied capture
demonstrates standalone search with `gemini-3.5-flash-lite`; local tests cover mixed
function/search translation through Messages, Chat Completions and Responses in
streamed and buffered modes. Live mixed-tool acceptance is not established by those
tests and can vary with the selected experience.

`blocked_domains` maps to native `excludeDomains`; only ASCII hostnames are accepted,
with at most 2,000 exclusions. Repeated declarations combine exclusions.
Allowlists, `max_uses`, localization, external-web-access restrictions, and search
context-size controls have no implemented native equivalent and return local HTTP
400 rather than being silently discarded. Native options other than `excludeDomains`
are also rejected. Code-execution callers are unsupported; `allowed_callers`, when
provided, must be `["direct"]`. Google's native exclusion field is described in the
[EnterpriseWebSearch reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/Shared.Types/EnterpriseWebSearch).

Responses include search query text and Markdown source links from genuine
`groundingChunks[].web` entries. Query suggestion HTML is never treated as a source
or rendered into these text protocols. A query-only result, like the supplied capture,
does not produce invented source links. This text adaptation does not reproduce
Google's suggestion-chip UI or Anthropic's encrypted search-result blocks.
Search footers are bound to the original response and connection/experience/history
replay scope, so follow-up requests restore native text and signatures without
signing added Markdown. Changed or imported history remains subject to replay checks.

- Ordinary local request/token accounting remains separate from those observations.

Screenshot provenance is recorded in
[`tests/fixtures/agy-enterprise/README.md`](../../tests/fixtures/agy-enterprise/README.md).
Automated protocol tests use synthetic context and sanitized screenshot values;
they do not prove live upstream acceptance or authentic tool/signature replay.

## Verification limits and Global follow-up

Release scope is a **text-only, single-instance US/EU preview**. Pending OAuth/setup
sessions are process-local; multiple instances need shared storage or session
affinity before this flow can be supported. The capture-based local tool, signature
replay and PNG implementation has its own automated checks; live acceptance remains
required before expanding the advertised preview. This preview does not claim
completion of the broader tool-calling PRD.

The 2026-10-04 remediation adds automated regressions for local request classification,
buffered safety/error precedence, advisory quota exclusion, reauthorization settings
and credential preservation, immediate HTTP 410 recovery, and server-owned license
provenance. These are synthetic checks, not evidence of live license entitlement or
upstream fingerprint acceptance. Full production build and repository CI remain
pre-merge requirements.

Request fidelity, US/EU routing, model cache, custom dispatch, icon behavior, manual
OAuth, PKCE ownership and issuer-bound refresh are covered by automated tests.
Live acceptance remains open: successful token exchange, automatic
license discovery for the account reporting HTTP 403, EU assignment/config/inference,
refresh with the same issuer, and another discovered model through both API surfaces.
Offline tests do not establish that the reported 403 is fixed. No new assignment was
made during this follow-up's validation.

**Global TODO:** the operator verified the host `businessaicode.googleapis.com`, but
the resource location and full assignment/config/inference contract still need a
capture. Do not assume a Global resource path or fall back to it automatically.
Global licenses remain visible but unsupported.

## Tool continuation and replay defaults

Enterprise capture retains the original native function-call parts and their
signature locations. When a client adds an absent top-level optional property
equal to its explicitly declared primitive default, the proxy verifies that
equivalence against the issuing request's schema snapshot and returns the
original native arguments. For example, an `Edit` call that omitted
`replace_all` can continue after the client inserts the declared boolean
default `false`. A later schema change cannot authorize a different historical
call. Streaming Claude/OpenAI, buffered SSE, and native JSON capture use the
same replay store (`open-sse/services/geminiThoughtSignatureStore.ts`).

Changed required arguments, non-default values, unexpected properties, removed
explicit arguments, nested defaults, constrained default properties (such as
`enum` or `minimum`), conditional/ref schemas, and malformed schema structures
receive no default-equivalence permission. Exact replay remains available.
Ordered parallel groups retain their captured
signature placement, including unsigned siblings. Interrupted non-terminal
responses grant no new replay permission.

Older hash-only records remain exact-match-only: they do not contain the
issuance schema or original native parts. No migration guesses those values.
Persisted replay records currently expire after 30 days and share a 2,000-record
cap; missing metadata may also reflect eviction. SQLite remains authoritative
for conflicting captures across processes.

Early replay failures are local request errors, correlated in the existing call
logs with the request/session identifiers. Reasons distinguish missing, expired,
invalid, conflicting, ambiguous-origin, argument/group mismatch, unavailable
storage, and unavailable legacy schema evidence. Difference categories contain
no argument values or signature bytes. No-log keys retain normal metadata while
omitting payload artifacts.

For unavailable storage, retry the unchanged request after storage recovers.
For incompatible arguments/groups, restore the original call representation.
If native continuation cannot be recovered, explicitly start a fresh session on
the same connection and experience, carrying a summary of completed tool actions
and results. Inspect the current workspace before repeating any edit or command:
the tool may have succeeded before continuation failed. A plain “Continue”
message does not activate recovery or erase history. A fresh session does not
restore opaque native reasoning state; the proxy never fabricates signatures or
automatically repeats completed actions.

These compatibility paths have synthetic regression coverage. A long real
Claude Code session using inserted defaults still requires live acceptance;
offline tests do not establish upstream Enterprise acceptance.

## Start the isolated local profile

From the implementation worktree, PowerShell:

```powershell
$env:DATA_DIR = Join-Path (Get-Location) '_cache/agy-enterprise-local'
$env:NEXT_DIST_DIR = '.build/agy-enterprise-oauth'
$env:HOST = '127.0.0.1'
$env:PORT = $env:OMNIROUTE_PORT = $env:API_PORT = $env:DASHBOARD_PORT = '20129'
node --max-old-space-size=8192 scripts/dev/run-next.mjs dev
```

Open `http://127.0.0.1:20129/dashboard/providers`. This profile stores its own
connections under `_cache/agy-enterprise-local`. Its dashboard uses the repository's
normal initial-password setup.
