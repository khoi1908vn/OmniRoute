import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { getLobeProviderIcon } from "@/shared/components/lobeProviderIcons";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";

vi.mock("@/shared/hooks/useTheme", () => ({ useTheme: () => ({ isDark: false }) }));

for (const type of ["mono", "color"] as const) {
  it(`Enterprise renders the AGY ${type} brand component with its own provider label`, () => {
    const icon = getLobeProviderIcon("agy", type)!;
    expect(icon).toBeTruthy();
    expect(getLobeProviderIcon("agy-enterprise", type)).toBe(icon);
    const expected = renderToStaticMarkup(
      React.createElement(icon, {
        "aria-label": "agy-enterprise",
        size: 24,
        style: { flex: "none" },
      })
    );
    const rendered = renderToStaticMarkup(<ProviderIcon providerId="agy-enterprise" type={type} />);
    expect(rendered).toContain(expected);
  });
}

it("Enterprise shares AGY fallback metadata while retaining separate identity", () => {
  expect(AI_PROVIDERS["agy-enterprise"].icon).toBe(AI_PROVIDERS.agy.icon);
  expect(AI_PROVIDERS["agy-enterprise"].id).toBe("agy-enterprise");
});
