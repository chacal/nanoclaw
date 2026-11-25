/**
 * Markdown → Signal text styles.
 *
 * Signal has no markup. A message is plain text plus offset-based style ranges
 * (`start:length:STYLE`). This module turns the agent's Markdown into that
 * shape, following the CommonMark rules that matter for chat text:
 *
 *  - fenced code blocks and code spans are literal (no further formatting);
 *  - backslash escapes (`\_`, `\*`, ...) produce the literal character;
 *  - emphasis uses the CommonMark delimiter-run algorithm, so `_` inside a
 *    word (`iphone_15_pro_max`) never starts or ends emphasis;
 *  - emphasis never crosses a blank line.
 *
 * Signal-only extras: `~~strike~~` and `||spoiler||` (exactly two characters).
 *
 * Offsets are UTF-16 code units of the *output* text, as before.
 */

export type SignalStyleName = 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';

export interface SignalTextStyle {
  style: SignalStyleName;
  start: number;
  length: number;
}

export interface StyledText {
  text: string;
  textStyles: SignalTextStyle[];
}

// ---------------------------------------------------------------------------
// Inline tree
// ---------------------------------------------------------------------------

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'styled'; style: SignalStyleName; children: Node[] }
  | { kind: 'delim'; char: string; count: number; orig: number; canOpen: boolean; canClose: boolean };

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;

const isWs = (ch: string | undefined): boolean => ch === undefined || WHITESPACE.test(ch);
const isPunct = (ch: string | undefined): boolean => ch !== undefined && UNICODE_PUNCT.test(ch);

/** Code point before `index` / at `index` (undefined = text boundary). */
function charBefore(s: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const cp = s.codePointAt(index - 1);
  // Low surrogate: step back to the full code point.
  if (cp !== undefined && cp >= 0xdc00 && cp <= 0xdfff && index >= 2)
    return String.fromCodePoint(s.codePointAt(index - 2)!);
  return s[index - 1];
}
const charAt = (s: string, index: number): string | undefined =>
  index >= s.length ? undefined : String.fromCodePoint(s.codePointAt(index)!);

function tokenizeInline(src: string): Node[] {
  const nodes: Node[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      nodes.push({ kind: 'text', value: buf });
      buf = '';
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Backslash escape: `\` + ASCII punctuation → the punctuation, literally.
    if (ch === '\\' && i + 1 < src.length && ASCII_PUNCT.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    // Code span: a run of N backticks closed by the next run of exactly N.
    if (ch === '`') {
      let n = 0;
      while (src[i + n] === '`') n++;
      let close = -1;
      for (let j = i + n; j < src.length;) {
        if (src[j] !== '`') {
          j++;
          continue;
        }
        let m = 0;
        while (src[j + m] === '`') m++;
        if (m === n) {
          close = j;
          break;
        }
        j += m;
      }
      if (close === -1) {
        buf += src.slice(i, i + n); // no closer: literal backticks
        i += n;
        continue;
      }
      let content = src.slice(i + n, close).replace(/\n/g, ' ');
      // CommonMark: strip one space on each side when both are present.
      if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ kind: 'code', value: content });
      i = close + n;
      continue;
    }

    // Delimiter run: * _ ~ |
    if (ch === '*' || ch === '_' || ch === '~' || ch === '|') {
      let n = 0;
      while (src[i + n] === ch) n++;
      const prev = charBefore(src, i);
      const next = charAt(src, i + n);

      if ((ch === '~' || ch === '|') && n !== 2) {
        buf += src.slice(i, i + n);
        i += n;
        continue;
      }

      const leftFlanking = !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
      const rightFlanking = !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
      let canOpen: boolean;
      let canClose: boolean;
      if (ch === '_') {
        canOpen = leftFlanking && (!rightFlanking || isPunct(prev));
        canClose = rightFlanking && (!leftFlanking || isPunct(next));
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }

      if (!canOpen && !canClose) {
        buf += src.slice(i, i + n);
      } else {
        flush();
        nodes.push({ kind: 'delim', char: ch, count: n, orig: n, canOpen, canClose });
      }
      i += n;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  return nodes;
}

/** CommonMark "process emphasis", extended with exact-pair `~~` and `||`. */
function processEmphasis(nodes: Node[]): Node[] {
  const styleFor = (char: string, use: number): SignalStyleName => {
    if (char === '~') return 'STRIKETHROUGH';
    if (char === '|') return 'SPOILER';
    return use === 2 ? 'BOLD' : 'ITALIC';
  };

  let closerIdx = 0;
  while (closerIdx < nodes.length) {
    const closer = nodes[closerIdx];
    if (closer.kind !== 'delim' || !closer.canClose || closer.count === 0) {
      closerIdx++;
      continue;
    }

    // Nearest compatible opener to the left.
    let openerIdx = -1;
    for (let j = closerIdx - 1; j >= 0; j--) {
      const cand = nodes[j];
      if (cand.kind !== 'delim' || cand.char !== closer.char || !cand.canOpen || cand.count === 0) continue;
      // "Rule of 3" applies to * and _ only.
      if (
        (closer.char === '*' || closer.char === '_') &&
        (cand.canClose || closer.canOpen) &&
        (cand.orig + closer.orig) % 3 === 0 &&
        !(cand.orig % 3 === 0 && closer.orig % 3 === 0)
      ) {
        continue;
      }
      openerIdx = j;
      break;
    }

    if (openerIdx === -1) {
      closerIdx++;
      continue;
    }

    const opener = nodes[openerIdx] as Extract<Node, { kind: 'delim' }>;
    const use = closer.char === '~' || closer.char === '|' ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    opener.count -= use;
    closer.count -= use;

    // Everything between opener and closer becomes the styled node's children;
    // delimiters left in between could not match and stay literal.
    const children = nodes.slice(openerIdx + 1, closerIdx);
    const styled: Node = { kind: 'styled', style: styleFor(closer.char, use), children };
    nodes.splice(openerIdx + 1, closerIdx - openerIdx - 1, styled);
    closerIdx = openerIdx + 2; // the closer, now right after the styled node

    // Keep fully consumed delimiters out of the way of later matching.
    if (opener.count === 0) {
      nodes.splice(openerIdx, 1);
      closerIdx--;
    }
    if (closer.count === 0) {
      nodes.splice(closerIdx, 1);
    }
    // Closer with delimiters left is re-examined (same closerIdx).
  }
  return nodes;
}

function render(nodes: Node[], out: { text: string; styles: SignalTextStyle[] }): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out.text += node.value;
        break;
      case 'delim':
        out.text += node.char.repeat(node.count); // unmatched → literal
        break;
      case 'code': {
        const start = out.text.length;
        out.text += node.value;
        if (node.value.length > 0) out.styles.push({ style: 'MONOSPACE', start, length: node.value.length });
        break;
      }
      case 'styled': {
        const start = out.text.length;
        render(node.children, out);
        const length = out.text.length - start;
        if (length > 0) out.styles.push({ style: node.style, start, length });
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Blocks: fenced code, paragraphs
// ---------------------------------------------------------------------------

type Block = { kind: 'fence'; content: string } | { kind: 'prose'; value: string };

const FENCE_OPEN = /^ {0,3}(`{3,})[^`\n]*$/;

function splitBlocks(input: string): Block[] {
  const lines = input.split('\n');
  const blocks: Block[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length > 0) {
      blocks.push({ kind: 'prose', value: prose.join('\n') });
      prose = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      prose.push(lines[i]);
      continue;
    }
    const fenceLen = open[1].length;
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const m = /^ {0,3}(`{3,})[ \t]*$/.exec(lines[j]);
      if (m && m[1].length >= fenceLen) {
        closed = true;
        break;
      }
      body.push(lines[j]);
    }
    flushProse();
    blocks.push({ kind: 'fence', content: body.join('\n') });
    // Resume after the closing fence (or at the end for an unclosed fence).
    i = closed ? j : lines.length;
  }
  flushProse();
  return blocks;
}

/**
 * Convert Markdown to Signal plain text + style ranges.
 *
 * Text without Markdown comes back unchanged with an empty style list.
 */
export function parseSignalStyles(input: string): StyledText {
  const out = { text: '', styles: [] as SignalTextStyle[] };

  // Blocks are whole lines; consecutive blocks are separated by one newline.
  const blocks = splitBlocks(input);
  for (let b = 0; b < blocks.length; b++) {
    if (b > 0) out.text += '\n';
    const block = blocks[b];
    if (block.kind === 'fence') {
      const start = out.text.length;
      out.text += block.content;
      if (block.content.length > 0) out.styles.push({ style: 'MONOSPACE', start, length: block.content.length });
      continue;
    }
    // Emphasis cannot cross a blank line: parse each paragraph on its own.
    for (const part of block.value.split(/(\n[ \t]*\n)/)) {
      if (/^\n[ \t]*\n$/.test(part)) out.text += part;
      else render(processEmphasis(tokenizeInline(part)), out);
    }
  }

  return { text: out.text, textStyles: out.styles };
}
