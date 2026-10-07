import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgyEnterpriseLicenseStep from "@/shared/components/oauthModal/AgyEnterpriseLicenseStep";

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
    licenseId: "global-license",
    projectId: "project-two",
    location: "global",
    userTier: "standard",
    supported: false,
  },
];
async function render(onSaved = vi.fn(), onSignInAgain = vi.fn()) {
  await act(async () =>
    root.render(
      <AgyEnterpriseLicenseStep
        setup={{ ...setup, expiresAt: Date.now() + 900_000 }}
        onSaved={onSaved}
        onSignInAgain={onSignInAgain}
      />
    )
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
  expect(element.querySelector<HTMLInputElement>('input[value="global-license"]')?.disabled).toBe(
    true
  );
  expect(element.textContent).toContain("unsupported location");
  await act(async () => button("Save").click());
  expect(saved).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
    setupId: setup.setupId,
    licenseId: "us-license",
  });
});

it("manual setup defaults to US and sends selected EU region, then saves the returned license", async () => {
  const custom = { ...licenses[0], licenseId: "eu-license", location: "eu" };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(
      String(input).includes("licenses?")
        ? { email: "person@example.com", licenses }
        : String(input).endsWith("verify-project")
          ? { licenses: [...licenses, custom], verifiedLicenseId: custom.licenseId }
          : { status: "completed" }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  await render();
  const region = element.querySelector<HTMLSelectElement>('select[aria-label="License region"]');
  expect(region?.value).toBe("us");
  await act(async () => {
    region!.value = "eu";
    region!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  enterProject("project-one");
  await act(async () => button("Verify project").click());
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
    setupId: setup.setupId,
    projectId: "project-one",
    location: "eu",
  });
  expect(element.querySelector<HTMLInputElement>('input[value="eu-license"]')?.checked).toBe(true);
  await act(async () => button("Save").click());
  expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).licenseId).toBe("eu-license");
});

it.each(["licenses", "finalize", "verify-project"])(
  "HTTP 410 offers immediate setup restart before client expiry: %s",
  async (action) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes(`/agy-enterprise/${action}`)
          ? Response.json({ error: "Enterprise setup is missing or expired" }, { status: 410 })
          : Response.json({ email: "person@example.com", licenses })
      )
    );
    const onSaved = vi.fn();
    const onSignInAgain = vi.fn();
    await render(onSaved, onSignInAgain);
    if (action === "verify-project") {
      enterProject("project-one");
      await act(async () => button("Verify project").click());
    } else if (action === "finalize") {
      await act(async () => button("Save").click());
    }
    expect(button("Sign in again")).toBeDefined();
    expect(element.textContent).toContain("Enterprise setup expired");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onSignInAgain).not.toHaveBeenCalled();
    await act(async () => button("Sign in again").click());
    expect(onSignInAgain).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  }
);

it("HTTP 503 preserves diagnostic and retry discovery without premature expiry", async () => {
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
  expect(button("Retry discovery").disabled).toBe(false);
  expect(button("Sign in again")).toBeUndefined();
  expect(element.textContent).not.toContain("Enterprise setup expired");
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
