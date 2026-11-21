// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly what the
// reference returns for {text, header} — {columns, rows, errors} — but reads
// the text by jumping between delimiters instead of walking it one character
// at a time.
//
// How it stays identical while going faster:
//  - A record whose first line holds no quote is one plain line: it is cut on
//    its commas in a single split, with stray CRs counted and dropped first.
//  - An unquoted field is found by scanning for the next comma, LF or CR and
//    cut out with one slice; only a stray CR makes it take a second pass.
//  - A quoted field is found by jumping from quote to quote; doubled quotes
//    collapse to one, and line breaks inside quotes are converted only when
//    the field actually holds one (rare: notes that span lines).
//  - Every broken shape still reports exactly the reference's errors, in the
//    reference's order: stray_cr and unterminated_quote as met, quote_junk
//    when its field ends, short_row / long_row when its record ends, each
//    with the 1-based line its record starts on and its index in rows.
//
// Pure: no clock, no randomness, no locale, nothing kept between calls.

const COMMA = 44; // ,
const QUOTE = 34; // "
const LF = 10; // \n
const CR = 13; // \r
const BOM = 0xfeff;

// How a field ended: at a comma (its record goes on), at a line break, or at
// the end of the text (its record ends either way).
const AT_COMMA = 0;
const AT_BREAK = 1;
const AT_END = 2;

/** csv-reader 1.0.0's answer for one case's input, read the fast way. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === BOM ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;
  let ended = AT_END;
  // Where the next CR sits at or after pos (-1: not looked for yet,
  // Infinity: none left). CRs are rare in LF files, so searching for one
  // from scratch at every record would re-scan long stretches again and
  // again; this remembers the answer across records, and pos only moves
  // forward, so the search as a whole walks the text once.
  let nextCR = -1;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field from pos, appending its kept characters onto
  // `value` ('' for a fresh field, the quoted value for junk after a closing
  // quote, '"' for a quote that never closed). Sets `ended`, returns the
  // field. A CR not followed by LF is dropped and reported, and the field
  // goes on after it.
  function unquoted(value) {
    let start = pos;
    for (;;) {
      let i = pos;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === COMMA || c === LF || c === CR) break;
        i++;
      }
      if (i >= len) {
        pos = len;
        ended = AT_END;
        return value ? value + text.slice(start, len) : text.slice(start, len);
      }
      const c = text.charCodeAt(i);
      if (c === COMMA) {
        pos = i + 1;
        ended = AT_COMMA;
        return value ? value + text.slice(start, i) : text.slice(start, i);
      }
      if (c === LF) {
        pos = i + 1;
        line += 1;
        ended = AT_BREAK;
        return value ? value + text.slice(start, i) : text.slice(start, i);
      }
      if (text.charCodeAt(i + 1) === LF) {
        pos = i + 2;
        line += 1;
        ended = AT_BREAK;
        return value ? value + text.slice(start, i) : text.slice(start, i);
      }
      pushError('stray_cr');
      value = value ? value + text.slice(start, i) : text.slice(start, i);
      pos = i + 1;
      start = i + 1;
    }
  }

  // Appends text[a..b) — a stretch inside a quoted field — onto `value`,
  // reading each CRLF or lone CR in it as one LF and counting every line
  // break it holds. The usual stretch holds no break at all: a single
  // bounded scan finds that out without ever looking past the stretch's end
  // (an unbounded search for CR would wander far in files that barely use
  // it), and the stretch is then one slice.
  function appendQuoted(value, a, b) {
    let hasBreak = false;
    for (let j = a; j < b; j++) {
      const c = text.charCodeAt(j);
      if (c === CR || c === LF) {
        hasBreak = true;
        break;
      }
    }
    if (!hasBreak) return value ? value + text.slice(a, b) : text.slice(a, b);
    let out = value;
    let s = a;
    for (let j = a; j < b; j++) {
      const c = text.charCodeAt(j);
      if (c === CR) {
        out += text.slice(s, j) + '\n';
        line += 1;
        if (text.charCodeAt(j + 1) === LF) j++;
        s = j + 1;
      } else if (c === LF) {
        line += 1;
      }
    }
    return out + text.slice(s, b);
  }

  // Reads a quoted field whose opening quote is at pos. Sets `ended`,
  // returns the field.
  function quotedField() {
    const open = pos;
    const openLine = line;
    let value = '';
    let i = pos + 1;
    for (;;) {
      const q = text.indexOf('"', i);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it reads again as an unquoted field.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        return unquoted('"');
      }
      if (text.charCodeAt(q + 1) === QUOTE) {
        value = appendQuoted(value, i, q) + '"';
        i = q + 2;
        continue;
      }
      value = appendQuoted(value, i, q);
      pos = q + 1;
      break;
    }
    if (pos >= len) {
      ended = AT_END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      ended = AT_COMMA;
      return value;
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      ended = AT_BREAK;
      return value;
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      ended = AT_BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break; junk counts only when it kept characters.
    const junk = unquoted(value);
    if (junk.length > value.length) pushError('quote_junk');
    return junk;
  }

  for (;;) {
    // Lines left with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    let quoted = false;
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    const q = text.indexOf('"', pos);
    if (q === -1 || q >= lineEnd) {
      // No quote before the line ends: the whole record is one plain line.
      let end = lineEnd;
      if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === CR) end -= 1;
      if (nextCR === -1 || nextCR < pos) {
        const r = text.indexOf('\r', pos);
        nextCR = r === -1 ? Infinity : r;
      }
      if (nextCR >= end) {
        fields = text.slice(pos, end).split(',');
      } else {
        const seg = text.slice(pos, end);
        const cleaned = seg.replaceAll('\r', '');
        const stray = seg.length - cleaned.length;
        for (let k = 0; k < stray; k++) pushError('stray_cr');
        fields = cleaned.split(',');
      }
      if (nl !== -1) {
        pos = nl + 1;
        line += 1;
      } else {
        pos = len;
      }
    } else {
      // A quote opens somewhere in this record: read it field by field.
      fields = [];
      do {
        if (text.charCodeAt(pos) === QUOTE) {
          quoted = true;
          fields.push(quotedField());
        } else {
          quoted = false;
          fields.push(unquoted(''));
        }
      } while (ended === AT_COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
