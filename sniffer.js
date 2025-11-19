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
  if (originalFetch) {
    window.fetch = async function (input, init) {
      try {
        const url =
          typeof input === "string" ? input : (input && input.url) || "";
        let isXApiCall = false;

        if (typeof url === "string" && url) {
          try {
            const u = new URL(url, window.location.origin);
            const host = (u.hostname || "").toLowerCase();
            if (host.endsWith("x.com") || host.endsWith("twitter.com")) {
              isXApiCall = true;
            }
          } catch (_) {
            if (url.includes("x.com") || url.includes("twitter.com")) {
              isXApiCall = true;
            }
          }
        }

        if (isXApiCall) {
          let authorization = null;
          let headersSource = null;

          if (init && init.headers) {
            headersSource = init.headers;
          } else if (input && typeof input === "object" && input.headers) {
            headersSource = input.headers;
          }

          if (headersSource) {
            const h = headersSource;

            if (h instanceof Headers) {
              authorization = h.get("authorization");
            } else if (Array.isArray(h)) {
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
          }

          if (authorization && authorization.startsWith("Bearer ")) {
            safeLog("Captured Authorization bearer from fetch to", url);
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
  }

  // Also hook XMLHttpRequest to catch auth headers set there.
  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    function WrappedXHR() {
      const xhr = new OriginalXHR();
      let authHeader = null;
      let requestUrl = null;

      const originalOpen = xhr.open;
      xhr.open = function (method, url) {
        try {
          requestUrl = url;
        } catch (_) {}
        return originalOpen.apply(xhr, arguments);
      };

      const originalSetRequestHeader = xhr.setRequestHeader;
      xhr.setRequestHeader = function (name, value) {
        try {
          if (
            typeof name === "string" &&
            name.toLowerCase() === "authorization" &&
            typeof value === "string" &&
            value.startsWith("Bearer ")
          ) {
            authHeader = value;
          }
        } catch (_) {}
        return originalSetRequestHeader.apply(xhr, arguments);
      };

      const originalSend = xhr.send;
      xhr.send = function (body) {
        try {
          if (authHeader && requestUrl) {
            let isXApiCall = false;
            try {
              const u = new URL(requestUrl, window.location.origin);
              const host = (u.hostname || "").toLowerCase();
              if (host.endsWith("x.com") || host.endsWith("twitter.com")) {
                isXApiCall = true;
              }
            } catch (_) {
              if (
                String(requestUrl).includes("x.com") ||
                String(requestUrl).includes("twitter.com")
              ) {
                isXApiCall = true;
              }
            }

            if (isXApiCall) {
              safeLog("Captured Authorization bearer from XHR to", requestUrl);
              window.postMessage(
                {
                  source: "affiliate-muter",
                  type: "auth",
                  authorization: authHeader,
                },
                "*"
              );
            }
          }
        } catch (e) {
          safeLog("Error sniffing XHR:", e);
        }
        return originalSend.apply(xhr, arguments);
      };

      return xhr;
    }

    WrappedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = WrappedXHR;
  }

  safeLog("Sniffer installed.");
})();
