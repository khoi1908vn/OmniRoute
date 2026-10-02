import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import OAuthModal from "@/shared/components/OAuthModal";

vi.mock("next-intl", () => ({
  useTranslations: () => Object.assign((key: string) => key, { rich: (key: string) => key }),
}));

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
        codeVerifier: "verifier",
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
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { type: "oauth_callback", data: { code: "code", state: "state-1" } },
        })
      )
    );
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
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { type: "oauth_callback", data: { code: "new-code", state: "state-2" } },
        })
      )
    );
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
