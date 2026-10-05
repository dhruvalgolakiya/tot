import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import "./index.css";
import App from "./App";
import { totDesktop } from "./lib/desktop";

// The Mac app (electron/) draws the window chrome itself (hidden title bar, traffic lights over the
// page). This class is the one thing that tells the rest of the app it's running there — see
// index.css's drag-region rules and components that read `totDesktop` for layout.
if (totDesktop) document.documentElement.classList.add("desktop");

// Icons default to a 1.75 stroke (lucide's 2 looks heavy next to Funnel Sans at 13–14px). An explicit
// `strokeWidth` prop on an icon still wins. See DESIGN.md → Icons.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LucideProvider strokeWidth={1.75}>
      <App />
    </LucideProvider>
  </StrictMode>,
);
