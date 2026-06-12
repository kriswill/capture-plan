// dates.ts — Date/time helpers

/** Named date directory schemes for vault path construction. */
export type DateScheme = "calendar" | "compact" | "monthly" | "flat"

/** All valid DateScheme values, for runtime validation. */
export const DATE_SCHEMES: readonly DateScheme[] = ["calendar", "compact", "monthly", "flat"]

/** Structured date/time components used for building vault paths and frontmatter. */
export type DateParts = {
  dd: string
  mm: string
  yyyy: string
  monthName: string
  dayName: string
  dateKey: string
  hh: string
  min: string
  datetime: string
  timeStr: string
  ampmTime: string
}

/** Format hours and minutes as a 12-hour AM/PM string (e.g. "2:05 PM"). */
export function formatAmPm(hours: number, minutes: number): string {
  const period = hours >= 12 ? "PM" : "AM"
  const h = hours % 12 || 12
  return `${h}:${String(minutes).padStart(2, "0")} ${period}`
}

/** Extract all date/time components from a Date object for vault path and frontmatter construction. */
export function getDatePartsFor(date: Date): DateParts {
  const dd = String(date.getDate()).padStart(2, "0")
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const yyyy = String(date.getFullYear())
  const hh = String(date.getHours()).padStart(2, "0")
  const min = String(date.getMinutes()).padStart(2, "0")
  const monthName = new Intl.DateTimeFormat("en-US", { month: "long" }).format(date)
  const dayName = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(date)
  return {
    dd,
    mm,
    yyyy,
    monthName,
    dayName,
    hh,
    min,
    dateKey: `${yyyy}-${mm}-${dd}`,
    datetime: `${yyyy}-${mm}-${dd}T${hh}:${min}`,
    timeStr: `${hh}:${min}`,
    ampmTime: formatAmPm(date.getHours(), date.getMinutes()),
  }
}

/** Extract date/time components for the current moment. */
export function getDateParts(): DateParts {
  return getDatePartsFor(new Date())
}

/** Format the date segment of a vault path according to the given scheme. */
export function formatDatePath(scheme: DateScheme, parts: DateParts): string {
  switch (scheme) {
    case "calendar":
      return `${parts.yyyy}/${parts.mm}-${parts.monthName}/${parts.dd}-${parts.dayName}`
    case "compact":
      return `${parts.yyyy}/${parts.mm}-${parts.dd}`
    case "monthly":
      return `${parts.yyyy}/${parts.mm}-${parts.monthName}/${parts.dd}`
    case "flat":
      return `${parts.yyyy}-${parts.mm}-${parts.dd}`
  }
}

/** Detect which DateScheme produced a given date directory path segment. */
export function detectDateScheme(dateSegment: string): DateScheme | undefined {
  if (/^\d{4}\/\d{2}-[A-Z][a-z]+\/\d{2}-[A-Z][a-z]+$/.test(dateSegment)) return "calendar"
  if (/^\d{4}\/\d{2}-[A-Z][a-z]+\/\d{2}$/.test(dateSegment)) return "monthly"
  if (/^\d{4}\/\d{2}-\d{2}$/.test(dateSegment)) return "compact"
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateSegment)) return "flat"
  return undefined
}

/** Convert a millisecond duration to whole seconds for numeric frontmatter fields. */
export function durationSeconds(ms: number): number {
  return Math.round(ms / 1000)
}

/** Format a millisecond duration as a human-readable string (e.g. "3m 12s", "1h 5m"). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (remainingMinutes > 0) return `${hours}h ${remainingMinutes}m`
  return `${hours}h`
}
