/**
 * Plugin option resolution. Options can be supplied through the plugin
 * entry in `tui.json` (or the opencode config `plugin` array), e.g.:
 *
 *   "plugin": [["opencode-peak-guard", { "providers": ["deepseek"], "dryRun": true }]]
 */
import {
  type PeakWindow,
  DEFAULT_PEAK_WINDOWS,
  DEFAULT_PEAK_MULTIPLIER,
  DEFAULT_TARGET_PROVIDERS,
} from "./peak"

export interface CostGuardOptions {
  /** Provider IDs subject to peak pricing (case-insensitive). */
  providers: readonly string[]
  /** Peak windows as [startHour, endHour] in the schedule timezone. */
  windows: readonly PeakWindow[]
  /** Peak price multiplier, for display only. */
  multiplier: number
  /** UTC offset of the schedule clock (Beijing = 8). */
  tzOffsetHours: number
  /** Log/inform instead of blocking: still sends, but warns. */
  dryRun: boolean
  /** Extra key binding to force-send while peak-gated (e.g. "ctrl+o"). */
  forceKey?: string
}

const DEFAULT_OPTIONS: CostGuardOptions = {
  providers: DEFAULT_TARGET_PROVIDERS,
  windows: DEFAULT_PEAK_WINDOWS,
  multiplier: DEFAULT_PEAK_MULTIPLIER,
  tzOffsetHours: 8,
  dryRun: false,
}

function isValidWindow(value: unknown): value is PeakWindow {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    value[0] >= 0 &&
    value[1] > value[0] &&
    value[1] <= 24
  )
}

/** Merge user-provided options over defaults, discarding malformed values. */
export function resolveOptions(raw: unknown): CostGuardOptions {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return DEFAULT_OPTIONS
  }
  const input = raw as Record<string, unknown>

  const providers =
    Array.isArray(input.providers) &&
    input.providers.every((p) => typeof p === "string")
      ? (input.providers as string[]).map((p) => p.toLowerCase())
      : DEFAULT_OPTIONS.providers

  const windows =
    Array.isArray(input.windows) &&
    input.windows.length > 0 &&
    input.windows.every(isValidWindow)
      ? (input.windows as PeakWindow[])
      : DEFAULT_OPTIONS.windows

  const multiplier =
    typeof input.multiplier === "number" && input.multiplier > 0
      ? input.multiplier
      : DEFAULT_OPTIONS.multiplier

  const tzOffsetHours =
    typeof input.tzOffsetHours === "number" &&
    Number.isFinite(input.tzOffsetHours)
      ? input.tzOffsetHours
      : DEFAULT_OPTIONS.tzOffsetHours

  const dryRun =
    typeof input.dryRun === "boolean" ? input.dryRun : DEFAULT_OPTIONS.dryRun

  const forceKey =
    typeof input.forceKey === "string" && input.forceKey.length > 0
      ? input.forceKey
      : undefined

  return {
    providers,
    windows,
    multiplier,
    tzOffsetHours,
    dryRun,
    ...(forceKey ? { forceKey } : {}),
  }
}
