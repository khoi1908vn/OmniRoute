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

function enterProject(value: string) {
  const input = element.querySelector<HTMLInputElement>(
    'input[placeholder="my-enterprise-project"]'
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("verifying another project selects that license for Save", async () => {
  const custom = { ...licenses[0], licenseId: "custom-license", projectId: "project-custom" };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).includes("licenses?"))
      return Response.json({ email: "person@example.com", licenses });
    if (String(input).endsWith("verify-project"))
      return Response.json({
        licenses: [...licenses, custom],
        verifiedLicenseId: custom.licenseId,
      });
    return Response.json({ status: "completed" });
  });
  vi.stubGlobal("fetch", fetchMock);
  await render();
  enterProject(custom.projectId);
  await act(async () => button("Verify project").click());
  await act(async () => button("Save").click());
  expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).licenseId).toBe(custom.licenseId);
});

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

it("verified identity survives discovery failure so a custom project can be verified", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    Response.json(
      String(input).includes("licenses?")
        ? {
            email: "person@example.com",
            licenses: [],
            discoveryError: "License discovery unavailable",
          }
        : { licenses: [licenses[0]], verifiedLicenseId: licenses[0].licenseId }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  await render();
  expect(element.querySelector('[role="alert"]')?.textContent).toBe(
    "License discovery unavailable"
  );
  expect(element.textContent).toContain("person@example.com");
  enterProject("project-one");
  expect(button("Verify project").disabled).toBe(false);
  await act(async () => button("Verify project").click());
  expect(button("Save").disabled).toBe(false);
});
