/* ============================================================================
   STRIPE CLIENT — Stripe.js Elements in the WebView.
   LIVE: card funding is enabled. Uses the live publishable key (pk_live_*),
   which is public by design and safe to embed. The secret key never leaves
   the backend. Webhook: https://phase-backend.onrender.com/api/v1/stripe/webhooks
============================================================================ */

// Stripe LIVE publishable key (pk_live_*). Public by design — safe to embed.
const PUBLISHABLE_KEY = "pk_live_51UL8rLA8lt1Plp3AEbLjNnLQoiYdcLrYzQO5Icq5TVbrL8kCtPFQhTj4B1WiYqsFrj59TlEtV0DDTJGSDg8gxznm00q";

let stripePromise = null;

function loadStripeJs() {
  if (stripePromise) return stripePromise;
  stripePromise = new Promise((resolve, reject) => {
    if (window.Stripe) return resolve(window.Stripe(PUBLISHABLE_KEY));
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3/";
    s.async = true;
    s.onload = () => {
      if (!window.Stripe) return reject(new Error("Stripe.js failed to load."));
      resolve(window.Stripe(PUBLISHABLE_KEY));
    };
    s.onerror = () => reject(new Error("Couldn't reach Stripe. Check your connection."));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error("Stripe.js timed out.")), 20000);
  });
  return stripePromise;
}

export async function getStripe() {
  return loadStripeJs();
}

/**
 * Mount a Stripe Card Element into `mountEl`. Returns { element, destroy }.
 */
export async function mountCardElement(mountEl) {
  const stripe = await getStripe();
  const elements = stripe.elements();
  const card = elements.create("card", {
    style: {
      base: {
        fontSize: "16px",
        color: "#0f172a",
        "::placeholder": { color: "#94a3b8" },
      },
      invalid: { color: "#dc2626" },
    },
  });
  card.mount(mountEl);
  return {
    card,
    destroy() {
      try { card.destroy(); } catch { /* noop */ }
    },
  };
}

/**
 * Confirm a card payment with the PaymentIntent client secret.
 * Handles 3D Secure automatically. Returns the confirmed PaymentIntent.
 */
export async function confirmCardPayment(card, clientSecret) {
  const stripe = await getStripe();
  const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
    payment_method: { card },
  });
  if (error) throw new Error(error.message || "Card payment failed.");
  if (paymentIntent?.status !== "succeeded") {
    throw new Error(`Payment ${paymentIntent?.status || "did not complete"}.`);
  }
  return paymentIntent;
}
