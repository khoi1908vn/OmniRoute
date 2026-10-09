import {
  agyEnterpriseContextSchema,
  agyEnterpriseQuotaObservationsSchema,
} from "../../utils/agyEnterprise.ts";
import { fetchAgyEnterpriseQuotaSummary } from "../agyEnterprise.ts";

export async function getAgyEnterpriseUsage(accessToken: string | undefined, context: unknown) {
  try {
    agyEnterpriseContextSchema.parse(context);
    if (!accessToken) throw new Error("Missing token");
    const data = await fetchAgyEnterpriseQuotaSummary(accessToken);
    return {
      quotas: null,
      quotaObservations: agyEnterpriseQuotaObservationsSchema.parse({
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
