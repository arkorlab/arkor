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
 * Assert on the token values, not on class names: the classes are what the
 * follow-up work moves into the shared package.
 */
// Computed-colour notation, which is the serialised form the browser returns.
// `getPropertyValue` hands back the declared text instead, so the properties
// are only checked for presence below; their correctness is what these paint.
const EXPECTED = {
  light: {
    canvas: "oklch(0.9851 0 0)",
    surface: "oklch(1 0 0)",
    fg: "oklch(0.2046 0 0)",
    edge: "oklch(0.9219 0 0)",
  },
  dark: {
    canvas: "oklch(0.1448 0 0)",
    surface: "oklch(0.1913 0 0)",
    fg: "oklch(0.9702 0 0)",
    edge: "oklch(0.3211 0 0)",
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

    const actual = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const card = document.querySelector("main a.group");
      return {
        dataTheme: document.documentElement.dataset.theme,
        canvas: root.getPropertyValue("--ak-canvas").trim(),
        surface: root.getPropertyValue("--ak-surface").trim(),
        fg: root.getPropertyValue("--ak-fg").trim(),
        edge: root.getPropertyValue("--ak-edge").trim(),
        // The app has to actually paint with them, not merely declare them.
        bodyBackground: body.backgroundColor,
        bodyColor: body.color,
        bodyFont: body.fontFamily.split(",")[0]?.trim(),
        cardBackground: card ? getComputedStyle(card).backgroundColor : null,
        cardBorder: card ? getComputedStyle(card).borderTopColor : null,
      };
    });

    const want = EXPECTED[theme];
    expect(actual.dataTheme).toBe(theme);
    // Declared at all: this is what a dropped import or a renamed token loses.
    for (const name of ["canvas", "surface", "fg", "edge"] as const) {
      expect(actual[name], `--ak-${name} is not declared`).not.toBe("");
    }
    expect(actual.bodyBackground).toBe(want.canvas);
    expect(actual.bodyColor).toBe(want.fg);
    expect(actual.cardBackground).toBe(want.surface);
    expect(actual.cardBorder).toBe(want.edge);
    // Declared in the same file as the colours, and just as silent when it
    // goes missing: the app would fall back to the browser default face.
    expect(actual.bodyFont).toBe('"Geist Variable"');
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
  // A `@theme` block that lost its `inline` would compile the light value into
  // every utility, leaving both themes identical rather than obviously broken.
  expect(await read("light")).not.toBe(await read("dark"));
});
