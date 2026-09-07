import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);

// Register the unified service worker (OneSignal push + PWA offline shell).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/OneSignalSDKWorker.js").catch(() => {
      /* SW registration is best-effort */
    });
  });
}
