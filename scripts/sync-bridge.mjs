#!/usr/bin/env node
/**
 * Refresh the installed bridge copy inside the Paseo-owned DSH profile.
 *
 * Why this is needed: `pnpm add file:<dir>` COPIES the package into the profile
 * instead of linking it. Editing dsh-bridge/ and rebuilding therefore does not
 * change what the DSH host loads - the profile keeps executing the old copy, so a
 * fix appears to do nothing. This script removes and reinstalls that copy.
 *
 * It only ever touches the dedicated Paseo profile, never web/desktop/headless.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.env.DSH_PASEO_PROFILE ?? "paseo-dsh";
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const FORBIDDEN = new Set(["web", "desktop", "headless"]);

if (FORBIDDEN.has(profile)) {
  console.error(`refusing to touch the '${profile}' profile: it belongs to your existing DeepSeek Harness`);
  process.exit(1);
}

const profileDir = join(dshHome, "profiles", profile);
if (!existsSync(profileDir)) {
  console.error(`profile '${profile}' not found at ${profileDir}; run scripts/install.sh first`);
  process.exit(1);
}

const bridgeSrc = join(root, "dsh-bridge");
if (!existsSync(join(bridgeSrc, "lib", "index.js"))) {
  console.error("bridge is not built; run: node scripts/build.mjs");
  process.exit(1);
}
const name = JSON.parse(readFileSync(join(bridgeSrc, "package.json"), "utf8")).name;
const installed = join(profileDir, "node_modules", name);

// Compare build timestamps so a no-op run stays quiet.
const builtAt = existsSync(join(bridgeSrc, "lib", "index.js"))
  ? readFileSync(join(bridgeSrc, "lib", "index.js")).length
  : 0;
const installedAt = existsSync(join(installed, "lib", "index.js"))
  ? readFileSync(join(installed, "lib", "index.js")).length
  : -1;
const same = builtAt === installedAt;
const force = process.argv.includes("--force");
if (same && !force) {
  console.log(`  bridge copy already matches the build (${name})`);
  process.exit(0);
}

rmSync(installed, { recursive: true, force: true });
execFileSync("pnpm", ["add", `${name}@file:${bridgeSrc}`], {
  cwd: profileDir,
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: "ignore",
});
console.log(`  refreshed ${name} in the '${profile}' profile`);
