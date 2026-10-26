#!/usr/bin/env node
/**
 * Mirror the user's LLM provider configuration into the Paseo-owned DSH profile.
 *
 * Why this exists
 * ---------------
 * The provider runs a DEDICATED DSH profile (`paseo-dsh`) so that installing this
 * plugin can never change the harness the user already runs. The cost of that
 * isolation is that a profile-local LLM configuration - the custom providers a
 * user added to their own `desktop` or `web` profile - is not inherited. The
 * symptom is subtle and confusing: the models work in DSH itself, but Paseo only
 * lists the built-in `deepseek-official` / `deepseek-account` routes.
 *
 * This script closes that gap by copying exactly one thing: the `llm-pi-ai`
 * entry's `config.providers` map. Nothing else is mirrored, and in particular
 * `agent-default-model` is deliberately NOT copied, so the Paseo profile keeps
 * the harness default (official `deepseek-flash`) unless the user asks otherwise.
 *
 * Merge semantics that make this non-obvious
 * ------------------------------------------
 * DSH applies a patch entry by replacing each top-level key of the target entry
 * (`applyEntryPatches` assigns `target[key] = value`). `config` is therefore
 * replaced wholesale, not deep-merged. A patch that supplied only one provider
 * would silently delete the rest, so this script always writes the COMPLETE
 * provider map it resolved.
 *
 * Safety
 * ------
 * - Only the Paseo profile's patch layer is written; source profiles are read-only.
 * - The written block is delimited by markers so re-runs replace it in place
 *   instead of appending duplicates.
 * - Any failure (missing source, unreadable YAML) is reported and the profile is
 *   left untouched, because a half-written patch layer would stop DSH from booting.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Marker delimiting the managed block, so re-runs replace rather than append. */
const BEGIN = "# >>> paseo-provider-dsh: inherited llm providers (managed block) >>>";
const END = "# <<< paseo-provider-dsh: inherited llm providers <<<";

/** Profiles whose LLM configuration must never be modified. */
const FORBIDDEN_TARGETS = new Set(["web", "desktop", "headless"]);

/** Parse CLI flags. */
function parseArgs(argv) {
  const options = {
    target: process.env.DSH_PASEO_PROFILE ?? "paseo-dsh",
    source: process.env.DSH_PASEO_LLM_SOURCE ?? "desktop",
    dshHome: process.env.DSH_HOME ?? join(homedir(), ".dsh"),
    dryRun: false,
    quiet: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--target=")) options.target = arg.slice("--target=".length);
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length);
    else if (arg.startsWith("--dsh-home=")) options.dshHome = arg.slice("--dsh-home=".length);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--quiet") options.quiet = true;
  }
  return options;
}

/** Read one profile's patch layer text. */
function readPatch(dshHome, profile) {
  const path = join(dshHome, "profiles", profile, "cordis.patch.yml");
  if (!existsSync(path)) return undefined;
  return { path, text: readFileSync(path, "utf8") };
}

/**
 * Extract the raw YAML text of the `llm-pi-ai` entry from a patch layer.
 *
 * A full YAML parser is avoided on purpose: this package must not add a runtime
 * dependency to the plugin, and the entry is a simple top-level list item. The
 * extraction is line-based, anchored on the entry id, and stops at the next
 * top-level `- id:` or at end of file.
 *
 * @returns the entry's text, without a trailing newline
 */
function extractLlmEntry(text) {
  const lines = text.split("\n");
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^-\s+id:\s*llm-pi-ai\s*$/.test(lines[index].trimEnd())) {
      start = index;
      break;
    }
  }
  if (start === -1) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    // A new top-level list item ends the entry.
    if (/^-\s+(id|insert):/.test(lines[index])) {
      end = index;
      break;
    }
  }
  // Trim trailing blank lines so the block stays compact.
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end).join("\n");
}

/** Collect provider ids from an `llm-pi-ai` entry, for reporting and verification. */
function providerIdsOf(entryText) {
  if (entryText === undefined) return [];
  const match = /^(\s*)providers:\s*$/m.exec(entryText);
  if (match === null) return [];
  const baseIndent = match[1].length;
  const ids = [];
  const lines = entryText.split("\n");
  let inProviders = false;
  for (const line of lines) {
    if (/^\s*providers:\s*$/.test(line)) {
      inProviders = true;
      continue;
    }
    if (!inProviders) continue;
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    // A shallower key ends the providers map.
    if (indent <= baseIndent) break;
    const providerMatch = /^(\s+)([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (providerMatch !== null && providerMatch[1].length === baseIndent + 2) {
      ids.push(providerMatch[2]);
    }
  }
  return ids;
}

/**
 * Indent a block so it sits correctly inside the patch list.
 *
 * The extracted entry is already a top-level `- id: llm-pi-ai` list item, which is
 * exactly the shape a patch layer expects, so no re-indentation is needed. The
 * function exists to make that contract explicit and to fail loudly if the source
 * shape ever changes.
 */
function asPatchEntry(entryText) {
  if (!/^-\s+id:\s*llm-pi-ai\s*$/m.test(entryText)) {
    throw new Error("extracted llm-pi-ai entry does not start with a top-level list item");
  }
  return entryText;
}

/** Remove a previously written managed block, if present. */
function stripManagedBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start === -1) return text;
  const endMarker = text.indexOf(END, start);
  if (endMarker === -1) return text;
  const after = text.slice(endMarker + END.length);
  // Drop the single blank line the writer adds after the block.
  return `${text.slice(0, start)}${after.replace(/^\n/, "")}`.replace(/\n{3,}/g, "\n\n");
}

/** Main. */
function main() {
  const options = parseArgs(process.argv.slice(2));
  const say = (message) => {
    if (!options.quiet) process.stdout.write(`  ${message}\n`);
  };

  if (FORBIDDEN_TARGETS.has(options.target)) {
    process.stderr.write(
      `refusing to write inherited providers into the '${options.target}' profile: it belongs to your existing DeepSeek Harness\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (options.source === options.target) {
    process.stderr.write(`source and target are the same profile (${options.target}); nothing to inherit\n`);
    process.exitCode = 1;
    return;
  }

  const source = readPatch(options.dshHome, options.source);
  if (source === undefined) {
    say(`source profile '${options.source}' not found under ${join(options.dshHome, "profiles")} - skipping inheritance`);
    return;
  }
  const sourceEntry = extractLlmEntry(source.text);
  if (sourceEntry === undefined) {
    say(`source profile '${options.source}' defines no llm-pi-ai entry - skipping inheritance`);
    return;
  }
  const providers = providerIdsOf(sourceEntry);
  if (providers.length === 0) {
    say(`source profile '${options.source}' declares no custom providers - skipping inheritance`);
    return;
  }

  const target = readPatch(options.dshHome, options.target);
  if (target === undefined) {
    process.stderr.write(
      `target profile '${options.target}' does not exist under ${join(options.dshHome, "profiles")}; run scripts/install.sh first\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Replace any previous managed block so re-runs are idempotent.
  const base = stripManagedBlock(target.text).replace(/\s+$/, "");
  const block = [
    BEGIN,
    "# Mirrors the LLM providers of the source profile so models that work in",
    "# DeepSeek Harness are also selectable in Paseo. `config` is REPLACED, not",
    "# merged, by the DSH patch loader, so the full provider map is written here.",
    "# agent-default-model is intentionally NOT mirrored: Paseo keeps the harness",
    "# default (deepseek-official/deepseek-flash).",
    asPatchEntry(sourceEntry),
    END,
    "",
  ].join("\n");
  const next = `${base}\n\n${block}`;

  if (options.dryRun) {
    say(`would write providers [${providers.join(", ")}] into ${target.path}`);
    return;
  }

  // Keep a backup before the first write of each run, then write atomically
  // enough for a config file: a partial write would stop the profile booting.
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  copyFileSync(target.path, `${target.path}.bak.llm.${stamp}`);
  writeFileSync(target.path, next);
  say(`inherited providers [${providers.join(", ")}] from '${options.source}' into '${options.target}'`);
  say(`wrote ${target.path}`);
}

main();
