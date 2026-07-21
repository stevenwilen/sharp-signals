// YOUTUBE SEARCH mapper — refusal-first. search.list has a DIFFERENT shape than playlistItems (id at
// it.id.videoId), and searched results must obey the SAME combat/prediction/anti-hindsight filters as the
// roster scan or the extractor gets fed basketball. These test the pure mapSearchResults; the network call
// (searchVideos) is a thin wrapper that does not swallow quota (structurally — no try/catch around api()).
const YT = require("../lib/youtube");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; process.stdout.write(`  PASS  ${m}\n`); } else { fail++; process.stdout.write(`  FAIL  ${m}\n`); } };
const item = (videoId, title, channelTitle = "Some MMA Channel", publishedAt = "2026-07-20T00:00:00Z", channelId = "UC_test_channel") =>
  ({ id: { videoId }, snippet: { title, channelTitle, publishedAt, channelId } });

// 1. Reads it.id.videoId (NOT snippet.resourceId.videoId) and emits the findVideos shape.
{
  const [v] = YT.mapSearchResults([item("abc123", "Jones vs Aspinall UFC prediction", "MMA Guy")]);
  ok(v && v.videoId === "abc123", "1a. reads it.id.videoId (search.list shape)");
  ok(v && v.url === "https://www.youtube.com/watch?v=abc123", "1b. builds the watch url");
  ok(v && v.source === "MMA Guy" && v.domain === null, "1c. source = channelTitle, domain = null");
  ok(v && v.title && v.publishedAt, "1d. carries title + publishedAt");
  ok(v && v.channelId === "UC_test_channel", "1e. carries channelId (so the roster-channel skip can dedupe by identity)");
}

// 2-4. The three filters must REFUSE the wrong content.
ok(YT.mapSearchResults([item("x", "Lakers vs Celtics NBA picks & prediction")]).length === 0, "2. non-combat 'picks' REFUSED by SPORT_RE");
ok(YT.mapSearchResults([item("x", "UFC 300 fighter walkout music compilation")]).length === 0, "3. combat but non-prediction REFUSED by PRED_RE");
ok(YT.mapSearchResults([item("x", "Jones vs Aspinall UFC prediction RECAP")]).length === 0, "4. post-fight 'recap' REFUSED by POST_RE (hindsight)");

// 5. Malformed items are dropped (no fake entries).
ok(YT.mapSearchResults([{ id: {}, snippet: { title: "UFC fight prediction", publishedAt: "2026-07-20T00:00:00Z" } }]).length === 0, "5a. missing videoId dropped");
ok(YT.mapSearchResults([{ id: { videoId: "y" }, snippet: { title: "UFC fight prediction" } }]).length === 0, "5b. missing publishedAt dropped");
ok(YT.mapSearchResults(null).length === 0 && YT.mapSearchResults(undefined).length === 0, "5c. null/undefined items -> []");

// 6. A genuine combat prediction survives.
ok(YT.mapSearchResults([item("z", "Khabib vs McGregor UFC breakdown and prediction")]).length === 1, "6. genuine combat prediction is INCLUDED");

// 7. searchVideos exists and is exported (the network wrapper).
ok(typeof YT.searchVideos === "function", "7. searchVideos is exported");

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
