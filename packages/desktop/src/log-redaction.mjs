import { StringDecoder } from 'node:string_decoder';

export function createTerminalFilter() {
  const decoder = new StringDecoder('utf8');
  let state = 'text';
  const clean = (text) => {
    let output = '';
    for (const character of text) {
      if (state === 'osc') {
        if (character === '\u0007' || character === '\u009c') state = 'text';
        else if (character === '\u001b') state = 'oscEscape';
      } else if (state === 'oscEscape') {
        state = character === '\\' ? 'text' : 'osc';
      } else if (state === 'csi') {
        if (character >= '@' && character <= '~') state = 'text';
      } else if (state === 'escape') {
        state = character === '[' ? 'csi' : character === ']' ? 'osc' : 'text';
      } else if (character === '\u001b') state = 'escape';
      else if (character === '\u009b') state = 'csi';
      else if (character === '\u009d') state = 'osc';
      else if (character === '\n' || character === '\t' || character >= ' ' && character !== '\u007f') output += character;
    }
    return output;
  };
  return {
    write: (chunk) => clean(Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)),
    flush: () => clean(decoder.end()),
  };
}

export function createLogRedactor(secrets) {
  const values = [...secrets].sort((a, b) => b.length - a.length);
  let pending = '';
  return {
    write(chunk) {
      let text = pending + chunk.toString();
      for (const secret of values) text = text.replaceAll(secret, '[hidden]');
      let keep = 0;
      for (const secret of values) {
        for (let size = Math.min(secret.length - 1, text.length); size > keep; size--) {
          if (text.endsWith(secret.slice(0, size))) { keep = size; break; }
        }
      }
      pending = keep ? text.slice(-keep) : '';
      return keep ? text.slice(0, -keep) : text;
    },
    flush() {
      const text = pending ? '[hidden]' : '';
      pending = '';
      return text;
    },
  };
}
