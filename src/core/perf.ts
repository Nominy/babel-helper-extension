type PerfDetail = Record<string, unknown> | undefined;

type PerfEntry = {
  name: string;
  at: number;
  detail?: PerfDetail;
};

export interface BabelHelperPerf {
  phase: string;
  counters: Record<string, number>;
  marks: Record<string, number>;
  measures: PerfEntry[];
  events: PerfEntry[];
  count: (name: string, detail?: PerfDetail) => number;
  mark: (name: string) => number;
  measure: (name: string, start: string, end?: string) => number | null;
  setPhase: (phase: string, detail?: PerfDetail) => void;
}

declare global {
  interface Window {
    __babelHelperPerf?: BabelHelperPerf;
  }
}

function now() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function createPerfRuntime(): BabelHelperPerf {
  const existing = window.__babelHelperPerf;
  if (existing) {
    return existing;
  }

  const perf: BabelHelperPerf = {
    phase: 'boot',
    counters: {},
    marks: {},
    measures: [],
    events: [],
    count(name, detail) {
      const next = (perf.counters[name] || 0) + 1;
      perf.counters[name] = next;
      if (detail) {
        perf.events.push({ name: `count:${name}`, at: now(), detail });
      }
      return next;
    },
    mark(name) {
      const value = now();
      perf.marks[name] = value;
      perf.events.push({ name: `mark:${name}`, at: value });
      return value;
    },
    measure(name, start, end) {
      const startAt = perf.marks[start];
      const endAt = end ? perf.marks[end] : now();
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) {
        return null;
      }
      const duration = Math.max(0, endAt - startAt);
      perf.measures.push({ name, at: duration, detail: { start, end: end || 'now' } });
      return duration;
    },
    setPhase(phase, detail) {
      perf.phase = phase;
      perf.events.push({ name: `phase:${phase}`, at: now(), detail });
    }
  };

  window.__babelHelperPerf = perf;
  perf.mark('boot');
  return perf;
}
