/* ============================================================================
   FEATURE FLAGS — flip these to enable/disable in-progress features.
   Each flag is a single boolean so a feature can be turned on or off
   without any other code changes.
============================================================================ */

// MARKETPLACE_LOCKED: when true, the Marketplace tab renders its content
// blurred behind a "Marketplace opening soon" lock overlay, until the crypto
// funding rails (USDC and USDT deposits) are finished and trading goes live.
// Set to false to restore the normal marketplace with no overlay or blur.
export const MARKETPLACE_LOCKED = true;

// CRYPTO_FUNDING_LOCKED: when true, the Fund Account modal renders its content
// blurred behind a "coming soon" lock card until the crypto deposit rails
// (USDC and USDT) are wired up. Funding is crypto-only: fiat methods
// (card, Interac, wire, ACH, Cash App) have been removed entirely.
// Set to false to enable the crypto funding flow.
export const CRYPTO_FUNDING_LOCKED = false;

// GO_LIVE_LOCKED: when true, the Go Live tab renders its content blurred
// behind a lock card instead of the operable coin-issuance form, until the
// legal review of user-issued coins is complete.
// Set to false to restore the issuance form.
export const GO_LIVE_LOCKED = false;

// DASHBOARD_LOCKED: when true, the Dashboard shows a simple "fund your
// account" empty state instead of simulated portfolio and net-worth figures.
// Set to false to restore the dashboard.
export const DASHBOARD_LOCKED = true;
