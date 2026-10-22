"use strict";

// The keys a 두벌식 (2-set Korean) typist pressed, from the Hangul the terminal sent.
//
// Under a Korean input source the terminal's IME composes before tweb sees anything: `f` is `ㄹ`,
// and `f` then `j` arrives as the one syllable `러`. In normal mode those are commands, so the
// engine undoes the composition: a syllable is split into its jamo (leading consonant, vowel,
// final), compound vowels and finals into the keys that typed them, and each jamo is the QWERTY
// key under it. `러` -> `fj`, `ㅘ` -> `hk`, `읽` -> `dlfr`.
//
// This is the fallback. The IME still holds the last key until the next one closes it, so the
// real fix is the input source (crates/tweb-cli/src/ime.rs); this makes what does arrive count.

const JAMO_KEYS = {
  "ㅂ": "q", "ㅃ": "Q", "ㅈ": "w", "ㅉ": "W", "ㄷ": "e", "ㄸ": "E", "ㄱ": "r", "ㄲ": "R",
  "ㅅ": "t", "ㅆ": "T", "ㅛ": "y", "ㅕ": "u", "ㅑ": "i", "ㅐ": "o", "ㅒ": "O", "ㅔ": "p", "ㅖ": "P",
  "ㅁ": "a", "ㄴ": "s", "ㅇ": "d", "ㄹ": "f", "ㅎ": "g", "ㅗ": "h", "ㅓ": "j", "ㅏ": "k", "ㅣ": "l",
  "ㅋ": "z", "ㅌ": "x", "ㅊ": "c", "ㅍ": "v", "ㅠ": "b", "ㅜ": "n", "ㅡ": "m",
  // Compounds: the two keys that make them.
  "ㅘ": "hk", "ㅙ": "ho", "ㅚ": "hl", "ㅝ": "nj", "ㅞ": "np", "ㅟ": "nl", "ㅢ": "ml",
  "ㄳ": "rt", "ㄵ": "sw", "ㄶ": "sg", "ㄺ": "fr", "ㄻ": "fa", "ㄼ": "fq", "ㄽ": "ft",
  "ㄾ": "fx", "ㄿ": "fv", "ㅀ": "fg", "ㅄ": "qt",
};

// Unicode's syllable order (U+AC00 = 가): 19 leading consonants x 21 vowels x 28 finals (0 = none).
const LEADS = [..."ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"];
const VOWELS = [..."ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"];
const FINALS = ["", ..."ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"];
const SYLLABLE_FIRST = 0xac00;
const SYLLABLE_LAST = 0xd7a3;

function jamoKeys(jamo) {
  return JAMO_KEYS[jamo] ?? null;
}

/** The QWERTY keys for one Hangul character (a syllable or a compatibility jamo), or null. */
function hangulKeys(char) {
  const codepoint = String(char).codePointAt(0);
  if (codepoint >= SYLLABLE_FIRST && codepoint <= SYLLABLE_LAST) {
    const index = codepoint - SYLLABLE_FIRST;
    const lead = LEADS[Math.floor(index / (21 * 28))];
    const vowel = VOWELS[Math.floor(index / 28) % 21];
    const final = FINALS[index % 28];
    return `${jamoKeys(lead)}${jamoKeys(vowel)}${final ? jamoKeys(final) : ""}`;
  }
  // Conjoining jamo (the U+1100 block, what NFD makes of a syllable) are in the same order as the
  // syllable tables, so they index straight into them.
  if (codepoint >= 0x1100 && codepoint <= 0x1112) return jamoKeys(LEADS[codepoint - 0x1100]);
  if (codepoint >= 0x1161 && codepoint <= 0x1175) return jamoKeys(VOWELS[codepoint - 0x1161]);
  if (codepoint >= 0x11a8 && codepoint <= 0x11c2) return jamoKeys(FINALS[codepoint - 0x11a7]);
  return jamoKeys(char);
}

module.exports = { hangulKeys };
