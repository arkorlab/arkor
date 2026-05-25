import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./lib/fonts";
import "./styles.css";

const rootElement = document.querySelector("#root");
if (!rootElement) throw new Error("Studio bootstrap failed: #root not found");
const root = createRoot(rootElement);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
