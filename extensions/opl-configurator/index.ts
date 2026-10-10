import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { showConfigurator } from "./configurator.js";

export default function configurator(pi: ExtensionAPI): void {
  pi.registerCommand("configurator", {
    description: "Configure instrumented OPL extensions through hotkey tabs",
    handler: async (_args, ctx) => {
      await showConfigurator(ctx);
    },
  });
}