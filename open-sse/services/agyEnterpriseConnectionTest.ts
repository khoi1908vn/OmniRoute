import { AgyEnterpriseExecutor } from "../executors/agyEnterprise.ts";
import type { ProviderCredentials } from "../executors/base.ts";
import { agyEnterpriseContextSchema } from "../utils/agyEnterprise.ts";

export function buildAgyEnterpriseProbe(
  connection: { providerSpecificData?: unknown },
  accessToken: string
): { url: string; method: string; headers: Record<string, string>; body: string } {
  const credentials: ProviderCredentials = {
    accessToken,
    providerSpecificData: agyEnterpriseContextSchema.parse(connection.providerSpecificData),
  };
  const executor = new AgyEnterpriseExecutor();
  const model = "gemini-3.5-flash-lite";
  return {
    url: executor.buildUrl(model, true, 0, credentials),
    method: "POST",
    headers: executor.buildHeaders(credentials),
    body: JSON.stringify(
      executor.transformRequest(
        model,
        {
          contents: [{ role: "user", parts: [{ text: "Explicitly reply with '1'" }] }],
          generationConfig: { maxOutputTokens: 8, temperature: 0 },
        },
        true,
        credentials
      )
    ),
  };
}
