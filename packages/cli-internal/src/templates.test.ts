import { describe, it, expect } from "vitest";

import { TEMPLATES, type TemplateId } from "./templates";

// Derive the id list from `TEMPLATES` (rather than hard-coding it) so a
// new template added to the registry is automatically covered by the
// per-template assertions below. The companion test then re-asserts
// the expected set so an accidental rename / removal of an existing
// template still fails loudly instead of silently shrinking coverage.
const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];

describe("templates", () => {
  it("registers exactly the expected starter templates", () => {
    expect(new Set(TEMPLATE_IDS)).toEqual(
      new Set<TemplateId>(["triage", "translate", "redaction"]),
    );
  });

  describe.each(TEMPLATE_IDS)("%s template", (id) => {
    const trainer = TEMPLATES[id].trainer;

    it("wires evaluation in by default via evalSteps", () => {
      // Scaffolded projects should produce both training and eval loss
      // from a fresh `arkor dev` so Studio's loss-curve picks the
      // `evalLoss` series up without the user needing to know about
      // the field. The exact cadence (25) doesn't matter for the
      // contract, but having SOME `evalSteps` set is what surfaces
      // eval to the UI; leaving it out would silently regress the
      // out-of-the-box eval experience.
      //
      // The object form is pinned, not just the presence of the key:
      // the cloud API validates `evalSteps` as exactly one of
      // `{ steps }` or `{ ratio }`, so a bare `evalSteps: 25` makes
      // every scaffolded project fail at job submission. Field order,
      // indentation and trailing commas stay unpinned so a formatter
      // pass can't break the test.
      expect(trainer).toMatch(/\bevalSteps:\s*\{\s*steps:\s*\d+[\s,]*\}/);
    });

    it("enables a held-out split so evalSteps actually runs", () => {
      // `evalSteps` alone is inert: the trainer only configures an eval
      // loop when the dataset was split, and `datasetSplit` defaults to
      // `{ enabled: false }` server-side. Without this the scaffold
      // submits successfully and then produces no eval loss at all.
      expect(trainer).toMatch(
        /\bdatasetSplit:\s*\{[^}]*\benabled:\s*true\b[^}]*\}/,
      );
    });

    it("destructures evalLoss in the onLog callback so it's printed when present", () => {
      // Observable contract: `evalLoss` is destructured into the
      // callback signature AND surfaces in the rendered output as an
      // `evalLoss=` segment. We don't pin the exact null-check
      // expression (`!== null` vs `Number.isFinite(...)` etc.) so the
      // template can change its guard style without breaking the
      // test, as long as the user-visible behavior is preserved.
      expect(trainer).toMatch(/onLog:\s*\(\{[^}]*\bevalLoss\b[^}]*\}\)/);
      expect(trainer).toContain("evalLoss=");
    });
  });
});
