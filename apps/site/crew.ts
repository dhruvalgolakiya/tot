import type { MascotSpec } from "@tot/shared/types";
import { defaultMascot } from "../web/src/components/mascot";

/** The cast of the landing page: a handful of agents who show up in several sections. */
export const crew = {
  tot: { name: "Tot", spec: defaultMascot },
  perry: { name: "Perry", spec: { shape: "pear", color: "#4ade80", accessory: "glasses", eyes: "dots" } },
  mochi: { name: "Mochi", spec: { shape: "cat", color: "#f472b6", accessory: "beret", eyes: "happy" } },
  bolt: { name: "Bolt", spec: { shape: "bot", color: "#60a5fa", accessory: "antenna", eyes: "wide" } },
  nova: { name: "Nova", spec: { shape: "star", color: "#fbbf24", accessory: "crown", eyes: "happy" } },
  ribbit: { name: "Ribbit", spec: { shape: "frog", color: "#34d399", accessory: "sunglasses", eyes: "dots" } },
  boo: { name: "Boo", spec: { shape: "ghost", color: "#818cf8", accessory: "scarf", eyes: "dots" } },
  nimbus: { name: "Nimbus", spec: { shape: "cloud", color: "#22d3ee", accessory: "cap", eyes: "sleepy" } },
  rosy: { name: "Rosy", spec: { shape: "heart", color: "#fb7185", accessory: "bowtie", eyes: "happy" } },
  splash: { name: "Splash", spec: { shape: "drop", color: "#fb923c", accessory: "headphones", eyes: "wide" } },
} satisfies Record<string, { name: string; spec: MascotSpec }>;

export type CrewMember = keyof typeof crew;
