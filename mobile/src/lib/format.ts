/** "now", "5m", "3h", "2d", or a date: how long ago a chat last changed, short enough for a row. */
export function ago(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - timestamp) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "just now", "5m ago": `ago` in a sentence. */
export function agoText(timestamp: number, now = Date.now()): string {
  const short = ago(timestamp, now);
  return short === "now" ? "just now" : /\d$|[mhd]$/.test(short) && !short.includes(" ") ? `${short} ago` : short;
}
