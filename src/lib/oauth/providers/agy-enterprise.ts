import { AGY_CONFIG } from "../constants/oauth";
import { buildAntigravityAuthUrl, exchangeAntigravityToken } from "./antigravity";
import { BUILTIN_ANTIGRAVITY_CLIENT } from "@omniroute/open-sse/services/tokenRefresh/googleClientBinding.ts";
import { z } from "zod";

export const agyEnterprise = {
  config: { ...AGY_CONFIG, userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo" },
  flowType: "authorization_code" as const,
  buildAuthUrl: buildAntigravityAuthUrl,
  exchangeToken: (config: typeof AGY_CONFIG, code: string, redirectUri: string) =>
    exchangeAntigravityToken(config, "cli", code, redirectUri).catch(() => {
      throw new Error("Enterprise token exchange failed. Start Google sign-in again.");
    }),
  mapTokens: (raw: unknown) => {
    const tokens = z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1).optional(),
        expires_in: z.number().positive().finite(),
        scope: z.string().optional(),
      })
      .parse(raw);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      scope: tokens.scope,
      providerSpecificData: {
        clientProfile: "cli",
        oauthClient:
          AGY_CONFIG.clientId === BUILTIN_ANTIGRAVITY_CLIENT.clientId
            ? "builtin"
            : `custom:${AGY_CONFIG.clientId}`,
      },
    };
  },
};
