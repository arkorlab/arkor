// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";

import { jsonResponse } from "../test-utils/responses";

import { EndpointsList } from "./Endpoints";

const ORIG_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

const CREATE_BUTTON = { name: /New endpoint/i } as const;

describe("<EndpointsList /> create affordance", () => {
  it("stays hidden until the capability check resolves, then appears for cloud", async () => {
    // The flag is tri-state on purpose: offering the form while
    // /api/deployments is still in flight lets a local-mode user submit a
    // create that can only come back 501.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = vi.fn(async () => {
      await gate;
      return jsonResponse({ deployments: [] });
    }) as typeof fetch;

    render(<EndpointsList />);
    expect(screen.queryByRole("button", CREATE_BUTTON)).not.toBeInTheDocument();

    release();
    expect(
      await screen.findByRole("button", CREATE_BUTTON),
    ).toBeInTheDocument();
  });

  it("keeps it hidden in local mode", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ deployments: [], localUnavailable: true }),
    ) as typeof fetch;

    render(<EndpointsList />);
    // The local-specific empty state proves the response landed.
    expect(
      await screen.findByText(/Deployments are cloud-only/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", CREATE_BUTTON)).not.toBeInTheDocument();
  });

  it("restores it when the capability check fails", async () => {
    // A transient blip must not cost the user the affordance for the rest
    // of the session; a create attempt then reports its own error.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;

    render(<EndpointsList />);
    await waitFor(() =>
      expect(screen.getByRole("button", CREATE_BUTTON)).toBeInTheDocument(),
    );
  });
});
