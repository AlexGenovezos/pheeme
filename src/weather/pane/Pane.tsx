// The weather over one band of hours, drawn on a canvas as if through a window pane (scene.ts).
// Drawn once when it shows; animated only while `playing`, and then only until the scene has
// wound down, so a calendar at rest runs no frames.
import { useEffect, useRef } from "react";
import type { Intensity } from "../codes";
import type { RunKind } from "../hourly";
import { type Ink, readInk } from "./ink";
import { createScene, type Scene } from "./scene";

export function Pane({
  kind,
  seed,
  intensity,
  playing,
}: {
  kind: RunKind;
  seed: string;
  intensity: Intensity;
  playing: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const playingRef = useRef(playing);
  // Starts the frames when it's still and should move; set by the effect below.
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    let scene: Scene | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    let ink: Ink | null = null;
    let frame = 0;
    let last = 0;

    const draw = () => {
      if (ctx && scene && ink) scene.paint(ctx, ink);
    };
    const restyle = () => {
      ink = readInk(canvas);
      draw();
    };
    const tick = (now: number) => {
      frame = 0;
      if (!scene) return;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      scene.step(dt, playingRef.current);
      draw();
      if (playingRef.current || !scene.still) frame = requestAnimationFrame(tick);
      else last = 0;
    };
    wake.current = () => {
      if (!frame && scene && (playingRef.current || !scene.still)) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    };

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx = canvas.getContext("2d");
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene = createScene(kind, width, height, intensity, seed);
      if (!ink) restyle();
      else draw();
      wake.current();
    });
    ro.observe(canvas);
    // The theme changing redraws the weather in its colours.
    const mo = new MutationObserver(restyle);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(frame);
      wake.current = () => {};
    };
  }, [kind, seed, intensity]);

  useEffect(() => {
    playingRef.current = playing;
    if (playing) wake.current();
  }, [playing]);

  return <canvas ref={ref} className="wx-hours__pane" />;
}
