import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

async function start() {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root");
  // Synthetic diagnostic preview is a development-only design tool.
  if (import.meta.env.DEV && location.pathname === "/diagnostic-preview") {
    const { default: DiagnosticPreview } = await import("./diagnostic-preview/DiagnosticPreview");
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <DiagnosticPreview />
      </React.StrictMode>,
    );
    return;
  }
  const { default: App } = await import("./App");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
