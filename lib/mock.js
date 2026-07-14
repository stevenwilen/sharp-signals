// Deterministic mock predictions to exercise grade -> match -> signal with NO keys.
// Resolved picks give sources a track record; fresh picks (on the live July 18 UFC
// card + live boxing) generate real signals against current Kalshi prices.

const DAY = 86400000;

// Build n resolved picks all at implied price `p`, with a win count that yields
// a realized ROI ≈ target. ROI = hitRate/p - 1  =>  hitRate = (target+1)*p.
function resolvedSet(source, domain, n, p, targetRoi, baseAgeDays = 120) {
  const winRate = Math.min(1, (targetRoi + 1) * p);
  const wins = Math.round(winRate * n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.now() - (baseAgeDays - (i * baseAgeDays) / n) * DAY).toISOString();
    out.push({
      source, domain, pick: `past-opponent-${i}`, priceAtCall: p,
      confidence: p, result: i < wins ? 1 : 0, timestamp: ts, resolved: true,
    });
  }
  return out;
}

function build() {
  const now = new Date().toISOString();
  const resolved = [
    // trusted: enough sample + beats the line
    ...resolvedSet("Din Thomas", "mma", 24, 0.45, 0.12),
    ...resolvedSet("Luke Thomas", "mma", 16, 0.5, 0.08),
    ...resolvedSet("Teddy Atlas", "boxing", 22, 0.5, 0.15),
    // NOT trusted: no real edge
    ...resolvedSet("Daniel Cormier", "mma", 20, 0.5, -0.02),
    ...resolvedSet("Chael Sonnen", "mma", 30, 0.5, 0.01),
    // NOT trusted: good edge but too few picks (sample gate)
    ...resolvedSet("Timothy Bradley", "boxing", 11, 0.5, 0.2),
  ];

  // Fresh (unresolved) picks on live markets -> should become signals.
  const fresh = [
    { source: "Din Thomas", domain: "mma", pick: "Kamaru Usman", confidence: 0.52,
      quote: "Usman's wrestling neutralizes DDP; live dog value.", timestamp: now, result: null },
    { source: "Luke Thomas", domain: "mma", pick: "Jared Cannonier", confidence: 0.47,
      quote: "Cannonier power is underrated here.", timestamp: now, result: null },
    { source: "Teddy Atlas", domain: "boxing", pick: "Harlem Eubank", confidence: 0.55,
      quote: "Eubank boxing IQ carries it.", timestamp: now, result: null },
    // untrusted source pick (research-only)
    { source: "Daniel Cormier", domain: "mma", pick: "Dricus Du Plessis", confidence: 0.72,
      quote: "DDP cardio + pressure.", timestamp: now, result: null },
  ];
  return { resolved, fresh };
}

module.exports = { build };
