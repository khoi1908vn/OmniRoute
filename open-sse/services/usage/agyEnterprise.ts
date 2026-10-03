import {
  enterpriseContextSchema,
  enterpriseQuotaObservationsSchema,
} from "../../utils/agyEnterprise.ts";
import { fetchEnterpriseQuotaSummary } from "../agyEnterprise.ts";

export async function getEnterpriseUsage(accessToken: string | undefined, context: unknown) {
  try {
    enterpriseContextSchema.parse(context);
    if (!accessToken) throw new Error("Missing token");
    const data = await fetchEnterpriseQuotaSummary(accessToken);
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
