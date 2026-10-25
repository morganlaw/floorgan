import { useState, useRef, useCallback } from 'react';
import { FloorplanState } from '../types';

interface HistoryState {
  past: FloorplanState[];
  present: FloorplanState;
  future: FloorplanState[];
}

export function useFloorplanHistory(initialState: FloorplanState, maxDepth = 50) {
  const [history, setHistory] = useState<HistoryState>({
    past: [],
    present: initialState,
    future: [],
  });

  // Snapshot taken at the beginning of an interactive continuous drag/resize/rotate
  const interactionSnapshotRef = useRef<FloorplanState | null>(null);

  // Set state with undo/redo history tracking
  const setState: React.Dispatch<React.SetStateAction<FloorplanState>> = useCallback(
    (action) => {
      setHistory((prev) => {
        const next = typeof action === 'function' ? action(prev.present) : action;
        if (next === prev.present) return prev;

        // If continuous interaction is active (e.g. dragging across canvas),
        // update present without generating undo steps for every pixel moved.
        if (interactionSnapshotRef.current !== null) {
          return {
            ...prev,
            present: next,
          };
        }

        // Discrete change: push current state to past, clear future
        return {
          past: [...prev.past.slice(-(maxDepth - 1)), prev.present],
          present: next,
          future: [],
        };
      });
    },
    [maxDepth]
  );

  // Start continuous interaction (drag, resize, rotate)
  const startInteraction = useCallback(() => {
    setHistory((prev) => {
      if (interactionSnapshotRef.current === null) {
        interactionSnapshotRef.current = prev.present;
      }
      return prev;
    });
  }, []);

  // End continuous interaction: if state actually changed, push pre-interaction snapshot to past
  const endInteraction = useCallback(() => {
    const initial = interactionSnapshotRef.current;
    interactionSnapshotRef.current = null;
    if (!initial) return;

    setHistory((prev) => {
      // Compare if any visual geometry actually changed
      const initialJson = JSON.stringify(initial);
      const presentJson = JSON.stringify(prev.present);
      if (initialJson === presentJson) {
        return prev;
      }

      return {
        past: [...prev.past.slice(-(maxDepth - 1)), initial],
        present: prev.present,
        future: [],
      };
    });
  }, [maxDepth]);

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (prev.past.length === 0) return prev;
      const previous = prev.past[prev.past.length - 1];
      const newPast = prev.past.slice(0, prev.past.length - 1);
      return {
        past: newPast,
        present: previous,
        future: [prev.present, ...prev.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((prev) => {
      if (prev.future.length === 0) return prev;
      const next = prev.future[0];
      const newFuture = prev.future.slice(1);
      return {
        past: [...prev.past.slice(-(maxDepth - 1)), prev.present],
        present: next,
        future: newFuture,
      };
    });
  }, [maxDepth]);

  return {
    state: history.present,
    setState,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    startInteraction,
    endInteraction,
  };
}
