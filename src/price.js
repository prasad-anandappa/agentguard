// NEAR/USD price oracle for display-only USD estimates.
//
// Fetches from a public price endpoint (CoinGecko simple price, no key),
// caches the result, and degrades to null when offline. It NEVER feeds the
// policy engine — a verdict must not depend on a price feed.

const DEFAULT_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd';

export function createPriceOracle({ fetchFn = fetch, url = DEFAULT_URL, ttlMs = 5 * 60_000, timeoutMs = 3000 } = {}) {
  let cache = null; // { usd, at }
  return {
    async getPrice(now = Date.now()) {
      if (cache && now - cache.at < ttlMs) return { ...cache, cached: true };
      try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`price HTTP ${res.status}`);
        const json = await res.json();
        const usd = Number(json?.near?.usd);
        if (!Number.isFinite(usd) || usd <= 0) throw new Error('price payload missing near.usd');
        cache = { usd, at: now };
        return { ...cache, cached: false };
      } catch (_) {
        // Offline / rate-limited: reuse a stale cache if we have one, else null.
        if (cache) return { ...cache, cached: true, stale: true };
        return null;
      }
    },
  };
}

export const priceOracle = createPriceOracle();

export function usdEstimate(amountNear, price) {
  if (!price || !Number.isFinite(price.usd) || !Number.isFinite(Number(amountNear))) return null;
  return Math.round(Number(amountNear) * price.usd * 100) / 100;
}
