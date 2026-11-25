import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AppErrorBoundary from "./AppErrorBoundary";
import { ConfirmationProvider } from "./ConfirmationDialog";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <ConfirmationProvider>
        <App />
      </ConfirmationProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
