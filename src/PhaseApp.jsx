import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { checkForUpdates, dismissUpdate, UpdateDialog } from "./update-check.jsx";
import { MARKETPLACE_LOCKED, CRYPTO_FUNDING_LOCKED, GO_LIVE_LOCKED, DASHBOARD_LOCKED } from "./feature-flags.js";
import { generateWallet, restoreWallet, createSovereignChain } from "./sovereign-client.js";
import { mountCardElement, confirmCardPayment } from "./stripe-client.js";

/* ------------------------- Phase backend API client ------------------------- */
// Real backend: issuance (draft → agreement → sign → mint) and funding.
const PHASE_BACKEND_URL = "https://phase-backend.onrender.com/api/v1";

async function backendFetch(path, { method = "GET", body, idempotencyKey } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${PHASE_BACKEND_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
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

const issuanceApi = {
  createDraft: (draft) => backendFetch("/issuance/draft", { method: "POST", body: draft }),
  getAgreement: (draftId) =>
    backendFetch(`/issuance/agreement?draftId=${encodeURIComponent(draftId)}`),
  signAgreement: (draftId, legalName) =>
    backendFetch("/issuance/sign", { method: "POST", body: { draftId, legalName, accepted: true } }),
  mint: (draftId, { meme = false, idempotencyKey } = {}) =>
    backendFetch("/issuance/mint", {
      method: "POST",
      body: { draftId, meme },
      idempotencyKey: idempotencyKey || `mint-${draftId}-${Date.now()}`,
    }),
};

const socialApi = {
  getProviders: () => backendFetch("/social/providers"),
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
  // Stripe card funding (test mode)
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
   Single-file React prototype. Light-blue glass aesthetic, Φ as living mark.
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

// Simulated PHASE Coin inflow dropped into a chain's own portfolio pool
// every background cycle, per the "16,000 PHASE Coin Network Inflow
// Engine" — purely a visual/simulated drip tied to the chain being live,
// not a real monetary system.
const PHASE_CHAIN_INFLOW_PER_CYCLE = 16000;

// Per-tick share-price jitter bounds for the sovereign chain price daemon.
const CHAIN_JITTER_PCT = 0.015;

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

const ONCHAINING_TERMS = `Phase Sovereign Chain Terms & Consent (Prototype Summary)

1. Accuracy of Information. By provisioning a sovereign chain, you confirm that the description, social proof metrics, and any supporting documentation you provide are accurate to the best of your knowledge.

2. Isolated Ledger. Your chain is a dedicated, sandboxed ledger instance — its trading activity, liquidity, and volatility are isolated from every other chain on Phase and cannot affect or be affected by them.

3. Share Split & Pricing. The public/retained split and starting share price you configure at provisioning are yours to set. 1,000,000 fractional shares are minted at genesis and allocated accordingly.

4. No Guarantee of Value. Share prices reflect simulated market activity in this prototype and are not guaranteed. Phase does not provide investment advice.

5. Revocability. Phase reserves the right to suspend a chain if the underlying information is found to be inaccurate or fraudulent.

This is a condensed prototype summary for demonstration purposes and is not a binding legal agreement.`;

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

TEMPLATE ONLY — This document is generated automatically from information provided. It is a template illustration for demonstration purposes, not a binding legal agreement and not a substitute for independent legal advice. Have legal counsel review before relying on it.`;
function generateAgreementText({ ownerName, listingName, valueThesis, equityPublic, equityRetained, docLabel }) {
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return `PHASE ISSUER AGREEMENT \u2014 TEMPLATE
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

5. Purchaser Acknowledgments. Each Purchaser acknowledges that: (i) no return is guaranteed and the Coin's value may fall to zero; (ii) the Coin trades on an isolated ledger whose price moves independently of any other chain; (iii) this is a prototype market for demonstration purposes.

6. Term. This Agreement remains in effect for as long as any shares of the Coin are publicly held.

7. Governing Terms. This Agreement incorporates Phase's Onchaining Terms & Consent by reference.

Signed: ${ownerName || "[Issuer legal name]"} \u2014 ${date}

TEMPLATE ONLY \u2014 This document is generated automatically from information Issuer provided. It is a template illustration for demonstration purposes, not a binding legal agreement and not a substitute for independent legal advice. Have legal counsel review before relying on it.`;
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

// Lightweight seed data for mock marketplace listings, one to two per
// subsection. These are clearly fictional and exist to make the directory
// feel populated before a real user publishes anything. hydrateMockAsset()
// below expands each into the same shape a real published asset uses.
const MOCK_LISTINGS_SEED = [
  // Public Stocks (fictional flagship-scale companies mirrored onto Nasdaq's
  // tokenization rail \u2014 no real public company names are used as
  // investable products here, but each is written at the scale and
  // specificity of an actual market leader in its sector)
  { name: "Veyronix Silicon", ticker: "VYRX.m", category: "stocks", subsection: "Technology", network: "nasdaq", tagline: "The dominant fabless designer of edge-AI inference chips, with a market capitalization near $2.1 trillion and silicon inside most flagship phones and AI PCs sold worldwide.", price: 70.92, prevPrice: 71.05, authorityScore: 94, marketCap: "$2.1T" },
  { name: "Quorvex Compute", ticker: "QRVX.m", category: "stocks", subsection: "Technology", network: "nasdaq", tagline: "The leading accelerated-computing platform powering large-scale AI training, with a market capitalization near $3.4 trillion across its data center and software segments.", price: 157.82, prevPrice: 157.11, authorityScore: 96, marketCap: "$3.4T" },
  { name: "Lucenna Therapeutics", ticker: "LUCN.m", category: "stocks", subsection: "Healthcare", network: "nasdaq", tagline: "A top-five global pharmaceutical manufacturer with a market capitalization near $740 billion, anchored by a blockbuster metabolic disease franchise.", price: 23.12, prevPrice: 22.92, authorityScore: 88, marketCap: "$740B" },
  { name: "Solmark Financial", ticker: "SLMK.m", category: "stocks", subsection: "Financials", network: "nasdaq", tagline: "A bulge-bracket global investment bank with a market capitalization near $310 billion, spanning trading, advisory, and asset management.", price: 51.51, prevPrice: 51.67, authorityScore: 85, marketCap: "$310B" },
  { name: "Aerodyne Commerce", ticker: "ARDC.m", category: "stocks", subsection: "Consumer Discretionary", network: "nasdaq", tagline: "The largest e-commerce and logistics retailer in its region, with a market capitalization near $1.6 trillion and same-day delivery to most major metro areas.", price: 33.72, prevPrice: 33.53, authorityScore: 90, marketCap: "$1.6T" },
  { name: "Helivant Energy", ticker: "HLVT.m", category: "stocks", subsection: "Energy", network: "nasdaq", tagline: "An integrated supermajor with upstream, midstream, and refining operations across four continents, market capitalization near $480 billion.", price: 47.90, prevPrice: 48.14, authorityScore: 82, marketCap: "$480B" },
  { name: "Voltrix Motors", ticker: "VLTX.m", category: "stocks", subsection: "Consumer Discretionary", network: "nasdaq", tagline: "The category-defining electric vehicle and energy storage manufacturer, market capitalization near $980 billion, with vertically integrated battery production.", price: 248.30, prevPrice: 245.10, authorityScore: 93, marketCap: "$980B" },
  { name: "Nexalink Holdings", ticker: "NXLK.m", category: "stocks", subsection: "Technology", network: "nasdaq", tagline: "The parent company of the world's largest social and messaging platforms by daily active users, market capitalization near $920 billion.", price: 612.40, prevPrice: 608.95, authorityScore: 91, marketCap: "$920B" },

  // Private Stocks & Pre-IPO
  { name: "Vector Orbital Systems \u2014 Core Secondary SPV", ticker: "pVECTOR", category: "privateStocks", subsection: "Special Purpose Vehicles (SPVs)", network: "phaseNative", tagline: "A single-purpose vehicle holding a secondary position in a fictional private orbital launch company ahead of a potential IPO.", price: 217.44, prevPrice: 217.61, authorityScore: 75 },
  { name: "Cognivault Labs \u2014 Series G Fractional", ticker: "pCOGNI", category: "privateStocks", subsection: "Late-Stage Venture", network: "phaseNative", tagline: "Late-stage equity in a fictional private foundation-model AI lab preparing for a public listing.", price: 99.80, prevPrice: 99.76, authorityScore: 67 },

  // Real Estate
  { name: "Austin Multi-Family Residential Yield", ticker: "rATX-RES", category: "realEstate", subsection: "Residential", network: "phaseNative", tagline: "A 1,200-unit institutional-grade multi-family residential portfolio across four stabilized Austin properties, generating consistent monthly rental income.", price: 113.95, prevPrice: 114.71, authorityScore: 80 },
  { name: "NYC Logistics Hub Commercial Trust", ticker: "rNYC-COM", category: "realEstate", subsection: "Commercial", network: "phaseNative", tagline: "A 2.4-million-square-foot last-mile logistics and distribution complex serving the greater New York metro area, leased to a long-term anchor tenant.", price: 410.30, prevPrice: 410.05, authorityScore: 86 },

  // Energy
  { name: "West Texas Wind Farms (Tokenized Yield)", ticker: "eWTX-WT", category: "energy", subsection: "Renewables", network: "phaseNative", tagline: "A utility-scale West Texas wind portfolio under long-term power purchase agreements with regional utilities.", price: 186.37, prevPrice: 186.93, authorityScore: 79 },
  { name: "Permian Basin Midstream Fractional", ticker: "ePRM-OIL", category: "energy", subsection: "Oil & Gas", network: "phaseNative", tagline: "Fractional royalty interest in Permian Basin midstream infrastructure, paying out a share of throughput revenue.", price: 52.33, prevPrice: 52.46, authorityScore: 58 },

  // Finance \u2014 private credit and venture funds are fictional; the four
  // tokenized Treasury/money-market funds below reference real, named funds
  // and the real networks that actually issue them.
  { name: "Middle-Market Senior Secured Loan Fund", ticker: "cMM-SEC", category: "finance", subsection: "Private Credit", network: "phaseNative", tagline: "A senior secured private credit fund lending to lower-middle-market businesses at fixed yield.", price: 106.28, prevPrice: 106.53, authorityScore: 72 },
  { name: "B2B SaaS ARR Factoring Pool", ticker: "cSaaS-ARR", category: "finance", subsection: "Venture & Private Equity", network: "phaseNative", tagline: "A revenue-based financing pool that advances capital against recurring SaaS revenue contracts.", price: 28.23, prevPrice: 28.37, authorityScore: 61 },
  { name: "Fidelity Treasury Digital Fund \u2014 OnChain (FYHXX)", ticker: "FYHXX", category: "finance", subsection: "Tokenized Funds", network: "fidelity", tagline: "Onchain share class of Fidelity's Treasury Digital Fund, recorded onchain, holding cash and U.S. Treasury securities.", price: 1.24, prevPrice: 1.25, authorityScore: 90, learnMoreUrl: "https://finance.yahoo.com/quote/FYHXX" },
  { name: "BlackRock USD Institutional Digital Liquidity Fund (BUIDL)", ticker: "BUIDL", category: "finance", subsection: "Tokenized Funds", network: "ethereum", tagline: "A tokenized fund holding cash and U.S. Treasury bills, issued on Ethereum in partnership with Securitize.", price: 1.05, prevPrice: 1.04, authorityScore: 92, learnMoreUrl: "https://en.wikipedia.org/wiki/BlackRock" },
  { name: "Ondo Short-Term US Government Treasuries (OUSG)", ticker: "OUSG", category: "finance", subsection: "Tokenized Funds", network: "ethereum", tagline: "A tokenized fund providing exposure to short-term U.S. government Treasuries, issued on Ethereum.", price: 0.99, prevPrice: 0.99, authorityScore: 86, learnMoreUrl: "https://en.wikipedia.org/wiki/Ondo_Finance" },
  { name: "Canton Network Wholesale Settlement Coin", ticker: "cUSD-W", category: "finance", subsection: "Tokenized Funds", network: "canton", tagline: "Tracks tokenized wholesale settlement activity on the Canton Network, the institutional rail used by DTCC for onchain Treasury custody pilots.", price: 95.99, prevPrice: 95.97, authorityScore: 88, learnMoreUrl: "https://en.wikipedia.org/wiki/Canton_Network" },

  // Small Businesses
  { name: "Toronto Premium Hospitality Pool", ticker: "sTO-REST", category: "smallBusiness", subsection: "Hospitality & Retail", network: "phaseNative", tagline: "A pooled vault of profitable Toronto-area restaurants and hospitality venues with consistent cash flow.", price: 9.64, prevPrice: 9.56, authorityScore: 55 },
  { name: "Boutique Retail Franchise Vault", ticker: "sRTL-FRAN", category: "smallBusiness", subsection: "Hospitality & Retail", network: "phaseNative", tagline: "A vault of boutique retail franchise locations generating royalty and franchise-fee income.", price: 12.03, prevPrice: 12.13, authorityScore: 60 },
  { name: "Midwest Last-Mile Logistics Fleet", ticker: "sMW-LOG", category: "smallBusiness", subsection: "Logistics & Supply", network: "phaseNative", tagline: "A fleet of last-mile delivery contracts across the Midwest, generating recurring logistics revenue.", price: 14.51, prevPrice: 14.63, authorityScore: 63 },
  { name: "Tri-State Municipal Fiber Expansion", ticker: "sTS-FIBR", category: "smallBusiness", subsection: "Local Infrastructure", network: "phaseNative", tagline: "A municipal fiber-optic buildout generating recurring infrastructure access fee revenue.", price: 7.68, prevPrice: 7.61, authorityScore: 49 },

  // Social Media & Audience Capital (fictional creators written at the scale
  // of genuine top-tier influencers \u2014 no real public figures are used)
  { name: "Top-Tier Tech Review Channel Equity", ticker: "aYT-TECH", category: "socialMedia", subsection: "YouTube Content Channels", network: "phaseNative", tagline: "One of the largest technology review channels in the world, with over 28 million subscribers and a multi-year exclusive sponsorship deal with three Fortune 500 hardware brands.", followers: "28400000", engagement: "6.4", price: 184.20, prevPrice: 182.65, authorityScore: 89 },
  { name: "Global Pop Culture Network", ticker: "aTK-POP", category: "socialMedia", subsection: "TikTok Creators", network: "phaseNative", tagline: "A top-five global entertainment and pop culture account with over 61 million followers, generating revenue from platform creator funds, brand partnerships, and a licensed merchandise line.", followers: "61200000", engagement: "9.1", price: 312.80, prevPrice: 309.40, authorityScore: 92 },
  { name: "Financial Distribution Network", ticker: "aX-FIN", category: "socialMedia", subsection: "X Audience Distribution Networks", network: "phaseNative", tagline: "A leading financial commentary and newsletter network with 4.2 million combined followers across its flagship accounts and a paid subscriber base exceeding 90,000.", followers: "4200000", engagement: "5.6", price: 96.50, prevPrice: 95.80, authorityScore: 81 },

  // Arts
  { name: "Blue-Chip Fine Art Fractional (Modern Pool)", ticker: "fART-MOD", category: "arts", subsection: "High-Value Fine Art", network: "phaseNative", tagline: "A fractionalized vault of blue-chip 20th-century fine art held in climate-controlled storage with tracked provenance.", price: 10.34, prevPrice: 10.36, authorityScore: 52 },
  { name: "Generative Fine Art (Glyphwork Vault)", ticker: "vGLYPH", category: "arts", subsection: "Digital Generative Collections (NFTs)", network: "ethereum", tagline: "A generative art collection with royalties flowing back to fractional holders on every secondary sale.", price: 3.89, prevPrice: 3.87, authorityScore: 46 },

  // Collectibles
  { name: "Heritage Chronograph & Watch Basket", ticker: "wPATEK", category: "collectibles", subsection: "Chronographs & Watches", network: "phaseNative", tagline: "A basket of vintage and modern luxury chronographs, appraised and insured for fractional ownership.", price: 57.12, prevPrice: 56.83, authorityScore: 57 },
  { name: "Fine Wine & Rare Spirits Allocation Fund", ticker: "wWINE", category: "collectibles", subsection: "Rare Assets", network: "phaseNative", tagline: "A temperature-controlled allocation fund of fine wine and rare spirits held for long-term appreciation.", price: 22.83, prevPrice: 22.74, authorityScore: 50 },
  { name: "Heritage Racing & Luxury Automotive Vault", ticker: "wRACE", category: "collectibles", subsection: "Luxury Automotives", network: "phaseNative", tagline: "A vault of fully restored heritage racing and luxury automobiles with documented provenance.", price: 139.57, prevPrice: 139.08, authorityScore: 53 },

  // Sports & Talent
  { name: "Draft-Eligible QB Income Share (ISA)", ticker: "tISA-NFL26", category: "sportsTalent", subsection: "Athlete Income Share Agreements (ISAs)", network: "phaseNative", tagline: "A draft-eligible quarterback tokenizing a share of future professional contract and endorsement income.", followers: "96000", engagement: "6.1", price: 43.58, prevPrice: 43.72, authorityScore: 71 },
  { name: "ATP Tour Rising Star Income Share (ISA)", ticker: "tISA-ATP", category: "sportsTalent", subsection: "Athlete Income Share Agreements (ISAs)", network: "phaseNative", tagline: "A rising professional tennis player tokenizing future prize money and sponsorship income.", followers: "58000", engagement: "7.3", price: 20.71, prevPrice: 20.56, authorityScore: 65 },
  { name: "Phase Pipeline Quant-Alpha Dev Team", ticker: "tDEV-ALPHA", category: "sportsTalent", subsection: "Independent Developer Alpha Pipelines", network: "phaseNative", tagline: "An independent quantitative developer team tokenizing future royalties across an early trading-tools pipeline.", followers: "31000", engagement: "5.4", price: 14.56, prevPrice: 14.62, authorityScore: 48 },

  // Intellectual Property
  { name: "90s Alternative Rock Master Catalogues", ticker: "ipROCK", category: "intellectualProperty", subsection: "Music Royalty Catalogues", network: "phaseNative", tagline: "A catalogue of 1990s alternative rock master recordings with steady sync licensing and streaming royalty income.", price: 26.83, prevPrice: 26.71, authorityScore: 68 },
  { name: "LEO Satellite Communication Patent Pool", ticker: "ipSAT-PAT", category: "intellectualProperty", subsection: "Patent Pools", network: "phaseNative", tagline: "A pool of low-earth-orbit satellite communication patents generating licensing income from three operators.", price: 16.81, prevPrice: 16.87, authorityScore: 54 },
  { name: "Open Restaking Primitive Extension", ticker: "ipOSS-RSTK", category: "intellectualProperty", subsection: "Open-Source Software Protocols", network: "ethereum", tagline: "A funding pool backing an open-source restaking protocol extension, distributing a share of protocol fee revenue to backers.", price: 7.78, prevPrice: 7.73, authorityScore: 45 },
];

function platformFromSubsection(subsection) {
  if (!subsection) return null;
  if (subsection.includes("YouTube")) return "YouTube";
  if (subsection.includes("TikTok")) return "TikTok";
  if (subsection.includes("X Audience")) return "X";
  return null;
}

function hydrateMockAsset(seed) {
  const price = seed.price;
  // History ends on the actual current price, with the second-to-last point
  // anchored to the seed's explicit prevPrice (if given) so the displayed
  // 24h change% matches the curated reference figures exactly, while earlier
  // history points still vary for a believable sparkline shape.
  const prevPrice = seed.prevPrice != null ? seed.prevPrice : price;
  const history = Array.from({ length: 11 }, () => price * (0.96 + Math.random() * 0.08));
  history.push(prevPrice, price);
  const network = seed.network || "phaseNative";
  // Only listings settling on Phase's own rail are sovereign chains issued
  // through the Go Live flow — assets brought in from Canton, Nasdaq,
  // Fidelity, or Ethereum are already-verified products living on someone
  // else's network, so they don't get a Phase-issued chainId.
  const isSovereignChain = network === "phaseNative";
  const publicShares = isSovereignChain ? Math.round(SOVEREIGN_TOTAL_SHARES * 0.25) : null;
  return {
    id: uid(),
    name: seed.name,
    ticker: seed.ticker || "",
    category: seed.category,
    subsection: seed.subsection,
    network,
    tagline: seed.tagline,
    marketCap: seed.marketCap || null,
    platform: seed.followers ? platformFromSubsection(seed.subsection) || "YouTube" : null,
    followers: seed.followers || "",
    engagement: seed.engagement || "",
    socialUrl: null,
    socialProfiles: [],
    verification: null, // no social verification yet -- links render as plain unverified links
    compliance: { docFileName: "on-file.pdf", licenseNumber: "DEMO-" + uid().toUpperCase(), consented: true },
    equityPublic: 25,
    equityRetained: 75,
    price,
    prevPrice,
    history,
    tickDir: "up",
    tickDirection: "FLAT",
    isOwner: false,
    isMock: true,
    authorityScore: seed.authorityScore,
    // External "learn more" link. Mock listings reference real, named
    // companies/funds/networks, so a search link to a finance/reference
    // source is genuinely useful here; explicit overrides win when provided.
    learnMoreUrl:
      seed.learnMoreUrl ||
      `https://www.google.com/search?q=${encodeURIComponent(seed.name + " finance")}`,

    // Sovereign ledger fields — only populated for Phase-native chains.
    chainId: isSovereignChain ? generateChainId() : null,
    zeroBaseFee: isSovereignChain,
    totalMinted: isSovereignChain ? SOVEREIGN_TOTAL_SHARES : null,
    publicFloatShares: publicShares,
    retainedShares: isSovereignChain ? SOVEREIGN_TOTAL_SHARES - publicShares : null,
    chainHistory: isSovereignChain ? [genesisBlock(seed.name, seed.ticker || "PHASE")] : [],
    phaseCoinPool: isSovereignChain ? 0 : null,
  };
}

/* ------------------------- Phi guide brain (demo) ------------------------- */
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
      text: "The Issuer Agreement is the contract you sign when you go live \u2014 a commitment to everyone who buys your coin covering who you are, the accuracy of your statements, and how value is shared. You can preview the PDF in the signing step. It's a template for now; legal counsel reviews it before any real offering.",
      suggestions: ["How do I go live?", "How does investing work?"],
    };
  }
  if (has("invest", "buy", "purchase", "allocat")) {
    return {
      text: "The Marketplace is the live directory of every listed person, business, and asset. Pick one, choose your currency \u2014 cash, stablecoin, or crypto \u2014 and invest. In this alpha everything is simulated, so explore freely.",
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
      text: "This alpha is completely free and fully simulated \u2014 no real money moves. When Phase connects live rails, fees and terms will be shown before you confirm anything.",
      suggestions: ["How do I go live?", "How does investing work?"],
    };
  }
  if (has("wallet", "fund", "usdc", "circle", "deposit", "crypto")) {
    return {
      text: "Funding in the alpha is simulated \u2014 you can add test balances from the Dashboard. Live USDC funding on testnet is being wired on the backend; it'll plug in here when ready.",
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
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        className={animated && !reduceMotion ? "phi-mark phi-mark-animated" : "phi-mark"}
      >
        <defs>
          <linearGradient id="phiStroke" x1="0" y1="0" x2="64" y2="64">
            <stop offset="0%" stopColor="#0ea5e9" />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>
        {/* outer loop */}
        <ellipse
          className="phi-ring"
          cx="32"
          cy="34"
          rx="17"
          ry="20"
          stroke="url(#phiStroke)"
          strokeWidth="4.5"
          fill="none"
        />
        {/* vertical settlement stroke */}
        <line
          className="phi-stroke"
          x1="32"
          y1="6"
          x2="32"
          y2="62"
          stroke="url(#phiStroke)"
          strokeWidth="4.5"
          strokeLinecap="round"
        />
      </svg>
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
    case "lock":
      return (
        <svg {...common}>
          <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="12" cy="15.2" r="1.2" fill="currentColor" />
        </svg>
      );
    default:
      return null;
  }
}

/* ===========================================================================
   APP
=========================================================================== */

export default function App() {
  const [activeTab, setActiveTab] = useState("golive"); // golive | market | dashboard
  const isAndroid = useMemo(() => /Android/.test(navigator.userAgent || ""), []);
  const [showNews, setShowNews] = useState(false);
  const [showBonusModal, setShowBonusModal] = useState(true);
  const [updateInfo, setUpdateInfo] = useState(null); // GitHub release update offer
  const [phaseCoins, setPhaseCoins] = useState(0);
  const [currency, setCurrency] = useState("usd");
  const [assets, setAssets] = useState(() => MOCK_LISTINGS_SEED.map(hydrateMockAsset)); // live directory, seeded with mock listings
  const [holdings, setHoldings] = useState([]); // { assetId, units, costBasisUsd }
  const [txHistory, setTxHistory] = useState([]);
  const [cashBalances, setCashBalances] = useState({}); // { usd: 0, cad: 0, usdc: 0, ... } funded cash, separate from PHASE coins
  const [cryptoFunded, setCryptoFunded] = useState(false); // true once real testnet balances are detected
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
        console.warn("sovereign wallet init failed", e);
      }
    })();
  }, []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // Poll real crypto funding balances — unlocks the dashboard once testnet
  // deposits land (or once the user mints their own coin).
  const refreshFundingStatus = useCallback(async () => {
    try {
      const data = await fundingApi.getBalances("app-user");
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

  // In-app update check — once per launch, silent unless a newer GitHub
  // release exists and this version wasn't snoozed.
  useEffect(() => {
    let cancelled = false;
    checkForUpdates().then((info) => {
      if (!cancelled && info) setUpdateInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live FX rate drift \u2014 simulates real-time currency data so portfolio
  // valuation actually shifts per-currency on the dashboard, not just per-asset.
  useEffect(() => {
    const interval = setInterval(() => {
      setLiveFx((prev) => {
        const next = { ...prev };
        Object.keys(BASE_FX).forEach((id) => {
          if (id === "usd") return; // USD is the numeraire, stays fixed
          const driftPct =
            CURRENCIES.find((c) => c.id === id)?.group === "Crypto"
              ? (Math.random() - 0.5) * 0.012
              : (Math.random() - 0.5) * 0.0015;
          next[id] = prev[id] * (1 + driftPct);
        });
        return next;
      });
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  // Live price simulation — also doubles as the sovereign chain's "sensory
  // price daemon": every tick appends a block to that chain's isolated
  // history and stamps an explicit UP/DOWN/FLAT direction. Each asset's
  // jitter is entirely self-contained, so one chain's volatility can never
  // spill into another's price or liquidity.
  useEffect(() => {
    const interval = setInterval(() => {
      setAssets((prev) =>
        prev.map((a) => {
          const pctMove = (Math.random() - 0.48) * (a.chainId ? CHAIN_JITTER_PCT : 0.018);
          const newPrice = Math.max(0.5, a.price * (1 + pctMove));
          const history = [...a.history.slice(-23), newPrice];
          const direction = newPrice > a.price ? "UP" : newPrice < a.price ? "DOWN" : "FLAT";

          if (!a.chainId) {
            return { ...a, prevPrice: a.price, price: newPrice, history, tickDir: direction === "DOWN" ? "down" : "up" };
          }

          // Sovereign-chain assets also accrue block history and a slow
          // PHASE coin drip into their own isolated pool while live.
          const nextBlock = {
            height: a.chainHistory.length,
            label: `Block ${a.chainHistory.length}`,
            detail: `Price tick ${direction === "UP" ? "▲" : direction === "DOWN" ? "▼" : "→"} ${formatCurrency(newPrice, "usd", BASE_FX)}`,
            time: Date.now(),
          };
          return {
            ...a,
            prevPrice: a.price,
            price: newPrice,
            history,
            tickDir: direction === "DOWN" ? "down" : "up",
            tickDirection: direction,
            chainHistory: [...a.chainHistory.slice(-49), nextBlock],
            phaseCoinPool: (a.phaseCoinPool || 0) + PHASE_CHAIN_INFLOW_PER_CYCLE,
          };
        })
      );
    }, 2500);
    return () => clearInterval(interval);
  }, []);

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

  const claimBonus = () => {
    setPhaseCoins(1000);
    setShowBonusModal(false);
    showToast("1,000 PHASE Coins added to your wallet");
  };

  const publishAsset = async (form) => {
    const initialPrice = Math.max(0.01, parseFloat(form.startingPrice) || 10);
    const letters = form.name.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 5);
    const generatedTicker = form.tickerOverride || "p" + (letters || "PHASE");
    const totalShares = Math.max(1000, parseInt(form.totalShares) || SOVEREIGN_TOTAL_SHARES);
    const publicShares = Math.round(totalShares * ((form.equityPublic || 0) / 100));
    const retainedShares = totalShares - publicShares;

    // Create a real sovereign chain on the backend (Phase 1 MVP).
    // Falls back to local-only mode if the backend is unreachable.
    let sovereignChainId = form.chainIdOverride || generateChainId();
    let sovereignLive = false;
    if (sovereignWallet) {
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
          sovereignLive = true;
        } else {
          console.warn("sovereign chain creation failed, using local mode", res.json);
        }
      } catch (e) {
        console.warn("sovereign chain creation error, using local mode", e);
      }
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
      verification: form.verification, // { status: 'verified'|'unverified', lookupFollowers, lookupEngagement }
      compliance: form.compliance, // { docFileName, licenseNumber, consented }
      equityPublic: form.equityPublic,
      equityRetained: 100 - form.equityPublic,
      price: initialPrice,
      prevPrice: initialPrice,
      history: Array.from({ length: 12 }, () => initialPrice * (0.97 + Math.random() * 0.06)),
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
      sovereignLive, // true if a real backend chain was provisioned
      zeroBaseFee: true,
      totalMinted: totalShares,
      publicFloatShares: publicShares,
      retainedShares,
      chainHistory: [genesisBlock(form.name, generatedTicker)],
      phaseCoinPool: 0, // grows via the periodic PHASE inflow engine while the chain is live
    };
    setAssets((prev) => [newAsset, ...prev]);
    showToast(
      sovereignLive
        ? `${form.name} is live on its sovereign chain`
        : `${form.name} is live (local mode — backend unreachable)`
    );
    setHasIssuedCoin(true);
    setActiveTab("market");
    return newAsset;
  };

  const invest = (asset, amountUsd, payCurrencyId) => {
    if (amountUsd <= 0) return;
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

      <TopNav
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        phaseCoins={phaseCoins}
      />

      <main className="app-main">
        {activeTab === "golive" && (
          <div className={GO_LIVE_LOCKED ? "feature-gated" : undefined}>
            {GO_LIVE_LOCKED && (
              <div className="feature-lock-overlay">
                <div className="glass-card feature-lock-card">
                  <div className="feature-lock-mark">
                    <Icon name="lock" size={30} />
                  </div>
                  <h3 className="feature-lock-title">Coin issuance opens after legal review</h3>
                  <p className="feature-lock-sub">
                    We&apos;re completing the legal review of user-issued coins before anyone can list. Check back soon.
                  </p>
                </div>
              </div>
            )}
            <div
              className={GO_LIVE_LOCKED ? "feature-locked-blur" : undefined}
              inert={GO_LIVE_LOCKED ? true : undefined}
              aria-hidden={GO_LIVE_LOCKED ? true : undefined}
            >
              <GoLiveTab onPublish={publishAsset} />
            </div>
          </div>
        )}
        {activeTab === "market" && (
          <MarketplaceTab
            assets={assets}
            currency={currency}
            setCurrency={setCurrency}
            onInvest={invest}
            phaseCoins={phaseCoins}
            cashBalances={cashBalances}
            liveFx={liveFx}
          />
        )}
        {activeTab === "dashboard" && (
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
              onFund={fundAccount}
              txHistory={txHistory}
              onExplore={() => setActiveTab("market")}
              liveFx={liveFx}
              netWorthHistory={netWorthHistory}
              netWorthUsd={netWorthUsd}
            />
          )
        )}
      </main>

      <BottomUtilityBar onOpenNews={() => setShowNews(true)} />

      {showNews && <NewsDrawer onClose={() => setShowNews(false)} />}

      {showBonusModal && <BonusModal onClaim={claimBonus} />}

      {updateInfo && (
        <UpdateDialog
          info={updateInfo}
          onLater={() => {
            dismissUpdate(updateInfo.version);
            setUpdateInfo(null);
          }}
          onDownload={() => setUpdateInfo(null)}
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

function TopNav({ activeTab, setActiveTab, phaseCoins }) {
  const tabs = [
    { id: "golive", label: "Go Live", icon: "directory" },
    { id: "dashboard", label: "Dashboard", icon: "dashboard" },
    { id: "market", label: "Marketplace", icon: "directory" },
  ];
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
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="top-nav-right">
        <div className="phase-coin-pill" title="Your PHASE Coin balance">
          <Icon name="coin" size={15} />
          <span>{phaseCoins.toLocaleString()}</span>
        </div>
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

/* ------------------------------- Bonus Modal -------------------------------- */

function BonusModal({ onClaim }) {
  return (
    <div className="modal-overlay">
      <div className="modal-card bonus-modal">
        <ConfettiBurst />
        <PhiMark size={52} animated />
        <h2>Welcome to the network</h2>
        <p>
          You've been detected entering the space. Claim your starting balance and explore
          what's live, or publish your own value-add to the network.
        </p>
        <button className="btn-primary btn-large" onClick={onClaim}>
          <Icon name="coin" size={18} />
          Claim 1,000 Phase Coins
        </button>
      </div>
    </div>
  );
}

function ConfettiBurst() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 24 }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 0.4,
        duration: 1.6 + Math.random() * 1,
        color: ["#0ea5e9", "#8b5cf6", "#22c55e", "#14b8a6"][i % 4],
        rotate: Math.random() * 360,
      })),
    []
  );
  return (
    <div className="confetti-wrap" aria-hidden="true">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="confetti-piece"
          style={{
            left: `${p.left}%`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            background: p.color,
            transform: `rotate(${p.rotate}deg)`,
          }}
        />
      ))}
    </div>
  );
}

/* =============================== GO LIVE TAB ================================ */

function GoLiveTab({ onPublish }) {
  const [flowStep, setFlowStep] = useState("entry"); // entry | bringYourOwn | form | issuance
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
  const addSocialProfile = () => {
    const url = socialUrl.trim();
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
        selectedPath={selectedPath}
        choosePath={choosePath}
        chooseExample={chooseExample}
        chooseOwnThesis={chooseOwnThesis}
        onBringYourOwn={() => setFlowStep("bringYourOwn")}
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
        }}
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
        <button className="link-btn back-link" onClick={() => setFlowStep("entry")}>
          ← Back to chain type
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
          This is your chain's opening valuation anchor. It will drift with simulated market activity
          once you're live, but you set where it starts.
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
// Draft → choice (Issuer Agreement vs Meme Coin) → sign → mint on Solana devnet.
// Uses the real Phase backend. The agreement creates a covenant between the
// issuer and purchasers; the meme path explicitly mints with no agreement.
function IssuanceFlow({ coin, onBack, onComplete }) {
  const [step, setStep] = useState("choice"); // choice | social | agreement | meme | minting | done | error
  const [chosenPath, setChosenPath] = useState(null); // "agreement" | "meme"
  const [socialProviders, setSocialProviders] = useState([]);
  const [socialConns, setSocialConns] = useState([]);
  const [socialLoading, setSocialLoading] = useState(false);
  const [draftId, setDraftId] = useState(null);
  const [agreementText, setAgreementText] = useState("");
  const [agreementHash, setAgreementHash] = useState("");
  const [legalName, setLegalName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [memeConfirmed, setMemeConfirmed] = useState(false);
  const [mintResult, setMintResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(`app-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  const startDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      const draft = await issuanceApi.createDraft({
        userId: "app-user",
        name: coin.name,
        ticker: coin.ticker,
        category: coin.category || "Creator",
        tagline: coin.tagline,
        valueThesis: coin.tagline,
        equityPublic: coin.equityPublic,
        equityRetained: coin.equityRetained,
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

  const chooseAgreement = async () => {
    const id = draftId || (await startDraft());
    if (!id) return;
    setChosenPath("agreement");
    setStep("social");
    loadSocial();
  };

  const chooseMeme = async () => {
    const id = draftId || (await startDraft());
    if (!id) return;
    setChosenPath("meme");
    setStep("social");
    loadSocial();
  };

  const loadSocial = async () => {
    setSocialLoading(true);
    try {
      const [prov, conns] = await Promise.all([
        socialApi.getProviders().catch(() => ({ providers: [] })),
        socialApi.getConnections("app-user").catch(() => ({ connections: [] })),
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
      const { authorizeUrl } = await socialApi.getAuthorizeUrl(provider, "app-user");
      // Open OAuth in system browser; backend callback stores the connection.
      window.open(authorizeUrl, "_blank");
      // Poll for the new connection (user completes OAuth in browser)
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const { connections } = await socialApi.getConnections("app-user").catch(() => ({ connections: [] }));
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
      await socialApi.disconnect(provider, "app-user");
      setSocialConns(socialConns.filter((c) => c.provider !== provider));
    } catch (e) {
      setError(e.message);
    }
  };

  const continueFromSocial = async () => {
    if (chosenPath === "agreement") {
      setStep("choice");
    } else {
      setStep("meme");
    }
  };

  const signAndMint = async () => {
    if (!legalName.trim() || legalName.trim().length < 2 || !accepted) return;
    setBusy(true);
    setError(null);
    try {
      await issuanceApi.signAgreement(draftId, legalName.trim());
      setStep("minting");
      const result = await issuanceApi.mint(draftId, {
        meme: false,
        idempotencyKey: idempotencyKey.current,
      });
      setMintResult(result.coin);
      setStep("done");
      onComplete && onComplete(result.coin, false);
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
      setStep("minting");
      const result = await issuanceApi.mint(draftId, {
        meme: true,
        idempotencyKey: idempotencyKey.current,
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
    const canSign = legalName.trim().length >= 2 && accepted && !busy;
    return (
      <div className="issuance-flow">
        <button className="link-btn back-link" onClick={onBack}>
          ← Back to coin details
        </button>
        <h2 className="section-title">Issuer Agreement</h2>
        <p className="section-sub">
          {coin.ticker} · {coin.equityPublic}% public / {coin.equityRetained}% retained · 1,000,000 shares on Solana devnet
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
            I, {legalName || "[your name]"}, have read this Issuer Agreement and agree to be
            bound by its covenants to each purchaser of {coin.ticker}.
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
        <p className="section-sub">Writing your coin to Solana devnet. This takes a few seconds.</p>
        <div className="provisioning-steps">
          <div className="provisioning-step provisioning-step-active">
            <span className="provisioning-step-dot" />
            <span className="provisioning-step-label">Submitting to Solana devnet…</span>
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
      const res = await socialApi.announce("app-user", coin.name, coin.ticker, !!mintResult.isMeme);
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
          : "Issuer Agreement signed and recorded."}
      </p>
      <div className="mint-details">
        <div className="mint-detail-row">
          <span className="stat-label">Mint address</span>
          <span className="stat-value mono">{mintResult.mintAddress}</span>
        </div>
        <div className="mint-detail-row">
          <span className="stat-label">Transaction</span>
          <span className="stat-value mono">{mintResult.txSignature.slice(0, 20)}…</span>
        </div>
        <div className="mint-detail-row">
          <span className="stat-label">Supply</span>
          <span className="stat-value">1,000,000 {mintResult.ticker}</span>
        </div>
      </div>
      <a
        className="btn-secondary"
        href={`https://explorer.solana.com/address/${mintResult.mintAddress}?cluster=devnet`}
        target="_blank"
        rel="noopener noreferrer"
      >
        View on Solana Explorer
      </a>

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

function GeneratedAgreementModal({ text, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card terms-modal" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <h3>Your Generated Agreement</h3>
        <div className="terms-body agreement-body">
          {text.split("\n\n").map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
        <a
          className="btn-secondary btn-full agreement-pdf-link"
          href="docs/phase-issuer-agreement.pdf"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name="soft" size={15} /> Open the Issuer Agreement (PDF)
        </a>
        <button className="btn-primary btn-full" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function GoLivePathPicker({ selectedPath, choosePath, chooseExample, chooseOwnThesis, onBringYourOwn }) {
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
              className={`golive-path-btn ${selectedPath === key ? "golive-path-btn-active" : ""}`}
              onClick={() => choosePath(key)}
            >
              {selectedPath === key && (
                <span className="golive-path-check">
                  <Icon name="check" size={14} />
                </span>
              )}
              <span className="golive-path-icon">
                <Icon name={path.icon} size={22} />
              </span>
              <span className="golive-path-label">{path.label}</span>
              <span className="golive-path-sublabel">{path.sublabel}</span>
            </button>
          ))}
        </div>

        {selectedPath && (
          <div className="golive-examples-block">
            <label className="field-label">Choose what best describes it</label>
            <div className="golive-examples-list">
              {GOLIVE_PATHS[selectedPath].examples.map((ex) => (
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
        )}
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

        <p className="field-hint demo-hint">
          Prototype simulation — there is no live cross-chain verification here. In a production version,
          Phase would confirm this product's status directly with the source network before listing it.
        </p>

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
// Stripe.js Card Element flow: amount -> backend creates PaymentIntent ->
// Stripe-hosted card input -> confirm -> webhook credits the ledger.
// Test mode only.

function CardFundPanel({ onFunded }) {
  const [amount, setAmount] = useState("25");
  const [step, setStep] = useState("entry"); // entry | card | processing | success | error
  const [error, setError] = useState(null);
  const [credited, setCredited] = useState(null);
  const [clientSecret, setClientSecret] = useState(null);
  const [intentId, setIntentId] = useState(null);
  const cardMountRef = useRef(null);
  const cardRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (cardRef.current) {
        try { cardRef.current.destroy(); } catch { /* noop */ }
        cardRef.current = null;
      }
    };
  }, []);

  const amountMinor = Math.round(parseFloat(amount || "0") * 100);
  const amountValid = Number.isFinite(amountMinor) && amountMinor >= 50 && amountMinor <= 99999999;

  // Mount the Stripe Card Element when we reach the card step.
  useEffect(() => {
    if (step !== "card" || !cardMountRef.current || cardRef.current) return;
    let cancelled = false;
    mountCardElement(cardMountRef.current)
      .then(({ card, destroy }) => {
        if (cancelled) { destroy(); return; }
        cardRef.current = { card, destroy };
      })
      .catch((e) => {
        if (!mountedRef.current) return;
        setError(e.message);
        setStep("error");
      });
    return () => { cancelled = true; };
  }, [step]);

  const startCardStep = async () => {
    if (!amountValid) return;
    setStep("processing");
    setError(null);
    try {
      const intent = await fundingApi.createStripeIntent("app-user", amountMinor, "cad");
      if (!intent.client_secret) throw new Error("No client secret from backend.");
      if (!mountedRef.current) return;
      setClientSecret(intent.client_secret);
      setIntentId(intent.id);
      setStep("card");
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e.message || "Couldn't start payment.");
      setStep("error");
    }
  };

  const payNow = async () => {
    if (!cardRef.current) return;
    setStep("processing");
    setError(null);
    try {
      await confirmCardPayment(cardRef.current.card, clientSecret);
      // Backend polls Stripe (webhook usually beats us; confirm is idempotent).
      const conf = await fundingApi.confirmStripeIntent(intentId);
      if (!mountedRef.current) return;
      const cad = (amountMinor / 100).toFixed(2);
      setCredited(cad);
      setStep("success");
      onFunded && onFunded("cad", cad, "Card deposit");
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e.message || "Payment failed.");
      setStep("card");
    }
  };

  const backToEntry = () => {
    if (cardRef.current) {
      try { cardRef.current.destroy(); } catch { /* noop */ }
      cardRef.current = null;
    }
    setStep("entry");
    setError(null);
  };

  return (
    <div className="card-fund-panel">
      {step === "entry" && (
        <>
          <p className="section-sub">
            Top up your Phase balance instantly. Test mode — use card{" "}
            <span className="mono">4242 4242 4242 4242</span>, any future expiry, any CVC.
          </p>
          <label className="field-label">Amount (CAD)</label>
          <div className="amount-row">
            <span className="amount-currency">$</span>
            <input
              className="amount-input"
              type="number"
              min="0.50"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="25.00"
            />
          </div>
          {!amountValid && amount !== "" && (
            <p className="field-hint field-error">Enter at least CA$0.50.</p>
          )}
          <button
            className="btn btn-primary btn-large btn-full"
            onClick={startCardStep}
            disabled={!amountValid}
          >
            Continue — CA${amountValid ? (amountMinor / 100).toFixed(2) : "0.00"}
          </button>
          <p className="field-hint">Secured by Stripe. Test mode, no real charge.</p>
        </>
      )}

      {step === "card" && (
        <>
          <h3>CA{(amountMinor / 100).toFixed(2)} — card details</h3>
          <p className="section-sub">Card data goes straight to Stripe, never our servers.</p>
          <label className="field-label">Card</label>
          <div ref={cardMountRef} className="stripe-card-element" />
          {error && <p className="field-hint field-error">{error}</p>}
          <button className="btn btn-primary btn-large btn-full" onClick={payNow}>
            Pay CA{(amountMinor / 100).toFixed(2)}
          </button>
          <button className="btn btn-ghost" onClick={backToEntry}>Back</button>
        </>
      )}

      {step === "processing" && (
        <div className="funding-processing">
          <span className="spinner spinner-large" />
          <h3>Processing…</h3>
          <p className="section-sub">Talking to Stripe. Don&apos;t close.</p>
        </div>
      )}

      {step === "success" && (
        <div className="funding-done">
          <div className="funding-done-icon">
            <Icon name="check" size={22} />
          </div>
          <h3>CA${credited} added!</h3>
          <p className="section-sub">Your Phase balance is updated.</p>
          <button className="btn btn-primary" onClick={backToEntry}>
            Add more
          </button>
        </div>
      )}

      {step === "error" && (
        <div className="funding-processing">
          <h3>Something went wrong</h3>
          <p className="section-sub">{error}</p>
          <button className="btn btn-secondary" onClick={backToEntry}>Try again</button>
        </div>
      )}
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
          fundingApi.getBtcAddress("app-user"),
          fundingApi.getBtcBalance("app-user").catch(() => null),
        ]);
        if (!mountedRef.current) return;
        setDepositInfo({ addresses: { "BTC-TESTNET": addr.address }, defaultChain: "BTC-TESTNET", testnet: addr.testnet });
        setBalances(bal ? { totals: { BTC: { credited: bal.confirmedBtc, pending: bal.mempoolBtc } } } : null);
      } else {
        const [dep, bal] = await Promise.all([
          fundingApi.getDepositInfo("app-user"),
          fundingApi.getBalances("app-user").catch(() => null),
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
          const bal = await fundingApi.getBtcBalance("app-user");
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
        const bal = await fundingApi.getBalances("app-user");
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
  const testnet = depositInfo?.testnet;
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
              {testnet ? " Testnet funds — no real money." : ""}
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
              under a minute on testnet. You can close this and come back — your funds are safe.
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

function MarketplaceTab({ assets, currency, setCurrency, onInvest, phaseCoins, cashBalances, liveFx }) {
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [marketEntry, setMarketEntry] = useState("select"); // select (dropdown) | browse (all category cards)
  const [subsectionFilter, setSubsectionFilter] = useState("all");
  const [networkFilters, setNetworkFilters] = useState([]); // empty = all networks
  const [expandedId, setExpandedId] = useState(null);
  const [financialsAsset, setFinancialsAsset] = useState(null);
  const [activeAsset, setActiveAsset] = useState(null);

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
              We're finishing the crypto funding rails — USDC and USDT deposits — before trading goes live.
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
        <h2 className="section-title">The Live Directory</h2>
        <CurrencyDropdown currency={currency} setCurrency={setCurrency} />
      </div>

      {categoryFilter === "all" ? (
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
      )}

      {activeAsset && (
        <InvestModal
          asset={activeAsset}
          phaseCoins={phaseCoins}
          cashBalances={cashBalances}
          liveFx={liveFx}
          onClose={() => setActiveAsset(null)}
          onInvest={(amount, payCurrency) => {
            onInvest(activeAsset, amount, payCurrency);
            setActiveAsset(null);
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
            {(asset.socialProfiles && asset.socialProfiles.length > 0
              ? asset.socialProfiles
              : asset.socialUrl
                ? [{ platform: asset.platform, url: asset.socialUrl }]
                : []
            ).map((p, i) => (
              <a
                key={`${p.platform}-${i}`}
                className="badge badge-link"
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                View {p.platform} Profile →
              </a>
            ))}
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

function InvestModal({ asset, phaseCoins, cashBalances, liveFx, onClose, onInvest }) {
  const [amount, setAmount] = useState("");
  const [usePhase, setUsePhase] = useState(true);
  const [payCurrency, setPayCurrency] = useState("usd");

  const effectivePayId = usePhase ? "phase" : payCurrency;
  const numericAmount = parseFloat(amount) || 0;
  const availableInPayCurrency = cashBalances[payCurrency] || 0;

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

        <label className="field-label">Amount {!usePhase && `(in ${payCurrency.toUpperCase()})`}</label>
        <input
          className="text-input"
          type="number"
          placeholder="Enter an amount"
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
  onFund,
  txHistory,
  onExplore,
  liveFx,
  netWorthHistory,
  netWorthUsd,
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
          <CurrencyDropdown currency={currency} setCurrency={setCurrency} />
        </div>
        <span className="stat-label">Total Net Worth</span>
        <span className="net-worth-value">{formatCurrency(netWorthUsd, currency, liveFx)}</span>

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
              {ownedProducts.map((a) => (
                <div className="compliance-doc-row" key={a.id}>
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
              ))}
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
                  {tx.type === "fund" ? "Funded account" : "Invested in"} <strong>{tx.assetName}</strong>
                </span>
                <span className="stat-label">
                  {formatCurrency(tx.amountUsd, tx.currency, liveFx)}
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
            <span className="chat-demo-badge">Demo</span>
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
          <div className="chat-demo-note">Demo answers \u2014 live AI connects with an API key.</div>
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
      .phase-coin-pill {
        display: flex; align-items: center; gap: 6px;
        background: linear-gradient(135deg, rgba(14,165,233,0.12), rgba(139,92,246,0.12));
        border: 1px solid rgba(14,165,233,0.22);
        padding: 6px 12px; border-radius: 20px;
        font-family: 'IBM Plex Mono'; font-size: 12.5px; color: var(--navy); font-weight: 500;
      }

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
      .agreement-body { font-family: 'IBM Plex Mono'; font-size: 11.5px; }

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
      .agreement-pdf-link { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 10px; text-decoration: none; }

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
      .compliance-doc-row {
        display: flex; align-items: center; gap: 10px; padding: 8px 0;
        border-bottom: 1px solid rgba(14,165,233,0.06); font-size: 12.5px;
      }
      .compliance-doc-name { flex: 1; font-weight: 600; }
      .badge-pending { background: rgba(239,68,68,0.1); color: #991b1b; }

      .tx-list { display: flex; flex-direction: column; gap: 8px; }
      .tx-row { display: flex; justify-content: space-between; font-size: 13px; padding: 8px 0; border-bottom: 1px solid rgba(14,165,233,0.07); }

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

      .bonus-modal { text-align: center; overflow: hidden; }
      .bonus-modal h2 { margin: 16px 0 8px; font-size: 21px; }
      .bonus-modal p { font-size: 13.5px; opacity: 0.7; line-height: 1.55; margin: 0 0 6px; }

      .confetti-wrap { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
      .confetti-piece {
        position: absolute; top: -10px; width: 7px; height: 12px; opacity: 0.8;
        animation: confettiFall linear forwards;
      }
      @keyframes confettiFall {
        to { transform: translateY(420px) rotate(540deg); opacity: 0; }
      }

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
