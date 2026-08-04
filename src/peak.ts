/**
 * Peak-pricing schedule logic (pure, framework-free).
 *
 * DeepSeek's official pricing page declares that during peak hours all
 * billing items are charged at 2x the regular price. Peak hours are
 * 09:00-12:00 and 14:00-18:00 Beijing time (UTC+8), daily. There is no
 * public API to query the current price tier, so the schedule is computed
 * locally from the clock. Windows are configurable and default to the
 * official DeepSeek windows.
 */

export type PeakWindow = readonly [startHour: number, endHour: number]

/** Official DeepSeek peak windows, Beijing time. */
export const DEFAULT_PEAK_WINDOWS: readonly PeakWindow[] = [
  [9, 12],
  [14, 18],
]

/** Beijing is UTC+8, year-round (no DST). */
export const BEIJING_UTC_OFFSET_HOURS = 8

/** Official peak-price multiplier (2x). */
export const DEFAULT_PEAK_MULTIPLIER = 2

/** Provider IDs that are subject to peak pricing. */
export const DEFAULT_TARGET_PROVIDERS: readonly string[] = ["deepseek"]

export interface PeakScheduleOptions {
  /** Peak windows as [startHour, endHour] in local-shifted time. */
  windows?: readonly PeakWindow[]
  /** UTC offset of the schedule clock (defaults to Beijing, 8). */
  tzOffsetHours?: number
}

/** Shift a Date into the schedule timezone and return the minute-of-day. */
function minuteOfDay(date: Date, tzOffsetHours: number): number {
  const shifted = new Date(date.getTime() + tzOffsetHours * 3_600_000)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/** True when `date` falls inside any peak window (schedule-local time). */
export function isPeakTime(
  date: Date = new Date(),
  options: PeakScheduleOptions = {},
): boolean {
  const tz = options.tzOffsetHours ?? BEIJING_UTC_OFFSET_HOURS
  const minutes = minuteOfDay(date, tz)
  const hours = minutes / 60
  const windows = options.windows ?? DEFAULT_PEAK_WINDOWS
  return windows.some(([start, end]) => hours >= start && hours < end)
}

/**
 * Next moment at which the current or next peak window ends, in the
 * schedule timezone. Used to tell the user when sending becomes cheap
 * again. Always returns a strictly-future instant for valid windows.
 *
 * Math: shift the instant into the schedule clock ("Beijing wall time as
 * if UTC"), find the day start in that shifted clock, add the window's end
 * offset, then shift back to real epoch by subtracting the timezone.
 */
export function nextOffPeakEnd(
  date: Date = new Date(),
  options: PeakScheduleOptions = {},
): Date {
  const tz = options.tzOffsetHours ?? BEIJING_UTC_OFFSET_HOURS
  const windows = options.windows ?? DEFAULT_PEAK_WINDOWS
  if (windows.length === 0) return date

  const shiftedMs = date.getTime() + tz * 3_600_000
  const shifted = new Date(shiftedMs)
  const dayStartShiftedMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  )
  const nowOffsetMs = shiftedMs - dayStartShiftedMs

  for (const [, end] of windows) {
    const endMs = end * 3_600_000
    if (nowOffsetMs < endMs) {
      // A window is not finished yet: the next off-peak moment is its end.
      return new Date(dayStartShiftedMs + endMs - tz * 3_600_000)
    }
    // nowOffsetMs >= endMs for this window; continue to the next window.
  }
  // Past every window today: off-peak resumes at the first window's end tomorrow.
  const firstEndMs = (windows[0]?.[1] ?? 24) * 3_600_000
  return new Date(dayStartShiftedMs + 86_400_000 + firstEndMs - tz * 3_600_000)
}

/** Format a Date as "HH:MM" in the schedule timezone. */
export function formatScheduleClock(
  date: Date,
  tzOffsetHours: number = BEIJING_UTC_OFFSET_HOURS,
): string {
  const shifted = new Date(date.getTime() + tzOffsetHours * 3_600_000)
  const hh = String(shifted.getUTCHours()).padStart(2, "0")
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0")
  return `${hh}:${mm}`
}

/** Case-insensitive match of a provider ID against the configured list. */
export function isTargetProvider(
  providerID: string | undefined,
  providers: readonly string[] = DEFAULT_TARGET_PROVIDERS,
): boolean {
  if (!providerID) return false
  const id = providerID.toLowerCase()
  return providers.some((p) => id === p.toLowerCase())
}
