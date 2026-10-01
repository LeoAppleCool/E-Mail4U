const API_BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  constructor(message, { status, errors = [], path } = {}) {
    super(message);
    this.name = 'CloudflareError';
    this.status = status;
    this.errors = errors;
    this.path = path;
  }

  /** Does the response contain one of the given Cloudflare error codes? */
  hasCode(...codes) {
    return this.errors.some((e) => codes.includes(e.code));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal client for the Cloudflare REST API (bearer token).
 */
export class CloudflareClient {
  constructor({ token, log, fetchImpl = fetch }) {
    this.token = token;
    this.log = log;
    this.fetch = fetchImpl;
  }

  async request(method, path, { body, query, form, retries = 3 } = {}) {
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = { Authorization: `Bearer ${this.token}` };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    // POST creates things (e.g. routing rules) – don't blindly retry on network/server errors (duplicates).
    const idempotent = method !== 'POST';
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        if (idempotent && attempt < retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new CloudflareError(`Cloudflare unreachable: ${err.message}`, { path });
      }

      const retryable = response.status === 429 || (idempotent && response.status >= 500);
      if (retryable && attempt < retries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }

      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // not a JSON response
      }
      if (!response.ok || data?.success === false) {
        const errors = data?.errors ?? [];
        const detail = errors.map((e) => `${e.message} (${e.code})`).join('; ') || text.slice(0, 200) || response.statusText;
        throw new CloudflareError(`Cloudflare ${method} ${path}: HTTP ${response.status} – ${detail}`, {
          status: response.status, errors, path,
        });
      }
      return data;
    }
  }

  async get(path, query) {
    return (await this.request('GET', path, { query })).result;
  }

  async post(path, body) {
    return (await this.request('POST', path, { body })).result;
  }

  async put(path, body) {
    return (await this.request('PUT', path, { body })).result;
  }

  async delete(path) {
    return (await this.request('DELETE', path)).result;
  }

  /** Fetches every page of a paginated endpoint. */
  async paginate(path, query = {}, perPage = 50) {
    const items = [];
    for (let page = 1; ; page++) {
      const data = await this.request('GET', path, { query: { ...query, page, per_page: perPage } });
      const result = data.result ?? [];
      items.push(...result);
      const info = data.result_info ?? {};
      if (!result.length) break;
      if (info.total_pages ? page >= info.total_pages
        : info.total_count !== undefined ? items.length >= info.total_count
          : result.length < perPage) break;
    }
    return items;
  }
}
