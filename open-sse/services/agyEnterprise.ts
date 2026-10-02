import { z } from "zod";
import {
  enterpriseContextSchema,
  enterpriseLicenseSchema,
  type EnterpriseContext,
} from "@omniroute/open-sse/utils/agyEnterprise.ts";
import { antigravityCliUserAgent } from "./antigravityHeaders.ts";

export const ENTERPRISE_US_HOST = "https://businessaicode.us.rep.googleapis.com";
export function enterpriseResource(context: EnterpriseContext): string {
  const checked = enterpriseContextSchema.parse(context);
  return `${ENTERPRISE_US_HOST}/v1beta/projects/${encodeURIComponent(checked.projectId)}/locations/us`;
}
export function enterpriseHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": antigravityCliUserAgent(undefined, "gcp"),
  };
}
export async function enterpriseFetchJson(
  url: string,
  accessToken: string,
  init: RequestInit = {}
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: enterpriseHeaders(accessToken),
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw Object.assign(new Error(`Enterprise request failed (HTTP ${response.status})`), {
      status: response.status,
    });
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
  signal?: AbortSignal
) {
  const resource = enterpriseResource({ projectId, location: "us", userTier: "pending" });
  return z.object({ license: enterpriseLicenseSchema }).parse(
    await enterpriseFetchJson(`${resource}:selfAssignLicense`, accessToken, {
      method: "POST",
      body: JSON.stringify({ parent: `projects/${projectId}/locations/us` }),
      signal,
    })
  ).license;
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
