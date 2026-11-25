import { describe, expect, it } from 'vitest';

import { parseSignalStyles } from './signal-styles.js';

const fmt = (input: string) => {
  const { text, textStyles } = parseSignalStyles(input);
  return { text, styles: textStyles.map((s) => `${s.start}:${s.length}:${s.style}`).sort() };
};

const ID = 'sensor.iphone_15_pro_max_battery_state';

describe('parseSignalStyles', () => {
  it('returns plain text unchanged with no styles', () => {
    expect(fmt('No formatting here')).toEqual({ text: 'No formatting here', styles: [] });
  });

  describe('identifiers with underscores survive (all 5 underscores, no italics)', () => {
    it('plain', () => {
      expect(fmt(ID)).toEqual({ text: ID, styles: [] });
    });

    it('plain in a sentence', () => {
      expect(fmt(`State of ${ID} is 80%`)).toEqual({ text: `State of ${ID} is 80%`, styles: [] });
    });

    it('in backticks → monospace, underscores intact', () => {
      expect(fmt(`Entity \`${ID}\` ok`)).toEqual({ text: `Entity ${ID} ok`, styles: [`7:${ID.length}:MONOSPACE`] });
    });

    it('in a fenced code block', () => {
      const r = fmt('Entity:\n```\n' + ID + '\n```\nDone');
      expect(r).toEqual({ text: `Entity:\n${ID}\nDone`, styles: [`8:${ID.length}:MONOSPACE`] });
    });

    it('in a fenced code block with an info string', () => {
      const r = fmt('```yaml\nid: ' + ID + '\n```');
      expect(r.text).toBe(`id: ${ID}`);
      expect(r.styles).toEqual([`0:${ID.length + 4}:MONOSPACE`]);
    });

    it('file names and snake_case words', () => {
      expect(fmt('see my_file_name.py and snake_case_word')).toEqual({
        text: 'see my_file_name.py and snake_case_word',
        styles: [],
      });
    });

    it('trailing underscore after a word and leading underscore', () => {
      expect(fmt('foo_ and _bar x_y')).toEqual({ text: 'foo_ and _bar x_y', styles: [] });
    });
  });

  describe('code is literal', () => {
    it('keeps ** inside a code span without ending bold', () => {
      const r = fmt('**use `a**b` here**');
      expect(r.text).toBe('use a**b here');
      expect(r.styles).toEqual(['0:13:BOLD', '4:4:MONOSPACE']);
    });

    it('no emphasis inside code spans', () => {
      expect(fmt('`*not italic*` and `_x_`')).toEqual({
        text: '*not italic* and _x_',
        styles: ['0:12:MONOSPACE', '17:3:MONOSPACE'],
      });
    });

    it('no emphasis inside fenced blocks', () => {
      const r = fmt('```\n**a** _b_ ~~c~~\n```');
      expect(r.text).toBe('**a** _b_ ~~c~~');
      expect(r.styles).toEqual(['0:15:MONOSPACE']);
    });

    it('supports double-backtick spans containing a backtick', () => {
      expect(fmt('x `` a`b `` y')).toEqual({ text: 'x a`b y', styles: ['2:3:MONOSPACE'] });
    });

    it('keeps inline triple-backtick code on one line', () => {
      expect(fmt('Run ```npm test``` now')).toEqual({ text: 'Run npm test now', styles: ['4:8:MONOSPACE'] });
    });

    it('treats an unclosed backtick as literal', () => {
      expect(fmt('it`s fine')).toEqual({ text: 'it`s fine', styles: [] });
    });

    it('runs an unclosed fence to the end', () => {
      expect(fmt('```\na_b_c')).toEqual({ text: 'a_b_c', styles: ['0:5:MONOSPACE'] });
    });
  });

  describe('backslash escapes', () => {
    it('escaped underscores are literal', () => {
      expect(fmt('\\_a\\_ and sensor\\_x')).toEqual({ text: '_a_ and sensor_x', styles: [] });
    });

    it('escaped asterisks do not start bold', () => {
      expect(fmt('\\*\\*not bold\\*\\*')).toEqual({ text: '**not bold**', styles: [] });
    });

    it('escaped backtick does not open a code span', () => {
      expect(fmt('\\`a\\`')).toEqual({ text: '`a`', styles: [] });
    });

    it('keeps a backslash before non-punctuation', () => {
      expect(fmt('C:\\temp')).toEqual({ text: 'C:\\temp', styles: [] });
    });

    it('does not process escapes inside code', () => {
      expect(fmt('`a\\_b`')).toEqual({ text: 'a\\_b', styles: ['0:4:MONOSPACE'] });
    });
  });

  describe('emphasis', () => {
    it('bold', () => {
      expect(fmt('Hello **world**')).toEqual({ text: 'Hello world', styles: ['6:5:BOLD'] });
    });

    it('italic with * and _', () => {
      expect(fmt('Hello *world*')).toEqual({ text: 'Hello world', styles: ['6:5:ITALIC'] });
      expect(fmt('hey _there_')).toEqual({ text: 'hey there', styles: ['4:5:ITALIC'] });
    });

    it('allows intraword * (CommonMark)', () => {
      expect(fmt('un*frigging*believable')).toEqual({ text: 'unfriggingbelievable', styles: ['2:8:ITALIC'] });
    });

    it('italic _ next to punctuation', () => {
      expect(fmt('(_hi_)')).toEqual({ text: '(hi)', styles: ['1:2:ITALIC'] });
    });

    it('bold + italic with ***', () => {
      expect(fmt('***both***')).toEqual({ text: 'both', styles: ['0:4:BOLD', '0:4:ITALIC'] });
    });

    it('nested styles keep output offsets', () => {
      const r = fmt('**bold with `code` inside**');
      expect(r.text).toBe('bold with code inside');
      expect(r.styles).toEqual(['0:21:BOLD', '10:4:MONOSPACE']);
    });

    it('strikethrough and spoiler', () => {
      expect(fmt('a ~~gone~~ b')).toEqual({ text: 'a gone b', styles: ['2:4:STRIKETHROUGH'] });
      expect(fmt('a ||secret|| b')).toEqual({ text: 'a secret b', styles: ['2:6:SPOILER'] });
    });

    it('leaves list-style asterisks and lone delimiters literal', () => {
      expect(fmt('* one\n* two')).toEqual({ text: '* one\n* two', styles: [] });
      expect(fmt('2 * 3 * 4 and a || b')).toEqual({ text: '2 * 3 * 4 and a || b', styles: [] });
      expect(fmt('**unclosed bold')).toEqual({ text: '**unclosed bold', styles: [] });
    });

    it('does not carry emphasis across a blank line', () => {
      expect(fmt('*a\n\nb*')).toEqual({ text: '*a\n\nb*', styles: [] });
    });

    it('works across several paragraphs and a code block', () => {
      const r = fmt('**One**\n\n```\nx_y\n```\n\n_Two_');
      expect(r.text).toBe('One\n\nx_y\n\nTwo');
      expect(r.styles).toEqual(['0:3:BOLD', '10:3:ITALIC', '5:3:MONOSPACE'].sort());
    });
  });
});
