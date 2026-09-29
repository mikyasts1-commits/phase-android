/* ------------------------- Crash reporting (Sentry) ------------------------- */
// TODO: Replace with real Sentry DSN from the Phase Sentry project before
// production. While this is empty, all Sentry calls fail silently and the
// app behaves exactly as if Sentry were not present.
export const SENTRY_DSN = "";

let sentry = null;
let initAttempted = false;

export function initSentry() {
  if (initAttempted) return;
  initAttempted = true;
  if (!SENTRY_DSN) return; // Not configured — stay silent.
  // Dynamic import so a missing/broken @sentry/react can never break the app.
  import("@sentry/react")
    .then((mod) => {
      sentry = mod;
      try {
        mod.init({
          dsn: SENTRY_DSN,
          // tracesSampleRate 0 until we need performance monitoring —
          // we only want crash reports for now.
          tracesSampleRate: 0,
        });
      } catch {
        sentry = null;
      }
    })
    .catch(() => {
      sentry = null;
    });
}

/** Report a caught error to Sentry. Never throws; no-op when unconfigured. */
export function reportError(error, context) {
  if (!sentry) return;
  try {
    if (context) {
      sentry.withScope((scope) => {
        try {
          scope.setExtra("context", context);
        } catch {}
        sentry.captureException(error);
      });
    } else {
      sentry.captureException(error);
    }
  } catch {}
}
