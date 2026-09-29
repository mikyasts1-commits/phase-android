import React from "react";
import { createRoot } from "react-dom/client";
import App from "./PhaseApp.jsx";
import { initSentry } from "./sentry.js";
import "./index.css";

initSentry();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
