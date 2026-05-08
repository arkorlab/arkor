import { describe, it, expect } from "vitest";
import { TEMPLATES, type TemplateId } from "./templates";

const TEMPLATE_IDS: readonly TemplateId[] = ["triage", "translate", "redaction"];

describe("templates", () => {
  describe.each(TEMPLATE_IDS)("%s template", (id) => {
    const trainer = TEMPLATES[id].trainer;

    it("wires evaluation in by default via evalSteps", () => {
      // Scaffolded projects should produce both training and eval loss
      // from a fresh `arkor dev` so Studio's loss-curve picks the
      // `evalLoss` series up without the user needing to know about
      // the field. The exact cadence (25) doesn't matter for the
      // contract, but having SOME `evalSteps` set is what surfaces
      // eval to the UI — leaving it out would silently regress the
      // out-of-the-box eval experience.
      //
      // Match `evalSteps: <number>` anywhere it appears so a future
      // formatter or refactor (changed indentation, trailing comma
      // dropped, fields reordered) doesn't break the test as long as
      // the contract — "some numeric evalSteps is configured" — is
      // preserved.
      expect(trainer).toMatch(/\bevalSteps:\s*\d+/);
    });

    it("destructures evalLoss in the onLog callback so it's printed when present", () => {
      // Observable contract: `evalLoss` is destructured into the
      // callback signature AND surfaces in the rendered output as an
      // `evalLoss=` segment. We don't pin the exact null-check
      // expression (`!== null` vs `Number.isFinite(...)` etc.) so the
      // template can change its guard style without breaking the
      // test, as long as the user-visible behavior is preserved.
      expect(trainer).toMatch(
        /onLog:\s*\(\{[^}]*\bevalLoss\b[^}]*\}\)/,
      );
      expect(trainer).toContain("evalLoss=");
    });
  });
});
