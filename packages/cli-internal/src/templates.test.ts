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
      expect(trainer).toMatch(/^\s*evalSteps:\s*\d+,\s*$/m);
    });

    it("destructures evalLoss in the onLog callback so it's printed when present", () => {
      // The onLog body needs to actually consume `evalLoss` — not just
      // accept it in the signature — otherwise users wouldn't see
      // anything new in their terminal even with eval enabled. The
      // template uses a conditional append so `evalLoss=null` rows
      // (the majority) stay terse.
      expect(trainer).toMatch(/onLog:\s*\(\{\s*step,\s*loss,\s*evalLoss\s*\}\)/);
      expect(trainer).toContain("evalLoss !== null");
    });
  });
});
