# Kalshi fee verification — what was verified, and how it was reviewed

**Status:** PASS for the verified scope only
**Verified:** 2026-07-16
**Record:** `data/fee-verification.json` · **Examples:** `data/fee-examples.json` · **Enforced by:** `lib/contracts.js` `FEES.verifiedScope` + `withinVerifiedEnvelope()`

---

## The verified envelope — exact, and enforced in code

| dimension | verified value |
|---|---|
| Series | `KXUFCFIGHT` only (exact segment match, not a prefix) |
| Side | YES only |
| Execution | single-price taker Quick Order |
| Price range | 0.59 – 0.89 |
| Quantity range | 82.37 – 823.81 contracts |
| Fee formula | `ceil_to_cent(0.07 × contracts × price × (1 − price))` |

**Maker, NO, multi-fill, and other-series orders are unverified and fail closed.** This is asserted
by tests, not by convention. An order outside the envelope on *any* dimension is priced by
extrapolation and says so on the order record; it does not inherit credibility it did not earn.

Evidence: five authenticated, unsubmitted Kalshi UFC Quick Order tickets, all reproducing exactly
(diff 0.00) — $100 at 0.69/0.59/0.89, plus $50 and $500 at 0.59 which vary size at a fixed price.

---

## How this was reviewed — read this before citing the review

The extension of the envelope was checked by an independent adversarial review. **Two of three
lenses completed. The third did not run.**

| lens | status | verdict |
|---|---|---|
| Authorised bounds — did the extension exceed its authorisation? | **completed** | EXTENSION_SOUND |
| Blocked-still-blocked — did maker/NO/multi-fill/other-series leak? | **completed** | EXTENSION_SOUND |
| Small-size claims — are the linearity and ceil-premium claims true? | **FAILED** (StructuredOutput retry cap exceeded, 5 failed calls, no valid output) | *none* |

**This must not be described as three completed independent reviews.** It was two.

The third lens's subject matter — the small-size linearity claim and the ceil-premium figures — was
**manually reproduced and locked into tests instead**. That is a real check, and it is *not* an
independent one: it was performed by the same agent that wrote the claims, which is precisely the
weakness an independent lens exists to remove. The claims it covered:

- linearity over the 10× span at a fixed price (82.37 → 823.81 at 0.59) — reproduced exactly;
- the ceil premium (0.375% of the fee at 82.37, 0.003% at 823.81) — reproduced exactly;
- the $50 ticket's own rate interval being too wide (502 ppm) to tighten the 50 ppm intersection —
  reproduced exactly.

Anyone relying on this verification should treat those three claims as self-checked, and the
bounds/leak findings as independently checked.

## What the completed lenses found

The arithmetic survived every lens. The defects were all in the *labelling and gating* around it,
and each was reproduced by execution before being fixed:

1. **False provenance that shipped.** The scope text claimed round-half-up fits 1/5; it fits **2/5**.
   `priceOrder` copies that string onto every order.
2. **The maker gate was deny-by-exact-string.** `"Maker"`, `"MAKER"`, `"limit"`, `"post_only"`,
   `"passive"` were all priced at the full taker rate. Now an allowlist.
3. **The envelope failed *open* on missing data.** An order with no ticker passed the series gate as
   verified, through the full production path. Now every dimension fails closed.
4. **The flag contradicted its own warning.** A multi-fill order reported
   `withinVerifiedEnvelope: true` while its reasons said "untested". Now one channel.
5. **The series check was a prefix match.** `KXUFCFIGHTNIGHT-x` squatted `KXUFCFIGHT`.

## What this verification does NOT establish

Recorded in full in `FEES.verifiedScope.doesNotEstablish`. The load-bearing ones:

- **Maker fees.** No maker example exists. `makerRate` was removed rather than left at an untested
  `0.0` that `tradingFee` never read.
- **Settlement/exercise fees** — a separate Kalshi line item the order ticket never displays.
- **The P = 0.50 peak** — the very figure that motivates this gate. Tested `p(1−p)` is
  0.2419 / 0.2139 / 0.0979; the 0.2500 maximum is never observed. The "1.75¢ at 50¢" number is
  **interpolated from the fitted model, not measured.**
- **Linearity at prices other than 0.59.** Size was varied at one price only, so the separable form
  is measured on its two axes independently and the cross-term is inferred.
- **Sizes below 82.37 contracts**, where the ceil premium grows as size shrinks. At a $5k bankroll
  the 0.5% cap proposes ~42 contracts — still outside, still caveated.
- **Any date other than 2026-07-16.** There is no expiry check; the schedule could change.
