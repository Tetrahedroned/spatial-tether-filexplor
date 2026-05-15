export function formatDate(d: Date): string {
  return d.toISOString();
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
