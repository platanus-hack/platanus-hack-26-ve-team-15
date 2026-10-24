// Límite de tasa de ventana fija en memoria (contrato §4, 429).
export function createRateLimiter(now) {
  const buckets = new Map();
  return {
    /** true si la clave aún está dentro del límite en la ventana actual. */
    hit(key, max, windowS) {
      const t = now();
      const b = buckets.get(key);
      if (!b || t - b.start >= windowS) {
        buckets.set(key, { start: t, n: 1 });
        if (buckets.size > 50_000) for (const [k, v] of buckets) if (t - v.start >= windowS) buckets.delete(k);
        return true;
      }
      b.n += 1;
      return b.n <= max;
    },
    size: () => buckets.size,
  };
}
