---
title: "Antigravity Enterprise Local Preview"
version: 3.8.52
lastUpdated: 2026-10-02
---

# Antigravity Enterprise local preview

The `agy-enterprise` provider uses Google OAuth and a selected US Enterprise license.
It has its own connections; personal `agy` and `antigravity` accounts remain separate.

## Connect

Open **Dashboard → Providers → Antigravity Enterprise**, sign in with Google, and
review the discovered project, location and tier. Click **Save** to validate the
selected configuration and persist the connection. OAuth exchange alone does not
save an account. Other returned locations are visible but disabled.

If discovery fails, retry within the same setup. Pending credentials remain in
server memory for 15 minutes from exchange. Expiry or server restart requires a
new Google sign-in. Closing setup cancels an uncommitted save. A save that has
already committed remains saved.

**Verify project** explicitly requests US license assignment for the entered Google
Cloud project. Cancelling setup cannot undo an upstream assignment.

## Local behavior

- The available model is `agy-enterprise/gemini-3.5-flash-lite`, the text experience
  visible in the supplied HTTP Toolkit screenshots.
- Chat Completions and Responses support streaming and JSON responses. The upstream
  always uses Gemini SSE on the fixed US regional Enterprise endpoint.
- Tool calls, images, other regions and unverified model experiences are disabled.
- OAuth currently reuses the existing Antigravity CLI Google client and scopes.
  The screenshots did not expose the actual Enterprise OAuth issuer or scopes;
  successful live sign-in and inference are still required to verify compatibility.
- The model list is a local catalog. Live `fetchAvailableModels` synchronization
  awaits a verified request/response and model-to-experience mapping.
- Usage refresh shows Google account quota buckets as advisory observations with
  source and observation time. Their scope for the selected license is unverified.
  A full fraction does not mean unlimited. Observations do not control routing,
  cooldowns, cutoffs or recovery of inference errors.
- Ordinary local request/token accounting remains separate from those observations.

Screenshot provenance is recorded in
[`tests/fixtures/agy-enterprise/README.md`](../../tests/fixtures/agy-enterprise/README.md).
Automated protocol tests use synthetic context and sanitized screenshot values;
they do not prove live upstream acceptance or authentic tool/signature replay.

## Start the isolated local profile

From the implementation worktree, PowerShell:

```powershell
$env:DATA_DIR = Join-Path (Get-Location) '_cache/agy-enterprise-local'
$env:HOST = '127.0.0.1'
$env:PORT = $env:OMNIROUTE_PORT = $env:API_PORT = $env:DASHBOARD_PORT = '20129'
node --max-old-space-size=8192 scripts/dev/run-next.mjs dev
```

Open `http://127.0.0.1:20129/dashboard/providers`. This profile stores its own
connections under `_cache/agy-enterprise-local`. Its dashboard uses the repository's
normal initial-password setup.
