import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

async function start() {
  const privateTools =
    import.meta.env.DEV ||
    (import.meta.env.VITE_APP_AUTH_MODE !== "account" &&
      import.meta.env.VITE_APP_PRIVATE_TOOLS === "true");
  if (privateTools && location.pathname === "/diagnostic-preview") {
    const { default: DiagnosticPreview } = await import("./diagnostic-preview/DiagnosticPreview");
    const root = document.getElementById("root");
    if (!root) throw new Error("Missing #root");
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <DiagnosticPreview />
      </React.StrictMode>,
    );
    return;
  }
  if (privateTools && location.pathname === "/dogfood") {
    const { default: Dogfood } = await import("./Dogfood");
    const root = document.getElementById("root");
    if (!root) throw new Error("Missing #root");
    ReactDOM.createRoot(root).render(<Dogfood />);
    return;
  }
  const { hydrateAccessFromHash } = await import("./api");
  if (import.meta.env.VITE_APP_AUTH_MODE !== "account") await hydrateAccessFromHash();
  const { default: App } = await import("./App");

  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root");

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
