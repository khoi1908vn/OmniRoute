import { z } from "zod";
import { sanitizeErrorMessage, sanitizeUpstreamDetails } from "../utils/error.ts";
import {
  enterpriseContextSchema,
  enterpriseLicenseSchema,
  enterpriseQuotaObservationsSchema,
  type EnterpriseContext,
  type EnterpriseLocation,
} from "@omniroute/open-sse/utils/agyEnterprise.ts";

export const enterpriseQuotaSummarySchema = z.object({
  groups: z
    .array(
      z.object({
        buckets: z
          .array(
            enterpriseQuotaObservationsSchema.shape.buckets.element.extend({
              bucketId: z.string().min(1).max(200).regex(/\S/),
            })
          )
          .max(200),
      })
    )
    .max(100),
});
export type EnterpriseQuotaSummary = z.infer<typeof enterpriseQuotaSummarySchema>;

export async function fetchEnterpriseQuotaSummary(
  accessToken: string,
  signal?: AbortSignal
): Promise<EnterpriseQuotaSummary> {
  return enterpriseQuotaSummarySchema.parse(
    await enterpriseFetchJson(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      accessToken,
      { method: "POST", body: "{}", signal }
    )
  );
}

export async function fetchEnterpriseModels(
  accessToken: string,
  signal?: AbortSignal
): Promise<Array<{ id: string; name: string; apiFormat: "gemini"; supportsTools: false }>> {
  const summary = await fetchEnterpriseQuotaSummary(accessToken, signal);
  const seen = new Set<string>();
  return (summary.groups[0]?.buckets || []).flatMap((bucket) => {
    if (seen.has(bucket.bucketId)) return [];
    seen.add(bucket.bucketId);
    return [
      {
        id: bucket.bucketId,
        name: bucket.displayName?.trim() || bucket.bucketId,
        apiFormat: "gemini" as const,
        supportsTools: false as const,
      },
    ];
  });
}

export const ENTERPRISE_US_HOST = "https://businessaicode.us.rep.googleapis.com";
const ENTERPRISE_HOSTS: Record<EnterpriseLocation, string> = {
  us: ENTERPRISE_US_HOST,
  eu: "https://businessaicode.eu.rep.googleapis.com",
};
export function enterpriseResource(context: EnterpriseContext): string {
  const checked = enterpriseContextSchema.parse(context);
  return `${ENTERPRISE_HOSTS[checked.location]}/v1beta/projects/${encodeURIComponent(checked.projectId)}/locations/${checked.location}`;
}
export function enterpriseHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    // Captured Enterprise CLI identity; independent of personal Antigravity defaults.
    "User-Agent":
      "antigravity/cli/1.2.14 (aidev_client; os_type=windows; arch=amd64; cl=990662481; auth_method=gcp)",
  };
}
export async function enterpriseFetchJson(
  url: string,
  accessToken: string,
  init: RequestInit = {}
): Promise<unknown> {
  const startedAt = Date.now();
  const response = await fetch(url, {
    ...init,
    headers: enterpriseHeaders(accessToken),
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    let upstream: unknown;
    try {
      // Remove even opaque echoed access tokens before parsing or logging upstream data.
      const text = (await response.text()).split(accessToken).join("[REDACTED]");
      try {
        const parsed: unknown = JSON.parse(text);
        upstream =
          parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : parsed;
      } catch {
        upstream = text || "[empty response body]";
      }
    } catch (error) {
      upstream = `Unable to read upstream error body: ${sanitizeErrorMessage(error)}`;
    }
    const diagnostics = {
      method: init.method || "GET",
      url: sanitizeErrorMessage(url),
      status: response.status,
      statusText: sanitizeErrorMessage(response.statusText),
      elapsedMs: Date.now() - startedAt,
      responseHeaders: Object.fromEntries(
        ["content-type", "retry-after", "x-request-id", "x-goog-request-id"]
          .filter((name) => response.headers.has(name))
          .map((name) => [name, sanitizeErrorMessage(response.headers.get(name))])
      ),
      upstream: sanitizeUpstreamDetails(upstream),
    };
    const message = sanitizeErrorMessage(
      `Enterprise request failed (HTTP ${response.status}): ${JSON.stringify(diagnostics)}`
    );
    console.error("[agy-enterprise] Upstream request failed", JSON.stringify(diagnostics, null, 2));
    throw Object.assign(new Error(message), {
      status: response.status,
      diagnostics,
    });
  }
  return response.json();
}
export async function fetchEnterpriseLicenses(accessToken: string, signal?: AbortSignal) {
  return z
    .object({ licenses: z.array(enterpriseLicenseSchema).default([]) })
    .parse(
      await enterpriseFetchJson(
        "https://businessaicode.googleapis.com/v1beta:fetchLicenses",
        accessToken,
        { signal }
      )
    ).licenses;
}
export async function assignEnterpriseLicense(
  accessToken: string,
  projectId: string,
  location: EnterpriseLocation,
  signal?: AbortSignal
) {
  const resource = enterpriseResource({ projectId, location, userTier: "pending" });
  const license = z.object({ license: enterpriseLicenseSchema }).parse(
    await enterpriseFetchJson(`${resource}:selfAssignLicense`, accessToken, {
      method: "POST",
      body: JSON.stringify({ parent: `projects/${projectId}/locations/${location}` }),
      signal,
    })
  ).license;
  if (license.projectId !== projectId || license.location !== location)
    throw new Error("Enterprise assignment returned a different project/location context");
  return license;
}
export async function fetchEnterpriseConfig(
  accessToken: string,
  context: EnterpriseContext,
  signal?: AbortSignal
) {
  return z
    .object({ adminControls: z.record(z.string(), z.unknown()) })
    .passthrough()
    .parse(
      await enterpriseFetchJson(
        `${enterpriseResource(context)}:fetchConfig?entitlement.userTier=${encodeURIComponent(context.userTier)}`,
        accessToken,
        { signal }
      )
    );
}
