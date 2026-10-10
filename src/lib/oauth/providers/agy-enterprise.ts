import { z } from "zod";
import { sanitizeErrorMessage, sanitizeUpstreamDetails } from "@omniroute/open-sse/utils/error.ts";
import { AGY_ENTERPRISE_CONFIG } from "../constants/oauth";
import { buildAntigravityAuthUrl } from "./antigravity";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().finite(),
  scope: z.string().optional(),
});

export const agyEnterprise = {
  config: AGY_ENTERPRISE_CONFIG,
  flowType: "authorization_code_pkce" as const,
  buildAuthUrl: buildAntigravityAuthUrl,
  exchangeToken: async (
    config: typeof AGY_ENTERPRISE_CONFIG,
    code: string,
    redirectUri: string,
    codeVerifier: string
  ): Promise<unknown> => {
    if (!codeVerifier)
      throw new Error("Enterprise PKCE verifier is missing. Start Google sign-in again.");
    const redact = (value: string) =>
      [code, codeVerifier, config.clientSecret]
        .filter(Boolean)
        .reduce((text, credential) => text.split(credential).join("[REDACTED]"), value);
    try {
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const raw = redact(await response.text());
        let upstream: unknown = raw || "[empty response body]";
        try {
          upstream = JSON.parse(raw);
        } catch {
          /* Preserve non-JSON upstream diagnostics. */
        }
        throw new Error(
          `HTTP ${response.status}: ${JSON.stringify(sanitizeUpstreamDetails(upstream))}`
        );
      }
      return await response.json();
    } catch (error) {
      throw new Error(
        sanitizeErrorMessage(
          `Enterprise token exchange failed: ${redact(error instanceof Error ? error.message : "Unknown upstream error")}. Start Google sign-in again.`
        )
      );
    }
  },
  mapTokens: (raw: unknown) => {
    const tokens = tokenSchema.parse(raw);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      scope: tokens.scope,
      providerSpecificData: {
        clientProfile: "cli",
        oauthClient: `custom:${AGY_ENTERPRISE_CONFIG.clientId}`,
      },
    };
  },
};
