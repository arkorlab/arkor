export {
  scaffold,
  templateChoices,
  type FileAction,
  type ScaffoldOptions,
  type ScaffoldResult,
} from "./scaffold";
export {
  STARTER_CONFIG,
  STARTER_README,
  TEMPLATES,
  type TemplateId,
} from "./templates";
export {
  detectPackageManager,
  resolvePackageManager,
  type PackageManager,
  type PackageManagerFlags,
} from "./package-manager";
export { install } from "./install";
export {
  MANUAL_DEV_HINT,
  MANUAL_INSTALL_HINT,
  MANUAL_RUN_ARKOR_DEV_HINT,
  runArkorDevViaPm,
} from "./next-steps";
export {
  gitInitialCommit,
  isInGitRepo,
  type InitialCommitResult,
} from "./git";
export { sanitise } from "./sanitise";
