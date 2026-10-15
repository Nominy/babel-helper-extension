interface ZoomWave {
  zoom?: (pixelsPerSecond: number) => void;
  getDecodedData?: () => unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => (() => void) | void;
  un?: (event: string, listener: (...args: unknown[]) => void) => void;
}
interface ZoomLease {
  version: 1;
  owners: number;
  disposed: boolean;
  wrapped: (this: ZoomWave, value: number) => void;
  dispose(): void;
}
const ZOOM_LEASE = Symbol.for('babel-helper.native-zoom-readiness');

/** Native ready handlers synchronize zoom before sibling lanes have decoded. */
export function acquireNativeZoomReadiness(wave: ZoomWave): (() => void) | null {
  // Nonvisual transports have no zoom operation to guard.
  if (typeof wave.zoom !== 'function') return null;
  let lease = Reflect.get(wave, ZOOM_LEASE) as ZoomLease | undefined;
  if (lease) {
    if (lease.version !== 1 || lease.disposed || wave.zoom !== lease.wrapped) {
      throw new Error('Native waveform zoom ownership was replaced');
    }
  } else {
    if (typeof wave.getDecodedData !== 'function' || typeof wave.on !== 'function' || typeof wave.un !== 'function') {
      throw new Error('Native waveform zoom readiness notifications are unavailable');
    }
    const original = wave.zoom;
    const descriptor = Object.getOwnPropertyDescriptor(wave, 'zoom');
    const cleanups: (() => void)[] = [];
    let pending: number | undefined;
    const owned: ZoomLease = {
      version: 1, owners: 0, disposed: false,
      wrapped(value) {
        if (this !== wave) return original.call(this, value);
        if (!wave.getDecodedData!()) {
          pending = value;
          return;
        }
        pending = undefined;
        return original.call(wave, value);
      },
      dispose() {
        if (owned.disposed) return;
        owned.disposed = true;
        pending = undefined;
        for (const cleanup of cleanups) cleanup();
        if (wave.zoom === owned.wrapped) {
          if (descriptor) Object.defineProperty(wave, 'zoom', descriptor);
          else delete wave.zoom;
        }
        if (Reflect.get(wave, ZOOM_LEASE) === owned) Reflect.deleteProperty(wave, ZOOM_LEASE);
      }
    };
    try {
      Object.defineProperty(wave, 'zoom', { configurable: true, writable: true,
        enumerable: descriptor?.enumerable ?? false, value: owned.wrapped });
      Object.defineProperty(wave, ZOOM_LEASE, { configurable: true, value: owned });
      const onReady = () => {
        if (owned.disposed || pending === undefined) return;
        if (wave.zoom !== owned.wrapped) {
          owned.dispose();
          throw new Error('Native waveform zoom ownership was replaced');
        }
        const value = pending;
        if (!wave.getDecodedData!()) throw new Error('Native waveform ready event has no decoded audio');
        pending = undefined;
        original.call(wave, value);
      };
      for (const [event, listener] of [['ready', onReady], ['destroy', owned.dispose]] as const) {
        cleanups.push(() => wave.un!(event, listener));
        if (typeof wave.on(event, listener) !== 'function') {
          throw new Error(`Native waveform ${event} subscription has no disposer`);
        }
      }
      lease = owned;
    } catch (error) {
      owned.dispose();
      throw error;
    }
  }
  lease.owners += 1;
  const owned = lease;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (!owned.disposed && --owned.owners === 0) owned.dispose();
  };
}
