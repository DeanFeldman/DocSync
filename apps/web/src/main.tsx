import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AppErrorBoundary from "./AppErrorBoundary";
import AuthGate from "./AuthGate";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <AuthGate><App /></AuthGate>
    </AppErrorBoundary>
  </StrictMode>,
);
