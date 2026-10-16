import { lazy, type ComponentType, type LazyExoticComponent } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any props: this only wraps components.
type AnyComponent = ComponentType<any>;

export type PreloadableComponent<C extends AnyComponent> = LazyExoticComponent<C> & {
  /** Fetch the component's chunk ahead of its first render. */
  preload: () => Promise<unknown>;
};

/**
 * A named export of a module that loads on its first render (its own chunk, out of the main bundle), with
 * `preload` to fetch it earlier, e.g. while the app is idle.
 */
export function lazyComponent<M extends Record<K, AnyComponent>, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): PreloadableComponent<M[K]> {
  return Object.assign(
    lazy(() => load().then((module) => ({ default: module[name] }))),
    { preload: load },
  );
}
