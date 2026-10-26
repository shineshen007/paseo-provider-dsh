/**
 * Paseo plugin server entry.
 *
 * Paseo loads this module inside the daemon's plugin subprocess and calls the
 * default export with a `PluginServerContext`. Registering the provider here is
 * what makes DeepSeek Harness a first-class Paseo provider: no ACP process, no
 * protocol shim, and no `runAcpProvider` anywhere in this plugin.
 *
 * Paseo's plugin contract requires every relative import from this file to live
 * under `server/` or `shared/`; both halves of the bridge are wired through
 * those directories only.
 */

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createDshProvider } from "./server/provider.ts";

export default function contribute(server: PluginServerContext): () => void {
  const provider = createDshProvider({
    log: (message) => {
      // The plugin subprocess's stderr is captured by the daemon's log; stdout is
      // left alone because it carries the daemon's own RPC frames.
      process.stderr.write(`[paseo-provider-dsh] ${message}\n`);
    },
  });
  server.registerProvider(provider);
  return () => {
    // Live dsh children are owned by their provider connections; Paseo closes
    // those before this cleanup runs, so there is nothing left to reap here.
  };
}
