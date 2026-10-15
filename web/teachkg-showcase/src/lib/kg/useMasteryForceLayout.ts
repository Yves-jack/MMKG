import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PackedInput, PackedLayout } from "./packedMindmapLayout.mjs";
import {
  createMasteryForce,
  advanceMasteryForce,
  moveMasteryForce,
  forceBounds,
  renderMasteryForce,
  type MasteryForce,
} from "./masteryForceLayout.mjs";

export function useMasteryForceLayout(
  input: PackedInput,
  enabled: boolean,
  resetKey: number,
) {
  const key = useMemo(
    () =>
      JSON.stringify([
        resetKey,
        input.records.map((n) => [
          n.key,
          n.node.zh,
          n.children,
          n.spec,
          (n.node as { __open?: boolean }).__open,
        ]),
      ]),
    [input, resetKey],
  );
  const simulation = useRef<MasteryForce | null>(null);
  const previousReset = useRef(resetKey);
  const raf = useRef(0);
  const wake = useRef<() => void>(() => {});
  const [state, setState] = useState<{ key: string; layout?: PackedLayout }>({
    key: "",
  });
  useEffect(() => {
    if (!enabled) return;
    const previous =
      previousReset.current === resetKey
        ? simulation.current?.bodies
        : undefined;
    previousReset.current = resetKey;
    const sim = createMasteryForce(input, previous);
    simulation.current = sim;
    let frames = 0,
      calm = 0,
      last = 0,
      active = true;
    const publish = () => {
      if (active) setState({ key, layout: renderMasteryForce(sim) });
    };
    const tick = (time: number) => {
      raf.current = 0;
      if (!active) return;
      if (time - last < 30) {
        raf.current = requestAnimationFrame(tick);
        return;
      }
      last = time;
      const energy = advanceMasteryForce(sim);
      if (sim.autoFit) sim.bounds = forceBounds(sim);
      calm = energy < 0.015 ? calm + 1 : 0;
      frames++;
      publish();
      if (frames < 450 && calm < 20) raf.current = requestAnimationFrame(tick);
    };
    wake.current = () => {
      if (!active) return;
      frames = 0;
      calm = 0;
      publish();
      if (!raf.current) raf.current = requestAnimationFrame(tick);
    };
    publish();
    wake.current();
    return () => {
      active = false;
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      wake.current = () => {};
    };
  }, [key, enabled]);
  const moveNode = useCallback((nodeKey: string, dx: number, dy: number) => {
    if (!simulation.current) return;
    moveMasteryForce(simulation.current, nodeKey, dx, dy);
    wake.current();
  }, []);
  const freezeViewport = useCallback(() => {
    if (simulation.current) simulation.current.autoFit = false;
  }, []);
  return {
    freezeViewport,
    layout: enabled && state.key === key ? state.layout : undefined,
    moveNode,
  };
}
