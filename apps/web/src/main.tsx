import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App.js";

import "./theme.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Unable to initialize Muse web app: #root container not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
