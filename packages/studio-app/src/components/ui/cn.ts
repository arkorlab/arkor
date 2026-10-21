/*
 * Joins; it does NOT merge. A caller's `className` and the component's base
 * class both survive, so when the two set the same property the winner is
 * whichever utility Tailwind emitted later, not the one the caller wrote.
 *
 * That failure is silent, and it has already happened once: `CopyButton` asked
 * its `IconButton` for `text-fg` while copied and got nothing, because
 * `.text-fg-muted` ships after `.text-fg` in the generated stylesheet. The
 * class was dropped rather than fixed.
 *
 * So a component taking `className` cannot promise a caller can override its
 * colours. Either keep the base free of the property a caller is expected to
 * set, or reach for a real merger.
 *
 * Both mergers were measured against this app rather than guessed. Each
 * resolves every conflict in this codebase identically, including the custom
 * tokens (`text-fg` against `text-fg-muted`, `border-edge` against
 * `border-edge-strong`), and a dump of every rendered class across four pages
 * showed exactly one changed element for either: the disabled segment in
 * `ModelToggle`, where the `hover:text-fg-muted` that cancels the hover starts
 * winning by resolution instead of by emit order. Cost is why neither landed,
 * against a bundle that was 86.07 kB gzipped:
 *
 *   tailwind-merge 3.6.0    +8.6 kB gzipped   (94.69)
 *   cnfast 0.2.0           +14.2 kB gzipped  (100.31)
 *
 * Worth revisiting when something actually needs to override a base colour, or
 * when these primitives move to `@arkor/ui` and the question arrives for a
 * package whose whole job is taking a `className`.
 */
export function cn(...args: (string | false | null | undefined)[]): string {
  return args.filter(Boolean).join(" ");
}
