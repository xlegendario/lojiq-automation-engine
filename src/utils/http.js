const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchJson(url, options = {}, { retries = 3, timeoutMs = 20000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let body = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText}`);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    } catch (error) {
      lastError = error;
      const retryable = error.name === "AbortError" || RETRYABLE.has(error.status);
      if (!retryable || attempt === retries) throw error;
      const retryAfter = Number(error?.headers?.get?.("retry-after") || 0);
      const waitMs = retryAfter ? retryAfter * 1000 : 500 * (2 ** attempt);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export function escapeFormulaString(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
