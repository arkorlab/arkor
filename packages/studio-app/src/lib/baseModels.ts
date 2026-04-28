/**
 * Base models the Studio Playground can target without an adapter. This list
 * must mirror what cloud-api accepts on `/v1/inference/chat` for `baseModel`;
 * sending an unsupported value produces a 4xx from upstream.
 */
export const SUPPORTED_BASE_MODELS = ["unsloth/gemma-4-e4b-it"] as const;

export type SupportedBaseModel = (typeof SUPPORTED_BASE_MODELS)[number];

export const DEFAULT_BASE_MODEL: SupportedBaseModel = SUPPORTED_BASE_MODELS[0];
