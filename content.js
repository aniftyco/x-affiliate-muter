// =============================
// STATE & SNIFFER
// =============================

let authBearer = null;

// Inject sniffer script into the page context to capture the
// Authorization bearer token X uses for its own API calls.
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

function getCsrfTokenFromCookies() {
  const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
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

  // Try to find the main affiliates list section as the anchor
  const affiliatesSection = document.querySelector(
    'section[role="region"][aria-labelledby^="accessible-list-"]'
  );

  if (!affiliatesSection) {
    log("Affiliates section not found yet.");
    return;
  }

  const btn = document.createElement("button");
  btn.id = "affiliate-muter-button";
  btn.textContent = "Mute All";
  btn.style.marginLeft = "8px";
  btn.style.padding = "4px 8px";
  btn.style.borderRadius = "9999px";
  btn.style.border = "1px solid rgb(113, 118, 123)";
  btn.style.background = "transparent";
  btn.style.color = "rgb(239, 243, 244)";
  btn.style.cursor = "pointer";
  btn.style.fontSize = "13px";

  const container = document.createElement("div");
  container.style.display = "flex";
  container.style.justifyContent = "flex-end";
  container.style.marginBottom = "8px";
  container.appendChild(btn);

  btn.addEventListener("click", async () => {
    try {
      const targets = collectAffiliateTargets();
      if (!targets.length) {
        alert(
          "No affiliate handles found on this page (or they haven't fully loaded yet). Try scrolling or waiting a moment, then click again."
        );
        return;
      }

      const handles = targets.map((t) => t.handle);

      if (
        !confirm(
          `Found ${handles.length} affiliate accounts. Mute them all? This will call X's mute API for each.`
        )
      ) {
        return;
      }

      log("Will mute affiliates:", handles);

      btn.disabled = true;
      btn.textContent = "Muting affiliates...";

      await muteAllAffiliates(targets);

      alert(
        "Finished attempting to mute all affiliates. Check console for details / errors."
      );
      btn.textContent = "Done muting affiliates";
    } catch (e) {
      console.error(e);
      alert("Error while muting affiliates. Check console for details.");
      btn.textContent = "Mute All";
    } finally {
      btn.disabled = false;
    }
  });

  affiliatesSection.insertBefore(container, affiliatesSection.firstChild);
  log("Injected mute button.");
}

// =============================
// SCRAPE AFFILIATES
// =============================

function collectAffiliateTargets() {
  const targetsByHandle = new Map();

  const affiliatesSection =
    document.querySelector(
      'section[role="region"][aria-labelledby^="accessible-list-"]'
    ) ||
    document.querySelector("main") ||
    document.body;

  const followButtons = affiliatesSection.querySelectorAll(
    "button[aria-label*='@'][data-testid*='-follow']"
  );

  for (const btn of followButtons) {
    const label = btn.getAttribute("aria-label") || "";
    if (!label) continue;

    if (!/Follow/i.test(label) && !/Following/i.test(label)) continue;

    const handleMatch = label.match(/@([A-Za-z0-9_]{1,50})/);
    if (!handleMatch) continue;

    const handle = handleMatch[1];

    const dataTestId = btn.getAttribute("data-testid") || "";
    const idMatch = dataTestId.match(/^(\d+)-/);
    if (!idMatch) continue;

    const userId = idMatch[1];

    if (!targetsByHandle.has(handle)) {
      targetsByHandle.set(handle, { handle, userId });
    }
  }

  return Array.from(targetsByHandle.values());
}

function collectAffiliateHandles() {
  return collectAffiliateTargets().map((t) => t.handle);
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
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  };
}

async function muteUserId(userId, handle, headers) {
  const url = "https://x.com/i/api/1.1/mutes/users/create.json";

  const body = `user_id=${encodeURIComponent(userId)}`;

  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers,
    body,
  });

  if (!res.ok) {
    throw new Error(`Failed to mute @${handle}: ${res.status}`);
  }

  const data = await res.json();
  return data;
}

async function muteAllAffiliates(targets) {
  const bearer = await waitForAuth();
  const csrf = getCsrfTokenFromCookies();
  const headers = buildHeaders(bearer, csrf);

  const total = targets.length;

  for (let i = 0; i < total; i++) {
    const { handle, userId } = targets[i];
    try {
      log(`(${i + 1}/${total}) Muting @${handle}`);
      await muteUserId(userId, handle, headers);

      await sleep(750);
    } catch (err) {
      console.error(`Error muting @${handle}`, err);
      await sleep(500);
    }
  }
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
