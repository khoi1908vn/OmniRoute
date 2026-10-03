import type { RegistryEntry } from "../../shared.ts";
import { resolvePublicCred } from "../../shared.ts";

export const agyEnterpriseProvider: RegistryEntry = {
  id: "agy-enterprise",
  alias: "agy-enterprise",
  format: "gemini",
  executor: "agy-enterprise",
  baseUrl: "https://businessaicode.us.rep.googleapis.com",
  authType: "oauth",
  authHeader: "bearer",
  forceStream: true,
  oauth: {
    clientIdEnv: "ANTIGRAVITY_OAUTH_CLIENT_ID",
    clientIdDefault: resolvePublicCred("antigravity_id"),
    clientSecretEnv: "ANTIGRAVITY_OAUTH_CLIENT_SECRET",
    clientSecretDefault: resolvePublicCred("antigravity_alt"),
  },
  models: [
    {
      id: "gemini-3.5-flash-lite",
      name: "Gemini 3.5 Flash Lite",
      targetFormat: "gemini",
      toolCalling: false,
      supportsVision: false,
    },
  ],
  passthroughModels: true,
};
