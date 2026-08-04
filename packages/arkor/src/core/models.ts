/**
 * Base models `createTrainer` can target. This list must mirror what cloud-api
 * accepts for a job's `model`; sending an unsupported value produces a 4xx from
 * upstream.
 *
 * Widening the array is the only edit needed to open the field up to the rest
 * of the Gemma 4 family (see the roadmap Backlog): the `SupportedModel` union
 * is derived from it.
 *
 * Studio's Playground keeps its own copy of this list in
 * `@arkor/studio-app`'s `lib/baseModels.ts`. That duplication is deliberate:
 * the SPA bundle does not import from `arkor`, so unifying the two would pull
 * the SDK into the browser bundle. Keep them in sync by hand.
 */
export const SUPPORTED_MODELS = Object.freeze([
  "unsloth/gemma-4-E4B-it",
] as const);

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];
