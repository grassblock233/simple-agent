"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import type { CSSProperties, PointerEvent } from "react";
import type { ReasoningEffort } from "@/lib/types";

const levels: ReasoningEffort[] = ["off", "low", "high", "max"];
export const effortLabels: Record<ReasoningEffort, string> = { off: "关闭", low: "低", high: "高", max: "最大" };

type Props = {
  open: boolean;
  value: ReasoningEffort;
  disabled: boolean;
  saving: boolean;
  error?: string;
  onCommit: (value: ReasoningEffort) => void;
};

export default function EffortControl({ open, value, disabled, saving, error, onCommit }: Props) {
  const [position, setPosition] = useState(levels.indexOf(value));
  const [hovered, setHovered] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointer = useRef<number | null>(null);
  const draft = useRef(position);
  const unavailable = disabled || saving;
  const selected = Math.round(position);

  const move = (next: number) => { draft.current = next; setPosition(next); };
  useEffect(() => {
    if (!saving) { draft.current = levels.indexOf(value); setPosition(draft.current); }
  }, [value, saving]);
  useEffect(() => {
    if (!open) { pointer.current = null; setDragging(false); setHovered(null); draft.current = levels.indexOf(value); setPosition(draft.current); }
  }, [open, value]);

  const pointerPosition = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    // The thumb centers stay 15px inside each rounded end of the track.
    return Math.max(0, Math.min(3, (event.clientX - bounds.left - 15) / (bounds.width - 30) * 3));
  };
  const commit = (next: number) => {
    const snapped = Math.round(next);
    move(snapped);
    onCommit(levels[snapped]);
  };

  return <div className={`composer-popover effort-popover ${open ? "open" : ""}`} role="dialog" aria-label="选择思考强度" aria-hidden={!open} inert={!open}>
    <div className="effort-heading">
      <strong>{effortLabels[levels[selected]]}</strong>
      <span>deepseek-flash<ChevronRight size={12} aria-hidden="true" /></span>
      <button className="effort-reset" title="恢复默认思考强度" aria-label="恢复默认思考强度" disabled={unavailable} onClick={() => commit(2)}><RotateCcw size={17} /></button>
    </div>
    <div className={`effort-track ${dragging ? "dragging" : ""}`} role="slider" tabIndex={unavailable ? -1 : 0} aria-label="思考强度" aria-valuemin={0} aria-valuemax={3} aria-valuenow={selected} aria-valuetext={effortLabels[levels[selected]]} aria-disabled={unavailable} aria-busy={saving} aria-orientation="horizontal" style={{ "--effort-progress": position / 3 } as CSSProperties}
      onPointerDown={event => {
        if (unavailable || event.button !== 0 || !event.isPrimary) return;
        event.preventDefault(); event.currentTarget.focus();
        pointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true); move(pointerPosition(event));
      }}
      onPointerMove={event => {
        if (unavailable) return;
        const next = pointerPosition(event);
        setHovered(Math.round(next));
        if (pointer.current === event.pointerId) move(next);
      }}
      onPointerLeave={() => setHovered(null)}
      onPointerUp={event => {
        if (pointer.current !== event.pointerId) return;
        pointer.current = null; setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
        commit(pointerPosition(event));
      }}
      onPointerCancel={() => { pointer.current = null; setDragging(false); move(levels.indexOf(value)); setHovered(null); }}
      onLostPointerCapture={() => {
        if (pointer.current !== null) { pointer.current = null; setDragging(false); move(levels.indexOf(value)); }
      }}
      onKeyDown={event => {
        if (unavailable) return;
        const current = Math.round(draft.current);
        const next = event.key === "Home" ? 0 : event.key === "End" ? 3 : ["ArrowRight", "ArrowUp"].includes(event.key) ? Math.min(3, current + 1) : ["ArrowLeft", "ArrowDown"].includes(event.key) ? Math.max(0, current - 1) : null;
        if (next !== null) { event.preventDefault(); commit(next); }
      }}>
      <div className="effort-fill" aria-hidden="true" />
      <div className="effort-ticks" aria-hidden="true">{levels.map((level, index) => <i key={level} className={`${index <= position ? "filled" : ""} ${hovered === index ? "hovered" : ""}`} />)}</div>
      <div className="effort-thumb" aria-hidden="true" />
    </div>
    {error && <p className="effort-error" role="alert">{error}</p>}
  </div>;
}
