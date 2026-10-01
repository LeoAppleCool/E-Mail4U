import { randomInt } from 'node:crypto';

// No l, o, 0 or 1, so the names stay unambiguous when typed by hand.
const LETTERS = 'abcdefghijkmnpqrstuvwxyz';
const ALPHABET = `${LETTERS}23456789`;

/** Random name that always starts with a letter. */
export function randomLocalPart(length = 10) {
  let out = LETTERS[randomInt(LETTERS.length)];
  while (out.length < length) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function randomSuffix(length = 4) {
  let out = '';
  while (out.length < length) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
