export function fmtMoney(v: number): string {
  return `$${v.toFixed(2)}`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
