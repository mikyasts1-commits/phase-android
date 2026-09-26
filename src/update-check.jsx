import React from "react";
import { UPDATE_REPO_OWNER, UPDATE_REPO_NAME } from "./update-config.js";

/* App version injected at build time via vite.config.js `define`
   (read from package.json). Replaced with a string literal on build. */
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

const PLACEHOLDER_OWNER = "OWNER";
const PLACEHOLDER_REPO = "REPO";

// One check per app launch (module-level guard; StrictMode-safe).
let checkedThisLaunch = false;

function stripV(tag) {
  return (tag || "").trim().replace(/^v/i, "");
}

function parseSemver(v) {
  return stripV(v).split(".").map((n) => parseInt(n, 10) || 0);
}

// >0 if a > b, <0 if a < b, 0 if equal. Compares numeric parts only.
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function dismissedKey(version) {
  return "phase_update_dismissed_v" + stripV(version);
}

/**
 * Checks GitHub for a newer Phase release.
 * Resolves to { version, downloadUrl } when an update should be offered,
 * otherwise null. Never throws — all network/API failures are silent.
 */
export async function checkForUpdates() {
  if (checkedThisLaunch) return null;
  checkedThisLaunch = true;
  try {
    // Repo not configured yet — parent agent fills in update-config.js first.
    if (
      !UPDATE_REPO_OWNER ||
      !UPDATE_REPO_NAME ||
      UPDATE_REPO_OWNER === PLACEHOLDER_OWNER ||
      UPDATE_REPO_NAME === PLACEHOLDER_REPO
    ) {
      return null;
    }
    const res = await fetch(
      "https://api.github.com/repos/" + UPDATE_REPO_OWNER + "/" + UPDATE_REPO_NAME + "/releases/latest",
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) return null;
    const release = await res.json();
    const latest = stripV(release.tag_name);
    if (!latest) return null;
    if (compareSemver(latest, APP_VERSION) <= 0) return null; // up to date
    if (window.localStorage.getItem(dismissedKey(latest))) return null; // snoozed
    const apk = (release.assets || []).find((a) =>
      (a.name || "").toLowerCase().endsWith(".apk")
    );
    if (!apk || !apk.browser_download_url) return null;
    return { version: latest, downloadUrl: apk.browser_download_url };
  } catch {
    return null; // offline, rate-limited, bad JSON — stay silent
  }
}

/** Persist a "Later" dismissal so this version doesn't nag on next launch. */
export function dismissUpdate(version) {
  try {
    window.localStorage.setItem(dismissedKey(version), String(Date.now()));
  } catch {
    /* storage unavailable — fine, it just shows again next launch */
  }
}

function openDownload(url) {
  try {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

/* Non-blocking dialog using the app's own glass-modal styles
   (.modal-overlay / .modal-card) and button system. */
export function UpdateDialog({ info, onLater, onDownload }) {
  return (
    <div className="modal-overlay" style={{ zIndex: 200 }}>
      <div className="modal-card" style={{ textAlign: "center" }}>
        <div style={{ fontSize: 40, lineHeight: 1, color: "var(--sky-500)" }}>Φ</div>
        <h2 style={{ margin: "12px 0 6px", fontSize: 20 }}>
          Update available — v{info.version}
        </h2>
        <p style={{ fontSize: 13.5, opacity: 0.7, lineHeight: 1.55, margin: "0 0 18px" }}>
          A newer build of Phase is ready. Download it to stay on the latest alpha.
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn-secondary" onClick={onLater} style={{ flex: 1 }}>
            Later
          </button>
          <button
            className="btn-primary"
            style={{ flex: 1 }}
            onClick={() => {
              onDownload();
              openDownload(info.downloadUrl);
            }}
          >
            Download
          </button>
        </div>
      </div>
    </div>
  );
}
