import { createContext, useContext } from "react";
import type { AppId } from "./ids";

export type Layout = "desktop" | "phone";

/** What every app can ask of the "OS" it runs in: open another app, open the launcher, and which shell it's in. */
export const OsContext = createContext<{ open: (id: AppId) => void; search: () => void; layout: Layout }>({
  open: () => {},
  search: () => {},
  layout: "desktop",
});

export const useOs = () => useContext(OsContext);
