---
title: "Antigravity Enterprise Local Preview"
version: 3.8.52
lastUpdated: 2026-10-03
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
account/project/region identity checks.

If discovery fails, retry within the same setup. Pending credentials remain in
server memory for 15 minutes from exchange. Expiry or server restart requires a
new Google sign-in. Closing setup cancels an uncommitted save. A save that has
already committed remains saved.

**Verify project** explicitly requests license assignment for the entered Google
Cloud project and selected region (US by default). Cancelling setup cannot undo an
upstream assignment. Discovery and retry never request assignment. The server rejects
an assignment response for another project or region.

Connections are distinct by Google account, project and region. Reauthorization
cannot replace a connection with another region. Inference uses the saved context;
request payloads cannot override it.

## Local behavior

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
- Tool calls, images and locations other than US/EU are unsupported.
- OAuth requests Cloud Platform, user-info email/profile, cclog,
  experimentsandconfigs and `openid` scopes using PKCE S256. Enterprise transport
  uses the captured CLI fingerprint independently of the personal provider's defaults.
- Usage refresh shows Google account quota buckets as advisory observations with
  source and observation time. Their scope for the selected license is unverified.
  A full fraction does not mean unlimited. Observations do not control routing,
  cooldowns, cutoffs or recovery of inference errors.
- Ordinary local request/token accounting remains separate from those observations.

Screenshot provenance is recorded in
[`tests/fixtures/agy-enterprise/README.md`](../../tests/fixtures/agy-enterprise/README.md).
Automated protocol tests use synthetic context and sanitized screenshot values;
they do not prove live upstream acceptance or authentic tool/signature replay.

## Verification limits and Global follow-up

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
