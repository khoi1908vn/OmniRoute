# Enterprise evidence fixtures

Source: the operator's `agy-enterprise-http-traces.md`, compiled 2026-10-02 from
HTTP Toolkit screenshots dated 2026-10-01. These are transcriptions, not raw captures.
Project identifiers and private system prompts are replaced consistently. Opaque
signature/response bytes remain explicitly unknown; these placeholders must never
be replayed upstream or presented as genuine signatures.

`terminal.json` retains the signature-only completion event used by the parser
and executor regression tests. The main response's modelVersion and quota bucket
IDs do not establish experience mappings. Sanitized raw protocol fixtures live in
`captured-protocol/`.
