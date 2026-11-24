/** Cartographic product colors. The NWS table lists lower numbers first in priority. */
export const PALETTE_SOURCES = Object.freeze({
  warnings: 'https://www.weather.gov/help-map/',
  ero: 'https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer/0',
  wssi: 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer/4',
  extended: 'https://mapservices.weather.noaa.gov/vector/rest/services/hazards/cpc_weather_hazards/MapServer'
});

// weather.gov Warnings, Watches and Advisories table, revised March 10, 2025.
// [display name, priority, published hexadecimal color, display as transparent?]
export const WWA = Object.freeze([
  Object.freeze(["Tsunami Warning", 1, "#FD6347"]),
  Object.freeze(["Tornado Warning", 2, "#FF0000"]),
  Object.freeze(["Extreme Wind Warning", 3, "#FF8C00"]),
  Object.freeze(["Severe Thunderstorm Warning", 4, "#FFA500"]),
  Object.freeze(["Flash Flood Warning", 5, "#8B0000"]),
  Object.freeze(["Flash Flood Statement", 6, "#8B0000"]),
  Object.freeze(["Severe Weather Statement", 7, "#00FFFF"]),
  Object.freeze(["Shelter In Place Warning", 8, "#FA8072"]),
  Object.freeze(["Evacuation Immediate", 9, "#7FFF00"]),
  Object.freeze(["Civil Danger Warning", 10, "#FFB6C1"]),
  Object.freeze(["Nuclear Power Plant Warning", 11, "#4B0082"]),
  Object.freeze(["Radiological Hazard Warning", 12, "#4B0082"]),
  Object.freeze(["Hazardous Materials Warning", 13, "#4B0082"]),
  Object.freeze(["Fire Warning", 14, "#A0522D"]),
  Object.freeze(["Civil Emergency Message", 15, "#FFB6C1"]),
  Object.freeze(["Law Enforcement Warning", 16, "#C0C0C0"]),
  Object.freeze(["Storm Surge Warning", 17, "#B524F7"]),
  Object.freeze(["Hurricane Force Wind Warning", 18, "#CD5C5C"]),
  Object.freeze(["Hurricane Warning", 19, "#DC143C"]),
  Object.freeze(["Typhoon Warning", 20, "#DC143C"]),
  Object.freeze(["Special Marine Warning", 21, "#FFA500"]),
  Object.freeze(["Blizzard Warning", 22, "#FF4500"]),
  Object.freeze(["Snow Squall Warning", 23, "#C71585"]),
  Object.freeze(["Ice Storm Warning", 24, "#8B008B"]),
  Object.freeze(["Heavy Freezing Spray Warning", 25, "#00BFFF"]),
  Object.freeze(["Winter Storm Warning", 26, "#FF69B4"]),
  Object.freeze(["Lake Effect Snow Warning", 27, "#008B8B"]),
  Object.freeze(["Dust Storm Warning", 28, "#FFE4C4"]),
  Object.freeze(["Blowing Dust Warning", 29, "#FFE4C4"]),
  Object.freeze(["High Wind Warning", 30, "#DAA520"]),
  Object.freeze(["Tropical Storm Warning", 31, "#B22222"]),
  Object.freeze(["Storm Warning", 32, "#9400D3"]),
  Object.freeze(["Tsunami Advisory", 33, "#D2691E"]),
  Object.freeze(["Tsunami Watch", 34, "#FF00FF"]),
  Object.freeze(["Avalanche Warning", 35, "#1E90FF"]),
  Object.freeze(["Earthquake Warning", 36, "#8B4513"]),
  Object.freeze(["Volcano Warning", 37, "#2F4F4F"]),
  Object.freeze(["Ashfall Warning", 38, "#A9A9A9"]),
  Object.freeze(["Flood Warning", 39, "#00FF00"]),
  Object.freeze(["Coastal Flood Warning", 40, "#228B22"]),
  Object.freeze(["Lakeshore Flood Warning", 41, "#228B22"]),
  Object.freeze(["Ashfall Advisory", 42, "#696969"]),
  Object.freeze(["High Surf Warning", 43, "#228B22"]),
  Object.freeze(["Extreme Heat Warning", 44, "#C71585"]),
  Object.freeze(["Tornado Watch", 45, "#FFFF00"]),
  Object.freeze(["Severe Thunderstorm Watch", 46, "#DB7093"]),
  Object.freeze(["Flash Flood Watch", 47, "#2E8B57"]),
  Object.freeze(["Gale Warning", 48, "#DDA0DD"]),
  Object.freeze(["Flood Statement", 49, "#00FF00"]),
  Object.freeze(["Extreme Cold Warning", 50, "#0000FF"]),
  Object.freeze(["Freeze Warning", 51, "#483D8B"]),
  Object.freeze(["Red Flag Warning", 52, "#FF1493"]),
  Object.freeze(["Storm Surge Watch", 53, "#DB7FF7"]),
  Object.freeze(["Hurricane Watch", 54, "#FF00FF"]),
  Object.freeze(["Hurricane Force Wind Watch", 55, "#9932CC"]),
  Object.freeze(["Typhoon Watch", 56, "#FF00FF"]),
  Object.freeze(["Tropical Storm Watch", 57, "#F08080"]),
  Object.freeze(["Storm Watch", 58, "#FFE4B5"]),
  Object.freeze(["Tropical Cyclone Local Statement", 59, "#FFE4B5"]),
  Object.freeze(["Winter Weather Advisory", 60, "#7B68EE"]),
  Object.freeze(["Avalanche Advisory", 61, "#CD853F"]),
  Object.freeze(["Cold Weather Advisory", 62, "#AFEEEE"]),
  Object.freeze(["Heat Advisory", 63, "#FF7F50"]),
  Object.freeze(["Flood Advisory", 64, "#00FF7F"]),
  Object.freeze(["Coastal Flood Advisory", 65, "#7CFC00"]),
  Object.freeze(["Lakeshore Flood Advisory", 66, "#7CFC00"]),
  Object.freeze(["High Surf Advisory", 67, "#BA55D3"]),
  Object.freeze(["Dense Fog Advisory", 68, "#708090"]),
  Object.freeze(["Dense Smoke Advisory", 69, "#F0E68C"]),
  Object.freeze(["Small Craft Advisory", 70, "#D8BFD8"]),
  Object.freeze(["Brisk Wind Advisory", 71, "#D8BFD8"]),
  Object.freeze(["Hazardous Seas Warning", 72, "#D8BFD8"]),
  Object.freeze(["Dust Advisory", 73, "#BDB76B"]),
  Object.freeze(["Blowing Dust Advisory", 74, "#BDB76B"]),
  Object.freeze(["Lake Wind Advisory", 75, "#D2B48C"]),
  Object.freeze(["Wind Advisory", 76, "#D2B48C"]),
  Object.freeze(["Frost Advisory", 77, "#6495ED"]),
  Object.freeze(["Freezing Fog Advisory", 78, "#008080"]),
  Object.freeze(["Freezing Spray Advisory", 79, "#00BFFF"]),
  Object.freeze(["Low Water Advisory", 80, "#A52A2A"]),
  Object.freeze(["Local Area Emergency", 81, "#C0C0C0"]),
  Object.freeze(["Winter Storm Watch", 82, "#4682B4"]),
  Object.freeze(["Rip Current Statement", 83, "#40E0D0"]),
  Object.freeze(["Beach Hazards Statement", 84, "#40E0D0"]),
  Object.freeze(["Gale Watch", 85, "#FFC0CB"]),
  Object.freeze(["Avalanche Watch", 86, "#F4A460"]),
  Object.freeze(["Hazardous Seas Watch", 87, "#483D8B"]),
  Object.freeze(["Heavy Freezing Spray Watch", 88, "#BC8F8F"]),
  Object.freeze(["Flood Watch", 89, "#2E8B57"]),
  Object.freeze(["Coastal Flood Watch", 90, "#66CDAA"]),
  Object.freeze(["Lakeshore Flood Watch", 91, "#66CDAA"]),
  Object.freeze(["High Wind Watch", 92, "#B8860B"]),
  Object.freeze(["Extreme Heat Watch", 93, "#800000"]),
  Object.freeze(["Extreme Cold Watch", 94, "#5F9EA0"]),
  Object.freeze(["Freeze Watch", 95, "#00FFFF"]),
  Object.freeze(["Fire Weather Watch", 96, "#FFDEAD"]),
  Object.freeze(["Extreme Fire Danger", 97, "#E9967A"]),
  Object.freeze(["911 Telephone Outage", 98, "#C0C0C0"]),
  Object.freeze(["Coastal Flood Statement", 99, "#6B8E23"]),
  Object.freeze(["Lakeshore Flood Statement", 100, "#6B8E23"]),
  Object.freeze(["Special Weather Statement", 101, "#FFE4B5"]),
  Object.freeze(["Marine Weather Statement", 102, "#FFDAB9"]),
  Object.freeze(["Air Quality Alert", 103, "#808080"]),
  Object.freeze(["Air Stagnation Advisory", 104, "#808080"]),
  Object.freeze(["Hazardous Weather Outlook", 105, "#EEE8AA"]),
  Object.freeze(["Hydrologic Outlook", 106, "#90EE90"]),
  Object.freeze(["Short Term Forecast", 107, "#98FB98"]),
  Object.freeze(["Administrative Message", 108, "#C0C0C0"]),
  Object.freeze(["Test", 109, "#F0FFFF"]),
  Object.freeze(["Child Abduction Emergency", 110, "#FFFFFF", true]),
  Object.freeze(["Blue Alert", 111, "#FFFFFF", true]),
]);

export const ERO_COLORS = Object.freeze({
  "Marginal": "#38A800",
  "Slight": "#FFFE00",
  "Moderate": "#F50000",
  "High": "#FF69C5",
});

export const ERO_OUTLINES = Object.freeze({
  "Marginal": "#00734C",
  "Slight": "#E69800",
  "Moderate": "#8A0000",
  "High": "#FF00FF",
});

export const WSSI_COLORS = Object.freeze({
  "Winter Weather Area": "#D2DFE7",
  "Minor": "#FAF5A3",
  "Moderate": "#F7962F",
  "Major": "#E61F26",
  "Extreme": "#7853A1",
});

export const EXTENDED_COLORS = Object.freeze({
  "Frost/Freeze": "#C500FF",
  "Hazardous Heat": "#A80000",
  "Hazardous Cold": "#005CE6",
  "High Winds": "#CDAA66",
  "Significant Waves": "#FFD37F",
  "Flooding Likely": "#DF73FF",
  "Flooding Occurring or Imminent": "#4C0073",
  "Flooding Possible": "#E8BEFF",
  "Freezing Rain": "#FF00C5",
  "Heavy Precipitation": "#00E6A9",
  "Heavy Rain": "#267300",
  "Heavy Snow": "#0084A8",
  "Severe Weather": "#E69800",
  "Critical Wildfire Risk": "#000000",
  "Severe Drought": "#732600",
});

const byEvent = new Map(WWA.map(([name, priority, color, transparent]) => [
  name.toLowerCase(), Object.freeze({name, priority, color, known: true, visible: !transparent})
]));

const unknownStyle = Object.freeze({
  name: 'Unlisted NWS product', priority: 999, color: '#AAB7C3', known: false, visible: true
});

/** Pass the CAP event name, or a normalized alert with title/event. */
export function alertStyle(event) {
  const name = typeof event === 'string' ? event : event?.event || event?.title;
  return byEvent.get(String(name || '').trim().toLowerCase()) || unknownStyle;
}

/** SVG paints the highest-priority warning last. Transparent products stay in the text list. */
export function alertDrawOrder(a, b) {
  return alertStyle(b).priority - alertStyle(a).priority;
}

/** Return the black or white foreground with the larger WCAG contrast ratio on a solid sRGB swatch. */
export function inkFor(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return '#FFFFFF';
  const [r, g, b] = [1, 3, 5].map(offset => {
    const s = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#FFFFFF';
}

const svgNamespace = 'http://www.w3.org/2000/svg';

/**
 * Draw a WWA polygon with a contrasting casing and an exact NWS-color edge.
 * Use {fill: true} for a dedicated warning map. Overlay mode keeps the forecast legible.
 * The returned foreground path accepts click or pointer handlers from the brief's map.
 */
export function appendAlertPath(group, d, event, {fill = false, label} = {}) {
  const style = alertStyle(event);
  if (!d || !style.visible) return null;
  const doc = group.ownerDocument;
  const attributes = {
    d, 'fill-rule': 'evenodd', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke'
  };
  const append = options => {
    const path = doc.createElementNS(svgNamespace, 'path');
    for (const [key, value] of Object.entries({...attributes, ...options})) path.setAttribute(key, value);
    group.append(path);
    return path;
  };
  append({
    fill: 'none', stroke: inkFor(style.color), 'stroke-width': '3.2',
    'pointer-events': 'none', 'aria-hidden': 'true'
  });
  const front = append({
    fill: fill ? style.color : 'transparent', stroke: style.color, 'stroke-width': '1.6',
    'stroke-dasharray': style.known ? 'none' : '4 3', 'pointer-events': 'all'
  });
  const title = doc.createElementNS(svgNamespace, 'title');
  title.textContent = label || (typeof event === 'string' ? event : event?.title || event?.event) || style.name;
  front.append(title);
  return front;
}
