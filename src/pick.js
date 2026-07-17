import { emitKeypressEvents } from 'node:readline';

const CLEAR_LINE = '\x1b[2K';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function safeLabel(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

export async function pickFiles(
  items,
  { label = 'Select files to delete', input = process.stdin, output = process.stdout } = {}
) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error(
      'The interactive picker requires a TTY. Pass explicit filenames instead.'
    );
  }

  if (items.length === 0) return [];

  const names = items.map((item) => typeof item === 'string' ? item : item.name);
  const selected = new Set();
  let cursor = 0;
  let rendered = false;
  const rowCount = names.length + 1;
  const wasRaw = Boolean(input.isRaw);
  const wasFlowing = input.readableFlowing === true;

  output.write(`${label}\n${HIDE_CURSOR}`);

  const render = () => {
    if (rendered) output.write(`\x1b[${rowCount}A`);

    const rows = names.map((name, index) => {
      const pointer = index === cursor ? '>' : ' ';
      const checkbox = selected.has(index) ? '[x]' : '[ ]';
      return `${CLEAR_LINE}\r${pointer} ${checkbox} ${safeLabel(name)}`;
    });
    rows.push(`${CLEAR_LINE}\r  ↑/↓ move  space toggle  enter confirm  q cancel`);
    output.write(`${rows.join('\n')}\n`);
    rendered = true;
  };

  const clearPicker = () => {
    if (!rendered) return;
    output.write(`\x1b[${rowCount}A`);
    for (let index = 0; index < rowCount; index += 1) {
      output.write(`${CLEAR_LINE}\r\n`);
    }
  };

  return new Promise((resolve, reject) => {
    const finish = (result, error) => {
      input.removeListener('keypress', onKeypress);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);

      try {
        if (!wasRaw) input.setRawMode(false);
      } catch {
        // The terminal may already be closed; cursor restoration still matters.
      }
      if (!wasFlowing && typeof input.pause === 'function') input.pause();
      clearPicker();
      output.write(SHOW_CURSOR);

      if (error) reject(error);
      else resolve(result);
    };

    const onKeypress = (character, key = {}) => {
      if ((key.ctrl && key.name === 'c') || character === 'q') {
        finish(null);
      } else if (key.name === 'up') {
        cursor = (cursor - 1 + names.length) % names.length;
        render();
      } else if (key.name === 'down') {
        cursor = (cursor + 1) % names.length;
        render();
      } else if (key.name === 'space' || character === ' ') {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        finish(names.filter((_, index) => selected.has(index)));
      }
    };
    const onEnd = () => finish(null);
    const onError = (error) => finish(null, error);

    try {
      emitKeypressEvents(input);
      input.on('keypress', onKeypress);
      input.once('end', onEnd);
      input.once('error', onError);
      if (!wasRaw) input.setRawMode(true);
      if (typeof input.resume === 'function') input.resume();
      render();
    } catch (error) {
      finish(null, error);
    }
  });
}
