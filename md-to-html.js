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

// The per-POI schedule table (时间|行程|地图|交通/费用|参考链接) used throughout the
// itinerary is too narrow per-column on phones. Rather than authoring a separate
// mobile version by hand (two copies to keep in sync), we detect this exact header
// shape here and have the *same* markdown row render a mobile-only summary line
// (map/cost/reference) inside the 行程 cell. CSS then hides columns 3–5 on narrow
// screens and reveals that summary line instead — single source of truth in the .md.
const POI_SCHEDULE_HEADER = ['时间', '行程', '地图', '交通 / 费用', '参考链接'];

function convertTable(lines) {
  const rows = lines.filter(l => l.trim().startsWith('|'));
  if (rows.length < 2) return lines.map(l => `<p>${inlineConvert(l)}</p>`).join('\n');

  const rawHeader = rows[0].split('|').slice(1, -1).map(c => c.trim());
  const isPoiSchedule = rawHeader.length === POI_SCHEDULE_HEADER.length &&
    rawHeader.every((c, i) => c === POI_SCHEDULE_HEADER[i]);

  const header = rawHeader.map(c => `<th>${inlineConvert(c)}</th>`).join('');
  const body = rows.slice(2).map(row => {
    const raw = row.split('|').slice(1, -1).map(c => c.trim());
    let cells = raw.map(c => `<td>${inlineConvert(c)}</td>`).join('');
    if (isPoiSchedule) {
      const [, , map, cost, ref] = raw;
      const parts = [];
      if (map && map !== '—') parts.push(inlineConvert(map));
      if (cost && cost !== '—') parts.push(inlineConvert(cost));
      if (ref && ref !== '—') parts.push(inlineConvert(ref));
      if (parts.length) {
        // Injected into the 2nd <td> (行程) so it stacks under that text on mobile
        // without duplicating content anywhere else in the markdown source.
        const tdMatches = [...cells.matchAll(/<td>[\s\S]*?<\/td>/g)];
        const poiCell = tdMatches[1];
        if (poiCell) {
          const withMeta = poiCell[0].replace(/<\/td>$/, `<div class="mobile-meta">${parts.join(' · ')}</div></td>`);
          cells = cells.slice(0, poiCell.index) + withMeta + cells.slice(poiCell.index + poiCell[0].length);
        }
      }
    }
    return `<tr>${cells}</tr>`;
  }).join('\n');

  const tableClass = isPoiSchedule ? ' class="poi-schedule"' : '';
  return `<div class="table-wrap"><table${tableClass}><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
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
      // Consecutive ">" lines (including blank ">" separators) belong to one note,
      // not a new boxed blockquote per line — merge them so a multi-line tip renders
      // as a single card instead of a stack of disconnected boxes.
      const groupLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        groupLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      const firstContent = groupLines.find(l => l.trim() !== '') || '';
      const cls = firstContent.startsWith('⚠️') ? 'warn' : firstContent.startsWith('💡') ? 'tip' : firstContent.startsWith('✨') ? 'upgrade' : firstContent.startsWith('🎡') ? 'tip' : '';
      const bodyHtml = groupLines.filter(l => l.trim() !== '').map(l => `<p>${inlineConvert(l)}</p>`).join('');
      html.push(`<blockquote class="${cls}">${bodyHtml}</blockquote>`);
      continue;
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

// Renders a city's intro notes, collapsing the hotel name's address/phone/station
// lines into a <details> toggle so this block doesn't visually dominate the day
// accordion above it; only the hotel name stays visible by default. Any plain
// (non-blockquote) line directly following the address, with no blank line in
// between, is treated as more address-block content and folded in too.
function renderCityIntroNotes(introNoteLines) {
  if (!introNoteLines.length) return '';
  const hotelIdx = introNoteLines.findIndex(l => /^\*\*酒店[:：]/.test(l.trim()));
  if (hotelIdx === -1) return convert(introNoteLines.join('\n'));

  const hotelLine = introNoteLines[hotelIdx].trim();
  let j = hotelIdx + 1;
  const addrLines = [];
  while (j < introNoteLines.length) {
    const t = introNoteLines[j].trim();
    if (t === '' || t.startsWith('>')) break;
    addrLines.push(t);
    j++;
  }

  const before = introNoteLines.slice(0, hotelIdx);
  const after = introNoteLines.slice(j);

  let html = '';
  if (before.length) html += convert(before.join('\n')) + '\n';
  html += `<div class="hotel-intro"><p class="hotel-name">🏨 ${inlineConvert(hotelLine)}</p>`;
  if (addrLines.length) {
    const addrHtml = addrLines.map(l => `<p>${inlineConvert(l)}</p>`).join('');
    html += `<details class="hotel-addr"><summary>📍 地址 / 联系方式 ▾</summary><div class="hotel-addr-body">${addrHtml}</div></details>`;
  }
  html += `</div>\n`;
  if (after.length) html += convert(after.join('\n')) + '\n';
  return html;
}

let overviewHtml = '';   // 总路线 + ★必去亮点 (行程总览 tab)
let hotelsTableRaw = null; // 住宿一览 raw rows
let cityDaySections = []; // { cityTitle, introTable, days: [{title, bodyLines}] }
let optionalExtLines = null; // 🗺 可选景点 & 延伸行程
let costLines = null;     // 💴 费用参考
let checklistLines = null; // ✅ 行前重要 Checklist
let driveIntroHtml = '';  // 🚗 自驾版行程 intro notes (before first ### day)
let driveDayItems = [];   // 🚗 自驾版行程 days: [{title, bodyLines}]
let googleMapLines = null; // 🗺 Google Map tab content

for (const block of h2Blocks) {
  const isCity = /Day\s*\d/.test(block.title);
  if (block.title === '总路线' || block.title === '★ 必去亮点') {
    overviewHtml += convert(trimBlock(block.contentLines).join('\n')) + '\n';
  } else if (block.title === '住宿一览') {
    hotelsTableRaw = parseTableRaw(block.contentLines);
  } else if (block.title.startsWith('🚗 自驾版行程')) {
    const h3Idxs = findHeadingIdxs(block.contentLines, 3);
    const introLines = h3Idxs.length ? block.contentLines.slice(0, h3Idxs[0]) : block.contentLines;
    driveIntroHtml = convert(trimBlock(introLines).join('\n'));
    driveDayItems = h3Idxs.map((start, i) => {
      const end = i + 1 < h3Idxs.length ? h3Idxs[i + 1] : block.contentLines.length;
      const title = block.contentLines[start].replace(/^###\s+/, '').trim();
      const bodyLines = trimBlock(block.contentLines.slice(start + 1, end));
      return { title, bodyLines };
    });
  } else if (block.title.includes('路线地图') || block.title.includes('Google Map')) {
    googleMapLines = trimBlock(block.contentLines);
  } else if (isCity) {
    const h3Idxs = findHeadingIdxs(block.contentLines, 3);
    const introLines = h3Idxs.length ? block.contentLines.slice(0, h3Idxs[0]) : block.contentLines;
    const introTable = parseTableRaw(introLines);
    // Narrative notes before the destination table (hotel name, address, 💡/📝 blockquotes)
    // — kept separately so they still render instead of being silently dropped.
    const introNoteLines = trimBlock(introLines.filter(l => !l.trim().startsWith('|')));
    const introNotesHtml = renderCityIntroNotes(introNoteLines);
    const days = h3Idxs.map((start, i) => {
      const end = i + 1 < h3Idxs.length ? h3Idxs[i + 1] : block.contentLines.length;
      const title = block.contentLines[start].replace(/^###\s+/, '').trim();
      const bodyLines = trimBlock(block.contentLines.slice(start + 1, end));
      return { title, bodyLines };
    });
    cityDaySections.push({ cityTitle: block.title, introTable, introNotesHtml, days });
  } else if (block.title.includes('可选景点')) {
    optionalExtLines = trimBlock(block.contentLines);
  } else if (block.title.includes('费用参考')) {
    costLines = trimBlock(block.contentLines);
  } else if (block.title.includes('Checklist')) {
    checklistLines = trimBlock(block.contentLines);
  }
}

// City-segment accent colors for day headings (逐日行程 + 自驾版行程), so the trip's
// four legs (JB+Osaka①/Nagoya/Kyoto/Osaka②) are visually distinguishable at a glance.
// Travel days between legs (Sep 12/14/16) get a gradient blending the two legs they
// connect instead of a flat color. Boundaries are hardcoded to this specific 13-day
// route rather than derived from the "## 城市" headings, since the JB day (Sep 8) and
// the first Osaka leg intentionally share one color as a single visual block.
const SEGMENT_COLORS = ['#8ea3b5', '#8fa88c', '#b98c95', '#c2a878'];
const SEGMENT_SOLID_RANGES = [[8, 11, 0], [13, 13, 1], [15, 15, 2], [17, 21, 3]];
const SEGMENT_GRADIENTS = { 12: [0, 1], 14: [1, 2], 16: [2, 3] };

function daySegmentBar(title) {
  const m = title.match(/Sep\s*(\d{1,2})/);
  if (!m) return '';
  const day = parseInt(m[1], 10);
  const solid = SEGMENT_SOLID_RANGES.find(([start, end]) => day >= start && day <= end);
  if (solid) return SEGMENT_COLORS[solid[2]];
  const grad = SEGMENT_GRADIENTS[day];
  if (grad) return `linear-gradient(180deg, ${SEGMENT_COLORS[grad[0]]}, ${SEGMENT_COLORS[grad[1]]})`;
  return '';
}

// Splits a day's body on "#### 📍 ..." headings into per-attraction collapsibles
// (time/route/transport table + POI-level note), so a day with several stops doesn't
// dump one giant table — each stop opens on its own. Content before the first such
// heading (rare) renders normally, ungrouped.
function renderDayBody(bodyLines) {
  const h4Idxs = findHeadingIdxs(bodyLines, 4);
  if (h4Idxs.length === 0) return convert(bodyLines.join('\n'));
  let html = '';
  const preLines = trimBlock(bodyLines.slice(0, h4Idxs[0]));
  if (preLines.length) html += convert(preLines.join('\n')) + '\n';
  h4Idxs.forEach((start, i) => {
    const end = i + 1 < h4Idxs.length ? h4Idxs[i + 1] : bodyLines.length;
    const title = bodyLines[start].replace(/^####\s+/, '').trim();
    const sectionLines = trimBlock(bodyLines.slice(start + 1, end));
    html += `<details class="poi"><summary>📍 ${inlineConvert(title)}</summary><div class="poi-body">${convert(sectionLines.join('\n'))}</div></details>\n`;
  });
  return html;
}

// ---------- Build 📅 逐日行程 tab ----------

let itineraryHtml = '';
cityDaySections.forEach(city => {
  itineraryHtml += `<div class="city-group">${inlineConvert(city.cityTitle)}</div>\n`;
  if (city.introNotesHtml) itineraryHtml += city.introNotesHtml + '\n';
  city.days.forEach(day => {
    const bar = daySegmentBar(day.title);
    const style = bar ? ` style="--accent-bar:${bar};"` : '';
    itineraryHtml += `<details class="day"${style}><summary>${inlineConvert(day.title)}</summary><div class="day-body">${renderDayBody(day.bodyLines)}</div></details>\n`;
  });
});
if (optionalExtLines) {
  overviewHtml += `<details class="day optional"><summary>🗺 可选景点 & 延伸行程（点击展开）</summary><div class="day-body">${convert(optionalExtLines.join('\n'))}</div></details>\n`;
}

// ---------- Build 🚗 自驾版行程 tab ----------

let driveItineraryHtml = '';
if (driveIntroHtml) driveItineraryHtml += driveIntroHtml + '\n';
driveDayItems.forEach(day => {
  const bar = daySegmentBar(day.title);
  const style = bar ? ` style="--accent-bar:${bar};"` : '';
  driveItineraryHtml += `<details class="day"${style}><summary>${inlineConvert(day.title)}</summary><div class="day-body">${renderDayBody(day.bodyLines)}</div></details>\n`;
});

// ---------- Build 🗺 Google Map tab ----------

const googleMapHtml = googleMapLines ? convert(googleMapLines.join('\n')) : '';

// ---------- Build 🏨 住宿 tab ----------

const VOUCHERS_DRIVE_URL = 'https://drive.google.com/drive/folders/15b3HNyrht43G0Fm6--sdJV9BPMlwAU99?usp=drive_link';

let hotelsHtml = `<div class="hotel-card" style="border-left:3px solid var(--accent);">
<h3>🎫 订票凭证 / Booking Vouchers</h3>
<p class="hotel-note">所有酒店入住凭证、门票 PDF 存在私人 Google Drive 文件夹（不公开在此页面，避免订单号/PIN码外泄）：<br><a href="${VOUCHERS_DRIVE_URL}" target="_blank" rel="noopener">📂 打开 Google Drive 凭证文件夹</a></p>
<p class="hotel-note" style="font-size:0.8rem;color:#999;">⚠️ 此页面会公开在 GitHub Pages，请确认该 Drive 文件夹的分享权限设置为仅限你自己或指定帐号可开启。</p>
</div>\n`;
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

// ---------- Build ✅ 清单 tab ----------

const checklistHtml = checklistLines ? convert(checklistLines.join('\n')) : '';

// ---------- Assemble ----------

const pageHeaderHtml = convert(pageHeaderLines.join('\n'));

const css = `
:root {
  --ink: #5f6b75;
  --ink2: #838d97;
  --accent: #8ea3b5;
  --accent-l: #edf1f4;
  --teal: #8fa9a4;
  --teal-l: #eaf1ef;
  --must: #b58e93;
  --must-l: #f5edee;
  --tip: #7292ab;
  --tip-l: #edf2f6;
  --upgrade: #9c92ab;
  --upgrade-l: #f2eef5;
  --warn-l: #f7f0e7;
  --warn: #bb9270;
  --bg: #f1f3f4;
  --card: #ffffff;
  --bdr: rgba(95,107,117,0.13);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: var(--bg); color: var(--ink);
  line-height: 1.75; font-size: 15px;
  display: flex; justify-content: center; padding: 1.5rem 1rem 4rem;
}
.wrap { max-width: 780px; width: 100%; }
h1 { font-size: 1.6rem; color: var(--ink); margin: 0 0 0.3rem; padding-bottom: 0.6rem; border-bottom: 2px solid var(--accent); }
h2 { font-size: 1.2rem; color: var(--ink); margin: 1.5rem 0 0.5rem; padding: 0.4rem 0.8rem; background: var(--accent-l); border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0; }
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
ul li::before { content: '·'; position: absolute; left: 0.4rem; color: var(--accent); font-size: 1.3rem; line-height: 1; }
ul li.sub { padding-left: 2.5rem; }
ul li.sub::before { left: 1.6rem; color: var(--teal); }
blockquote { max-width: 85%; margin: 0.5rem 0 0.5rem 1.2rem; padding: 0.5rem 0.8rem; border-radius: 0 8px 8px 0; font-size: 0.8rem; line-height: 1.5; border-left: 3px solid var(--tip); background: var(--tip-l); color: #3a4654; }
blockquote p { margin: 0; }
blockquote p + p { margin-top: 0.35rem; }
blockquote.tip { border-color: var(--accent); background: var(--accent-l); color: #3f4a5a; }
blockquote.warn { border-color: var(--warn); background: var(--warn-l); color: var(--warn); }
blockquote.upgrade { border-color: var(--upgrade); background: var(--upgrade-l); color: var(--upgrade); }
.table-wrap { overflow-x: auto; margin: 0.8rem 0 1.2rem; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
thead { background: var(--ink); }
thead th { color: #fff; padding: 0.55rem 0.75rem; text-align: left; font-weight: 500; white-space: nowrap; }
tbody tr:nth-child(odd) { background: var(--card); }
tbody tr:nth-child(even) { background: #f9f9fb; }
tbody tr:hover { background: var(--accent-l); }
td { padding: 0.5rem 0.75rem; color: var(--ink2); vertical-align: top; border-bottom: 1px solid var(--bdr); }
td details { margin-top: 0.3rem; font-size: 0.8rem; }
td details summary { display: inline-block; cursor: pointer; color: var(--accent); font-weight: 600; list-style: none; user-select: none; }
td details summary::-webkit-details-marker { display: none; }
td details[open] summary { margin-bottom: 0.2rem; }
td strong { color: var(--ink); }

/* Page header */
.page-header { margin-bottom: 1rem; }

/* Tabs (CSS-only radio technique) */
.tabs-input { position: absolute; opacity: 0; pointer-events: none; }
.tab-bar { display: flex; flex-wrap: wrap; gap: 0.5rem; position: sticky; top: 0; background: var(--bg); z-index: 10; padding: 0.7rem 0; margin-bottom: 0.4rem; border-bottom: 1px solid var(--bdr); }
.tab-label { flex: 1 1 auto; text-align: center; padding: 0.55rem 0.4rem; border-radius: 20px; background: var(--card); border: 1px solid var(--bdr); font-size: 0.83rem; font-weight: 600; color: var(--ink2); cursor: pointer; white-space: nowrap; user-select: none; transition: background .15s, color .15s, border-color .15s; }
.tab-panel { display: none; }
.tab-label.muted { background: transparent; border-color: transparent; color: #b7bcc1; font-weight: 500; font-size: 0.76rem; flex: 0 1 auto; }
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

/* Sub-tabs (nested inside 行程总览 panel: 逐日行程 / 总览) — same radio technique, own group */
.subtabs-input { position: absolute; opacity: 0; pointer-events: none; }
.subtab-bar { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.8rem; }
.subtab-label { flex: 1 1 auto; text-align: center; padding: 0.45rem 0.4rem; border-radius: 16px; background: var(--card); border: 1px solid var(--bdr); font-size: 0.8rem; font-weight: 600; color: var(--ink2); cursor: pointer; white-space: nowrap; user-select: none; transition: background .15s, color .15s, border-color .15s; }
.subtab-panel { display: none; }
#subtab-1:checked ~ .subtab-bar label[for="subtab-1"],
#subtab-2:checked ~ .subtab-bar label[for="subtab-2"] { background: var(--accent); color: #fff; border-color: var(--accent); }
#subtab-1:checked ~ #subpanel-1,
#subtab-2:checked ~ #subpanel-2 { display: block; }

/* City group label */
.city-group { font-size: 1rem; font-weight: 700; color: var(--card); background: var(--ink); padding: 0.5rem 0.9rem; border-radius: 8px; margin: 1.4rem 0 0.6rem; }

/* Day accordion */
details.day { position: relative; background: var(--card); border: 1px solid var(--bdr); border-radius: 10px; margin: 0.6rem 0; overflow: hidden; }
details.day::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 8px; background: var(--accent-bar, transparent); }
details.day summary { padding: 0.8rem 1rem; cursor: pointer; font-weight: 600; font-size: 0.92rem; list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; }
details.day summary::-webkit-details-marker { display: none; }
details.day summary::after { content: '▾'; color: var(--accent); flex-shrink: 0; transition: transform .2s; }
details.day[open] > summary::after { transform: rotate(180deg); }
details.day .day-body { padding: 0 1rem 1rem; }
details.day.optional summary { color: var(--upgrade); }

/* POI (attraction) accordion — nested one level inside a day, one per stop */
details.poi { background: var(--accent-l); border: 1px solid var(--bdr); border-radius: 8px; margin: 0.6rem 0; overflow: hidden; }
details.poi summary { padding: 0.6rem 0.8rem; cursor: pointer; font-weight: 600; font-size: 0.88rem; color: var(--ink); list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; }
details.poi summary::-webkit-details-marker { display: none; }
details.poi summary::after { content: '▾'; color: var(--accent); flex-shrink: 0; transition: transform .2s; }
details.poi[open] > summary::after { transform: rotate(180deg); }
details.poi .poi-body { padding: 0 0.8rem 0.8rem; background: var(--card); }
details.poi .poi-body blockquote { max-width: 100%; margin-left: 0.3rem; }

/* Compact note embedded inside a schedule-table cell (row-specific tip) */
.row-note { margin-top: 0.3rem; padding: 0.25rem 0.5rem 0.25rem 0.9rem; background: var(--accent-l); border-left: 2px solid var(--accent); border-radius: 0 4px 4px 0; font-size: 0.76rem; color: var(--ink2); position: relative; }
.row-note::before { content: '▸'; position: absolute; left: 0.25rem; color: var(--accent); }

/* Hotel cards */
.hotel-card { background: var(--card); border: 1px solid var(--bdr); border-radius: 12px; padding: 1rem 1.2rem; margin: 0.9rem 0; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
.hotel-card h3 { border: none; margin: 0 0 0.2rem; padding: 0; }
.hotel-meta { color: var(--accent); font-weight: 600; font-size: 0.85rem; margin-bottom: 0.4rem; }
.hotel-note { color: var(--ink2); font-size: 0.88rem; margin-bottom: 0.4rem; }

/* Hotel intro block (city sections) — compact name + collapsible address, same row */
.hotel-intro { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.5rem; margin: 0.6rem 0 0.5rem; }
.hotel-intro p.hotel-name { flex: 1 1 auto; font-weight: 700; color: var(--ink); font-size: 0.95rem; margin: 0.3rem 0; }
details.hotel-addr { flex: 0 0 auto; background: var(--accent-l); border: 1px solid var(--bdr); border-radius: 8px; align-self: flex-start; }
details.hotel-addr[open] { flex-basis: 100%; }
details.hotel-addr summary { display: inline-block; padding: 0.35rem 0.7rem; cursor: pointer; font-size: 0.78rem; font-weight: 600; color: var(--ink2); list-style: none; user-select: none; white-space: nowrap; }
details.hotel-addr summary::-webkit-details-marker { display: none; }
details.hotel-addr .hotel-addr-body { padding: 0 0.7rem 0.6rem; }
details.hotel-addr .hotel-addr-body p { font-size: 0.78rem; color: var(--ink2); margin: 0.2rem 0; white-space: normal; }

/* Reference dropdown — collapsed extra data (official schedules/pricing tables) inside a POI */
details.ref-drop { display: block; background: var(--accent-l); border: 1px solid var(--bdr); border-radius: 8px; margin: 0.5rem 0; }
details.ref-drop summary { display: inline-block; padding: 0.4rem 0.7rem; cursor: pointer; font-size: 0.8rem; font-weight: 600; color: var(--ink2); list-style: none; user-select: none; }
details.ref-drop summary::-webkit-details-marker { display: none; }
details.ref-drop .ref-drop-body { padding: 0 0.7rem 0.7rem; }
details.ref-drop .ref-drop-body table { font-size: 0.82rem; }

/* Mobile summary line inside the 行程 cell — hidden by default (desktop shows the
   real 地图/交通费用/参考链接 columns instead); switched on below 600px. */
.mobile-meta { display: none; margin-top: 0.3rem; font-size: 0.78rem; color: var(--ink2); }
.mobile-meta a { font-weight: 600; }

@media (max-width: 600px) {
  h1 { font-size: 1.3rem; }
  h2 { font-size: 1.05rem; }
  body { font-size: 14px; padding: 1rem 0.75rem 3rem; }
  .tab-label { font-size: 0.78rem; padding: 0.5rem 0.3rem; }
  .subtab-label { font-size: 0.75rem; padding: 0.4rem 0.3rem; }
  blockquote { max-width: 90%; margin-left: 0.6rem; }

  /* Collapse the 5-col POI schedule table to 时间|行程 on phones — 地图/交通费用/
     参考链接 move into the mobile-meta line generated inside the 行程 cell instead
     of squeezing into unreadably narrow columns. */
  table.poi-schedule th:nth-child(3), table.poi-schedule td:nth-child(3),
  table.poi-schedule th:nth-child(4), table.poi-schedule td:nth-child(4),
  table.poi-schedule th:nth-child(5), table.poi-schedule td:nth-child(5) { display: none; }
  table.poi-schedule th:nth-child(1), table.poi-schedule td:nth-child(1) { width: 3.2rem; white-space: nowrap; }
  table.poi-schedule .mobile-meta { display: block; }
}
`;

const output = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🇯🇵 日本家庭自助游攻略 2026 · 大阪 + 名古屋 + 京都</title>
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
  <label class="tab-label" for="tab-1">🚗 自驾版行程</label>
  <label class="tab-label" for="tab-2">🗺 路线地图</label>
  <label class="tab-label" for="tab-3">🏨 住宿 & 🎫 凭证</label>
  <label class="tab-label" for="tab-4">✅ 清单</label>
  <label class="tab-label muted" for="tab-5">行程总览（原版参考）</label>
</div>

<div class="tab-panel" id="panel-1">${driveItineraryHtml}</div>
<div class="tab-panel" id="panel-2">${googleMapHtml}</div>
<div class="tab-panel" id="panel-3">${hotelsHtml}</div>
<div class="tab-panel" id="panel-4">${checklistHtml}</div>
<div class="tab-panel" id="panel-5">
<input type="radio" name="subtabs" id="subtab-1" class="subtabs-input" checked>
<input type="radio" name="subtabs" id="subtab-2" class="subtabs-input">
<div class="subtab-bar">
  <label class="subtab-label" for="subtab-1">📅 逐日行程</label>
  <label class="subtab-label" for="subtab-2">📊 总览</label>
</div>
<div class="subtab-panel" id="subpanel-1">${itineraryHtml}</div>
<div class="subtab-panel" id="subpanel-2">${overviewHtml}</div>
</div>
</div>
</body>
</html>`;

fs.writeFileSync(path.resolve(__dirname, outputFile), output, 'utf8');
console.log(`✅ 输出成功：${outputFile}`);
