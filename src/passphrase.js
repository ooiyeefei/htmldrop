import { randomInt } from 'node:crypto';

// Small embedded word list for memorable passphrases. Kept short, neutral, and
// unambiguous on purpose: colors, nature, objects, animals. No system
// dictionary, no dependencies. This is a CONVENIENCE for memorability only —
// it trades entropy for recall. Users who want higher entropy (sensitive docs)
// should supply their own long password via --password, ideally piped from a
// password manager (see the tip printed after `push`).
const WORDS = [
  // colors
  'red', 'blue', 'green', 'gold', 'cyan', 'jade', 'plum', 'ruby',
  'coral', 'amber', 'ivory', 'slate', 'olive', 'lilac', 'teal', 'indigo',
  // nature
  'river', 'stone', 'cloud', 'leaf', 'fern', 'pine', 'birch', 'cedar',
  'willow', 'maple', 'ocean', 'meadow', 'valley', 'cliff', 'dune', 'brook',
  'grove', 'harbor', 'field', 'forest',
  // objects
  'lantern', 'anchor', 'beacon', 'compass', 'feather', 'quill', 'ribbon', 'marble',
  'pebble', 'kettle', 'mallet', 'rudder', 'saddle', 'spindle', 'thimble', 'wagon',
  'yarn', 'hammock',
  // animals
  'heron', 'robin', 'finch', 'sparrow', 'otter', 'badger', 'ferret', 'walrus',
  'bison', 'camel', 'falcon', 'puffin', 'magpie', 'wren', 'raven', 'starling',
];

// Generate a memorable passphrase: two lowercase words + a 2-digit number,
// e.g. "coral-sunset-42". Selection uses node:crypto randomInt (NOT Math.random)
// so every index is cryptographically secure. The 2-digit number (10..99) is
// also drawn with randomInt. Words may repeat, which is fine — the format stays
// valid and the goal is recall, not maximizing entropy.
export function generatePassphrase() {
  const a = WORDS[randomInt(0, WORDS.length)];
  const b = WORDS[randomInt(0, WORDS.length)];
  const n = randomInt(10, 100); // 10..99 inclusive -> always two digits
  return `${a}-${b}-${n}`;
}
