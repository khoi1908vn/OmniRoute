import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { generateAuthData, exchangeTokens, resolveBrowserOAuthRedirectUri } from "./providers";
import { enterprisePendingSetup } from "./enterprisePendingSetup";
import { upsertEnterpriseOAuthConnection, getProviderConnectionById } from "@/lib/db/providers";
import { resolveProxyForProvider } from "@/models";
import {
  enterpriseProjectSchema,
  enterpriseLocationSchema,
  enterpriseContextSchema,
  enterpriseIdentitySnapshot,
} from "@omniroute/open-sse/utils/agyEnterprise.ts";
import { verifyDashboardSessionToken } from "@/shared/utils/dashboardSessionToken";
import { validateBrowserMutationOrigin } from "@/server/origin/publicOrigin";
import { validateDashboardCsrfToken } from "@/server/authz/csrf";
import { runWithProxyContextOrDirect } from "@omniroute/open-sse/utils/proxyFetch.ts";
import {
  fetchEnterpriseLicenses,
  assignEnterpriseLicense,
  fetchEnterpriseConfig,
  enterpriseFetchJson,
} from "@omniroute/open-sse/services/agyEnterprise.ts";
import { getAccessToken } from "@omniroute/open-sse/services/tokenRefresh.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { syncToCloudIfEnabled } from "./connectionPersistence";

const COOKIE = "enterprise_setup_owner";
const authorizations = new Map<string, { owner: string; expiresAt: number; redirectUri: string }>();
const uuid = z.string().uuid();
const exchangeSchema = z.object({
  code: z.string().min(1).max(8192),
  redirectUri: z.string().url(),
  codeVerifier: z.string().optional(),
  state: z.string().min(1).max(512),
  connectionId: uuid.optional(),
});
const actionSchema = z.object({
  setupId: uuid,
  licenseId: uuid.optional(),
  projectId: enterpriseProjectSchema.optional(),
  location: enterpriseLocationSchema.default("us"),
});

function cookie(request: Request, name: string) {
  return (request.headers.get("cookie") || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
async function ownerBinding(request: Request, owner: string) {
  const rawSession = cookie(request, "auth_token");
  const session = await verifyDashboardSessionToken(rawSession);
  if (rawSession && !session) throw new Error("Dashboard session expired. Sign in again.");
  // Management auth ran before this handler; raw credentials never enter the store.
  const principal =
    session?.jti || (session ? rawSession : request.headers.get("authorization")) || "local";
  return createHash("sha256").update(`${owner}:${principal}`).digest("hex");
}

export async function handleEnterpriseOAuth(request: Request, action: string): Promise<Response> {
  try {
    const origin = validateBrowserMutationOrigin(request);
    if (!origin.ok && !(origin.reason === "invalid-origin" && validateDashboardCsrfToken(request)))
      return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
    let owner = cookie(request, COOKIE);
    if (action === "authorize" && request.method === "GET") {
      if (!owner || !/^[a-f0-9]{64}$/.test(owner)) owner = randomBytes(32).toString("hex");
      const query = new URL(request.url).searchParams;
      const redirectUri = resolveBrowserOAuthRedirectUri(
        "agy-enterprise",
        query.get("redirect_uri") || "http://localhost:8080/callback"
      );
      const data = generateAuthData("agy-enterprise", redirectUri);
      for (const [state, entry] of authorizations)
        if (entry.expiresAt <= Date.now()) authorizations.delete(state);
      if (authorizations.size >= 1000)
        throw new Error("Too many pending Enterprise authorizations");
      authorizations.set(data.state, {
        owner: await ownerBinding(request, owner),
        expiresAt: Date.now() + 15 * 60 * 1000,
        redirectUri,
      });
      const response = NextResponse.json(data);
      response.cookies.set(COOKIE, owner, {
        httpOnly: true,
        sameSite: "strict",
        secure: new URL(request.url).protocol === "https:",
        path: "/api/oauth/agy-enterprise",
        maxAge: 3600,
      });
      return response;
    }
    if (!owner || !/^[a-f0-9]{64}$/.test(owner))
      throw new Error("Enterprise setup owner is missing. Sign in again.");
    const binding = await ownerBinding(request, owner);
    const proxy = await resolveProxyForProvider("agy-enterprise");
    return await runWithProxyContextOrDirect(proxy, async () => {
      if (action === "exchange" && request.method === "POST") {
        const body = exchangeSchema.parse(await request.json());
        const authorization = authorizations.get(body.state);
        if (
          !authorization ||
          authorization.expiresAt <= Date.now() ||
          authorization.owner !== binding ||
          authorization.redirectUri !== body.redirectUri
        )
          throw new Error("Invalid Enterprise OAuth state");
        let target: { id: string; identity: string } | undefined;
        if (body.connectionId) {
          const row = await getProviderConnectionById(body.connectionId);
          if (!row || row.provider !== "agy-enterprise" || row.authType !== "oauth")
            throw new Error("Enterprise reauthorization target unavailable");
          target = { id: body.connectionId, identity: enterpriseIdentitySnapshot(row) };
        }
        authorizations.delete(body.state);
        // No user-info or discovery here: credentials enter pending memory immediately.
        const tokens = await exchangeTokens(
          "agy-enterprise",
          body.code,
          body.redirectUri,
          body.codeVerifier,
          body.state
        );
        return NextResponse.json(enterprisePendingSetup.create(binding, tokens, target));
      }
      const body =
        request.method === "GET"
          ? actionSchema.parse(Object.fromEntries(new URL(request.url).searchParams))
          : actionSchema.parse(await request.json());
      if (action === "cancel" && request.method === "POST")
        return NextResponse.json(enterprisePendingSetup.cancel(body.setupId, binding));
      if (action === "finalize" && request.method === "POST") {
        if (!body.licenseId) throw new Error("Select a license");
        const result = await enterprisePendingSetup.finalize(
          body.setupId,
          binding,
          body.licenseId,
          async (ticket, license) => {
            if (!ticket.tokens?.email)
              throw new Error("Discover the verified Google account first");
            if (new Date(ticket.tokens.expiresAt).getTime() <= Date.now() + 60_000) {
              const refreshed = await getAccessToken("agy-enterprise", ticket.tokens, null, proxy);
              enterprisePendingSetup.get(body.setupId, binding);
              if (!ticket.tokens || ticket.state !== "finalizing")
                throw new Error("Enterprise setup cancelled");
              if (!refreshed?.accessToken)
                throw new Error("Enterprise token refresh failed. Sign in again.");
              ticket.tokens = {
                ...ticket.tokens,
                ...refreshed,
                expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000).toISOString(),
              };
            }
            await fetchEnterpriseConfig(
              ticket.tokens.accessToken,
              enterpriseContextSchema.parse(license),
              ticket.controller.signal
            );
          },
          (ticket, license) => {
            const tokens = ticket.tokens!;
            const row = upsertEnterpriseOAuthConnection(
              {
                ...tokens,
                provider: "agy-enterprise",
                authType: "oauth",
                projectId: license.projectId,
                tokenExpiresAt: tokens.expiresAt,
                testStatus: "active",
                isActive: true,
                providerSpecificData: {
                  ...tokens.providerSpecificData,
                  ...enterpriseContextSchema.parse(license),
                  verifiedAt: new Date().toISOString(),
                },
              },
              ticket.target
            ) as { id: string };
            return row.id;
          }
        );
        await syncToCloudIfEnabled();
        return NextResponse.json(result);
      }
      const ticket = enterprisePendingSetup.pending(body.setupId, binding);
      if (action === "licenses" && request.method === "GET") {
        if (!ticket.tokens.email && !ticket.tokens.providerSpecificData.googleSubject) {
          const info = z
            .object({
              id: z.string().min(1),
              email: z.string().email(),
              verified_email: z.boolean(),
            })
            .parse(
              await enterpriseFetchJson(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                ticket.tokens.accessToken,
                { signal: ticket.controller.signal }
              )
            );
          if (!info.verified_email) throw new Error("Google account email is not verified");
          enterprisePendingSetup.pending(body.setupId, binding);
          ticket.tokens.email = info.email;
          ticket.tokens.providerSpecificData.googleSubject = info.id;
        }
        // Identity is already verified; a failed catalog request must still allow
        // the explicit custom-project recovery path.
        let licenses: Awaited<ReturnType<typeof fetchEnterpriseLicenses>> = [];
        let discoveryError: string | undefined;
        try {
          licenses = await fetchEnterpriseLicenses(
            ticket.tokens.accessToken,
            ticket.controller.signal
          );
        } catch (error) {
          discoveryError =
            error instanceof z.ZodError
              ? "License discovery returned invalid data. Retry or verify a project."
              : sanitizeErrorMessage(
                  error instanceof Error ? error.message : "License discovery failed"
                );
        }
        const entries = enterprisePendingSetup.addLicenses(body.setupId, binding, licenses);
        return NextResponse.json({ email: ticket.tokens.email, licenses: entries, discoveryError });
      }
      if (action === "verify-project" && request.method === "POST") {
        if (!body.projectId || !ticket.tokens.email)
          throw new Error("Discover your account and enter a valid project first");
        const license = await assignEnterpriseLicense(
          ticket.tokens.accessToken,
          body.projectId,
          body.location,
          ticket.controller.signal
        );
        const licenses = enterprisePendingSetup.addLicenses(body.setupId, binding, [license]);
        return NextResponse.json({
          licenses,
          verifiedLicenseId: licenses.find(
            (entry) => entry.projectId === license.projectId && entry.location === license.location
          )!.licenseId,
        });
      }
      return NextResponse.json({ error: "Unsupported Enterprise OAuth action" }, { status: 400 });
    });
  } catch (error) {
    const status =
      error instanceof z.ZodError ? 400 : Number((error as { status?: number }).status) || 400;
    const message =
      error instanceof z.ZodError
        ? "Invalid Enterprise setup data"
        : sanitizeErrorMessage(error instanceof Error ? error.message : "Enterprise setup failed");
    return NextResponse.json({ error: message }, { status });
  }
}
