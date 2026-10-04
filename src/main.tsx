import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import "./index.css";
import App from "./App";

// Icons default to a 1.75 stroke (lucide's 2 looks heavy next to Funnel Sans at 13–14px). An explicit
// `strokeWidth` prop on an icon still wins. See DESIGN.md → Icons.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LucideProvider strokeWidth={1.75}>
      <App />
    </LucideProvider>
  </StrictMode>,
);
