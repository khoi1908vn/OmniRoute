import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agyEnterpriseContextSchema,
  agyEnterpriseWebSearchSchema,
} from "@omniroute/open-sse/utils/agyEnterprise.ts";
import {
  BaseExecutor,
  type ExecuteInput,
  type ProviderCredentials,
  type ExecutorLog,
  type ExecutorExecuteResult,
} from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { getAccessToken } from "../services/tokenRefresh.ts";
import { agyEnterpriseResource, agyEnterpriseHeaders } from "../services/agyEnterprise.ts";
import { errorResponse } from "../utils/error.ts";
import {
  agyEnterpriseHistorySnapshot,
  type GeminiContent,
} from "../translator/request/openai-to-gemini/helpers.ts";

const UNSUPPORTED_TOOLS = "Enterprise unverified tool mode: omit toolConfig";
const UNSUPPORTED_IMAGES = "Enterprise unverified media: only inline PNG user input is supported";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngData = z
  .string()
  .min(1)
  .refine((data) => {
    const bytes = Buffer.from(data, "base64");
    return bytes.toString("base64") === data && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  }, UNSUPPORTED_IMAGES);
const part = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value && typeof value === "object" && "fileData" in value) {
      ctx.addIssue({ code: "custom", message: UNSUPPORTED_IMAGES });
    }
  })
  .pipe(
    z.union([
      z
        .object({
          text: z.string(),
          thought: z.boolean().optional(),
          thoughtSignature: z.string().optional(),
        })
        .strict(),
      z
        .object({
          functionCall: z
            .object({
              id: z.string().min(1),
              name: z.string().min(1),
              args: z.record(z.string(), z.unknown()),
            })
            .strict(),
          thoughtSignature: z.string().min(1).optional(),
        })
        .strict(),
      z
        .object({
          functionResponse: z
            .object({
              id: z.string().min(1),
              name: z.string().min(1),
              response: z.object({ output: z.string() }).strict(),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          inlineData: z.object({ mimeType: z.literal("image/png"), data: pngData }).strict(),
        })
        .strict(),
    ])
  );
const content = z
  .object({ role: z.enum(["user", "model"]).optional(), parts: z.array(part).min(1) })
  .superRefine((value, ctx) => {
    if (value.parts.some((p) => "inlineData" in p) && value.role !== "user") {
      ctx.addIssue({ code: "custom", message: UNSUPPORTED_IMAGES });
    }
  });
const requestSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    const source = value as Record<string, unknown> | null | undefined;
    if (source?.toolConfig) {
      ctx.addIssue({ code: "custom", message: UNSUPPORTED_TOOLS });
    }
    if (
      source?._agyEnterpriseHistory instanceof Map &&
      Array.isArray(source.contents) &&
      source._agyEnterpriseHistory.get("history") !==
        agyEnterpriseHistorySnapshot(source.contents as GeminiContent[])
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Enterprise replay history changed after translation",
      });
    }
  })
  .pipe(
    z.object({
      contents: z.array(content).min(1),
      systemInstruction: z
        .object({
          role: z.literal("user").optional(),
          parts: z.array(z.object({ text: z.string() }).strict()).min(1),
        })
        .optional(),
      generationConfig: z.record(z.string(), z.unknown()).optional(),
      tools: z
        .array(
          z.union([
            z
              .object({
                functionDeclarations: z
                  .array(
                    z
                      .object({
                        name: z.string().min(1),
                        description: z.string().optional(),
                        parameters: z.record(z.string(), z.unknown()).optional(),
                      })
                      .strict()
                  )
                  .min(1),
              })
              .strict(),
            z.object({ enterpriseWebSearch: agyEnterpriseWebSearchSchema }).strict(),
          ])
        )
        .optional(),
    })
  );
const experienceSchema = z.string().min(1).max(200).regex(/\S/);

function parseAgyEnterpriseRequest(
  model: string,
  body: unknown
): { experience: string; request: z.infer<typeof requestSchema> } {
  return { experience: experienceSchema.parse(model), request: requestSchema.parse(body) };
}

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
    return `${agyEnterpriseResource(credentials?.providerSpecificData)}:streamGenerateContent?alt=sse`;
  }
  buildHeaders(credentials: ProviderCredentials) {
    if (!credentials.accessToken) throw new Error("Enterprise OAuth access token required");
    return {
      ...agyEnterpriseHeaders(credentials.accessToken),
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
    const { experience, request } = parseAgyEnterpriseRequest(model, body);
    const context = agyEnterpriseContextSchema.parse(credentials.providerSpecificData);
    return {
      ...request,
      aicode: { experience },
      entitlement: { userTier: context.userTier },
    };
  }
  async refreshCredentials(credentials: ProviderCredentials, log: ExecutorLog | null) {
    return getAccessToken("agy-enterprise", credentials, log);
  }
  async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    try {
      parseAgyEnterpriseRequest(input.model, input.body);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      const diagnostic = error.issues.find(
        (issue) => issue.message === UNSUPPORTED_TOOLS || issue.message === UNSUPPORTED_IMAGES
      )?.message;
      const safeMessage =
        diagnostic ||
        (experienceSchema.safeParse(input.model).success
          ? `Invalid Enterprise request: ${error.issues.map((issue) => `${issue.path.join(".") || "request"} [${issue.code}]: ${issue.message}`).join("; ")}`
          : "Invalid Enterprise experience: use 1 to 200 characters with non-whitespace text");
      return errorResponse(400, safeMessage, { type: "invalid_request_error" });
    }
    return super.execute({ ...input, stream: true });
  }
}
