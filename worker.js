const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS,POST",
};

const TARGETS = {
  users: "https://users.roblox.com",
  groups: "https://groups.roblox.com",
  friends: "https://friends.roblox.com",
  thumbnails: "https://thumbnails.roblox.com",
  www: "https://www.roblox.com",
  cdn: "https://tr.rbxcdn.com",
};

const DEFAULT_GROUP_ID = 564810012;
const GROUP_ICON_SIZE = "420x420";
const HEADSHOT_SIZE = "420x420";
const FALLBACK_CARD_PATH = "/share-fallback.svg";
const HOME_META_IMAGE_URL = "https://raw.githubusercontent.com/mm6683/SRL-User-Checker/refs/heads/main/public/logo.png";
const ROBLOX_CDN_HOST = "tr.rbxcdn.com";

// Proxy for numbered Roblox CDN subdomains (t0-t7.rbxcdn.com).
// Used for 3D avatar assets: OBJ mesh, MTL material, and textures.
// Route: /proxy/rbxcdn/{0-7}/{path...}  (path can contain hyphens, slashes, etc.)
async function handleRbxCdnProxy(request) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Strip the /proxy/rbxcdn/{n}/ prefix and treat the rest as the CDN path.
  // Use a loose match so hyphens, underscores, and other chars are allowed.
  const match = url.pathname.match(/^\/proxy\/rbxcdn\/([0-7])\/(.+)$/);
  if (!match) {
    return new Response("Invalid CDN path", { status: 400, headers: CORS_HEADERS });
  }

  const [, server, cdnPath] = match;
  const targetUrl = `https://t${server}.rbxcdn.com/${cdnPath}`;

  try {
    const response = await fetch(targetUrl, { redirect: "follow" });
    const headers = new Headers(response.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (err) {
    console.error("CDN proxy fetch failed:", err);
    return new Response("CDN fetch failed", { status: 502, headers: CORS_HEADERS });
  }
}

async function handleProxy(request, env) {
  const url = new URL(request.url);
  const [, , service, ...rest] = url.pathname.split("/");

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (!TARGETS[service]) {
    return new Response("Unknown proxy service", { status: 400, headers: CORS_HEADERS });
  }

  if (!["GET", "HEAD", "POST"].includes(request.method)) {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  const targetUrl = new URL(`/${rest.join("/")}${url.search}`, TARGETS[service]);

  // Strip headers that cause Roblox to reject server-side requests with 403.
  // The browser sends Origin/Referer pointing at the worker domain, which
  // Roblox treats as an invalid origin on stricter endpoints (e.g. avatar-3d).
  // Cookie is stripped to avoid accidentally forwarding session tokens.
  const outboundHeaders = new Headers(request.headers);
  outboundHeaders.delete("origin");
  outboundHeaders.delete("referer");
  outboundHeaders.delete("cookie");

  // Since March 23 2026, Roblox requires Open Cloud authentication for all
  // -3d thumbnail endpoints. Inject the API key (stored as a Worker secret
  // via `wrangler secret put ROBLOX_API_KEY`) for all thumbnails requests.
  if (service === "thumbnails" && env.RBX_SRL) {
    outboundHeaders.set("x-api-key", env.RBX_SRL);
  }

  const outboundInit = {
    method: request.method,
    headers: outboundHeaders,
    redirect: "follow",
  };

  if (request.method === "POST") {
    outboundInit.body = request.body;
  }

  const outbound = new Request(targetUrl.toString(), outboundInit);
  const response = await fetch(outbound);
  const headers = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function serveSPA(request, env) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return new Response("Static assets binding not configured", { status: 500 });
  }

  const spaRequest = new Request(new URL("/", request.url), request);
  return env.ASSETS.fetch(spaRequest);
}

function getFallbackCardImage(request) {
  return new URL(FALLBACK_CARD_PATH, request.url).toString();
}

function proxyCdnUrl(rawUrl, request) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname !== ROBLOX_CDN_HOST) return rawUrl;
    return new URL(`/proxy/cdn${parsed.pathname}${parsed.search}`, request.url).toString();
  } catch {
    return rawUrl;
  }
}

async function getGroupIconUrl(groupId, size = GROUP_ICON_SIZE) {
  try {
    const response = await fetch(
      `${TARGETS.thumbnails}/v1/groups/icons?groupIds=${groupId}&size=${size}&format=Png&isCircular=false`,
    );
    if (!response.ok) return undefined;
    const payload = await response.json();
    return payload?.data?.[0]?.imageUrl;
  } catch (err) {
    console.warn("Unable to fetch group icon", err);
    return undefined;
  }
}

async function getUserHeadshotUrl(userId, size = HEADSHOT_SIZE) {
  try {
    const response = await fetch(
      `${TARGETS.thumbnails}/v1/users/avatar-headshot?userIds=${userId}&size=${size}&format=Png&isCircular=true`,
    );
    if (!response.ok) return undefined;
    const payload = await response.json();
    return payload?.data?.[0]?.imageUrl;
  } catch (err) {
    console.warn("Unable to fetch user headshot", err);
    return undefined;
  }
}

async function getUserIdFromUsername(username) {
  try {
    const cleanUsername = username.replace(/^@/, "").replace(/[()]/g, "").trim();
    if (!cleanUsername) return undefined;

    const response = await fetch(`${TARGETS.users}/v1/usernames/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [cleanUsername], excludeBannedUsers: false }),
    });

    if (!response.ok) return undefined;
    const payload = await response.json();
    return payload?.data?.[0]?.id;
  } catch (err) {
    console.warn("Unable to fetch Roblox userId from username for share card", err);
    return undefined;
  }
}

async function serveUserSharePage(request, env, userId) {
  const baseResponse = await serveSPA(request, env);
  const contentType = baseResponse.headers.get("Content-Type") || "";
  if (!contentType.includes("text/html")) return baseResponse;

  let description = `SRL User Checker - User | ${userId}`;
  const rawGroupIconUrl = await getGroupIconUrl(DEFAULT_GROUP_ID);
  const rawImageUrl = rawGroupIconUrl || getFallbackCardImage(request);
  let imageUrl = proxyCdnUrl(rawImageUrl, request);

  try {
    const userResponse = await fetch(`https://users.roblox.com/v1/users/${userId}`);
    if (userResponse.ok) {
      const user = await userResponse.json();
      const username = user.name || user.displayName;
      if (username) description = `SRL User Checker - ${username} | ${userId}`;
    }
  } catch (err) {
    console.warn("Unable to fetch Roblox user for share card", err);
  }

  const headshotUrl = await getUserHeadshotUrl(userId);
  if (headshotUrl) imageUrl = proxyCdnUrl(headshotUrl, request);

  const html = await baseResponse.text();
  const replacements = [
    { pattern: /<meta\s+name="description"[^>]*content="[^"]*"/i, replacement: `<meta name="description" content="${description}"` },
    { pattern: /<meta\s+property="og:description"[^>]*content="[^"]*"/i, replacement: `<meta property="og:description" content="${description}"` },
    { pattern: /<meta\s+name="twitter:description"[^>]*content="[^"]*"/i, replacement: `<meta name="twitter:description" content="${description}"` },
    { pattern: /<meta\s+property="og:image"[^>]*content="[^"]*"/i, replacement: `<meta property="og:image" content="${imageUrl || ""}"` },
    { pattern: /<meta\s+property="og:image:width"[^>]*content="[^"]*"/i, replacement: `<meta property="og:image:width" content="150"` },
    { pattern: /<meta\s+property="og:image:height"[^>]*content="[^"]*"/i, replacement: `<meta property="og:image:height" content="150"` },
    { pattern: /<meta\s+name="twitter:image"[^>]*content="[^"]*"/i, replacement: `<meta name="twitter:image" content="${imageUrl || ""}"` },
    { pattern: /<meta\s+name="twitter:card"[^>]*content="[^"]*"/i, replacement: `<meta name="twitter:card" content="summary"` },
  ];

  const updatedHtml = replacements.reduce((output, { pattern, replacement }) => output.replace(pattern, replacement), html);
  const headers = new Headers(baseResponse.headers);
  return new Response(updatedHtml, { status: baseResponse.status, statusText: baseResponse.statusText, headers });
}

async function serveMainSharePage(request, env) {
  const baseResponse = await serveSPA(request, env);
  const contentType = baseResponse.headers.get("Content-Type") || "";
  if (!contentType.includes("text/html")) return baseResponse;

  const imageUrl = HOME_META_IMAGE_URL;
  const html = await baseResponse.text();
  const replacements = [
    { pattern: /<meta\s+property="og:image"[^>]*content="[^"]*"/i, replacement: `<meta property="og:image" content="${imageUrl}"` },
    { pattern: /<meta\s+property="og:image:width"[^>]*content="[^"]*"/i, replacement: `<meta property="og:image:width" content="150"` },
    { pattern: /<meta\s+property="og:image:height"[^>]*content="[^"]*"/i, replacement: `<meta property="og:image:height" content="150"` },
    { pattern: /<meta\s+name="twitter:image"[^>]*content="[^"]*"/i, replacement: `<meta name="twitter:image" content="${imageUrl}"` },
    { pattern: /<meta\s+name="twitter:card"[^>]*content="[^"]*"/i, replacement: `<meta name="twitter:card" content="summary"` },
  ];

  const updatedHtml = replacements.reduce((output, { pattern, replacement }) => output.replace(pattern, replacement), html);
  const headers = new Headers(baseResponse.headers);
  return new Response(updatedHtml, { status: baseResponse.status, statusText: baseResponse.statusText, headers });
}

async function serveUsernameSharePage(request, env, username) {
  const userId = await getUserIdFromUsername(username);
  if (!userId) return serveMainSharePage(request, env);
  return serveUserSharePage(request, env, userId);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Temporary debug route — visit /debug/auth-check to confirm the secret
    // is wired up in the live worker. Remove once confirmed working.
    if (url.pathname === "/debug/auth-check") {
      return new Response(
        JSON.stringify({ RBX_SRL_present: !!env.RBX_SRL, RBX_SRL_length: env.RBX_SRL?.length ?? 0 }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // 3D avatar CDN proxy — must be checked before the generic /proxy/ handler
    if (url.pathname.startsWith("/proxy/rbxcdn/")) {
      return handleRbxCdnProxy(request);
    }

    if (url.pathname.startsWith("/proxy/")) {
      return handleProxy(request, env);
    }

    if (url.pathname.startsWith("/username/")) {
      const match = url.pathname.match(/^\/username\/([^/]+)/);
      if (match) return serveUsernameSharePage(request, env, decodeURIComponent(match[1]));
      return serveMainSharePage(request, env);
    }

    if (url.pathname.startsWith("/userid/")) {
      const match = url.pathname.match(/^\/userid\/(\d+)/);
      if (match) return serveUserSharePage(request, env, match[1]);
      return serveMainSharePage(request, env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveMainSharePage(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
