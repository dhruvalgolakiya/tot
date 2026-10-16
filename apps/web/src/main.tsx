import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import "./fonts.css";
import "./index.css";
import App from "./App";
import { totDesktop } from "./lib/desktop";
import { loadMarkdown } from "./lib/markdownLoader";

// An open chat waits for the markdown renderer (its own chunk): start fetching it now, alongside the app's first
// requests. (index.html's modulepreload already has the browser downloading it; this runs it.)
loadMarkdown().catch(() => {});

// The Mac app (apps/desktop/) draws the window chrome itself (hidden title bar, traffic lights over the
// page). This class is the one thing that tells the rest of the app it's running there — see
// index.css's drag-region rules and components that read `totDesktop` for layout.
if (totDesktop) document.documentElement.classList.add("desktop");

// Icons default to a 1.75 stroke (lucide's 2 looks heavy next to Inter at 13–14px). An explicit
// `strokeWidth` prop on an icon still wins. See DESIGN.md → Icons.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LucideProvider strokeWidth={1.75}>
      <App />
    </LucideProvider>
  </StrictMode>,
);
