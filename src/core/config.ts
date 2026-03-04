export function createConfig() {
  return {
    rowTextareaSelector: 'textarea[placeholder^="What was said"]',
    actionTriggerSelector: 'button[aria-haspopup="menu"]',
    hotkeysHelpMarker: 'data-babel-helper-hotkeys',
    hotkeysDialogPatterns: [
      /\bkeyboard shortcuts\b/i,
      /\buse these shortcuts to navigate and control the transcription workbench\b/i,
      /\bhotkeys\b/i
    ],
    hotkeysHelpRows: [
      ['Esc', 'Toggle blur and restore cursor'],
      ['Alt + [ (РҐ)', 'Move text before caret to previous segment'],
      ['Alt + ] (РЄ)', 'Move text after caret to next segment'],
      ['Alt + Shift + Up', 'Merge with previous segment'],
      ['Alt + Shift + Down', 'Merge with next segment'],
      ['Del', 'Delete current segment'],
      ['D', 'Delete current segment when not typing']
    ],
    actionPatterns: {
      deleteSegment: [/\bdelete(?:\s+segment)?\b/i, /\bremove(?:\s+segment)?\b/i],
      mergePrevious: [
        /\bmerge\b.*\b(previous|prev|above|before|up)\b/i,
        /\b(previous|prev|above|before|up)\b.*\b(merge|combine|join)\b/i,
        /\b(combine|join)\b.*\b(previous|prev|above|before|up)\b/i
      ],
      mergeNext: [
        /\bmerge\b.*\b(next|below|after|following|down)\b/i,
        /\b(next|below|after|following|down)\b.*\b(merge|combine|join)\b/i,
        /\b(combine|join)\b.*\b(next|below|after|following|down)\b/i
      ],
      mergeFallback: [/\bmerge\b/i, /\bcombine\b/i, /\bjoin\b/i]
    }
  };
}

