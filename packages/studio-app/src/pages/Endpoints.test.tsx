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
  it("stays hidden until the mode resolves, then appears for cloud", async () => {
    // Offering the form before /api/credentials settles would let a
    // local-mode user submit a create that can only come back 501.
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ deployments: [] }),
    ) as typeof fetch;

    const { rerender } = render(<EndpointsList />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", CREATE_BUTTON)).not.toBeInTheDocument();

    rerender(<EndpointsList local={false} />);
    expect(
      await screen.findByRole("button", CREATE_BUTTON),
    ).toBeInTheDocument();
  });

  it("keeps it hidden in local mode", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ deployments: [], localUnavailable: true }),
    ) as typeof fetch;

    render(<EndpointsList local />);
    // The local-specific empty state proves the response landed.
    expect(
      await screen.findByText(/Deployments are cloud-only/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", CREATE_BUTTON)).not.toBeInTheDocument();
  });

  it("keeps it available when the deployments list fails to load", async () => {
    // The affordance follows the credentials-derived mode, so a transient
    // list failure cannot cost the user the primary action for the
    // session; a create attempt then reports its own error.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;

    render(<EndpointsList local={false} />);
    await waitFor(() =>
      expect(screen.getByRole("button", CREATE_BUTTON)).toBeInTheDocument(),
    );
  });
});
