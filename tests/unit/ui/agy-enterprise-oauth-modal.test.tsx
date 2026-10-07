import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import OAuthModal from "@/shared/components/OAuthModal";

vi.mock("next-intl", () => ({
  useTranslations: () => Object.assign((key: string) => key, { rich: (key: string) => key }),
}));

function enterCode(element: HTMLElement, value: string) {
  const input = element.querySelector<HTMLInputElement>("input:not([readonly])")!;
  expect(input).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function connect(element: HTMLElement) {
  return [...element.querySelectorAll("button")].find(
    (button) => button.textContent === "connect"
  )!;
}

it("close and reopen cancels the late exchange without replacing the current setup", async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let resolveExchange!: (response: Response) => void;
  const exchange = new Promise<Response>((resolve) => {
    resolveExchange = resolve;
  });
  let authorization = 0;
  let exchanges = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/authorize?"))
      return Response.json({
        authUrl: "https://accounts.google.com/authorize",
        state: `state-${++authorization}`,
        redirectUri: "https://antigravity.google/oauth-callback",
      });
    if (url.endsWith("/exchange"))
      return ++exchanges === 1
        ? exchange
        : Response.json({ setupId: "new-setup", expiresAt: Date.now() + 900_000 });
    if (url.endsWith("/cancel")) return Response.json({ status: "cancelled" });
    if (url.endsWith("/finalize")) return Response.json({ status: "completed" });
    return Response.json({
      email: "current@example.com",
      licenses: [
        {
          licenseId: "new-license",
          projectId: "new-project",
          location: "us",
          userTier: "standard",
          supported: true,
        },
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "open").mockImplementation(() => null);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const saved = vi.fn();
  const render = async (isOpen: boolean, id: string) => {
    await act(async () =>
      root.render(
        <OAuthModal
          isOpen={isOpen}
          provider="agy-enterprise"
          providerInfo={{ name: "Enterprise" }}
          reauthConnection={{ id }}
          onClose={vi.fn()}
          onSuccess={saved}
        />
      )
    );
  };
  try {
    await render(true, "old-target");
    enterCode(element, "old-code");
    await act(async () => connect(element).click());
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/exchange"))).toBe(true);
    await render(false, "old-target");
    await render(true, "new-target");
    await act(async () =>
      resolveExchange(Response.json({ setupId: "old-setup", expiresAt: Date.now() + 900_000 }))
    );
    const cancelled = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/cancel"));
    expect(cancelled).toBeDefined();
    expect(JSON.parse(String(cancelled?.[1]?.body)).setupId).toBe("old-setup");
    expect(element.textContent).not.toContain("Select an Enterprise license");
    expect(element.textContent).not.toContain("old@example.com");
    expect(saved).not.toHaveBeenCalled();
    enterCode(element, "new-code");
    await act(async () => connect(element).click());
    expect(element.textContent).toContain("current@example.com");
    const save = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Save"
    )!;
    await act(async () => save.click());
    expect(saved).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

async function withModal(
  run: (element: HTMLDivElement, fetchMock: ReturnType<typeof vi.fn>) => Promise<void>,
  options: {
    remote?: boolean;
    blocked?: boolean;
    exchangeFailure?: boolean;
    pendingExchange?: Promise<Response>;
  } = {}
) {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let authCount = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/authorize?"))
      return Response.json({
        authUrl: "https://accounts.google.com/o/oauth2/auth?synthetic",
        state: `state-${++authCount}`,
        redirectUri: "https://antigravity.google/oauth-callback",
      });
    if (url.endsWith("/exchange")) {
      if (options.pendingExchange) return options.pendingExchange;
      if (options.exchangeFailure)
        return Response.json(
          {
            error:
              "Enterprise token exchange failed: HTTP 400: invalid_grant. Start Google sign-in again.",
          },
          { status: 400 }
        );
      return Response.json({ setupId: "setup", expiresAt: Date.now() + 900_000 });
    }
    if (url.includes("licenses?"))
      return Response.json({ email: "person@example.com", licenses: [] });
    return Response.json({ status: "cancelled" });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "open").mockImplementation(() =>
    options.blocked ? null : ({ closed: false } as Window)
  );
  if (options.remote)
    vi.stubGlobal("location", new URL("https://remote.example/dashboard/providers"));
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        <OAuthModal
          isOpen
          provider="agy-enterprise"
          providerInfo={{ name: "Enterprise" }}
          onClose={vi.fn()}
        />
      )
    );
    await run(element, fetchMock);
  } finally {
    act(() => root.unmount());
    element.remove();
    localStorage.removeItem("oauth_callback");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
}

it("Enterprise accepts hosted code without browser verifier", async () => {
  await withModal(async (element, fetchMock) => {
    expect(element.textContent).toContain("agyEnterpriseCodePasteHint");
    expect(element.querySelector<HTMLInputElement>("input:not([readonly])")!.placeholder).toBe(
      "authorizationCodePlaceholder"
    );
    enterCode(element, "  synthetic-code  ");
    await act(async () => connect(element).click());
    const exchange = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/exchange"));
    expect(JSON.parse(String(exchange?.[1]?.body))).toEqual({
      code: "synthetic-code",
      state: "state-1",
    });
    expect(element.textContent).toContain("person@example.com");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/finalize"))).toBe(false);
  });
});

it.each([{ blocked: true }, { remote: true }])(
  "Enterprise remains manual when popup is blocked or dashboard is remote: %j",
  async (options) => {
    await withModal(async (element, fetchMock) => {
      expect(
        element.querySelector('a[href="https://accounts.google.com/o/oauth2/auth?synthetic"]')
      ).not.toBeNull();
      expect(element.querySelector("input:not([readonly])")).not.toBeNull();
      expect(element.textContent).not.toContain("remoteAccessInfo");
      expect(element.textContent).not.toContain("googleLoopbackTitle");
      expect(
        fetchMock.mock.calls.some(([url]) => /callback-server|poll-callback/.test(String(url)))
      ).toBe(false);
    }, options);
  }
);

it("unrelated callback messages do not exchange Enterprise code", async () => {
  await withModal(async (_element, fetchMock) => {
    await act(async () => {
      const data = { type: "oauth_callback", data: { code: "unsolicited-code", state: "state-1" } };
      window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, data }));
      window.dispatchEvent(
        new StorageEvent("storage", { key: "oauth_callback", newValue: JSON.stringify(data.data) })
      );
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/exchange"))).toHaveLength(
      0
    );
  });
});

it.each([
  ["https://foreign.example/oauth-callback?code=code&state=state-1", "errorAgyEnterpriseCallback"],
  ["https://antigravity.google/foreign?code=code&state=state-1", "errorAgyEnterpriseCallback"],
  ["https://antigravity.google/oauth-callback?code=code&state=state-foreign", "errorStateMismatch"],
  ["https://antigravity.google/oauth-callback?code=code", "errorStateMismatch"],
])("full callback rejects foreign URL or mismatched state: %s", async (url, error) => {
  await withModal(async (element, fetchMock) => {
    enterCode(element, url);
    await act(async () => connect(element).click());
    expect(element.textContent).toContain(error);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/exchange"))).toHaveLength(
      0
    );
  });
});

it("Enterprise accepts the matching hosted callback URL", async () => {
  await withModal(async (element, fetchMock) => {
    enterCode(
      element,
      "https://antigravity.google/oauth-callback?code=synthetic-code&state=state-1"
    );
    await act(async () => connect(element).click());
    const exchange = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/exchange"));
    expect(JSON.parse(String(exchange?.[1]?.body))).toEqual({
      code: "synthetic-code",
      state: "state-1",
    });
  });
});

it("Enterprise disables duplicate submit during exchange", async () => {
  let resolve!: (response: Response) => void;
  const exchange = new Promise<Response>((done) => {
    resolve = done;
  });
  await withModal(
    async (element, fetchMock) => {
      enterCode(element, "synthetic-code");
      const button = connect(element);
      await act(async () => {
        button.click();
        button.click();
      });
      expect(connect(element).disabled).toBe(true);
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/exchange"))
      ).toHaveLength(1);
      await act(async () =>
        resolve(Response.json({ setupId: "setup", expiresAt: Date.now() + 900_000 }))
      );
    },
    { pendingExchange: exchange }
  );
});

it("rejected exchange shows sanitized diagnostics and restarts sign-in", async () => {
  await withModal(
    async (element, fetchMock) => {
      enterCode(element, "synthetic-code");
      await act(async () => connect(element).click());
      expect(element.textContent).toContain("HTTP 400: invalid_grant");
      expect(element.textContent).toContain("Start Google sign-in again");
      const retry = [...element.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("tryAgain")
      )!;
      await act(async () => retry.click());
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes("/authorize?"))
      ).toHaveLength(2);
      expect(connect(element).disabled).toBe(true);
    },
    { exchangeFailure: true }
  );
});
