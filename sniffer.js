// Injected into the page context. It monkey-patches window.fetch
// and captures the Authorization header when X calls its own APIs.

(function () {
  const LOG_PREFIX = "[Affiliate Muter Sniffer]";

  function safeLog(...args) {
    try {
      console.log(LOG_PREFIX, ...args);
    } catch (_) {}
  }

  if (window.__affiliateMuterSnifferInstalled) {
    return;
  }
  window.__affiliateMuterSnifferInstalled = true;

  const originalFetch = window.fetch;
  if (!originalFetch) {
    safeLog("window.fetch not found.");
    return;
  }

  window.fetch = async function (input, init) {
    try {
      const url =
        typeof input === "string" ? input : (input && input.url) || "";
      const isTwitterApiCall =
        typeof url === "string" && url.includes("/i/api/");

      if (isTwitterApiCall && init && init.headers) {
        let authorization = null;

        // Handle various header shapes
        const h = init.headers;

        if (h instanceof Headers) {
          authorization = h.get("authorization");
        } else if (Array.isArray(h)) {
          // e.g. [["authorization", "Bearer ..."], ...]
          for (const [key, value] of h) {
            if (String(key).toLowerCase() === "authorization") {
              authorization = value;
              break;
            }
          }
        } else if (typeof h === "object") {
          for (const key in h) {
            if (Object.prototype.hasOwnProperty.call(h, key)) {
              if (key.toLowerCase() === "authorization") {
                authorization = h[key];
                break;
              }
            }
          }
        }

        if (authorization && authorization.startsWith("Bearer ")) {
          window.postMessage(
            {
              source: "affiliate-muter",
              type: "auth",
              authorization,
            },
            "*"
          );
        }
      }
    } catch (e) {
      safeLog("Error sniffing fetch:", e);
    }

    return originalFetch.apply(this, arguments);
  };

  safeLog("Sniffer installed.");
})();
