/**
 * Date utilities — mirrors the web app's timezone-safe strategy.
 * Dates are stored as UTC noon (12:00:00 UTC) so the date is
 * the same in all timezones from UTC-12 to UTC+12.
 */

export function parseLocalDateToUTC(dateStr: string): Date {
  if (dateStr.includes("T")) return new Date(dateStr);
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

export function todayAtNoonUTC(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0)
  );
}

export function formatDateForOutput(date: string | Date | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
