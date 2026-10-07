# Sanitized Enterprise capture evidence

Source: the local `.build/all.fixed.har`, exported by mitmproxy 12.2.3. No original `.mitm` file was found in the workspace. HAR indices are zero-based; six selected transactions are all the Business AI Code inference transactions in this 47-entry export.

| Flow | Scenario                                                           | SSE events |
| ---- | ------------------------------------------------------------------ | ---------: |
| 23   | Ordinary text probe, `gemini-3.5-flash-lite`                       |          2 |
| 25   | Ordinary text with 13 tool declarations, `gemini-3.8-flash-high`   |          4 |
| 33   | First explicit native `run_command` call                           |          3 |
| 35   | First result containing an error, followed by a second native call |          3 |
| 38   | Second result, then final visible text                             |          2 |
| 43   | Inline PNG input, reasoning and visible text                       |         24 |

Each flow has `.http.json` metadata, `.request.json`, and `.response.sse`. Request JSON string tokens and response JSON string tokens are substituted without rebuilding the bodies: key order, whitespace and SSE framing are retained. Headers are exported separately with secret values replaced. Bodies retain numeric values, booleans, schema structure, protocol enums, models, tool names and argument field names. All nonempty user/model/system text, descriptions, string arguments, result text, IDs and live signatures are replaced consistently. Empty strings remain empty. The private image is replaced with a synthetic 1×1 PNG; original dimensions and byte counts are recorded in `manifest.json`.

`SYNTHETIC_SIGNATURE_*` values are placeholders, deliberately unusable upstream. Repeated placeholders establish exact equality relationships found in the capture. They do not prove cryptographic validity or whether replay without signatures would succeed. `SANITIZED_OUTPUT_*` substitutes the complete result string; the original first result contained an error, but its private text is not retained. No opaque signature digest is exported.

`translator-probe.json` is generated from these sanitized fixtures against the current dirty worktree. It is diagnostic output, not captured traffic or proof of upstream acceptance. The probe uses an isolated database containing only synthetic signatures. `manifest.json` records capture provenance, selected-flow measurements and redaction locations; original token counts describe the source traffic, not the replacement text/image.

Reproduce from the worktree root:

```powershell
node scripts/ad-hoc/inspect-agy-enterprise-capture.mjs
node --import tsx/esm scripts/ad-hoc/probe-agy-enterprise-translators.mjs
node --import tsx/esm --test tests/unit/agy-enterprise-captured-evidence.test.ts
```

The extractor performs offline parsing only, verifies removal of private replaced strings and captured credential/PII values, and never replays HTTP or changes the capture. Do not stage the source HAR, probe database, credentials or unsanitized traffic. These fixtures preserve structure, not the original private payload bytes.
