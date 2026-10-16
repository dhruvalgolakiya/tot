import type { ProviderStatus } from "../../shared/types.ts";
import { providerStatuses } from "../agent/providers/index.ts";

/** Which providers are signed in and with which models, for orchestration's own choices; tests swap in a fixture. */
let source: () => Promise<ProviderStatus[]> = () => providerStatuses();

export const statuses = {
  get(): Promise<ProviderStatus[]> {
    return source();
  },
  use(fake: (() => Promise<ProviderStatus[]>) | null): void {
    source = fake ?? (() => providerStatuses());
  },
};
