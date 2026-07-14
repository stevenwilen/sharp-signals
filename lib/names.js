// Fighter-name handling. ONE place, because every part of this system joins on names:
// the extractor emits a name, Kalshi lists a name, BestFightOdds lists a name, and if any two
// of them disagree the pick is silently dropped — or worse, silently matched to the wrong man.
//
// Two real bugs this exists to kill:
//
// 1. WRONG FIGHTER, WRONG PRICE. results.js matched on surname alone, so a pick for
//    "Daniel Santos" resolved to the JUNIOR DOS SANTOS market and was graded against his
//    price. Same surname, different fight, different human. Nothing flagged it.
//
// 2. ONE FIGHTER, TWO PEOPLE. Sources spell names differently from Kalshi. Paddy vs Patty
//    Pimblett, Sean vs Shawn O'Malley, Rei vs Ray Tsuruya. The two spellings never matched, so
//    picks were dropped and both "sides" of a fight could resolve to the same guy. Eleven of
//    thirty-two two-sided fights had prices that did not sum to ~1 — the signature of this.
const RAW_ALIASES = {
  "patty pimblett": "paddy pimblett",
  "shawn omalley": "sean omalley",
  "ray tsuruya": "rei tsuruya",
  "daniil donchenko": "danil donchenko",
  "alexandro costa": "alessandro costa",
  "brian norman": "brian norman jr",
  "brian norman junior": "brian norman jr",
};

// Lowercase, strip accents, collapse whitespace.
//
// Apostrophes are DELETED, not turned into spaces. Otherwise "O'Malley" becomes the two tokens
// "o" and "malley", which never matches "OMalley" — so Sean O'Malley failed to match himself
// depending on which side spelled it with the apostrophe.
const norm = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/['’`.]/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const ALIASES = {};
for (const [k, v] of Object.entries(RAW_ALIASES)) ALIASES[norm(k)] = norm(v);

// The name we join on.
function canonical(name) {
  const n = norm(name);
  return ALIASES[n] || n;
}

const tokens = (s) => canonical(s).split(" ").filter(Boolean);
const surname = (s) => { const t = tokens(s); return t[t.length - 1] || ""; };

// How strongly does `text` refer to the fighter `name`?
//   3 = it IS the name
//   2 = every token of the name appears ("Kamaru Usman by KO" -> Kamaru Usman)
//   1 = the surname alone appears  <- NEVER sufficient on its own. Two fighters share a
//       surname more often than you'd think, and a surname can appear inside a phrase about
//       the OTHER man ("Usman over Du Plessis"). Callers must corroborate a 1 or refuse.
//   0 = no reference
function nameScore(text, name) {
  if (!text || !name) return 0;
  const t = canonical(text), n = canonical(name);
  if (!t || !n) return 0;
  if (t === n) return 3;
  const tt = tokens(t), nt = tokens(n);
  if (nt.length && nt.every((x) => tt.includes(x))) return 2;
  if (nt.length && tt.includes(nt[nt.length - 1])) return 1;
  return 0;
}

module.exports = { canonical, norm, nameScore, tokens, surname, ALIASES };
