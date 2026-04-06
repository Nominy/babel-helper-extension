const INTEGER_PATTERN = /^-?\d+$/;
const DECIMAL_COMMA_PATTERN = /^-?\d+,\d+$/;
const SLASH_FRACTION_PATTERN = /^-?\d+\s*\/\s*[1-9]\d*$/;
const INTEGER_RANGE_PATTERN = /^-?\d+(?:\s*-\s*-?\d+)+$/;
const PERCENT_PATTERN = /^(-?\d+)\s*%$/;
const MAX_SUPPORTED_DIGITS = 12;

const HUNDREDS = [
  'сто',
  'двести',
  'триста',
  'четыреста',
  'пятьсот',
  'шестьсот',
  'семьсот',
  'восемьсот',
  'девятьсот'
];

const TENS = [
  'двадцать',
  'тридцать',
  'сорок',
  'пятьдесят',
  'шестьдесят',
  'семьдесят',
  'восемьдесят',
  'девяносто'
];

const TEENS = [
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать'
];

const UNITS_MALE = [
  'один',
  'два',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять'
];

const UNITS_FEMALE = [
  'одна',
  'две',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять'
];

const SCALE_FORMS: Array<[string, string, string]> = [
  ['', '', ''],
  ['тысяча', 'тысячи', 'тысяч'],
  ['миллион', 'миллиона', 'миллионов'],
  ['миллиард', 'миллиарда', 'миллиардов']
];

const SPOKEN_DIGIT_WORDS = new Map<string, string>([
  ['ноль', '0'],
  ['один', '1'],
  ['одна', '1'],
  ['два', '2'],
  ['две', '2'],
  ['три', '3'],
  ['четыре', '4'],
  ['пять', '5'],
  ['шесть', '6'],
  ['семь', '7'],
  ['восемь', '8'],
  ['девять', '9']
]);

const DIGIT_WORDS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];

type FractionDenominatorSpec = {
  singular: string;
  plural: string;
  pluralFew?: string;
  forms: string[];
};

const FRACTION_DENOMINATORS = new Map<number, FractionDenominatorSpec>([
  [2, { singular: 'вторая', plural: 'вторых', forms: ['вторая', 'вторую', 'второй', 'вторых', 'вторые'] }],
  [3, { singular: 'третья', plural: 'третьих', forms: ['третья', 'третью', 'третьей', 'третьих', 'третьи'] }],
  [4, { singular: 'четвертая', plural: 'четвертых', pluralFew: 'четверти', forms: ['четвертая', 'четвертую', 'четвертой', 'четвертых', 'четвертые', 'четверти', 'четвертей'] }],
  [5, { singular: 'пятая', plural: 'пятых', forms: ['пятая', 'пятую', 'пятой', 'пятых', 'пятые'] }],
  [6, { singular: 'шестая', plural: 'шестых', forms: ['шестая', 'шестую', 'шестой', 'шестых', 'шестые'] }],
  [7, { singular: 'седьмая', plural: 'седьмых', forms: ['седьмая', 'седьмую', 'седьмой', 'седьмых', 'седьмые'] }],
  [8, { singular: 'восьмая', plural: 'восьмых', forms: ['восьмая', 'восьмую', 'восьмой', 'восьмых', 'восьмые'] }],
  [9, { singular: 'девятая', plural: 'девятых', forms: ['девятая', 'девятую', 'девятой', 'девятых', 'девятые'] }],
  [10, { singular: 'десятая', plural: 'десятых', forms: ['десятая', 'десятую', 'десятой', 'десятых', 'десятые'] }],
  [11, { singular: 'одиннадцатая', plural: 'одиннадцатых', forms: ['одиннадцатая', 'одиннадцатую', 'одиннадцатой', 'одиннадцатых', 'одиннадцатые'] }],
  [12, { singular: 'двенадцатая', plural: 'двенадцатых', forms: ['двенадцатая', 'двенадцатую', 'двенадцатой', 'двенадцатых', 'двенадцатые'] }],
  [13, { singular: 'тринадцатая', plural: 'тринадцатых', forms: ['тринадцатая', 'тринадцатую', 'тринадцатой', 'тринадцатых', 'тринадцатые'] }],
  [14, { singular: 'четырнадцатая', plural: 'четырнадцатых', forms: ['четырнадцатая', 'четырнадцатую', 'четырнадцатой', 'четырнадцатых', 'четырнадцатые'] }],
  [15, { singular: 'пятнадцатая', plural: 'пятнадцатых', forms: ['пятнадцатая', 'пятнадцатую', 'пятнадцатой', 'пятнадцатых', 'пятнадцатые'] }],
  [16, { singular: 'шестнадцатая', plural: 'шестнадцатых', forms: ['шестнадцатая', 'шестнадцатую', 'шестнадцатой', 'шестнадцатых', 'шестнадцатые'] }],
  [17, { singular: 'семнадцатая', plural: 'семнадцатых', forms: ['семнадцатая', 'семнадцатую', 'семнадцатой', 'семнадцатых', 'семнадцатые'] }],
  [18, { singular: 'восемнадцатая', plural: 'восемнадцатых', forms: ['восемнадцатая', 'восемнадцатую', 'восемнадцатой', 'восемнадцатых', 'восемнадцатые'] }],
  [19, { singular: 'девятнадцатая', plural: 'девятнадцатых', forms: ['девятнадцатая', 'девятнадцатую', 'девятнадцатой', 'девятнадцатых', 'девятнадцатые'] }],
  [20, { singular: 'двадцатая', plural: 'двадцатых', forms: ['двадцатая', 'двадцатую', 'двадцатой', 'двадцатых', 'двадцатые'] }]
]);

function dispatchInputEvent(element: HTMLInputElement | HTMLTextAreaElement) {
  element.dispatchEvent(
    typeof InputEvent === 'function'
      ? new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          data: null,
          inputType: 'insertText'
        })
      : new Event('input', {
          bubbles: true,
          cancelable: false
        })
  );
}

function setTextControlValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

  if (typeof setter === 'function') {
    setter.call(element, value);
  } else {
    element.value = value;
  }
}

export function isTextControl(
  element: EventTarget | null
): element is HTMLInputElement | HTMLTextAreaElement {
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }

  if (!(element instanceof HTMLInputElement)) {
    return false;
  }

  return ['text', 'search', 'url', 'tel', 'password', 'email', 'number'].includes(element.type || 'text');
}

function pickPluralForm(value: number, one: string, twoToFour: string, many: string) {
  const absolute = Math.abs(value);
  const mod10 = absolute % 10;
  const mod100 = absolute % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }

  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return twoToFour;
  }

  return many;
}

function threeDigitToWords(value: number, isFeminine = false) {
  const parts: string[] = [];
  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  const tens = Math.floor(remainder / 10);
  const units = remainder % 10;

  if (hundreds > 0) {
    parts.push(HUNDREDS[hundreds - 1]);
  }

  if (remainder >= 10 && remainder <= 19) {
    parts.push(TEENS[remainder - 10]);
    return parts.join(' ');
  }

  if (tens >= 2) {
    parts.push(TENS[tens - 2]);
  }

  if (units > 0) {
    parts.push((isFeminine ? UNITS_FEMALE : UNITS_MALE)[units - 1]);
  }

  return parts.join(' ');
}

function integerTextToRussianWords(numberText: string, lastTriadFeminine = false) {
  let signPrefix = '';
  let digits = numberText;

  if (digits.startsWith('-')) {
    signPrefix = 'минус ';
    digits = digits.slice(1);
  }

  digits = digits.replace(/^0+/, '');
  if (!digits) {
    return `${signPrefix}ноль`;
  }

  if (digits.length > MAX_SUPPORTED_DIGITS) {
    return '';
  }

  const triads: string[] = [];
  while (digits.length > 0) {
    triads.unshift(digits.slice(-3));
    digits = digits.slice(0, -3);
  }

  const parts: string[] = [];
  for (let index = 0; index < triads.length; index += 1) {
    const triadValue = Number(triads[index]);
    if (!triadValue) {
      continue;
    }

    const scaleIndex = triads.length - index - 1;
    const isFeminine = scaleIndex === 1 || (scaleIndex === 0 && lastTriadFeminine);
    const triadWords = threeDigitToWords(triadValue, isFeminine);
    if (!triadWords) {
      continue;
    }

    if (scaleIndex > 0) {
      const [one, twoToFour, many] = SCALE_FORMS[scaleIndex];
      parts.push(`${triadWords} ${pickPluralForm(triadValue, one, twoToFour, many)}`);
    } else {
      parts.push(triadWords);
    }
  }

  if (!parts.length) {
    return `${signPrefix}ноль`;
  }

  return `${signPrefix}${parts.join(' ')}`;
}

function chooseFractionDenominatorWord(denominator: number, numerator: number) {
  const spec = FRACTION_DENOMINATORS.get(denominator);
  if (!spec) {
    return null;
  }

  const absolute = Math.abs(numerator);
  const mod10 = absolute % 10;
  const mod100 = absolute % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return spec.singular;
  }

  if (spec.pluralFew && mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return spec.pluralFew;
  }

  return spec.plural;
}

export function buildSkazFromSlashFraction(selectedText: string) {
  const trimmed = selectedText.trim();
  if (!SLASH_FRACTION_PATTERN.test(trimmed)) {
    return null;
  }

  const match = trimmed.match(/^(-?\d+)\s*\/\s*(\d+)$/);
  if (!match) {
    return null;
  }

  const numeratorText = match[1];
  const denominatorValue = Number(match[2]);
  if (!Number.isInteger(denominatorValue) || denominatorValue < 2 || denominatorValue > 20) {
    return null;
  }

  const numeratorValue = Number(numeratorText);
  if (!Number.isInteger(numeratorValue)) {
    return null;
  }

  const numeratorWords = integerTextToRussianWords(numeratorText, true);
  const denominatorWord = chooseFractionDenominatorWord(denominatorValue, numeratorValue);
  if (!numeratorWords || !denominatorWord) {
    return null;
  }

  return `${trimmed} {СКАЗ: ${numeratorWords} ${denominatorWord}}`;
}

export function formatGroupedIntegerText(numberText: string) {
  if (!INTEGER_PATTERN.test(numberText)) {
    return numberText;
  }

  const sign = numberText.startsWith('-') ? '-' : '';
  const digits = sign ? numberText.slice(1) : numberText;
  if (digits.length <= 3 || (digits.length > 1 && digits.startsWith('0'))) {
    return numberText;
  }

  const groupedDigits = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${groupedDigits}`;
}

export function formatGroupedDecimalText(numberText: string) {
  if (!DECIMAL_COMMA_PATTERN.test(numberText)) {
    return numberText;
  }

  const sign = numberText.startsWith('-') ? '-' : '';
  const unsigned = sign ? numberText.slice(1) : numberText;
  const [integerPart, fractionPart] = unsigned.split(',');
  const groupedIntegerPart = formatGroupedIntegerText(`${sign}${integerPart}`);
  const normalizedIntegerPart = sign && groupedIntegerPart.startsWith('-')
    ? groupedIntegerPart.slice(1)
    : groupedIntegerPart;

  return `${sign}${normalizedIntegerPart},${fractionPart}`;
}

function decimalCommaTextToRussianWords(numberText: string) {
  if (!DECIMAL_COMMA_PATTERN.test(numberText)) {
    return '';
  }

  const signPrefix = numberText.startsWith('-') ? 'минус ' : '';
  const unsigned = signPrefix ? numberText.slice(1) : numberText;
  const [integerPart, fractionPart] = unsigned.split(',');
  const integerWords = numberTextToRussianWords(integerPart);
  if (!integerWords) {
    return '';
  }

  const fractionWords = fractionPart
    .split('')
    .map((digit) => DIGIT_WORDS[Number(digit)] ?? '')
    .filter(Boolean);
  if (!fractionWords.length || fractionWords.length !== fractionPart.length) {
    return '';
  }

  return `${signPrefix}${integerWords} и ${fractionWords.join(' ')}`;
}

export function numberTextToRussianWords(numberText: string) {
  return integerTextToRussianWords(numberText, false);
}

export function buildExpandedSkazText(selectedText: string) {
  const trimmed = selectedText.trim();
  if (!trimmed) {
    return null;
  }

  if (DECIMAL_COMMA_PATTERN.test(trimmed)) {
    const words = decimalCommaTextToRussianWords(trimmed);
    if (!words) {
      return null;
    }

    return `${formatGroupedDecimalText(trimmed)} {СКАЗ: ${words}}`;
  }

  if (!INTEGER_PATTERN.test(trimmed)) {
    return null;
  }

  const words = numberTextToRussianWords(trimmed);
  if (!words) {
    return null;
  }

  return `${formatGroupedIntegerText(trimmed)} {СКАЗ: ${words}}`;
}

export function buildExpandedSkazForNumericPattern(selectedText: string) {
  const trimmed = selectedText.trim();
  if (!trimmed) {
    return null;
  }

  const percentMatch = trimmed.match(PERCENT_PATTERN);
  if (percentMatch) {
    const digits = percentMatch[1];
    const words = numberTextToRussianWords(digits);
    if (!words) {
      return null;
    }

    const percentWord = pickPluralForm(Number(digits), 'процент', 'процента', 'процентов');
    return `${formatGroupedIntegerText(digits)} % {СКАЗ: ${words} ${percentWord}}`;
  }

  if (!INTEGER_RANGE_PATTERN.test(trimmed)) {
    return null;
  }

  const parts = trimmed.split(/\s*-\s*/);
  const words = parts.map((part) => numberTextToRussianWords(part));
  if (words.some((part) => !part)) {
    return null;
  }

  return `${parts.map((part) => formatGroupedIntegerText(part)).join('-')} {СКАЗ: ${words.join(' ')}}`;
}

export function buildSkazFromSpokenDigitSequence(selectedText: string) {
  const trimmed = selectedText.trim();
  if (!trimmed) {
    return null;
  }

  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return null;
  }

  const digits = tokens.map((token) => SPOKEN_DIGIT_WORDS.get(token) ?? '');
  if (digits.some((token) => !token)) {
    return null;
  }

  return `${digits.join('-')} {СКАЗ: ${trimmed}}`;
}

export function buildAutoConvertedNumberText(selectedText: string) {
  return (
    buildExpandedSkazText(selectedText) ??
    buildSkazFromSlashFraction(selectedText) ??
    buildExpandedSkazForNumericPattern(selectedText) ??
    buildSkazFromSpokenDigitSequence(selectedText)
  );
}

export function replaceSelectionInTextControl(
  control: HTMLInputElement | HTMLTextAreaElement,
  replacement: string,
  cursorOffset?: number
) {
  const start = typeof control.selectionStart === 'number' ? control.selectionStart : null;
  const end = typeof control.selectionEnd === 'number' ? control.selectionEnd : null;
  if (start === null || end === null || start === end) {
    return false;
  }

  const nextValue = `${control.value.slice(0, start)}${replacement}${control.value.slice(end)}`;
  setTextControlValue(control, nextValue);
  control.focus({ preventScroll: true });
  const cursor = start + (cursorOffset ?? replacement.length);
  try {
    control.setSelectionRange(cursor, cursor);
  } catch (_error) {
    // Ignore selection restoration failures on unusual input types.
  }
  dispatchInputEvent(control);
  return true;
}

function replaceDocumentSelection(replacement: string) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();

  const node = document.createTextNode(replacement);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export function getSelectedTextFromTextControl(control: HTMLInputElement | HTMLTextAreaElement) {
  const start = typeof control.selectionStart === 'number' ? control.selectionStart : null;
  const end = typeof control.selectionEnd === 'number' ? control.selectionEnd : null;
  if (start === null || end === null || start === end) {
    return '';
  }

  return control.value.slice(start, end);
}

export function autoConvertSelectedNumberText(target?: EventTarget | null) {
  const targetNode = target ?? null;
  let activeTarget: HTMLInputElement | HTMLTextAreaElement | null = null;

  if (isTextControl(targetNode)) {
    activeTarget = targetNode;
  } else if (isTextControl(document.activeElement)) {
    activeTarget = document.activeElement;
  }

  if (activeTarget) {
    const selectedText = getSelectedTextFromTextControl(activeTarget);
    const replacement = buildAutoConvertedNumberText(selectedText);
    if (!replacement) {
      return false;
    }

    return replaceSelectionInTextControl(activeTarget, replacement);
  }

  const selection = window.getSelection();
  const selectedText = selection?.toString() ?? '';
  const replacement = buildAutoConvertedNumberText(selectedText);
  if (!replacement) {
    return false;
  }

  return replaceDocumentSelection(replacement);
}

export function convertSelectionWithDigit(target: EventTarget | null, digit: string) {
  if (!isTextControl(target)) {
    return false;
  }

  const selectedText = getSelectedTextFromTextControl(target);
  if (!selectedText || selectedText.trim().length === 0) {
    return false;
  }

  const replacement = `${digit} {СКАЗ: ${selectedText}}`;
  return replaceSelectionInTextControl(target, replacement, digit.length);
}
