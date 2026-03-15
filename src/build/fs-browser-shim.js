const EN_CSV = `META;;;;
separators;;;;
-;;;;
text;value;multiply level;errors limit;rank
zero;0;0;1;1
one;1;0;0;1
two;2;0;0;1
three;3;0;1;1
four;4;0;0;1
five;5;0;1;1
six;6;0;0;1
seven;7;0;0;1
eight;8;0;1;1
nine;9;0;1;1
ten;10;0;0;1
eleven;11;0;2;1
twelve;12;0;2;1
thirteen;13;0;2;1
fourteen;14;0;2;1
fifteen;15;0;2;1
sixteen;16;0;2;1
seventeen;17;0;2;1
eighteen;18;0;2;1
nineteen;19;0;2;1
twenty;20;0;1;2
thirty;30;0;1;2
forty;40;0;0;2
fifty;50;0;1;2
sixty;60;0;1;2
seventy;70;0;1;2
eighty;80;0;1;2
ninety;90;0;1;2
hundred;100;2;2;3
thousand;1000;1;2;4
million;1000000;1;2;7
billion;1000000000;1;2;10
trillion;1000000000000;1;2;13
first;1;0;1;1
second;2;0;1;1
third;3;0;1;1
fourth;4;0;1;1
fifth;5;0;1;1
sixth;6;0;1;1
seventh;7;0;1;1
eighth;8;0;1;1
nineth;9;0;1;1`;

const RU_CSV = `META;;;;
separators;;;;
;;;;
text;value;multiply level;errors limit;rank
ноль;0;0;1;1
один;1;0;1;1
два;2;0;1;1
три;3;0;0;1
четыре;4;0;2;1
пять;5;0;0;1
шесть;6;0;1;1
семь;7;0;0;1
восемь;8;0;2;1
девять;9;0;2;1
десять;10;0;2;1
одиннадцать;11;0;2;1
двенадцать;12;0;2;1
тринадцать;13;0;2;1
четырнадцать;14;0;2;1
пятнадцать;15;0;2;1
шестнадцать;16;0;2;1
семнадцать;17;0;2;1
восемнадцать;18;0;2;1
девятнадцать;19;0;2;1
двадцать;20;0;2;2
тридцать;30;0;2;2
сорок;40;0;0;2
пятьдесят;50;0;2;2
шестьдесят;60;0;2;2
семьдесят;70;0;2;2
восемьдесят;80;0;2;2
девяносто;90;0;2;2
сто;100;0;0;3
сотня;100;1;2;3
двести;200;0;1;3
триста;300;0;1;3
четыреста;400;0;2;3
пятьсот;500;0;2;3
шестьсот;600;0;2;3
семьсот;700;0;2;3
восемьсот;800;0;2;3
девятьсот;900;0;2;3
тысяча;1000;1;2;4
тыща;1000;1;1;4
миллион;1000000;1;2;7
миллиард;1000000000;1;2;10
триллион;1000000000000;1;2;13
первый;1;0;2;1
второй;2;0;2;1
третий;3;0;2;1
третьего;3;0;0;1
пятый;5;0;1;1
пятая;5;0;1;1
пятого;5;0;1;1
пятыми;5;0;1;1
шестой;6;0;2;1
седьмой;7;0;2;1
восьмой;8;0;2;1
девятый;9;0;2;1
четвертый;4;0;0;1
четвертая;4;0;0;1
четвертыое;4;0;0;1
четвертого;4;0;0;1
четвертые;4;0;0;1
полтора;1.5;0;0;1
полторы;1.5;0;0;1`;

const FILES = {
  'EN.csv': EN_CSV.replace(/\n/g, '\r\n'),
  'RU.csv': RU_CSV.replace(/\n/g, '\r\n')
};

function getFileName(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '';
}

export function readFileSync(filePath, options) {
  const fileName = getFileName(filePath);
  const contents = FILES[fileName];
  if (typeof contents !== 'string') {
    throw new Error(`fs-browser-shim cannot read ${String(filePath)}`);
  }

  if (typeof options === 'string') {
    return contents;
  }

  if (options && typeof options === 'object' && options.encoding) {
    return contents;
  }

  return new TextEncoder().encode(contents);
}

export function readdirSync(dirPath) {
  const normalized = String(dirPath).replace(/\\/g, '/');
  if (normalized.endsWith('/expressions') || normalized.endsWith('/expressions/')) {
    return Object.keys(FILES);
  }

  throw new Error(`fs-browser-shim cannot read directory ${String(dirPath)}`);
}

export default {
  readFileSync,
  readdirSync
};
