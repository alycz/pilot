export type NearLiveRun = Readonly<{
  id: number;
  controller: AbortController;
  signal: AbortSignal;
}>;

/** Owns one browser flow run, aborting predecessors and invalidating late work. */
export function createNearLiveRunCoordinator() {
  let revision = 0;
  let active: NearLiveRun | undefined;
  return Object.freeze({
    begin(): NearLiveRun {
      active?.controller.abort();
      const controller = new AbortController();
      active = Object.freeze({
        id: ++revision,
        controller,
        signal: controller.signal,
      });
      return active;
    },
    isCurrent(run: NearLiveRun): boolean {
      return active?.id === run.id && !run.signal.aborted;
    },
    finish(run: NearLiveRun): boolean {
      if (active?.id !== run.id) return false;
      active = undefined;
      return !run.signal.aborted;
    },
    cancel(): void {
      active?.controller.abort();
      active = undefined;
      revision += 1;
    },
  });
}

