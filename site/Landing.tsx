import { useSyncExternalStore } from "react";
import { Desktop } from "./os/Desktop";
import { Phone } from "./os/Phone";

// Windows need room: smaller screens (phones, small tablets) get the home-screen version.
const roomy = window.matchMedia("(min-width: 900px) and (min-height: 600px)");
const subscribe = (listener: () => void) => {
  roomy.addEventListener("change", listener);
  return () => roomy.removeEventListener("change", listener);
};

/** The landing page is Tot's own device: a desktop with windows, or a phone with apps. */
export function Landing() {
  const desktop = useSyncExternalStore(subscribe, () => roomy.matches);
  return desktop ? <Desktop /> : <Phone />;
}
