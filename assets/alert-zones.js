// src/feeds/alerts.mjs
var ORIGIN = "https://api.weather.gov";
var ALERTS_URL = ORIGIN + "/alerts/active";
var COUNT_URL = ALERTS_URL + "/count";
var STATE = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI".split(" "));
var MAX_AGE = 15 * 6e4;
var UTC_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
var control = /[\u0000-\u001f\u007f]+/g;
var tidy = (s, max = 260) => typeof s === "string" ? s.replace(control, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
var iso = (t) => new Date(t).toISOString().replace(".000Z", "Z");
var time = (s) => typeof s === "string" && UTC_STAMP.test(s) && Number.isFinite(Date.parse(s)) ? Date.parse(s) : null;
var unique = (a) => [...new Set(a)];
var strings = (a) => Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
function cleanGeometry(g) {
  if (!g || !["Polygon", "MultiPolygon"].includes(g.type)) return null;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  if (!Array.isArray(polys) || !polys.length) return null;
  const out = [];
  for (const p of polys) {
    if (!Array.isArray(p) || !p.length) return null;
    const rings = [];
    for (const ring of p) {
      if (!Array.isArray(ring) || ring.length < 4) return null;
      const rr = [];
      for (const xy of ring) {
        if (!Array.isArray(xy) || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1]) || Math.abs(xy[0]) > 180 || Math.abs(xy[1]) > 90) return null;
        rr.push([xy[0], xy[1]]);
      }
      const [first, last] = [rr[0], rr[rr.length - 1]];
      if (last[0] !== first[0] || last[1] !== first[1] || new Set(rr.map((x) => x.join(","))).size < 3) return null;
      rings.push(rr);
    }
    out.push(rings);
  }
  return { type: g.type, coordinates: g.type === "Polygon" ? out[0] : out };
}
var ZONE_LINK = /^https:\/\/api\.weather\.gov\/zones\/(forecast|public|land|marine|coastal|offshore|fire)\/([A-Z]{2}Z[0-9]{3})$/;
async function resolveAlertZones(event, asOf = /* @__PURE__ */ new Date(), fetchFn = fetch, cache = /* @__PURE__ */ new Map()) {
  const at = +new Date(asOf);
  const urls = unique(strings(event?.zone_urls).filter((u) => ZONE_LINK.test(u)));
  const codes = new Set(strings(event?.ugc)), shapes = [], missing = new Set(codes);
  if (!Number.isFinite(at) || !urls.length || event?.unit !== "CAP message" || event?.warning_identity_status === "needs review") {
    return { status: "unavailable", geometry: [], zones: [], missing_ugc: [...missing].sort(), role: "NWS forecast zones" };
  }
  async function resolve(url) {
    const [, kind, code] = ZONE_LINK.exec(url);
    if (!codes.has(code)) return;
    let zone = cache.get(url);
    if (!zone || Date.now() - zone.cached_at > 12 * 36e5 || at < zone.start || at >= zone.end) {
      try {
        const u = new URL(url);
        u.searchParams.set("effective", iso(at));
        const res = await fetchFn(u.href, { headers: { Accept: "application/geo+json" }, redirect: "manual", signal: AbortSignal.timeout(1e4) });
        if (!res.ok) return;
        const f = await res.json(), p = f?.properties;
        if (f?.type !== "Feature" || f.id !== url || p?.id !== code || !["public", "coastal", "offshore", "fire", "marine", "land"].includes(p.type)) return;
        if (["public", "coastal", "offshore", "fire"].includes(kind) && p.type !== kind) return;
        const start = time(p.effectiveDate), end = time(p.expirationDate), geometry = cleanGeometry(f.geometry);
        if (!geometry || start === null || end === null || !(start <= at && at < end)) return;
        zone = { start, end, cached_at: Date.now(), geometry, info: {
          ugc: code,
          name: tidy(p.name, 120),
          type: p.type,
          source_url: url,
          valid_from: iso(start),
          valid_until: iso(end)
        } };
        if (cache.size >= 300 && !cache.has(url)) cache.delete(cache.keys().next().value);
        cache.set(url, zone);
      } catch {
        return;
      }
    }
    shapes.push(zone);
    missing.delete(code);
  }
  for (let i = 0; i < urls.length; i += 4) await Promise.all(urls.slice(i, i + 4).map(resolve));
  shapes.sort((a, b) => a.info.ugc.localeCompare(b.info.ugc));
  return {
    status: !shapes.length ? "unavailable" : missing.size ? "partial" : "ok",
    geometry: shapes.map((z) => z.geometry),
    zones: shapes.map((z) => z.info),
    missing_ugc: [...missing].sort(),
    role: "NWS forecast zones"
  };
}
export {
  resolveAlertZones
};
