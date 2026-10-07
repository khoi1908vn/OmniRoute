import { z } from "zod";

export const agyEnterpriseProjectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/);
export const agyEnterpriseLicenseSchema = z.object({
  projectId: agyEnterpriseProjectSchema,
  location: z.string().min(1).max(64),
  userTier: z.string().min(1).max(200),
  tierDisplayName: z.string().max(200).optional(),
});
export const agyEnterpriseLocationSchema = z.enum(["us", "eu"]);
export type AgyEnterpriseLocation = z.infer<typeof agyEnterpriseLocationSchema>;
export const agyEnterpriseContextSchema = agyEnterpriseLicenseSchema.extend({
  location: agyEnterpriseLocationSchema,
});
export type AgyEnterpriseContext = z.infer<typeof agyEnterpriseContextSchema>;
export type AgyEnterpriseLicense = z.infer<typeof agyEnterpriseLicenseSchema>;

export const agyEnterpriseQuotaObservationsSchema = z.object({
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
export type AgyEnterpriseQuotaObservations = z.infer<typeof agyEnterpriseQuotaObservationsSchema>;

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

export function sameAgyEnterpriseIdentity(a: IdentityConnection, b: IdentityConnection): boolean {
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
export function agyEnterpriseIdentitySnapshot(connection: IdentityConnection): string {
  const data = metadata(connection);
  return JSON.stringify([
    connection.provider,
    connection.authType,
    data.googleSubject || normalized(connection.email),
    data.projectId,
    data.location,
  ]);
}
