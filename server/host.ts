/**
 * DSH host lifecycle for the Paseo side.
 *
 * The provider drives a real `dsh` process. This module owns that process and
 * the socket channel to it:
 *
 * - One host per provider connection. Paseo gives each provider `connect()` its
 *   own lifecycle, so tying the host to the connection means a disconnect tears
 *   the host down and a reconnect starts a fresh one without leaking processes.
 * - The host is launched with `DSH_PASEO_BRIDGE_SOCKET` pointing at a socket the
 *   plugin creates, so stdout/stderr stay free for DSH's own logging. A P0
 *   measurement showed DSH writing diagnostics to stdout, which rules out using
 *   stdout as the protocol channel.
 * - The socket path lives under the DSH home in a 0700 directory, so the channel
 *   is owner-private: no TCP port is opened and Paseo Remote SSH needs no
 *   forwarding.
 * - A launch override supplied by the Paseo daemon (`request.launch`) wins over
 *   our defaults. That is how a user points the provider at a different `dsh`
 *   binary, which is what a Remote SSH host or a non-standard install needs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Shape of the daemon-resolved launch override (mirrors the SDK's ProviderLaunch). */
export interface LaunchOverride {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

/** Where the host should be spawned. */
export interface HostLaunchRequest {
  /** Daemon-resolved override, when the user configured one. */
  readonly launch?: LaunchOverride;
  /** Extra environment from the Paseo session config. */
  readonly env: Readonly<Record<string, string>>;
}

/** Resolved host plan, logged so a failure is diagnosable. */
export interface HostPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly socketPath: string;
}

/** Default profile name the installer creates. */
export const DEFAULT_PROFILE = "paseo-dsh";

/** Resolve the DSH home the same way DSH does (`$DSH_HOME`, else `~/.dsh`). */
export function resolveDshHome(env: NodeJS.ProcessEnv): string {
  const configured = env.DSH_HOME;
  if (configured !== undefined && configured.trim().length > 0) return configured;
  return join(homedir(), ".dsh");
}

/** Directory holding the bridge socket; owner-private. */
export function bridgeRuntimeDir(dshHome: string): string {
  return join(dshHome, "paseo-bridge");
}

/**
 * Maximum useful socket path length.
 *
 * `sockaddr_un.sun_path` is 104 bytes on macOS/BSD and 108 on Linux, including
 * the terminator. A path that exceeds it fails with `EINVAL` from `listen()`,
 * which is what a deeply nested `DSH_HOME` under a temp directory produces.
 * Keeping the budget below the smallest limit makes the same code work on both.
 */
const MAX_SOCKET_PATH = 100;

/**
 * Choose a socket path that fits in `sockaddr_un`.
 *
 * Preference order:
 * 1. Inside the DSH home (self-describing, cleaned up with the install).
 * 2. The OS temp directory (short on macOS, still owner-private under a 0700 dir).
 *
 * A path that cannot be made to fit is a configuration error worth failing loudly
 * on, because silently truncating it would create a socket nobody can find.
 *
 * @param dshHome - resolved DSH home.
 * @param suffix - short unique suffix for this provider connection.
 * @throws Error when no candidate fits the platform limit.
 */
export function resolveSocketPath(dshHome: string, suffix: string): string {
  const candidates = [
    join(bridgeRuntimeDir(dshHome), `b-${suffix}.sock`),
    join(tmpdir(), "dsh-paseo", `b-${suffix}.sock`),
    join("/tmp", `dsh-pb-${suffix}.sock`),
  ];
  for (const candidate of candidates) {
    if (Buffer.byteLength(candidate) < MAX_SOCKET_PATH) return candidate;
  }
  throw new Error(
    `cannot place the bridge socket within ${MAX_SOCKET_PATH} bytes; set DSH_HOME to a shorter path (tried ${candidates.join(", ")})`,
  );
}

/**
 * Build the host plan for one connection.
 *
 * @param request - launch inputs from Paseo.
 * @param baseEnv - environment to inherit (normally `process.env`).
 * @returns the exact command, arguments, environment and socket path to use.
 */
export function planHost(request: HostLaunchRequest, baseEnv: NodeJS.ProcessEnv): HostPlan {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...request.env };
  const dshHome = resolveDshHome(env);
  const socketPath = resolveSocketPath(dshHome, `${process.pid.toString(36)}-${randomUUID().slice(0, 6)}`);

  // The profile is fixed by install.sh; the bridge socket is what makes this
  // host the Paseo-owned one rather than the user's own harness.
  const defaultArgs = ["--profile", env.DSH_PASEO_PROFILE ?? DEFAULT_PROFILE, "--port", "0", "--no-open"];
  const command = request.launch?.command ?? "dsh";
  const args = request.launch !== undefined ? [...request.launch.args, ...defaultArgs] : defaultArgs;

  return {
    command,
    args,
    env: {
      ...env,
      ...(request.launch?.env ?? {}),
      DSH_HOME: dshHome,
      DSH_PASEO_BRIDGE_SOCKET: socketPath,
    },
    socketPath,
  };
}

/** One live bridge channel to a DSH host. */
export interface BridgeChannel {
  /** The connected socket. */
  readonly socket: Socket;
  /** Terminate the host and remove the socket. */
  close(): Promise<void>;
}

/** Raised when the host could not be started or reached. */
export class HostStartError extends Error {
  readonly diagnostic: string;

  constructor(message: string, diagnostic: string) {
    super(message);
    this.name = "HostStartError";
    this.diagnostic = diagnostic;
  }
}

/**
 * Spawn one DSH host and wait for its bridge socket.
 *
 * @param plan - resolved launch plan.
 * @param options - timeouts and an abort signal.
 * @returns the connected socket plus a closer that reaps the process.
 * @throws HostStartError when the process exits early or the socket never opens.
 */
export async function startHost(
  plan: HostPlan,
  options: { timeoutMs?: number; signal?: AbortSignal; onStderr?: (line: string) => void },
): Promise<BridgeChannel> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  // The socket may live under the DSH home or under the temp directory; create
  // whichever parent the resolved path needs.
  mkdirSync(dirname(plan.socketPath), { recursive: true, mode: 0o700 });

  const child: ChildProcess = spawn(plan.command, [...plan.args], {
    env: plan.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const stderrLines: string[] = [];
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  child.stdout?.on("data", (chunk: Buffer) => {
    // Host stdout is not our channel; keep it for diagnostics only.
    const text = chunk.toString();
    for (const line of text.split("\n")) {
      if (line.trim()) options.onStderr?.(`stdout: ${line}`);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      stderrLines.push(line);
      if (stderrLines.length > 200) stderrLines.shift();
      options.onStderr?.(line);
    }
  });
  child.on("error", (error) => {
    stderrLines.push(`spawn error: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const closer = async (): Promise<void> => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    // Give DSH a moment to flush session logs and release its write locks.
    const deadline = Date.now() + 8_000;
    while (exited === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (exited === undefined) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    try {
      rmSync(plan.socketPath, { force: true });
    } catch {
      // Best effort.
    }
  };

  try {
    const socket = await waitForSocket(plan.socketPath, {
      timeoutMs,
      signal: options.signal,
      exited: () => exited,
      stderr: () => stderrLines.join("\n"),
    });
    return { socket, close: closer };
  } catch (error) {
    await closer();
    throw error;
  }
}

/** Poll for the socket file and connect to it. */
async function waitForSocket(
  socketPath: string,
  state: {
    timeoutMs: number;
    signal?: AbortSignal;
    exited(): { code: number | null; signal: NodeJS.Signals | null } | undefined;
    stderr(): string;
  },
): Promise<Socket> {
  const deadline = Date.now() + state.timeoutMs;
  for (;;) {
    if (state.signal?.aborted === true) {
      throw new HostStartError("bridge start aborted", state.stderr());
    }
    const exit = state.exited();
    if (exit !== undefined && !existsSync(socketPath)) {
      throw new HostStartError(
        `dsh host exited before opening the bridge channel (code ${String(exit.code)}, signal ${String(exit.signal)})`,
        state.stderr(),
      );
    }
    if (existsSync(socketPath)) {
      try {
        return await connectSocket(socketPath);
      } catch (error) {
        if (Date.now() > deadline) {
          throw new HostStartError(
            `bridge socket exists but refused a connection: ${error instanceof Error ? error.message : String(error)}`,
            state.stderr(),
          );
        }
      }
    }
    if (Date.now() > deadline) {
      throw new HostStartError(
        `dsh host did not open the bridge socket within ${state.timeoutMs}ms`,
        state.stderr(),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Connect one socket with a short per-attempt timeout. */
function connectSocket(socketPath: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connect timeout"));
    }, 2_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
  });
}

/**
 * Probe whether a usable `dsh` binary exists.
 *
 * Used by the provider's `status()` so Paseo shows "unavailable" with an
 * actionable diagnostic instead of failing inside the first session.
 */
export async function probeDsh(
  request: { launch?: LaunchOverride },
  baseEnv: NodeJS.ProcessEnv,
): Promise<{ available: true; diagnostic?: string } | { available: false; diagnostic: string }> {
  const command = request.launch?.command ?? "dsh";
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, ["--version"], {
      env: { ...baseEnv, ...(request.launch?.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      resolve({ code: null, stdout, stderr: `${stderr}timed out` });
    }, 10_000);
  });

  if (result.code !== 0) {
    return {
      available: false,
      diagnostic: `\`${command} --version\` failed (${result.code === null ? "no exit" : `code ${result.code}`}): ${result.stderr.trim() || "no output"}. Install the DeepSeek Harness CLI or set a launch command for this provider.`,
    };
  }
  const version = result.stdout.trim().split("\n")[0] ?? "";
  return { available: true, ...(version.length > 0 ? { diagnostic: version } : {}) };
}
