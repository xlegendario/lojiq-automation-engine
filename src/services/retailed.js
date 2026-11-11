import { config } from "../config.js";

// Retailed answers a StockX search with a plain array of products. Make took
// the first one ("data[]"), so this does too.
//
// Make retried a failed search three times with ten seconds in between. A
// payment or key problem (401/402/403) will not fix itself in ten seconds,
// so those stop at once; anything else gets the three attempts.
export async function searchStockxFirst(query) {
  const text = String(query ?? "").trim();

  if (!text || !config.retailedApiKey) {
    return null;
  }

  const url =
    `${config.retailedSearchUrl}?query=${encodeURIComponent(text)}`;

  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "x-api-key": config.retailedApiKey },
        signal: AbortSignal.timeout(20000),
      });

      if (!response.ok) {
        const error = new Error(`Retailed HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }

      const results = await response.json();

      return Array.isArray(results) && results.length ? results[0] : null;
    } catch (error) {
      lastError = error;

      if ([401, 402, 403].includes(error.status) || attempt === 3) {
        break;
      }

      await new Promise(resolve =>
        setTimeout(resolve, config.retailedRetryDelayMs)
      );
    }
  }

  console.warn("[order-intake] retailed search failed", {
    query: text,
    error: lastError?.message,
  });

  return null;
}
