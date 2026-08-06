import { describe, expect, test } from "bun:test"
import {
  BEIJING_UTC_OFFSET_HOURS,
  isPeakTime,
  isTargetProvider,
  msUntilOffPeak,
  nextOffPeakEnd,
  formatScheduleClock,
} from "./peak"
import { resolveOptions } from "./config"

// Helper: Beijing time (UTC+8) without DST.
function beijing(y: number, mo: number, d: number, h: number, mi = 0): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi))
}

describe("isPeakTime", () => {
  test("inside morning window (09:00-12:00)", () => {
    expect(isPeakTime(beijing(2026, 8, 4, 9, 0))).toBe(true)
    expect(isPeakTime(beijing(2026, 8, 4, 11, 59))).toBe(true)
  })

  test("inside afternoon window (14:00-18:00)", () => {
    expect(isPeakTime(beijing(2026, 8, 4, 14, 0))).toBe(true)
    expect(isPeakTime(beijing(2026, 8, 4, 17, 59))).toBe(true)
  })

  test("window boundaries are half-open", () => {
    expect(isPeakTime(beijing(2026, 8, 4, 12, 0))).toBe(false)
    expect(isPeakTime(beijing(2026, 8, 4, 18, 0))).toBe(false)
    expect(isPeakTime(beijing(2026, 8, 4, 8, 59))).toBe(false)
    expect(isPeakTime(beijing(2026, 8, 4, 13, 59))).toBe(false)
  })

  test("off-peak at midnight and early morning", () => {
    expect(isPeakTime(beijing(2026, 8, 4, 0, 30))).toBe(false)
    expect(isPeakTime(beijing(2026, 8, 4, 6, 0))).toBe(false)
    expect(isPeakTime(beijing(2026, 8, 4, 23, 0))).toBe(false)
  })

  test("custom windows override defaults", () => {
    const options = { windows: [[20, 22]] as const }
    expect(isPeakTime(beijing(2026, 8, 4, 21, 0), options)).toBe(true)
    expect(isPeakTime(beijing(2026, 8, 4, 10, 0), options)).toBe(false)
  })

  test("local-time interpretation honors tzOffsetHours", () => {
    // Interpret the same instant under Beijing vs UTC: 10:00 Beijing is 02:00 UTC.
    const instant = beijing(2026, 8, 4, 10, 0) // 02:00 UTC
    expect(isPeakTime(instant, { tzOffsetHours: BEIJING_UTC_OFFSET_HOURS })).toBe(true)
    expect(isPeakTime(instant, { tzOffsetHours: 0 })).toBe(false)
  })
})

describe("nextOffPeakEnd", () => {
  test("during morning window ends at 12:00 same day", () => {
    const end = nextOffPeakEnd(beijing(2026, 8, 4, 10, 30))
    expect(end.getTime()).toBe(beijing(2026, 8, 4, 12, 0).getTime())
  })

  test("during afternoon window ends at 18:00 same day", () => {
    const end = nextOffPeakEnd(beijing(2026, 8, 4, 16, 15))
    expect(end.getTime()).toBe(beijing(2026, 8, 4, 18, 0).getTime())
  })

  test("between windows ends at 18:00 (next window's end)", () => {
    const end = nextOffPeakEnd(beijing(2026, 8, 4, 12, 30))
    expect(end.getTime()).toBe(beijing(2026, 8, 4, 18, 0).getTime())
  })

  test("before first window ends at 12:00 same day", () => {
    const end = nextOffPeakEnd(beijing(2026, 8, 4, 7, 0))
    expect(end.getTime()).toBe(beijing(2026, 8, 4, 12, 0).getTime())
  })

  test("after all windows ends at 12:00 tomorrow", () => {
    const end = nextOffPeakEnd(beijing(2026, 8, 4, 20, 0))
    expect(end.getTime()).toBe(beijing(2026, 8, 5, 12, 0).getTime())
  })

  test("always strictly in the future for valid windows", () => {
    const now = beijing(2026, 8, 4, 11, 0)
    expect(nextOffPeakEnd(now).getTime()).toBeGreaterThan(now.getTime())
  })
})

describe("msUntilOffPeak", () => {
  test("delay equals the distance to the current window's end", () => {
    const now = beijing(2026, 8, 4, 10, 30)
    expect(msUntilOffPeak(now)).toBe(
      beijing(2026, 8, 4, 12, 0).getTime() - now.getTime(),
    )
  })

  test("afternoon window delay lands on 18:00", () => {
    const now = beijing(2026, 8, 4, 15, 45)
    expect(msUntilOffPeak(now)).toBe(
      beijing(2026, 8, 4, 18, 0).getTime() - now.getTime(),
    )
  })

  test("strictly positive for valid windows", () => {
    expect(msUntilOffPeak(beijing(2026, 8, 4, 11, 59))).toBeGreaterThan(0)
    expect(msUntilOffPeak(beijing(2026, 8, 4, 23, 59))).toBeGreaterThan(0)
  })

  test("honors custom windows", () => {
    const now = beijing(2026, 8, 4, 20, 30)
    const options = { windows: [[20, 22]] as const }
    expect(msUntilOffPeak(now, options)).toBe(
      beijing(2026, 8, 4, 22, 0).getTime() - now.getTime(),
    )
  })
})

describe("formatScheduleClock", () => {
  test("formats Beijing clock", () => {
    expect(formatScheduleClock(beijing(2026, 8, 4, 9, 5))).toBe("09:05")
    expect(formatScheduleClock(beijing(2026, 8, 4, 17, 59))).toBe("17:59")
  })
})

describe("isTargetProvider", () => {
  test("matches deepseek case-insensitively", () => {
    expect(isTargetProvider("deepseek")).toBe(true)
    expect(isTargetProvider("DeepSeek")).toBe(true)
    expect(isTargetProvider("openai")).toBe(false)
    expect(isTargetProvider(undefined)).toBe(false)
  })

  test("honors custom provider list", () => {
    expect(isTargetProvider("openai", ["openai"])).toBe(true)
    expect(isTargetProvider("deepseek", ["openai"])).toBe(false)
  })
})

describe("resolveOptions", () => {
  test("defaults", () => {
    const options = resolveOptions(undefined)
    expect(options.providers).toEqual(["deepseek"])
    expect(options.multiplier).toBe(2)
    expect(options.tzOffsetHours).toBe(8)
    expect(options.dryRun).toBe(false)
    expect(options.windows).toEqual([
      [9, 12],
      [14, 18],
    ])
  })

  test("merges valid overrides", () => {
    const options = resolveOptions({
      providers: ["DeepSeek", "openai"],
      windows: [
        [10, 13],
        [15, 19],
      ],
      multiplier: 1.5,
      tzOffsetHours: 0,
      dryRun: true,
      forceKey: "ctrl+o",
    })
    expect(options.providers).toEqual(["deepseek", "openai"])
    expect(options.windows).toEqual([
      [10, 13],
      [15, 19],
    ])
    expect(options.multiplier).toBe(1.5)
    expect(options.tzOffsetHours).toBe(0)
    expect(options.dryRun).toBe(true)
    expect(options.forceKey).toBe("ctrl+o")
  })

  test("rejects malformed values", () => {
    const options = resolveOptions({
      providers: "deepseek",
      windows: [[5, 2]],
      multiplier: -1,
      tzOffsetHours: "eight",
    })
    expect(options.providers).toEqual(["deepseek"])
    expect(options.multiplier).toBe(2)
    expect(options.tzOffsetHours).toBe(8)
  })
})
