import { BABEL_ROW_EDITOR_SELECTOR, BABEL_TRANSCRIPT_ROW_SELECTOR } from '../core/babel-editor-contract';

export const selectors = {
  transcriptRows: BABEL_TRANSCRIPT_ROW_SELECTOR,
  rowEditor: BABEL_ROW_EDITOR_SELECTOR,
  rowActionTrigger: 'button[aria-haspopup="menu"]'
};
