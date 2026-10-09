import { z } from "zod";
import { sanitizeErrorMessage, sanitizeUpstreamDetails } from "../utils/error.ts";
import {
  agyEnterpriseContextSchema,
  agyEnterpriseLicenseSchema,
  agyEnterpriseQuotaObservationsSchema,
  type AgyEnterpriseContext,
  type AgyEnterpriseLocation,
} from "@omniroute/open-sse/utils/agyEnterprise.ts";
import { antigravityCliUserAgent } from "./antigravityHeaders.ts";

const agyEnterpriseQuotaSummarySchema = z.object({
  groups: z
    .array(
      z.object({
        buckets: z
          .array(
            agyEnterpriseQuotaObservationsSchema.shape.buckets.element.extend({
              bucketId: z.string().min(1).max(200).regex(/\S/),
            })
          )
          .max(200),
      })
    )
    .max(100),
});
type AgyEnterpriseQuotaSummary = z.infer<typeof agyEnterpriseQuotaSummarySchema>;

export async function fetchAgyEnterpriseQuotaSummary(
  accessToken: string,
  signal?: AbortSignal
): Promise<AgyEnterpriseQuotaSummary> {
  return agyEnterpriseQuotaSummarySchema.parse(
    await agyEnterpriseFetchJson(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      accessToken,
      { method: "POST", body: "{}", signal }
    )
  );
}

export async function fetchAgyEnterpriseModels(
  accessToken: string,
  signal?: AbortSignal
): Promise<Array<{ id: string; name: string; apiFormat: "gemini"; supportsTools: false }>> {
  const summary = await fetchAgyEnterpriseQuotaSummary(accessToken, signal);
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

const AGY_ENTERPRISE_HOSTS: Record<AgyEnterpriseLocation, string> = {
  us: "https://businessaicode.us.rep.googleapis.com",
  eu: "https://businessaicode.eu.rep.googleapis.com",
};
export function agyEnterpriseResource(context: AgyEnterpriseContext): string {
  const checked = agyEnterpriseContextSchema.parse(context);
  return `${AGY_ENTERPRISE_HOSTS[checked.location]}/v1beta/projects/${encodeURIComponent(checked.projectId)}/locations/${checked.location}`;
}
export function agyEnterpriseHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    // Shared CLI version cache and platform fingerprint with the Enterprise auth method.
    "User-Agent": antigravityCliUserAgent(undefined, "gcp"),
  };
}
export async function agyEnterpriseFetchJson(
  url: string,
  accessToken: string,
  init: RequestInit = {}
): Promise<unknown> {
  const startedAt = Date.now();
  const response = await fetch(url, {
    ...init,
    headers: agyEnterpriseHeaders(accessToken),
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
export async function fetchAgyEnterpriseLicenses(accessToken: string, signal?: AbortSignal) {
  return z
    .object({ licenses: z.array(agyEnterpriseLicenseSchema).default([]) })
    .parse(
      await agyEnterpriseFetchJson(
        "https://businessaicode.googleapis.com/v1beta:fetchLicenses",
        accessToken,
        { signal }
      )
    ).licenses;
}
export async function assignAgyEnterpriseLicense(
  accessToken: string,
  projectId: string,
  location: AgyEnterpriseLocation,
  signal?: AbortSignal
) {
  const resource = agyEnterpriseResource({ projectId, location, userTier: "pending" });
  const license = z.object({ license: agyEnterpriseLicenseSchema }).parse(
    await agyEnterpriseFetchJson(`${resource}:selfAssignLicense`, accessToken, {
      method: "POST",
      body: JSON.stringify({ parent: `projects/${projectId}/locations/${location}` }),
      signal,
    })
  ).license;
  if (license.projectId !== projectId || license.location !== location)
    throw new Error("Enterprise assignment returned a different project/location context");
  return license;
}
export async function fetchAgyEnterpriseConfig(
  accessToken: string,
  context: AgyEnterpriseContext,
  signal?: AbortSignal
) {
  return z
    .object({ adminControls: z.record(z.string(), z.unknown()) })
    .passthrough()
    .parse(
      await agyEnterpriseFetchJson(
        `${agyEnterpriseResource(context)}:fetchConfig?entitlement.userTier=${encodeURIComponent(context.userTier)}`,
        accessToken,
        { signal }
      )
    );
}
