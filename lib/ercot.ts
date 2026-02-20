// lib/ercot.ts

const TOKEN_URL =
  "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token";

const PUBLIC_DATA_BASE = "https://api.ercot.com/api/public-reports";

const DEFAULT_CLIENT_ID = "fec253ea-0d06-4272-a5e6-b478baeecd70";

const TOKEN_TIMEOUT_MS = 12_000;
const API_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_SKEW_MS = 30_000;

type TokenCache = { token: string; expMs: number };

declare global {
  var __ERCOT_TOKEN_CACHE__: TokenCache | null | undefined;
}


function getGlobalTokenCache(): TokenCache | null {
  return globalThis.__ERCOT_TOKEN_CACHE__ ?? null;
}

function setGlobalTokenCache(v: TokenCache | null) {
  globalThis.__ERCOT_TOKEN_CACHE__ = v;
}

function withTimeout(ms: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    done: () => clearTimeout(id),
  };
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function redact(s: string, maxLen = 800) {
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

async function getIdToken(): Promise<string> {
  const cached = getGlobalTokenCache();
  if (cached && Date.now() < cached.expMs - TOKEN_REFRESH_SKEW_MS) return cached.token;

  const username = process.env.ERCOT_USERNAME;
  const password = process.env.ERCOT_PASSWORD;
  const clientId = process.env.ERCOT_CLIENT_ID ?? DEFAULT_CLIENT_ID;

  if (!username || !password) throw new Error("Missing ERCOT_USERNAME / ERCOT_PASSWORD");

  const body = new URLSearchParams({
    grant_type: "password",
    username,
    password,
    scope: `openid ${clientId} offline_access`,
    client_id: clientId,
    response_type: "id_token",
  });

  const t = withTimeout(TOKEN_TIMEOUT_MS);
  try {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: t.signal,
      cache: "no-store",
    });

    if (!resp.ok) {
      const txt = redact(await resp.text());
      throw new Error(`ERCOT token failed: ${resp.status} ${txt}`);
    }

    const json = (await resp.json()) as { id_token?: string; expires_in?: number };
    if (!json.id_token) throw new Error("ERCOT token response missing id_token");

    const expMs = Date.now() + (json.expires_in ?? 3600) * 1000;
    setGlobalTokenCache({ token: json.id_token, expMs });

    return json.id_token;
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("ERCOT token request timed out");
    }
    throw e;
  } finally {
    t.done();
  }
}

function isRetryableStatus(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Fetches JSON from ERCOT public-reports endpoints using:
 * - Azure B2C id_token (ROPC flow)
 * - Ocp-Apim-Subscription-Key
 *
 * Important: credentials are server-side only. Do not expose them to the client.
 */
// src/lib/ercot.ts
export async function ercotGetJson<T>(
  path: string,
  query: Record<string, string>
): Promise<T> {
  const subKey = process.env.ERCOT_SUBSCRIPTION_KEY;
  if (!subKey) throw new Error("Missing ERCOT_SUBSCRIPTION_KEY");

  const token = await getIdToken();

  const url = new URL(`${PUBLIC_DATA_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t = withTimeout(API_TIMEOUT_MS);

    try {
      const resp = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          "Ocp-Apim-Subscription-Key": subKey,
          Accept: "application/json",
        },
        signal: t.signal,
        cache: "no-store",
      });

      const text = await resp.text(); // read once

      if (!resp.ok) {
        if (isRetryableStatus(resp.status) && attempt < maxAttempts) {
          await sleep(300 * attempt);
          continue;
        }
        throw new Error(`ERCOT API failed: ${resp.status} ${redact(text)}`);
      }

      // parse once
      const json = JSON.parse(text) as T;

      // if you really want logging:
      // console.log("ERCOT response sample", JSON.stringify(json).slice(0, 1200));

      return json;
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") {
        if (attempt < maxAttempts) {
          await sleep(300 * attempt);
          continue;
        }
        throw new Error(`ERCOT API request timed out (${path})`);
      }
      throw e;
    } finally {
      t.done();
    }
  }

  throw new Error(`ERCOT API failed after retries (${path})`);
}
