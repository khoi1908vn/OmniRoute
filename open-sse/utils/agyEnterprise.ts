import { z } from "zod";

export const enterpriseProjectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/);
export const enterpriseLicenseSchema = z.object({
  projectId: enterpriseProjectSchema,
  location: z.string().min(1).max(64),
  userTier: z.string().min(1).max(200),
  tierDisplayName: z.string().max(200).optional(),
});
export const enterpriseContextSchema = enterpriseLicenseSchema.extend({
  location: z.literal("us"),
});
export type EnterpriseContext = z.infer<typeof enterpriseContextSchema>;
export type EnterpriseLicense = z.infer<typeof enterpriseLicenseSchema>;

export const enterpriseQuotaObservationsSchema = z.object({
  source: z.literal("cloudcode-pa:retrieveUserQuotaSummary"),
  observedAt: z.string().datetime(),
  authority: z.literal("advisory"),
  buckets: z
    .array(
      z.object({
        bucketId: z.string().min(1).max(200),
        displayName: z.string().max(200).optional(),
        remainingFraction: z.number().min(0).max(1).optional(),
      })
    )
    .max(200),
});
export type EnterpriseQuotaObservations = z.infer<typeof enterpriseQuotaObservationsSchema>;

type IdentityConnection = {
  provider?: unknown;
  authType?: unknown;
  email?: unknown;
  providerSpecificData?: unknown;
};

function metadata(connection: IdentityConnection): Record<string, unknown> {
  const data = connection.providerSpecificData;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function sameEnterpriseIdentity(a: IdentityConnection, b: IdentityConnection): boolean {
  const left = metadata(a);
  const right = metadata(b);
  if (
    !left.projectId ||
    !left.location ||
    left.projectId !== right.projectId ||
    left.location !== right.location
  )
    return false;
  if (left.googleSubject && right.googleSubject) return left.googleSubject === right.googleSubject;
  return !!normalized(a.email) && normalized(a.email) === normalized(b.email);
}

/** Snapshot used to detect a changed reauthorization target inside the write transaction. */
export function enterpriseIdentitySnapshot(connection: IdentityConnection): string {
  const data = metadata(connection);
  return JSON.stringify([
    connection.provider,
    connection.authType,
    data.googleSubject || normalized(connection.email),
    data.projectId,
    data.location,
  ]);
}
