import { z } from "zod";
import {
  enterpriseContextSchema,
  enterpriseLicenseSchema,
  type EnterpriseContext,
  type EnterpriseLocation,
} from "@omniroute/open-sse/utils/agyEnterprise.ts";

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
