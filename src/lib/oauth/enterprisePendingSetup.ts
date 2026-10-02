import { randomUUID } from "node:crypto";
import type { EnterpriseLicense } from "@omniroute/open-sse/utils/agyEnterprise.ts";

export type EnterpriseTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  expiresIn?: number;
  scope?: string;
  email?: string;
  providerSpecificData: Record<string, unknown>;
};
export type EnterpriseResult = { status: "completed"; connectionId: string };
type Ticket = {
  owner: string;
  expiresAt: number;
  tokens?: EnterpriseTokens;
  target?: { id: string; identity: string };
  licenses: Map<string, EnterpriseLicense>;
  state: "pending" | "finalizing" | "completed" | "cancelled";
  controller: AbortController;
  attempt?: Promise<EnterpriseResult>;
  selection?: string;
  result?: EnterpriseResult;
};

/** ponytail: one process; use shared storage before deploying multiple instances. */
export class EnterprisePendingSetup {
  private tickets = new Map<string, Ticket>();
  constructor(private now: () => number = Date.now) {}
  create(owner: string, tokens: EnterpriseTokens, target?: Ticket["target"]) {
    this.cleanup();
    if (this.tickets.size >= 1000) throw new Error("Too many pending Enterprise setups");
    const setupId = randomUUID();
    const expiresAt = this.now() + 15 * 60 * 1000;
    this.tickets.set(setupId, {
      owner,
      expiresAt,
      tokens,
      target,
      licenses: new Map(),
      state: "pending",
      controller: new AbortController(),
    });
    return { status: "pending" as const, setupId, expiresAt };
  }
  private cleanup() {
    for (const [id, ticket] of this.tickets)
      if (ticket.expiresAt <= this.now()) {
        ticket.tokens = undefined;
        ticket.controller.abort();
        this.tickets.delete(id);
      }
  }
  get(id: string, owner: string): Ticket {
    this.cleanup();
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.owner !== owner)
      throw Object.assign(new Error("Enterprise setup expired or unavailable. Sign in again."), {
        status: 410,
      });
    if (ticket.state === "cancelled")
      throw Object.assign(new Error("Enterprise setup cancelled"), { status: 410 });
    return ticket;
  }
  pending(id: string, owner: string): Ticket & { tokens: EnterpriseTokens } {
    const ticket = this.get(id, owner);
    if (ticket.state !== "pending" || !ticket.tokens)
      throw new Error("Enterprise setup is no longer pending");
    return ticket as Ticket & { tokens: EnterpriseTokens };
  }
  addLicenses(id: string, owner: string, licenses: EnterpriseLicense[]) {
    const ticket = this.pending(id, owner);
    for (const license of licenses) {
      const existing = [...ticket.licenses].find(
        ([, entry]) => entry.projectId === license.projectId && entry.location === license.location
      );
      ticket.licenses.set(existing?.[0] || randomUUID(), license);
    }
    return [...ticket.licenses].map(([licenseId, license]) => ({
      licenseId,
      ...license,
      supported: license.location === "us",
    }));
  }
  cancel(id: string, owner: string) {
    const ticket = this.get(id, owner);
    if (ticket.result) return ticket.result;
    ticket.state = "cancelled";
    ticket.tokens = undefined;
    ticket.licenses.clear();
    ticket.controller.abort();
    return { status: "cancelled" as const };
  }
  finalize(
    id: string,
    owner: string,
    licenseId: string,
    validate: (ticket: Ticket, license: EnterpriseLicense) => Promise<void>,
    commit: (ticket: Ticket, license: EnterpriseLicense) => string
  ): Promise<EnterpriseResult> {
    const ticket = this.get(id, owner);
    if (ticket.selection && ticket.selection !== licenseId)
      throw new Error("Enterprise setup selection is already frozen");
    if (ticket.result) return Promise.resolve(ticket.result);
    if (ticket.attempt) return ticket.attempt;
    const license = ticket.licenses.get(licenseId);
    if (!license || license.location !== "us") throw new Error("Select a verified US license");
    ticket.selection = licenseId;
    ticket.state = "finalizing";
    const attempt = (async () => {
      await Promise.resolve();
      await validate(ticket, license);
      this.get(id, owner);
      if (ticket.state !== "finalizing" || !ticket.tokens)
        throw new Error("Enterprise setup cancelled");
      // Synchronous DB transaction is the commit/cancel ordering boundary.
      const connectionId = commit(ticket, license);
      ticket.result = { status: "completed", connectionId };
      ticket.state = "completed";
      ticket.tokens = undefined;
      ticket.licenses.clear();
      return ticket.result;
    })().finally(() => {
      ticket.attempt = undefined;
      if (ticket.state === "finalizing") {
        ticket.state = "pending";
        ticket.selection = undefined;
      }
    });
    ticket.attempt = attempt;
    return attempt;
  }
}
const processState = globalThis as typeof globalThis & {
  enterprisePendingSetup?: EnterprisePendingSetup;
};
export const enterprisePendingSetup = (processState.enterprisePendingSetup ||=
  new EnterprisePendingSetup());
