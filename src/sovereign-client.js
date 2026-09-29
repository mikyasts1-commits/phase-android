/**
 * Sovereign Ledger client — Phase 1 MVP.
 *
 * Creates real sovereign chains via the backend API and submits Ed25519-signed
 * transactions. Uses Web Crypto API for key generation/signing (no dependencies).
 *
 * TESTNET / EXPERIMENTAL: backend state is in-memory only.
 */

// Base URL is centralized in API_CONFIG (PhaseApp.jsx). This derives from the
// same production URL; update API_CONFIG to change environments.
const SOVEREIGN_API = "https://phase-backend.onrender.com/api/v1/sovereign";

// --- base58 (Bitcoin alphabet) ---
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(buf) {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let num = 0n;
  for (const b of buf) num = num * 256n + BigInt(b);
  let out = "";
  while (num > 0n) {
    out = B58[Number(num % 58n)] + out;
    num = num / 58n;
  }
  return "1".repeat(zeros) + out;
}

// --- Key management ---
// Generates an Ed25519 keypair, returns { publicKey (CryptoKey), pubkeyHex, address }
export async function generateWallet() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const pubkeyHex = [...rawPub].map((b) => b.toString(16).padStart(2, "0")).join("");
  const address = "ph1" + b58encode(rawPub);
  // Store private key as JWK for persistence
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: kp.publicKey, privateKey: kp.privateKey, pubkeyHex, address, jwk };
}

// Restores a wallet from stored JWK
export async function restoreWallet(jwk, pubkeyHex) {
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["sign"]);
  const rawPub = new Uint8Array(pubkeyHex.match(/../g).map((h) => parseInt(h, 16)));
  const publicKey = await crypto.subtle.importKey("raw", rawPub, { name: "Ed25519" }, true, ["verify"]);
  const address = "ph1" + b58encode(rawPub);
  return { publicKey, privateKey, pubkeyHex, address, jwk };
}

// --- Canonical JSON (sorted keys) for signing ---
function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}

// Signs a transaction object (minus signatures) and returns the signed tx
export async function signTransaction(wallet, tx) {
  const payload = {
    chain_id: tx.chain_id,
    tx_id: tx.tx_id,
    type: tx.type,
    sender: tx.sender,
    nonce: tx.nonce,
    payload: tx.payload,
    submitted_at: tx.submitted_at,
  };
  const msg = new TextEncoder().encode(canonicalize(payload));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, wallet.privateKey, msg);
  const sigHex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { ...tx, signatures: [{ pubkey: wallet.pubkeyHex, signature: sigHex }] };
}

// --- API calls ---
async function api(method, path, body) {
  const res = await fetch(SOVEREIGN_API + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

export async function createSovereignChain({ coinName, ticker, totalSupply, decimals, issuerAddress, allowMint }) {
  return api("POST", "/chains", {
    coin_name: coinName,
    ticker,
    total_supply: String(totalSupply),
    decimals: decimals || 6,
    issuer_address: issuerAddress,
    transfer_rules: { allow_mint: !!allowMint },
  });
}

export async function submitSignedTransaction(chainId, signedTx) {
  return api("POST", `/chains/${chainId}/transactions`, signedTx);
}

export async function getBalance(chainId, address) {
  return api("GET", `/chains/${chainId}/balances/${address}`);
}

export async function getChain(chainId) {
  return api("GET", `/chains/${chainId}`);
}

export function newTxId() {
  return crypto.randomUUID();
}
