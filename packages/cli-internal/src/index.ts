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
export {
  install,
  lockfileChangedSince,
  snapshotLockfile,
  type LockfileSnapshot,
} from "./install";
export {
  gitInitialCommit,
  isInGitRepo,
  type InitialCommitResult,
} from "./git";
export { sanitise } from "./sanitise";
