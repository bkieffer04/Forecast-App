// src/lib/ercot.ts
const TOKEN_URL =
  "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token";

const PUBLIC_DATA_BASE = "https://api.ercot.com/api/public-reports";

let cachedToken: { token: string; expMs: number } | null = null;

async function getIdToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expMs - 30_000) return cachedToken.token;

  const username = process.env.ERCOT_USERNAME;
  const password = process.env.ERCOT_PASSWORD;

  if (!username || !password) throw new Error("Missing ERCOT_USERNAME / ERCOT_PASSWORD");
    const clientId = "fec253ea-0d06-4272-a5e6-b478baeecd70";
    // This mirrors the commonly used PubAPI ROPC flow.
    // If ERCOT changes client_id/scope in the Explorer, swap them here.
    const body = new URLSearchParams({
    grant_type: "password",
    username,
    password,
    // IMPORTANT: ERCOT requires scope = "openid <client_id> offline_access"
    // (Their docs show it as openid+<client_id>+offline_access.) :contentReference[oaicite:1]{index=1}
    scope: `openid ${clientId} offline_access`,
    client_id: clientId,
    response_type: "id_token",
});

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`ERCOT token failed: ${resp.status} ${txt}`);
  }

  const json = (await resp.json()) as { id_token?: string; expires_in?: number };
  if (!json.id_token) throw new Error("ERCOT token response missing id_token");

  const exp = (json.expires_in ?? 3600) * 1000;
  cachedToken = { token: json.id_token, expMs: Date.now() + exp };
  return json.id_token;
}

export async function ercotGetJson<T>(
  path: string,
  query: Record<string, string>,
): Promise<T> {
  const subKey = process.env.ERCOT_SUBSCRIPTION_KEY;
  if (!subKey) throw new Error("Missing ERCOT_SUBSCRIPTION_KEY");

  const token = await getIdToken();

  const url = new URL(`${PUBLIC_DATA_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Ocp-Apim-Subscription-Key": subKey,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`ERCOT API failed: ${resp.status} ${txt}`);
  }

  return (await resp.json()) as T;
}
