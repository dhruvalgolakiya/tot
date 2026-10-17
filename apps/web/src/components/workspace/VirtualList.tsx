import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";

const OVERSCAN = 12;

/**
 * Fixed-height rows, only the ones in view rendered: a diff or a file list of any length scrolls as one of a
 * hundred lines does. `width` sets the content's width (CSS) for rows that scroll sideways; `scrollTo` brings a
 * row into view whenever it changes.
 */
export function VirtualList({
  count,
  rowHeight,
  renderRow,
  width,
  scrollTo,
  className,
  label,
}: {
  count: number;
  rowHeight: number;
  renderRow: (index: number) => ReactNode;
  width?: string;
  scrollTo?: { index: number } | null;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element || !scrollTo) return;
    const top = scrollTo.index * rowHeight;
    if (top < element.scrollTop || top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 3);
    }
  }, [scrollTo, rowHeight]);

  const first = Math.max(0, Math.floor(view.top / rowHeight) - OVERSCAN);
  const last = Math.min(count, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN);
  const rows: ReactNode[] = [];
  for (let index = first; index < last; index++) {
    rows.push(
      <div key={index} className="absolute inset-x-0" style={{ top: index * rowHeight, height: rowHeight }}>
        {renderRow(index)}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      aria-label={label}
      className={clsx("relative min-h-0 overflow-auto", className)}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setView((current) => (Math.abs(current.top - top) < rowHeight / 2 ? current : { ...current, top }));
      }}
    >
      <div className="relative" style={{ height: count * rowHeight, width: width ?? "100%", minWidth: "100%" }}>
        {rows}
      </div>
    </div>
  );
}
