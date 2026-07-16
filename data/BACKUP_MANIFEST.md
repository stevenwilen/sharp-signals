# Backup Manifest — off-repo raw caches

**These datasets are deliberately NOT committed.** They are large, re-fetchable in principle, and
would bloat the repository. But re-fetching them cost **~8 hours** of throttled scraping, and they
are the entire basis of the fighter and odds databases — so they are archived, checksummed, and
stored in two places. This file is the tracked record of where they are and how to prove they are intact.

**Created:** 2026-07-16
**Repository commit at creation:** `15e3cdb7e91ed07c7283b085f85bbc680d325fb2`
**V1 archive tag:** `v1-archive` → `d3fff9d`

---

## Archives

### 1. Wikipedia fighter cache

| Field | Value |
|---|---|
| Archive | `Sharp-Signals-Wiki-Cache-2026-07-16.tar.gz` |
| SHA-256 | `287ed1090a48a02f8f0fd44734233e0f84c5f8ace2adfd4e61e278029d7e8881` |
| File count | **14,112** (8,286 `.txt` wikitext pages + 5,826 `search_*.json` title-resolution caches) |
| Uncompressed | 312,695,748 bytes (298 MiB) |
| Compressed | 98,381,819 bytes (94 MiB) |
| Source path | `data/wiki/` |

**How it was collected:** fetched from the Wikipedia MediaWiki API during the 24-month backfill
(2026-07-15/16). Titles resolved via `action=opensearch` (cached as `search_*.json` because opensearch
is not page-cached and the backfill looks up the same fighter hundreds of times); page bodies via
`action=parse&prop=wikitext`. Throttled to a 250 ms minimum gap with fail-fast retry
(`lib/ufc-results.js`). **708 pages carry an `{{MMA record}}` table**; 707 of those also carry
`{{birth date and age|Y|M|D}}` — this is the fighter database and the sole source of the ages used in
the youth study. The remaining pages are either non-fighter articles pulled in by imperfect name
searches (e.g. `2011_Norway_attacks.txt`, from a fighter-name query that missed) or fighters whose
pages lack a record table. Harmless, and retained rather than pruned so the cache stays a faithful
snapshot. Results parsed from this cache validated **8/8 against Kalshi settlements**.

### 2. BestFightOdds cache

| Field | Value |
|---|---|
| Archive | `Sharp-Signals-BFO-Cache-2026-07-16.tar.gz` |
| SHA-256 | `ad9eb0d10b3304bc5fb76532b495b3245f8016bd5fc26c466365a655a1d36ac4` |
| File count | **1,261** (481 fighter pages + 780 search pages) |
| Uncompressed | 44,501,964 bytes (42 MiB) |
| Compressed | 6,267,787 bytes (6.0 MiB) |
| Source path | `data/bfo/` |

**How it was collected:** scraped from `bestfightodds.com` during the backfill and the live-divergence
tests, throttled to a 200 ms minimum gap (`lib/odds-history.js`). Each fighter page carries that
fighter's **entire** bout history with open and closing moneylines for both sides, which is why 481
pages yield **~5,230 unique fights**. Prices are de-vigged by normalising the two sides' implied
probabilities; any parse producing an overround outside 1.01–1.12 is rejected rather than believed.
The de-vig validated **14/14 against Kalshi**. This is the odds database and the source of every
closing line in the youth confirmation study.

> **Warning for future readers:** these are *settled-fight* pages, which never change — that is why
> caching them is safe. Reading this cache for a **live/upcoming** price would return a stale number
> and silently corrupt any comparison. Live reads must use `oh.fetchLive()`, which bypasses the cache.

---

## Storage locations (two copies)

| Copy | Path | Notes |
|---|---|---|
| Local, outside the repo | `C:\Users\steve\Sharp Signals Archive\` | Same disk as the originals — protects against repo mistakes, not disk failure |
| Off-device | `C:\Users\steve\OneDrive\Documents\Sharp Signals Archive\` | Cloud-synced — this is the copy that survives the disk |

`checksums.sha256` sits alongside the archives in both locations.

**The originals in `data/wiki/` and `data/bfo/` were not deleted** and remain gitignored.

---

## Verification performed (2026-07-16)

All checks passed at creation:

1. **Checksums recalculated** after writing — recorded above.
2. **Archives opened** successfully (`tar -tzf`).
3. **File counts confirmed** against the live directories: 14,112 = 14,112 and 1,261 = 1,261.
4. **Samples extracted and read**: `Aaron_Pico.txt` (63,397 bytes) still contains
   `{{birth date and age|1996|09|23}}`; `www_bestfightodds_com_fighters_aaron_pico_7170.html`
   (58,622 bytes) is valid HTML.
5. **Byte-for-byte comparison** of an extracted file against its original: identical.
6. **The off-device copies were verified independently** with `sha256sum -c` after copying, rather
   than trusting `cp`.

## How to verify again later

```bash
cd "/c/Users/steve/OneDrive/Documents/Sharp Signals Archive"   # or the local copy
sha256sum -c checksums.sha256          # must print OK for both
tar -tzf Sharp-Signals-Wiki-Cache-2026-07-16.tar.gz | grep -vc '/$'   # expect 14112
tar -tzf Sharp-Signals-BFO-Cache-2026-07-16.tar.gz  | grep -vc '/$'   # expect 1261
```

## How to restore

```bash
tar -xzf Sharp-Signals-Wiki-Cache-2026-07-16.tar.gz -C /c/Users/steve/SharpSignals/data
tar -xzf Sharp-Signals-BFO-Cache-2026-07-16.tar.gz  -C /c/Users/steve/SharpSignals/data
```

Archives expand to `wiki/` and `bfo/` respectively, so extracting into `data/` restores the original
paths exactly.
