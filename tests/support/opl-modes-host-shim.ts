// Build-time entry for the opl-modes lifecycle test. It re-exports the extension and the shared
// state/registry modules from ONE bundle, so the test and the mounted extension observe the same
// module instances. Compiled by tests/opl-modes-lifecycle.test.mjs with the Pi host package
// stubbed; it is never imported directly, because `index.ts` needs the host to resolve.
export { default } from "../../extensions/opl-modes/index.ts";
export { getMode, getRestoringModel, resetState } from "../../extensions/opl-modes/state.ts";
export { MODE_REGISTRY, registerMode, getModeDefinition } from "../../extensions/opl-modes/config.ts";
