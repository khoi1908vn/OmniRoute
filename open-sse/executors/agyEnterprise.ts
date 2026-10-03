import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BaseExecutor,
  type ExecuteInput,
  type ProviderCredentials,
  type ExecutorLog,
} from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { getAccessToken } from "../services/tokenRefresh.ts";
import { enterpriseContextSchema } from "@omniroute/open-sse/utils/agyEnterprise.ts";
import { enterpriseResource, enterpriseHeaders } from "../services/agyEnterprise.ts";

const part = z
  .object({
    text: z.string(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
  })
  .strict();
const content = z.object({ role: z.string().optional(), parts: z.array(part) });
const requestSchema = z.object({
  contents: z.array(content).min(1),
  systemInstruction: content.optional(),
  generationConfig: z.record(z.string(), z.unknown()).optional(),
});
const experienceSchema = z.string().min(1).max(200).regex(/\S/);

export class AgyEnterpriseExecutor extends BaseExecutor {
  constructor() {
    super("agy-enterprise", PROVIDERS["agy-enterprise"]);
  }
  buildUrl(
    _model: string,
    _stream: boolean,
    _index = 0,
    credentials: ProviderCredentials | null = null
  ) {
    return `${enterpriseResource(enterpriseContextSchema.parse(credentials?.providerSpecificData))}:streamGenerateContent?alt=sse`;
  }
  buildHeaders(credentials: ProviderCredentials) {
    if (!credentials.accessToken) throw new Error("Enterprise OAuth access token required");
    return {
      ...enterpriseHeaders(credentials.accessToken),
      Accept: "text/event-stream",
      "X-Aicode-Request-Id": `checkpoint/${randomUUID()}`,
    };
  }
  transformRequest(
    model: string,
    body: unknown,
    _stream: boolean,
    credentials: ProviderCredentials
  ) {
    const experience = experienceSchema.parse(model);
    const source = body as Record<string, unknown>;
    if ((Array.isArray(source?.tools) && source.tools.length) || source?.toolConfig)
      throw new Error("Enterprise tool calling is not yet verified");
    const context = enterpriseContextSchema.parse(credentials.providerSpecificData);
    return {
      ...requestSchema.parse(body),
      aicode: { experience },
      entitlement: { userTier: context.userTier },
    };
  }
  async refreshCredentials(credentials: ProviderCredentials, log: ExecutorLog | null) {
    return getAccessToken("agy-enterprise", credentials, log);
  }
  async execute(input: ExecuteInput) {
    return super.execute({ ...input, stream: true });
  }
}
