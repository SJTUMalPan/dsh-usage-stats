/**
 * Peak/off-peak pricing for DeepSeek models.
 *
 * Pricing rules come from the official page; the catalog in `prices.json` is
 * data, not code, so a price change is a data edit. Two rules matter and are
 * easy to get wrong:
 *
 *   - Peak windows are stated in Beijing time (09:00-12:00, 14:00-18:00) and
 *     apply to weekdays only; weekends and Chinese public holidays are
 *     off-peak in full. Internally everything is evaluated in UTC.
 *   - Off-peak is exactly half of peak, and the discount is determined by the
 *     moment of the call, not by when the report runs.
 *
 * @module dsh-usage-stats/pricing
 */

/**
 * Parse `"HH:MM"` into minutes since midnight.
 * @param {string} hhmm - Clock time.
 * @returns {number} Minutes since midnight.
 */
function minutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * Test whether a UTC instant falls in a half-open window, wrapping midnight
 * when the start is later than the end.
 * @param {number} now - Minutes since midnight.
 * @param {[string, string]} window - `[start, end)` in `"HH:MM"`.
 * @returns {boolean} True when inside the window.
 */
function inWindow(now, window) {
  const start = minutes(window[0])
  const end = minutes(window[1])
  return start <= end ? now >= start && now < end : now >= start || now < end
}

/**
 * Decide whether one call was billed at peak rates.
 * @param {Date} when - Call time (UTC).
 * @param {{utcWindows: [string,string][], weekdaysOnly?: boolean, holidays?: string[]}} peak - Peak definition.
 * @returns {boolean} True when the call is peak.
 */
export function isPeak(when, peak) {
  const day = when.toISOString().slice(0, 10)
  if ((peak.holidays ?? []).includes(day)) return false
  if (peak.weekdaysOnly !== false) {
    const weekday = when.getUTCDay()
    if (weekday === 0 || weekday === 6) return false
  }
  const now = when.getUTCHours() * 60 + when.getUTCMinutes()
  return (peak.utcWindows ?? []).some((w) => inWindow(now, w))
}

/**
 * Build a model lookup that resolves retired aliases to their billing model.
 * @param {object} catalog - Parsed `prices.json`.
 * @returns {Map<string, object>} Alias (and canonical name) to price spec.
 */
export function indexCatalog(catalog) {
  const index = new Map()
  for (const [name, spec] of Object.entries(catalog.models ?? {})) {
    index.set(name, spec)
    for (const alias of spec.aliases ?? []) index.set(alias, spec)
  }
  return index
}

/**
 * Price one model call.
 *
 * `uncached` is the cache-miss input; `cache` is the cache-hit input. They are
 * billed at different rates and must never be summed before pricing.
 *
 * @param {{model: string|null, uncached: number, cache: number, output: number, at: Date|null}} call - One call.
 * @param {object} catalog - Parsed `prices.json`.
 * @param {Map<string, object>} index - Result of {@link indexCatalog}.
 * @returns {{cost: number, costCache: number, costUncached: number, costOutput: number, tier: 'peak'|'offpeak'|'unknown'}} Cost, its breakdown, and the rate tier.
 */
export function priceCall(call, catalog, index) {
  const spec = call.model === null ? undefined : index.get(call.model)
  if (spec === undefined || call.at === null) {
    return { cost: 0, costCache: 0, costUncached: 0, costOutput: 0, tier: 'unknown' }
  }

  const peak = isPeak(call.at, catalog.peak ?? { utcWindows: [] })
  const rates = peak ? spec : (spec.offPeak ?? spec)
  const { cacheHitPerM, cacheMissPerM, outputPerM } = rates
  if (cacheHitPerM == null || cacheMissPerM == null || outputPerM == null) {
    return { cost: 0, costCache: 0, costUncached: 0, costOutput: 0, tier: 'unknown' }
  }
  const costCache = (call.cache * cacheHitPerM) / 1e6
  const costUncached = (call.uncached * cacheMissPerM) / 1e6
  const costOutput = (call.output * outputPerM) / 1e6
  return {
    cost: costCache + costUncached + costOutput,
    costCache,
    costUncached,
    costOutput,
    tier: peak ? 'peak' : 'offpeak',
  }
}
