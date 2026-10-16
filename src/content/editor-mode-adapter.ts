import { getActiveEditorMode, publishActiveEditorMode } from '../core/editor-mode';
import type { NativeRenderPerformanceOptions } from './native-render-performance';

export type EditorAdapterFactory = NonNullable<NativeRenderPerformanceOptions['adapterFactory']>;
const classicFactoryKey = Symbol.for('babel-helper/classic-editor-adapter');

/** Preparation only: both document_start entries finish before the page executes its editor module. */
export function registerClassicEditorAdapter(factory: EditorAdapterFactory, target: object = globalThis): void {
  const current = Object.getOwnPropertyDescriptor(target, classicFactoryKey);
  if (current) {
    if (current.value !== factory) throw new Error('Another Classic adapter already owns this document.');
    return;
  }
  if (getActiveEditorMode(target) !== null) {
    throw new Error('The editor has already started. Refresh the page to select Classic.');
  }
  Object.defineProperty(target, classicFactoryKey, { value: factory });
}

/** The static bootstrap calls this only when the genuine native editor module executes. */
export function selectEditorAdapterFactory(nativeFactory: EditorAdapterFactory, target: object = globalThis): EditorAdapterFactory {
  const classic = Object.getOwnPropertyDescriptor(target, classicFactoryKey);
  if (classic && typeof classic.value !== 'function') {
    throw new Error('The registered Classic editor adapter is invalid.');
  }
  const mode = classic ? 'classic' : 'native';
  publishActiveEditorMode(mode, target);
  return classic ? classic.value : nativeFactory;
}
