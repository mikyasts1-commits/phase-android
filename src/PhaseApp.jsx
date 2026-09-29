import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { MARKETPLACE_LOCKED, CRYPTO_FUNDING_LOCKED, GO_LIVE_LOCKED } from "./feature-flags.js";
import { generateWallet, restoreWallet, createSovereignChain } from "./sovereign-client.js";
// stripe-client.js is retained for the future live-Stripe integration;
// card funding UI is currently disabled (see CardFundPanel).
import { reportError } from "./sentry.js";

/* ------------------------- Phase backend API client ------------------------- */
// Real backend: issuance (draft → agreement → sign → mint) and funding.
//
// Central API configuration. Production is live; add staging/dev URLs here
// when those environments exist and switch PHASE_BACKEND_URL below.
//   staging: "https://phase-backend-staging.onrender.com/api/v1",
//   dev:     "http://localhost:3000/api/v1",
const API_CONFIG = {
  production: "https://phase-backend.onrender.com/api/v1",
};
const PHASE_BACKEND_URL = API_CONFIG.production;

// Per-install identity: a stable random ID per device install, persisted in
// localStorage. Replaces the old hardcoded "app-user" so buyer and issuer
// are distinct accounts across devices (and self-trade is correctly
// rejected). This is NOT a login — real authenticated identity still to come.
function phaseUserId() {
  const K = "phase_user_id";
  try {
    let id = localStorage.getItem(K);
    if (!id) {
      id = "u_" + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
      localStorage.setItem(K, id);
    }
    return id;
  } catch {
    return "u_" + Math.random().toString(36).slice(2);
  }
}
const PHASE_USER_ID = phaseUserId();

async function backendFetch(path, { method = "GET", body, idempotencyKey, retries = 3 } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  try {
    const token = getAuthToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  } catch {}

  // Render's free-tier instance spins down after idle and can take 50s+ to
  // wake back up (see Render's own dashboard warning). A cold-start request
  // often fails at the network level — fetch() throws before any response
  // exists — rather than timing out gracefully. Retry with backoff instead
  // of surfacing a bare "Failed to fetch" on the user's first tap.
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(`${PHASE_BACKEND_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      throw new Error(
        "Couldn't reach Phase's servers. They may be waking up from idle — please try again in a moment."
      );
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || `Backend error ${res.status}`);
      err.code = data.error || data.code;
      err.status = res.status;
      err.detail = data;
      throw err;
    }
    return data;
  }
}

/* ------------------------- Auth: real accounts ------------------------- */
const AUTH_TOKEN_KEY = "phase_auth_token";
const AUTH_USER_KEY = "phase_auth_user";
// Bank-style session lock: log out after 10 minutes without interaction.
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
function getAuthToken() {
  try { return localStorage.getItem(AUTH_TOKEN_KEY); } catch { return null; }
}
function getAuthUser() {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function setAuthSession(token, user) {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  } catch {}
  try { window.dispatchEvent(new CustomEvent("phase:auth-changed")); } catch {}
}
function clearAuthSession() {
  // Bank-app behavior: remember who signed in (name/email only — the
  // password is never stored) so the next login is one tap + password.
  try {
    const u = getAuthUser();
    if (u && (u.email || u.name)) {
      localStorage.setItem(
        "phase_remembered",
        JSON.stringify({ email: u.email || "", name: u.name || "" })
      );
    }
  } catch {}
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
  } catch {}
  try { window.dispatchEvent(new CustomEvent("phase:auth-changed")); } catch {}
}
function currentUserId() {
  const u = getAuthUser();
  return u && u.userId ? u.userId : PHASE_USER_ID;
}
function isLoggedIn() {
  return !!getAuthToken();
}
const authApi = {
  signup: (email, password, name) =>
    backendFetch("/auth/signup", { method: "POST", body: { email, password, name } }),
  login: (email, password) =>
    backendFetch("/auth/login", { method: "POST", body: { email, password } }),
  me: () => backendFetch("/auth/me"),
  logout: async () => {
    try { await backendFetch("/auth/logout", { method: "POST" }); } catch {}
    clearAuthSession();
  },
  forgotPassword: (email) =>
    backendFetch("/auth/forgot-password", { method: "POST", body: { email } }),
  resetPassword: (token, password) =>
    backendFetch("/auth/reset-password", { method: "POST", body: { token, password } }),
  verifyEmail: (token) =>
    backendFetch("/auth/verify-email", { method: "POST", body: { token } }),
  deleteAccount: (password) =>
    backendFetch("/auth/account", { method: "DELETE", body: { password } }),
};
const issuanceApi = {
  createDraft: (draft) => backendFetch("/issuance/draft", { method: "POST", body: draft }),
  getAgreement: (draftId) =>
    backendFetch(`/issuance/agreement?draftId=${encodeURIComponent(draftId)}`),
  signAgreement: (draftId, legalName, { issuerCategory = "individual", title = "" } = {}) =>
    backendFetch("/issuance/sign", {
      method: "POST",
      body: { draftId, legalName, accepted: true, userId: currentUserId(), issuerCategory, title },
    }),
  mint: (draftId, { meme = false, idempotencyKey, issuerAddress, totalShares } = {}) =>
    backendFetch("/issuance/mint", {
      method: "POST",
      body: { draftId, meme, userId: currentUserId(), issuerAddress, totalShares },
      idempotencyKey: idempotencyKey || `mint-${draftId}-${Date.now()}`,
    }),
};

// Legal documents: the completed Phase Coin Minting Agreement.
const legalApi = {
  // The full completed agreement — linked from the Sign & Mint page.
  agreementUrl: () => `${PHASE_BACKEND_URL}/legal/minting-agreement.pdf`,
  // The issuer's own signed copy (Article 20 auto-populated) — shown in
  // Documentation & Compliance after issuance.
  signedAgreementUrl: (signatureId) =>
    `${PHASE_BACKEND_URL}/legal/minting-agreement/signed/${encodeURIComponent(signatureId)}`,
};

// Marketplace settlement: real two-legged trades for sovereign coins.
// POST /trades/buy moves buyer USD -> issuer USD and float -> buyer on-chain.
const tradeApi = {
  buy: (chainId, { amountUsd, buyerAddress, idempotencyKey } = {}) =>
    backendFetch("/trades/buy", {
      method: "POST",
      body: { userId: currentUserId(), chainId, amountUsd, buyerAddress },
      idempotencyKey: idempotencyKey || `buy-${chainId}-${Date.now()}`,
    }),
  // Server-authoritative pre-confirmation quote: gross, 80-bps fee, net.
  // The client displays these values; settlement recomputes them server-side.
  quote: (chainId, amountUsd) =>
    backendFetch(
      `/trades/quote?chainId=${encodeURIComponent(chainId)}&amountUsd=${encodeURIComponent(amountUsd)}`
    ),
  balances: () => backendFetch(`/trades/balances?userId=${currentUserId()}`),
  history: (role = "seller") => backendFetch(`/trades/history?userId=${currentUserId()}&role=${role}`),
  topup: (amountUsd) =>
    backendFetch("/trades/topup", { method: "POST", body: { userId: currentUserId(), amountUsd } }),
};

// Issuer directory + coin-for-coin swaps: the "issuers online" marketplace.
// GET /marketplace/coins lists every issued sovereign coin (own + others).
// POST /trades/swap offers units of your own coin in exchange for another's.
const marketApi = {
  directory: () => backendFetch("/marketplace/coins"),
  myCoins: () => backendFetch(`/issuance/coins?userId=${encodeURIComponent(currentUserId())}`),
  chainBalance: (chainId, address) =>
    backendFetch(
      `/sovereign/chains/${encodeURIComponent(chainId)}/balances/${encodeURIComponent(address)}`
    ),
  swap: (targetChainId, { offerChainId, offerUnits, buyerAddress, idempotencyKey } = {}) =>
    backendFetch("/trades/swap", {
      method: "POST",
      body: { userId: currentUserId(), chainId: targetChainId, buyerAddress, offerChainId, offerUnits },
      idempotencyKey: idempotencyKey || `swap-${targetChainId}-${Date.now()}`,
    }),
  // Server-authoritative swap quote: gross target units, fee units, net units.
  swapQuote: (targetChainId, offerChainId, offerUnits) =>
    backendFetch(
      `/trades/swap-quote?chainId=${encodeURIComponent(targetChainId)}&offerChainId=${encodeURIComponent(offerChainId)}&offerUnits=${encodeURIComponent(offerUnits)}`
    ),
};

// Admin API: fee config, treasury, withdrawals, reconciliation, system
// checks, admin management. Every endpoint is admin-gated server-side;
// adminApi.me() lets the client probe privilege without side effects.
const adminApi = {
  me: () => backendFetch("/admin/me"),
  getFeeConfig: () => backendFetch("/admin/fees/config"),
  setFeeConfig: (feeBps, reason) =>
    backendFetch("/admin/fees/config", { method: "PUT", body: { feeBps, reason } }),
  getSummary: (days = 30) =>
    backendFetch(`/admin/fees/summary?days=${encodeURIComponent(days)}`),
  getLedger: (limit = 50, offset = 0) =>
    backendFetch(`/admin/fees/ledger?limit=${limit}&offset=${offset}`),
  getTreasuryBalances: () => backendFetch("/admin/treasury/balances"),
  requestWithdrawal: ({ assetSymbol, amount, destinationRef, provider = "manual" }) =>
    backendFetch("/admin/treasury/withdrawals", {
      method: "POST",
      body: { assetSymbol, amount, destinationRef, provider },
    }),
  listWithdrawals: (status) =>
    backendFetch(
      `/admin/treasury/withdrawals${status ? `?status=${encodeURIComponent(status)}` : ""}`
    ),
  approveWithdrawal: (id) =>
    backendFetch(`/admin/treasury/withdrawals/${encodeURIComponent(id)}/approve`, {
      method: "POST",
    }),
  executeWithdrawal: (id, externalRef) =>
    backendFetch(`/admin/treasury/withdrawals/${encodeURIComponent(id)}/execute`, {
      method: "POST",
      body: { externalRef },
    }),
  runReconciliation: () => backendFetch("/admin/reconciliation/run", { method: "POST" }),
  latestReconciliation: () => backendFetch("/admin/reconciliation/latest"),
  systemChecks: () => backendFetch("/admin/system/checks"),
  listAdmins: () => backendFetch("/admin/users/admins"),
  grantAdmin: (userId) =>
    backendFetch(`/admin/users/${encodeURIComponent(userId)}/grant`, { method: "POST" }),
  revokeAdmin: (userId) =>
    backendFetch(`/admin/users/${encodeURIComponent(userId)}/revoke`, { method: "POST" }),
};

const socialApi = {  getProviders: () => backendFetch("/social/providers"),
  getAuthorizeUrl: (provider, userId) =>
    backendFetch(`/social/${provider}/authorize?userId=${encodeURIComponent(userId)}`),
  getConnections: (userId) =>
    backendFetch(`/social/connections?userId=${encodeURIComponent(userId)}`),
  disconnect: (provider, userId) =>
    backendFetch(`/social/${provider}`, { method: "DELETE", body: { userId } }),
  previewCard: (coinName, ticker, meme) =>
    backendFetch("/social/cards/preview", { method: "POST", body: { coinName, ticker, meme } }),
  announce: (userId, coinName, ticker, meme) =>
    backendFetch("/social/announce", { method: "POST", body: { userId, coinName, ticker, meme } }),
};

// Compact number formatting: 1234 -> "1.2K", 2500000 -> "2.5M"
const formatCount = (n) => {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
};

const fundingApi = {
  getDepositInfo: (userId, chain, currency) => {
    const q = new URLSearchParams({ userId });
    if (chain) q.set("chain", chain);
    if (currency) q.set("currency", currency);
    return backendFetch(`/funding/deposit-address?${q}`);
  },
  getBalances: (userId) =>
    backendFetch(`/funding/balances?userId=${encodeURIComponent(userId)}`),
  getBtcAddress: (userId) =>
    backendFetch(`/funding/btc/address?userId=${encodeURIComponent(userId)}`),
  getBtcBalance: (userId) =>
    backendFetch(`/funding/btc/balance?userId=${encodeURIComponent(userId)}`),
  // Stripe card funding (currently disabled pending live keys)
  createStripeIntent: (userId, amountMinor, currency) =>
    backendFetch(`/stripe/payment-intents?userId=${encodeURIComponent(userId)}`, {
      method: "POST",
      body: { amount: amountMinor, currency, description: "Phase account funding" },
    }),
  confirmStripeIntent: (paymentIntentId) =>
    backendFetch(`/stripe/payment-intents/${encodeURIComponent(paymentIntentId)}/confirm`, {
      method: "POST",
    }),
  getFiatBalances: (userId) =>
    backendFetch(`/stripe/balances?userId=${encodeURIComponent(userId)}`),
};

/* ============================================================================
   PHASE — Onchain settlement for human, creative, and soft-asset value
   Single-file React app. Light-blue glass aesthetic, Φ as living mark.
============================================================================ */

/* ---------------------------------- DATA ---------------------------------- */

// Full asset-class taxonomy. Every listing belongs to one major category and
// (usually) one subsection. This is the single source of truth for the Go
// Live category picker, Marketplace filters, and card badges. "Asset" here
// follows the stricter definition: something with a claim to capital
// appreciation or income generation, not just attention.
const ASSET_CATEGORIES = {
  stocks: {
    label: "Public Stocks",
    icon: "stocks",
    complianceClass: "financial",
    usesSocialProof: false,
    subsections: ["Technology", "Energy", "Healthcare", "Financials", "Consumer Discretionary"],
  },
  privateStocks: {
    label: "Private Stocks & Pre-IPO",
    icon: "finance",
    complianceClass: "financial",
    usesSocialProof: false,
    subsections: ["Late-Stage Venture", "Special Purpose Vehicles (SPVs)"],
  },
  realEstate: {
    label: "Real Estate",
    icon: "realEstate",
    complianceClass: "hardAsset",
    usesSocialProof: false,
    subsections: ["Residential", "Commercial"],
  },
  energy: {
    label: "Energy",
    icon: "energy",
    complianceClass: "hardAsset",
    usesSocialProof: false,
    subsections: ["Renewables", "Oil & Gas"],
  },
  finance: {
    label: "Finance",
    icon: "finance",
    complianceClass: "financial",
    usesSocialProof: false,
    subsections: ["Private Credit", "Venture & Private Equity", "Tokenized Funds"],
  },
  smallBusiness: {
    label: "Small Businesses",
    icon: "soft",
    complianceClass: "business",
    usesSocialProof: false,
    subsections: ["Hospitality & Retail", "Logistics & Supply", "Local Infrastructure"],
  },
  socialMedia: {
    label: "Social Media & Audience Capital",
    icon: "person",
    complianceClass: "talent",
    usesSocialProof: true,
    subsections: ["YouTube Content Channels", "TikTok Creators", "X Audience Distribution Networks"],
  },
  arts: {
    label: "Arts",
    icon: "arts",
    complianceClass: "talent",
    usesSocialProof: true,
    subsections: ["High-Value Fine Art", "Digital Generative Collections (NFTs)"],
  },
  collectibles: {
    label: "Collectibles",
    icon: "hard",
    complianceClass: "hardAsset",
    usesSocialProof: false,
    subsections: ["Luxury Automotives", "Chronographs & Watches", "Rare Assets"],
  },
  sportsTalent: {
    label: "Sports & Talent",
    icon: "person",
    complianceClass: "talent",
    usesSocialProof: true,
    subsections: ["Athlete Income Share Agreements (ISAs)", "Independent Developer Alpha Pipelines"],
  },
  intellectualProperty: {
    label: "Intellectual Property",
    icon: "soft",
    complianceClass: "talent",
    usesSocialProof: false,
    subsections: ["Music Royalty Catalogues", "Patent Pools", "Open-Source Software Protocols"],
  },
};

// Networks are a SEPARATE filter axis from category. Category answers "what
// economically is this asset" (a stock, a fund, a piece of real estate);
// network answers "where does it live and who verifies it." A listing has
// exactly one category and exactly one network. This mirrors how the same
// economic asset (e.g. a tokenized Treasury fund) can appear on different
// rails with different compliance backers.
const NETWORKS = {
  canton: { label: "Canton Network", short: "Canton" },
  nasdaq: { label: "Nasdaq Digital Ledger", short: "Nasdaq" },
  fidelity: { label: "Fidelity Financial Rails", short: "Fidelity" },
  ethereum: { label: "Ethereum", short: "Ethereum" },
  phaseNative: { label: "Phase Native Architecture", short: "Phase Native" },
};

// Compliance requirements are keyed by class, not individual category, since
// many categories share the same kind of legal instrument. Retained in
// lightweight form as informational hints on the sovereign chain flow, not
// as a hard gate to publishing — provisioning a chain is instant.
const COMPLIANCE_META = {
  talent: {
    docLabel: "Talent / Representation Agreement",
    docHint:
      "Optional: an agreement (e.g. with a talent agency, manager, or self-drafted representation contract) documenting how you're representing this value onchain.",
    licenseLabel: "Government-Issued ID (for identity verification)",
  },
  business: {
    docLabel: "Business Registration or Operating Agreement",
    docHint:
      "Optional: articles of incorporation, business license, or an operating agreement backing this entity.",
    licenseLabel: "Business License / Registration Number",
  },
  hardAsset: {
    docLabel: "Title, Deed, or Government License",
    docHint: "Optional: proof of ownership (title, deed, registration) or the relevant government license.",
    licenseLabel: "Title / Registration / License Number",
  },
  financial: {
    docLabel: "Regulatory Filing or Custody Confirmation",
    docHint: "Optional: documentation confirming the underlying security or fund position is legitimately held.",
    licenseLabel: "Custody Account / Filing Reference Number",
  },
};

// Every sovereign chain mints exactly this many fractional shares at
// provisioning time — a fixed constant so the split math and share-unit
// math stay identical across every chain on the network.
const SOVEREIGN_TOTAL_SHARES = 1_000_000;

function generateChainId() {
  // Six-digit sovereign chain identifier, e.g. "Φ-482913"
  return "Φ-" + String(Math.floor(100000 + Math.random() * 900000));
}

function genesisBlock(assetName, ticker) {
  return {
    height: 0,
    label: "Genesis",
    detail: `${assetName} (${ticker}) sovereign ledger initialized · ${SOVEREIGN_TOTAL_SHARES.toLocaleString()} shares minted · zero base fee`,
    time: Date.now(),
  };
}

// The Go Live entry screen offers three broad paths instead of forcing a
// person to pick from the full ~11-category browsing taxonomy used in the
// Marketplace. Each path lists a handful of common, recognizable examples
// as tappable chips; every chip maps onto the existing category/subsection
// system underneath so the browsing taxonomy stays the single source of
// truth. A "describe your own" option is always available per path for
// anything that doesn't fit a listed example.
const GOLIVE_PATHS = {
  capital: {
    label: "MyCoin",
    sublabel: "Your personal coin — creativity, talent, audience, or future earning potential",
    icon: "person",
    examples: [
      { label: "Social Media / Creator Channel", category: "socialMedia", subsection: "YouTube Content Channels" },
      { label: "Athlete or Performer", category: "sportsTalent", subsection: "Athlete Income Share Agreements (ISAs)" },
      { label: "Independent Developer / Builder", category: "sportsTalent", subsection: "Independent Developer Alpha Pipelines" },
      { label: "Visual or Recording Artist", category: "arts", subsection: "High-Value Fine Art" },
      { label: "Student / Future Earning Potential", category: "sportsTalent", subsection: "Independent Developer Alpha Pipelines" },
    ],
  },
  business: {
    label: "Blockchain for My Business",
    sublabel: "A small business, consultancy, professional practice, or side gig",
    icon: "soft",
    examples: [
      { label: "Local Shop or Restaurant", category: "smallBusiness", subsection: "Hospitality & Retail" },
      { label: "Consultancy or Professional Practice", category: "smallBusiness", subsection: "Local Infrastructure" },
      { label: "Independent Instructor (Yoga, Coaching, Tutoring)", category: "smallBusiness", subsection: "Local Infrastructure" },
      { label: "Online Business or Side Gig", category: "smallBusiness", subsection: "Logistics & Supply" },
    ],
  },
  asset: {
    label: "Blockchain for My Assets",
    sublabel: "Something you own that appreciates in value or generates income",
    icon: "hard",
    examples: [
      { label: "Real Estate", category: "realEstate", subsection: "Residential" },
      { label: "Energy or Infrastructure", category: "energy", subsection: "Renewables" },
      { label: "Collectible (Watches, Cars, Cards, Wine)", category: "collectibles", subsection: "Rare Assets" },
      { label: "Music, Patents, or Other IP", category: "intellectualProperty", subsection: "Music Royalty Catalogues" },
      { label: "Private Company Equity / Pre-IPO", category: "privateStocks", subsection: "Late-Stage Venture" },
    ],
  },
};

const CURRENCIES = [
  { id: "usd", label: "US Dollar", short: "USD", group: "Fiat", symbol: "$" },
  { id: "cad", label: "Canadian Dollar", short: "CAD", group: "Fiat", symbol: "$" },
  { id: "usdc", label: "USD Coin", short: "USDC", group: "Stablecoin" },
  { id: "usdt", label: "Tether", short: "USDT", group: "Stablecoin" },
  { id: "cadc", label: "CAD Coin", short: "CADC", group: "Stablecoin" },
  { id: "qcad", label: "QCAD", short: "QCAD", group: "Stablecoin" },
  { id: "btc", label: "Bitcoin", short: "BTC", group: "Crypto" },
  { id: "eth", label: "Ethereum", short: "ETH", group: "Crypto" },
  { id: "phase", label: "PHASE Coin", short: "PHASE", group: "Crypto" },
];

// Baseline mock FX rates (1 USD -> unit). These drift slightly over time via
// the live rate engine below so the dashboard genuinely updates, the same
// way the asset price ticker does. This is illustrative, not live market data.
// PHASE is valued at 10% of USD (1 PHASE = $0.10, so $1 = 10 PHASE).
const BASE_FX = {
  usd: 1,
  cad: 1.36,
  usdc: 1,
  usdt: 1,
  cadc: 1.36,
  qcad: 1.36,
  btc: 0.0000094,
  eth: 0.00027,
  phase: 10,
};

const PLATFORMS = ["YouTube", "TikTok", "X", "Instagram"];

// Funding methods offered in the "Fund Account" flow. Funding is crypto-only:
// the only rail is a crypto wallet transfer (USDC/USDT). Fiat methods (card,
// Interac, wire, ACH, Cash App) were removed -- they were simulated and are
// not part of the product.
const FUNDING_METHODS = [
  { id: "crypto", label: "Crypto Wallet Transfer", icon: "stocks", note: "Send USDC or USDT from an external wallet." },
];

// DRAFT — requires legal review before production.
// Privacy policy shown in-app (Settings → Privacy Policy) and linked from
// the signup screen. Contact placeholder must be replaced with the real
// privacy contact before launch.
const PRIVACY_POLICY = `Phase Privacy Policy (Draft)

Last updated: September 2026

1. Data we collect.
Account information: your name, email address, and password (stored as a one-way hash — we never store your plain-text password). Issued assets: the coins, chains, and listings you create, including names, descriptions, images, and social/website links you provide. Transaction history: trades, funding events, and balances associated with your account. Device data: basic technical information needed to operate the app (device type, app version).

2. How we use it.
We use your data to operate your account, display your dashboard and marketplace activity, process issuance and trades, provide support, and comply with legal obligations. We do not sell your personal data.

3. Data sharing.
We do not share your personal data with third parties except as required by law (for example, a valid court order or regulatory request) or to operate core infrastructure (hosting, crash reporting). Any such provider only receives the minimum data needed to perform its function.

4. Data retention.
We keep your account data for as long as your account is active. If you delete your account, we permanently delete your personal data, issued assets, and transaction history, except for records we are legally required to retain (for example, financial records subject to tax or anti-fraud law).

5. Your rights.
You may request a copy of your data, correct inaccurate data, or delete your account and personal data at any time from Settings → Delete Account. For other requests, contact privacy@phase.app. // TODO: replace with the real privacy contact before production.

6. Security.
We protect your data with encrypted connections, authenticated API access, and server-side session management. No system is perfectly secure; if we learn of a breach affecting your data, we will notify you as required by law.

7. Changes.
If we change this policy materially, we will notify you in the app before the changes take effect.
`;

const ONCHAINING_TERMS = `Phase Sovereign Chain Terms & Consent

1. Accuracy of Information. By provisioning a sovereign chain, you confirm that the description, social proof metrics, and any supporting documentation you provide are accurate to the best of your knowledge.

2. Isolated Ledger. Your chain is a dedicated, sandboxed ledger instance — its trading activity, liquidity, and volatility are isolated from every other chain on Phase and cannot affect or be affected by them.

3. Share Split & Pricing. The public/retained split and starting share price you configure at provisioning are yours to set. 1,000,000 fractional shares are minted at genesis and allocated accordingly.

4. No Guarantee of Value. Share prices are not guaranteed and may fluctuate. Phase does not provide investment advice.

5. Revocability. Phase reserves the right to suspend a chain if the underlying information is found to be inaccurate or fraudulent.

DRAFT — pending legal review. This summary does not constitute legal advice.`;

// Produces the text of an auto-generated Sovereign Chain Charter using the
// person's own entered information \u2014 a lightweight, informational record
// of the chain's genesis parameters (split, starting price, value thesis),
// not a securities-style equity agreement. Optional; only shown if a
// person wants a readable summary of what they just provisioned.
const BUSINESS_ATTESTATION_TEXT = (businessName, ticker) => `BUSINESS ATTESTATION — PHASE SOVEREIGN CHAIN

Business: ${businessName} (${ticker})
Date: ${new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}

1. Identity. I represent that I am authorized to act on behalf of the business named above and that the business name, description, and value thesis provided are accurate to the best of my knowledge.

2. No Registration Documents. I acknowledge that I have not uploaded business registration, incorporation, licensing, or operating-agreement documents. This attestation stands in place of such documentation.

3. Accuracy of Representations. I warrant that all statements made about this business — its nature, operations, and value proposition — are truthful and not misleading. I understand that purchasers of ${ticker} may rely on these representations.

4. Authority & Compliance. I represent that this business operates lawfully in its jurisdiction and that issuing a sovereign chain for it does not violate any applicable law, regulation, or contractual obligation known to me.

5. Ongoing Duty. I agree to correct any material inaccuracy in the business information promptly upon becoming aware of it.

6. Isolated Ledger. I understand this chain is an isolated ledger — its trading activity and value are independent of every other chain on Phase.

7. Digital Signature. My typed legal name below constitutes my digital signature on this attestation and binds me to its terms.

DRAFT — pending legal review. This document is generated automatically from the information provided and is not a substitute for independent legal advice.`;
function generateAgreementText({ ownerName, listingName, valueThesis, equityPublic, equityRetained, docLabel }) {
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return `PHASE ISSUER AGREEMENT
Generated by Phase Platforms \u2014 ${date}

This Issuer Agreement ("Agreement") is made by the undersigned issuer ("Issuer") for the benefit of each person who purchases shares of the coin described below ("Purchasers").

1. The Coin. Issuer is listing "${listingName || "[Coin Name]"}" (the "Coin") on the Phase network. Issuer describes the basis of the Coin's value as follows: "${valueThesis || "[Value thesis as entered by Issuer]"}"

2. Share Split. At genesis, 1,000,000 shares of the Coin are minted: ${equityPublic}% allocated to the public float and ${equityRetained}% retained by Issuer.

3. Issuer Representations. Issuer represents and warrants to each Purchaser that:
   (a) Identity & Authority \u2014 Issuer is the person or business named below and has full authority to enter into this Agreement and to tokenize and offer the described value;
   (b) Accuracy \u2014 all information Issuer provided about the Coin is true and complete to Issuer's knowledge, with no material fact omitted and no misleading statement;
   (c) Rights \u2014 tokenizing and offering the described value does not infringe the rights of any third party;
   (d) Compliance \u2014 Issuer will comply with all applicable laws in connection with the Coin.

4. Value Sharing. Issuer intends that any future income, appreciation, royalties, or other economic value generated by the activity or asset described for this Coin will be reflected in the Coin's share price, in proportion to the split in Section 2, for as long as shares remain publicly held.

5. Purchaser Acknowledgments. Each Purchaser acknowledges that: (i) no return is guaranteed and the Coin's value may fall to zero; (ii) the Coin trades on an isolated ledger whose price moves independently of any other chain; (iii) the Coin is a novel digital asset with uncertain regulatory treatment.

6. Term. This Agreement remains in effect for as long as any shares of the Coin are publicly held.

7. Governing Terms. This Agreement incorporates Phase's Onchaining Terms & Consent by reference.

Signed: ${ownerName || "[Issuer legal name]"} \u2014 ${date}

DRAFT \u2014 pending legal review. This document is generated automatically from information Issuer provided and is not a substitute for independent legal advice.`;
}

const NEWS_ITEMS = [
  {
    tag: "Education",
    title: "What does it mean to be \u201Conchain\u201D?",
    body: "Putting an asset on the network means its ownership and cash-flow rights are tracked on a shared, tamper-resistant ledger instead of a private spreadsheet or platform database.",
  },
  {
    tag: "News",
    title: "Stablecoins crossed $180B in circulating supply",
    body: "Dollar-pegged digital currency continues to serve as the settlement layer of choice for cross-border creator payouts and fractional investment.",
  },
  {
    tag: "Guide",
    title: "Reading a Network Authority Score",
    body: "Authority scores blend audience size, engagement velocity, and cash-flow consistency into one number allocators can compare across very different asset types.",
  },
  {
    tag: "Education",
    title: "Sovereign Equity vs. traditional equity",
    body: "Unlike a typical cap table, Sovereign Equity Splits are enforced automatically: the owner always keeps a transparent, guaranteed minimum stake.",
  },
  {
    tag: "Guide",
    title: "Why Phase requires documentation",
    body: "Verified social reach and signed documentation are what separate investment-grade chains from speculative attention \u2014 both protect shareholders and the person going live.",
  },
];

/* ------------------------- Phi guide brain ------------------------- */
// Conversational mock brain for Phi, the in-app guide. Today it answers from
// scripted knowledge; the live path is a single swap in queryPhiBrain() below:
// POST the message history to /api/guide/chat on the Phase backend, which
// proxies to the Llama API (see phase-backend/guide-proxy.ts). Nothing else in
// the UI changes.

const PHI_GREETING =
  "Hi, I'm Phi \u2014 your guide to Phase. Ask me anything: going live, the coin split, the Issuer Agreement, or investing.";

const PHI_SUGGESTIONS = [
  "How do I go live?",
  "How does investing work?",
  "What's the Issuer Agreement?",
];

function getPhiReply(rawText) {
  const t = (rawText || "").toLowerCase();
  const has = (...words) => words.some((w) => t.includes(w));

  if (has("go live", "golive", "onchain", "on-chain", "issue", "list myself", "mint", "create a coin", "mycoin", "my coin")) {
    return {
      text: "Going live takes about two minutes: describe your value, link your social profiles or business numbers, set your Sovereign Equity Split, then sign the Issuer Agreement. I can take you straight there.",
      actions: [{ label: "Open Go Live", tab: "golive" }],
      suggestions: ["What's a Sovereign Equity Split?", "What's the Issuer Agreement?"],
    };
  }
  if (has("split", "equity", "percent", "stake", "retain", "sovereign")) {
    return {
      text: "The Sovereign Equity Split decides how much of your future upside you sell publicly vs. keep. Move one side and the other adjusts automatically \u2014 it always totals 100%, so your stake is always clear.",
      suggestions: ["How do I go live?", "What's the Issuer Agreement?"],
    };
  }
  if (has("agreement", "contract", "legal", "sign", "signature")) {
    return {
      text: "The Issuer Agreement is the Phase Coin Minting Agreement you sign when you go live \u2014 a commitment to everyone who buys your coin covering who you are, the accuracy of your statements, and how value is shared. You can open the full PDF in the signing step, and your signed copy lands in Documentation & Compliance.",
      suggestions: ["How do I go live?", "How does investing work?"],
    };
  }
  if (has("invest", "buy", "purchase", "allocat")) {
    return {
      text: "The Marketplace is the live directory of every listed person, business, and asset. Pick one, choose your currency \u2014 cash, stablecoin, or crypto \u2014 and invest. Trades settle live on each coin's own Phase chain.",
      actions: [{ label: "Open Marketplace", tab: "market" }],
      suggestions: ["How do I go live?", "Is this real money?"],
    };
  }
  if (has("marketplace", "browse", "listing")) {
    return {
      text: "The Marketplace lists every coin on the network \u2014 people, businesses, and assets. You can jump straight to a category from the dropdown or browse everything.",
      actions: [{ label: "Open Marketplace", tab: "market" }],
      suggestions: ["How does investing work?"],
    };
  }
  if (has("social", "profile", "verify", "verification", "follower", "tiktok", "youtube", "instagram")) {
    return {
      text: "When you go live you can link multiple social profiles \u2014 YouTube, TikTok, X, Instagram. Each one shows as a clickable badge on your listing so investors can check you out. Links are shown as unverified for now.",
      suggestions: ["How do I go live?", "What's the Issuer Agreement?"],
    };
  }
  if (has("dashboard", "portfolio", "holding", "net worth", "balance")) {
    return {
      text: "Your Dashboard shows your portfolio, holdings, cash balances, and transaction history across every currency.",
      actions: [{ label: "Open Dashboard", tab: "dashboard" }],
      suggestions: ["How does investing work?"],
    };
  }
  if (has("fee", "cost", "price", "charge", "free", "real money")) {
    return {
      text: "Trading on Phase is free while we launch. Fees and terms will be shown before you confirm anything.",
      suggestions: ["How do I go live?", "How does investing work?"],
    };
  }
  if (has("wallet", "fund", "usdc", "circle", "deposit", "crypto")) {
    return {
      text: "You can fund your account from the Dashboard. Card funding is not available yet; crypto funding is being connected.",
      actions: [{ label: "Open Dashboard", tab: "dashboard" }],
      suggestions: ["Is this real money?"],
    };
  }
  if (has("what is phase", "what even", "how does phase work", "explain phase")) {
    return {
      text: "Phase lets anyone \u2014 a creator, an athlete, a small business, even a physical asset \u2014 turn real-world value into shares people can invest in. You publish, allocators fund you, you grow.",
      suggestions: ["How do I go live?", "How does investing work?"],
    };
  }
  if (has("hello", "hey", "yo", "sup") || t.trim() === "hi") {
    return {
      text: "Hey! Ask me about going live, investing, the Issuer Agreement \u2014 or tap a suggestion below.",
      suggestions: PHI_SUGGESTIONS,
    };
  }
  if (has("thank", "thx", "got it", "perfect", "awesome", "cool")) {
    return {
      text: "Anytime. I'll be right here if you need me.",
      suggestions: PHI_SUGGESTIONS,
    };
  }
  return {
    text: "I can help with going live, the coin split, the Issuer Agreement, social profiles, or investing. What would you like to know?",
    suggestions: PHI_SUGGESTIONS,
  };
}

// Single swap point for the live brain. When the backend proxy is ready,
// replace the body with:
//   const res = await fetch("/api/guide/chat", { method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({ messages }) });
//   return res.json();
async function queryPhiBrain(messages) {
  const lastUser = [...messages].reverse().find((m) => m.from === "user");
  // Tiny delay so the typing indicator feels natural.
  await new Promise((r) => setTimeout(r, 450));
  return getPhiReply(lastUser ? lastUser.text : "");
}

/* ------------------------------- UTILITIES -------------------------------- */

function formatCurrency(amountUsd, currencyId, liveFx) {
  const fx = liveFx || BASE_FX;
  const meta = CURRENCIES.find((x) => x.id === currencyId);
  const rate = fx[currencyId] != null ? fx[currencyId] : BASE_FX[currencyId] || 1;
  const val = amountUsd * rate;

  if (!meta) return `$${amountUsd.toFixed(2)}`;

  if (currencyId === "phase") {
    return `${val.toLocaleString(undefined, { maximumFractionDigits: 2 })} PHASE`;
  }
  if (meta.group === "Crypto") {
    const decimals = currencyId === "btc" ? 6 : 4;
    return `${val.toFixed(decimals)} ${meta.short}`;
  }
  if (meta.group === "Stablecoin") {
    return `${val.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${meta.short}`;
  }
  // Fiat
  return `${meta.symbol}${val.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

// Deterministic mock yield/expense-ratio figures for fund-like listings, so
// the same fund always shows the same illustrative numbers rather than
// re-randomizing on every render. Purely illustrative \u2014 real figures live
// behind the "Verify Certified Deep Financials" outbound link.
function mockFundMetrics(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % 100000;
  }
  const yieldPct = (3.8 + (hash % 220) / 100).toFixed(2);
  const expenseRatioPct = (0.1 + (hash % 35) / 100).toFixed(2);
  return { yieldPct, expenseRatioPct };
}

// Returns the 3-4 "Core Operational Snapshot" datapoints shown in the Stage 1
// expanded tray. The datapoints shown differ by what kind of asset this is:
// social/talent listings show audience velocity, fund-like listings show
// yield and expense ratio, everything else shows generic deal metrics.
function formatFollowerCount(raw) {
  const n = parseInt(raw, 10);
  if (!n) return "0";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

function getOperationalSnapshot(asset) {
  const isFund = asset.category === "finance" && asset.subsection === "Tokenized Funds";
  if (isFund) {
    const { yieldPct, expenseRatioPct } = mockFundMetrics(asset.name);
    return [
      { label: "7-Day Yield", value: `${yieldPct}%` },
      { label: "Expense Ratio", value: `${expenseRatioPct}%` },
      { label: "Authority Score", value: `${asset.authorityScore}` },
    ];
  }
  if (asset.marketCap) {
    return [
      { label: "Market Cap", value: asset.marketCap },
      { label: "Authority Score", value: `${asset.authorityScore}` },
      { label: "Public / Retained Split", value: `${asset.equityPublic}% / ${asset.equityRetained}%` },
    ];
  }
  if (asset.platform) {
    return [
      { label: "Authority Score", value: `${asset.authorityScore}` },
      { label: `${asset.platform} Followers`, value: formatFollowerCount(asset.followers) },
      { label: "Engagement Velocity", value: `${asset.engagement || "0"}%` },
    ];
  }
  return [
    { label: "Authority Score", value: `${asset.authorityScore}` },
    { label: "Public / Retained Split", value: `${asset.equityPublic}% / ${asset.equityRetained}%` },
  ];
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* ------------------------------ Φ LOGO (SVG) ------------------------------- */
/* The signature element: a living settlement mark. The vertical stroke draws
   itself in a continuous loop (flow of value), the outer loop breathes via
   scale, and on hover a neon settlement-pulse fires along the ring. */

function PhiMark({ size = 36, animated = true, onClick, title }) {
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title || "Phase"}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        cursor: onClick ? "pointer" : "default",
        display: "inline-flex",
        lineHeight: 0,
      }}
      className="phi-mark-btn"
    >
      <img
        src="logo.png"
        width={size}
        height={size}
        alt="Phase"
        style={{ borderRadius: 8, objectFit: "contain" }}
      />
    </button>
  );
}

/* ------------------------------ Mini Sparkline ----------------------------- */

function Sparkline({ points, width = 96, height = 32, positive = true }) {
  if (!points || points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = i * stepX;
      const y = height - ((p - min) / range) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const [hoverX, setHoverX] = useState(null);
  const idx =
    hoverX !== null ? clamp(Math.round(hoverX / stepX), 0, points.length - 1) : null;

  return (
    <div
      style={{ position: "relative", width, height }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setHoverX(e.clientX - rect.left);
      }}
      onMouseLeave={() => setHoverX(null)}
      onTouchMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setHoverX(e.touches[0].clientX - rect.left);
      }}
      onTouchEnd={() => setHoverX(null)}
    >
      <svg width={width} height={height}>
        <path d={path} fill="none" stroke={positive ? "#22c55e" : "#ef4444"} strokeWidth="2" />
        {idx !== null && (
          <>
            <line
              x1={idx * stepX}
              x2={idx * stepX}
              y1={0}
              y2={height}
              stroke="rgba(14,165,233,0.35)"
              strokeWidth="1"
            />
            <circle
              cx={idx * stepX}
              cy={height - ((points[idx] - min) / range) * height}
              r="3"
              fill={positive ? "#22c55e" : "#ef4444"}
            />
          </>
        )}
      </svg>
      {idx !== null && (
        <div className="spark-tooltip" style={{ left: clamp(idx * stepX, 12, width - 12) }}>
          {points[idx].toFixed(2)}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Allocation Donut --------------------------- */
/* Interactive SVG donut chart with hover/tap highlighting and a center label.
   Built natively (no chart library) so it stays dependency-free and portable. */

function AllocationDonut({ segments, size = 168, centerLabel, centerValue }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const radius = size / 2;
  const strokeWidth = size * 0.22;
  const innerRadius = radius - strokeWidth / 2;
  const circumference = 2 * Math.PI * innerRadius;

  if (total <= 0) {
    return (
      <div className="donut-empty" style={{ width: size, height: size }}>
        <Icon name="dashboard" size={28} />
        <span>No allocation yet</span>
      </div>
    );
  }

  let cumulative = 0;
  const arcs = segments
    .filter((seg) => seg.value > 0)
    .map((seg, i) => {
      const fraction = seg.value / total;
      const dashLength = fraction * circumference;
      const offset = cumulative * circumference;
      cumulative += fraction;
      return { ...seg, dashLength, offset, idx: i, pct: fraction * 100 };
    });

  const active = hoverIdx !== null ? arcs.find((a) => a.idx === hoverIdx) : null;

  return (
    <div className="donut-wrap">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: "rotate(-90deg)" }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <circle cx={radius} cy={radius} r={innerRadius} fill="none" stroke="rgba(14,165,233,0.08)" strokeWidth={strokeWidth} />
        {arcs.map((arc) => (
          <circle
            key={arc.label}
            cx={radius}
            cy={radius}
            r={innerRadius}
            fill="none"
            stroke={arc.color}
            strokeWidth={hoverIdx === arc.idx ? strokeWidth * 1.12 : strokeWidth}
            strokeDasharray={`${arc.dashLength} ${circumference - arc.dashLength}`}
            strokeDashoffset={-arc.offset}
            strokeLinecap="butt"
            style={{ transition: "stroke-width 0.15s ease, opacity 0.15s ease", cursor: "pointer" }}
            opacity={hoverIdx === null || hoverIdx === arc.idx ? 1 : 0.45}
            onMouseEnter={() => setHoverIdx(arc.idx)}
            onTouchStart={() => setHoverIdx(arc.idx)}
          />
        ))}
      </svg>
      <div className="donut-center">
        {active ? (
          <>
            <span className="donut-center-value">{active.pct.toFixed(1)}%</span>
            <span className="donut-center-label">{active.label}</span>
          </>
        ) : (
          <>
            <span className="donut-center-value">{centerValue}</span>
            <span className="donut-center-label">{centerLabel}</span>
          </>
        )}
      </div>
    </div>
  );
}

function DonutLegend({ segments }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  return (
    <div className="donut-legend">
      {segments
        .filter((seg) => seg.value > 0)
        .map((seg) => (
          <div className="donut-legend-row" key={seg.label}>
            <span className="donut-legend-swatch" style={{ background: seg.color }} />
            <span className="donut-legend-label">{seg.label}</span>
            <span className="donut-legend-pct">{total > 0 ? ((seg.value / total) * 100).toFixed(1) : "0.0"}%</span>
          </div>
        ))}
    </div>
  );
}

/* ---------------------------- Net Worth Trend Chart ------------------------- */
/* Touch/drag-interactive line + area chart tracking net worth over the
   recorded history snapshots. */

function NetWorthTrendChart({ history, currency, liveFx, width = 320, height = 120 }) {
  const [hoverX, setHoverX] = useState(null);
  if (!history || history.length < 2) {
    return (
      <div className="trend-empty" style={{ width: "100%", height }}>
        <span>Your net worth trend will appear here as the network moves.</span>
      </div>
    );
  }

  const values = history.map((h) => h.valueUsd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const pad = 6;
  const plotHeight = height - pad * 2;

  const points = values.map((v, i) => ({
    x: i * stepX,
    y: pad + plotHeight - ((v - min) / range) * plotHeight,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${height} L0,${height} Z`;

  const idx = hoverX !== null ? clamp(Math.round(hoverX / stepX), 0, points.length - 1) : null;
  const trendUp = values[values.length - 1] >= values[0];

  return (
    <div
      className="trend-chart-wrap"
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setHoverX(e.clientX - rect.left);
      }}
      onMouseLeave={() => setHoverX(null)}
      onTouchMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setHoverX(e.touches[0].clientX - rect.left);
      }}
      onTouchEnd={() => setHoverX(null)}
    >
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={trendUp ? "#0ea5e9" : "#ef4444"} stopOpacity="0.28" />
            <stop offset="100%" stopColor={trendUp ? "#0ea5e9" : "#ef4444"} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#trendFill)" stroke="none" />
        <path d={linePath} fill="none" stroke={trendUp ? "#0ea5e9" : "#ef4444"} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        {idx !== null && (
          <>
            <line x1={points[idx].x} x2={points[idx].x} y1={0} y2={height} stroke="rgba(14,165,233,0.3)" strokeWidth="1" />
            <circle cx={points[idx].x} cy={points[idx].y} r="4" fill={trendUp ? "#0ea5e9" : "#ef4444"} stroke="white" strokeWidth="1.5" />
          </>
        )}
      </svg>
      {idx !== null && (
        <div className="trend-tooltip" style={{ left: clamp(points[idx].x, 36, width - 36) }}>
          {formatCurrency(values[idx], currency, liveFx)}
        </div>
      )}
    </div>
  );
}

/* --------------------------- Asset Trend Chart (Stage 2) ------------------- */
/* A larger, scrubbable historical chart for the full financials view. Shows a
   filled area, a draggable/hoverable cursor, and a floating tooltip with both
   the price and a relative day label at the scrubbed point. */

function AssetTrendChart({ points, currency, liveFx, positive, width = 320, height = 110 }) {
  const [hoverX, setHoverX] = useState(null);
  if (!points || points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const pad = 6;
  const plotHeight = height - pad * 2;

  const coords = points.map((p, i) => ({
    x: i * stepX,
    y: pad + plotHeight - ((p - min) / range) * plotHeight,
  }));
  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${height} L0,${height} Z`;

  const idx = hoverX !== null ? clamp(Math.round(hoverX / stepX), 0, points.length - 1) : null;
  const daysAgo = idx !== null ? points.length - 1 - idx : null;
  const color = positive ? "#0ea5e9" : "#ef4444";

  return (
    <div
      className="asset-trend-chart"
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setHoverX(e.clientX - rect.left);
      }}
      onMouseLeave={() => setHoverX(null)}
      onTouchMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setHoverX(e.touches[0].clientX - rect.left);
      }}
      onTouchEnd={() => setHoverX(null)}
    >
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="assetTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#assetTrendFill)" stroke="none" />
        <path d={linePath} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        {idx !== null && (
          <>
            <line x1={coords[idx].x} x2={coords[idx].x} y1={0} y2={height} stroke="rgba(14,165,233,0.3)" strokeWidth="1" />
            <circle cx={coords[idx].x} cy={coords[idx].y} r="4" fill={color} stroke="white" strokeWidth="1.5" />
          </>
        )}
      </svg>
      {idx !== null && (
        <div className="trend-tooltip asset-trend-tooltip" style={{ left: clamp(coords[idx].x, 42, width - 42) }}>
          <span>{formatCurrency(points[idx], currency, liveFx)}</span>
          <span className="asset-trend-tooltip-day">{daysAgo === 0 ? "now" : `${daysAgo}d ago`}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- Icon set ---------------------------------- */

function Icon({ name, size = 18 }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none" };
  switch (name) {
    case "person":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.6" />
          <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "social":
      return (
        <svg {...common}>
          <circle cx="7" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="17" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="17" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.6" />
          <path d="M9.6 10.8l4.8-3.6M9.6 13.2l4.8 3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "hard":
      return (
        <svg {...common}>
          <path d="M3 11l9-7 9 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 10v9h14v-9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "soft":
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 9h8M8 13h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "stocks":
      return (
        <svg {...common}>
          <path d="M4 17l5-6 4 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 20h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "realEstate":
      return (
        <svg {...common}>
          <path d="M4 21V10l8-6 8 6v11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 21v-6h6v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "energy":
      return (
        <svg {...common}>
          <path d="M13 3L5 14h6l-1 7 8-11h-6l1-7z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "finance":
      return (
        <svg {...common}>
          <path d="M4 19V9M10 19V5M16 19v-7M21 19H3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "arts":
      return (
        <svg {...common}>
          <path
            d="M12 4c-4.4 0-8 3.2-8 7.2 0 3.6 3 6.3 6.6 6.3.6 0 1.1-.5 1.1-1.1 0-.3-.1-.5-.3-.8-.2-.2-.3-.5-.3-.8 0-.6.5-1.1 1.1-1.1H14c3.3 0 6-2.4 6-5.4C20 6 16.4 4 12 4z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle cx="8.7" cy="10.5" r="0.9" fill="currentColor" />
          <circle cx="12" cy="8.3" r="0.9" fill="currentColor" />
          <circle cx="15.3" cy="10.5" r="0.9" fill="currentColor" />
        </svg>
      );
    case "wallet":
      return (
        <svg {...common}>
          <rect x="3" y="6" width="18" height="13" rx="2.4" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3 10h18" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="16.5" cy="14" r="1.3" fill="currentColor" />
        </svg>
      );
    case "directory":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M20 20l-4.4-4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "dashboard":
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
          <rect x="13" y="3.5" width="7.5" height="4.5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
          <rect x="13" y="10.5" width="7.5" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
          <rect x="3.5" y="13.5" width="7.5" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      );
    case "news":
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M7.5 8.5h5M7.5 12h9M7.5 15.5h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "chat":
      return (
        <svg {...common}>
          <path
            d="M4 5h16v10H9l-4 4V5z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="M5 13l5 5L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "coin":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M12 8v8M9.5 9.7c0-1 1-1.7 2.5-1.7s2.5.7 2.5 1.6c0 2-5 1.3-5 3.4 0 .9 1 1.6 2.5 1.6s2.5-.7 2.5-1.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "arrowRight":
      return (
        <svg {...common}>
          <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "chevronDown":
      return (
        <svg {...common}>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "chevronUp":
      return (
        <svg {...common}>
          <path d="M6 15l6-6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "lock":
      return (
        <svg {...common}>
          <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="12" cy="15.2" r="1.2" fill="currentColor" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M15.8 15.8L20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...common}>
          <path d="M20 12a8 8 0 1 1-2.3-5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M20 3.5V8h-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "external":
      return (
        <svg {...common}>
          <path d="M14 4h6v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M20 4L11 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M19 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    default:
      return null;
  }
}

/* ===========================================================================
   APP
=========================================================================== */

/* ------------------------- Auth screen ------------------------- */
function AuthScreen({ onAuthSuccess, initialMode = "signup", notice, onOpenPrivacy }) {
  const [mode, setMode] = useState(initialMode); // signup | login | forgot | reset
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  useEffect(() => {
    try {
      const remembered = JSON.parse(localStorage.getItem("phase_remembered") || "null");
      if (remembered && remembered.email && !email) {
        setEmail(remembered.email);
        if (remembered.name) setName(remembered.name);
      }
    } catch {}
  }, []);
  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError("Enter a valid email address.");
      return;
    }
    if ((mode === "signup" || mode === "login" || mode === "reset") && password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (mode === "signup" && !name.trim()) {
      setError("Enter your name.");
      return;
    }
    if (mode === "reset" && !resetToken.trim()) {
      setError("Enter the reset token.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "forgot") {
        const res = await authApi.forgotPassword(cleanEmail);
        // Dev mode: backend returns the token directly
        if (res.resetToken) setResetToken(res.resetToken);
        setResetSent(true);
        setMode("reset");
      } else if (mode === "reset") {
        await authApi.resetPassword(resetToken.trim(), password);
        setError(null);
        setMode("login");
        setPassword("");
        setResetToken("");
        setResetSent(false);
      } else {
        const res = mode === "signup"
          ? await authApi.signup(cleanEmail, password, name.trim())
          : await authApi.login(cleanEmail, password);
        setAuthSession(res.token, { userId: res.userId, email: res.email, name: res.name });
        try { localStorage.removeItem("phase_remembered"); } catch {}
        onAuthSuccess({ userId: res.userId, email: res.email, name: res.name });
      }
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  const modeTitle = {
    signup: "Create your account",
    login: "Welcome back",
    forgot: "Reset your password",
    reset: "Enter new password",
  }[mode];
  const modeSub = {
    signup: "Going live creates your Phase account. Your coins and balances follow this account across devices.",
    login: "Log in to access your dashboard, marketplace, and issued coins.",
    forgot: "Enter your email and we'll send you a password reset token.",
    reset: resetSent ? "Enter the reset token and choose a new password." : "Enter the reset token and choose a new password.",
  }[mode];
  return (
    <div className="auth-wrap">
      <div className="glass-card auth-card">
        <h2 className="section-title">{modeTitle}</h2>
        <p className="section-sub">{modeSub}</p>
        {notice && <p className="auth-notice">{notice}</p>}
        <form onSubmit={submit} className="auth-form">
          {mode === "signup" && (
            <label className="field">
              <span className="field-label">Name</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" />
            </label>
          )}
          <label className="field">
            <span className="field-label">Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
          </label>
          {(mode === "signup" || mode === "login" || mode === "reset") && (
            <label className="field">
              <span className="field-label">{mode === "reset" ? "New password" : "Password"}</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "signup" ? "At least 8 characters" : mode === "reset" ? "At least 8 characters" : "Your password"} autoComplete={mode === "signup" || mode === "reset" ? "new-password" : "current-password"} />
            </label>
          )}
          {mode === "reset" && (
            <label className="field">
              <span className="field-label">Reset token</span>
              <input type="text" value={resetToken} onChange={(e) => setResetToken(e.target.value)} placeholder="Paste the reset token" autoComplete="off" />
            </label>
          )}
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" className="btn-primary auth-submit" disabled={busy}>
            {busy ? "Please wait…" : mode === "signup" ? "Sign up & continue" : mode === "login" ? "Log in" : mode === "forgot" ? "Send reset token" : "Set new password"}
          </button>
        </form>
        {(mode === "signup" || mode === "login") && (
          <button className="link-btn auth-switch" onClick={() => { setMode(mode === "signup" ? "login" : "signup"); setError(null); }}>
            {mode === "signup" ? "Already have an account? Log in" : "New to Phase? Create an account"}
          </button>
        )}
        {mode === "login" && (
          <button className="link-btn auth-switch" onClick={() => { setMode("forgot"); setError(null); }}>
            Forgot your password?
          </button>
        )}
        {(mode === "forgot" || mode === "reset") && (
          <button className="link-btn auth-switch" onClick={() => { setMode("login"); setError(null); setResetSent(false); }}>
            Back to log in
          </button>
        )}
        {mode === "signup" && (
          <p className="auth-legal">
            By signing up you agree to our{" "}
            <button type="button" className="link-btn" onClick={onOpenPrivacy}>
              Privacy Policy
            </button>
            .
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------- Account modals ------------------------- */
// Privacy policy viewer. Content is PRIVACY_POLICY (draft — legal review
// required before production).
function PrivacyPolicyModal({ onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card terms-modal" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <h3>Privacy Policy</h3>
        <div className="terms-body">
          {PRIVACY_POLICY.split("\n\n").map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
        <button className="btn-primary btn-full" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

// Delete-account confirmation: explains permanence and requires the
// account password before calling DELETE /api/v1/auth/account.
function DeleteAccountModal({ onClose, onDeleted }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!password) {
      setError("Enter your password to confirm deletion.");
      return;
    }
    setBusy(true);
    try {
      await authApi.deleteAccount(password);
      onDeleted();
    } catch (err) {
      setError(err.message || "Could not delete your account. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <h3 className="danger-title">Delete Account</h3>
        <p className="section-sub">
          This permanently deletes your account, all issued assets, transaction
          history, and personal data. This cannot be undone.
        </p>
        <form onSubmit={submit} className="auth-form">
          <label className="field">
            <span className="field-label">Confirm with your password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              autoComplete="current-password"
            />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" className="btn-danger btn-full" disabled={busy}>
            {busy ? "Deleting…" : "Permanently delete my account"}
          </button>
          <button type="button" className="btn-secondary btn-full" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </form>
      </div>
    </div>
  );
}

// Account settings: user info, privacy policy link, delete-account entry.
function AccountModal({ authUser, onClose, onOpenPrivacy, onOpenDelete }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <h3>Account</h3>
        {authUser && (
          <div className="account-info">
            {authUser.name ? <p className="account-name">{authUser.name}</p> : null}
            {authUser.email ? <p className="account-email">{authUser.email}</p> : null}
          </div>
        )}
        <button className="link-btn account-row" onClick={onOpenPrivacy}>
          Privacy Policy
        </button>
        <div className="account-danger-zone">
          <p className="danger-zone-label">Danger zone</p>
          <button className="btn-danger btn-full" onClick={onOpenDelete}>
            Delete Account
          </button>
        </div>
        <button className="btn-secondary btn-full" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

// Error boundary: catches render crashes (e.g. bad data after login) and
// shows the error instead of a black screen.
class PhaseErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    try {
      console.error("Phase render crash:", error, info);
    } catch {}
    // Report to Sentry when configured; fails silently otherwise.
    try {
      reportError(error, info && info.componentStack ? { componentStack: info.componentStack } : undefined);
    } catch {}
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: "#fff", background: "#111", minHeight: "100vh" }}>
          <h2>Something went wrong</h2>
          <p>Please restart the app. If this keeps happening, contact support.</p>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.7 }}>
            {String(this.state.error && this.state.error.message || this.state.error)}
          </pre>
          <button
            onClick={() => { try { localStorage.clear(); } catch {} window.location.reload(); }}
            style={{ marginTop: 16, padding: "12px 24px", borderRadius: 8 }}
          >
            Reset and reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppInner() {
  const [activeTab, setActiveTab] = useState("golive"); // golive | market | dashboard
  const [authUser, setAuthUser] = useState(() => getAuthUser());
  const [authReady, setAuthReady] = useState(false);
  const isAndroid = useMemo(() => /Android/.test(navigator.userAgent || ""), []);
  const [showSplash, setShowSplash] = useState(true);
  // Account modals: null | "account" | "privacy" | "delete"
  const [accountModal, setAccountModal] = useState(null);
  // Notice shown on the auth screen (e.g. after account deletion).
  const [authNotice, setAuthNotice] = useState(null);
  // Admin privilege: probed once per login via /admin/me. Non-admins never
  // see the admin dashboard entry point.
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  useEffect(() => {
    if (!authUser) {
      setIsAdmin(false);
      setShowAdmin(false);
      return;
    }
    let cancelled = false;
    adminApi
      .me()
      .then((r) => {
        if (!cancelled) setIsAdmin(!!r.isAdmin);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authUser]);
  // Welcoming splash: Phase mark on open, fades away quickly.
  useEffect(() => {
    const t = setTimeout(() => setShowSplash(false), 1400);
    return () => clearTimeout(t);
  }, []);
  // Fetch the user's real issued coins from the backend and merge them into
  // the asset list as owned products.
  const refreshMyCoins = useCallback(async () => {
    if (!isLoggedIn()) return;
    try {
      const data = await marketApi.myCoins();
      const coins = (data.coins || []).map((c) => ({
        id: `coin-${c.mintAddress || c.chainId}`,
        assetId: `coin-${c.mintAddress || c.chainId}`,
        chainId: c.mintAddress || c.chainId,
        name: c.name,
        ticker: c.ticker,
        category: c.category || "socialMedia",
        subsection: c.subsection || "",
        tagline: `${c.name} — your sovereign coin`,
        price: Number(c.priceUsd) || 0,
        prevPrice: Number(c.priceUsd) || 0,
        totalMinted: c.totalShares || 0,
        retainedShares: c.retainedShares || 0,
        socialProfiles: c.socialProfiles || [],
        websiteUrl: c.websiteUrl || null,
        isOwner: true,
        mine: true,
        sovereignLive: true,
      }));
      setAssets((prev) => {
        const filtered = prev.filter((a) => !a.id || !String(a.id).startsWith("coin-") || !a.isOwner);
        const existingIds = new Set(filtered.map((a) => a.id));
        const fresh = coins.filter((c) => !existingIds.has(c.id));
        return [...filtered, ...fresh];
      });
    } catch (e) {
      console.warn("my coins refresh failed", e);
    }
  }, []);
  // Restore session on launch: if a token exists, validate it silently.
  useEffect(() => {
    (async () => {
      try {
        if (getAuthToken()) {
          const me = await authApi.me();
          setAuthSession(getAuthToken(), { userId: me.userId, email: me.email, name: me.name });
          setAuthUser({ userId: me.userId, email: me.email, name: me.name });
          refreshMyCoins();
        }
      } catch {
        clearAuthSession();
        setAuthUser(null);
      } finally {
        setAuthReady(true);
      }
    })();
    const onAuthChanged = () => setAuthUser(getAuthUser());
    window.addEventListener("phase:auth-changed", onAuthChanged);
    return () => window.removeEventListener("phase:auth-changed", onAuthChanged);
  }, []);
  // Bank-style inactivity lock: after INACTIVITY_TIMEOUT_MS with no
  // interaction, the session is logged out automatically. Name/email are
  // remembered (see clearAuthSession) so logging back in is quick; the
  // password is never stored. Redirects to the Go Live login screen.
  useEffect(() => {
    if (!authUser) return;
    let timer = null;
    let lastActivity = Date.now();
    const doLock = async () => {
      await authApi.logout();
      setAuthUser(null);
      setActiveTab("golive");
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(doLock, INACTIVITY_TIMEOUT_MS);
    };
    const onActivity = () => {
      lastActivity = Date.now();
      arm();
    };
    // If the app was backgrounded longer than the timeout, lock on return.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) doLock();
        else arm();
      }
    };
    const events = ["mousedown", "keydown", "touchstart", "touchmove", "wheel", "scroll", "click"];
    events.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    document.addEventListener("visibilitychange", onVisibility);
    arm();
    return () => {
      if (timer) clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, onActivity));
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [authUser]);
  const [showNews, setShowNews] = useState(false);
  const [phaseCoins, setPhaseCoins] = useState(0);
  const [currency, setCurrency] = useState("usd");
  const [assets, setAssets] = useState([]); // live directory — populated from the backend only
  const [holdings, setHoldings] = useState([]); // { assetId, units, costBasisUsd }
  const [txHistory, setTxHistory] = useState([]);
  const [cashBalances, setCashBalances] = useState({}); // { usd: 0, cad: 0, usdc: 0, ... } funded cash, separate from PHASE coins
  // Backend settlement ledger (USD) for sovereign-coin trades. Buyer USD is
  // debited here and issuer USD credited here on every buy — this is the
  // "issuer gets paid" account. Test rails only for now.
  const [tradeCashUsd, setTradeCashUsd] = useState(0);
  const [coinSalesUsd, setCoinSalesUsd] = useState(0); // lifetime earnings as a seller/issuer
  const refreshTradeBalances = useCallback(async () => {
    try {
      const data = await tradeApi.balances();
      setTradeCashUsd(Number(data?.balances?.USD) || 0);
      setCoinSalesUsd(Number(data?.lifetimeSalesUsd) || 0);
    } catch (e) {
      console.warn("trade balances refresh failed", e);
    }
  }, []);
  useEffect(() => {
    refreshTradeBalances();
  }, [refreshTradeBalances]);
  const [cryptoFunded, setCryptoFunded] = useState(false); // true once crypto balances are detected
  const [hasIssuedCoin, setHasIssuedCoin] = useState(false); // true once the user mints their own coin
  const [netWorthHistory, setNetWorthHistory] = useState([]); // [{ t, valueUsd }] for the dashboard trend line
  const [chatOpen, setChatOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [liveFx, setLiveFx] = useState(BASE_FX);
  // Sovereign wallet: Ed25519 keypair for signing ledger transactions.
  // Generated on first launch, persisted as JWK in localStorage.
  const [sovereignWallet, setSovereignWallet] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const stored = localStorage.getItem("phase_sovereign_wallet");
        if (stored) {
          const { jwk, pubkeyHex } = JSON.parse(stored);
          const w = await restoreWallet(jwk, pubkeyHex);
          setSovereignWallet(w);
        } else {
          const w = await generateWallet();
          localStorage.setItem("phase_sovereign_wallet", JSON.stringify({ jwk: w.jwk, pubkeyHex: w.pubkeyHex }));
          setSovereignWallet(w);
        }
      } catch (e) {
        console.error("sovereign wallet init failed", e);
        showToast("Wallet initialization failed — issuance is unavailable. Please restart the app.");
      }
    })();
  }, []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // Poll crypto funding balances — unlocks the dashboard once deposits
  // land (or once the user mints their own coin).
  const refreshFundingStatus = useCallback(async () => {
    try {
      const data = await fundingApi.getBalances(currentUserId());
      const balances = data.balances || data || {};
      const total = Object.values(balances).reduce((sum, b) => {
        const credited = typeof b === "object" ? (b.credited || 0) : b;
        return sum + (Number(credited) || 0);
      }, 0);
      setCryptoFunded(total > 0);
    } catch {
      // Backend unreachable — stay locked, don't crash
    }
  }, []);

  useEffect(() => {
    refreshFundingStatus();
    const t = setInterval(refreshFundingStatus, 30000);
    return () => clearInterval(t);
  }, [refreshFundingStatus]);

  // Dashboard gate lifted for now — show the full interface so we can see it.
  // Re-enable with: const dashboardUnlocked = cryptoFunded || hasIssuedCoin;
  const dashboardUnlocked = true;


  // Net worth, computed once here so both the dashboard figure and the
  // trend-line history snapshot stay perfectly in sync.
  const netWorthUsd = useMemo(() => {
    const investmentsUsd = holdings.reduce((sum, h) => {
      const asset = assets.find((a) => a.id === h.assetId);
      return asset ? sum + h.units * asset.price : sum;
    }, 0);
    const ownedProductsUsd = assets
      .filter((a) => a.isOwner)
      .reduce((sum, a) => sum + a.price * (a.retainedShares != null ? a.retainedShares : a.equityRetained), 0);
    const cashUsd = Object.entries(cashBalances).reduce((sum, [id, amt]) => {
      const rate = liveFx[id] != null ? liveFx[id] : BASE_FX[id] || 1;
      return sum + amt / rate;
    }, 0);
    const phaseRate = liveFx.phase != null ? liveFx.phase : BASE_FX.phase;
    const phaseCoinsUsd = phaseCoins / phaseRate; // PHASE is valued at 10% of USD (rate = 10)
    return investmentsUsd + ownedProductsUsd + cashUsd + phaseCoinsUsd;
  }, [holdings, assets, cashBalances, liveFx, phaseCoins]);

  // Snapshot net worth periodically to build the dashboard trend line.
  useEffect(() => {
    setNetWorthHistory((prev) => {
      const next = [...prev, { t: Date.now(), valueUsd: netWorthUsd }];
      return next.slice(-30);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.round(netWorthUsd * 100)]);

  const publishAsset = async (form) => {
    const initialPrice = Math.max(0.01, parseFloat(form.startingPrice) || 10);
    const letters = form.name.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 5);
    const generatedTicker = form.tickerOverride || "p" + (letters || "PHASE");
    const totalShares = Math.max(1000, parseInt(form.totalShares) || SOVEREIGN_TOTAL_SHARES);
    const publicShares = Math.round(totalShares * ((form.equityPublic || 0) / 100));
    const retainedShares = totalShares - publicShares;

    // Create a real sovereign chain on the backend. There is no local-only
    // fallback: if the backend is unreachable, issuance fails loudly and
    // nothing is created.
    if (!sovereignWallet) {
      showToast("Issuance failed: wallet not ready. Your asset was NOT created. Please try again.");
      return null;
    }
    let sovereignChainId;
    try {
      showToast("Creating your sovereign chain...");
      const res = await createSovereignChain({
        coinName: form.name,
        ticker: generatedTicker,
        totalSupply: String(totalShares),
        decimals: 6,
        issuerAddress: sovereignWallet.address,
        allowMint: true,
      });
      if (res.status === 201 && res.json.chain_id) {
        sovereignChainId = res.json.chain_id;
      } else {
        throw new Error((res.json && res.json.message) || "Sovereign chain creation failed.");
      }
    } catch (e) {
      console.error("sovereign chain creation failed", e);
      showToast("Issuance failed: could not reach the server. Your asset was NOT created. Please try again.");
      return null;
    }
    const newAsset = {
      id: uid(),
      name: form.name,
      ticker: generatedTicker,
      category: form.category,
      subsection: form.subsection,
      network: form.bringYourOwnNetwork || "phaseNative", // self-published listings settle on Phase's own native rail unless brought from elsewhere
      tagline: form.tagline,
      platform: form.platform,
      followers: form.followers,
      engagement: form.engagement,
      socialUrl: form.socialUrl,
      socialProfiles: form.socialProfiles || [], // every linked social account; each renders clickable on the listing
      websiteUrl: form.websiteUrl || null, // business/asset website; renders as a button on the listing
      verification: form.verification, // { status: 'verified'|'unverified', lookupFollowers, lookupEngagement }
      compliance: form.compliance, // { docFileName, licenseNumber, consented }
      equityPublic: form.equityPublic,
      equityRetained: 100 - form.equityPublic,
      price: initialPrice,
      prevPrice: initialPrice,
      history: [], // no fabricated price history — fills in from real market data
      tickDir: "up",
      tickDirection: "FLAT",
      isOwner: true,
      authorityScore: Math.min(
        99,
        Math.round((parseFloat(form.followers || "0") / 2000) + parseFloat(form.engagement || "0") * 3 + 20)
      ),
      learnMoreUrl: null, // no external reference page for user-published listings

      // --- Sovereign Ledger fields: each "Go Live" provisions an isolated,
      // dedicated chain rather than minting onto a shared network. This
      // sandboxes each person/asset's trading activity so no chain's
      // volatility or liquidity can drag on any other chain's price.
      chainId: sovereignChainId,
      sovereignLive: true, // a real backend chain was provisioned (issuance fails loudly otherwise)
      zeroBaseFee: true,
      totalMinted: totalShares,
      publicFloatShares: publicShares,
      retainedShares,
      chainHistory: [genesisBlock(form.name, generatedTicker)],
      phaseCoinPool: 0,
    };
    setAssets((prev) => [newAsset, ...prev]);
    showToast(`${form.name} is live on its sovereign chain`);
    setHasIssuedCoin(true);
    setActiveTab("market");
    return newAsset;
  };

  const invest = async (asset, amountUsd, payCurrencyId) => {
    if (amountUsd <= 0) return;

    // Sovereign coins settle for real on the backend: buyer USD -> issuer USD
    // plus public float -> buyer on the coin's own chain. This is what pays
    // the issuer when someone buys their coin.
    const isSovereign = asset.chainId && String(asset.chainId).startsWith("ch_");
    if (isSovereign) {
      // Register directory coins in the asset registry so Dashboard
      // holdings enrichment can find them after the trade.
      setAssets((prev) => (prev.some((a) => a.id === asset.id) ? prev : [...prev, asset]));
      if (!sovereignWallet?.address) {
        showToast("Your Phase wallet isn't ready yet — try again in a moment");
        return;
      }
      try {
        const res = await tradeApi.buy(asset.chainId, {
          amountUsd,
          buyerAddress: sovereignWallet.address,
        });
        // The Phase fee is denominated in the purchased asset: the buyer
        // receives NET units (gross - fee). Paid USD is the full gross.
        const netUnits = res.fee?.buyerReceivesUnits != null
          ? Number(res.fee.buyerReceivesUnits)
          : Number(res.trade.units) || 0;
        const paidUsd = Number(res.trade.amountUsd) || 0;
        const feeUnits = res.fee ? Number(res.fee.feeUnits) || 0 : 0;
        const feeTicker = res.fee?.assetSymbol ?? asset.ticker;
        setHoldings((prev) => {
          const existing = prev.find((h) => h.assetId === asset.id);
          if (existing) {
            return prev.map((h) =>
              h.assetId === asset.id
                ? { ...h, units: h.units + netUnits, costBasisUsd: h.costBasisUsd + paidUsd }
                : h
            );
          }
          return [...prev, { assetId: asset.id, units: netUnits, costBasisUsd: paidUsd }];
        });
        setTxHistory((prev) => [
          {
            id: uid(),
            assetName: asset.name,
            amountUsd: paidUsd,
            currency: "usd",
            time: new Date(),
            type: "invest",
            txId: res.trade.txId,
            kind: "buy",
            feeBps: res.fee?.feeBps ?? null,
            feeAmount: res.fee?.feeUnits ?? null,
            feeAssetSymbol: feeTicker,
            netAmount: res.fee?.buyerReceivesUnits ?? null,
          },
          ...prev,
        ]);
        await refreshTradeBalances();
        showToast(
          `Bought ${netUnits} ${asset.ticker} — $${paidUsd.toFixed(2)}${
            feeUnits > 0 ? ` (incl. ${feeUnits} ${feeTicker} Phase fee)` : ""
          }`
        );
      } catch (e) {
        if (e.code === "insufficient_funds" || e.status === 402) {
          showToast("Not enough trade USD — fund your account and try again");
        } else {
          showToast(e.message || "Trade failed — please try again");
        }
      }
      return;
    }

    const units = amountUsd / asset.price;

    if (payCurrencyId === "phase") {
      const phaseRate = liveFx.phase != null ? liveFx.phase : BASE_FX.phase;
      const amountInPhase = amountUsd * phaseRate;
      if (amountInPhase > phaseCoins) {
        showToast("Not enough PHASE Coins for that amount");
        return;
      }
      setPhaseCoins((c) => c - amountInPhase);
    } else {
      const rate = liveFx[payCurrencyId] != null ? liveFx[payCurrencyId] : BASE_FX[payCurrencyId] || 1;
      const amountInPayCurrency = amountUsd * rate;
      const available = cashBalances[payCurrencyId] || 0;
      if (amountInPayCurrency > available) {
        showToast(`Not enough ${payCurrencyId.toUpperCase()} in your cash account. Try funding your account first.`);
        return;
      }
      setCashBalances((prev) => ({
        ...prev,
        [payCurrencyId]: (prev[payCurrencyId] || 0) - amountInPayCurrency,
      }));
    }

    setHoldings((prev) => {
      const existing = prev.find((h) => h.assetId === asset.id);
      if (existing) {
        return prev.map((h) =>
          h.assetId === asset.id
            ? { ...h, units: h.units + units, costBasisUsd: h.costBasisUsd + amountUsd }
            : h
        );
      }
      return [...prev, { assetId: asset.id, units, costBasisUsd: amountUsd }];
    });

    setTxHistory((prev) => [
      {
        id: uid(),
        assetName: asset.name,
        amountUsd,
        currency: payCurrencyId,
        time: new Date(),
        type: "invest",
      },
      ...prev,
    ]);

    showToast(
      `Invested ${formatCurrency(amountUsd, payCurrencyId, liveFx)} in ${asset.name}`
    );
  };

  // Coin-for-coin swap: offer units of your own issued coin in exchange for
  // another issuer's coin. Settles on both sovereign chains via the backend.
  const investSwap = async (asset, offerCoin, offerUnits) => {
    if (offerUnits < 1) return;
    setAssets((prev) => {
      let next = prev;
      for (const a of [asset, offerCoin]) {
        if (a && !next.some((x) => x.id === a.id)) next = [...next, a];
      }
      return next;
    });
    if (!sovereignWallet?.address) {
      showToast("Your Phase wallet isn't ready yet — try again in a moment");
      return;
    }
    try {
      const res = await marketApi.swap(asset.chainId, {
        offerChainId: offerCoin.chainId,
        offerUnits,
        buyerAddress: sovereignWallet.address,
      });
      const t = res.trade || {};
      // The buyer receives NET units (gross minus the Phase fee). Fall back
      // to the gross trade units for older backends without fee data.
      const gotUnits = Number(res.fee?.buyerReceivesUnits) || Number(t.units) || 0;
      const paidUnits = Number(t.offerUnits) || offerUnits;
      const valueUsd = Number(t.amountUsd) || 0;
      const feeUnits = res.fee ? Number(res.fee.feeUnits) || 0 : 0;
      const feeTicker = res.fee?.assetSymbol || asset.ticker;
      setHoldings((prev) => {
        const bump = (list, assetId, deltaUnits, usd) => {
          const existing = list.find((h) => h.assetId === assetId);
          if (existing) {
            return list.map((h) =>
              h.assetId === assetId
                ? { ...h, units: Math.max(0, h.units + deltaUnits), costBasisUsd: h.costBasisUsd + usd }
                : h
            );
          }
          if (deltaUnits <= 0) return list;
          return [...list, { assetId, units: deltaUnits, costBasisUsd: usd }];
        };
        let next = bump(prev, asset.id, gotUnits, valueUsd);
        next = bump(next, offerCoin.assetId, -paidUnits, 0);
        return next;
      });
      setTxHistory((prev) => [
        {
          id: uid(),
          assetName: `${asset.ticker} ⇄ ${offerCoin.ticker}`,
          amountUsd: valueUsd,
          currency: "usd",
          time: new Date(),
          type: "swap",
          txId: res.targetTxId || t.txId,
          kind: "swap",
          feeBps: res.fee?.feeBps ?? null,
          feeAmount: res.fee?.feeUnits ?? null,
          feeTicker,
          netAmount: res.fee?.buyerReceivesUnits ?? null,
        },
        ...prev,
      ]);
      showToast(
        `Swapped ${paidUnits} ${offerCoin.ticker} → ${gotUnits} ${asset.ticker}${
          feeUnits > 0 ? ` (${feeUnits} ${feeTicker} Phase fee)` : ""
        }`
      );
    } catch (e) {
      showToast(e.message || "Swap failed — please try again");
    }
  };

  const fundAccount = (currencyId, amountInCurrency, method) => {
    if (amountInCurrency <= 0) return;
    setCryptoFunded(true); // real deposit confirmed — unlock the dashboard
    setCashBalances((prev) => ({
      ...prev,
      [currencyId]: (prev[currencyId] || 0) + amountInCurrency,
    }));
    setTxHistory((prev) => [
      {
        id: uid(),
        assetName: `Funded via ${method}`,
        amountUsd: amountInCurrency / (liveFx[currencyId] != null ? liveFx[currencyId] : BASE_FX[currencyId] || 1),
        currency: currencyId,
        time: new Date(),
        type: "fund",
      },
      ...prev,
    ]);
    showToast(`Added ${formatCurrency(
      amountInCurrency / (liveFx[currencyId] != null ? liveFx[currencyId] : BASE_FX[currencyId] || 1),
      currencyId,
      liveFx
    )} to your account via ${method}`);
  };

  return (
    <div className={`app-root${isAndroid ? " platform-android" : ""}`}>
      <GlobalStyles />
      <BackgroundGrid />

      {showSplash && <SplashScreen />}

      <TopNav
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        authUser={authUser}
        onOpenAccount={() => { setAuthNotice(null); setAccountModal("account"); }}
        onLogout={async () => {
          await authApi.logout();
          setAuthUser(null);
          setActiveTab("golive");
        }}
      />

      <main className="app-main">
        {activeTab === "golive" && !authUser && authReady && (
          <AuthScreen
            notice={authNotice}
            onOpenPrivacy={() => setAccountModal("privacy")}
            onAuthSuccess={(u) => {
              setAuthNotice(null);
              setAuthUser(u);
              refreshTradeBalances();
              refreshFundingStatus();
              refreshMyCoins();
            }}
          />
        )}
        {activeTab === "golive" && authUser && (
          <div className={GO_LIVE_LOCKED ? "feature-gated" : undefined}>
            {GO_LIVE_LOCKED && (
              <div className="feature-lock-overlay">
                <div className="glass-card feature-lock-card">
                  <div className="feature-lock-mark">
                    <Icon name="lock" size={30} />
                  </div>
                  <h3 className="feature-lock-title">Coin issuance opening soon</h3>
                  <p className="feature-lock-sub">
                    Coin issuance will be available here soon. Check back soon.
                  </p>
                </div>
              </div>
            )}
            <div
              className={GO_LIVE_LOCKED ? "feature-locked-blur" : undefined}
              inert={GO_LIVE_LOCKED ? true : undefined}
              aria-hidden={GO_LIVE_LOCKED ? true : undefined}
            >
              <GoLiveTab onPublish={publishAsset} issuerAddress={sovereignWallet?.address} />
            </div>
          </div>
        )}
        {activeTab === "market" && authUser && (
          <MarketplaceTab
            assets={assets}
            currency={currency}
            setCurrency={setCurrency}
            onInvest={invest}
            onInvestSwap={investSwap}
            sovereignAddress={sovereignWallet?.address}
            phaseCoins={phaseCoins}
            cashBalances={cashBalances}
            liveFx={liveFx}
            tradeCashUsd={tradeCashUsd}
            onTopup={async (amt) => {
              await tradeApi.topup(amt);
              await refreshTradeBalances();
            }}
          />
        )}
        {activeTab === "dashboard" && authUser && (
          !dashboardUnlocked ? (
            <div className="dashboard-wrap">
              <div className="glass-card empty-state">
                <Icon name="wallet" size={30} />
                <h3>Fund your account to see your dashboard</h3>
                <p>Your portfolio, net worth, and activity will appear here once your account is funded.</p>
              </div>
            </div>
          ) : (
            <DashboardTab
              assets={assets}
              holdings={holdings}
              currency={currency}
              setCurrency={setCurrency}
              phaseCoins={phaseCoins}
              cashBalances={cashBalances}
              tradeCashUsd={tradeCashUsd}
              coinSalesUsd={coinSalesUsd}
              onFund={fundAccount}
              txHistory={txHistory}
              onExplore={() => setActiveTab("market")}
              liveFx={liveFx}
              netWorthHistory={netWorthHistory}
              netWorthUsd={netWorthUsd}
              isAdmin={isAdmin}
              onOpenAdmin={() => setShowAdmin(true)}
            />
          )
        )}
      </main>

      <BottomUtilityBar onOpenNews={() => setShowNews(true)} />

      {showNews && <NewsDrawer onClose={() => setShowNews(false)} />}

      {showAdmin && isAdmin && (
        <AdminDashboardModal onClose={() => setShowAdmin(false)} showToast={showToast} />
      )}

      {accountModal === "account" && (
        <AccountModal
          authUser={authUser}
          onClose={() => setAccountModal(null)}
          onOpenPrivacy={() => setAccountModal("privacy")}
          onOpenDelete={() => setAccountModal("delete")}
        />
      )}
      {accountModal === "privacy" && (
        <PrivacyPolicyModal onClose={() => setAccountModal(authUser ? "account" : null)} />
      )}
      {accountModal === "delete" && (
        <DeleteAccountModal
          onClose={() => setAccountModal("account")}
          onDeleted={() => {
            // Full local wipe: session, remembered login, and all cached data.
            try { localStorage.clear(); } catch {}
            try { window.dispatchEvent(new CustomEvent("phase:auth-changed")); } catch {}
            setAuthUser(null);
            setAccountModal(null);
            setActiveTab("golive");
            setAuthNotice("Your account has been permanently deleted.");
          }}
        />
      )}



      <ChatbotLauncher
        open={chatOpen}
        setOpen={setChatOpen}
        onNavigate={(tab) => setActiveTab(tab)}
      />

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ------------------------------ Background -------------------------------- */

function BackgroundGrid() {
  return (
    <div className="bg-grid" aria-hidden="true">
      <div className="bg-grid-inner" />
      <div className="bg-glow bg-glow-1" />
      <div className="bg-glow bg-glow-2" />
    </div>
  );
}

/* -------------------------------- Top Nav ---------------------------------- */

/* ------------------------------ Splash ------------------------------------- */

function SplashScreen() {
  return (
    <div className="splash-overlay" aria-hidden="true">
      <div className="splash-mark">
        <PhiMark size={84} animated />
        <div className="splash-word">Phase</div>
      </div>
    </div>
  );
}

function TopNav({ activeTab, setActiveTab, authUser, onLogout, onOpenAccount }) {
  const tabs = [
    { id: "golive", label: "Go Live", icon: "directory" },
    { id: "dashboard", label: "Dashboard", icon: "dashboard" },
    { id: "market", label: "Marketplace", icon: "directory" },
  ];
  const handleTab = (id) => {
    if ((id === "dashboard" || id === "market") && !authUser) {
      setActiveTab("golive");
      return;
    }
    setActiveTab(id);
  };
  return (
    <header className="top-nav">
      <div className="top-nav-left">
        <PhiMark size={34} title="Phase" />
        <span className="brand-word">Phase</span>
      </div>
      <nav className="top-nav-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`nav-tab ${activeTab === t.id ? "nav-tab-active" : ""}`}
            onClick={() => handleTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="top-nav-right">
        {authUser ? (
          <>
            <button className="icon-btn nav-account" onClick={onOpenAccount} title="Account settings">
              <Icon name="person" size={20} />
            </button>
            <button className="link-btn nav-logout" onClick={onLogout} title={authUser.email}>
              Log out
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}

/* ------------------------------ Bottom bar --------------------------------- */

function BottomUtilityBar({ onOpenNews }) {
  return (
    <button className="bottom-bar" onClick={onOpenNews}>
      <Icon name="news" size={16} />
      <span>News, Education &amp; Network Info</span>
      <Icon name="arrowRight" size={14} />
    </button>
  );
}

function NewsDrawer({ onClose }) {
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <span className="drawer-title">News &amp; Learn</span>
          <button className="icon-btn" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="drawer-body">
          {NEWS_ITEMS.map((n, i) => (
            <div className="news-card" key={i}>
              <span className={`news-tag news-tag-${n.tag.toLowerCase()}`}>{n.tag}</span>
              <h4>{n.title}</h4>
              <p>{n.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GoLiveTab({ onPublish, issuerAddress }) {
  const [flowStep, setFlowStep] = useState("entry"); // entry | describe | bringYourOwn | form | issuance
  const [selectedPath, setSelectedPath] = useState(null); // 'capital' | 'business' | 'asset'
  const [selectedExample, setSelectedExample] = useState(null); // example object from GOLIVE_PATHS, or null for "describe my own"
  const [usingOwnThesis, setUsingOwnThesis] = useState(false);

  const [category, setCategory] = useState("socialMedia");
  const [subsection, setSubsection] = useState(ASSET_CATEGORIES.socialMedia.subsections[0]);
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [tagline, setTagline] = useState("");
  const [platform, setPlatform] = useState("YouTube");
  const [followers, setFollowers] = useState("");
  const [engagement, setEngagement] = useState("");
  const [socialUrl, setSocialUrl] = useState("");
  const [verifyState, setVerifyState] = useState("idle"); // idle | checking | verified | mismatch
  const [lookupResult, setLookupResult] = useState(null);
  const [socialProfiles, setSocialProfiles] = useState([]); // linked social accounts: [{ platform, url, followers, engagement, verified }]
  const [websiteUrl, setWebsiteUrl] = useState(""); // business/asset website, shown on marketplace listing
  const [showOptionalSocial, setShowOptionalSocial] = useState(false); // non-social categories can optionally link socials
  const [showTerms, setShowTerms] = useState(false);
  const [consented, setConsented] = useState(false);
  // Business attestation: when a business chain is provisioned without uploaded
  // registration documents, the issuer must sign this attestation instead.
  const [businessDocName, setBusinessDocName] = useState(null);
  const [businessAttested, setBusinessAttested] = useState(false);
  const [businessLegalName, setBusinessLegalName] = useState("");
  const [equityPublic, setEquityPublic] = useState(20);
  const [startingPrice, setStartingPrice] = useState(10);
  const [totalShares, setTotalShares] = useState(100000);
  const [published, setPublished] = useState(null);

  const equityRetained = 100 - equityPublic;
  const compliance = COMPLIANCE_META[ASSET_CATEGORIES[category].complianceClass];
  const publicShares = Math.round(totalShares * (equityPublic / 100));
  const retainedShares = totalShares - publicShares;

  const choosePath = (pathKey) => {
    setSelectedPath(pathKey);
    setFlowStep("describe");
  };

  const chooseExample = (example) => {
    setSelectedExample(example);
    setUsingOwnThesis(false);
    setCategory(example.category);
    setSubsection(example.subsection);
    setFlowStep("form");
  };

  const chooseOwnThesis = () => {
    setSelectedExample(null);
    setUsingOwnThesis(true);
    // Keep a sensible default category for the chosen path so compliance
    // and social-proof behavior still make sense; the person can still
    // adjust category/subsection on the form itself.
    if (selectedPath === "capital") {
      setCategory("socialMedia");
      setSubsection(ASSET_CATEGORIES.socialMedia.subsections[0]);
    } else if (selectedPath === "business") {
      setCategory("smallBusiness");
      setSubsection(ASSET_CATEGORIES.smallBusiness.subsections[0]);
    } else {
      setCategory("realEstate");
      setSubsection(ASSET_CATEGORIES.realEstate.subsections[0]);
    }
    setFlowStep("form");
  };

  const canVerify = socialUrl.trim().length > 4;
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);


  // Lock the current platform + URL into the linked-profiles list so an
  // issuer can attach several social accounts; each renders as a clickable
  // link on their live listing.
  const normalizeUrl = (u) => {
    const t = (u || "").trim();
    if (!t) return t;
    return /^https?:\/\//i.test(t) ? t : `https://${t}`;
  };
  const addSocialProfile = () => {
    const url = normalizeUrl(socialUrl);
    if (url.length < 5) return;
    if (socialProfiles.some((p) => p.platform === platform && p.url === url)) return;
    setSocialProfiles((prev) => [
      ...prev,
      {
        platform,
        url,
        followers: followers.trim(),
        engagement: engagement.trim(),
        verified: false, // no verification yet -- links render as plain unverified links
      },
    ]);
    setSocialUrl("");
    setFollowers("");
    setEngagement("");
    setVerifyState("idle");
    setLookupResult(null);
  };
  const removeSocialProfile = (idx) =>
    setSocialProfiles((prev) => prev.filter((_, i) => i !== idx));

  // Documentation is optional in the sovereign-chain model — provisioning a
  // chain doesn't require pre-existing paperwork. If someone chose "generate
  // a charter," we still ask for a name + signature so the charter reads
  // correctly, but it's not a hard gate.
  const hasDocumentation = true; // real agreement handled in the issuance flow

  // Business chains without uploaded documents must sign the attestation.
  const isBusinessClass = compliance && compliance.docLabel && compliance.docLabel.toLowerCase().includes("business");
  const needsBusinessAttestation = isBusinessClass && !businessDocName;
  const businessAttestationDone = !needsBusinessAttestation || (businessAttested && businessLegalName.trim().length >= 2);

  const canPublish =
    name.trim().length > 1 &&
    ticker.trim().length >= 2 &&
    tagline.trim().length > 3 &&
    consented &&
    hasDocumentation &&
    businessAttestationDone &&
    startingPrice > 0 &&
    totalShares >= 1000;



  if (flowStep === "entry") {
    return (
      <GoLivePathPicker
        choosePath={choosePath}
        onBringYourOwn={() => setFlowStep("bringYourOwn")}
      />
    );
  }

  if (flowStep === "describe") {
    return (
      <GoLiveDescribeStep
        pathKey={selectedPath}
        chooseExample={chooseExample}
        chooseOwnThesis={chooseOwnThesis}
        onBack={() => setFlowStep("entry")}
      />
    );
  }

  if (flowStep === "bringYourOwn") {
    return (
      <BringYourOwnNetworkFlow
        onBack={() => setFlowStep("entry")}
        onPublish={onPublish}
      />
    );
  }

  if (flowStep === "issuance") {
    return (
      <IssuanceFlow
        coin={{
          name: name.trim(),
          ticker: ticker.trim(),
          tagline: tagline.trim(),
          category,
          equityPublic,
          equityRetained,
          totalShares,
          startingPrice,
          socialProfiles,
          websiteUrl: normalizeUrl(websiteUrl) || null,
        }}
        issuerAddress={issuerAddress}
        onBack={() => setFlowStep("form")}
        onComplete={async (mintedCoin, isMeme) => {
          // Hand the real minted coin to the parent for dashboard unlock.
          setHasIssuedCoin(true);
          const asset = await onPublish({
            name: mintedCoin.name,
            category,
            subsection,
            tagline: tagline.trim(),
            socialProfiles,
            websiteUrl: normalizeUrl(websiteUrl) || null,
            verification: { status: "unverified", lookupFollowers: null, lookupEngagement: null },
            compliance: {
              docFileName: isMeme ? null : "Issuer Agreement (digitally signed)",
              generatedAgreement: null,
              signature: null,
              issuanceCoinId: mintedCoin.id,
              mintAddress: mintedCoin.mintAddress,
              txSignature: mintedCoin.txSignature,
              isMeme,
              consented,
            },
            equityPublic,
            startingPrice,
            totalShares,
            publicShares,
            retainedShares,
            mintAddress: mintedCoin.mintAddress,
            txSignature: mintedCoin.txSignature,
          });
          setPublished(asset);
        }}
      />
    );
  }

  return (
    <div className="golive-grid">
      <section className="glass-card golive-form">
        <button className="link-btn back-link" onClick={() => setFlowStep("describe")}>
          ← Back
        </button>
        <h2 className="section-title">Issue Your Sovereign Chain</h2>
        <p className="section-sub">
          Describe your value, verify your reach, attach your documentation, set your split.
        </p>

        {usingOwnThesis && (
          <div className="own-thesis-banner">
            <Icon name="check" size={14} />
            Describing your own value thesis under {GOLIVE_PATHS[selectedPath].label}. Adjust the category below if needed.
          </div>
        )}

        <label className="field-label">What are you issuing a chain for?</label>
        <div className="category-toggle category-toggle-wide">
          {Object.entries(ASSET_CATEGORIES).map(([key, meta]) => (
            <button
              key={key}
              className={`cat-btn ${category === key ? "cat-btn-active" : ""}`}
              onClick={() => {
                setCategory(key);
                setSubsection(meta.subsections[0]);
              }}
            >
              <Icon name={meta.icon} size={16} />
              {meta.label}
            </button>
          ))}
        </div>

        <label className="field-label">Subsection</label>
        <div className="category-toggle">
          {ASSET_CATEGORIES[category].subsections.map((s) => (
            <button
              key={s}
              className={`pill-btn ${subsection === s ? "pill-btn-active" : ""}`}
              onClick={() => setSubsection(s)}
            >
              {s}
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="asset-name">
          Name
        </label>
        <input
          id="asset-name"
          className="text-input"
          placeholder={
            ASSET_CATEGORIES[category].usesSocialProof
              ? "e.g. Your name, stage name, or channel"
              : category === "realEstate" || category === "collectibles"
              ? "e.g. Downtown Duplex / 2024 Porsche 911"
              : "e.g. Your business, fund, or chain name"
          }
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label" htmlFor="asset-ticker">
          Ticker symbol
        </label>
        <input
          id="asset-ticker"
          className="text-input"
          placeholder="e.g. MYC"
          maxLength={10}
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          style={{ maxWidth: 160, textTransform: "uppercase" }}
        />
        <p className="field-hint">2–10 characters, letters and numbers only. This is your coin's on-chain symbol.</p>

        <label className="field-label" htmlFor="asset-tagline">
          {usingOwnThesis ? "Describe your value thesis" : "How do you add value to society?"}
        </label>
        <textarea
          id="asset-tagline"
          className="text-input textarea"
          placeholder="Describe your skill, your business, your audience, or your asset's real-world utility..."
          value={tagline}
          onChange={(e) => setTagline(e.target.value)}
          rows={3}
        />

        {ASSET_CATEGORIES[category].usesSocialProof && (
          <>
            <label className="field-label">Social proof sync</label>
            <div className="social-sync-row">
              <div className="platform-pills">
                {PLATFORMS.map((p) => (
                  <button
                    key={p}
                    className={`pill-btn ${platform === p ? "pill-btn-active" : ""}`}
                    onClick={() => {
                      setPlatform(p);
                      setVerifyState("idle");
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <div className="social-inputs">
                <input
                  className="text-input small-input"
                  type="number"
                  placeholder="Followers"
                  value={followers}
                  onChange={(e) => {
                    setFollowers(e.target.value);
                    setVerifyState("idle");
                  }}
                />
                <input
                  className="text-input small-input"
                  type="number"
                  placeholder="Engagement %"
                  value={engagement}
                  onChange={(e) => setEngagement(e.target.value)}
                />
              </div>
            </div>

            <label className="field-label" htmlFor="social-url">
              Link your {platform} profile
            </label>
            <div className="verify-row">
              <input
                id="social-url"
                className="text-input"
                placeholder={`https://${platform.toLowerCase()}.com/yourprofile`}
                value={socialUrl}
                onChange={(e) => {
                  setSocialUrl(e.target.value);
                }}
              />
            </div>
            <p className="field-hint">
              Links are shown as plain, unverified links — Phase does not verify social accounts yet.
            </p>

            {socialProfiles.length > 0 && (
              <div className="social-profiles-list">
                {socialProfiles.map((p, i) => (
                  <div key={`${p.platform}-${i}`} className="social-profile-row">
                    <span className="social-profile-platform">{p.platform}</span>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="social-profile-url"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {p.url.replace(/^https?:\/\//, "").slice(0, 34)}
                    </a>
                    <button className="icon-btn" onClick={() => removeSocialProfile(i)} title="Remove profile">
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              className={`btn-secondary social-add-btn ${socialUrl.trim().length < 5 ? "btn-disabled" : ""}`}
              onClick={addSocialProfile}
              disabled={socialUrl.trim().length < 5}
            >
              + Add {platform} profile{socialProfiles.length > 0 ? " (another)" : ""}
            </button>
          </>
        )}

        {/* Optional social linking for non-social categories — by choice, not required */}
        {!ASSET_CATEGORIES[category].usesSocialProof && (
          <div className="optional-social-block">
            <button
              className="link-btn optional-social-toggle"
              onClick={() => setShowOptionalSocial(!showOptionalSocial)}
            >
              {showOptionalSocial ? "−" : "+"} Optionally link social profiles
            </button>
            {showOptionalSocial && (
              <>
                <label className="field-label">Social proof sync (optional)</label>
                <div className="social-sync-row">
                  <div className="platform-pills">
                    {PLATFORMS.map((p) => (
                      <button
                        key={p}
                        className={`pill-btn ${platform === p ? "pill-btn-active" : ""}`}
                        onClick={() => {
                          setPlatform(p);
                          setVerifyState("idle");
                        }}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="field-label" htmlFor="social-url-optional">
                  Link your {platform} profile (optional)
                </label>
                <div className="verify-row">
                  <input
                    id="social-url-optional"
                    className="text-input"
                    placeholder={`https://${platform.toLowerCase()}.com/yourprofile`}
                    value={socialUrl}
                    onChange={(e) => {
                      setSocialUrl(e.target.value);
                    }}
                  />
                </div>
                {socialProfiles.length > 0 && (
                  <div className="social-profiles-list">
                    {socialProfiles.map((p, i) => (
                      <div key={`${p.platform}-${i}`} className="social-profile-row">
                        <span className="social-profile-platform">{p.platform}</span>
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="social-profile-url"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.url.replace(/^https?:\/\//, "").slice(0, 34)}
                        </a>
                        <button className="icon-btn" onClick={() => removeSocialProfile(i)} title="Remove profile">
                          <Icon name="close" size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  className={`btn-secondary social-add-btn ${socialUrl.trim().length < 5 ? "btn-disabled" : ""}`}
                  onClick={addSocialProfile}
                  disabled={socialUrl.trim().length < 5}
                >
                  + Add {platform} profile{socialProfiles.length > 0 ? " (another)" : ""}
                </button>
              </>
            )}
          </div>
        )}

        {/* Website URL for business and asset listings — shows on marketplace */}
        {["business", "hardAsset", "financial"].includes(ASSET_CATEGORIES[category].complianceClass) && (
          <>
            <label className="field-label" htmlFor="website-url">
              Website (optional)
            </label>
            <input
              id="website-url"
              className="text-input"
              placeholder="https://yourbusiness.com"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
            />
            <p className="field-hint">
              Your website shows as a button on your marketplace listing so buyers can learn more.
            </p>
          </>
        )}

          <div className="consent-row">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
              />
              <span>
                I agree to the{" "}
                <button className="link-btn" onClick={() => setShowTerms(true)}>
                  Onchaining Terms &amp; Consent
                </button>
                , including that this chain is an isolated ledger and any future value is reflected
                proportionally per my Sovereign Split.
              </span>
            </label>
          </div>

          {isBusinessClass && (
            <div className="business-doc-block">
              <label className="field-label">{compliance.docLabel} (optional)</label>
              <div className="file-upload-row">
                <label className="file-upload-btn">
                  <input
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files && e.target.files[0];
                      setBusinessDocName(f ? f.name : null);
                      // A fresh upload resets the attestation
                      if (f) { setBusinessAttested(false); }
                    }}
                  />
                  {businessDocName ? "Replace document" : "Upload document"}
                </label>
                {businessDocName && (
                  <span className="file-upload-name">
                    <Icon name="check" size={13} /> {businessDocName}
                    <button className="icon-btn" onClick={() => setBusinessDocName(null)} title="Remove">
                      <Icon name="close" size={12} />
                    </button>
                  </span>
                )}
              </div>
              <p className="field-hint">{compliance.docHint}</p>
            </div>
          )}

          {needsBusinessAttestation && (
            <div className="business-attestation">
              <h3 className="section-title" style={{ fontSize: 17 }}>Business Attestation</h3>
              <p className="section-sub">
                No registration documents uploaded. Sign this attestation instead — it binds
                you to the accuracy of your business representations.
              </p>
              <div className="agreement-doc">
                <pre className="agreement-text">{BUSINESS_ATTESTATION_TEXT(name.trim() || "[Business name]", ticker.trim() || "[TICKER]")}</pre>
              </div>
              <label className="field-label" htmlFor="business-legal-name">
                Your full legal name
              </label>
              <input
                id="business-legal-name"
                className="text-input signature-input"
                placeholder="Type your full legal name to sign"
                value={businessLegalName}
                onChange={(e) => setBusinessLegalName(e.target.value)}
              />
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={businessAttested}
                  onChange={(e) => setBusinessAttested(e.target.checked)}
                />
                <span>
                  I, {businessLegalName || "[your name]"}, attest that the business information
                  provided is accurate and agree to be bound by this attestation.
                </span>
              </label>
            </div>
          )}

        <label className="field-label" htmlFor="starting-price">
          Starting Share Price
        </label>
        <div className="price-input-row">
          <span className="price-input-prefix">$</span>
          <input
            id="starting-price"
            className="text-input price-input"
            type="number"
            min="0.01"
            step="0.01"
            placeholder="10.00"
            value={startingPrice}
            onChange={(e) => setStartingPrice(parseFloat(e.target.value) || 0)}
          />
        </div>
        <p className="field-hint">
          This is your chain's opening valuation anchor. You set where it starts.
        </p>

        <label className="field-label">Fractionalization &amp; Sovereign Split</label>
        <label className="field-label" htmlFor="total-shares" style={{ marginTop: 4 }}>
          Total shares to issue
        </label>
        <input
          id="total-shares"
          className="text-input"
          type="number"
          min="1000"
          step="1000"
          placeholder="100,000"
          value={totalShares}
          onChange={(e) => setTotalShares(Math.max(1000, parseInt(e.target.value, 10) || 1000))}
        />
        <p className="field-hint">
          {totalShares.toLocaleString()} fractional shares mint at genesis. Set how many go to
          the public float vs. what you retain — it's entirely up to you.
        </p>
        <EquitySplitSlider
          equityPublic={equityPublic}
          setEquityPublic={setEquityPublic}
        />
        <div className="share-split-readout">
          <div>
            <span className="stat-label">Public Float</span>
            <span className="stat-value">{publicShares.toLocaleString()} shares</span>
          </div>
          <div>
            <span className="stat-label">Retained by You</span>
            <span className="stat-value">{retainedShares.toLocaleString()} shares</span>
          </div>
        </div>

        <div className="retained-value-readout">
          <span className="retained-value-label">Your retained stake is worth</span>
          <span className="retained-value-amount">
            ${(retainedShares * (startingPrice || 0)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
          <span className="retained-value-hint">at today's starting price</span>
        </div>

        <button
          className={`btn-primary btn-large btn-pulse ${!canPublish ? "btn-disabled" : ""}`}
          onClick={() => setFlowStep("issuance")}
          disabled={!canPublish}
        >
          Continue to Issuance →
        </button>
        {!canPublish && (
          <p className="field-hint">
            Add a name, ticker, value description, starting price, agree to the terms
            {needsBusinessAttestation && ", and sign the business attestation"} to continue.
          </p>
        )}

        {published && (
          <div className="publish-success">
            <Icon name="check" size={16} />
            <span>
              {published.name} is live on chain {published.chainId}. Check the Marketplace tab.
            </span>
          </div>
        )}
      </section>

      <section className="glass-card golive-preview">
        <span className="preview-label">Live preview — your sovereign chain</span>
        <div className="preview-card chain-preview-card">
          <div className="chain-preview-header">
            <span className="chain-id-badge">
              <Icon name="directory" size={12} /> Chain ID pending
            </span>
            <span className="chain-preview-note">zero base fee · isolated ledger</span>
          </div>

          <div className="preview-card-top">
            <div className="preview-avatar">
              <Icon name={ASSET_CATEGORIES[category].icon} size={20} />
            </div>
            <div>
              <h3>{name || "Your name here"}</h3>
              <span className="preview-category">
                {ASSET_CATEGORIES[category].label} · {subsection}
              </span>
            </div>
          </div>
          <p className="preview-tagline">
            {tagline || "Your value-addition description will appear here."}
          </p>


          {ASSET_CATEGORIES[category].usesSocialProof && (
            <div className="preview-stats">
              <div>
                <span className="stat-label">{platform}</span>
                <span className="stat-value">{followers || "0"} followers</span>
              </div>
              <div>
                <span className="stat-label">Engagement</span>
                <span className="stat-value">{engagement || "0"}%</span>
              </div>
            </div>
          )}
          <div className="preview-split">
            <div className="split-bar">
              <div className="split-bar-public" style={{ width: `${equityPublic}%` }} />
            </div>
            <div className="split-labels">
              <span>{equityPublic}% public · {publicShares.toLocaleString()} shares</span>
              <span>{equityRetained}% retained · {retainedShares.toLocaleString()} shares</span>
            </div>
          </div>
          <div className="preview-price">
            <span className="stat-label">Starting share price</span>
            <span className="preview-price-value">${(startingPrice || 0).toFixed(2)}</span>
          </div>
          <div className="preview-chain-stats">
            <div>
              <span className="stat-label">Total Shares Minted</span>
              <span className="stat-value">{SOVEREIGN_TOTAL_SHARES.toLocaleString()}</span>
            </div>
            <div>
              <span className="stat-label">Base Fee</span>
              <span className="stat-value">$0.00</span>
            </div>
          </div>
        </div>
      </section>

      {showTerms && <TermsModal onClose={() => setShowTerms(false)} />}
    </div>
  );
}

// The staged reveal a person watches while their sovereign chain
// provisions — steps light up in sequence, ending with the chain ID
// animating in large. This is the emotional high point of Go Live, so it
// gets its own beat instead of a generic spinner.

/* ------------------------- Real issuance flow ------------------------- */
// Draft → choice (Issuer Agreement vs Meme Coin) → sign → mint on your own
// Phase sovereign chain (in-house — each coin gets its own isolated chain).
// Uses the real Phase backend. The agreement creates a covenant between the
// issuer and purchasers; the meme path explicitly mints with no agreement.
function IssuanceFlow({ coin, issuerAddress, onBack, onComplete }) {
  const [step, setStep] = useState("choice"); // choice | social | meme | minting | done | error
  const [socialProviders, setSocialProviders] = useState([]);
  const [socialConns, setSocialConns] = useState([]);
  const [socialLoading, setSocialLoading] = useState(false);
  const [draftId, setDraftId] = useState(null);
  const [agreementText, setAgreementText] = useState("");
  const [agreementHash, setAgreementHash] = useState("");
  const [legalName, setLegalName] = useState("");
  const [issuerCategory, setIssuerCategory] = useState("individual"); // individual | entity
  const [entityTitle, setEntityTitle] = useState("");
  const [signatureId, setSignatureId] = useState(null);
  const [signedAt, setSignedAt] = useState(null);
  const [accepted, setAccepted] = useState(false);
  const [memeConfirmed, setMemeConfirmed] = useState(false);
  const [mintResult, setMintResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(`app-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const draftStarted = useRef(false);

  // The agreement screen needs a backend draft before anything can be signed.
  // Create it on mount (guarded — the old path left draftId null until a
  // choice button that no longer exists was pressed, causing
  // "Body must include draftId." on sign).
  useEffect(() => {
    if (draftStarted.current) return;
    draftStarted.current = true;
    startDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The sovereign chain needs the issuer's ph1 wallet address. Prefer the
  // prop; fall back to restoring the on-device wallet from localStorage.
  const ensureIssuerAddress = async () => {
    if (issuerAddress) return issuerAddress;
    try {
      const stored = localStorage.getItem("phase_sovereign_wallet");
      if (stored) {
        const { jwk, pubkeyHex } = JSON.parse(stored);
        const w = await restoreWallet(jwk, pubkeyHex);
        if (w && w.address) return w.address;
      }
      const w = await generateWallet();
      localStorage.setItem("phase_sovereign_wallet", JSON.stringify({ jwk: w.jwk, pubkeyHex: w.pubkeyHex }));
      return w.address;
    } catch (e) {
      throw new Error("Could not load your Phase wallet. Please restart the app and try again.");
    }
  };

  const startDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      const draft = await issuanceApi.createDraft({
        userId: currentUserId(),
        name: coin.name,
        ticker: coin.ticker,
        category: coin.category || "Creator",
        tagline: coin.tagline,
        valueThesis: coin.tagline,
        equityPublic: coin.equityPublic,
        equityRetained: coin.equityRetained,
        socialProfiles: coin.socialProfiles || [],
        websiteUrl: coin.websiteUrl || null,
        priceUsd: coin.startingPrice,
      });
      setDraftId(draft.draftId);
      // Fetch the agreement text now so the choice screen (which is now the
      // agreement screen) can display the full legal document immediately.
      try {
        const ag = await issuanceApi.getAgreement(draft.draftId);
        setAgreementText(ag.agreementText);
        setAgreementHash(ag.agreementHash);
      } catch {
        // agreement text load failure surfaces at sign time
      }
      return draft.draftId;
    } catch (e) {
      setError(e.message);
      setStep("error");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const chooseMeme = async () => {
    const id = draftId || (await startDraft());
    if (!id) return;
    setStep("social");
    loadSocial();
  };

  const loadSocial = async () => {
    setSocialLoading(true);
    try {
      const [prov, conns] = await Promise.all([
        socialApi.getProviders().catch(() => ({ providers: [] })),
        socialApi.getConnections(currentUserId()).catch(() => ({ connections: [] })),
      ]);
      setSocialProviders(prov.providers || []);
      setSocialConns(conns.connections || []);
    } finally {
      setSocialLoading(false);
    }
  };

  const connectSocial = async (provider) => {
    setSocialLoading(true);
    try {
      const { authorizeUrl } = await socialApi.getAuthorizeUrl(provider, currentUserId());
      // Open OAuth in system browser; backend callback stores the connection.
      window.open(authorizeUrl, "_blank");
      // Poll for the new connection (user completes OAuth in browser)
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const { connections } = await socialApi.getConnections(currentUserId()).catch(() => ({ connections: [] }));
        if (connections.some((c) => c.provider === provider)) {
          setSocialConns(connections);
          break;
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSocialLoading(false);
    }
  };

  const disconnectSocial = async (provider) => {
    try {
      await socialApi.disconnect(provider, currentUserId());
      setSocialConns(socialConns.filter((c) => c.provider !== provider));
    } catch (e) {
      setError(e.message);
    }
  };

  const continueFromSocial = async () => {
    setStep("meme");
  };

  const signAndMint = async () => {
    if (!legalName.trim() || legalName.trim().length < 2 || !accepted) return;
    if (issuerCategory === "entity" && !entityTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const id = draftId || (await startDraft());
      if (!id) return;
      const sig = await issuanceApi.signAgreement(id, legalName.trim(), {
        issuerCategory,
        title: issuerCategory === "entity" ? entityTitle.trim() : "",
      });
      setSignatureId(sig.signatureId || null);
      setSignedAt(sig.signedAt || null);
      setStep("minting");
      const result = await issuanceApi.mint(id, {
        meme: false,
        idempotencyKey: idempotencyKey.current,
        issuerAddress: await ensureIssuerAddress(),
        totalShares: coin.totalShares,
      });
      setMintResult(result.coin);
      setStep("done");
      onComplete && onComplete(result.coin, false, {
        signatureId: sig.signatureId || null,
        signedAt: sig.signedAt || null,
        legalName: legalName.trim(),
        issuerCategory,
        entityTitle: issuerCategory === "entity" ? entityTitle.trim() : "",
      });
    } catch (e) {
      setError(e.message);
      setStep("error");
    } finally {
      setBusy(false);
    }
  };

  const mintMeme = async () => {
    if (!memeConfirmed) return;
    setBusy(true);
    setError(null);
    try {
      const id = draftId || (await startDraft());
      if (!id) return;
      setStep("minting");
      const result = await issuanceApi.mint(id, {
        meme: true,
        idempotencyKey: idempotencyKey.current,
        issuerAddress: await ensureIssuerAddress(),
        totalShares: coin.totalShares,
      });
      setMintResult(result.coin);
      setStep("done");
      onComplete && onComplete(result.coin, true);
    } catch (e) {
      setError(e.message);
      setStep("error");
    } finally {
      setBusy(false);
    }
  };

  if (step === "choice") {
    const canSign =
      !!draftId &&
      legalName.trim().length >= 2 &&
      accepted &&
      (issuerCategory !== "entity" || entityTitle.trim().length >= 2) &&
      !busy;
    return (
      <div className="issuance-flow">
        <button className="link-btn back-link" onClick={onBack}>
          ← Back to coin details
        </button>
        <h2 className="section-title">Issuer Agreement</h2>
        <p className="section-sub">
          {coin.ticker} · {coin.equityPublic}% public / {coin.equityRetained}% retained · {(coin.totalShares || 100000).toLocaleString()} shares on your own Phase sovereign chain
        </p>
        <p className="section-sub">
          This covenant is made for the benefit of everyone who purchases {coin.ticker}. Read it
          carefully — your digital signature binds you to it.
        </p>
        <div className="agreement-doc">
          <pre className="agreement-text">{agreementText}</pre>
        </div>
        {agreementHash && (
          <p className="field-hint">Document hash: {agreementHash.slice(0, 16)}…</p>
        )}
        <button
          className="btn btn-secondary btn-full"
          type="button"
          onClick={() => window.open(legalApi.agreementUrl(), "_blank", "noopener")}
          disabled={busy}
        >
          View full terms and conditions (PDF)
        </button>
        <p className="field-hint">
          The complete Phase Coin Minting Agreement — the binding document your signature applies to.
        </p>
        <label className="field-label" htmlFor="issuance-issuer-category">
          Issuer category
        </label>
        <select
          id="issuance-issuer-category"
          className="text-input"
          value={issuerCategory}
          onChange={(e) => setIssuerCategory(e.target.value)}
          disabled={busy}
        >
          <option value="individual">Individual (Schedule A)</option>
          <option value="entity">Entity — company, fund, or organization (Schedule B)</option>
        </select>
        {issuerCategory === "entity" && (
          <>
            <label className="field-label" htmlFor="issuance-entity-title">
              Your title at the entity
            </label>
            <input
              id="issuance-entity-title"
              className="text-input"
              placeholder="e.g. Chief Executive Officer"
              value={entityTitle}
              onChange={(e) => setEntityTitle(e.target.value)}
              disabled={busy}
            />
          </>
        )}
        <label className="field-label" htmlFor="issuance-legal-name">
          Your full legal name
        </label>
        <input
          id="issuance-legal-name"
          className="text-input signature-input"
          placeholder="Type your full legal name to sign"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span>
            I, {legalName || "[your name]"}, have read the Phase Coin Minting Agreement
            (full terms) and agree to be bound by its covenants to each purchaser of {coin.ticker}.
          </span>
        </label>
        <button
          className={`btn-primary btn-large ${!canSign ? "btn-disabled" : ""}`}
          onClick={signAndMint}
          disabled={!canSign}
        >
          {busy ? "Signing & minting…" : `Sign & Mint ${coin.ticker}`}
        </button>

        <div className="issuance-meme-alt">
          <div className="market-entry-divider">
            <span>or</span>
          </div>
          <button
            className="btn btn-ghost btn-full"
            onClick={chooseMeme}
            disabled={busy}
          >
            Mint as a Meme Coin — no agreement, no obligations
          </button>
        </div>
        {busy && <p className="field-hint">Preparing your coin draft…</p>}
      </div>
    );
  }

  if (step === "social") {
    const connectedMap = Object.fromEntries(socialConns.map((c) => [c.provider, c]));
    return (
      <div className="issuance-flow">
        <button className="link-btn back-link" onClick={() => setStep("choice")}>
          ← Back to issuance options
        </button>
        <h2 className="section-title">Link your socials</h2>
        <p className="section-sub">
          Verify who you are. Connected accounts show on your coin's profile with real
          follower counts — no fake badges. Optional, but serious issuers link up.
        </p>
        <div className="social-connect-list">
          {socialLoading && socialProviders.length === 0 && (
            <p className="field-hint">Loading social providers…</p>
          )}
          {socialProviders.map((p) => {
            const conn = connectedMap[p.provider];
            return (
              <div key={p.provider} className="social-connect-row">
                <span className="social-connect-icon"><Icon name="social" size={20} /></span>
                <span className="social-connect-info">
                  <span className="social-connect-label">{p.label}</span>
                  {conn ? (
                    <span className="social-connect-detail">
                      @{conn.username}{conn.followerCount != null ? ` · ${formatCount(conn.followerCount)} followers` : ""}
                    </span>
                  ) : (
                    <span className="social-connect-detail">
                      {p.configured ? "Not connected" : "Coming soon"}
                    </span>
                  )}
                </span>
                {conn ? (
                  <button className="btn btn-ghost btn-sm" onClick={() => disconnectSocial(p.provider)}>
                    Disconnect
                  </button>
                ) : (
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={!p.configured || socialLoading}
                    onClick={() => connectSocial(p.provider)}
                  >
                    {socialLoading ? "Waiting…" : "Connect"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {socialLoading && <p className="field-hint">Complete the login in your browser, then come back here…</p>}
        <div className="form-actions">
          <button className="btn btn-primary" onClick={continueFromSocial} disabled={busy || socialLoading}>
            Continue{socialConns.length > 0 ? ` (${socialConns.length} linked)` : ""}
          </button>
          <button className="link-btn" onClick={continueFromSocial} disabled={busy}>
            Skip for now
          </button>
        </div>
      </div>
    );
  }


  if (step === "meme") {
    return (
      <div className="issuance-flow">
        <button className="link-btn back-link" onClick={() => setStep("choice")}>
          ← Back to issuance options
        </button>
        <h2 className="section-title">Meme Coin — No Agreement</h2>
        <div className="meme-disclaimer">
          <p>
            <strong>{coin.name} ({coin.ticker})</strong> will be minted as a meme coin.
          </p>
          <p>This means:</p>
          <ul>
            <li>No issuer agreement and no covenant with purchasers.</li>
            <li>No representations about identity, accuracy, or value.</li>
            <li>No commitment to share revenue, royalties, or appreciation.</li>
            <li>Purchasers buy it for fun — nothing is promised.</li>
          </ul>
          <p className="field-hint">
            This is permanent. A meme coin cannot later gain an issuer agreement.
          </p>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={memeConfirmed}
            onChange={(e) => setMemeConfirmed(e.target.checked)}
          />
          <span>
            I understand {coin.ticker} is a meme coin with no agreement, no representations,
            and no obligations to purchasers.
          </span>
        </label>
        <button
          className={`btn-primary btn-large ${!memeConfirmed || busy ? "btn-disabled" : ""}`}
          onClick={mintMeme}
          disabled={!memeConfirmed || busy}
        >
          {busy ? "Minting…" : `Mint ${coin.ticker} as Meme Coin`}
        </button>
      </div>
    );
  }

  if (step === "minting") {
    return (
      <div className="issuance-flow issuance-status">
        <h2 className="section-title">Minting {coin.ticker}…</h2>
        <p className="section-sub">Provisioning your coin's own sovereign chain. This takes a few seconds.</p>
        <div className="provisioning-steps">
          <div className="provisioning-step provisioning-step-active">
            <span className="provisioning-step-dot" />
            <span className="provisioning-step-label">Provisioning your sovereign chain…</span>
          </div>
        </div>
      </div>
    );
  }

  if (step === "done" && mintResult) {
    return (
      <IssuanceDoneScreen
        mintResult={mintResult}
        coin={coin}
        socialConns={socialConns}
        onBack={onBack}
      />
    );
  }

  return (
    <div className="issuance-flow issuance-status">
      <h2 className="section-title">Something went wrong</h2>
      <p className="section-sub">{error || "The issuance request failed."}</p>
      <button className="btn-secondary" onClick={() => { setError(null); setStep("choice"); }}>
        Try again
      </button>
      <button className="link-btn back-link" onClick={onBack}>
        ← Back to coin details
      </button>
    </div>
  );
}

function IssuanceDoneScreen({ mintResult, coin, socialConns, onBack }) {
  const [announcing, setAnnouncing] = useState(false);
  const [announceResult, setAnnounceResult] = useState(null);
  const [cardUrl, setCardUrl] = useState(null);

  const handleAnnounce = async () => {
    setAnnouncing(true);
    try {
      const res = await socialApi.announce(currentUserId(), coin.name, coin.ticker, !!mintResult.isMeme);
      setCardUrl(res.cardUrl);
      setAnnounceResult(res.results);
    } catch (e) {
      setAnnounceResult({ error: e.message });
    } finally {
      setAnnouncing(false);
    }
  };

  const posted = announceResult && Object.values(announceResult).some((r) => r.ok);

  return (
    <div className="issuance-flow issuance-status">
      <span className="issuance-success-icon"><Icon name="check" size={28} /></span>
      <h2 className="section-title">{mintResult.name} is live!</h2>
      <p className="section-sub">
        {mintResult.isMeme
          ? "Minted as a meme coin — no agreement attached."
          : "Minting Agreement signed — your signed copy is in Documentation & Compliance."}
      </p>
      <div className="mint-details">
        <div className="mint-detail-row">
          <span className="stat-label">Chain ID</span>
          <span className="stat-value mono">{mintResult.mintAddress}</span>
        </div>
        <div className="mint-detail-row">
          <span className="stat-label">Genesis hash</span>
          <span className="stat-value mono">{mintResult.txSignature.slice(0, 20)}…</span>
        </div>
        <div className="mint-detail-row">
          <span className="stat-label">Supply</span>
          <span className="stat-value">{Number(mintResult.supply).toLocaleString()} {mintResult.ticker}</span>
        </div>
        <div className="mint-detail-row">
          <span className="stat-label">Network</span>
          <span className="stat-value">Phase sovereign chain</span>
        </div>
      </div>

      {socialConns.length > 0 && !announceResult && (
        <div className="announce-section">
          <h3 className="announce-title">Tell the world</h3>
          <p className="section-sub">
            Post your launch to {socialConns.map((c) => c.provider).join(", ")} in one tap.
          </p>
          <button className="btn btn-primary" onClick={handleAnnounce} disabled={announcing}>
            {announcing ? "Posting…" : `Announce $${coin.ticker}`}
          </button>
        </div>
      )}
      {cardUrl && (
        <div className="announce-result">
          <img src={cardUrl} alt="Launch card" className="announce-card-img" />
          {posted ? (
            <p className="field-hint">Posted! Check your socials.</p>
          ) : (
            <p className="field-hint">
              Card generated — posting needs the social apps configured on the backend.
            </p>
          )}
        </div>
      )}
      {announceResult?.error && <p className="field-hint">{announceResult.error}</p>}

      <button className="link-btn back-link" onClick={onBack} style={{ marginTop: 16 }}>
        ← Back to Go Live
      </button>
    </div>
  );
}

function ProvisioningModal({ steps, activeIndex, chainId, name }) {  const isFinalStep = activeIndex === steps.length - 1;
  return (
    <div className="modal-overlay provisioning-overlay">
      <div className="modal-card provisioning-card">
        <div className="provisioning-steps">
          {steps.map((step, i) => {
            const state = i < activeIndex ? "done" : i === activeIndex ? "active" : "pending";
            return (
              <div key={step} className={`provisioning-step provisioning-step-${state}`}>
                <span className="provisioning-step-dot">
                  {state === "done" ? <Icon name="check" size={11} /> : null}
                </span>
                <span className="provisioning-step-label">{step}</span>
              </div>
            );
          })}
        </div>

        <div className={`provisioning-chain-reveal ${isFinalStep ? "provisioning-chain-reveal-shown" : ""}`}>
          <span className="provisioning-chain-caption">{name || "Your chain"}</span>
          <span className="provisioning-chain-id">{chainId}</span>
        </div>
      </div>
    </div>
  );
}

function TermsModal({ onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card terms-modal" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <h3>Onchaining Terms &amp; Consent</h3>
        <div className="terms-body">
          {ONCHAINING_TERMS.split("\n\n").map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
        <button className="btn-primary btn-full" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}


function GoLivePathPicker({ choosePath, onBringYourOwn }) {
  return (
    <div className="golive-entry-wrap">
      <div className="glass-card golive-entry-card">
        <h2 className="section-title">What are you putting onchain?</h2>
        <p className="section-sub">
          Pick the path that fits best. If nothing matches, you can always describe it in your own words.
        </p>

        <div className="golive-path-grid">
          {Object.entries(GOLIVE_PATHS).map(([key, path]) => (
            <button
              key={key}
              className="golive-path-btn"
              onClick={() => choosePath(key)}
            >
              <span className="golive-path-icon">
                <Icon name={path.icon} size={22} />
              </span>
              <span className="golive-path-label">{path.label}</span>
              <span className="golive-path-sublabel">{path.sublabel}</span>
              <span className="golive-path-arrow">
                <Icon name="arrowRight" size={16} />
              </span>
            </button>
          ))}
        </div>
      </div>

      <button className="glass-card golive-byon-card" onClick={onBringYourOwn}>
        <span className="golive-byon-icon">
          <Icon name="directory" size={20} />
        </span>
        <div className="golive-byon-text">
          <span className="golive-byon-title">Already verified on another network?</span>
          <span className="golive-byon-sub">
            Bring a product already onchain via Canton, Nasdaq, Ethereum, or Fidelity onto Phase's marketplace.
          </span>
        </div>
        <Icon name="arrowRight" size={16} />
      </button>
    </div>
  );
}

function GoLiveDescribeStep({ pathKey, chooseExample, chooseOwnThesis, onBack }) {
  const path = pathKey ? GOLIVE_PATHS[pathKey] : null;
  if (!path) {
    return (
      <div className="golive-entry-wrap">
        <button className="link-btn back-link" onClick={onBack}>← Back</button>
      </div>
    );
  }
  return (
    <div className="golive-entry-wrap">
      <div className="glass-card golive-entry-card">
        <button className="link-btn back-link" onClick={onBack}>
          ← Back
        </button>
        <h2 className="section-title">{path.label}</h2>
        <p className="section-sub">{path.sublabel}</p>

        <label className="field-label">Choose what best describes it</label>
        <div className="golive-examples-list">
          {path.examples.map((ex) => (
            <button key={ex.label} className="golive-example-btn" onClick={() => chooseExample(ex)}>
              <span>{ex.label}</span>
              <Icon name="arrowRight" size={14} />
            </button>
          ))}
          <button className="golive-example-btn golive-example-btn-own" onClick={chooseOwnThesis}>
            <span>None of these — let me describe my own value thesis</span>
            <Icon name="arrowRight" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function BringYourOwnNetworkFlow({ onBack, onPublish }) {
  const [network, setNetwork] = useState(null);
  const [productName, setProductName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [category, setCategory] = useState("finance");
  const [tagline, setTagline] = useState("");
  const [published, setPublished] = useState(null);

  const canSubmit = network && productName.trim().length > 1 && identifier.trim().length > 1;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const asset = await onPublish({
      name: productName,
      category,
      subsection: ASSET_CATEGORIES[category].subsections[0],
      tagline:
        tagline.trim() ||
        `An already-verified product brought onto Phase's marketplace from ${NETWORKS[network].label}.`,
      platform: null,
      followers: "",
      engagement: "",
      socialUrl: null,
      verification: { status: "verified", lookupFollowers: null, lookupEngagement: null },
      compliance: {
        docFileName: null,
        licenseNumber: identifier,
        consented: true,
      },
      equityPublic: 25,
      bringYourOwnNetwork: network,
      tickerOverride: identifier.toUpperCase(),
    });
    setPublished(asset);
  };

  return (
    <div className="golive-grid">
      <section className="glass-card golive-form">
        <button className="link-btn back-link" onClick={onBack}>
          ← Back to Go Live options
        </button>
        <h2 className="section-title">Bring an Already-Verified Product</h2>
        <p className="section-sub">
          If your product already exists and is verified on another network, list it on Phase's marketplace
          without going through the full publishing flow.
        </p>

        <label className="field-label">Which network is it verified on?</label>
        <div className="category-toggle">
          {Object.entries(NETWORKS)
            .filter(([key]) => key !== "phaseNative")
            .map(([key, meta]) => (
              <button
                key={key}
                className={`pill-btn ${network === key ? "pill-btn-active" : ""}`}
                onClick={() => setNetwork(key)}
              >
                {meta.label}
              </button>
            ))}
        </div>

        <label className="field-label" htmlFor="byon-name">
          Product or fund name
        </label>
        <input
          id="byon-name"
          className="text-input"
          placeholder="e.g. the exact name as listed on that network"
          value={productName}
          onChange={(e) => setProductName(e.target.value)}
        />

        <label className="field-label" htmlFor="byon-identifier">
          Ticker, contract address, or reference ID
        </label>
        <input
          id="byon-identifier"
          className="text-input"
          placeholder="e.g. a ticker symbol or onchain contract address"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />

        <label className="field-label">What kind of product is this?</label>
        <div className="category-toggle category-toggle-wide">
          {Object.entries(ASSET_CATEGORIES).map(([key, meta]) => (
            <button
              key={key}
              className={`cat-btn ${category === key ? "cat-btn-active" : ""}`}
              onClick={() => setCategory(key)}
            >
              <Icon name={meta.icon} size={16} />
              {meta.label}
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="byon-tagline">
          Short description (optional)
        </label>
        <textarea
          id="byon-tagline"
          className="text-input textarea"
          placeholder="What is this product, and why does it belong on Phase's marketplace?"
          value={tagline}
          onChange={(e) => setTagline(e.target.value)}
          rows={3}
        />

        <button
          className={`btn-primary btn-large btn-pulse ${!canSubmit ? "btn-disabled" : ""}`}
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          List on Phase's Marketplace
        </button>

        {published && (
          <div className="publish-success">
            <Icon name="check" size={16} />
            <span>{published.name} is now listed. Check the Marketplace tab.</span>
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------- Card funding (Stripe) ------------------------- */
// Card funding is disabled until live Stripe keys are configured.
// The test-mode Card Element flow was removed; this panel renders a
// placeholder message instead of payment UI.

function CardFundPanel({ onFunded }) {
  return (
    <div className="card-fund-panel">
      <p className="section-sub">Card funding is not available yet.</p>
    </div>
  );
}


function FundAccountModal({ onClose, onFund }) {
  const [method, setMethod] = useState("card"); // card | crypto
  const [step, setStep] = useState("deposit"); // deposit | waiting | confirmed (crypto flow)
  const [cryptoLoading, setCryptoLoading] = useState(false); // crypto tab loads lazily
  const [depositInfo, setDepositInfo] = useState(null);
  const [balances, setBalances] = useState(null);
  const [chain, setChain] = useState("BASE-SEPOLIA");
  const [currency, setCurrency] = useState("USDC");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [pollCount, setPollCount] = useState(0);
  const mountedRef = useRef(true);
  const pollRef = useRef(null);

  const CHAINS = [
    { id: "BASE-SEPOLIA", label: "Base Sepolia", currencies: ["USDC", "USDT"] },
    { id: "MATIC-AMOY", label: "Polygon Amoy", currencies: ["USDC", "USDT"] },
    { id: "SOLANA-DEVNET", label: "Solana Devnet", currencies: ["USDC"] },
    { id: "BTC-TESTNET", label: "Bitcoin Testnet", currencies: ["BTC"], isBtc: true },
  ];

  const isBtcChain = chain === "BTC-TESTNET";

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Lazy-load crypto deposit info only when the Crypto tab is opened.
  // The Card tab never depends on it, so a crypto backend hiccup can't
  // block card payments.
  useEffect(() => {
    if (method === "crypto" && !depositInfo && !cryptoLoading) {
      loadDepositInfo();
    }
  }, [method]);

  useEffect(() => {
    const c = CHAINS.find((x) => x.id === chain);
    if (c && !c.currencies.includes(currency)) setCurrency(c.currencies[0]);
  }, [chain]);

  const loadDepositInfo = async () => {
    setCryptoLoading(true);
    setError(null);
    try {
      if (isBtcChain) {
        const [addr, bal] = await Promise.all([
          fundingApi.getBtcAddress(currentUserId()),
          fundingApi.getBtcBalance(currentUserId()).catch(() => null),
        ]);
        if (!mountedRef.current) return;
        setDepositInfo({ addresses: { "BTC-TESTNET": addr.address }, defaultChain: "BTC-TESTNET", testnet: addr.testnet });
        setBalances(bal ? { totals: { BTC: { credited: bal.confirmedBtc, pending: bal.mempoolBtc } } } : null);
      } else {
        const [dep, bal] = await Promise.all([
          fundingApi.getDepositInfo(currentUserId()),
          fundingApi.getBalances(currentUserId()).catch(() => null),
        ]);
        if (!mountedRef.current) return;
        setDepositInfo(dep);
        setBalances(bal);
        const firstChain = dep.defaultChain || Object.keys(dep.addresses || {})[0];
        if (firstChain) setChain(firstChain);
      }
      if (mountedRef.current) setCryptoLoading(false);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e.message);
      setCryptoLoading(false);
    }
  };

  // Reload when switching between BTC and Circle chains (crypto tab only)
  useEffect(() => {
    if (method === "crypto" && depositInfo) loadDepositInfo();
  }, [chain]);

  const copyAddress = async () => {
    const addr = depositInfo?.addresses?.[chain];
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = addr;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => mountedRef.current && setCopied(false), 2000);
  };

  const startWaiting = () => {
    setStep("waiting");
    setPollCount(0);
    pollRef.current = setInterval(async () => {
      try {
        if (isBtcChain) {
          const bal = await fundingApi.getBtcBalance(currentUserId());
          if (!mountedRef.current) return;
          setPollCount((n) => n + 1);
          const credited = parseFloat(bal?.confirmedBtc || "0");
          const pending = parseFloat(bal?.mempoolBtc || "0");
          if (credited > 0 || pending > 0) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setStep("confirmed");
            onFund && onFund("btc", credited || pending, "BTC deposit");
          }
          return;
        }
        const bal = await fundingApi.getBalances(currentUserId());
        if (!mountedRef.current) return;
        setBalances(bal);
        setPollCount((n) => n + 1);
        const credited = parseFloat(bal?.totals?.[currency]?.credited || "0");
        const pending = parseFloat(bal?.totals?.[currency]?.pending || "0");
        if (credited > 0 || pending > 0) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setStep("confirmed");
          onFund && onFund(currency.toLowerCase(), credited || pending, `${currency} deposit`);
        }
      } catch {
        // keep polling on transient errors
      }
    }, 10000);
  };

  const stopWaiting = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setStep("deposit");
  };

  const address = depositInfo?.addresses?.[chain];
  const totals = balances?.totals || {};
  const chainLabel = (CHAINS.find((c) => c.id === chain) || {}).label || chain;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card fund-modal" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>

        {step === "deposit" && (
          <>
            <h3>Fund Your Account</h3>

            <div className="chain-picker fund-method-tabs">
              <button
                className={"chain-btn" + (method === "card" ? " chain-btn-active" : "")}
                onClick={() => setMethod("card")}
              >
                Card
              </button>
              <button
                className={"chain-btn" + (method === "crypto" ? " chain-btn-active" : "")}
                onClick={() => setMethod("crypto")}
              >
                Crypto
              </button>
            </div>

            {method === "card" ? (
              <CardFundPanel onFunded={onFund} />
            ) : cryptoLoading ? (
              <div className="funding-processing">
                <span className="spinner spinner-large" />
                <h3>Setting up your deposit…</h3>
                <p className="section-sub">Generating your wallet addresses.</p>
              </div>
            ) : error ? (
              <div className="funding-processing">
                <h3>Couldn&apos;t load deposit info</h3>
                <p className="section-sub">{error || "The funding backend didn't respond."}</p>
                <button className="btn btn-secondary" onClick={loadDepositInfo}>Try again</button>
              </div>
            ) : !depositInfo ? (
              <div className="funding-processing">
                <span className="spinner spinner-large" />
                <h3>Setting up your deposit…</h3>
              </div>
            ) : (
            <>
            <p className="section-sub">
              Send {currency} from your external wallet to the address below.
            </p>

            <label className="field-label">Network</label>
            <div className="chain-picker">
              {CHAINS.filter((c) => depositInfo.addresses?.[c.id]).map((c) => (
                <button
                  key={c.id}
                  className={"chain-btn" + (chain === c.id ? " chain-btn-active" : "")}
                  onClick={() => setChain(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <label className="field-label">Currency</label>
            <div className="chain-picker">
              {(CHAINS.find((c) => c.id === chain)?.currencies || ["USDC"]).map((cur) => (
                <button
                  key={cur}
                  className={"chain-btn" + (currency === cur ? " chain-btn-active" : "")}
                  onClick={() => setCurrency(cur)}
                >
                  {cur}
                </button>
              ))}
            </div>

            <label className="field-label">Your {currency} deposit address ({chainLabel})</label>
            <div className="deposit-address-box">
              <span className="deposit-address mono">{address || "—"}</span>
              <button className="btn btn-ghost btn-sm" onClick={copyAddress} disabled={!address}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="field-hint">
              Send only {currency} on {chainLabel}. Other assets will not be credited.
            </p>

            {(totals.USDC || totals.USDT) && (
              <div className="funding-totals">
                {["USDC", "USDT"].map((cur) => totals[cur] && (
                  <div key={cur} className="funding-total-row">
                    <span className="stat-label">{cur}</span>
                    <span className="stat-value">
                      {totals[cur].credited} credited
                      {parseFloat(totals[cur].pending) > 0 && ` \u00b7 ${totals[cur].pending} pending`}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <button className="btn btn-primary btn-large btn-full" onClick={startWaiting} disabled={!address}>
              I&apos;ve sent funds
            </button>
            </>
            )}
          </>
        )}

        {step === "waiting" && (
          <div className="funding-processing">
            <span className="spinner spinner-large" />
            <h3>Watching for your deposit…</h3>
            <p className="section-sub">
              We&apos;re monitoring the blockchain for incoming {currency}. This usually takes
              under a minute. You can close this and come back — your funds are safe.
            </p>
            <p className="field-hint">Checked {pollCount} time{pollCount === 1 ? "" : "s"}</p>
            <button className="btn btn-ghost" onClick={stopWaiting}>Back to address</button>
          </div>
        )}

        {step === "confirmed" && (
          <div className="funding-done">
            <div className="funding-done-icon">
              <Icon name="check" size={22} />
            </div>
            <h3>Deposit detected!</h3>
            <p className="section-sub">
              {totals[currency]?.credited && parseFloat(totals[currency].credited) > 0
                ? `${totals[currency].credited} ${currency} credited to your account.`
                : `${totals[currency]?.pending || ""} ${currency} incoming — confirming on-chain now.`}
            </p>
            <button className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}


function EquitySplitSlider({ equityPublic, setEquityPublic }) {
  return (
    <div className="split-slider-block">
      <div className="split-slider-row">
        <span className="split-slider-tag split-public">Public Sale</span>
        <input
          type="range"
          min="1"
          max="80"
          value={equityPublic}
          onChange={(e) => setEquityPublic(parseInt(e.target.value, 10))}
          className="range-input"
        />
        <span className="split-slider-value">{equityPublic}%</span>
      </div>
      <div className="split-slider-row">
        <span className="split-slider-tag split-retained">Owner Retained</span>
        <input
          type="range"
          min="20"
          max="99"
          value={100 - equityPublic}
          onChange={(e) => setEquityPublic(100 - parseInt(e.target.value, 10))}
          className="range-input range-input-retained"
        />
        <span className="split-slider-value">{100 - equityPublic}%</span>
      </div>
      <p className="field-hint">Move either side — they always total 100%.</p>
    </div>
  );
}

/* ============================= MARKETPLACE TAB =============================== */

// First-run category picker: instead of dumping every listing at once, the
// Marketplace opens on a short category menu. Listings, subsections, and
// network filters only appear after the user picks a category.
function MarketEntrySelect({ counts, onPick, onBrowseAll }) {
  return (
    <div className="market-entry">
      <div className="glass-card market-entry-card">
        <h3 className="cat-picker-title">What are you looking for?</h3>
        <p className="cat-picker-sub">Pick a category to jump straight into live listings.</p>
        <label className="field-label" htmlFor="market-category-select">Choose a category</label>
        <div className="market-entry-select-wrap">
          <select
            id="market-category-select"
            className="market-entry-select"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) onPick(e.target.value);
            }}
          >
            <option value="" disabled>Select a category…</option>
            {Object.entries(ASSET_CATEGORIES).map(([key, meta]) => (
              <option key={key} value={key}>
                {meta.label} — {counts[key] || 0} live
              </option>
            ))}
          </select>
          <Icon name="arrowRight" size={14} />
        </div>
        <div className="market-entry-divider">
          <span>or</span>
        </div>
        <button className="btn-secondary market-entry-browse" onClick={onBrowseAll}>
          <Icon name="directory" size={15} />
          Browse all categories
        </button>
      </div>
    </div>
  );
}

function CategoryPicker({ counts, onPick }) {
  return (
    <div className="cat-picker">
      <div className="glass-card cat-picker-card">
        <h3 className="cat-picker-title">What are you looking for?</h3>
        <p className="cat-picker-sub">Pick a category to browse live listings.</p>
        <div className="cat-picker-list">
          {Object.entries(ASSET_CATEGORIES).map(([key, meta]) => (
            <button key={key} className="cat-picker-btn" onClick={() => onPick(key)}>
              <span className="cat-picker-icon">
                <Icon name={meta.icon} size={20} />
              </span>
              <span className="cat-picker-text">
                <span className="cat-picker-label">{meta.label}</span>
                <span className="cat-picker-count">{counts[key] || 0} live</span>
              </span>
              <Icon name="arrowRight" size={14} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Compact issuer id for display: first 6 chars of the per-install user id.
const issuerTag = (userId) =>
  userId === currentUserId() ? "You" : `Issuer ${String(userId || "").slice(0, 6)}…`;

// One row in the issuer directory: online dot, identity, key numbers,
// and Buy / Compare actions.
function DirectoryCoinCard({ coin, inCompare, onToggleCompare, onDetail, onBuy }) {
  const mcap = (Number(coin.priceUsd) || 0) * (Number(coin.supply) || 0);
  const floatAvail = coin.floatAvailable != null ? Number(coin.floatAvailable) : null;
  return (
    <div className="glass-card dir-coin-card">
      <button className="dir-coin-main" onClick={onDetail} aria-label={`Details for ${coin.name}`}>
        <span className="online-dot" title="Online" />
        <div className="dir-coin-id">
          <div className="dir-coin-avatar">{String(coin.ticker || "?").slice(0, 2).toUpperCase()}</div>
          <div className="dir-coin-names">
            <div className="holdings-name">
              {coin.name}
              <span className="ticker-tag">{coin.ticker}</span>
            </div>
            <div className="dir-coin-sub">
              {coin.mine ? "Your issuance" : issuerTag(coin.issuerUserId)}
              {" · "}
              {coin.hasAgreement ? "Agreement signed" : coin.isMeme ? "Meme coin" : "No agreement"}
            </div>
          </div>
        </div>
        <div className="dir-coin-stats">
          <span className="price-text-sm">${(Number(coin.priceUsd) || 0).toFixed(2)}</span>
          <span className="dir-coin-mcap">MCap ${formatCount(mcap)}</span>
          {floatAvail != null && <span className="dir-coin-float">{formatCount(floatAvail)} available</span>}
        </div>
      </button>
      <div className="dir-coin-actions">
        {!coin.mine && (
          <button className="pill-btn pill-btn-active dir-buy-btn" onClick={onBuy}>
            Buy
          </button>
        )}
        <button
          className={`pill-btn ${inCompare ? "pill-btn-active" : ""}`}
          onClick={onToggleCompare}
        >
          {inCompare ? "✓ Comparing" : "Compare"}
        </button>
      </div>
    </div>
  );
}

// Full key information for one coin — everything needed to decide.
function CoinDetailModal({ coin, inCompare, onToggleCompare, onClose, onBuy }) {
  const mcap = (Number(coin.priceUsd) || 0) * (Number(coin.supply) || 0);
  const floatAvail = coin.floatAvailable != null ? Number(coin.floatAvailable) : null;
  const issuedOn = coin.createdAt ? new Date(coin.createdAt).toLocaleDateString() : "—";
  const rows = [
    ["Price per coin", `$${(Number(coin.priceUsd) || 0).toFixed(2)}`],
    ["Market cap", `$${formatCount(mcap)}`],
    ["Total supply", formatCount(Number(coin.supply) || 0)],
    ["Available to buy", floatAvail != null ? `${formatCount(floatAvail)} ${coin.ticker}` : "—"],
    ["Issuer", coin.mine ? "You (this install)" : issuerTag(coin.issuerUserId)],
    ["Agreement", coin.hasAgreement ? "Signed ✓" : coin.isMeme ? "Meme — none required" : "None"],
    ["Coin type", coin.isMeme ? "Meme" : coin.category || "Sovereign"],
    ["Issued", issuedOn],
    ["Status", "● Online"],
  ];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card coin-detail-modal" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <div className="dir-coin-id coin-detail-head">
          <div className="dir-coin-avatar dir-coin-avatar-lg">
            {String(coin.ticker || "?").slice(0, 2).toUpperCase()}
          </div>
          <div>
            <h3>
              {coin.name} <span className="ticker-tag">{coin.ticker}</span>
            </h3>
            <p className="section-sub">
              {coin.mine ? "Your issuance" : issuerTag(coin.issuerUserId)} · sovereign chain
            </p>
          </div>
        </div>
        <div className="coin-detail-rows">
          {rows.map(([label, value]) => (
            <div className="coin-detail-row" key={label}>
              <span className="stat-label">{label}</span>
              <span className="coin-detail-value">{value}</span>
            </div>
          ))}
        </div>
        <div className="coin-detail-actions">
          {!coin.mine && (
            <button className="pill-btn pill-btn-active" onClick={onBuy}>
              Buy {coin.ticker}
            </button>
          )}
          <button
            className={`pill-btn ${inCompare ? "pill-btn-active" : ""}`}
            onClick={onToggleCompare}
          >
            {inCompare ? "✓ Comparing" : "Add to compare"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Side-by-side comparison of up to 3 coins.
function CompareModal({ coins, onRemove, onClose, onBuy }) {
  const mcap = (c) => (Number(c.priceUsd) || 0) * (Number(c.supply) || 0);
  const rows = [
    ["Price", (c) => `$${(Number(c.priceUsd) || 0).toFixed(2)}`],
    ["Market cap", (c) => `$${formatCount(mcap(c))}`],
    ["Supply", (c) => formatCount(Number(c.supply) || 0)],
    ["Available", (c) => (c.floatAvailable != null ? formatCount(Number(c.floatAvailable)) : "—")],
    ["Issuer", (c) => (c.mine ? "You" : issuerTag(c.issuerUserId))],
    ["Agreement", (c) => (c.hasAgreement ? "Signed ✓" : c.isMeme ? "Meme" : "None")],
    ["Type", (c) => (c.isMeme ? "Meme" : c.category || "Sovereign")],
    ["Issued", (c) => (c.createdAt ? new Date(c.createdAt).toLocaleDateString() : "—")],
  ];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card compare-modal" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <h3>Compare coins</h3>
        <p className="section-sub">Side-by-side, so you can decide.</p>
        <div className="compare-table-wrap">
          <table className="compare-table">
            <thead>
              <tr>
                <th />
                {coins.map((c) => (
                  <th key={c.chainId}>
                    <div className="compare-head">
                      <span className="ticker-tag">{c.ticker}</span>
                      <button className="icon-btn" onClick={() => onRemove(c.chainId)} aria-label={`Remove ${c.ticker}`}>
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                    <div className="compare-name">{c.name}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, get]) => (
                <tr key={label}>
                  <td className="stat-label">{label}</td>
                  {coins.map((c) => (
                    <td key={c.chainId}>{get(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="coin-detail-actions">
          {coins
            .filter((c) => !c.mine)
            .map((c) => (
              <button key={c.chainId} className="pill-btn" onClick={() => onBuy(c)}>
                Buy {c.ticker}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

function MarketplaceTab({ assets, currency, setCurrency, onInvest, onInvestSwap, sovereignAddress, phaseCoins, cashBalances, liveFx, tradeCashUsd, onTopup }) {
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [marketEntry, setMarketEntry] = useState("select"); // select (dropdown) | browse (all category cards)
  const [subsectionFilter, setSubsectionFilter] = useState("all");
  const [networkFilters, setNetworkFilters] = useState([]); // empty = all networks
  const [expandedId, setExpandedId] = useState(null);
  const [financialsAsset, setFinancialsAsset] = useState(null);
  const [activeAsset, setActiveAsset] = useState(null);

  // Issuer directory: every sovereign coin issued and online — other
  // issuers as well as this install's own issuances, in one seamless list.
  const [dirCoins, setDirCoins] = useState([]);
  const [dirLoading, setDirLoading] = useState(true);
  const [dirError, setDirError] = useState(null);
  const [dirQuery, setDirQuery] = useState("");
  const [dirFilter, setDirFilter] = useState("all"); // all | mine | others
  const [myCoinList, setMyCoinList] = useState([]); // this install's own issued coins
  const [detailCoin, setDetailCoin] = useState(null);
  const [compareIds, setCompareIds] = useState([]); // chainIds, max 3
  const [compareOpen, setCompareOpen] = useState(false);
  // Category browsing lives behind "Other assets" at the bottom of the page —
  // the marketplace opens as a search-first issuer directory, not a list.
  const [showOtherAssets, setShowOtherAssets] = useState(false);

  const refreshDirectory = useCallback(async () => {
    setDirLoading(true);
    setDirError(null);
    try {
      const [dir, mine] = await Promise.all([
        marketApi.directory().catch(() => ({ coins: [] })),
        marketApi.myCoins().catch(() => ({ coins: [] })),
      ]);
      const coins = (dir.coins || []).map((c) => ({
        ...c,
        id: `coin-${c.chainId}`,
        assetId: `coin-${c.chainId}`,
        price: Number(c.priceUsd) || 0,
        tagline: `${c.name} — sovereign coin`,
        mine: c.issuerUserId === currentUserId(),
      }));
      setDirCoins(coins);
      setMyCoinList(
        (mine.coins || []).map((c) => ({
          ...c,
          id: `coin-${c.mintAddress}`,
          chainId: c.mintAddress,
          assetId: `coin-${c.mintAddress}`,
          price: Number(c.priceUsd) || 0,
          tagline: `${c.name} — your sovereign coin`,
          mine: true,
        }))
      );
    } catch (e) {
      setDirError(e.message || "Couldn't load the directory");
    } finally {
      setDirLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshDirectory();
  }, [refreshDirectory]);

  const toggleCompare = (chainId) => {
    setCompareIds((prev) =>
      prev.includes(chainId)
        ? prev.filter((id) => id !== chainId)
        : prev.length >= 3
          ? prev
          : [...prev, chainId]
    );
  };

  const dirFiltered = useMemo(() => {
    const q = dirQuery.trim().toLowerCase();
    return dirCoins.filter((c) => {
      if (dirFilter === "mine" && !c.mine) return false;
      if (dirFilter === "others" && c.mine) return false;
      if (!q) return true;
      return `${c.name} ${c.ticker} ${c.issuerUserId || ""}`.toLowerCase().includes(q);
    });
  }, [dirCoins, dirQuery, dirFilter]);

  const compareCoins = useMemo(
    () => compareIds.map((id) => dirCoins.find((c) => c.chainId === id)).filter(Boolean),
    [compareIds, dirCoins]
  );

  const availableSubsections =
    categoryFilter !== "all" ? ASSET_CATEGORIES[categoryFilter].subsections : [];

  const toggleNetwork = (id) => {
    setNetworkFilters((prev) =>
      prev.includes(id) ? prev.filter((n) => n !== id) : [...prev, id]
    );
  };

  const filteredAssets = assets.filter((a) => {
    if (categoryFilter !== "all" && a.category !== categoryFilter) return false;
    if (subsectionFilter !== "all" && a.subsection !== subsectionFilter) return false;
    if (networkFilters.length > 0 && !networkFilters.includes(a.network)) return false;
    return true;
  });

  const countsByCategory = useMemo(() => {
    const counts = {};
    assets.forEach((a) => {
      counts[a.category] = (counts[a.category] || 0) + 1;
    });
    return counts;
  }, [assets]);

  const handleRowClick = (asset) => {
    if (expandedId === asset.id) {
      // Already expanded once \u2014 second click opens full financials.
      setFinancialsAsset(asset);
    } else {
      setExpandedId(asset.id);
    }
  };

  return (
    <div className={"market-wrap" + (MARKETPLACE_LOCKED ? " market-gated" : "")}>
      {MARKETPLACE_LOCKED && (
        <div className="market-lock-overlay">
          <div className="glass-card market-lock-card">
            <div className="market-lock-mark">
              <Icon name="lock" size={30} />
            </div>
            <h3 className="market-lock-title">Marketplace opening soon</h3>
            <p className="market-lock-sub">
              Trading will be available here soon.
            </p>
          </div>
        </div>
      )}
      <div
        className={MARKETPLACE_LOCKED ? "market-locked-blur" : undefined}
        inert={MARKETPLACE_LOCKED ? true : undefined}
        aria-hidden={MARKETPLACE_LOCKED ? true : undefined}
      >
      <div className="market-header">
        <h2 className="section-title">Marketplace</h2>
        <CurrencyDropdown currency={currency} setCurrency={setCurrency} />
      </div>
      <p className="field-hint market-fee-disclosure">
        Phase charges 0.80% on applicable transactions.
      </p>

      {/* Issuer search — every person who minted a coin on Phase, searchable.
          No list until you search: the directory is a search function. */}
      <div className="dir-section">
        <div className="dir-search-row">
          <div className="dir-search-wrap">
            <Icon name="search" size={16} />
            <input
              className="dir-search"
              placeholder="Search coins, tickers, issuers…"
              value={dirQuery}
              onChange={(e) => setDirQuery(e.target.value)}
            />
          </div>
          <button className="icon-btn dir-refresh" onClick={refreshDirectory} aria-label="Refresh directory">
            <Icon name="refresh" size={16} />
          </button>
        </div>
        <div className="dir-pills">
          {[
            ["all", "All live"],
            ["mine", "My coins"],
            ["others", "Others' coins"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={`pill-btn ${dirFilter === id ? "pill-btn-active" : ""}`}
              onClick={() => setDirFilter(id)}
            >
              {label}
            </button>
          ))}
          {compareIds.length > 0 && (
            <button className="pill-btn dir-compare-btn" onClick={() => setCompareOpen(true)}>
              Compare ({compareIds.length})
            </button>
          )}
        </div>

        {dirLoading ? (
          <div className="glass-card dir-loading">
            <p className="section-sub">Loading live issuers…</p>
          </div>
        ) : dirError ? (
          <div className="glass-card empty-state">
            <h3>Directory unavailable</h3>
            <p>{dirError}</p>
            <button className="pill-btn" onClick={refreshDirectory}>Retry</button>
          </div>
        ) : dirQuery.trim() === "" && dirFilter === "all" ? (
          <div className="glass-card dir-search-prompt">
            <Icon name="search" size={28} />
            <h3>Search every issuer on Phase</h3>
            <p>
              {dirCoins.length > 0
                ? `${dirCoins.length} coin${dirCoins.length === 1 ? "" : "s"} live — type a coin, ticker, or issuer name to find them.`
                : "No coins have been issued yet — be the first from Go Live."}
            </p>
          </div>
        ) : dirFiltered.length === 0 ? (
          <div className="glass-card empty-state">
            <Icon name="directory" size={32} />
            <h3>No issuers match</h3>
            <p>
              {dirCoins.length === 0
                ? "No coins have been issued yet — be the first from Go Live."
                : "Try a different search or filter."}
            </p>
          </div>
        ) : (
          <div className="dir-coin-list">
            {dirFiltered.map((coin) => (
              <DirectoryCoinCard
                key={coin.chainId}
                coin={coin}
                inCompare={compareIds.includes(coin.chainId)}
                onToggleCompare={() => toggleCompare(coin.chainId)}
                onDetail={() => setDetailCoin(coin)}
                onBuy={() => setActiveAsset(coin)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Other assets: category browsing, behind a tap at the bottom. */}
      <div className="market-browse-divider">
        <button
          className="other-assets-toggle"
          onClick={() => setShowOtherAssets((v) => !v)}
          aria-expanded={showOtherAssets}
        >
          <span>Other assets</span>
          <Icon name={showOtherAssets ? "chevronUp" : "chevronDown"} size={15} />
        </button>
      </div>

      {showOtherAssets && (
      categoryFilter === "all" ? (
        marketEntry === "select" ? (
          <MarketEntrySelect
            counts={countsByCategory}
            onPick={(id) => {
              setCategoryFilter(id);
              setSubsectionFilter("all");
            }}
            onBrowseAll={() => setMarketEntry("browse")}
          />
        ) : (
          <>
            <button className="market-back-link" onClick={() => setMarketEntry("select")}>
              <span className="back-arrow-flip"><Icon name="arrowRight" size={13} /></span> Back to quick pick
            </button>
            <CategoryPicker
              counts={countsByCategory}
              onPick={(id) => {
                setCategoryFilter(id);
                setSubsectionFilter("all");
              }}
            />
          </>
        )
      ) : (
        <>
          <div className="market-filter-row">
            <CategoryFilterDropdown
              categoryFilter={categoryFilter}
              setCategoryFilter={(id) => {
                setCategoryFilter(id);
                setSubsectionFilter("all");
                if (id === "all") setMarketEntry("select");
              }}
            />
            <SubsectionFilterDropdown
              subsections={availableSubsections}
              subsectionFilter={subsectionFilter}
              setSubsectionFilter={setSubsectionFilter}
            />
          </div>

          <NetworkFilterPanel networkFilters={networkFilters} toggleNetwork={toggleNetwork} onClear={() => setNetworkFilters([])} />

          {filteredAssets.length === 0 ? (
            <div className="empty-state glass-card">
              <Icon name="directory" size={32} />
              <h3>Nothing here yet</h3>
              <p>No live assets match this filter right now.</p>
            </div>
          ) : (
            <div className="asset-list">
              {filteredAssets.map((asset) => (
                <AssetListRow
                  key={asset.id}
                  asset={asset}
                  currency={currency}
                  liveFx={liveFx}
                  expanded={expandedId === asset.id}
                  onRowClick={() => handleRowClick(asset)}
                  onInvest={() => setActiveAsset(asset)}
                />
              ))}
            </div>
          )}
        </>
      )
      )}

      {activeAsset && (
        <InvestModal
          asset={activeAsset}
          phaseCoins={phaseCoins}
          cashBalances={cashBalances}
          liveFx={liveFx}
          tradeCashUsd={tradeCashUsd}
          sovereignAddress={sovereignAddress}
          myCoins={myCoinList}
          onTopup={onTopup}
          onClose={() => setActiveAsset(null)}
          onInvest={(amount, payCurrency) => {
            onInvest(activeAsset, amount, payCurrency);
            setActiveAsset(null);
          }}
          onInvestSwap={(offerCoin, offerUnits) => {
            onInvestSwap(activeAsset, offerCoin, offerUnits);
            setActiveAsset(null);
          }}
        />
      )}

      {detailCoin && (
        <CoinDetailModal
          coin={detailCoin}
          inCompare={compareIds.includes(detailCoin.chainId)}
          onToggleCompare={() => toggleCompare(detailCoin.chainId)}
          onClose={() => setDetailCoin(null)}
          onBuy={() => {
            setActiveAsset(detailCoin);
            setDetailCoin(null);
          }}
        />
      )}

      {compareOpen && compareCoins.length > 0 && (
        <CompareModal
          coins={compareCoins}
          onRemove={(chainId) => toggleCompare(chainId)}
          onClose={() => setCompareOpen(false)}
          onBuy={(coin) => {
            setActiveAsset(coin);
            setCompareOpen(false);
          }}
        />
      )}

      {financialsAsset && (
        <FinancialsModal
          asset={financialsAsset}
          currency={currency}
          liveFx={liveFx}
          onClose={() => setFinancialsAsset(null)}
          onInvest={() => {
            setActiveAsset(financialsAsset);
            setFinancialsAsset(null);
          }}
        />
      )}
      </div>
    </div>
  );
}

function CategoryFilterDropdown({ categoryFilter, setCategoryFilter }) {
  const [open, setOpen] = useState(false);
  const current = categoryFilter === "all" ? null : ASSET_CATEGORIES[categoryFilter];

  return (
    <div className="currency-dropdown-wrap">
      <button className="filter-dropdown-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        {current && <Icon name={current.icon} size={14} />}
        <span>{current ? current.label : "All Categories"}</span>
        <Icon name="arrowRight" size={13} />
      </button>
      {open && (
        <>
          <div className="dropdown-backdrop" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="currency-dropdown-menu category-filter-menu" role="listbox">
            <button
              className={`currency-option ${categoryFilter === "all" ? "currency-option-active" : ""}`}
              onClick={() => { setCategoryFilter("all"); setOpen(false); }}
            >
              <span className="currency-option-label">All Categories</span>
              {categoryFilter === "all" && <Icon name="check" size={14} />}
            </button>
            {Object.entries(ASSET_CATEGORIES).map(([key, meta]) => (
              <button
                key={key}
                className={`currency-option ${categoryFilter === key ? "currency-option-active" : ""}`}
                onClick={() => { setCategoryFilter(key); setOpen(false); }}
              >
                <Icon name={meta.icon} size={14} />
                <span className="currency-option-label">{meta.label}</span>
                {categoryFilter === key && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SubsectionFilterDropdown({ subsections, subsectionFilter, setSubsectionFilter }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="currency-dropdown-wrap">
      <button className="filter-dropdown-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span>{subsectionFilter === "all" ? "All Sectors" : subsectionFilter}</span>
        <Icon name="arrowRight" size={13} />
      </button>
      {open && (
        <>
          <div className="dropdown-backdrop" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="currency-dropdown-menu" role="listbox">
            <button
              className={`currency-option ${subsectionFilter === "all" ? "currency-option-active" : ""}`}
              onClick={() => { setSubsectionFilter("all"); setOpen(false); }}
            >
              <span className="currency-option-label">All Sectors</span>
              {subsectionFilter === "all" && <Icon name="check" size={14} />}
            </button>
            {subsections.map((s) => (
              <button
                key={s}
                className={`currency-option ${subsectionFilter === s ? "currency-option-active" : ""}`}
                onClick={() => { setSubsectionFilter(s); setOpen(false); }}
              >
                <span className="currency-option-label">{s}</span>
                {subsectionFilter === s && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function NetworkFilterPanel({ networkFilters, toggleNetwork, onClear }) {
  return (
    <div className="network-filter-panel">
      <span className="network-filter-label">Verified by</span>
      <div className="network-filter-badges">
        {Object.entries(NETWORKS).map(([id, meta]) => {
          const active = networkFilters.includes(id);
          return (
            <button
              key={id}
              className={`network-badge ${active ? "network-badge-active" : ""}`}
              onClick={() => toggleNetwork(id)}
              aria-pressed={active}
            >
              {active && <Icon name="check" size={11} />}
              {meta.short}
            </button>
          );
        })}
        {networkFilters.length > 0 && (
          <button className="network-filter-clear" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function CurrencyDropdown({ currency, setCurrency, excludeIds }) {
  const [open, setOpen] = useState(false);
  const visibleCurrencies = excludeIds ? CURRENCIES.filter((c) => !excludeIds.includes(c.id)) : CURRENCIES;
  const current = visibleCurrencies.find((c) => c.id === currency) || visibleCurrencies[0];
  const groups = ["Fiat", "Stablecoin", "Crypto"];

  return (
    <div className="currency-dropdown-wrap">
      <button
        className="currency-dropdown-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="currency-dropdown-current">{current.short}</span>
        <span className="currency-dropdown-sub">{current.label}</span>
        <Icon name="arrowRight" size={13} />
      </button>

      {open && (
        <>
          <div
            className="dropdown-backdrop"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <div className="currency-dropdown-menu" role="listbox">
            {groups.map((group) => (
              <div key={group} className="currency-group">
                <span className="currency-group-label">{group}</span>
                {visibleCurrencies.filter((c) => c.group === group).map((c) => (
                  <button
                    key={c.id}
                    className={`currency-option ${currency === c.id ? "currency-option-active" : ""}`}
                    onClick={() => {
                      setCurrency(c.id);
                      setOpen(false);
                    }}
                    role="option"
                    aria-selected={currency === c.id}
                  >
                    <span className="currency-option-short">{c.short}</span>
                    <span className="currency-option-label">{c.label}</span>
                    {currency === c.id && <Icon name="check" size={14} />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AssetListRow({ asset, currency, liveFx, expanded, onRowClick, onInvest }) {
  const changePct = ((asset.price - asset.prevPrice) / asset.prevPrice) * 100;
  const positive = changePct >= 0;
  const isVerified = asset.verification && asset.verification.status === "verified";
  const compliant = asset.compliance && asset.compliance.consented;

  return (
    <div className={`glass-card asset-list-row ${expanded ? "asset-list-row-expanded" : ""}`}>
      <div
        className="asset-list-row-collapsed"
        onClick={onRowClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onRowClick();
          }
        }}
      >
        <div className="asset-avatar asset-avatar-sm">
          <Icon name={ASSET_CATEGORIES[asset.category].icon} size={16} />
        </div>
        <div className="asset-list-row-main">
          <div className="asset-list-row-top">
            <span className="holdings-name">
              {asset.name}
              {asset.ticker && <span className="ticker-tag">{asset.ticker}</span>}
            </span>
            <div className="asset-list-row-price">
              <span className={`price-text-sm ${positive ? "price-up" : "price-down"}`} key={asset.price}>
                {formatCurrency(asset.price, currency, liveFx)}
              </span>
              <span className={`change-text ${positive ? "price-up" : "price-down"}`}>
                {positive ? "+" : ""}
                {changePct.toFixed(2)}%
              </span>
            </div>
          </div>
          <div className="asset-list-row-bottom">
            <span className="network-pill">{NETWORKS[asset.network]?.short || "Phase Native"}</span>
            <Sparkline points={asset.history} width={56} height={20} positive={positive} />
          </div>
        </div>
        <span className="asset-list-row-chevron">
          <Icon name={expanded ? "close" : "arrowRight"} size={14} />
        </span>
      </div>

      {expanded && (
        <div className="asset-list-row-expanded-content">
          <p className="asset-tagline">{asset.tagline}</p>

          {/* Prominent external link buttons: social media for creator coins, website for business/assets */}
          {((asset.socialProfiles && asset.socialProfiles.length > 0) || asset.socialUrl || asset.websiteUrl) && (
            <div className="asset-external-links">
              {(asset.socialProfiles && asset.socialProfiles.length > 0
                ? asset.socialProfiles
                : asset.socialUrl
                  ? [{ platform: asset.platform || "Social", url: asset.socialUrl }]
                  : []
              ).map((p, i) => (
                <a
                  key={`social-${p.platform}-${i}`}
                  className="btn-external-link btn-social-link"
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Icon name="external" size={14} /> Visit {p.platform} Profile
                </a>
              ))}
              {asset.websiteUrl && (
                <a
                  className="btn-external-link btn-website-link"
                  href={asset.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Icon name="external" size={14} /> Visit Website
                </a>
              )}
            </div>
          )}

          <div className="asset-badges-row">
            {isVerified && (
              <span className="badge badge-verified">
                <Icon name="check" size={11} /> Social Verified
              </span>
            )}
            {compliant && (
              <span className="badge badge-compliant">
                <Icon name="check" size={11} /> Documentation on File
              </span>
            )}
          </div>

          <div className="asset-card-stats">
            {getOperationalSnapshot(asset).map((stat) => (
              <div key={stat.label}>
                <span className="stat-label">{stat.label}</span>
                <span className="stat-value">{stat.value}</span>
              </div>
            ))}
          </div>

          {asset.chainId && <SovereignChainPanel asset={asset} compact />}

          <div className="asset-list-row-actions">
            <button className="btn-primary" onClick={onInvest}>
              Buy Shares
            </button>
            <button
              className="btn-secondary btn-disabled"
              disabled
              title="You don't currently hold a position in this asset"
            >
              Sell Shares
            </button>
          </div>
          <button className="link-btn view-full-profile-link" onClick={onRowClick}>
            View Full Profile →
          </button>
        </div>
      )}
    </div>
  );
}

// Renders a sovereign chain's live identity: chain ID, isolation notice,
// share allocation, PHASE inflow pool, and a scrollable block feed. Used in
// both the marketplace row's expanded state (compact) and the full
// financials modal (non-compact, taller feed).
function SovereignChainPanel({ asset, compact }) {
  if (!asset.chainId) return null;
  const dirIcon = asset.tickDirection === "UP" ? "▲" : asset.tickDirection === "DOWN" ? "▼" : "→";
  const dirClass =
    asset.tickDirection === "UP" ? "price-up" : asset.tickDirection === "DOWN" ? "price-down" : "";
  const recentBlocks = [...asset.chainHistory].slice(-(compact ? 4 : 10)).reverse();

  return (
    <div className={`chain-panel ${compact ? "chain-panel-compact" : ""}`}>
      <div className="chain-panel-header">
        <span className="chain-id-badge">
          <Icon name="directory" size={12} /> {asset.chainId}
        </span>
        <span className={`chain-tick-flag ${dirClass}`}>{dirIcon} {asset.tickDirection || "FLAT"}</span>
      </div>
      <p className="chain-panel-note">
        Isolated sovereign ledger — zero base fee. This chain's activity cannot affect or be affected by
        any other chain on Phase.
      </p>
      <div className="chain-panel-stats">
        <div>
          <span className="stat-label">Total Minted</span>
          <span className="stat-value">{asset.totalMinted.toLocaleString()}</span>
        </div>
        <div>
          <span className="stat-label">Public Float</span>
          <span className="stat-value">{asset.publicFloatShares.toLocaleString()}</span>
        </div>
        <div>
          <span className="stat-label">Retained</span>
          <span className="stat-value">{asset.retainedShares.toLocaleString()}</span>
        </div>
        <div>
          <span className="stat-label">PHASE Pool</span>
          <span className="stat-value">{(asset.phaseCoinPool || 0).toLocaleString()}</span>
        </div>
      </div>
      <div className="chain-block-feed">
        {recentBlocks.map((b, i) => (
          <div
            key={b.height}
            className={`chain-block-row ${i === 0 ? "chain-block-row-new" : ""}`}
          >
            <span className="chain-block-height">#{b.height}</span>
            <span className="chain-block-detail">{b.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FinancialsModal({ asset, currency, liveFx, onClose, onInvest }) {
  const changePct = ((asset.price - asset.prevPrice) / asset.prevPrice) * 100;
  const positive = changePct >= 0;
  const high = Math.max(...asset.history, asset.price);
  const low = Math.min(...asset.history, asset.price);
  const isVerified = asset.verification && asset.verification.status === "verified";
  const compliant = asset.compliance && asset.compliance.consented;
  const network = NETWORKS[asset.network] || NETWORKS.phaseNative;

  // Caption the outbound link by its actual host, matching the precise,
  // unembellished phrasing requested rather than a generic "learn more."
  const learnMoreCaption = asset.learnMoreUrl
    ? asset.learnMoreUrl.includes("wikipedia.org")
      ? "View Independent Asset Registry on Wikipedia"
      : asset.learnMoreUrl.includes("finance.yahoo.com")
      ? "Verify Certified Deep Financials on Yahoo Finance"
      : asset.learnMoreUrl.includes("google.com")
      ? "Verify Certified Deep Financials on Google Finance"
      : "View Independent Reference Source"
    : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card financials-modal" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>

        <div className="financials-header">
          <div className="asset-avatar">
            <Icon name={ASSET_CATEGORIES[asset.category].icon} size={20} />
          </div>
          <div>
            <h3>
              {asset.name}
              {asset.ticker && <span className="ticker-tag ticker-tag-lg">{asset.ticker}</span>}
            </h3>
            <span className="preview-category">
              {ASSET_CATEGORIES[asset.category].label}
              {asset.subsection ? ` · ${asset.subsection}` : ""}
            </span>
          </div>
          <span className="network-pill network-pill-modal">{network.short}</span>
        </div>

        <p className="section-sub">{asset.tagline}</p>

        <div className="financials-price-row">
          <span className={`financials-price ${positive ? "price-up" : "price-down"}`}>
            {formatCurrency(asset.price, currency, liveFx)}
          </span>
          <span className={`change-text ${positive ? "price-up" : "price-down"}`}>
            {positive ? "+" : ""}
            {changePct.toFixed(2)}% today
          </span>
        </div>

        <AssetTrendChart points={asset.history} currency={currency} liveFx={liveFx} positive={positive} />

        <div className="financials-stat-grid">
          <div className="financials-stat">
            <span className="stat-label">Recent High</span>
            <span className="stat-value">{formatCurrency(high, currency, liveFx)}</span>
          </div>
          <div className="financials-stat">
            <span className="stat-label">Recent Low</span>
            <span className="stat-value">{formatCurrency(low, currency, liveFx)}</span>
          </div>
          <div className="financials-stat">
            <span className="stat-label">Authority Score</span>
            <span className="stat-value">{asset.authorityScore} / 99</span>
          </div>
          <div className="financials-stat">
            <span className="stat-label">Public / Retained Split</span>
            <span className="stat-value">{asset.equityPublic}% / {asset.equityRetained}%</span>
          </div>
        </div>

        <div className="asset-badges-row">
          {isVerified && (
            <span className="badge badge-verified">
              <Icon name="check" size={11} /> Social Verified
            </span>
          )}
          {compliant && (
            <span className="badge badge-compliant">
              <Icon name="check" size={11} /> Documentation on File
            </span>
          )}
        </div>

        {asset.chainId && <SovereignChainPanel asset={asset} />}

        {asset.learnMoreUrl && (
          <a
            className="financials-learn-more"
            href={asset.learnMoreUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {learnMoreCaption} ↗
          </a>
        )}

        <button className="btn-primary btn-large btn-full" onClick={onInvest}>
          Invest Instantly
        </button>
      </div>
    </div>
  );
}

const QUICK_AMOUNTS = [10, 25, 50, 100, 250];

function InvestModal({ asset, phaseCoins, cashBalances, liveFx, tradeCashUsd, sovereignAddress, myCoins, onTopup, onClose, onInvest, onInvestSwap }) {
  const [amount, setAmount] = useState("");
  const [usePhase, setUsePhase] = useState(true);
  const [payCurrency, setPayCurrency] = useState("usd");
  // Sovereign pay method: "usd" (Trade USD, issuer gets paid) or "coin"
  // (offer units of your own issued coin in exchange).
  const [sovPay, setSovPay] = useState("usd");
  const [offerCoinId, setOfferCoinId] = useState("");
  const [offerUnits, setOfferUnits] = useState("");
  const [offerBalances, setOfferBalances] = useState({});
  const [balancesLoading, setBalancesLoading] = useState(false);

  // Server-authoritative 80-bps fee quotes. The client never computes fees —
  // it only displays what the backend quotes; settlement recomputes them.
  const [quote, setQuote] = useState(null); // buy quote
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState(null);
  const quoteReqRef = useRef(0);
  const [swapQuote, setSwapQuote] = useState(null); // swap quote
  const [swapQuoteLoading, setSwapQuoteLoading] = useState(false);
  const [swapQuoteError, setSwapQuoteError] = useState(null);
  const swapQuoteReqRef = useRef(0);

  // Sovereign coins settle for real on the backend: buyer USD -> issuer USD
  // plus coins move on the coin's own chain — or a coin-for-coin swap.
  const isSovereign = asset.chainId && String(asset.chainId).startsWith("ch_");

  const effectivePayId = isSovereign ? "trade-usd" : usePhase ? "phase" : payCurrency;
  const numericAmount = parseFloat(amount) || 0;
  const numericOfferUnits = Math.floor(parseFloat(offerUnits) || 0);
  const availableInPayCurrency = isSovereign ? tradeCashUsd || 0 : cashBalances[payCurrency] || 0;

  // Coins this install issued that can be offered (never the target itself).
  const offerableCoins = (myCoins || []).filter((c) => c.chainId !== asset.chainId);
  const offerCoin = offerableCoins.find((c) => c.chainId === offerCoinId) || null;
  const offerBalance = offerCoin ? offerBalances[offerCoin.chainId] || 0 : 0;

  // Load on-chain balances of the user's own coins when the coin tab opens.
  useEffect(() => {
    if (!isSovereign || sovPay !== "coin" || !sovereignAddress || offerableCoins.length === 0) return;
    if (Object.keys(offerBalances).length > 0) return;
    setBalancesLoading(true);
    Promise.all(
      offerableCoins.map((c) =>
        marketApi
          .chainBalance(c.chainId, sovereignAddress)
          .then((r) => [c.chainId, Math.floor(Number(r.balance || 0) / 1e6)])
          .catch(() => [c.chainId, 0])
      )
    ).then((pairs) => {
      const map = {};
      pairs.forEach(([id, bal]) => {
        map[id] = bal;
      });
      setOfferBalances(map);
      setBalancesLoading(false);
      const first = offerableCoins.find((c) => (map[c.chainId] || 0) > 0) || offerableCoins[0];
      if (first) setOfferCoinId(first.chainId);
    });
  }, [isSovereign, sovPay, sovereignAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  const offerValueUsd = offerCoin ? numericOfferUnits * (Number(offerCoin.priceUsd) || 0) : 0;
  const swapReceiveUnits =
    offerValueUsd > 0 && asset.price > 0 ? Math.floor(offerValueUsd / asset.price) : 0;

  const usdUnitsPreview =
    numericAmount > 0 && asset.price > 0 ? Math.floor(numericAmount / asset.price) : 0;

  // Buy fee quote: debounced; stale responses are discarded via the counter.
  useEffect(() => {
    if (!isSovereign || sovPay !== "usd" || !(numericAmount > 0) || !asset.chainId) {
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }
    setQuoteLoading(true);
    setQuoteError(null);
    const reqId = ++quoteReqRef.current;
    const t = setTimeout(async () => {
      try {
        const res = await tradeApi.quote(asset.chainId, numericAmount);
        if (quoteReqRef.current !== reqId) return;
        setQuote(res.quote || null);
      } catch (e) {
        if (quoteReqRef.current !== reqId) return;
        setQuote(null);
        setQuoteError(e.message || "Couldn't fetch the fee quote");
      } finally {
        if (quoteReqRef.current === reqId) setQuoteLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [isSovereign, sovPay, numericAmount, asset.chainId]);

  // Swap fee quote: debounced; stale responses are discarded via the counter.
  // Depends on offerCoinId (stable string), not the offerCoin object identity.
  useEffect(() => {
    const oc = offerableCoins.find((c) => c.chainId === offerCoinId) || null;
    if (!isSovereign || sovPay !== "coin" || !oc || !(numericOfferUnits > 0)) {
      setSwapQuote(null);
      setSwapQuoteError(null);
      setSwapQuoteLoading(false);
      return;
    }
    setSwapQuoteLoading(true);
    setSwapQuoteError(null);
    const reqId = ++swapQuoteReqRef.current;
    const t = setTimeout(async () => {
      try {
        const res = await marketApi.swapQuote(asset.chainId, oc.chainId, numericOfferUnits);
        if (swapQuoteReqRef.current !== reqId) return;
        setSwapQuote(res.quote || null);
      } catch (e) {
        if (swapQuoteReqRef.current !== reqId) return;
        setSwapQuote(null);
        setSwapQuoteError(e.message || "Couldn't fetch the fee quote");
      } finally {
        if (swapQuoteReqRef.current === reqId) setSwapQuoteLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSovereign, sovPay, offerCoinId, numericOfferUnits, asset.chainId]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card invest-modal" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <h3>Invest in {asset.name}</h3>
        <p className="section-sub">{asset.tagline}</p>

        <div className="invest-price-row">
          <span className="stat-label">Current share price</span>
          <span className="preview-price-value">${asset.price.toFixed(2)}</span>
        </div>

        <label className="field-label">Pay with</label>
        {isSovereign ? (
          <>
            <div className="platform-pills">
              <button
                className={`pill-btn ${sovPay === "usd" ? "pill-btn-active" : ""}`}
                onClick={() => setSovPay("usd")}
              >
                Trade USD
              </button>
              <button
                className={`pill-btn ${sovPay === "coin" ? "pill-btn-active" : ""}`}
                onClick={() => setSovPay("coin")}
              >
                My coins
              </button>
            </div>

            {sovPay === "usd" ? (
              <>
                <p className="field-hint">
                  Trade USD balance: <strong>${(tradeCashUsd || 0).toFixed(2)}</strong>
                  {" — "}your payment goes straight to the coin issuer.
                </p>
                {(tradeCashUsd || 0) < numericAmount && (
                  <p className="field-hint field-error" style={{ marginTop: 6 }}>
                    Insufficient trade USD balance. Fund your account to invest.
                  </p>
                )}

                <label className="field-label">Amount (in USD)</label>
                <div className="quick-amounts">
                  {QUICK_AMOUNTS.map((q) => (
                    <button
                      key={q}
                      className={`pill-btn ${numericAmount === q ? "pill-btn-active" : ""}`}
                      onClick={() => setAmount(String(q))}
                    >
                      ${q}
                    </button>
                  ))}
                </div>
                <input
                  className="text-input"
                  type="number"
                  placeholder="Or enter a custom amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                {numericAmount > 0 && !quote && !quoteLoading && !quoteError && (
                  <p className="field-hint">
                    You'll receive approximately {usdUnitsPreview} coins.
                  </p>
                )}
                {numericAmount > 0 && quoteLoading && (
                  <p className="field-hint">Fetching fee quote…</p>
                )}
                {numericAmount > 0 && quoteError && (
                  <p className="field-hint field-error" style={{ marginTop: 6 }}>
                    {quoteError} — please try again.
                  </p>
                )}
                {numericAmount > 0 && quote && (
                  <div className="fee-breakdown glass-card">
                    <div className="fee-row">
                      <span>You pay</span>
                      <strong>${Number(quote.grossUsd).toFixed(2)}</strong>
                    </div>
                    <div className="fee-row">
                      <span>Gross</span>
                      <strong>
                        {Number(quote.grossUnits).toLocaleString()} {quote.ticker}
                      </strong>
                    </div>
                    <div className="fee-row">
                      <span>Phase fee ({(quote.feeBps / 100).toFixed(2)}%)</span>
                      <strong>
                        {Number(quote.feeUnits).toLocaleString()} {quote.feeAssetSymbol ?? quote.ticker}
                      </strong>
                    </div>
                    <p className="fee-note">
                      The fee is taken from the coins you receive — the seller
                      gets the full ${Number(quote.grossUsd).toFixed(2)}.
                    </p>
                    <div className="fee-row fee-row-total">
                      <span>You receive</span>
                      <strong>
                        {Number(quote.buyerReceivesUnits).toLocaleString()} {quote.ticker}
                      </strong>
                    </div>
                    <p className="fee-disclosure">
                      Phase charges 0.80% on applicable transactions.
                    </p>
                  </div>
                )}

                <button
                  className={`btn-primary btn-large btn-full ${
                    numericAmount <= 0 || quoteLoading || !!quoteError ? "btn-disabled" : ""
                  }`}
                  disabled={numericAmount <= 0 || quoteLoading || !!quoteError}
                  onClick={() => onInvest(numericAmount, effectivePayId)}
                >
                  {quote ? `Invest $${Number(quote.grossUsd).toFixed(2)}` : "Invest Instantly"}
                </button>
              </>
            ) : offerableCoins.length === 0 ? (
              <div className="glass-card empty-state">
                <h3>No coins to offer yet</h3>
                <p>Issue your own coin from Go Live, then offer it here in exchange.</p>
              </div>
            ) : (
              <>
                <p className="field-hint">
                  Offer units of a coin you issued — the issuer receives your coins,
                  you receive {asset.ticker}.
                </p>
                <label className="field-label">Your coin</label>
                <select
                  className="text-input"
                  value={offerCoinId}
                  onChange={(e) => setOfferCoinId(e.target.value)}
                >
                  {offerableCoins.map((c) => (
                    <option key={c.chainId} value={c.chainId}>
                      {c.ticker} — {c.name}
                      {offerBalances[c.chainId] != null
                        ? ` (${offerBalances[c.chainId].toLocaleString()} avail.)`
                        : ""}
                    </option>
                  ))}
                </select>
                {balancesLoading && <p className="field-hint">Loading your coin balances…</p>}

                <label className="field-label">Offer units</label>
                <div className="offer-units-row">
                  <input
                    className="text-input"
                    type="number"
                    min="1"
                    step="1"
                    placeholder="Whole coins"
                    value={offerUnits}
                    onChange={(e) => setOfferUnits(e.target.value)}
                  />
                  <button
                    className="pill-btn"
                    disabled={!offerCoin || offerBalance <= 0}
                    onClick={() => setOfferUnits(String(offerBalance))}
                  >
                    Max
                  </button>
                </div>
                {offerCoin && numericOfferUnits > 0 && !swapQuote && !swapQuoteLoading && !swapQuoteError && (
                  <p className="field-hint">
                    Offer {numericOfferUnits.toLocaleString()} {offerCoin.ticker} (≈ $
                    {offerValueUsd.toFixed(2)}) → receive ≈ {swapReceiveUnits.toLocaleString()}{" "}
                    {asset.ticker}.
                    {numericOfferUnits > offerBalance &&
                      ` — you only hold ${offerBalance.toLocaleString()}.`}
                  </p>
                )}
                {offerCoin && numericOfferUnits > 0 && swapQuoteLoading && (
                  <p className="field-hint">Fetching fee quote…</p>
                )}
                {offerCoin && numericOfferUnits > 0 && swapQuoteError && (
                  <p className="field-hint field-error">{swapQuoteError} — please try again.</p>
                )}
                {offerCoin && numericOfferUnits > 0 && swapQuote && (
                  <div className="fee-breakdown glass-card">
                    <div className="fee-row">
                      <span>You offer</span>
                      <strong>
                        {Number(swapQuote.offerUnits).toLocaleString()} {swapQuote.offerTicker}
                      </strong>
                    </div>
                    <div className="fee-row">
                      <span>Gross receive</span>
                      <strong>
                        {Number(swapQuote.grossUnits).toLocaleString()} {swapQuote.targetTicker}
                      </strong>
                    </div>
                    <div className="fee-row">
                      <span>Phase fee ({(swapQuote.feeBps / 100).toFixed(2)}%)</span>
                      <strong>
                        {Number(swapQuote.feeUnits).toLocaleString()} {swapQuote.targetTicker}
                      </strong>
                    </div>
                    <div className="fee-row fee-row-total">
                      <span>You receive</span>
                      <strong>
                        {Number(swapQuote.buyerReceivesUnits).toLocaleString()}{" "}
                        {swapQuote.targetTicker}
                      </strong>
                    </div>
                    <p className="fee-disclosure">
                      Phase charges 0.80% on applicable transactions.
                    </p>
                  </div>
                )}

                <button
                  className={`btn-primary btn-large btn-full ${
                    numericOfferUnits < 1 ||
                    numericOfferUnits > offerBalance ||
                    swapReceiveUnits < 1 ||
                    swapQuoteLoading ||
                    !!swapQuoteError
                      ? "btn-disabled"
                      : ""
                  }`}
                  disabled={
                    numericOfferUnits < 1 ||
                    numericOfferUnits > offerBalance ||
                    swapReceiveUnits < 1 ||
                    swapQuoteLoading ||
                    !!swapQuoteError
                  }
                  onClick={() => onInvestSwap(offerCoin, numericOfferUnits)}
                >
                  Offer {offerCoin ? offerCoin.ticker : "coins"}
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <div className="platform-pills">
              <button
                className={`pill-btn ${usePhase ? "pill-btn-active" : ""}`}
                onClick={() => setUsePhase(true)}
              >
                PHASE Coins
              </button>
              <button
                className={`pill-btn ${!usePhase ? "pill-btn-active" : ""}`}
                onClick={() => setUsePhase(false)}
              >
                Other Currency
              </button>
            </div>

            {usePhase ? (
              <p className="field-hint">Available: {phaseCoins.toLocaleString()} PHASE Coins</p>
            ) : (
              <>
                <div style={{ margin: "8px 0 4px" }}>
                  <CurrencyDropdown currency={payCurrency} setCurrency={setPayCurrency} excludeIds={["phase"]} />
                </div>
                <p className="field-hint">
                  Available: {formatCurrency(availableInPayCurrency / (liveFx[payCurrency] || 1), payCurrency, liveFx)}
                  {availableInPayCurrency <= 0 && " — fund your account from the Dashboard to invest with cash"}
                </p>
              </>
            )}

            <label className="field-label">
              Amount {!usePhase && `(in ${payCurrency.toUpperCase()})`}
            </label>
            <div className="quick-amounts">
              {QUICK_AMOUNTS.map((q) => (
                <button
                  key={q}
                  className={`pill-btn ${numericAmount === q ? "pill-btn-active" : ""}`}
                  onClick={() => setAmount(String(q))}
                >
                  ${q}
                </button>
              ))}
            </div>
            <input
              className="text-input"
              type="number"
              placeholder="Or enter a custom amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />

            {numericAmount > 0 && (
              <p className="field-hint">
                You'll receive approximately{" "}
                {(
                  (usePhase ? numericAmount / (liveFx.phase || BASE_FX.phase) : numericAmount / (liveFx[payCurrency] || 1)) /
                  asset.price
                ).toFixed(4)}{" "}
                shares.
              </p>
            )}

            <button
              className={`btn-primary btn-large btn-full ${numericAmount <= 0 ? "btn-disabled" : ""}`}
              disabled={numericAmount <= 0}
              onClick={() => {
                const amountUsd = usePhase
                  ? numericAmount / (liveFx.phase || BASE_FX.phase)
                  : numericAmount / (liveFx[payCurrency] || 1);
                onInvest(amountUsd, effectivePayId);
              }}
            >
              Invest Instantly
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================== ADMIN DASHBOARD ================================ */
// Admin-only: fee config, fee ledger, treasury, withdrawals, reconciliation,
// production checks, admin management. Entry is gated by adminApi.me() in
// AppInner — non-admins never see the button or this modal.

function AdminDashboardModal({ onClose, showToast }) {
  const [tab, setTab] = useState("fees");
  const tabs = [
    ["fees", "Fees"],
    ["ledger", "Fee ledger"],
    ["treasury", "Treasury"],
    ["recon", "Reconciliation"],
    ["system", "System"],
    ["admins", "Admins"],
  ];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card admin-modal" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <h3>Phase Admin</h3>
        <p className="section-sub">Fee engine, treasury, and reconciliation controls.</p>
        <div className="platform-pills admin-tabs">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              className={`pill-btn ${tab === id ? "pill-btn-active" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "fees" && <AdminFeesTab showToast={showToast} />}
        {tab === "ledger" && <AdminLedgerTab showToast={showToast} />}
        {tab === "treasury" && <AdminTreasuryTab showToast={showToast} />}
        {tab === "recon" && <AdminReconTab showToast={showToast} />}
        {tab === "system" && <AdminSystemTab showToast={showToast} />}
        {tab === "admins" && <AdminUsersTab showToast={showToast} />}
      </div>
    </div>
  );
}

function AdminFeesTab({ showToast }) {
  const [config, setConfig] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [bps, setBps] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfg, sum] = await Promise.all([
        adminApi.getFeeConfig(),
        adminApi.getSummary(30).catch(() => null),
      ]);
      setConfig(cfg.config || null);
      setSummary(sum?.summary ?? null);
      if (cfg.config) setBps(String(cfg.config.feeBps));
    } catch (e) {
      setError(e.message || "Couldn't load fee config");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    const n = Number(bps);
    if (!Number.isInteger(n) || n < 0 || n > 10000) {
      showToast("Fee must be a whole number of basis points (0–10000)");
      return;
    }
    setSaving(true);
    try {
      const res = await adminApi.setFeeConfig(n, reason || undefined);
      setConfig(res.config || null);
      showToast(`Fee rate updated to ${(n / 100).toFixed(2)}%`);
      setReason("");
    } catch (e) {
      showToast(e.message || "Couldn't update the fee rate");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="field-hint">Loading fee configuration…</p>;
  if (error) return <p className="field-hint field-error">{error}</p>;
  return (
    <div className="admin-section">
      <h4 className="subsection-title">Current rate</h4>
      <div className="admin-kv">
        <div className="fee-row">
          <span>Rate</span>
          <strong>{config ? `${(config.feeBps / 100).toFixed(2)}% (${config.feeBps} bps)` : "—"}</strong>
        </div>
        <div className="fee-row">
          <span>Version</span>
          <strong>{config?.version ?? "—"}</strong>
        </div>
        <div className="fee-row">
          <span>Effective from</span>
          <strong>{config?.effectiveFrom ? new Date(config.effectiveFrom).toLocaleString() : "—"}</strong>
        </div>
        <div className="fee-row">
          <span>Last changed by</span>
          <strong>{config?.createdBy || "—"}</strong>
        </div>
        {config?.reason && (
          <div className="fee-row">
            <span>Reason</span>
            <strong>{config.reason}</strong>
          </div>
        )}
      </div>
      <h4 className="subsection-title">Change rate</h4>
      <p className="field-hint">
        Appends a new versioned rate — history is preserved and the change is audited. Applies to
        new transactions only.
      </p>
      <div className="admin-form-row">
        <input
          className="text-input"
          type="number"
          min="0"
          max="10000"
          step="1"
          placeholder="Basis points (e.g. 80)"
          value={bps}
          onChange={(e) => setBps(e.target.value)}
        />
        <input
          className="text-input"
          type="text"
          placeholder="Reason (audited)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button className="btn-primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Update rate"}
        </button>
      </div>
      <h4 className="subsection-title">30-day summary</h4>
      {summary ? (
        <AdminSummaryView summary={summary} />
      ) : (
        <p className="field-hint">No summary data yet.</p>
      )}
    </div>
  );
}

// Defensive renderer: the summary shape may evolve; show per-asset rows
// when present, otherwise list top-level entries.
function AdminSummaryView({ summary }) {
  const rows = [];
  const push = (label, value) => rows.push([label, value]);
  if (summary && typeof summary === "object") {
    const byAsset = summary.byAsset || summary.assets || summary.totals;
    if (byAsset && typeof byAsset === "object") {
      for (const [asset, v] of Object.entries(byAsset)) {
        const val =
          v && typeof v === "object"
            ? Object.entries(v)
                .map(([k, x]) => `${k}: ${x}`)
                .join(" · ")
            : String(v);
        push(asset, val);
      }
    } else {
      for (const [k, v] of Object.entries(summary)) {
        if (v != null && typeof v !== "object") push(k, String(v));
      }
    }
  }
  if (rows.length === 0) return <p className="field-hint">No summary data yet.</p>;
  return (
    <div className="admin-kv">
      {rows.map(([k, v]) => (
        <div className="fee-row" key={k}>
          <span>{k}</span>
          <strong>{v}</strong>
        </div>
      ))}
    </div>
  );
}

function AdminLedgerTab({ showToast }) {
  const [fees, setFees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await adminApi.getLedger(50, 0);
        setFees(res.fees || []);
      } catch (e) {
        setError(e.message || "Couldn't load the fee ledger");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <p className="field-hint">Loading fee ledger…</p>;
  if (error) return <p className="field-hint field-error">{error}</p>;
  if (fees.length === 0) return <p className="field-hint">No fee records yet.</p>;
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>Asset</th>
            <th>Gross</th>
            <th>Fee</th>
            <th>Net</th>
            <th>Rate</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {fees.map((f) => (
            <tr key={f.feeId || f.idempotencyKey}>
              <td>{f.createdAt ? new Date(f.createdAt).toLocaleString() : "—"}</td>
              <td>{f.transactionType || "—"}</td>
              <td>{f.assetSymbol || "—"}</td>
              <td>{f.grossQuantity ?? "—"}</td>
              <td>{f.feeQuantity ?? "—"}</td>
              <td>{f.netQuantity ?? "—"}</td>
              <td>{f.feeBps != null ? `${(f.feeBps / 100).toFixed(2)}%` : "—"}</td>
              <td>
                <span className={`status-chip status-${f.status || "unknown"}`}>{f.status || "—"}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminTreasuryTab({ showToast }) {
  const [balances, setBalances] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [assetSymbol, setAssetSymbol] = useState("USD");
  const [amount, setAmount] = useState("");
  const [destinationRef, setDestinationRef] = useState("");
  const [requesting, setRequesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, w] = await Promise.all([
        adminApi.getTreasuryBalances(),
        adminApi.listWithdrawals().catch(() => ({ withdrawals: [] })),
      ]);
      setBalances(b.balances || []);
      setWithdrawals(w.withdrawals || []);
    } catch (e) {
      setError(e.message || "Couldn't load treasury data");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const request = async () => {
    if (!assetSymbol.trim() || !(Number(amount) > 0) || !destinationRef.trim()) {
      showToast("Asset, amount, and destination reference are required");
      return;
    }
    setRequesting(true);
    try {
      await adminApi.requestWithdrawal({
        assetSymbol: assetSymbol.trim(),
        amount: amount.trim(),
        destinationRef: destinationRef.trim(),
        provider: "manual",
      });
      showToast("Withdrawal requested — needs approval");
      setAmount("");
      setDestinationRef("");
      await load();
    } catch (e) {
      showToast(e.message || "Couldn't request the withdrawal");
    } finally {
      setRequesting(false);
    }
  };

  const approve = async (id) => {
    try {
      await adminApi.approveWithdrawal(id);
      showToast("Withdrawal approved");
      await load();
    } catch (e) {
      showToast(e.message || "Couldn't approve the withdrawal");
    }
  };

  const execute = async (id) => {
    const externalRef = window.prompt("External reference (bank/provider reference):", "");
    if (externalRef == null) return;
    try {
      await adminApi.executeWithdrawal(id, externalRef || undefined);
      showToast("Withdrawal executed");
      await load();
    } catch (e) {
      showToast(e.message || "Couldn't execute the withdrawal");
    }
  };

  if (loading) return <p className="field-hint">Loading treasury…</p>;
  if (error) return <p className="field-hint field-error">{error}</p>;
  return (
    <div className="admin-section">
      <h4 className="subsection-title">Balances</h4>
      {balances.length === 0 ? (
        <p className="field-hint">No treasury balances yet.</p>
      ) : (
        <div className="admin-kv">
          {balances.map((b) => (
            <div className="fee-row" key={`${b.accountId}:${b.assetSymbol}`}>
              <span>{b.assetSymbol}</span>
              <strong>{b.balance}</strong>
            </div>
          ))}
        </div>
      )}
      <h4 className="subsection-title">Request withdrawal</h4>
      <p className="field-hint">
        Withdrawals require a second step: approve, then execute with the provider reference.
      </p>
      <div className="admin-form-row">
        <input
          className="text-input"
          type="text"
          placeholder="Asset (e.g. USD)"
          value={assetSymbol}
          onChange={(e) => setAssetSymbol(e.target.value)}
        />
        <input
          className="text-input"
          type="text"
          inputMode="decimal"
          placeholder="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <input
          className="text-input"
          type="text"
          placeholder="Destination reference"
          value={destinationRef}
          onChange={(e) => setDestinationRef(e.target.value)}
        />
        <button className="btn-primary" disabled={requesting} onClick={request}>
          {requesting ? "Requesting…" : "Request"}
        </button>
      </div>
      <h4 className="subsection-title">Withdrawals</h4>
      {withdrawals.length === 0 ? (
        <p className="field-hint">No withdrawals yet.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Amount</th>
                <th>Destination</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {withdrawals.map((w) => (
                <tr key={w.id}>
                  <td>{w.assetSymbol}</td>
                  <td>{w.amount}</td>
                  <td className="admin-wrap">{w.destinationRef}</td>
                  <td>
                    <span className={`status-chip status-${w.status}`}>{w.status}</span>
                  </td>
                  <td>
                    {w.status === "requested" && (
                      <button className="btn-secondary btn-small" onClick={() => approve(w.id)}>
                        Approve
                      </button>
                    )}
                    {w.status === "approved" && (
                      <button className="btn-secondary btn-small" onClick={() => execute(w.id)}>
                        Execute
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AdminReconTab({ showToast }) {
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const loadLatest = useCallback(async () => {
    try {
      const res = await adminApi.latestReconciliation();
      setRun(res.run || null);
    } catch (e) {
      setError(e.message || "Couldn't load reconciliation status");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    loadLatest();
  }, [loadLatest]);

  const runNow = async () => {
    setRunning(true);
    try {
      const res = await adminApi.runReconciliation();
      setRun(res.result || null);
      if (res.result && !res.result.invariantOk) {
        showToast("Reconciliation found mismatches — review before any withdrawals");
      } else {
        showToast("Reconciliation complete — all invariants hold");
      }
    } catch (e) {
      showToast(e.message || "Couldn't run reconciliation");
    } finally {
      setRunning(false);
    }
  };

  if (loading) return <p className="field-hint">Loading reconciliation status…</p>;
  if (error) return <p className="field-hint field-error">{error}</p>;
  const assets = run?.assets || run?.totals?.assets || [];
  return (
    <div className="admin-section">
      <button className="btn-primary" disabled={running} onClick={runNow}>
        {running ? "Running…" : "Run reconciliation now"}
      </button>
      {run ? (
        <>
          <div className={`recon-banner ${run.invariantOk ? "recon-ok" : "recon-bad"}`}>
            {run.invariantOk
              ? "All invariants hold."
              : "MISMATCH — discrepancies recorded, never auto-repaired. Investigate before any withdrawals."}
          </div>
          <p className="field-hint">
            Run {run.runId != null ? `#${run.runId}` : ""} ·{" "}
            {run.ranAt ? new Date(run.ranAt).toLocaleString() : "—"}
          </p>
          {assets.length > 0 && (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Collected</th>
                    <th>Withdrawn</th>
                    <th>Treasury</th>
                    <th>Difference</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((a) => (
                    <tr key={a.assetSymbol}>
                      <td>{a.assetSymbol}</td>
                      <td>{a.collected}</td>
                      <td>{a.withdrawn}</td>
                      <td>{a.treasuryBalance}</td>
                      <td>{a.difference}</td>
                      <td>
                        <span className={`status-chip ${a.ok ? "status-settled" : "status-bad"}`}>
                          {a.ok ? "ok" : "mismatch"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <p className="field-hint">No reconciliation runs yet.</p>
      )}
    </div>
  );
}

function AdminSystemTab({ showToast }) {
  const [checks, setChecks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await adminApi.systemChecks();
        setChecks(res.checks || []);
      } catch (e) {
        setError(e.message || "Couldn't load production checks");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <p className="field-hint">Loading production checks…</p>;
  if (error) return <p className="field-hint field-error">{error}</p>;
  if (checks.length === 0) return <p className="field-hint">No checks reported.</p>;
  return (
    <div className="admin-section">
      {checks.map((c) => (
        <div className="fee-row" key={c.check}>
          <span>
            <span className={`check-dot ${c.ok ? "check-ok" : c.critical ? "check-critical" : "check-warn"}`} />
            {c.check}
            <span className="field-hint"> — {c.message}</span>
          </span>
          <strong>{c.ok ? "ok" : c.critical ? "CRITICAL" : "warn"}</strong>
        </div>
      ))}
    </div>
  );
}

function AdminUsersTab({ showToast }) {
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [userId, setUserId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.listAdmins();
      setAdmins(res.admins || []);
    } catch (e) {
      setError(e.message || "Couldn't load admins");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const grant = async () => {
    if (!userId.trim()) {
      showToast("Enter a user id");
      return;
    }
    try {
      await adminApi.grantAdmin(userId.trim());
      showToast("Admin granted");
      setUserId("");
      await load();
    } catch (e) {
      showToast(e.message || "Couldn't grant admin");
    }
  };
  const revoke = async (id) => {
    try {
      await adminApi.revokeAdmin(id);
      showToast("Admin revoked");
      await load();
    } catch (e) {
      showToast(e.message || "Couldn't revoke admin");
    }
  };

  if (loading) return <p className="field-hint">Loading admins…</p>;
  if (error) return <p className="field-hint field-error">{error}</p>;
  return (
    <div className="admin-section">
      <h4 className="subsection-title">Administrators</h4>
      {admins.length === 0 ? (
        <p className="field-hint">No flagged admins.</p>
      ) : (
        <div className="admin-kv">
          {admins.map((a) => (
            <div className="fee-row" key={a.userId}>
              <span>
                {a.name || a.email || a.userId}
                {a.email && a.name ? ` (${a.email})` : ""}
              </span>
              <button className="btn-secondary btn-small" onClick={() => revoke(a.userId)}>
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
      <h4 className="subsection-title">Grant admin</h4>
      <div className="admin-form-row">
        <input
          className="text-input"
          type="text"
          placeholder="User id"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
        <button className="btn-primary" onClick={grant}>
          Grant
        </button>
      </div>
    </div>
  );
}

/* ============================== DASHBOARD TAB ================================ */

function DashboardTab({
  assets,
  holdings,
  currency,
  setCurrency,
  phaseCoins,
  cashBalances,
  tradeCashUsd,
  coinSalesUsd,
  onFund,
  txHistory,
  onExplore,
  liveFx,
  netWorthHistory,
  netWorthUsd,
  isAdmin,
  onOpenAdmin,
}) {
  const [showFundModal, setShowFundModal] = useState(false);

  const enrichedHoldings = holdings
    .map((h) => {
      const asset = assets.find((a) => a.id === h.assetId);
      if (!asset) return null;
      const currentValueUsd = h.units * asset.price;
      const changeUsd = currentValueUsd - h.costBasisUsd;
      const changePct = h.costBasisUsd > 0 ? (changeUsd / h.costBasisUsd) * 100 : 0;
      return { ...h, asset, currentValueUsd, changeUsd, changePct };
    })
    .filter(Boolean);

  const totalInvestmentsUsd = enrichedHoldings.reduce((sum, h) => sum + h.currentValueUsd, 0);

  // Investments grouped by major asset category, for the breakdown list and donut.
  const investmentsByCategory = Object.keys(ASSET_CATEGORIES)
    .map((key) => {
      const valueUsd = enrichedHoldings
        .filter((h) => h.asset.category === key)
        .reduce((sum, h) => sum + h.currentValueUsd, 0);
      return { key, label: ASSET_CATEGORIES[key].label, valueUsd };
    })
    .filter((c) => c.valueUsd > 0);

  // The user's own published listings ("My Onchained Products").
  const ownedProducts = assets.filter((a) => a.isOwner);
  const ownedProductsMarketUsd = ownedProducts.reduce((sum, a) => sum + a.price * (a.totalMinted || 100), 0);
  const ownedProductsRetainedUsd = ownedProducts.reduce(
    (sum, a) => sum + a.price * (a.retainedShares != null ? a.retainedShares : a.equityRetained),
    0
  );

  // Pure currency: PHASE coins + every funded cash balance, expressed in USD.
  const cashEntries = Object.entries(cashBalances).filter(([, amt]) => amt > 0);
  const cashTotalUsd = cashEntries.reduce((sum, [id, amt]) => {
    const rate = liveFx[id] != null ? liveFx[id] : BASE_FX[id] || 1;
    return sum + amt / rate;
  }, 0);
  const phaseRate = liveFx.phase != null ? liveFx.phase : BASE_FX.phase;
  const phaseCoinsUsd = phaseCoins / phaseRate; // PHASE is valued at 10% of USD (rate = 10)
  const totalCurrencyUsd = cashTotalUsd + phaseCoinsUsd;

  const donutSegments = [
    { label: "My Investments", value: totalInvestmentsUsd, color: "#0ea5e9" },
    { label: "My Onchained Products", value: ownedProductsRetainedUsd, color: "#8b5cf6" },
    { label: "Cash & Currency", value: totalCurrencyUsd, color: "#14b8a6" },
  ];

  // Compliance summary across the user's own published listings.
  const compliantCount = ownedProducts.filter((a) => a.compliance && a.compliance.consented).length;
  const verifiedCount = ownedProducts.filter((a) => a.verification && a.verification.status === "verified").length;

  return (
    <div className="dashboard-wrap">
      <section className="glass-card net-worth-card">
        <div className="market-header">
          <h2 className="section-title">My Dashboard</h2>
          <div className="dash-header-actions">
            {isAdmin && (
              <button className="btn-secondary btn-small" onClick={onOpenAdmin}>
                Admin
              </button>
            )}
            <CurrencyDropdown currency={currency} setCurrency={setCurrency} />
          </div>
        </div>
        <span className="stat-label">Total Net Worth</span>
        <span className="net-worth-value">{formatCurrency(netWorthUsd, currency, liveFx)}</span>
        <p className="net-worth-disclaimer">On-chained value doesn't necessarily reflect the market.</p>

        <div className="net-worth-charts-row">
          <AllocationDonut
            segments={donutSegments}
            centerLabel="Net Worth"
            centerValue={formatCurrency(netWorthUsd, currency, liveFx)}
          />
          <div className="net-worth-trend-block">
            <span className="stat-label">Trend</span>
            <NetWorthTrendChart history={netWorthHistory} currency={currency} liveFx={liveFx} />
          </div>
        </div>

        <DonutLegend segments={donutSegments} />
      </section>

      {phaseCoins > 0 && holdings.length === 0 && (
        <div className="banner-flash glass-card">
          <Icon name="coin" size={18} />
          <span>You have uninvested network equity! Go to the Live Directory to back a project.</span>
          <button className="btn-secondary" onClick={onExplore}>
            Explore Active Profiles
          </button>
        </div>
      )}

      {/* ---------------- My Investments ---------------- */}
      <section className="glass-card holdings-card">
        <div className="dash-section-header">
          <h3 className="subsection-title">My Investments</h3>
          <span className="stat-value">{formatCurrency(totalInvestmentsUsd, currency, liveFx)}</span>
        </div>

        {enrichedHoldings.length === 0 ? (
          <div className="empty-state">
            <Icon name="wallet" size={28} />
            <p>You are not currently holding any live equity on the network.</p>
            <button className="btn-secondary" onClick={onExplore}>
              Explore Active Profiles
            </button>
          </div>
        ) : (
          <>
            {investmentsByCategory.length > 1 && (
              <div className="category-breakdown-row">
                {investmentsByCategory.map((c) => (
                  <div className="category-breakdown-chip" key={c.key}>
                    <Icon name={ASSET_CATEGORIES[c.key].icon} size={13} />
                    <span>{c.label}</span>
                    <span className="category-breakdown-value">
                      {formatCurrency(c.valueUsd, currency, liveFx)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="holdings-table">
              <div className="holdings-row holdings-head">
                <span>Asset</span>
                <span>Price</span>
                <span>24h</span>
                <span>My Stake</span>
                <span>Value</span>
                <span>Trend</span>
              </div>
              {enrichedHoldings.map((h) => {
                const changePct =
                  ((h.asset.price - h.asset.prevPrice) / h.asset.prevPrice) * 100;
                const positive = changePct >= 0;
                return (
                  <div className="holdings-row" key={h.assetId}>
                    <div className="holdings-name-cell">
                      <span className="holdings-name">
                        {h.asset.name}
                        {h.asset.ticker && <span className="ticker-tag">{h.asset.ticker}</span>}
                      </span>
                      <span className="holdings-category-tag">{ASSET_CATEGORIES[h.asset.category].label}</span>
                    </div>
                    <span>{formatCurrency(h.asset.price, currency, liveFx)}</span>
                    <span className={positive ? "price-up" : "price-down"}>
                      {positive ? "+" : ""}
                      {changePct.toFixed(2)}%
                    </span>
                    <span>{h.units.toFixed(3)} sh</span>
                    <span>{formatCurrency(h.currentValueUsd, currency, liveFx)}</span>
                    <Sparkline points={h.asset.history} width={72} height={26} positive={positive} />
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      {/* ---------------- My Onchained Products ---------------- */}
      <section className="glass-card products-card">
        <div className="dash-section-header">
          <h3 className="subsection-title">My Onchained Products</h3>
          <span className="stat-value">{formatCurrency(ownedProductsRetainedUsd, currency, liveFx)}</span>
        </div>

        {ownedProducts.length === 0 ? (
          <div className="empty-state">
            <Icon name="soft" size={28} />
            <p>You haven't issued a chain yet.</p>
          </div>
        ) : (
          <div className="products-list">
            {ownedProducts.map((a) => (
              <div className="product-row" key={a.id}>
                <div className="product-row-icon">
                  <Icon name={ASSET_CATEGORIES[a.category].icon} size={16} />
                </div>
                <div className="product-row-main">
                  <span className="holdings-name">
                    {a.name}
                    {a.ticker && <span className="ticker-tag">{a.ticker}</span>}
                  </span>
                  <span className="holdings-category-tag">
                    {ASSET_CATEGORIES[a.category].label}
                    {a.subsection ? ` · ${a.subsection}` : ""}
                  </span>
                  {a.chainId && <span className="chain-id-stamp">{a.chainId}</span>}
                </div>
                <div className="product-row-stat">
                  <span className="stat-label">Market Value</span>
                  <span className="stat-value">
                    {formatCurrency(a.price * (a.totalMinted || 100), currency, liveFx)}
                  </span>
                </div>
                <div className="product-row-stat">
                  <span className="stat-label">Your Stake ({a.equityRetained}%)</span>
                  <span className="stat-value">
                    {formatCurrency(a.price * (a.retainedShares != null ? a.retainedShares : a.equityRetained), currency, liveFx)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---------------- Currency & Cash ---------------- */}
      <section className="glass-card cash-card">
        <div className="dash-section-header">
          <h3 className="subsection-title">Currency &amp; Cash</h3>
          <button className="btn-primary fund-btn" onClick={() => setShowFundModal(true)}>
            <Icon name="wallet" size={15} /> Fund Account
          </button>
        </div>

        <div className="cash-balance-row">
          <div className="cash-balance-chip">
            <Icon name="coin" size={15} />
            <span>PHASE Coins</span>
            <span className="cash-balance-value">{phaseCoins.toLocaleString()}</span>
          </div>
          {(tradeCashUsd > 0 || coinSalesUsd > 0) && (
            <>
              <div className="cash-balance-chip">
                <span className="cash-balance-currency">TRADE USD</span>
                <span className="cash-balance-value">${tradeCashUsd.toFixed(2)}</span>
              </div>
              <div className="cash-balance-chip">
                <span className="cash-balance-currency">COIN SALES</span>
                <span className="cash-balance-value">${coinSalesUsd.toFixed(2)}</span>
              </div>
            </>
          )}
          {cashEntries.length === 0 ? (
            <p className="field-hint">Nothing funded yet. Use Fund Account to add USDC or USDT from your wallet.</p>
          ) : (
            cashEntries.map(([id, amt]) => {
              const meta = CURRENCIES.find((c) => c.id === id);
              return (
                <div className="cash-balance-chip" key={id}>
                  <span className="cash-balance-currency">{meta ? meta.short : id.toUpperCase()}</span>
                  <span className="cash-balance-value">
                    {formatCurrency(amt / (liveFx[id] || BASE_FX[id] || 1), id, liveFx)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* ---------------- Documentation & Compliance ---------------- */}
      <section className="glass-card compliance-summary-card">
        <h3 className="subsection-title">Documentation &amp; Compliance</h3>
        {ownedProducts.length === 0 ? (
          <p className="field-hint">
            Once you issue a chain, its verification status and documentation will appear here.
          </p>
        ) : (
          <>
            <div className="compliance-summary-row">
              <div className="compliance-summary-stat">
                <span className="stat-label">Documentation on File</span>
                <span className="stat-value">{compliantCount} / {ownedProducts.length} chains</span>
              </div>
              <div className="compliance-summary-stat">
                <span className="stat-label">Social Verified</span>
                <span className="stat-value">{verifiedCount} / {ownedProducts.length} chains</span>
              </div>
            </div>
            <div className="compliance-doc-list">
              {ownedProducts.map((a) => {
                const sig = a.compliance && a.compliance.signature;
                return (
                  <div className="compliance-doc-entry" key={a.id}>
                    <div className="compliance-doc-row">
                      <span className="compliance-doc-name">{a.name}</span>
                      <span className={`badge ${a.compliance && a.compliance.consented ? "badge-compliant" : "badge-pending"}`}>
                        <Icon name={a.compliance && a.compliance.consented ? "check" : "close"} size={11} />
                        {a.compliance && a.compliance.consented ? "On File" : "Missing"}
                      </span>
                      <span className={`badge ${a.verification && a.verification.status === "verified" ? "badge-verified" : "badge-pending"}`}>
                        <Icon name={a.verification && a.verification.status === "verified" ? "check" : "close"} size={11} />
                        {a.verification && a.verification.status === "verified" ? "Verified" : "Unverified"}
                      </span>
                    </div>
                    {sig && sig.signatureId && (
                      <div className="compliance-signed-doc">
                        <span className="compliance-signed-meta">
                          Phase Coin Minting Agreement — signed by {sig.legalName}
                          {sig.signedAt ? ` on ${new Date(sig.signedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}` : ""}
                          {sig.issuerCategory === "entity" ? " (Entity)" : " (Individual)"}
                        </span>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          onClick={() => window.open(legalApi.signedAgreementUrl(sig.signatureId), "_blank", "noopener")}
                        >
                          View signed agreement
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      {txHistory.length > 0 && (
        <section className="glass-card history-card">
          <h3 className="subsection-title">Recent Activity</h3>
          <div className="tx-list">
            {txHistory.slice(0, 8).map((tx) => (
              <div className="tx-row" key={tx.id}>
                <span>
                  {tx.type === "fund"
                    ? "Funded account"
                    : tx.kind === "swap"
                      ? "Swapped"
                      : "Invested in"}{" "}
                  <strong>{tx.assetName}</strong>
                </span>
                <span className="tx-amount-col">
                  <span className="stat-label">
                    {formatCurrency(tx.amountUsd, tx.currency, liveFx)}
                  </span>
                  {tx.feeBps != null && tx.feeAmount != null && (
                    <span className="tx-fee-line">
                      {tx.kind === "swap"
                        ? `Fee ${(tx.feeBps / 100).toFixed(2)}% · ${Number(tx.feeAmount).toLocaleString()} ${tx.feeTicker || ""} · you received ${Number(tx.netAmount || 0).toLocaleString()} ${tx.feeTicker || ""}`
                        : `Fee ${(tx.feeBps / 100).toFixed(2)}% · ${Number(tx.feeAmount).toLocaleString()} ${tx.feeAssetSymbol || ""} · you received ${Number(tx.netAmount || 0).toLocaleString()} ${tx.feeAssetSymbol || ""}`}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="glass-card footnotes-card">
        <a className="footnote-link" href="#" onClick={(e) => e.preventDefault()}>
          Phase Community on Discord
        </a>
        <a className="footnote-link" href="#" onClick={(e) => e.preventDefault()}>
          Developer Documentation
        </a>
      </section>

      {showFundModal && (
        <FundAccountModal onClose={() => setShowFundModal(false)} onFund={onFund} />
      )}
    </div>
  );
}

/* ================================ CHATBOT ==================================== */

function ChatbotLauncher({ open, setOpen, onNavigate }) {
  const [history, setHistory] = useState([
    { from: "phi", text: PHI_GREETING, suggestions: PHI_SUGGESTIONS },
  ]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [history, thinking, open]);

  const send = async (text) => {
    const clean = text.trim();
    if (!clean || thinking) return;
    const withUser = [...history, { from: "user", text: clean }];
    setHistory(withUser);
    setInput("");
    setThinking(true);
    try {
      const reply = await queryPhiBrain(withUser);
      setHistory((h) => [...h, { from: "phi", ...reply }]);
    } finally {
      setThinking(false);
    }
  };

  const tapAction = (tab) => {
    onNavigate(tab);
    setOpen(false);
  };

  const lastPhi = [...history].reverse().find((m) => m.from === "phi" && m.suggestions);

  return (
    <>
      <button
        className={`chat-launcher ${open ? "chat-launcher-open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label="Open Phi assistant"
      >
        {open ? <Icon name="close" size={20} /> : <PhiMark size={28} animated />}
      </button>

      {open && (
        <div className="chat-panel glass-card">
          <div className="chat-panel-header">
            <PhiMark size={22} animated={false} />
            <span>Phi \u2014 your guide</span>
          </div>
          <div className="chat-panel-body" ref={bodyRef}>
            {history.map((msg, i) => (
              <div key={i} className="chat-msg-wrap">
                <div className={`chat-bubble ${msg.from === "user" ? "chat-bubble-user" : "chat-bubble-phi"}`}>
                  {msg.text}
                </div>
                {msg.actions && (
                  <div className="chat-actions">
                    {msg.actions.map((a, j) => (
                      <button key={j} className="chat-action-btn" onClick={() => tapAction(a.tab)}>
                        {a.label} \u2192
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {thinking && (
              <div className="chat-bubble chat-bubble-phi chat-thinking">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            )}
          </div>
          {lastPhi && !thinking && (
            <div className="chat-suggestions">
              {lastPhi.suggestions.map((s, i) => (
                <button key={i} className="chat-suggestion-chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
          <form
            className="chat-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <input
              className="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Phi anything..."
              maxLength={300}
            />
            <button
              type="submit"
              className="chat-send-btn"
              disabled={!input.trim() || thinking}
              aria-label="Send"
            >
              <Icon name="arrowRight" size={16} />
            </button>
          </form>
        </div>
      )}
    </>
  );
}

/* ================================ STYLES ====================================== */

function GlobalStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

      :root {
        --sky-50: #f0f9ff;
        --sky-500: #0ea5e9;
        --violet: #8b5cf6;
        --navy: #0c4a6e;
        --emerald: #22c55e;
        --coral: #ef4444;
        --teal: #14b8a6;
      }

      * { box-sizing: border-box; }
      html, body, #root { margin: 0; padding: 0; }

      .app-root {
        position: relative;
        min-height: 100vh;
        font-family: 'Outfit', sans-serif;
        color: var(--navy);
        background: var(--sky-50);
        overflow-x: hidden;
        padding-bottom: 64px;
      }

      /* ---------------- Background ---------------- */
      .bg-grid {
        position: fixed;
        inset: 0;
        z-index: 0;
        overflow: hidden;
        pointer-events: none;
      }
      .bg-grid-inner {
        position: absolute;
        inset: -10%;
        background-image:
          linear-gradient(rgba(14,165,233,0.07) 1px, transparent 1px),
          linear-gradient(90deg, rgba(14,165,233,0.07) 1px, transparent 1px);
        background-size: 42px 42px;
        animation: gridBreathe 12s ease-in-out infinite;
      }
      @keyframes gridBreathe {
        0%, 100% { opacity: 0.6; transform: scale(1); }
        50% { opacity: 1; transform: scale(1.02); }
      }
      .bg-glow {
        position: absolute;
        border-radius: 50%;
        filter: blur(80px);
        opacity: 0.35;
      }
      .bg-glow-1 {
        width: 420px; height: 420px;
        background: var(--sky-500);
        top: -120px; left: -100px;
      }
      .bg-glow-2 {
        width: 380px; height: 380px;
        background: var(--violet);
        bottom: -140px; right: -100px;
        opacity: 0.22;
      }

      /* ---------------- Reduced motion ---------------- */
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
      }

      /* ---------------- Phi mark ---------------- */
      .phi-mark-btn:focus-visible { outline: 2px solid var(--sky-500); border-radius: 8px; }

      /* ------------------------- Auth ------------------------- */
      .auth-wrap { display: flex; justify-content: center; padding: 24px 16px; }
      .auth-card { width: 100%; max-width: 420px; padding: 28px 24px; }
      .auth-form { display: flex; flex-direction: column; gap: 14px; margin-top: 18px; }
      .auth-form .field { display: flex; flex-direction: column; gap: 6px; }
      .auth-form .field-label { font-size: 13px; font-weight: 600; color: var(--navy); }
      .auth-form input { padding: 12px 14px; border: 1px solid #bae6fd; border-radius: 10px; font-size: 16px; font-family: inherit; background: #fff; color: var(--navy); }
      .auth-form input:focus { outline: 2px solid var(--sky-500); border-color: var(--sky-500); }
      .auth-error { color: var(--coral); font-size: 14px; margin: 0; }
      .auth-submit { margin-top: 6px; width: 100%; }
      .auth-switch { margin-top: 16px; width: 100%; text-align: center; }
      .nav-logout { font-size: 14px; padding: 8px 12px; }
      .phi-mark { transition: filter 0.25s ease; }
      .phi-mark-btn:hover .phi-mark {
        filter: drop-shadow(0 0 8px rgba(14,165,233,0.6));
      }
      .phi-mark-animated .phi-ring {
        animation: phiBreathe 4s ease-in-out infinite;
        transform-origin: center;
      }
      .phi-mark-animated .phi-stroke {
        stroke-dasharray: 60;
        animation: phiFlow 2.6s linear infinite;
      }
      @keyframes phiBreathe {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.045); }
      }
      @keyframes phiFlow {
        0% { stroke-dashoffset: 60; }
        100% { stroke-dashoffset: 0; }
      }

      /* ---------------- Splash ---------------- */
      .splash-overlay {
        position: fixed; inset: 0; z-index: 200;
        display: flex; align-items: center; justify-content: center;
        background: linear-gradient(160deg, #eef4fb 0%, #e6f0fa 55%, #efe9fb 100%);
        animation: splashOut 0.45s ease 0.95s forwards;
        pointer-events: none;
      }
      .splash-mark { display: flex; flex-direction: column; align-items: center; gap: 14px; animation: splashIn 0.5s ease both; }
      .splash-word { font-size: 30px; font-weight: 700; color: var(--navy); letter-spacing: 0.5px; }
      @keyframes splashIn { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
      @keyframes splashOut { to { opacity: 0; visibility: hidden; } }

      /* ---------------- Top nav ---------------- */
      .top-nav {
        position: sticky;
        top: 0;
        z-index: 30;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 12px 20px;
        background: rgba(255,255,255,0.65);
        backdrop-filter: blur(20px);
        border-bottom: 1px solid rgba(14,165,233,0.16);
      }
      /* On Android the WebView draws edge-to-edge under the status bar and
         system nav buttons — push the chrome clear of them. env() covers
         devices that report insets; the fallback covers those that don't. */
      .platform-android .top-nav { padding-top: calc(12px + env(safe-area-inset-top, 26px)); }
      .platform-android .bottom-bar {
        padding-top: 13px;
        padding-bottom: calc(13px + env(safe-area-inset-bottom, 20px));
      }
      .platform-android .toast { bottom: calc(76px + env(safe-area-inset-bottom, 20px)); }
      .platform-android.app-root { padding-bottom: calc(64px + env(safe-area-inset-bottom, 20px)); }
      .top-nav-left { display: flex; align-items: center; gap: 8px; }
      .brand-word { font-weight: 700; font-size: 18px; letter-spacing: -0.02em; color: var(--navy); }
      .top-nav-tabs { display: flex; gap: 4px; background: rgba(14,165,233,0.07); border-radius: 14px; padding: 4px; }
      .nav-tab {
        border: none; background: transparent; padding: 8px 14px; border-radius: 10px;
        font-family: 'Outfit'; font-weight: 600; font-size: 13.5px; color: var(--navy);
        opacity: 0.55; cursor: pointer; transition: all 0.2s ease;
      }
      .nav-tab:hover { opacity: 0.85; }
      .nav-tab-active { background: white; opacity: 1; box-shadow: 0 2px 10px rgba(14,165,233,0.18); }
      .top-nav-right { display: flex; align-items: center; }

      @media (max-width: 760px) {
        .top-nav { flex-wrap: wrap; }
        .top-nav-tabs { order: 3; width: 100%; justify-content: space-between; }
        .nav-tab { flex: 1; text-align: center; padding: 8px 6px; font-size: 12.5px; }
      }

      /* ---------------- Main layout ---------------- */
      .app-main {
        position: relative;
        z-index: 1;
        max-width: 1080px;
        margin: 0 auto;
        padding: 28px 20px 40px;
      }

      .glass-card {
        background: rgba(255,255,255,0.75);
        backdrop-filter: blur(24px);
        border: 1px solid rgba(14,165,233,0.18);
        border-radius: 20px;
        padding: 22px;
        box-shadow: 0 4px 24px rgba(14,165,233,0.08);
      }

      .section-title { font-size: 21px; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; }
      .section-sub { font-size: 13.5px; opacity: 0.65; margin: 0 0 16px; }
      .subsection-title { font-size: 15px; font-weight: 700; margin: 0 0 14px; }

      .field-label { display: block; font-size: 12.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.55; margin: 16px 0 8px; }
      .field-hint { font-size: 12px; opacity: 0.55; margin: 6px 0 0; }

      .text-input {
        width: 100%;
        font-family: 'Outfit';
        font-size: 14px;
        padding: 11px 14px;
        border-radius: 12px;
        border: 1px solid rgba(14,165,233,0.22);
        background: rgba(255,255,255,0.8);
        color: var(--navy);
        outline: none;
        transition: border-color 0.2s ease, box-shadow 0.2s ease;
      }
      .text-input:focus { border-color: var(--sky-500); box-shadow: 0 0 0 3px rgba(14,165,233,0.14); }
      .textarea { resize: vertical; font-family: 'Outfit'; }
      .small-input { width: 100%; }

      .stat-label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.5; font-weight: 600; }
      .stat-value { display: block; font-family: 'IBM Plex Mono'; font-size: 14px; font-weight: 500; margin-top: 2px; }

      /* ---------------- Buttons ---------------- */
      .btn-primary {
        background: linear-gradient(135deg, var(--sky-500), var(--violet));
        color: white; border: none; border-radius: 14px;
        font-family: 'Outfit'; font-weight: 700; font-size: 14px;
        padding: 12px 20px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; justify-content: center;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }
      .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(14,165,233,0.3); }
      .btn-large { padding: 14px 22px; font-size: 15px; margin-top: 18px; }
      .btn-full { width: 100%; }
      .btn-disabled { opacity: 0.4; cursor: not-allowed; transform: none !important; box-shadow: none !important; }
      .btn-pulse:not(.btn-disabled) { animation: btnPulse 2.4s ease-in-out infinite; }
      @keyframes btnPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(14,165,233,0.35); }
        50% { box-shadow: 0 0 0 10px rgba(14,165,233,0); }
      }

      .btn-secondary {
        background: rgba(14,165,233,0.1);
        color: var(--sky-500); border: 1px solid rgba(14,165,233,0.3);
        border-radius: 12px; font-family: 'Outfit'; font-weight: 600; font-size: 13px;
        padding: 9px 16px; cursor: pointer; transition: background 0.2s ease;
      }
      .btn-secondary:hover { background: rgba(14,165,233,0.18); }

      .btn-danger {
        background: linear-gradient(135deg, #dc2626, #991b1b);
        color: white; border: none; border-radius: 14px;
        font-family: 'Outfit'; font-weight: 700; font-size: 14px;
        padding: 12px 20px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; justify-content: center;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }
      .btn-danger:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(220,38,38,0.3); }
      .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
      .danger-title { color: #dc2626; }
      .danger-zone-label {
        font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
        color: #dc2626; opacity: 0.8; margin: 0 0 8px;
      }
      .account-danger-zone {
        margin: 20px 0; padding: 16px; border: 1px solid rgba(220,38,38,0.35);
        border-radius: 12px; background: rgba(220,38,38,0.06);
      }
      .account-info { margin: 4px 0 12px; }
      .account-name { font-weight: 700; font-size: 16px; margin: 0; }
      .account-email { opacity: 0.7; font-size: 14px; margin: 4px 0 0; }
      .account-row {
        display: block; width: 100%; text-align: left;
        padding: 10px 0; font-size: 15px;
      }
      .auth-notice {
        background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.35);
        color: #16a34a; border-radius: 10px; padding: 10px 14px;
        font-size: 14px; margin: 0 0 12px;
      }
      .auth-legal { font-size: 12px; opacity: 0.7; text-align: center; margin: 12px 0 0; }
      .auth-legal .link-btn { font-size: 12px; padding: 0; }
      .nav-account { margin-right: 4px; }

      .icon-btn {
        background: transparent; border: none; cursor: pointer; color: var(--navy);
        opacity: 0.6; padding: 4px; display: inline-flex; border-radius: 8px;
      }
      .icon-btn:hover { opacity: 1; background: rgba(14,165,233,0.08); }

      /* ---------------- Category / pills ---------------- */
      .category-toggle { display: flex; gap: 8px; flex-wrap: wrap; }
      .cat-btn {
        display: flex; align-items: center; gap: 6px;
        border: 1px solid rgba(14,165,233,0.22); background: rgba(255,255,255,0.6);
        border-radius: 12px; padding: 9px 14px; font-family: 'Outfit'; font-weight: 600; font-size: 13px;
        color: var(--navy); cursor: pointer; transition: all 0.2s ease;
      }
      .cat-btn-active { background: var(--sky-500); color: white; border-color: var(--sky-500); }

      .pill-btn {
        border: 1px solid rgba(14,165,233,0.22); background: rgba(255,255,255,0.6);
        border-radius: 18px; padding: 7px 14px; font-family: 'Outfit'; font-weight: 600; font-size: 12.5px;
        color: var(--navy); cursor: pointer; transition: all 0.2s ease; white-space: nowrap;
      }
      .pill-btn-active { background: var(--violet); color: white; border-color: var(--violet); }
      .filter-pills { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
      .platform-pills { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }

      /* ---------------- Issuer directory (marketplace top search) ---------------- */
      .dir-section { margin-bottom: 22px; }
      .dir-search-row { display: flex; gap: 8px; margin-bottom: 10px; }
      .dir-search-wrap {
        flex: 1; display: flex; align-items: center; gap: 8px;
        background: rgba(255,255,255,0.75); border: 1px solid rgba(14,165,233,0.22);
        border-radius: 14px; padding: 0 12px; color: var(--navy);
      }
      .dir-search {
        flex: 1; border: none; outline: none; background: transparent;
        font-family: 'Outfit'; font-size: 14px; color: var(--navy); padding: 11px 0;
      }
      .dir-search::placeholder { color: rgba(30,58,95,0.45); }
      .dir-refresh { flex-shrink: 0; }
      .dir-pills { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
      .dir-compare-btn { border-style: dashed; }
      .dir-loading { padding: 18px; text-align: center; }
      .dir-coin-list { display: flex; flex-direction: column; gap: 10px; }
      .dir-coin-card { padding: 12px 14px; }
      .dir-coin-main {
        width: 100%; display: flex; align-items: center; gap: 10px;
        background: none; border: none; padding: 0; cursor: pointer; text-align: left;
        font-family: 'Outfit'; color: var(--navy);
      }
      .online-dot {
        width: 9px; height: 9px; border-radius: 50%; background: #22c55e; flex-shrink: 0;
        box-shadow: 0 0 0 3px rgba(34,197,94,0.18); animation: pulseDot 2s infinite;
      }
      @keyframes pulseDot {
        0%, 100% { box-shadow: 0 0 0 3px rgba(34,197,94,0.18); }
        50% { box-shadow: 0 0 0 6px rgba(34,197,94,0.08); }
      }
      .dir-coin-id { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
      .dir-coin-avatar {
        width: 38px; height: 38px; border-radius: 12px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        background: linear-gradient(135deg, var(--sky-500), var(--violet));
        color: white; font-weight: 700; font-size: 13px;
      }
      .dir-coin-avatar-lg { width: 48px; height: 48px; font-size: 16px; border-radius: 14px; }
      .dir-coin-names { min-width: 0; }
      .dir-coin-sub { font-size: 11.5px; opacity: 0.6; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dir-coin-stats { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; flex-shrink: 0; }
      .dir-coin-mcap { font-size: 11.5px; opacity: 0.65; font-weight: 600; }
      .dir-coin-float { font-size: 11px; color: #16a34a; font-weight: 600; }
      .dir-coin-actions { display: flex; gap: 8px; margin-top: 10px; }
      .dir-buy-btn { flex: 1; text-align: center; }

      .market-browse-divider {
        display: flex; align-items: center; gap: 12px; margin: 6px 0 16px;
        color: rgba(30,58,95,0.55); font-family: 'Outfit'; font-size: 12.5px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.06em;
      }
      .market-browse-divider::before, .market-browse-divider::after {
        content: ""; flex: 1; height: 1px; background: rgba(14,165,233,0.18);
      }
      .other-assets-toggle {
        display: flex; align-items: center; gap: 8px;
        background: none; border: none; cursor: pointer; padding: 4px 8px;
        color: rgba(30,58,95,0.75); font-family: 'Outfit'; font-size: 12.5px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.06em;
      }
      .dir-search-prompt { text-align: center; padding: 28px 20px; }
      .dir-search-prompt h3 { margin: 12px 0 6px; font-size: 16px; }
      .dir-search-prompt p { font-size: 13px; opacity: 0.65; line-height: 1.5; margin: 0; }

      /* ---------------- Coin detail + compare ---------------- */
      .coin-detail-head { margin-bottom: 14px; }
      .coin-detail-head h3 { margin: 0; font-size: 17px; }
      .coin-detail-rows { display: flex; flex-direction: column; margin-bottom: 14px; }
      .coin-detail-row {
        display: flex; justify-content: space-between; align-items: center;
        padding: 9px 0; border-bottom: 1px solid rgba(14,165,233,0.12);
      }
      .coin-detail-row:last-child { border-bottom: none; }
      .coin-detail-value { font-weight: 700; font-size: 13.5px; }
      .coin-detail-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .coin-detail-actions .pill-btn { flex: 1; text-align: center; }
      .compare-modal { max-width: 560px; }
      .compare-table-wrap { overflow-x: auto; margin-bottom: 12px; }
      .compare-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .compare-table th, .compare-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid rgba(14,165,233,0.12); white-space: nowrap; }
      .compare-table thead th { border-bottom: 2px solid rgba(14,165,233,0.2); vertical-align: top; }
      .compare-head { display: flex; align-items: center; gap: 6px; }
      .compare-name { font-size: 11.5px; font-weight: 600; opacity: 0.7; margin-top: 4px; }

      /* ---------------- Buy modal: quick amounts + coin offers ---------------- */
      .quick-amounts { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 10px; }
      .offer-units-row { display: flex; gap: 8px; align-items: center; }
      .offer-units-row .text-input { flex: 1; }
      select.text-input { appearance: auto; }

      .social-sync-row { display: flex; flex-direction: column; gap: 4px; }
      .social-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

      /* ---------------- Currency dropdown ---------------- */
      .currency-dropdown-wrap { position: relative; }
      .currency-dropdown-trigger {
        display: flex; align-items: center; gap: 8px;
        background: rgba(14,165,233,0.07); border: 1px solid rgba(14,165,233,0.2);
        border-radius: 12px; padding: 8px 12px; cursor: pointer; color: var(--navy);
        font-family: 'Outfit'; transition: background 0.2s ease;
      }
      .currency-dropdown-trigger:hover { background: rgba(14,165,233,0.13); }
      .currency-dropdown-current { font-family: 'IBM Plex Mono'; font-weight: 700; font-size: 13px; }
      .currency-dropdown-sub { font-size: 11.5px; opacity: 0.6; font-weight: 500; }
      .dropdown-backdrop { position: fixed; inset: 0; z-index: 35; background: transparent; }
      .currency-dropdown-menu {
        position: absolute; top: calc(100% + 8px); right: 0; z-index: 36;
        width: 240px; max-height: 320px; overflow-y: auto;
        background: rgba(255,255,255,0.97); backdrop-filter: blur(20px);
        border: 1px solid rgba(14,165,233,0.2); border-radius: 16px;
        padding: 10px; box-shadow: 0 12px 36px rgba(14,165,233,0.22);
        animation: modalPop 0.18s ease;
      }
      .currency-group { margin-bottom: 6px; }
      .currency-group-label {
        display: block; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em;
        opacity: 0.45; font-weight: 700; padding: 6px 8px 2px;
      }
      .currency-option {
        width: 100%; display: flex; align-items: center; gap: 8px; text-align: left;
        background: transparent; border: none; border-radius: 10px; padding: 8px 8px;
        cursor: pointer; color: var(--navy); transition: background 0.15s ease;
      }
      .currency-option:hover { background: rgba(14,165,233,0.08); }
      .currency-option-active { background: rgba(14,165,233,0.12); }
      .currency-option-short { font-family: 'IBM Plex Mono'; font-weight: 700; font-size: 12.5px; width: 48px; }
      .currency-option-label { flex: 1; font-size: 12.5px; opacity: 0.8; }

      /* ---------------- Go Live tab ---------------- */
      .golive-grid { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 22px; align-items: start; }
      @media (max-width: 900px) { .golive-grid { grid-template-columns: 1fr; } }

      /* Entry screen: 3-path picker + bring-your-own-network */
      .golive-entry-wrap { display: flex; flex-direction: column; gap: 18px; max-width: 720px; margin: 0 auto; }
      .golive-entry-card { padding: 26px; }
      .golive-path-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 18px; }
      @media (max-width: 760px) { .golive-path-grid { grid-template-columns: 1fr; } }
      .golive-path-btn {
        display: flex; flex-direction: column; align-items: flex-start; gap: 8px; text-align: left;
        background: rgba(255,255,255,0.7); border: 1px solid rgba(14,165,233,0.18); border-radius: 16px;
        padding: 18px 16px; cursor: pointer; color: var(--navy); transition: all 0.2s ease;
        position: relative; -webkit-tap-highlight-color: transparent;
      }
      .golive-path-btn:hover { border-color: var(--sky-500); background: rgba(14,165,233,0.06); }
      /* Doubled selector so the selected state always wins over sticky :hover on touch devices */
      .golive-path-btn.golive-path-btn-active,
      .golive-path-btn.golive-path-btn-active:hover {
        background: linear-gradient(135deg, #0369a1 0%, #0ea5e9 55%, #7c3aed 100%);
        border-color: transparent; color: #ffffff;
        box-shadow: 0 10px 30px rgba(14,165,233,0.4), inset 0 1px 0 rgba(255,255,255,0.25);
        animation: cardSelectPop 0.38s ease;
      }
      @keyframes cardSelectPop {
        0% { transform: scale(0.97); }
        55% { transform: scale(1.018); }
        100% { transform: scale(1); }
      }
      .golive-path-check {
        position: absolute; top: 12px; right: 12px;
        width: 26px; height: 26px; border-radius: 50%;
        background: rgba(255,255,255,0.95); color: #0369a1;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 2px 8px rgba(3,105,161,0.35);
        animation: checkPop 0.3s ease;
      }
      @keyframes checkPop { from { transform: scale(0.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      .golive-path-icon {
        width: 38px; height: 38px; border-radius: 11px; background: rgba(14,165,233,0.14);
        display: flex; align-items: center; justify-content: center; color: var(--sky-500);
      }
      .golive-path-btn-active .golive-path-icon { background: rgba(255,255,255,0.22); color: white; }
      .golive-path-label { font-weight: 700; font-size: 14.5px; }
      .golive-path-sublabel { font-size: 12px; opacity: 0.7; line-height: 1.4; }
      .golive-path-btn-active .golive-path-sublabel { opacity: 0.9; }
      .golive-path-arrow {
        position: absolute; right: 14px; top: 50%; transform: translateY(-50%);
        color: var(--sky-500); opacity: 0.6; display: flex; align-items: center;
      }

      .golive-examples-block { margin-top: 22px; padding-top: 18px; border-top: 1px dashed rgba(14,165,233,0.2); }
      .golive-examples-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
      .golive-example-btn {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        background: rgba(255,255,255,0.7); border: 1px solid rgba(14,165,233,0.18); border-radius: 12px;
        padding: 13px 16px; cursor: pointer; color: var(--navy); font-family: 'Outfit'; font-weight: 600;
        font-size: 13.5px; text-align: left; transition: all 0.2s ease;
      }
      .golive-example-btn:hover { border-color: var(--sky-500); background: rgba(14,165,233,0.06); }
      .golive-example-btn-own {
        background: rgba(139,92,246,0.06); border-color: rgba(139,92,246,0.25); color: var(--violet);
        font-style: italic;
      }
      .golive-example-btn-own:hover { background: rgba(139,92,246,0.12); border-color: var(--violet); }

      .golive-byon-card {
        display: flex; align-items: center; gap: 14px; padding: 18px 20px; cursor: pointer;
        color: var(--navy); text-align: left; transition: all 0.2s ease; width: 100%;
      }
      .golive-byon-card:hover { box-shadow: 0 8px 28px rgba(14,165,233,0.18); }
      .golive-byon-icon {
        width: 40px; height: 40px; border-radius: 12px; background: rgba(20,184,166,0.12); flex-shrink: 0;
        display: flex; align-items: center; justify-content: center; color: var(--teal);
      }
      .golive-byon-text { display: flex; flex-direction: column; gap: 3px; flex: 1; }
      .golive-byon-title { font-weight: 700; font-size: 14px; }
      .golive-byon-sub { font-size: 12px; opacity: 0.65; line-height: 1.4; }

      .own-thesis-banner {
        display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--violet);
        background: rgba(139,92,246,0.08); border: 1px solid rgba(139,92,246,0.2); border-radius: 12px;
        padding: 10px 14px; margin: 14px 0;
      }

      /* Documentation choice: own document vs. auto-generated agreement */
      .doc-choice-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 8px 0 14px; }
      @media (max-width: 600px) { .doc-choice-row { grid-template-columns: 1fr; } }
      .doc-choice-btn {
        display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
        background: rgba(255,255,255,0.7); border: 1px solid rgba(139,92,246,0.2); border-radius: 14px;
        padding: 16px 12px; cursor: pointer; color: var(--navy); font-family: 'Outfit'; font-weight: 600;
        font-size: 12.5px; transition: all 0.2s ease;
      }
      .doc-choice-btn:hover { border-color: var(--violet); background: rgba(139,92,246,0.06); }
      .doc-choice-btn-active { background: var(--violet); border-color: var(--violet); color: white; }

      .generate-agreement-block { background: rgba(139,92,246,0.05); border-radius: 14px; padding: 14px; margin-top: 6px; }
      .signature-input { font-family: 'Outfit'; font-style: italic; }

      .split-slider-block { background: rgba(14,165,233,0.05); border-radius: 14px; padding: 14px; margin-top: 4px; }
      .split-slider-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
      .split-slider-tag { font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 8px; white-space: nowrap; width: 92px; text-align: center; }
      .split-public { background: rgba(14,165,233,0.18); color: var(--sky-500); }
      .split-retained { background: rgba(139,92,246,0.18); color: var(--violet); }
      .split-slider-value { font-family: 'IBM Plex Mono'; font-size: 13px; width: 38px; text-align: right; }
      .range-input { flex: 1; accent-color: var(--sky-500); }
      .range-input-retained { accent-color: var(--violet); }

      .publish-success {
        display: flex; align-items: center; gap: 8px; margin-top: 14px;
        color: var(--emerald); font-size: 13px; font-weight: 600;
      }

      .preview-label { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.5; font-weight: 600; margin-bottom: 14px; }
      .preview-card { background: linear-gradient(160deg, rgba(14,165,233,0.08), rgba(139,92,246,0.06)); border-radius: 16px; padding: 18px; border: 1px solid rgba(14,165,233,0.15); }
      .preview-card-top { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
      .preview-avatar { width: 42px; height: 42px; border-radius: 12px; background: white; display: flex; align-items: center; justify-content: center; color: var(--sky-500); box-shadow: 0 2px 8px rgba(14,165,233,0.15); }
      .preview-card-top h3 { margin: 0; font-size: 16px; }
      .preview-category { font-size: 11.5px; opacity: 0.55; font-weight: 600; }
      .preview-tagline { font-size: 13px; opacity: 0.8; line-height: 1.5; margin: 0 0 14px; }
      .preview-stats { display: flex; gap: 22px; margin-bottom: 14px; }
      .preview-split { margin-bottom: 14px; }
      .split-bar { height: 8px; border-radius: 6px; background: rgba(139,92,246,0.18); overflow: hidden; margin-bottom: 6px; }
      .split-bar-public { height: 100%; background: var(--sky-500); transition: width 0.3s ease; }
      .split-labels { display: flex; justify-content: space-between; font-size: 11.5px; opacity: 0.65; font-weight: 600; }
      .preview-price { display: flex; justify-content: space-between; align-items: center; border-top: 1px dashed rgba(14,165,233,0.25); padding-top: 12px; margin-bottom: 12px; }
      .preview-price-value { font-family: 'IBM Plex Mono'; font-size: 18px; font-weight: 600; color: var(--sky-500); }

      /* ---------------- Sovereign Chain UI ---------------- */
      .share-split-readout { display: flex; gap: 22px; background: rgba(14,165,233,0.05); border-radius: 12px; padding: 10px 14px; margin: 10px 0 16px; }
      .share-split-readout .stat-value { font-family: 'IBM Plex Mono'; }

      .price-input-row { display: flex; align-items: center; background: rgba(15,23,42,0.03); border: 1px solid rgba(14,165,233,0.2); border-radius: 12px; padding: 0 12px; }
      .price-input-prefix { font-family: 'IBM Plex Mono'; font-weight: 600; opacity: 0.6; margin-right: 4px; }
      .price-input { border: none; background: transparent; padding: 12px 0; }
      .price-input:focus { outline: none; box-shadow: none; }

      .chain-preview-card { position: relative; }
      .chain-preview-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
      .chain-preview-note { font-size: 10.5px; opacity: 0.5; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
      .chain-id-badge {
        display: inline-flex; align-items: center; gap: 5px; font-family: 'IBM Plex Mono';
        font-size: 11.5px; font-weight: 600; color: var(--violet); background: rgba(139,92,246,0.12);
        border-radius: 8px; padding: 4px 9px;
      }
      .preview-chain-stats { display: flex; gap: 22px; border-top: 1px dashed rgba(14,165,233,0.25); padding-top: 12px; }

      .chain-panel {
        background: rgba(15,23,42,0.035); border: 1px solid rgba(139,92,246,0.15); border-radius: 14px;
        padding: 14px; margin: 4px 0 14px;
      }
      .chain-panel-compact { padding: 12px; }
      .chain-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
      .chain-tick-flag { font-family: 'IBM Plex Mono'; font-size: 11.5px; font-weight: 700; opacity: 0.75; }
      .chain-panel-note { font-size: 11.5px; opacity: 0.55; line-height: 1.4; margin: 0 0 12px; }
      .chain-panel-stats { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 12px; }
      .chain-block-feed { display: flex; flex-direction: column; gap: 5px; max-height: 140px; overflow-y: auto; }
      .chain-block-row {
        display: flex; gap: 8px; font-family: 'IBM Plex Mono'; font-size: 10.5px; opacity: 0.7;
        background: rgba(255,255,255,0.4); border-radius: 6px; padding: 5px 8px;
      }
      .chain-block-height { font-weight: 700; color: var(--violet); flex-shrink: 0; }
      .chain-block-detail { opacity: 0.85; }

      @keyframes blockSlideIn {
        0% { opacity: 0; transform: translateY(-6px); background: rgba(139,92,246,0.22); }
        60% { opacity: 1; transform: translateY(0); background: rgba(139,92,246,0.22); }
        100% { background: rgba(255,255,255,0.4); }
      }
      .chain-block-row-new { animation: blockSlideIn 1.1s ease-out; }

      .retained-value-readout {
        display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
        background: linear-gradient(135deg, rgba(139,92,246,0.08), rgba(14,165,233,0.06));
        border: 1px solid rgba(139,92,246,0.18); border-radius: 12px; padding: 12px 16px; margin: 4px 0 18px;
      }
      .retained-value-label { font-size: 12px; font-weight: 600; opacity: 0.7; }
      .retained-value-amount { font-family: 'IBM Plex Mono'; font-size: 20px; font-weight: 700; color: var(--violet); }
      .retained-value-hint { font-size: 11px; opacity: 0.5; }

      .chain-id-stamp {
        display: inline-block; font-family: 'IBM Plex Mono'; font-size: 10.5px; font-weight: 700;
        letter-spacing: 0.03em; color: var(--violet); margin-top: 3px;
      }

      /* ---------------- Provisioning Reveal ---------------- */
      .provisioning-overlay { backdrop-filter: blur(6px); background: rgba(8,10,20,0.55); }
      .provisioning-card {
        max-width: 380px; padding: 32px 28px; display: flex; flex-direction: column; align-items: center;
        gap: 22px; text-align: center;
      }
      .provisioning-steps { display: flex; flex-direction: column; gap: 12px; width: 100%; }
      .provisioning-step { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 600; opacity: 0.35; transition: opacity 0.3s ease; }
      .provisioning-step-active { opacity: 1; color: var(--violet); }
      .provisioning-step-done { opacity: 0.6; }
      .provisioning-step-dot {
        width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        border: 1.5px solid currentColor;
      }
      .provisioning-step-active .provisioning-step-dot { animation: provisionPulse 1s ease-in-out infinite; }
      .provisioning-step-done .provisioning-step-dot { background: var(--violet); border-color: var(--violet); color: #fff; }
      @keyframes provisionPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(139,92,246,0.35); }
        50% { box-shadow: 0 0 0 6px rgba(139,92,246,0); }
      }
      .provisioning-chain-reveal {
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        opacity: 0; transform: scale(0.9); transition: opacity 0.5s ease, transform 0.5s ease;
      }
      .provisioning-chain-reveal-shown { opacity: 1; transform: scale(1); }
      .provisioning-chain-caption { font-size: 11.5px; opacity: 0.55; font-weight: 600; }
      .provisioning-chain-id { font-family: 'IBM Plex Mono'; font-size: 30px; font-weight: 800; color: var(--violet); letter-spacing: 0.02em; }

      /* ---------------- Verification ---------------- */
      .verify-row { display: flex; gap: 8px; align-items: stretch; }
      .verify-row .text-input { flex: 1; }
      .verify-btn { white-space: nowrap; flex-shrink: 0; }
      .demo-hint { font-style: italic; opacity: 0.5; }

      .spinner {
        display: inline-block; width: 12px; height: 12px; border-radius: 50%;
        border: 2px solid rgba(14,165,233,0.25); border-top-color: var(--sky-500);
        animation: spin 0.7s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }

      .verify-status {
        display: flex; align-items: flex-start; gap: 8px; margin-top: 10px;
        font-size: 12.5px; line-height: 1.5; padding: 10px 12px; border-radius: 12px;
      }
      .verify-checking { background: rgba(14,165,233,0.08); color: var(--navy); }
      .verify-ok { background: rgba(34,197,94,0.1); color: #166534; }
      .verify-warn { background: rgba(239,68,68,0.1); color: #991b1b; }
      .verify-ok svg, .verify-warn svg { flex-shrink: 0; margin-top: 1px; }

      /* Linked social profiles (issuers can attach several) */
      .social-profiles-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
      .social-profile-row {
        display: flex; align-items: center; gap: 8px;
        background: rgba(14,165,233,0.06); border: 1px solid rgba(14,165,233,0.2);
        border-radius: 12px; padding: 9px 10px 9px 12px;
      }
      .social-profile-platform { font-weight: 700; font-size: 13px; color: var(--navy); white-space: nowrap; }
      .social-profile-url {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 12px; color: var(--sky-500);
      }
      .social-profile-verified {
        display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
        font-size: 11px; font-weight: 700; color: #166534;
        background: rgba(34,197,94,0.14); border-radius: 20px; padding: 3px 8px;
      }
      .social-add-btn { margin-top: 10px; width: 100%; display: flex; align-items: center; justify-content: center; }

      /* ---------------- Compliance & consent ---------------- */
      .compliance-block {
        background: rgba(139,92,246,0.05); border: 1px solid rgba(139,92,246,0.15);
        border-radius: 14px; padding: 14px; margin-top: 8px;
      }
      .compliance-hint { font-size: 12.5px; opacity: 0.7; line-height: 1.5; margin: 0 0 10px; }
      .field-label-sub { margin: 12px 0 6px; opacity: 0.6; }

      .file-upload-row { display: flex; align-items: center; gap: 8px; }
      .file-upload-btn {
        flex: 1; display: flex; align-items: center; gap: 8px;
        background: rgba(255,255,255,0.8); border: 1px dashed rgba(139,92,246,0.4);
        border-radius: 12px; padding: 10px 14px; font-size: 13px; color: var(--navy);
        cursor: pointer; transition: border-color 0.2s ease; overflow: hidden;
        white-space: nowrap; text-overflow: ellipsis;
      }
      .file-upload-btn:hover { border-color: var(--violet); }

      .consent-row { margin-top: 14px; }
      .checkbox-row {
        display: flex; align-items: flex-start; gap: 10px; font-size: 12.5px;
        line-height: 1.55; opacity: 0.85; cursor: pointer;
      }
      .checkbox-row input[type="checkbox"] { margin-top: 2px; accent-color: var(--violet); width: 16px; height: 16px; flex-shrink: 0; }
      .link-btn {
        background: none; border: none; padding: 0; color: var(--sky-500);
        font-weight: 600; cursor: pointer; text-decoration: underline; font-size: 12.5px;
        font-family: 'Outfit';
      }
      .agreement-preview-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin: 6px 0 4px; }
      .agreement-pdf-inline { display: inline-flex; align-items: center; gap: 5px; text-decoration: underline; }

      .terms-modal { max-width: 480px; }
      .terms-modal h3 { margin: 0 0 14px; font-size: 18px; }
      .terms-body {
        max-height: 360px; overflow-y: auto; font-size: 12.5px; line-height: 1.6;
        opacity: 0.85; margin-bottom: 16px; padding-right: 6px;
      }
      .terms-body p { margin: 0 0 12px; white-space: pre-wrap; }

      /* ---------------- Badges ---------------- */
      .asset-badges-row, .preview-badges-row { display: flex; gap: 6px; flex-wrap: wrap; }
      .badge {
        display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 700;
        padding: 4px 9px; border-radius: 20px; text-decoration: none; white-space: nowrap;
      }
      .badge-verified { background: rgba(34,197,94,0.13); color: #15803d; }
      .badge-compliant { background: rgba(139,92,246,0.13); color: var(--violet); }
      .badge-link { background: rgba(14,165,233,0.1); color: var(--sky-500); cursor: pointer; }
      .badge-link:hover { background: rgba(14,165,233,0.18); }

      /* External link buttons on marketplace listings (social profiles, websites) */
      .asset-external-links { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 4px; }
      .btn-external-link {
        display: inline-flex; align-items: center; gap: 7px;
        padding: 9px 16px; border-radius: 10px; font-size: 14px; font-weight: 600;
        text-decoration: none; cursor: pointer; border: none;
        transition: transform 0.1s ease, opacity 0.15s ease;
      }
      .btn-external-link:active { transform: scale(0.97); }
      .btn-social-link { background: linear-gradient(135deg, #0ea5e9, #6366f1); color: #fff; }
      .btn-social-link:hover { opacity: 0.92; }
      .btn-website-link { background: var(--surface-2); color: var(--ink); border: 1px solid var(--border); }
      .btn-website-link:hover { background: var(--surface-3); }

      /* Optional social section toggle on the mint form */
      .optional-social-block { margin: 6px 0 4px; }
      .optional-social-toggle { font-size: 14px; padding: 6px 0; }

      /* ---------------- Marketplace ---------------- */
      .market-wrap { display: flex; flex-direction: column; gap: 4px; }

      /* Marketplace locked gate: content is blurred + inert behind a lock card
         overlay until MARKETPLACE_LOCKED is flipped to false. */
      .market-gated { position: relative; }
      .market-locked-blur { filter: blur(12px) saturate(0.85); pointer-events: none; user-select: none; }
      .market-lock-overlay {
        position: absolute; inset: 0; z-index: 20;
        display: flex; align-items: center; justify-content: center;
        padding: 24px; pointer-events: none;
      }
      .market-lock-card {
        text-align: center; max-width: 340px; padding: 34px 28px;
        pointer-events: auto;
        box-shadow: 0 20px 60px rgba(14,165,233,0.28);
        animation: modalPop 0.3s ease;
      }
      .market-lock-mark {
        width: 64px; height: 64px; margin: 0 auto 14px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        background: linear-gradient(135deg, #0ea5e9, #8b5cf6); color: #fff;
        box-shadow: 0 8px 24px rgba(14,165,233,0.4);
      }
      .market-lock-title { font-size: 20px; font-weight: 800; color: var(--navy); margin: 0 0 8px; font-family: 'Outfit'; }
      .market-lock-sub { font-size: 13.5px; line-height: 1.55; opacity: 0.7; margin: 0; }
      /* Generic feature lock gate (Go Live tab, Fund Account modal): same
         blurred-content + inert + lock-card-overlay pattern as the
         marketplace gate. Controlled by GO_LIVE_LOCKED / CRYPTO_FUNDING_LOCKED. */
      .feature-gated { position: relative; }
      .feature-locked-blur { filter: blur(12px) saturate(0.85); pointer-events: none; user-select: none; }
      .feature-lock-overlay {
        position: absolute; inset: 0; z-index: 20;
        display: flex; align-items: center; justify-content: center;
        padding: 24px; pointer-events: none;
      }
      .feature-lock-card {
        text-align: center; max-width: 340px; padding: 34px 28px;
        pointer-events: auto;
        box-shadow: 0 20px 60px rgba(14,165,233,0.28);
        animation: modalPop 0.3s ease;
      }

      /* ---------------- Real issuance flow (agreement vs meme) ---------------- */
      .issuance-flow { max-width: 640px; margin: 0 auto; padding: 8px 4px 32px; }
      .issuance-choice-grid {
        display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px;
      }
      @media (max-width: 560px) { .issuance-choice-grid { grid-template-columns: 1fr; } }
      .issuance-choice-card {
        display: flex; flex-direction: column; gap: 10px; text-align: left;
        padding: 22px 18px; border-radius: 16px; cursor: pointer;
        background: rgba(255,255,255,0.55); border: 2px solid rgba(14,165,233,0.25);
        transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
        color: inherit; font: inherit;
      }
      .issuance-choice-card:hover:not(:disabled) {
        transform: translateY(-2px); border-color: rgba(14,165,233,0.6);
        box-shadow: 0 12px 32px rgba(14,165,233,0.18);
      }
      .issuance-choice-card:disabled { opacity: 0.6; cursor: wait; }
      .issuance-choice-meme { border-color: rgba(168,85,247,0.3); }
      .issuance-choice-meme:hover:not(:disabled) {
        border-color: rgba(168,85,247,0.6); box-shadow: 0 12px 32px rgba(168,85,247,0.18);
      }
      .issuance-choice-icon {
        width: 44px; height: 44px; border-radius: 12px;
        display: flex; align-items: center; justify-content: center;
        background: rgba(14,165,233,0.12); color: #0284c7;
      }
      .issuance-choice-meme .issuance-choice-icon {
        background: rgba(168,85,247,0.12); color: #7c3aed;
      }
      .issuance-choice-title { font-size: 17px; font-weight: 700; }
      .issuance-choice-desc { font-size: 13.5px; line-height: 1.55; opacity: 0.82; }
      .social-connect-list { display: flex; flex-direction: column; gap: 12px; margin-top: 20px; }
      .social-connect-row {
        display: flex; align-items: center; gap: 14px;
        padding: 14px 16px; border-radius: 14px;
        background: rgba(255,255,255,0.55); border: 1.5px solid rgba(14,165,233,0.2);
      }
      .social-connect-icon {
        width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        background: rgba(14,165,233,0.12); color: #0284c7;
      }
      .social-connect-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .social-connect-label { font-size: 15px; font-weight: 700; }
      .social-connect-detail { font-size: 12.5px; opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .announce-section { margin-top: 24px; padding-top: 20px; border-top: 1px solid rgba(14,165,233,0.15); display: flex; flex-direction: column; gap: 10px; align-items: center; }
      .announce-title { font-size: 16px; font-weight: 700; margin: 0; }
      .announce-result { margin-top: 16px; display: flex; flex-direction: column; gap: 10px; align-items: center; }
      .announce-card-img { width: 220px; height: 220px; border-radius: 16px; box-shadow: 0 12px 32px rgba(2,132,199,0.25); }
      .issuance-meme-alt { margin-top: 28px; }
      .issuance-meme-alt .market-entry-divider { margin: 0 0 12px; }
      .business-doc-block { margin: 18px 0 6px; padding: 14px; border-radius: 14px; background: rgba(255,255,255,0.35); }
      .file-upload-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; flex-wrap: wrap; }
      .file-upload-name { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: #0284c7; }
      .business-attestation { margin: 20px 0; padding: 18px; border-radius: 16px; border: 1.5px solid rgba(14,165,233,0.25); background: rgba(14,165,233,0.05); }
      .chain-picker { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 16px; }
      .fund-method-tabs { margin: 12px 0 20px; }
      .fund-method-tabs .chain-btn { flex: 1; text-align: center; }
      .card-fund-panel { display: flex; flex-direction: column; }
      .amount-row {
        display: flex; align-items: center; gap: 8px;
        background: rgba(255,255,255,0.6); border: 1.5px solid rgba(14,165,233,0.25);
        border-radius: 14px; padding: 12px 16px; margin: 4px 0 8px;
      }
      .amount-currency { font-size: 20px; font-weight: 700; color: #0e7490; }
      .amount-input {
        flex: 1; border: none; background: transparent; outline: none;
        font: inherit; font-size: 22px; font-weight: 700; color: inherit;
      }
      .field-error { color: #dc2626; }
      .stripe-card-element {
        background: rgba(255,255,255,0.6); border: 1.5px solid rgba(14,165,233,0.25);
        border-radius: 14px; padding: 14px 16px; margin: 4px 0 16px;
      }
      .chain-btn {
        padding: 10px 16px; border-radius: 12px; cursor: pointer;
        background: rgba(255,255,255,0.5); border: 1.5px solid rgba(14,165,233,0.2);
        font: inherit; font-size: 13.5px; font-weight: 600; color: inherit;
        transition: border-color 0.15s ease, background 0.15s ease;
      }
      .chain-btn-active {
        border-color: rgba(14,165,233,0.7); background: rgba(14,165,233,0.12); color: #0284c7;
      }
      .deposit-address-box {
        display: flex; align-items: center; gap: 10px;
        padding: 14px; border-radius: 12px; margin: 8px 0;
        background: rgba(2,132,199,0.06); border: 1.5px dashed rgba(14,165,233,0.35);
      }
      .deposit-address { flex: 1; font-size: 12px; word-break: break-all; line-height: 1.5; }
      .funding-totals { margin: 16px 0; padding: 12px 16px; border-radius: 12px; background: rgba(255,255,255,0.4); }
      .funding-total-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13.5px; }
      .issuance-choice-tag {
        align-self: flex-start; font-size: 11.5px; font-weight: 600;
        padding: 4px 10px; border-radius: 999px;
        background: rgba(14,165,233,0.12); color: #0284c7;
      }
      .issuance-choice-meme .issuance-choice-tag {
        background: rgba(168,85,247,0.12); color: #7c3aed;
      }
      .agreement-doc {
        margin: 16px 0; border-radius: 12px; border: 1px solid rgba(14,165,233,0.2);
        background: rgba(255,255,255,0.7); max-height: 420px; overflow-y: auto;
      }
      .agreement-text {
        margin: 0; padding: 20px; font-size: 13px; line-height: 1.65;
        white-space: pre-wrap; font-family: ui-serif, Georgia, serif; color: #1e293b;
      }
      .meme-disclaimer {
        margin: 16px 0; padding: 20px; border-radius: 12px;
        background: rgba(168,85,247,0.07); border: 1px solid rgba(168,85,247,0.25);
        font-size: 14px; line-height: 1.6;
      }
      .meme-disclaimer ul { margin: 8px 0; padding-left: 20px; }
      .meme-disclaimer li { margin: 4px 0; }
      .issuance-status { text-align: center; padding-top: 32px; }
      .issuance-success-icon {
        display: inline-flex; width: 64px; height: 64px; border-radius: 50%;
        background: rgba(34,197,94,0.14); color: #16a34a;
        align-items: center; justify-content: center; margin-bottom: 12px;
      }
      .mint-details {
        margin: 20px auto; max-width: 480px; text-align: left;
        border-radius: 12px; border: 1px solid rgba(14,165,233,0.2);
        background: rgba(255,255,255,0.6); padding: 4px 18px;
      }
      .mint-detail-row {
        display: flex; justify-content: space-between; align-items: center; gap: 12px;
        padding: 12px 0; border-bottom: 1px solid rgba(14,165,233,0.1);
      }
      .mint-detail-row:last-child { border-bottom: none; }
      .mono { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
      .feature-lock-mark {
        width: 64px; height: 64px; margin: 0 auto 14px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        background: linear-gradient(135deg, #0ea5e9, #8b5cf6); color: #fff;
        box-shadow: 0 8px 24px rgba(14,165,233,0.4);
      }
      .feature-lock-title { font-size: 20px; font-weight: 800; color: var(--navy); margin: 0 0 8px; font-family: 'Outfit'; }
      .feature-lock-sub { font-size: 13.5px; line-height: 1.55; opacity: 0.7; margin: 0; }
      .market-header { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 6px; }
      .market-filter-row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }

      /* Marketplace first-run category picker (progressive disclosure) */
      .cat-picker { margin-top: 6px; }
      .cat-picker-card { padding: 20px; }
      .cat-picker-title { font-size: 17px; font-weight: 700; color: var(--navy); margin: 0 0 4px; font-family: 'Outfit'; }
      .cat-picker-sub { font-size: 13px; opacity: 0.65; margin: 0 0 14px; }
      .cat-picker-list { display: flex; flex-direction: column; gap: 8px; }
      .cat-picker-btn {
        display: flex; align-items: center; gap: 12px; width: 100%;
        background: rgba(255,255,255,0.7); border: 1px solid rgba(14,165,233,0.18); border-radius: 12px;
        padding: 12px 14px; cursor: pointer; color: var(--navy); font-family: 'Outfit';
        text-align: left; transition: all 0.2s ease;
      }
      .cat-picker-btn:hover { border-color: var(--sky-500); background: rgba(14,165,233,0.06); }
      .cat-picker-icon {
        width: 38px; height: 38px; border-radius: 11px; background: rgba(14,165,233,0.1); flex-shrink: 0;
        display: flex; align-items: center; justify-content: center; color: var(--sky-500);
      }
      .cat-picker-text { display: flex; flex-direction: column; gap: 2px; flex: 1; }
      .cat-picker-label { font-weight: 700; font-size: 14px; }
      .cat-picker-count { font-size: 11.5px; opacity: 0.6; }

      /* Marketplace quick-pick entry: dropdown + browse-all */
      .market-entry { margin-top: 6px; }
      .market-entry-card { padding: 22px 20px; }
      .market-entry-select-wrap { position: relative; }
      .market-entry-select {
        width: 100%; appearance: none; -webkit-appearance: none;
        background: rgba(255,255,255,0.85); border: 1.5px solid rgba(14,165,233,0.3);
        border-radius: 14px; padding: 14px 40px 14px 14px;
        font-family: 'Outfit'; font-weight: 600; font-size: 15px; color: var(--navy);
        cursor: pointer; transition: border-color 0.2s ease, box-shadow 0.2s ease;
      }
      .market-entry-select:focus { outline: none; border-color: var(--sky-500); box-shadow: 0 0 0 3px rgba(14,165,233,0.18); }
      .market-entry-select-wrap > svg, .market-entry-select-wrap .icon-wrap { position: absolute; right: 14px; top: 50%; transform: translateY(-50%) rotate(90deg); pointer-events: none; opacity: 0.6; }
      .market-entry-divider { display: flex; align-items: center; gap: 10px; margin: 16px 0; color: var(--navy); opacity: 0.5; font-size: 12.5px; font-weight: 600; }
      .market-entry-divider::before, .market-entry-divider::after { content: ""; flex: 1; height: 1px; background: rgba(14,165,233,0.25); }
      .market-entry-browse { width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 13px; font-size: 14.5px; }
      .market-back-link {
        display: inline-flex; align-items: center; gap: 6px; background: none; border: none;
        color: var(--sky-500); font-family: 'Outfit'; font-weight: 600; font-size: 13px;
        cursor: pointer; padding: 4px 0 10px;
      }
      .back-arrow-flip { display: inline-flex; transform: rotate(180deg); }

      .filter-dropdown-trigger {
        display: flex; align-items: center; gap: 8px;
        background: rgba(14,165,233,0.07); border: 1px solid rgba(14,165,233,0.2);
        border-radius: 12px; padding: 8px 14px; cursor: pointer; color: var(--navy);
        font-family: 'Outfit'; font-weight: 600; font-size: 13px; transition: background 0.2s ease;
      }
      .filter-dropdown-trigger:hover { background: rgba(14,165,233,0.13); }
      .category-filter-menu { width: 260px; max-height: 360px; }

      /* ---------------- Network multi-filter ---------------- */
      .network-filter-panel { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
      .network-filter-label { font-size: 12px; font-weight: 600; opacity: 0.5; text-transform: uppercase; letter-spacing: 0.04em; }
      .network-filter-badges { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; }
      .network-badge {
        display: inline-flex; align-items: center; gap: 5px;
        background: rgba(255,255,255,0.7); border: 1px solid rgba(14,165,233,0.2);
        border-radius: 16px; padding: 6px 12px; font-family: 'Outfit'; font-weight: 600; font-size: 12px;
        color: var(--navy); cursor: pointer; transition: all 0.2s ease;
      }
      .network-badge:hover { border-color: var(--sky-500); }
      .network-badge-active { background: var(--navy); color: white; border-color: var(--navy); }
      .network-filter-clear { background: none; border: none; color: var(--coral); font-size: 12px; font-weight: 600; cursor: pointer; text-decoration: underline; }

      .network-pill {
        flex-shrink: 0; font-family: 'IBM Plex Mono'; font-size: 10.5px; font-weight: 600;
        background: rgba(20,184,166,0.1); color: var(--teal); border: 1px solid rgba(20,184,166,0.22);
        border-radius: 10px; padding: 4px 9px; white-space: nowrap;
      }
      .network-pill-modal { margin-left: auto; }

      .empty-state {
        display: flex; flex-direction: column; align-items: center; gap: 10px;
        padding: 48px 20px; text-align: center; color: var(--navy); opacity: 0.75;
      }
      .empty-state h3 { margin: 4px 0 0; font-size: 16px; }
      .empty-state p { margin: 0; font-size: 13.5px; max-width: 320px; opacity: 0.8; }

      /* ---------------- Asset list (expandable rows) ---------------- */
      .asset-list { display: flex; flex-direction: column; gap: 10px; }
      .asset-list-row { padding: 0; overflow: hidden; }
      .asset-list-row-expanded { box-shadow: 0 6px 28px rgba(14,165,233,0.16); }

      .asset-list-row-collapsed {
        display: flex; align-items: center; gap: 12px; width: 100%;
        padding: 14px 16px; cursor: pointer; text-align: left;
        background: transparent; border: none; color: var(--navy);
      }
      .asset-list-row-collapsed:hover { background: rgba(14,165,233,0.04); }
      .asset-avatar { width: 38px; height: 38px; border-radius: 10px; background: rgba(14,165,233,0.12); display: flex; align-items: center; justify-content: center; color: var(--sky-500); flex-shrink: 0; }
      .asset-avatar-sm { width: 32px; height: 32px; border-radius: 9px; }

      .asset-list-row-main { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
      .asset-list-row-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
      .asset-list-row-top .holdings-name {
        font-size: 13.5px; line-height: 1.3; overflow-wrap: anywhere; min-width: 0; flex: 1;
      }
      .asset-list-row-bottom { display: flex; align-items: center; gap: 8px; }

      .asset-list-row-price { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; flex-shrink: 0; }
      .asset-list-row-chevron { flex-shrink: 0; opacity: 0.5; }
      .price-text-sm { font-family: 'IBM Plex Mono'; font-size: 14px; font-weight: 600; white-space: nowrap; }
      .owner-badge { background: var(--violet); color: white; font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 8px; flex-shrink: 0; }
      .asset-tagline { font-size: 12.5px; opacity: 0.7; line-height: 1.5; margin: 0; }
      .asset-card-stats { display: flex; gap: 18px; }
      .change-text { font-family: 'IBM Plex Mono'; font-size: 12px; font-weight: 500; }
      .price-up { color: var(--emerald); }
      .price-down { color: var(--coral); }
      .price-flash { animation: priceFlash 1s ease; }
      @keyframes priceFlash { 0% { opacity: 0.4; } 100% { opacity: 1; } }
      .btn-full.btn-secondary { width: 100%; text-align: center; }

      .asset-list-row-expanded-content {
        padding: 4px 16px 18px; display: flex; flex-direction: column; gap: 14px;
        border-top: 1px solid rgba(14,165,233,0.1); margin: 0 16px; padding-top: 14px;
      }
      .asset-list-row-actions { display: flex; gap: 10px; flex-wrap: wrap; }
      .asset-list-row-actions .btn-secondary, .asset-list-row-actions .btn-primary { flex: 1; min-width: 140px; text-align: center; justify-content: center; }

      .spark-tooltip {
        position: absolute; top: -22px; transform: translateX(-50%);
        background: var(--navy); color: white; font-family: 'IBM Plex Mono';
        font-size: 10px; padding: 2px 6px; border-radius: 6px; white-space: nowrap; pointer-events: none;
      }

      /* ---------------- Financials modal ---------------- */
      .financials-modal { max-width: 440px; }
      .financials-header { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
      .financials-header h3 { margin: 0; font-size: 17px; }
      .financials-price-row { display: flex; justify-content: space-between; align-items: baseline; margin: 16px 0 10px; }
      .financials-price { font-family: 'IBM Plex Mono'; font-size: 26px; font-weight: 700; display: block; }

      .asset-trend-chart { position: relative; width: 100%; margin-bottom: 16px; }
      .asset-trend-tooltip {
        display: flex; flex-direction: column; align-items: center; gap: 1px;
      }
      .asset-trend-tooltip-day { font-size: 9.5px; opacity: 0.7; font-weight: 500; }

      .financials-stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
      .financials-stat { background: rgba(14,165,233,0.05); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; }
      .financials-learn-more {
        display: inline-flex; align-items: center; gap: 6px; color: var(--sky-500); font-size: 13px;
        font-weight: 600; text-decoration: none; margin: 14px 0 18px;
      }
      .financials-learn-more:hover { text-decoration: underline; }

      .view-full-profile-link { display: block; text-align: center; margin-top: 4px; font-size: 12.5px; }

      /* ---------------- Dashboard ---------------- */
      .dashboard-wrap { display: flex; flex-direction: column; gap: 18px; }
      .net-worth-value { font-family: 'IBM Plex Mono'; font-size: 34px; font-weight: 700; color: var(--sky-500); display: block; margin: 4px 0 16px; }
      .net-worth-disclaimer { font-size: 12px; color: var(--muted, #8a8f98); margin: -8px 0 16px; font-style: italic; }

      .dash-section-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }

      .banner-flash {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        color: var(--navy); font-size: 13.5px; font-weight: 500;
        background: linear-gradient(135deg, rgba(14,165,233,0.12), rgba(139,92,246,0.1));
        animation: bannerGlow 2.4s ease-in-out infinite;
      }
      @keyframes bannerGlow {
        0%, 100% { box-shadow: 0 4px 24px rgba(14,165,233,0.08); }
        50% { box-shadow: 0 4px 24px rgba(14,165,233,0.22); }
      }

      /* ---------------- Allocation donut ---------------- */
      .net-worth-charts-row { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; margin-bottom: 16px; }
      .donut-wrap { position: relative; display: inline-flex; flex-shrink: 0; }
      .donut-empty {
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
        border-radius: 50%; border: 1px dashed rgba(14,165,233,0.25); color: var(--navy); opacity: 0.5; font-size: 12px;
      }
      .donut-center {
        position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
        text-align: center; pointer-events: none; padding: 0 14%;
      }
      .donut-center-value { font-family: 'IBM Plex Mono'; font-weight: 700; font-size: 15px; color: var(--navy); line-height: 1.2; }
      .donut-center-label { font-size: 10.5px; opacity: 0.55; font-weight: 600; margin-top: 2px; }

      .donut-legend { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
      .donut-legend-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
      .donut-legend-swatch { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
      .donut-legend-label { flex: 1; opacity: 0.8; }
      .donut-legend-pct { font-family: 'IBM Plex Mono'; font-weight: 600; opacity: 0.7; }

      /* ---------------- Net worth trend chart ---------------- */
      .net-worth-trend-block { flex: 1; min-width: 180px; }
      .trend-chart-wrap { position: relative; width: 100%; }
      .trend-empty {
        display: flex; align-items: center; justify-content: center; text-align: center;
        font-size: 12px; opacity: 0.5; border: 1px dashed rgba(14,165,233,0.2); border-radius: 12px; padding: 0 16px;
      }
      .trend-tooltip {
        position: absolute; top: -22px; transform: translateX(-50%);
        background: var(--navy); color: white; font-family: 'IBM Plex Mono';
        font-size: 10.5px; padding: 3px 8px; border-radius: 6px; white-space: nowrap; pointer-events: none;
      }

      /* ---------------- Investment category breakdown ---------------- */
      .category-breakdown-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
      .category-breakdown-chip {
        display: flex; align-items: center; gap: 6px; background: rgba(14,165,233,0.07);
        border: 1px solid rgba(14,165,233,0.15); border-radius: 12px; padding: 6px 10px; font-size: 12px; color: var(--navy);
      }
      .category-breakdown-value { font-family: 'IBM Plex Mono'; font-weight: 600; opacity: 0.8; }

      .holdings-table { display: flex; flex-direction: column; gap: 2px; }
      .holdings-row {
        display: grid; grid-template-columns: 1.4fr 1fr 0.8fr 1fr 1fr 1fr;
        align-items: center; gap: 8px; padding: 10px 6px; font-size: 13px;
        border-bottom: 1px solid rgba(14,165,233,0.08);
      }
      .holdings-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.5; font-weight: 700; }
      .holdings-name { font-weight: 600; display: block; }
      .holdings-name-cell { display: flex; flex-direction: column; gap: 1px; }
      .holdings-category-tag { font-size: 10.5px; opacity: 0.5; font-weight: 500; }
      .ticker-tag {
        display: inline-block; margin-left: 7px; font-family: 'IBM Plex Mono'; font-weight: 600;
        font-size: 10.5px; color: var(--sky-500); background: rgba(14,165,233,0.1);
        border-radius: 6px; padding: 1px 6px; vertical-align: middle;
      }
      .ticker-tag-lg { font-size: 12px; padding: 2px 8px; margin-left: 9px; }
      @media (max-width: 700px) {
        .holdings-row { grid-template-columns: 1fr 1fr; font-size: 12px; }
        .holdings-head { display: none; }
      }

      /* ---------------- My Onchained Products ---------------- */
      .products-list { display: flex; flex-direction: column; gap: 4px; }
      .product-row {
        display: flex; align-items: center; gap: 12px; padding: 12px 6px;
        border-bottom: 1px solid rgba(14,165,233,0.08); flex-wrap: wrap;
      }
      .product-row-icon {
        width: 34px; height: 34px; border-radius: 10px; background: rgba(139,92,246,0.12);
        display: flex; align-items: center; justify-content: center; color: var(--violet); flex-shrink: 0;
      }
      .product-row-main { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 140px; }
      .product-row-stat { display: flex; flex-direction: column; gap: 1px; align-items: flex-end; }

      /* ---------------- Currency & Cash ---------------- */
      .fund-btn { padding: 9px 16px; font-size: 13px; margin-top: 0; display: inline-flex; gap: 6px; }
      .cash-balance-row { display: flex; gap: 10px; flex-wrap: wrap; }
      .cash-balance-chip {
        display: flex; align-items: center; gap: 7px; background: rgba(20,184,166,0.08);
        border: 1px solid rgba(20,184,166,0.22); border-radius: 14px; padding: 9px 14px;
      }
      .cash-balance-currency { font-family: 'IBM Plex Mono'; font-weight: 700; font-size: 12px; color: var(--teal); }
      .cash-balance-value { font-family: 'IBM Plex Mono'; font-weight: 600; font-size: 13px; }

      /* ---------------- Compliance summary ---------------- */
      .compliance-summary-row { display: flex; gap: 28px; flex-wrap: wrap; margin-bottom: 14px; }
      .compliance-summary-stat { display: flex; flex-direction: column; gap: 2px; }
      .compliance-doc-list { display: flex; flex-direction: column; gap: 8px; }
      .compliance-doc-entry { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 12px; background: rgba(59,130,246,0.06); border: 1px solid rgba(59,130,246,0.12); }
      .compliance-signed-doc { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
      .compliance-signed-meta { font-size: 12.5px; color: var(--ink-soft); line-height: 1.45; }
      .compliance-doc-row {
        display: flex; align-items: center; gap: 10px; padding: 8px 0;
        border-bottom: 1px solid rgba(14,165,233,0.06); font-size: 12.5px;
      }
      .compliance-doc-name { flex: 1; font-weight: 600; }
      .badge-pending { background: rgba(239,68,68,0.1); color: #991b1b; }

      .tx-list { display: flex; flex-direction: column; gap: 8px; }
      .tx-row { display: flex; justify-content: space-between; font-size: 13px; padding: 8px 0; border-bottom: 1px solid rgba(14,165,233,0.07); }
      .tx-amount-col { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
      .tx-fee-line { font-size: 11px; opacity: 0.6; text-align: right; }
      .field-error { color: #b91c1c; opacity: 1; }
      .btn-small { font-size: 12px; padding: 6px 12px; }

      /* ---------------- Fee quotes & disclosure ---------------- */
      .fee-breakdown { padding: 12px 14px; margin: 10px 0; }
      .fee-row { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; font-size: 13px; padding: 5px 0; }
      .fee-row span { opacity: 0.75; }
      .fee-row strong { font-weight: 700; }
      .fee-row-total { border-top: 1px solid rgba(14,165,233,0.12); margin-top: 4px; padding-top: 9px; font-size: 14px; }
      .fee-note { font-size: 11.5px; opacity: 0.6; margin: 4px 0 0; }
      .fee-disclosure { font-size: 11px; opacity: 0.55; margin: 8px 0 0; font-style: italic; }
      .market-fee-disclosure { margin: 2px 0 10px; }
      .dash-header-actions { display: flex; align-items: center; gap: 8px; }

      /* ---------------- Admin dashboard ---------------- */
      .admin-modal { max-width: 640px; width: calc(100vw - 32px); max-height: 88vh; overflow-y: auto; }
      .admin-tabs { margin: 10px 0 4px; flex-wrap: wrap; }
      .admin-section { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
      .admin-kv { display: flex; flex-direction: column; }
      .admin-form-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0 10px; }
      .admin-form-row .text-input { flex: 1 1 120px; min-width: 0; }
      .admin-table-wrap { overflow-x: auto; margin-top: 6px; }
      .admin-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .admin-table th, .admin-table td { text-align: left; padding: 7px 8px; border-bottom: 1px solid rgba(14,165,233,0.08); white-space: nowrap; }
      .admin-table th { opacity: 0.6; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
      .admin-wrap { white-space: normal !important; word-break: break-word; max-width: 180px; }
      .status-chip { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: rgba(14,165,233,0.12); color: var(--navy); }
      .status-settled, .status-executed, .status-approved { background: rgba(34,197,94,0.14); color: #15803d; }
      .status-reversed, .status-rejected, .status-failed { background: rgba(239,68,68,0.12); color: #b91c1c; }
      .status-requested, .status-pending { background: rgba(245,158,11,0.16); color: #b45309; }
      .status-bad { background: rgba(239,68,68,0.12); color: #b91c1c; }
      .recon-banner { font-size: 13px; font-weight: 600; padding: 10px 12px; border-radius: 10px; margin: 10px 0 4px; }
      .recon-ok { background: rgba(34,197,94,0.12); color: #15803d; }
      .recon-bad { background: rgba(239,68,68,0.12); color: #b91c1c; }
      .check-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; background: #94a3b8; }
      .check-ok { background: #22c55e; }
      .check-warn { background: #f59e0b; }
      .check-critical { background: #ef4444; }

      .footnotes-card { display: flex; gap: 18px; flex-wrap: wrap; }
      .footnote-link { color: var(--sky-500); font-size: 13px; font-weight: 600; text-decoration: none; }
      .footnote-link:hover { text-decoration: underline; }

      /* ---------------- Fund Account modal ---------------- */
      .fund-modal { max-width: 460px; }
      .funding-method-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
      @media (max-width: 480px) { .funding-method-grid { grid-template-columns: 1fr; } }
      .funding-method-btn {
        display: flex; flex-direction: column; align-items: flex-start; gap: 4px; text-align: left;
        background: rgba(255,255,255,0.7); border: 1px solid rgba(14,165,233,0.18); border-radius: 14px;
        padding: 12px 14px; cursor: pointer; color: var(--navy); transition: border-color 0.2s ease, background 0.2s ease;
      }
      .funding-method-btn:hover { border-color: var(--sky-500); background: rgba(14,165,233,0.06); }
      .funding-method-label { font-weight: 700; font-size: 13px; margin-top: 4px; }
      .funding-method-note { font-size: 11px; opacity: 0.55; line-height: 1.4; }

      .back-link { display: inline-block; margin-bottom: 10px; }

      .funding-processing, .funding-done {
        display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 20px 0 6px;
      }
      .spinner-large { width: 32px; height: 32px; border-width: 3px; }
      .funding-done-icon {
        width: 48px; height: 48px; border-radius: 50%; background: rgba(34,197,94,0.14); color: #15803d;
        display: flex; align-items: center; justify-content: center; margin-bottom: 4px;
      }


      /* ---------------- Bottom bar ---------------- */
      .bottom-bar {
        position: fixed; bottom: 0; left: 0; right: 0; z-index: 25;
        display: flex; align-items: center; justify-content: center; gap: 8px;
        background: rgba(255,255,255,0.85); backdrop-filter: blur(16px);
        border-top: 1px solid rgba(14,165,233,0.16);
        padding: 13px; font-family: 'Outfit'; font-weight: 600; font-size: 13px;
        color: var(--navy); cursor: pointer; border-left: none; border-right: none; border-bottom: none;
      }
      .bottom-bar:hover { background: rgba(240,249,255,0.95); }

      /* ---------------- News drawer ---------------- */
      .drawer-overlay {
        position: fixed; inset: 0; background: rgba(12,74,110,0.25); backdrop-filter: blur(4px);
        z-index: 50; display: flex; justify-content: flex-end;
      }
      .drawer {
        width: min(420px, 92vw); height: 100%; background: var(--sky-50);
        box-shadow: -8px 0 40px rgba(14,165,233,0.18);
        display: flex; flex-direction: column; animation: drawerSlide 0.25s ease;
      }
      @keyframes drawerSlide { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      .drawer-header { display: flex; justify-content: space-between; align-items: center; padding: 18px 20px; border-bottom: 1px solid rgba(14,165,233,0.15); }
      .drawer-title { font-weight: 700; font-size: 17px; }
      .drawer-body { padding: 16px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
      .news-card { background: rgba(255,255,255,0.75); border: 1px solid rgba(14,165,233,0.15); border-radius: 14px; padding: 14px; }
      .news-card h4 { margin: 6px 0 6px; font-size: 14px; }
      .news-card p { margin: 0; font-size: 12.5px; opacity: 0.75; line-height: 1.5; }
      .news-tag { font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 8px; text-transform: uppercase; letter-spacing: 0.03em; }
      .news-tag-education { background: rgba(14,165,233,0.15); color: var(--sky-500); }
      .news-tag-news { background: rgba(139,92,246,0.15); color: var(--violet); }
      .news-tag-guide { background: rgba(20,184,166,0.15); color: var(--teal); }

      /* ---------------- Modals ---------------- */
      .modal-overlay {
        position: fixed; inset: 0; background: rgba(12,74,110,0.3); backdrop-filter: blur(6px);
        z-index: 60; display: flex; align-items: center; justify-content: center; padding: 20px;
      }
      .modal-card {
        background: rgba(255,255,255,0.92); backdrop-filter: blur(30px);
        border: 1px solid rgba(14,165,233,0.22); border-radius: 22px;
        padding: 30px; max-width: 420px; width: 100%; position: relative;
        box-shadow: 0 20px 60px rgba(14,165,233,0.25);
        animation: modalPop 0.3s ease;
      }
      @keyframes modalPop { from { transform: scale(0.92) translateY(10px); opacity: 0; } to { transform: scale(1) translateY(0); opacity: 1; } }
      .modal-close { position: absolute; top: 16px; right: 16px; }

      .invest-modal h3 { margin: 0 0 4px; font-size: 18px; }
      .invest-price-row { display: flex; justify-content: space-between; align-items: center; background: rgba(14,165,233,0.06); border-radius: 12px; padding: 10px 14px; margin: 14px 0; }

      /* ---------------- Chatbot ---------------- */
      .chat-launcher {
        position: fixed; bottom: 76px; right: 20px; z-index: 40;
        width: 56px; height: 56px; border-radius: 50%;
        background: white; border: 1px solid rgba(14,165,233,0.25);
        box-shadow: 0 8px 28px rgba(14,165,233,0.3);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; transition: transform 0.2s ease;
      }
      .chat-launcher:hover { transform: scale(1.06); }
      .chat-launcher-open { background: var(--navy); color: white; }

      .chat-panel {
        position: fixed; bottom: 142px; right: 20px; z-index: 40;
        width: min(340px, 88vw); max-height: 480px;
        display: flex; flex-direction: column; padding: 0; overflow: hidden;
        animation: modalPop 0.25s ease;
      }
      .chat-panel-header {
        display: flex; align-items: center; gap: 8px; padding: 14px 16px;
        font-weight: 700; font-size: 13.5px; border-bottom: 1px solid rgba(14,165,233,0.15);
        background: rgba(14,165,233,0.06);
      }
      .chat-panel-body { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; max-height: 280px; }
      .chat-bubble { font-size: 13px; line-height: 1.45; padding: 10px 13px; border-radius: 14px; max-width: 88%; }
      .chat-bubble-phi { background: rgba(14,165,233,0.1); align-self: flex-start; border-bottom-left-radius: 4px; }
      .chat-bubble-user { background: var(--navy); color: white; align-self: flex-end; border-bottom-right-radius: 4px; }
      .chat-panel-options { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px 16px; border-top: 1px solid rgba(14,165,233,0.1); }
      .chat-option-btn {
        text-align: left; background: rgba(139,92,246,0.08); border: 1px solid rgba(139,92,246,0.2);
        border-radius: 10px; padding: 9px 12px; font-family: 'Outfit'; font-size: 12.5px; font-weight: 600;
        color: var(--navy); cursor: pointer; transition: background 0.2s ease;
      }
      .chat-option-btn:hover { background: rgba(139,92,246,0.16); }
      .chat-option-reset { background: rgba(14,165,233,0.08); border-color: rgba(14,165,233,0.2); }
      .chat-demo-badge {
        margin-left: auto; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
        color: var(--navy); background: rgba(14,165,233,0.14); border-radius: 20px; padding: 3px 9px;
      }
      .chat-msg-wrap { display: flex; flex-direction: column; gap: 6px; }
      .chat-actions { display: flex; gap: 6px; flex-wrap: wrap; }
      .chat-action-btn {
        background: var(--navy); color: white; border: none; border-radius: 20px;
        padding: 7px 13px; font-family: 'Outfit'; font-size: 12px; font-weight: 700; cursor: pointer;
      }
      .chat-suggestions {
        display: flex; gap: 6px; flex-wrap: wrap; padding: 10px 16px 0;
      }
      .chat-suggestion-chip {
        background: rgba(139,92,246,0.08); border: 1px solid rgba(139,92,246,0.25);
        border-radius: 20px; padding: 7px 12px; font-family: 'Outfit'; font-size: 12px; font-weight: 600;
        color: var(--navy); cursor: pointer;
      }
      .chat-input-row {
        display: flex; gap: 8px; padding: 10px 14px 6px; align-items: center;
      }
      .chat-input {
        flex: 1; border: 1px solid rgba(14,165,233,0.25); border-radius: 20px;
        padding: 10px 14px; font-family: 'Outfit'; font-size: 13px; outline: none;
        background: rgba(255,255,255,0.7); color: #0f172a;
      }
      .chat-input:focus { border-color: var(--sky-500); }
      .chat-send-btn {
        flex-shrink: 0; width: 38px; height: 38px; border-radius: 50%; border: none;
        background: var(--navy); color: white; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
      }
      .chat-send-btn:disabled { opacity: 0.35; cursor: default; }
      .chat-demo-note {
        text-align: center; font-size: 10.5px; color: #64748b; padding: 2px 0 10px; font-family: 'Outfit';
      }
      .chat-thinking { display: inline-flex; gap: 5px; align-items: center; padding: 13px 16px; }
      .typing-dot {
        width: 7px; height: 7px; border-radius: 50%; background: var(--sky-500);
        animation: typing-bounce 1.2s infinite ease-in-out;
      }
      .typing-dot:nth-child(2) { animation-delay: 0.15s; }
      .typing-dot:nth-child(3) { animation-delay: 0.3s; }
      @keyframes typing-bounce {
        0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
        30% { transform: translateY(-5px); opacity: 1; }
      }

      /* ---------------- Toast ---------------- */
      .toast {
        position: fixed; bottom: 76px; left: 50%; transform: translateX(-50%);
        background: var(--navy); color: white; padding: 11px 20px; border-radius: 30px;
        font-size: 13px; font-weight: 500; box-shadow: 0 8px 24px rgba(12,74,110,0.3);
        z-index: 70; animation: toastIn 0.25s ease;
      }
      @keyframes toastIn { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }

      @media (max-width: 480px) {
        .chat-panel { right: 10px; left: 10px; width: auto; bottom: 136px; }
        .chat-launcher { right: 16px; }
      }
    `}</style>
  );
}

export default function App() {
  return (
    <PhaseErrorBoundary>
      <AppInner />
    </PhaseErrorBoundary>
  );
}
