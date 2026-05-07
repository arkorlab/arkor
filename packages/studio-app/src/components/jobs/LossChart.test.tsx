// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LossChart, type LossPoint } from "./LossChart";

describe("<LossChart />", () => {
  it("shows the empty hint when no point carries a numeric loss", () => {
    render(<LossChart points={[{ step: 0, loss: null }]} />);
    expect(
      screen.getByText(/waiting for training\.log events/i),
    ).toBeInTheDocument();
  });

  it("renders only the training-loss path when no eval data is present", () => {
    const points: LossPoint[] = [
      { step: 0, loss: 1.2 },
      { step: 1, loss: 1.0 },
      { step: 2, loss: 0.9 },
    ];
    const { container } = render(<LossChart points={points} />);
    // Two paths: gradient area + training line. Eval line is omitted.
    const paths = container.querySelectorAll("svg path");
    expect(paths.length).toBe(2);
    // Legend reflects the single series.
    expect(screen.getByText(/training loss/i)).toBeInTheDocument();
    expect(screen.queryByText(/eval loss/i)).toBeNull();
  });

  it("renders the eval-loss path when at least one point has a numeric evalLoss", () => {
    const points: LossPoint[] = [
      { step: 0, loss: 1.2, evalLoss: 1.3 },
      { step: 1, loss: 1.0, evalLoss: null },
      { step: 2, loss: 0.9, evalLoss: 0.95 },
    ];
    const { container } = render(<LossChart points={points} />);
    // Three paths: area, training line, eval line.
    expect(container.querySelectorAll("svg path").length).toBe(3);
    // Eval-only points get a circle marker each. Hover circles are
    // gated on the hover state, so the only circles in the initial
    // render are the eval markers.
    const circles = container.querySelectorAll("svg circle");
    expect(circles.length).toBe(2);
    expect(screen.getByText(/eval loss/i)).toBeInTheDocument();
  });

  it("hides the advanced stats panel by default", () => {
    const points: LossPoint[] = [
      { step: 0, loss: 1.0 },
      { step: 1, loss: 0.9 },
    ];
    render(<LossChart points={points} />);
    // Assert against text that actually appears in the advanced panel
    // — "Mean loss" is the row label and "95% CI" is the hint beside
    // it. The earlier check used a stale "Mean CE" string which would
    // have stayed green even if the panel started leaking through.
    expect(screen.queryByText("Mean loss")).toBeNull();
    expect(screen.queryByText(/95% CI/)).toBeNull();
  });

  it("shows mean loss ± 95% CI, std dev, variance, p90, and p95 in advanced mode", () => {
    const points: LossPoint[] = [1, 2, 3, 4, 5].map((loss, i) => ({
      step: i,
      loss,
    }));
    render(<LossChart points={points} advanced />);
    // Advanced panel surfaces all the requested summary fields.
    expect(screen.getByText("Mean loss")).toBeInTheDocument();
    expect(screen.getByText(/95% CI/)).toBeInTheDocument();
    expect(screen.getByText("Std dev")).toBeInTheDocument();
    expect(screen.getByText("Variance")).toBeInTheDocument();
    expect(screen.getByText("p90")).toBeInTheDocument();
    expect(screen.getByText("p95")).toBeInTheDocument();
    // Mean of 1..5 is 3 → "3.0000 ± …".
    expect(screen.getByText(/3\.0000 ± /)).toBeInTheDocument();
  });

  it("notes that eval stats are pending when no point carries evalLoss", () => {
    const points: LossPoint[] = [
      { step: 0, loss: 1.0 },
      { step: 1, loss: 0.9 },
    ];
    render(<LossChart points={points} advanced />);
    expect(
      screen.getByText(/awaiting training\.log events with evalloss/i),
    ).toBeInTheDocument();
  });

  it("computes eval stats independently when eval points are present", () => {
    const points: LossPoint[] = [
      { step: 0, loss: 1.0, evalLoss: 2.0 },
      { step: 1, loss: 0.9, evalLoss: 1.8 },
      { step: 2, loss: 0.8, evalLoss: 1.6 },
    ];
    render(<LossChart points={points} advanced />);
    // Both cards show "n = 3" — one per series.
    expect(screen.getAllByText("n = 3").length).toBe(2);
    // Eval-mean of [2.0, 1.8, 1.6] is 1.8 → "1.8000 ± …".
    expect(screen.getByText(/1\.8000 ± /)).toBeInTheDocument();
  });

  it("still renders the eval series when training.log frames omit `loss`", () => {
    // Eval-only logging shape: trainer reports `evalLoss` on a coarser
    // cadence and elides `loss` on those frames. The chart must still
    // surface these in the eval line, legend, and stats — earlier
    // versions filtered the eval series through the training-loss
    // numeric subset and dropped them entirely.
    const points: LossPoint[] = [
      { step: 0, loss: null, evalLoss: 1.5 },
      { step: 1, loss: null, evalLoss: 1.4 },
      { step: 2, loss: null, evalLoss: 1.3 },
    ];
    const { container } = render(<LossChart points={points} />);
    // Eval line is drawn; the training line and its area gradient are
    // omitted entirely (no `loss` data to draw).
    const paths = container.querySelectorAll("svg path");
    expect(paths.length).toBe(1);
    // One eval marker per point.
    expect(container.querySelectorAll("svg circle").length).toBe(3);
    // Legend hides the training entry when no training data is present
    // but still surfaces the eval entry.
    expect(screen.queryByText(/training loss/i)).toBeNull();
    expect(screen.getByText(/eval loss/i)).toBeInTheDocument();
  });

  it("computes eval stats from eval-only frames in advanced mode", () => {
    const points: LossPoint[] = [
      { step: 0, loss: null, evalLoss: 1.5 },
      { step: 1, loss: null, evalLoss: 1.4 },
      { step: 2, loss: null, evalLoss: 1.3 },
    ];
    render(<LossChart points={points} advanced />);
    // Eval-mean of [1.5, 1.4, 1.3] is 1.4 → "1.4000 ± …".
    expect(screen.getByText(/1\.4000 ± /)).toBeInTheDocument();
    // Eval card has n=3; training card sits in its empty state with n=0.
    expect(screen.getByText("n = 3")).toBeInTheDocument();
    expect(screen.getByText("n = 0")).toBeInTheDocument();
  });
});
