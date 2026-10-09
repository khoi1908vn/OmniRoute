import type { getAccessToken } from "@omniroute/open-sse/services/tokenRefresh.ts";

import { makeDiagnosis } from "./codexAppServerHealth";

export async function acceptedOAuthProbeResult(
  response: Response,
  refreshed: boolean,
  newTokens: Awaited<ReturnType<typeof getAccessToken>> | null
) {
  // The HTTP result is final; cancellation is best-effort cleanup of unread SSE bodies.
  await response.body?.cancel().catch(() => {});
  return {
    valid: true,
    error: null,
    refreshed,
    newTokens,
    diagnosis: makeDiagnosis("ok", "upstream", null, null),
  };
}
