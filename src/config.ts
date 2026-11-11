import { homedir, platform } from "node:os"
import { join, posix, win32 } from "node:path"
import type { PluginOptions } from "./types"

export function defaultDataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platformName: NodeJS.Platform = platform(),
  home = homedir(),
) {
  if (env.OPENCODE_GO_POOL_DIR) return expandHome(env.OPENCODE_GO_POOL_DIR, home, platformName)
  if (platformName === "win32") {
    return win32.join(env.APPDATA ?? win32.join(home, "AppData", "Roaming"), "opencode-go-pool")
  }
  if (platformName === "darwin") {
    return posix.join(home, "Library", "Application Support", "opencode-go-pool")
  }
  return posix.join(env.XDG_DATA_HOME ?? posix.join(home, ".local", "share"), "opencode-go-pool")
}

export function dataDirectory(options?: PluginOptions) {
  return options?.dataDir ? expandHome(options.dataDir) : defaultDataDirectory()
}

export function configDirectory(env: NodeJS.ProcessEnv = process.env, platformName: NodeJS.Platform = platform(), home = homedir()) {
  const joinPath = platformName === "win32" ? win32.join : posix.join
  return joinPath(env.XDG_CONFIG_HOME ?? joinPath(home, ".config"), "opencode")
}

function expandHome(value: string, home = homedir(), platformName: NodeJS.Platform = platform()) {
  if (value === "~") return home
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return (platformName === "win32" ? win32 : posix).join(home, value.slice(2))
  }
  return value
}

export function paths(directory: string) {
  return {
    directory,
    accounts: join(directory, "accounts.json"),
    quota: join(directory, "quota.json"),
    cooldown: join(directory, "cooldown.json"),
    status: join(directory, "status.json"),
    switches: join(directory, "switches.json"),
    dashboard: join(directory, "dashboard.json"),
    clearRequest: join(directory, "clear-request.json"),
    events: join(directory, "events"),
    log: join(directory, "plugin.log"),
  }
}

export const DEFAULT_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
export const DEFAULT_UPSTREAM = "https://opencode.ai"

export function settings(options?: PluginOptions) {
  return {
    owner: options?.owner,
    switchAtPercent: clamp(options?.switchAtPercent ?? 100, 1, 100),
    refreshSeconds: Math.max(1, options?.refreshSeconds ?? 60),
    dashboard: options?.dashboard ?? false,
    dashboardPort: options?.dashboardPort ?? 0,
    usageURL: (options?.usageURL ?? DEFAULT_USAGE_URL).replace(/\/+$/, ""),
    upstream: (options?.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, ""),
    requestTimeoutMs: Math.max(500, options?.requestTimeoutMs ?? 5000),
    debug: options?.debug ?? false,
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return maximum
  return Math.min(maximum, Math.max(minimum, value))
}
