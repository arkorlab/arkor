# @arkor/ui

Design tokens shared by the arkor web surfaces. Private, source-only: there is
no build step, consumers bundle `src/` themselves.

## Usage

Tailwind v4, CSS-first. In the app's entry stylesheet:

```css
@import "tailwindcss";
@import "@arkor/ui/theme.css";
```

That brings in the `dark` variant, the token values for both themes, and the
`@theme inline` block that turns them into utilities (`bg-surface`,
`text-fg-muted`, `border-edge-strong`, `ring-ring`, ...). Because the block is
`inline`, those utilities follow `data-theme` on `<html>` at runtime, so a
component references one token rather than a light/dark pair.

The app owns two things this package deliberately does not: the pre-paint
script that sets `data-theme` before first paint, and the font loading. Only
the font *families* are declared here.

To read a token outside a utility class, from hand written CSS or an inline
style, use the backing property: `var(--ak-surface)`, not
`var(--color-surface)`. Tailwind emits a `--color-*` property only when it
finds a literal reference in a file it scans, and a reference it misses fails
silently, since an invalid var() leaves the property at its initial value. The
`--ak-*` properties are always declared.

## Tokens

| Group | Tokens |
| --- | --- |
| Surfaces | `canvas`, `surface`, `inset` |
| Text | `fg`, `fg-muted`, `fg-subtle` |
| Lines | `edge`, `edge-strong` |
| Action | `accent`, `accent-hover`, `on-accent`, `ring` |
| Danger | `danger`, `danger-hover`, `danger-fg`, `danger-surface`, `danger-edge` |
| Warning | `warn`, `warn-fg`, `warn-surface`, `warn-edge` |
| Charts | `series-strong`, `series-mid`, `series-faint` |
| Type | `--font-sans`, `--font-mono` |

Two rules the values encode, and that call sites have to keep:

- **Colour is exceptional.** The palette is monochrome apart from `danger` and
  `warn`. Status, success and emphasis are expressed with fill, border style
  and lightness: a solid `bg-accent` fill for a terminal success, an outline
  plus a pulsing dot for something in flight, a dashed outline for something
  queued, `bg-inset` for something inert.
- **Every token is opaque.** Do not add translucent values, and do not stack an
  opacity modifier on a token that represents a fill (`bg-danger-surface/50`).
  Alpha makes a token mean different things on different backgrounds and
  compounds when modifiers are layered.

## Adding UI primitives later

This package is CSS-only for now. When React primitives move in here, three
things need doing that are easy to miss:

- Add a `"."` entry to `exports` and the usual script set (`typecheck`,
  `lint`, `test`, `test:coverage`); see `packages/cli-internal` for the shape.
  Note that a `lint` script only works once the package actually has lintable
  files: ESLint fails on an empty match.
- Widen the React and jsx-a11y rule globs, which are currently scoped to
  `packages/studio-app/**/*.{ts,tsx,jsx}`, in both `eslint.config.ts` and
  `oxlint.config.ts`.
- Add `@source "../../ui/src";` (path relative to the consumer's stylesheet) to
  each consuming app's CSS. Tailwind does not scan `node_modules`, so class
  names living in this package would otherwise generate nothing.
