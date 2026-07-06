const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2] || 'japan-itinerary-2025.md';
const outputFile = process.argv[3] || inputFile.replace(/\.md$/, '.html');

const md = fs.readFileSync(path.resolve(__dirname, inputFile), 'utf8');

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineConvert(text) {
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\[ \]/g, '☐').replace(/\[x\]/gi, '☑');
  return text;
}

function convertTable(lines) {
  const rows = lines.filter(l => l.trim().startsWith('|'));
  if (rows.length < 2) return lines.map(l => `<p>${inlineConvert(l)}</p>`).join('\n');

  const header = rows[0].split('|').slice(1, -1).map(c => `<th>${inlineConvert(c.trim())}</th>`).join('');
  const body = rows.slice(2).map(row => {
    const cells = row.split('|').slice(1, -1).map(c => `<td>${inlineConvert(c.trim())}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');

  return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// Parses a markdown table into raw (un-converted) header/row cell arrays
function parseTableRaw(lines) {
  const rows = lines.filter(l => l.trim().startsWith('|'));
  if (rows.length < 2) return null;
  const header = rows[0].split('|').slice(1, -1).map(c => c.trim());
  const body = rows.slice(2).map(row => row.split('|').slice(1, -1).map(c => c.trim()));
  return { header, rows: body };
}

function convert(mdText) {
  const lines = mdText.split('\n');
  const html = [];
  let i = 0;
  let inList = false;
  let inCode = false;
  let tableBuffer = [];

  const flushList = () => {
    if (inList) { html.push('</ul>'); inList = false; }
  };
  const flushTable = () => {
    if (tableBuffer.length > 0) {
      html.push(convertTable(tableBuffer));
      tableBuffer = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      flushList(); flushTable();
      if (!inCode) { html.push('<pre><code>'); inCode = true; }
      else { html.push('</code></pre>'); inCode = false; }
      i++; continue;
    }
    if (inCode) { html.push(escapeHtml(line)); i++; continue; }

    if (trimmed.startsWith('|')) {
      flushList();
      tableBuffer.push(line);
      i++; continue;
    } else {
      flushTable();
    }

    if (/^---+$/.test(trimmed)) {
      flushList();
      html.push('<hr>');
      i++; continue;
    }

    const h = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (h) {
      flushList();
      const lvl = h[1].length;
      html.push(`<h${lvl}>${inlineConvert(h[2])}</h${lvl}>`);
      i++; continue;
    }

    if (trimmed.startsWith('>')) {
      flushList();
      const content = trimmed.replace(/^>\s*/, '');
      const cls = content.startsWith('⚠️') ? 'warn' : content.startsWith('💡') ? 'tip' : content.startsWith('✨') ? 'upgrade' : content.startsWith('🎡') ? 'tip' : '';
      html.push(`<blockquote class="${cls}">${inlineConvert(content)}</blockquote>`);
      i++; continue;
    }

    const liMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (liMatch) {
      if (!inList) { html.push('<ul>'); inList = true; }
      html.push(`<li>${inlineConvert(liMatch[1])}</li>`);
      i++; continue;
    }

    const subLi = line.match(/^\s{2,}[-*✔]\s+(.+)/);
    if (subLi) {
      html.push(`<li class="sub">${inlineConvert(subLi[1])}</li>`);
      i++; continue;
    }

    if (trimmed === '') {
      flushList();
      html.push('');
      i++; continue;
    }

    if (/^\*[^*].*[^*]\*$/.test(trimmed)) {
      flushList();
      html.push(`<p class="meta">${inlineConvert(trimmed)}</p>`);
      i++; continue;
    }

    flushList();
    html.push(`<p>${inlineConvert(trimmed)}</p>`);
    i++;
  }
  flushList();
  flushTable();
  return html.join('\n');
}

// ---------- Structural parsing (for tabbed layout) ----------

function findHeadingIdxs(lines, level) {
  const marker = '#'.repeat(level) + ' ';
  const idxs = [];
  lines.forEach((l, i) => { if (l.trim().startsWith(marker)) idxs.push(i); });
  return idxs;
}

function trimBlock(lines) {
  const out = lines.slice();
  while (out.length && out[0].trim() === '') out.shift();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  while (out.length && /^---+$/.test(out[out.length - 1].trim())) {
    out.pop();
    while (out.length && out[out.length - 1].trim() === '') out.pop();
  }
  return out;
}

const allLines = md.split('\n');
const h2Idxs = findHeadingIdxs(allLines, 2);

const pageHeaderLines = trimBlock(allLines.slice(0, h2Idxs[0]));

const h2Blocks = h2Idxs.map((start, i) => {
  const end = i + 1 < h2Idxs.length ? h2Idxs[i + 1] : allLines.length;
  const title = allLines[start].replace(/^##\s+/, '').trim();
  const contentLines = allLines.slice(start + 1, end);
  return { title, contentLines };
});

// Pulls the Japanese (or fallback) place name out of a "目的地" cell like
// "💰 御金神社 (Mikane Jinja / 御金神社)" for use in a Google Maps search query.
function extractPlaceQuery(cellText) {
  const slashMatch = cellText.match(/\(([^\/\)]*)\/\s*([^)]+)\)/);
  if (slashMatch) return slashMatch[2].trim();
  const parenMatch = cellText.match(/\(([^)]+)\)/);
  if (parenMatch) return parenMatch[1].trim();
  return cellText.replace(/[★💰🖤🎡🥩🐬🚃🐴🛶⚠️⛴]/g, '').trim();
}

function travelModeFor(transportText) {
  return /步行/.test(transportText) ? 'walking' : 'transit';
}

function buildDirectionsUrl(origin, destination, mode) {
  const params = new URLSearchParams({ api: '1', origin, destination, travelmode: mode });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function renderDistanceTable(raw, headerOverride, linkCtx) {
  if (!raw) return '';
  const header = headerOverride || raw.header;
  const headHtml = header.map(c => `<th>${inlineConvert(c)}</th>`).join('');
  const bodyHtml = raw.rows.map(r => {
    const cells = r.map((c, idx) => {
      if (linkCtx && idx === 1) {
        const destQuery = `${extractPlaceQuery(r[0])}, ${linkCtx.cityHint}`;
        const mode = travelModeFor(r[2] || '');
        const url = buildDirectionsUrl(linkCtx.origin, destQuery, mode);
        return `<td><a class="dist-link" href="${url}" target="_blank" rel="noopener">${inlineConvert(c)} 🔗</a></td>`;
      }
      return `<td>${inlineConvert(c)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');
  return `<div class="table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

// City hotel/day-trip distance reference used by both 地图&距离 tab and 住宿 tab
const OSAKA1_DISTANCE = {
  header: ['目的地', '距酒店距离', '交通'],
  rows: [['USJ 入口 (USJ Entrance)', '0.4km', '步行约5分']]
};

let itineraryTop = '';   // 总路线 + ★必去亮点
let hotelsTableRaw = null; // 住宿一览 raw rows
let cityDaySections = []; // { cityTitle, introTable, days: [{title, bodyLines}] }
let optionalExtLines = null; // 🗺 可选景点 & 延伸行程
let costLines = null;     // 💴 费用参考
let checklistLines = null; // ✅ 行前重要 Checklist

for (const block of h2Blocks) {
  const isCity = /Day\s*\d/.test(block.title);
  if (block.title === '总路线' || block.title === '★ 必去亮点') {
    itineraryTop += convert(trimBlock(block.contentLines).join('\n')) + '\n';
  } else if (block.title === '住宿一览') {
    hotelsTableRaw = parseTableRaw(block.contentLines);
  } else if (isCity) {
    const h3Idxs = findHeadingIdxs(block.contentLines, 3);
    const introLines = h3Idxs.length ? block.contentLines.slice(0, h3Idxs[0]) : block.contentLines;
    const introTable = parseTableRaw(introLines);
    const days = h3Idxs.map((start, i) => {
      const end = i + 1 < h3Idxs.length ? h3Idxs[i + 1] : block.contentLines.length;
      const title = block.contentLines[start].replace(/^###\s+/, '').trim();
      const bodyLines = trimBlock(block.contentLines.slice(start + 1, end));
      return { title, bodyLines };
    });
    cityDaySections.push({ cityTitle: block.title, introTable, days });
  } else if (block.title.includes('可选景点')) {
    optionalExtLines = trimBlock(block.contentLines);
  } else if (block.title.includes('费用参考')) {
    costLines = trimBlock(block.contentLines);
  } else if (block.title.includes('Checklist')) {
    checklistLines = trimBlock(block.contentLines);
  }
}

// ---------- Build 📅 逐日行程 tab ----------

let itineraryHtml = itineraryTop;
cityDaySections.forEach(city => {
  itineraryHtml += `<div class="city-group">${inlineConvert(city.cityTitle)}</div>\n`;
  city.days.forEach(day => {
    itineraryHtml += `<details class="day"><summary>${inlineConvert(day.title)}</summary><div class="day-body">${convert(day.bodyLines.join('\n'))}</div></details>\n`;
  });
});
if (optionalExtLines) {
  itineraryHtml += `<details class="day optional"><summary>🗺 可选景点 & 延伸行程（点击展开）</summary><div class="day-body">${convert(optionalExtLines.join('\n'))}</div></details>\n`;
}

// ---------- Build 🗺 地图 & 距离 tab ----------

const cityMapMeta = {
  '大阪第一段 (Osaka · Day 1–3)': { label: '🏯 大阪 · Day 1–3（Hotel Universal Port Vita）', origin: 'Hotel Universal Port Vita, Osaka', mapQuery: 'Hotel Universal Port Vita, Osaka', cityHint: 'Osaka' },
  '名古屋 (Nagoya / 名古屋) — Day 4–6 · 2晚': { label: '🌿 名古屋 · Day 4–6', origin: 'Nishitetsu Hotel Croom Nagoya, Nagoya', mapQuery: 'Nishitetsu Hotel Croom Nagoya, Nagoya', cityHint: 'Nagoya' },
  '京都 (Kyoto / 京都) — Day 6夜–8 · 2晚': { label: '⛩️ 京都 · Day 6夜–8', origin: 'Shijo Kawaramachi Station, Kyoto', mapQuery: 'Shijo Kawaramachi Station, Kyoto', cityHint: 'Kyoto' },
  '大阪第二段 (Osaka · Day 9–13)': { label: '🏯 大阪 · Day 9–13（Miyako City Hommachi）', origin: 'Miyako City Osaka Hommachi, Osaka', mapQuery: 'Miyako City Osaka Hommachi, Osaka', cityHint: 'Osaka' }
};

// Encodes a value for the classic (no-API-key) Google Maps URL scheme, where spaces
// must come through as literal "+" — URLSearchParams would instead escape a literal
// "+" separator to %2B, breaking the "waypoint+to:waypoint" directions syntax below.
function encodeMapsParam(str) {
  return encodeURIComponent(str).replace(/%20/g, '+');
}

// Builds a no-API-key Google Maps directions embed connecting origin -> waypoint1 -> waypoint2,
// so the iframe shows the actual route line/distance between the hotel and its top highlights.
function buildRouteEmbedUrl(origin, waypoints, mode) {
  const dirflg = mode === 'walking' ? 'w' : mode === 'driving' ? 'd' : 'r';
  const saddr = encodeMapsParam(origin);
  const daddr = waypoints.map(encodeMapsParam).join('+to:');
  return `https://www.google.com/maps?saddr=${saddr}&daddr=${daddr}&dirflg=${dirflg}&output=embed`;
}

let mapHtml = '<p class="tab-intro">按城市列出住宿到各景点的步行 / 交通距离参考；地图会画出酒店 → 前两大重点景点的实际路线，点击 🔗 可在 Google 地图查看其他景点的路线。</p>\n';
cityDaySections.forEach(city => {
  const meta = cityMapMeta[city.cityTitle] || { label: city.cityTitle, origin: null, mapQuery: null, cityHint: '' };
  const table = city.introTable || (city.cityTitle.startsWith('大阪第一段') ? OSAKA1_DISTANCE : null);
  mapHtml += `<h3>${meta.label}</h3>\n`;
  const topRows = table ? table.rows.slice(0, 2) : [];
  if (meta.origin && topRows.length > 0) {
    const waypoints = topRows.map(r => `${extractPlaceQuery(r[0])}, ${meta.cityHint}`);
    const mode = travelModeFor(topRows[0][2] || '');
    const routeUrl = buildRouteEmbedUrl(meta.origin, waypoints, mode);
    const waypointLabels = topRows.map(r => inlineConvert(r[0])).join(' → ');
    mapHtml += `<div class="map-embed"><iframe src="${routeUrl}" loading="lazy" allowfullscreen></iframe></div>\n`;
    mapHtml += `<p class="map-route-caption">📍 路线：${inlineConvert(meta.label.replace(/^\S+\s/, ''))}酒店 → ${waypointLabels}</p>\n`;
  } else if (meta.mapQuery) {
    mapHtml += `<div class="map-embed"><iframe src="https://www.google.com/maps?q=${encodeURIComponent(meta.mapQuery)}&output=embed" loading="lazy" allowfullscreen></iframe></div>\n`;
  }
  mapHtml += table ? renderDistanceTable(table, null, meta.origin ? { origin: meta.origin, cityHint: meta.cityHint } : null) : '<p>暂无距离数据</p>';
});

// ---------- Build 🏨 住宿 tab ----------

let hotelsHtml = '';
if (hotelsTableRaw) {
  hotelsTableRaw.rows.forEach((row, idx) => {
    const [name, dates, location, note] = row;
    const city = cityDaySections[idx];
    const table = city ? (city.introTable || (city.cityTitle.startsWith('大阪第一段') ? OSAKA1_DISTANCE : null)) : null;
    hotelsHtml += `<div class="hotel-card">
<h3>${inlineConvert(name)}</h3>
<div class="hotel-meta">${inlineConvert(dates)} · ${inlineConvert(location)}</div>
<p class="hotel-note">${inlineConvert(note)}</p>
${table ? `<p class="hotel-sub">附近景点参考：</p>${renderDistanceTable(table)}` : ''}
</div>\n`;
  });
}

// ---------- Build 💴 费用 & ✅ 清单 tabs ----------

const costHtml = costLines ? convert(costLines.join('\n')) : '';
const checklistHtml = checklistLines ? convert(checklistLines.join('\n')) : '';

// ---------- Assemble ----------

const pageHeaderHtml = convert(pageHeaderLines.join('\n'));

const css = `
:root {
  --ink: #1a1a2e;
  --ink2: #4a5568;
  --gold: #c8953a;
  --gold-l: #fdf6dc;
  --teal: #2d7d6f;
  --teal-l: #dff0ec;
  --must: #d4003a;
  --must-l: #fff0f3;
  --tip: #1565c0;
  --tip-l: #e3f0ff;
  --upgrade: #6b3a8a;
  --upgrade-l: #f5eef8;
  --warn-l: #fff8e1;
  --warn: #e65100;
  --bg: #faf9f7;
  --card: #ffffff;
  --bdr: rgba(0,0,0,0.08);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: var(--bg); color: var(--ink);
  line-height: 1.75; font-size: 15px;
  display: flex; justify-content: center; padding: 1.5rem 1rem 4rem;
}
.wrap { max-width: 780px; width: 100%; }
h1 { font-size: 1.6rem; color: var(--ink); margin: 0 0 0.3rem; padding-bottom: 0.6rem; border-bottom: 2px solid var(--gold); }
h2 { font-size: 1.2rem; color: var(--ink); margin: 1.5rem 0 0.5rem; padding: 0.4rem 0.8rem; background: var(--gold-l); border-left: 3px solid var(--gold); border-radius: 0 6px 6px 0; }
h3 { font-size: 1.05rem; color: var(--ink); margin: 1.2rem 0 0.4rem; padding-bottom: 0.2rem; border-bottom: 1px dashed var(--bdr); }
h4 { font-size: 0.95rem; color: var(--ink2); margin: 1rem 0 0.3rem; }
p { color: var(--ink2); margin: 0.4rem 0; }
p.meta { font-size: 0.82rem; color: #999; font-style: italic; margin-top: 1.5rem; }
p.tab-intro { font-size: 0.85rem; color: #999; margin-bottom: 0.8rem; }
.map-embed { width: 100%; height: 260px; border-radius: 10px; overflow: hidden; margin: 0.6rem 0; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
.map-embed iframe { width: 100%; height: 100%; border: 0; }
p.map-route-caption { font-size: 0.82rem; color: var(--ink2); margin: 0 0 1rem; }
a.dist-link { color: var(--tip); font-weight: 600; white-space: nowrap; }
a.dist-link:hover { text-decoration: underline; }
p.hotel-sub { font-size: 0.82rem; color: var(--ink2); font-weight: 600; margin-top: 0.6rem; }
a { color: var(--tip); text-decoration: none; }
a:hover { text-decoration: underline; }
strong { color: var(--ink); font-weight: 600; }
code { font-family: 'SFMono-Regular', Consolas, monospace; background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; color: #d4003a; }
pre { background: #1e1e2e; color: #cdd6f4; padding: 1rem 1.2rem; border-radius: 10px; overflow-x: auto; margin: 0.8rem 0; font-size: 0.85rem; line-height: 1.6; }
pre code { background: none; color: inherit; padding: 0; font-size: inherit; }
hr { border: none; border-top: 1px solid var(--bdr); margin: 1.8rem 0; }
ul { list-style: none; margin: 0.5rem 0 0.8rem; padding-left: 0; }
ul li { padding: 0.2rem 0 0.2rem 1.3rem; position: relative; color: var(--ink2); font-size: 0.93rem; }
ul li::before { content: '·'; position: absolute; left: 0.4rem; color: var(--gold); font-size: 1.3rem; line-height: 1; }
ul li.sub { padding-left: 2.5rem; }
ul li.sub::before { left: 1.6rem; color: var(--teal); }
blockquote { margin: 0.6rem 0; padding: 0.6rem 1rem; border-radius: 0 8px 8px 0; font-size: 0.9rem; line-height: 1.65; border-left: 3px solid var(--tip); background: var(--tip-l); color: #1a3a6b; }
blockquote.tip { border-color: var(--gold); background: var(--gold-l); color: #5c4000; }
blockquote.warn { border-color: var(--warn); background: var(--warn-l); color: var(--warn); }
blockquote.upgrade { border-color: var(--upgrade); background: var(--upgrade-l); color: var(--upgrade); }
.table-wrap { overflow-x: auto; margin: 0.8rem 0 1.2rem; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
thead { background: var(--ink); }
thead th { color: #fff; padding: 0.55rem 0.75rem; text-align: left; font-weight: 500; white-space: nowrap; }
tbody tr:nth-child(odd) { background: var(--card); }
tbody tr:nth-child(even) { background: #f9f9fb; }
tbody tr:hover { background: var(--gold-l); }
td { padding: 0.5rem 0.75rem; color: var(--ink2); vertical-align: top; border-bottom: 1px solid var(--bdr); }
td strong { color: var(--ink); }

/* Page header */
.page-header { margin-bottom: 1rem; }

/* Tabs (CSS-only radio technique) */
.tabs-input { position: absolute; opacity: 0; pointer-events: none; }
.tab-bar { display: flex; flex-wrap: wrap; gap: 0.5rem; position: sticky; top: 0; background: var(--bg); z-index: 10; padding: 0.7rem 0; margin-bottom: 0.4rem; border-bottom: 1px solid var(--bdr); }
.tab-label { flex: 1 1 auto; text-align: center; padding: 0.55rem 0.4rem; border-radius: 20px; background: var(--card); border: 1px solid var(--bdr); font-size: 0.83rem; font-weight: 600; color: var(--ink2); cursor: pointer; white-space: nowrap; user-select: none; transition: background .15s, color .15s, border-color .15s; }
.tab-panel { display: none; }
#tab-1:checked ~ .tab-bar label[for="tab-1"],
#tab-2:checked ~ .tab-bar label[for="tab-2"],
#tab-3:checked ~ .tab-bar label[for="tab-3"],
#tab-4:checked ~ .tab-bar label[for="tab-4"],
#tab-5:checked ~ .tab-bar label[for="tab-5"] { background: var(--ink); color: #fff; border-color: var(--ink); }
#tab-1:checked ~ #panel-1,
#tab-2:checked ~ #panel-2,
#tab-3:checked ~ #panel-3,
#tab-4:checked ~ #panel-4,
#tab-5:checked ~ #panel-5 { display: block; }

/* City group label */
.city-group { font-size: 1rem; font-weight: 700; color: var(--card); background: var(--ink); padding: 0.5rem 0.9rem; border-radius: 8px; margin: 1.4rem 0 0.6rem; }

/* Day accordion */
details.day { background: var(--card); border: 1px solid var(--bdr); border-radius: 10px; margin: 0.6rem 0; overflow: hidden; }
details.day summary { padding: 0.8rem 1rem; cursor: pointer; font-weight: 600; font-size: 0.92rem; list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; }
details.day summary::-webkit-details-marker { display: none; }
details.day summary::after { content: '▾'; color: var(--gold); flex-shrink: 0; transition: transform .2s; }
details.day[open] summary::after { transform: rotate(180deg); }
details.day .day-body { padding: 0 1rem 1rem; }
details.day.optional summary { color: var(--upgrade); }

/* Hotel cards */
.hotel-card { background: var(--card); border: 1px solid var(--bdr); border-radius: 12px; padding: 1rem 1.2rem; margin: 0.9rem 0; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
.hotel-card h3 { border: none; margin: 0 0 0.2rem; padding: 0; }
.hotel-meta { color: var(--gold); font-weight: 600; font-size: 0.85rem; margin-bottom: 0.4rem; }
.hotel-note { color: var(--ink2); font-size: 0.88rem; margin-bottom: 0.4rem; }

@media (max-width: 600px) {
  h1 { font-size: 1.3rem; }
  h2 { font-size: 1.05rem; }
  body { font-size: 14px; padding: 1rem 0.75rem 3rem; }
  .tab-label { font-size: 0.78rem; padding: 0.5rem 0.3rem; }
}
`;

const output = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🇯🇵 日本家庭自助游攻略 2025 · 大阪 + 京都 + 名古屋</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
<div class="page-header">${pageHeaderHtml}</div>

<input type="radio" name="tabs" id="tab-1" class="tabs-input" checked>
<input type="radio" name="tabs" id="tab-2" class="tabs-input">
<input type="radio" name="tabs" id="tab-3" class="tabs-input">
<input type="radio" name="tabs" id="tab-4" class="tabs-input">
<input type="radio" name="tabs" id="tab-5" class="tabs-input">

<div class="tab-bar">
  <label class="tab-label" for="tab-1">📅 逐日行程</label>
  <label class="tab-label" for="tab-2">🗺 地图 & 距离</label>
  <label class="tab-label" for="tab-3">🏨 住宿</label>
  <label class="tab-label" for="tab-4">💴 费用</label>
  <label class="tab-label" for="tab-5">✅ 清单</label>
</div>

<div class="tab-panel" id="panel-1">${itineraryHtml}</div>
<div class="tab-panel" id="panel-2">${mapHtml}</div>
<div class="tab-panel" id="panel-3">${hotelsHtml}</div>
<div class="tab-panel" id="panel-4">${costHtml}</div>
<div class="tab-panel" id="panel-5">${checklistHtml}</div>
</div>
</body>
</html>`;

fs.writeFileSync(path.resolve(__dirname, outputFile), output, 'utf8');
console.log(`✅ 输出成功：${outputFile}`);
