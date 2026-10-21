import { expect, test } from "../harness/fixture";

/**
 * Guards the token pipeline end to end: the `@arkor/ui` import resolving, the
 * `@theme inline` block generating utilities that reference `var(--ak-*)`, and
 * `data-theme` swapping the values underneath them.
 *
 * It runs in a browser rather than as a unit test because the failure this
 * catches is silent. An unresolved custom property leaves the affected
 * property at its initial value, so a dropped import, a renamed token or a
 * consumer that forgets to scan the package's sources all render a partly
 * unpainted app while every existing test still passes.
 *
 * Everything here asserts on *used* values, never on
 * `getComputedStyle().getPropertyValue("--ak-...")`: that returns an empty
 * string on the macOS runner's Chromium even where the same tokens paint
 * correctly, and what matters is what the page ends up painted with anyway.
 *
 * Expected colours are written as the token's declared text and handed to the
 * browser to serialise, so the comparison does not depend on how a given
 * Chromium prints a colour. They are spelled out rather than read back from
 * the stylesheet on purpose: a test that sources its expectations from the
 * thing under test cannot fail.
 *
 * Assert on the token values, not on class names: the classes are what the
 * follow-up work moves into the shared package.
 */
const EXPECTED = {
  light: {
    canvas: "oklch(98.51% 0 0)",
    surface: "oklch(100% 0 0)",
    fg: "oklch(20.46% 0 0)",
    edge: "oklch(92.19% 0 0)",
  },
  dark: {
    canvas: "oklch(14.48% 0 0)",
    surface: "oklch(19.13% 0 0)",
    fg: "oklch(97.02% 0 0)",
    edge: "oklch(32.11% 0 0)",
  },
} as const;

for (const theme of ["light", "dark"] as const) {
  test(`design tokens resolve in the ${theme} theme`, async ({
    page,
    studio,
  }) => {
    await page.addInitScript((t) => {
      window.localStorage.setItem("arkor-studio-theme", t);
    }, theme);
    await page.goto(studio.url);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

    const actual = await page.evaluate((want: Record<string, string>) => {
      // Round-trip each expected colour through the browser so both sides of
      // the comparison come out of the same serialiser.
      const probe = document.createElement("div");
      probe.style.display = "none";
      document.body.append(probe);
      const serialise = (css: string) => {
        probe.style.backgroundColor = "";
        probe.style.backgroundColor = css;
        return getComputedStyle(probe).backgroundColor;
      };
      const expected = Object.fromEntries(
        Object.entries(want).map(([k, v]) => [k, serialise(v)]),
      );
      probe.remove();

      const body = getComputedStyle(document.body);
      const card = document.querySelector("main a.group");
      const cardStyle = card ? getComputedStyle(card) : null;
      return {
        expected,
        dataTheme: document.documentElement.dataset.theme,
        bodyBackground: body.backgroundColor,
        bodyColor: body.color,
        bodyFont: body.fontFamily,
        cardBackground: cardStyle?.backgroundColor ?? null,
        cardBorder: cardStyle?.borderTopColor ?? null,
      };
    }, EXPECTED[theme]);

    expect(actual.dataTheme).toBe(theme);
    expect(actual.bodyBackground).toBe(actual.expected.canvas);
    expect(actual.bodyColor).toBe(actual.expected.fg);
    expect(actual.cardBackground).toBe(actual.expected.surface);
    expect(actual.cardBorder).toBe(actual.expected.edge);
    // Declared in the same file as the colours, and just as silent when it
    // goes missing: the app would fall back to the browser default face.
    expect(actual.bodyFont).toContain("Geist Variable");
  });
}

test("the two themes do not resolve to the same values", async ({
  page,
  studio,
}) => {
  const read = async (theme: "light" | "dark") => {
    await page.addInitScript((t) => {
      window.localStorage.setItem("arkor-studio-theme", t);
    }, theme);
    await page.goto(studio.url);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  };
  // Catches a theme that resolves but no longer varies: tokens replaced with
  // literals, or a `dark` variant that stopped matching. Either leaves a page
  // that renders perfectly in one theme and ignores the toggle.
  expect(await read("light")).not.toBe(await read("dark"));
});
