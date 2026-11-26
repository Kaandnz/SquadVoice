const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function normalizeIceServers(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return [raw];
  return [];
}

export async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  if (request.method !== 'POST' || (url.pathname !== '/' && url.pathname !== '/turn')) {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) {
    return jsonResponse({ error: 'Authorization Bearer token required' }, 401);
  }

  if (!env.FIREBASE_WEB_API_KEY || !env.FIREBASE_DATABASE_URL || !env.CF_TURN_KEY_ID || !env.CF_TURN_API_TOKEN) {
    return jsonResponse({ error: 'Worker secrets are not configured' }, 500);
  }

  // 1. Verify Firebase ID Token
  const lookupResp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    },
  );
  if (!lookupResp.ok) {
    return jsonResponse({ error: 'Invalid Firebase token' }, 401);
  }
  const lookupData = await lookupResp.json();
  const uid = lookupData?.users?.[0]?.localId;
  if (!uid) {
    return jsonResponse({ error: 'User not found' }, 401);
  }

  // 2. Verify user is a registered squad member in RTDB
  const dbBase = env.FIREBASE_DATABASE_URL.replace(/\/+$/, '');
  const memberResp = await fetch(
    `${dbBase}/users/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(idToken)}`,
  );
  if (!memberResp.ok) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }
  const memberData = await memberResp.json();
  if (!memberData || typeof memberData !== 'object') {
    return jsonResponse({ error: 'Not a squad member' }, 403);
  }

  // 3. Request ephemeral 24h Cloudflare TURN credentials
  const cfResp = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: 86400 }),
    },
  );

  if (!cfResp.ok) {
    return jsonResponse({ error: `Cloudflare TURN API error (${cfResp.status})` }, 502);
  }

  const cfData = await cfResp.json();
  const iceServers = normalizeIceServers(cfData?.iceServers);
  return jsonResponse({ iceServers, turnEnabled: iceServers.length > 0 });
}

export default {
  fetch: handleRequest,
};
