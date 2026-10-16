import { useSyncExternalStore } from "react";
import { HomePage } from "./home/HomePage";
import { Desktop } from "./os/Desktop";
import { Phone } from "./os/Phone";

// Windows need room: smaller screens (phones, small tablets) get the home-screen version.
const roomy = window.matchMedia("(min-width: 900px) and (min-height: 600px)");
const subscribe = (listener: () => void) => {
  roomy.addEventListener("change", listener);
  return () => roomy.removeEventListener("change", listener);
};

/** `/?os` keeps the earlier landing page, Tot's own device. The OS's open apps live in the hash, so it survives them. */
const os = new URLSearchParams(location.search).has("os");

/** The landing page: Home, as the app shows it, over a pixel-art scene. */
export function Landing() {
  return os ? <TotOs /> : <HomePage />;
}

/** Tot's device: a desktop with windows, or a phone with apps. */
function TotOs() {
  const desktop = useSyncExternalStore(subscribe, () => roomy.matches);
  return desktop ? <Desktop /> : <Phone />;
}
