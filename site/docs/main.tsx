import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import "../site.css";
import "./docs.css";
import { DocsApp } from "./DocsApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LucideProvider strokeWidth={1.75}>
      <DocsApp />
    </LucideProvider>
  </StrictMode>,
);
