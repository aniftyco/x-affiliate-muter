// =============================
// STATE
// =============================

let authBearer = null;

// =============================
// INJECT SNIFFER INTO PAGE
// =============================

function injectSniffer() {
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("sniffer.js");
    script.type = "text/javascript";
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (e) {
    console.error("[Affiliate Muter]", "Failed to inject sniffer:", e);
  }
}

injectSniffer();

// Listen for auth token from sniffer
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "affiliate-muter" || data.type !== "auth")
    return;

  if (data.authorization && data.authorization.startsWith("Bearer ")) {
    authBearer = data.authorization;
    console.log("[Affiliate Muter] Captured auth bearer.");
  }
});

// =============================
// UTILITIES
// =============================

function getCsrfTokenFromCookies() {
  const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCurrentPath() {
  try {
    return new URL(window.location.href).pathname;
  } catch {
    return window.location.pathname;
  }
}

function log(...args) {
  console.log("[Affiliate Muter]", ...args);
}

async function waitForAuth(maxWaitMs = 10000) {
  const start = Date.now();
  while (!authBearer && Date.now() - start < maxWaitMs) {
    await sleep(300);
  }
  if (!authBearer) {
    throw new Error(
      "Could not capture auth token from X yet. Try again in a few seconds."
    );
  }
  return authBearer;
}

// =============================
// DETECT AFFILIATES PAGE
// =============================

function onAffiliatesPage() {
  const path = getCurrentPath();
  const parts = path.split("/").filter(Boolean);
  // /SomeHandle/affiliates
  return parts.length === 2 && parts[1].toLowerCase() === "affiliates";
}

// Inject button into the tab bar or a reasonable place in the header
function injectMuteButton() {
  if (!onAffiliatesPage()) return;

  if (document.querySelector("#affiliate-muter-button")) return;

  const possibleNavs = document.querySelectorAll(
    'nav[role="navigation"], div[role="tablist"]'
  );
  let nav = null;
  for (const n of possibleNavs) {
    if (n.textContent && n.textContent.includes("Affiliates")) {
      nav = n;
      break;
    }
  }

  if (!nav) {
    log("Affiliates nav not found yet.");
    return;
  }

  const btn = document.createElement("button");
  btn.id = "affiliate-muter-button";
  btn.textContent = "Mute all affiliates";
  btn.style.marginLeft = "8px";
  btn.style.padding = "4px 8px";
  btn.style.borderRadius = "9999px";
  btn.style.border = "1px solid rgb(113, 118, 123)";
  btn.style.background = "transparent";
  btn.style.color = "rgb(239, 243, 244)";
  btn.style.cursor = "pointer";
  btn.style.fontSize = "13px";

  btn.addEventListener("click", async () => {
    try {
      btn.disabled = true;
      btn.textContent = "Muting...";
      await muteAllAffiliates();
      btn.textContent = "Done muting affiliates";
    } catch (e) {
      console.error(e);
      alert("Error while muting affiliates. Check console for details.");
      btn.textContent = "Mute all affiliates";
      btn.disabled = false;
    }
  });

  nav.appendChild(btn);
  log("Injected mute button.");
}

// =============================
// SCRAPE AFFILIATES
// =============================

function collectAffiliateHandles() {
  const handles = new Set();

  const main = document.querySelector("main") || document.body;

  const links = main.querySelectorAll(
    "a[href^='https://x.com/'], a[href^='/']"
  );
  for (const a of links) {
    let href = a.getAttribute("href");
    if (!href) continue;

    try {
      if (href.startsWith("http")) {
        const u = new URL(href);
        if (u.hostname !== "x.com" && u.hostname !== "twitter.com") continue;
        href = u.pathname;
      }
    } catch {
      // ignore
    }

    if (!href.startsWith("/")) continue;
    const parts = href.split("/").filter(Boolean);

    if (parts.length !== 1) continue;

    if (
      [
        "home",
        "i",
        "explore",
        "notifications",
        "messages",
        "settings",
      ].includes(parts[0].toLowerCase())
    ) {
      continue;
    }

    const handle = parts[0];

    if (!/^[A-Za-z0-9_]{1,50}$/.test(handle)) continue;

    handles.add(handle);
  }

  return Array.from(handles);
}

// =============================
// X API WRAPPERS
// =============================

function buildHeaders(bearer, csrfToken) {
  if (!bearer || !bearer.startsWith("Bearer ")) {
    throw new Error("Authorization bearer token missing or invalid.");
  }
  if (!csrfToken) {
    throw new Error("ct0 CSRF token cookie not found.");
  }

  return {
    authorization: bearer,
    "x-csrf-token": csrfToken,
    "x-twitter-active-user": "yes",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-client-language": "en",
    "content-type": "application/json",
  };
}

async function fetchUserIdForHandle(handle, headers) {
  const url = `https://x.com/i/api/2/users/by/username/${encodeURIComponent(
    handle
  )}?withSafetyModeUserFields=true&with_disabled_community=false`;

  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers,
  });

  if (!res.ok) {
    throw new Error(`Failed to get user id for @${handle}: ${res.status}`);
  }

  const data = await res.json();
  if (!data || !data.data || !data.data.id) {
    throw new Error(`No id in response for @${handle}`);
  }

  return data.data.id;
}

async function muteUserId(userId, headers) {
  const url = "https://x.com/i/api/1.1/mutes/users/create.json";

  const body = {
    user_id: userId,
  };

  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Failed to mute user ${userId}: ${res.status}`);
  }

  const data = await res.json();
  return data;
}

// =============================
// MAIN WORKFLOW
// =============================

async function muteAllAffiliates() {
  const bearer = await waitForAuth();
  const csrf = getCsrfTokenFromCookies();
  const headers = buildHeaders(bearer, csrf);

  const handles = collectAffiliateHandles();
  if (!handles.length) {
    alert(
      "No affiliate handles found on this page (or they haven't fully loaded yet). Try scrolling or waiting a moment, then click again."
    );
    return;
  }

  if (!confirm(`Found ${handles.length} affiliate accounts. Mute them all?`)) {
    return;
  }

  log("Will mute affiliates:", handles);

  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];
    try {
      log(`(${i + 1}/${handles.length}) Getting user id for @${handle}`);
      const userId = await fetchUserIdForHandle(handle, headers);

      log(`Muting user id ${userId} (@${handle})`);
      await muteUserId(userId, headers);

      await sleep(750);
    } catch (err) {
      console.error(`Error muting @${handle}`, err);
      await sleep(500);
    }
  }

  alert(
    "Finished attempting to mute all affiliates. Check console for details / errors."
  );
}

// =============================
// SPA HANDLING
// =============================

let lastPath = getCurrentPath();

function checkAndInject() {
  const currentPath = getCurrentPath();
  if (currentPath !== lastPath) {
    lastPath = currentPath;
  }

  if (onAffiliatesPage()) {
    injectMuteButton();
  }
}

setInterval(checkAndInject, 1500);

const observer = new MutationObserver(() => {
  checkAndInject();
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

checkAndInject();
log("Affiliate Muter content script loaded.");
