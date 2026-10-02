import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import EnterpriseLicenseStep from "@/shared/components/oauthModal/EnterpriseLicenseStep";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(() => {
  act(() => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const setup = { setupId: "synthetic-setup", expiresAt: Date.now() + 900_000 };
const licenses = [
  {
    licenseId: "us-license",
    projectId: "project-one",
    location: "us",
    userTier: "standard",
    supported: true,
  },
  {
    licenseId: "eu-license",
    projectId: "project-two",
    location: "eu",
    userTier: "standard",
    supported: false,
  },
];
async function render(onSaved = vi.fn()) {
  await act(async () =>
    root.render(<EnterpriseLicenseStep setup={setup} onSaved={onSaved} onSignInAgain={vi.fn()} />)
  );
  return onSaved;
}
function button(text: string) {
  return [...element.querySelectorAll("button")].find((button) => button.textContent === text)!;
}

it("single supported license preselects; discovery never saves; explicit Save completes", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(
      String(input).includes("licenses?")
        ? { email: "person@example.com", licenses }
        : { status: "completed", connectionId: "saved" }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  const saved = await render();
  expect(saved).not.toHaveBeenCalled();
  expect(element.querySelector<HTMLInputElement>('input[value="us-license"]')?.checked).toBe(true);
  expect(element.querySelector<HTMLInputElement>('input[value="eu-license"]')?.disabled).toBe(true);
  expect(element.textContent).toContain("unsupported location");
  await act(async () => button("Save").click());
  expect(saved).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
    setupId: setup.setupId,
    licenseId: "us-license",
  });
});

it("discovery error preserves setup and retry loads licenses", async () => {
  let failed = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      failed
        ? Response.json({ error: "Try again" }, { status: 503 })
        : Response.json({ email: "person@example.com", licenses })
    )
  );
  await render();
  expect(element.querySelector('[role="alert"]')?.textContent).toBe("Try again");
  failed = false;
  await act(async () => button("Retry discovery").click());
  expect(button("Save").disabled).toBe(false);
});
