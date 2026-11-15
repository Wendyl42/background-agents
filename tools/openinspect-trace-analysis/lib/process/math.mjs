/** Arithmetic stays integral until converting a duration (never an absolute clock) to display ms. */
export function ns(value) {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}
export const encoded = (value) => (value === null ? null : value.toString());
export function elapsed(start, end) {
  const a = ns(start),
    b = ns(end);
  return a !== null && b !== null && b >= a ? b - a : null;
}
export function union(intervals, clip = null) {
  const values = intervals
    .flatMap(([start, end]) => {
      let a = ns(start),
        b = ns(end);
      if (a === null || b === null || b < a) return [];
      if (clip) {
        const lo = ns(clip[0]),
          hi = ns(clip[1]);
        if (lo === null || hi === null || hi < lo) return [];
        if (a < lo) a = lo;
        if (b > hi) b = hi;
      }
      return b >= a ? [[a, b]] : [];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const merged = [];
  for (const [a, b] of values) {
    const last = merged.at(-1);
    if (last && a <= last[1]) {
      if (b > last[1]) last[1] = b;
    } else merged.push([a, b]);
  }
  return {
    duration_ns: encoded(merged.reduce((total, [a, b]) => total + b - a, 0n)),
    intervals: merged.map(([a, b]) => [encoded(a), encoded(b)]),
  };
}
export function total(values) {
  const known = values.map(ns).filter((value) => value !== null);
  return {
    known_ns: encoded(known.reduce((a, b) => a + b, 0n)),
    missing: values.length - known.length,
    total_ns: known.length === values.length ? encoded(known.reduce((a, b) => a + b, 0n)) : null,
  };
}
export function distribution(values) {
  const valid = values
    .map(ns)
    .filter((x) => x !== null)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const percentile = (p) =>
    valid.length ? encoded(valid[Math.max(0, Math.ceil(valid.length * p) - 1)]) : null;
  return {
    known_count: valid.length,
    missing_count: values.length - valid.length,
    p50_ns: percentile(0.5),
    p95_ns: percentile(0.95),
    convention: "nearest_rank",
    ...total(values),
  };
}
