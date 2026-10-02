import { z } from "zod";
import {
  enterpriseContextSchema,
  enterpriseQuotaObservationsSchema,
} from "../../utils/agyEnterprise.ts";
import { enterpriseFetchJson } from "../agyEnterprise.ts";

const summarySchema = z.object({
  groups: z
    .array(
      z.object({
        buckets: z
          .array(
            z.object({
              bucketId: z.string().min(1).max(200),
              displayName: z.string().max(200).optional(),
              remainingFraction: z.number().min(0).max(1).optional(),
            })
          )
          .max(200),
      })
    )
    .max(100),
});

export async function getEnterpriseUsage(accessToken: string | undefined, context: unknown) {
  try {
    enterpriseContextSchema.parse(context);
    if (!accessToken) throw new Error("Missing token");
    const data = summarySchema.parse(
      await enterpriseFetchJson(
        "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
        accessToken,
        { method: "POST", body: "{}" }
      )
    );
    return {
      quotas: null,
      quotaObservations: enterpriseQuotaObservationsSchema.parse({
        source: "cloudcode-pa:retrieveUserQuotaSummary",
        observedAt: new Date().toISOString(),
        authority: "advisory",
        buckets: data.groups.flatMap((group) => group.buckets),
      }),
    };
  } catch {
    // An observation failure says nothing about inference permission or account health.
    return { quotas: null, message: "Enterprise quota observations unavailable. Retry later." };
  }
}
