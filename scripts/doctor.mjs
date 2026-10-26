#!/usr/bin/env node
/**
 * `doctor` — version compatibility and installation diagnosis.
 *
 * A provider that spans two products fails in confusing ways when the versions
 * do not line up, so this script checks every boundary and prints one pasteable
 * report:
 *
 *  - the installed `dsh` CLI and its version;
 *  - the dedicated profile exists, composes, and carries the bridge entry;
 *  - the bridge package resolves from that profile and reports a handshake;
 *  - the Paseo plugin manifest satisfies the daemon's requirements;
 *  - the plugin is registered in the Paseo daemon config (when that config exists).
 *
 * It is read-only: it starts a host only for the handshake probe and kills it.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = process.env.DSH_PASEO_PROFILE ?? "paseo-dsh";
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PASEO_CONFIG = process.env.PASEO_CONFIG ?? join(homedir(), ".paseo", "config.json");

/** Result rows, printed as a table and summarised at the end. */
const checks = [];

/** Record one check result. */
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  const mark = ok === true ? "ok  " : ok === "warn" ? "warn" : "FAIL";
  process.stdout.write(`${mark}  ${name}${detail !== undefined ? ` — ${detail}` : ""}\n`);
}

/** Read a JSON file, returning undefined when absent or invalid. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Compare two dotted versions; returns true when `value` satisfies `range`'s lower bound. */
function satisfiesLowerBound(value, range) {
  const lower = range.replace(/^[>=^~ ]+/, "").split(" ")[0];
  const left = value.split(".").map(Number);
  const right = lower.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

/** Check the dsh CLI. */
function checkDsh() {
  const result = spawnSync("dsh", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    check("dsh CLI", false, "not found on PATH; install DeepSeek Harness");
    return undefined;
  }
  const version = (result.stdout ?? "").trim().split("\n")[0];
  check("dsh CLI", true, `${version} (${whichDsh()})`);
  return version;
}

/** Resolve the dsh binary path for the report. */
function whichDsh() {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", ["dsh"], { encoding: "utf8" });
  return (result.stdout ?? "").trim().split("\n")[0] || "unknown";
}

/** Check the dedicated profile composition. */
function checkProfile() {
  const dir = join(DSH_HOME, "profiles", PROFILE);
  if (!existsSync(dir)) {
    check("DSH profile", false, `${PROFILE} missing at ${dir}; run scripts/install.sh`);
    return undefined;
  }
  const patch = join(dir, "cordis.patch.yml");
  const patchText = existsSync(patch) ? readFileSync(patch, "utf8") : "";
  check("DSH profile", true, `${dir}`);
  check(
    "bridge patch entry",
    patchText.includes("paseo-bridge") ? true : false,
    patchText.includes("paseo-bridge") ? "present in cordis.patch.yml" : "missing; re-run scripts/install.sh",
  );

  // Report inherited third-party providers: their absence is the usual reason a
  // model the user sees in DeepSeek Harness is missing from Paseo.
  const inherited = [...patchText.matchAll(/^\s{6}([A-Za-z0-9_.-]+):\s*$/gm)].map((m) => m[1]);
  const inheritedProviders = patchText.includes("inherited llm providers") ? inherited : [];
  check(
    "inherited llm providers",
    inheritedProviders.length > 0 ? true : "warn",
    inheritedProviders.length > 0
      ? inheritedProviders.join(", ")
      : "none; Paseo shows only the built-in DeepSeek models. Re-run: node scripts/sync-llm-config.mjs --source=desktop",
  );

  const compose = spawnSync("dsh", ["--profile", PROFILE, "--dump-config"], {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME },
    timeout: 120_000,
  });
  if (compose.status !== 0) {
    check("profile composes", false, (compose.stderr ?? "").split("\n").slice(0, 2).join(" "));
    return dir;
  }
  const composed = compose.stdout ?? "";
  check("profile composes", composed.includes("paseo-bridge"), `${composed.split("\n").filter((l) => l.startsWith("- id:")).length} entries`);

  // Guard against having installed into a profile the user's own harness uses.
  const pkg = readJson(join(dir, "package.json"));
  const bundles = pkg?.dsh?.profile?.bundles ?? [];
  check(
    "profile is dedicated",
    PROFILE !== "web" && PROFILE !== "desktop" && PROFILE !== "headless",
    `bundles: ${bundles.join(", ") || "none"}`,
  );
  return dir;
}

/** Check the bridge package inside the profile. */
function checkBridge(profileDir) {
  if (profileDir === undefined) return;
  const pkgPath = join(profileDir, "node_modules", "dsh-paseo-bridge", "package.json");
  if (!existsSync(pkgPath)) {
    check("bridge package", false, "not installed in the profile; run scripts/install.sh");
    return;
  }
  const pkg = readJson(pkgPath);
  check("bridge package", true, `dsh-paseo-bridge@${pkg?.version ?? "?"}`);
}

/** Probe a live handshake against a freshly started host. */
async function checkHandshake() {
  if (!existsSync(join(DSH_HOME, "profiles", PROFILE))) {
    check("bridge handshake", "warn", "skipped: no profile");
    return;
  }
  const socketPath = join(tmpdir(), `dsh-paseo-doctor-${process.pid}.sock`);
  const child = spawn("dsh", ["--profile", PROFILE, "--port", "0", "--no-open"], {
    env: { ...process.env, DSH_HOME, DSH_PASEO_BRIDGE_SOCKET: socketPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  try {
    const socket = await waitSocket(socketPath, 90_000);
    if (socket === undefined) {
      check("bridge handshake", false, `host did not open ${socketPath}: ${stderr.join("").split("\n").filter((l) => l.includes("paseo-bridge")).slice(0, 2).join(" ")}`);
      return;
    }
    const reply = await callBridge(socket, "bridge/initialize", {
      wireVersion: 1,
      client: { name: "doctor", version: "0" },
      providerProtocol: 1,
    });
    const result = reply?.result;
    if (result === undefined) {
      check("bridge handshake", false, JSON.stringify(reply).slice(0, 200));
      return;
    }
    check("bridge handshake", true, `wire ${result.wireVersion}, bridge ${result.bridgeVersion}, node ${result.platform?.node}`);
    check(
      "advertised features",
      Object.values(result.features ?? {}).every((value) => value !== false) ? true : "warn",
      Object.entries(result.features ?? {}).filter(([, v]) => v !== true).map(([k]) => k).join(",") || "all present",
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Wait for the socket file to appear, then connect. */
async function waitSocket(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      try {
        return await new Promise((res, rej) => {
          const socket = connect(path);
          socket.once("connect", () => res(socket));
          socket.once("error", rej);
        });
      } catch {
        // Retry until the deadline.
      }
    }
    if (Date.now() > deadline) return undefined;
    await new Promise((res) => setTimeout(res, 200));
  }
}

/** Send one request and read one reply. */
async function callBridge(socket, method, params) {
  return new Promise((res) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        res(JSON.parse(buffer.slice(0, newline)));
      } catch {
        res(undefined);
      }
      socket.destroy();
    });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    setTimeout(() => res(undefined), 20_000);
  });
}

/** Check the Paseo plugin manifest and registration. */
function checkPaseo() {
  const manifest = readJson(join(root, "paseo-plugin.json"));
  if (manifest === undefined) {
    check("plugin manifest", false, "paseo-plugin.json missing");
    return;
  }
  const validId = /^[a-z][a-z0-9-]*$/.test(manifest.id ?? "");
  check("plugin manifest", validId, `id=${manifest.id} requires paseo ${manifest.requirements?.paseo ?? "(unset)"}`);
  check("plugin entry", existsSync(join(root, "index.server.ts")), "index.server.ts");

  const config = readJson(PASEO_CONFIG);
  if (config === undefined) {
    check("Paseo registration", "warn", `no daemon config at ${PASEO_CONFIG}`);
    return;
  }
  const entry = config.plugins?.[manifest.id];
  check(
    "Paseo registration",
    entry === undefined ? "warn" : entry.enabled !== false,
    entry === undefined ? "not registered; run scripts/install.sh" : `${entry.source}:${entry.path ?? ""}`,
  );

  // The daemon-wide switch is a separate gate from the per-plugin entry, and a
  // missing field means false. Without it every plugin in this daemon stays
  // `disabled`, which looks like a broken install but is really a consent step.
  const master = config.pluginsEnabled === true;
  check(
    "pluginsEnabled (daemon switch)",
    master ? true : false,
    master
      ? "on"
      : entry === undefined
        ? "off; required before any plugin can start"
        : "off, so this plugin reports status \"disabled\"; enable in Paseo Settings > Plugins or re-run install.sh --enable-plugins",
  );
  // Report the running daemon's version when it can be read from the app bundle.
  const appPath = "/Applications/Paseo.app/Contents/Info.plist";
  if (existsSync(appPath)) {
    const plist = readFileSync(appPath, "utf8");
    const match = /CFBundleShortVersionString<\/key>\s*<string>([^<]+)</.exec(plist);
    if (match !== null) {
      const satisfies = satisfiesLowerBound(match[1], manifest.requirements?.paseo ?? ">=0");
      check("Paseo version", satisfies, `${match[1]} vs requires ${manifest.requirements?.paseo ?? "(unset)"}`);
    }
  }
}

// ---------------------------------------------------------------------------
process.stdout.write("paseo-provider-dsh — doctor\n\n");
process.stdout.write(`  DSH_HOME : ${DSH_HOME}\n`);
process.stdout.write(`  profile  : ${PROFILE}\n`);
process.stdout.write(`  plugin   : ${root}\n\n`);

checkDsh();
const profileDir = checkProfile();
checkBridge(profileDir);
checkPaseo();
await checkHandshake();

const failed = checks.filter((c) => c.ok === false).length;
const warned = checks.filter((c) => c.ok === "warn").length;
process.stdout.write(`\n${checks.length - failed - warned} ok, ${warned} warning(s), ${failed} failure(s)\n`);
if (failed > 0) {
  process.stdout.write('\nNext: run scripts/install.sh (or reinstall the bridge with: dsh plugin --profile ' + PROFILE + " add " + root + '/dsh-bridge)\n');
  process.exit(1);
}
