export type AngleTagPartBackspaceEdit = {
  nextValue: string;
  removedText: string;
  selectionStart: number;
  selectionEnd: number;
};

export type AngleTagPartBackspaceEvent = {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};

export type AngleTagPartBackspaceOptions = {
  skipAdjacentSuffix?: boolean;
};

type AngleTagPartRange = {
  start: number;
  end: number;
};

export function shouldHandleAngleTagPartBackspaceEvent(event: AngleTagPartBackspaceEvent) {
  return event.key === 'Backspace' && !event.altKey && !event.metaKey;
}

function isValidAngleTagPart(text: string) {
  if (!text.startsWith('<') || !text.endsWith('>') || text.length < 3) {
    return false;
  }

  const body = text.slice(1, -1);
  const name = body.startsWith("/") ? body.slice(1) : body;
  return name.trim().length > 0 && !/[<>\r\n]/u.test(name);
}

function getAngleTagPartRangeAtBackspacePoint(value: string, cursorPosition: number): AngleTagPartRange | null {
  if (cursorPosition <= 0 || cursorPosition > value.length) {
    return null;
  }

  const deletionIndex = cursorPosition - 1;
  const openIndex = value.lastIndexOf('<', deletionIndex);
  if (openIndex < 0) {
    return null;
  }

  const closeIndex = value.indexOf('>', openIndex + 1);
  if (closeIndex < 0 || deletionIndex > closeIndex) {
    return null;
  }

  const end = closeIndex + 1;
  const candidate = value.slice(openIndex, end);
  if (!isValidAngleTagPart(candidate)) {
    return null;
  }

  return {
    start: openIndex,
    end,
  };
}

function getBackspacePointBeforeAdjacentSuffix(value: string, cursorPosition: number) {
  if (cursorPosition <= 0 || cursorPosition > value.length) {
    return null;
  }

  let index = cursorPosition;
  if (/\s/u.test(value[index - 1] || '')) {
    while (index > 0 && /\s/u.test(value[index - 1] || '')) {
      index -= 1;
    }
  } else {
    while (index > 0 && !/[<>\s]/u.test(value[index - 1] || '')) {
      index -= 1;
    }
  }

  if (index === cursorPosition || value[index - 1] !== '>') {
    return null;
  }

  return index;
}

export function getAngleTagPartBackspaceEdit(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  options: AngleTagPartBackspaceOptions = {}
): AngleTagPartBackspaceEdit | null {
  if (
    typeof value !== "string" ||
    !Number.isInteger(selectionStart) ||
    !Number.isInteger(selectionEnd) ||
    selectionStart !== selectionEnd
  ) {
    return null;
  }

  let range = getAngleTagPartRangeAtBackspacePoint(value, selectionStart);
  if (!range && options.skipAdjacentSuffix) {
    const backspacePoint = getBackspacePointBeforeAdjacentSuffix(value, selectionStart);
    if (backspacePoint !== null) {
      range = getAngleTagPartRangeAtBackspacePoint(value, backspacePoint);
      if (range) {
        range = {
          start: range.start,
          end: selectionStart,
        };
      }
    }
  }

  if (!range) {
    return null;
  }

  return {
    nextValue: value.slice(0, range.start) + value.slice(range.end),
    removedText: value.slice(range.start, range.end),
    selectionStart: range.start,
    selectionEnd: range.start,
  };
}
