// Noctalum frontend
(() => {
  // Environment ribbon. Fires once at page load — before login, before
  // any auth — because the ribbon must be visible on every screen. The
  // server echoes NOCTALUM_ENV back through /api/ping (public, cheap,
  // already used elsewhere for restart detection). Uppercased-verbatim
  // so a future NOCTALUM_ENV=preview or =demo shows through without any
  // frontend change; "prod" (default) hides the ribbon.
  //
  // The label is repeated across the full-width bar with wide gaps so
  // the pattern is legible on any viewport. 40 copies covers even
  // ultra-wide monitors; overflow: hidden clips the tail on narrow
  // ones. gap between copies uses a real character (space + separator
  // + space) rather than CSS letter-spacing, so the whitespace is
  // clearly *between* words rather than stretched *within* them.
  fetch('/api/ping').then(r => r.ok ? r.json() : null).then(j => {
    if (!j || !j.env || j.env === 'prod') return;
    const el = document.getElementById('env-ribbon');
    if (!el) return;
    const word = String(j.env).toUpperCase();
    el.textContent = Array(40).fill(word).join('     ');
    el.hidden = false;
    document.body.classList.add('env-ribbon-active');
  }).catch(() => {});

  // i18n shortcut.  i18n.js loads first and exposes window.I18N; we keep a tiny
  // local alias so calling sites stay terse.  Fallback returns the key so
  // missing-catalog setups still render something.
  const t = (key, vars) => (window.I18N ? window.I18N.t(key, vars) : key);
  const applyI18n = (root) => { if (window.I18N) window.I18N.apply(root); };
  const localeForFmt = () => {
    const code = window.I18N ? window.I18N.lang() : 'en';
    return code === 'de' ? 'de-DE' : 'en-GB';
  };

  const MODES = ['CW', 'SSB', 'USB', 'LSB', 'FM', 'AM', 'RTTY', 'FT8', 'FT4', 'PSK31', 'PSK63', 'JT65', 'DIGI'];
  const BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm', '23cm', '13cm', '3cm'];
  const BAND_COLORS = {
    '160m': '#ef5350', '80m': '#ff7043', '60m': '#ffa000', '40m': '#fdd835',
    '30m': '#c0ca33', '20m': '#26c6da', '17m': '#29b6f6', '15m': '#7e57c2',
    '12m': '#ec407a', '10m': '#66bb6a', '6m':  '#ffee58', '4m':  '#aed581',
    '2m':  '#42a5f5', '70cm': '#ab47bc', '23cm': '#26a69a', '13cm': '#8d6e63', '3cm': '#78909c',
  };
  function bandColor(b) { return BAND_COLORS[b] || '#9e9e9e'; }

  // Returns an array of unique color strings from an array of {color} objects,
  // preserving first-seen order.
  function _uniqueColors(entries) {
    const seen = new Set(), out = [];
    for (const e of entries) { if (!seen.has(e.color)) { seen.add(e.color); out.push(e.color); } }
    return out;
  }

  // Draws a pie-chart filled circle on a 2D canvas context.  Each color in
  // `colors` gets an equal angular sector; sectors start at the top (12 o'clock)
  // and proceed clockwise.  Single-color: plain filled circle.
  function _drawPie(ctx, cx, cy, r, colors) {
    const n = colors.length;
    if (!n) return;
    if (n === 1) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = colors[0]; ctx.fill();
    } else {
      const step = (2 * Math.PI) / n;
      for (let i = 0; i < n; i++) {
        const a1 = -Math.PI / 2 + i * step, a2 = a1 + step;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a1, a2); ctx.closePath();
        ctx.fillStyle = colors[i]; ctx.fill();
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }

  // Returns an SVG string for a pie-chart circle of radius r.
  function _pieSvg(colors, r) {
    const n = colors.length, d = r * 2;
    if (!n) return '';
    if (n === 1) return `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${r}" cy="${r}" r="${r-0.5}" fill="${colors[0]}" stroke="rgba(0,0,0,0.4)" stroke-width="1"/></svg>`;
    const step = (2 * Math.PI) / n;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}">`;
    for (let i = 0; i < n; i++) {
      const a1 = -Math.PI / 2 + i * step, a2 = a1 + step;
      const x1 = (r + r * Math.cos(a1)).toFixed(3), y1 = (r + r * Math.sin(a1)).toFixed(3);
      const x2 = (r + r * Math.cos(a2)).toFixed(3), y2 = (r + r * Math.sin(a2)).toFixed(3);
      s += `<path d="M${r},${r} L${x1},${y1} A${r},${r},0,0,1,${x2},${y2} Z" fill="${colors[i]}"/>`;
    }
    s += `<circle cx="${r}" cy="${r}" r="${r-0.5}" fill="none" stroke="rgba(0,0,0,0.4)" stroke-width="1"/></svg>`;
    return s;
  }

  // Creates a Leaflet DivIcon containing the pie-chart SVG, centered on the anchor.
  function _pieDivIcon(colors, r) {
    return L.divIcon({
      html: _pieSvg(colors, r),
      className: '',
      iconSize: [r * 2, r * 2],
      iconAnchor: [r, r],
      tooltipAnchor: [r, 0],
      popupAnchor: [0, -r],
    });
  }

  // ----- Mobile mode detection -----
  // Activation order: URL flag (?mode=mobile|desktop) > Settings override
  // (localStorage 'noctalum.displayMode' = 'mobile'|'desktop'|'auto') > UA hint
  // OR narrow viewport.  Re-evaluated on resize and when the Settings select
  // changes; the body.mobile-mode class drives all styling and JS branches.
  const DISPLAY_MODE_KEY = 'noctalum.displayMode';
  function getDisplayModeOverride() {
    const url = new URLSearchParams(location.search).get('mode');
    if (url === 'mobile' || url === 'desktop') return url;
    const stored = localStorage.getItem(DISPLAY_MODE_KEY);
    if (stored === 'mobile' || stored === 'desktop') return stored;
    return 'auto';
  }
  function detectMobile() {
    const ov = getDisplayModeOverride();
    if (ov === 'mobile') return true;
    if (ov === 'desktop') return false;
    const uaMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const narrow = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
    return uaMobile || narrow;
  }
  function applyMobileMode() {
    const wantMobile = detectMobile();
    const wasMobile = document.body.classList.contains('mobile-mode');
    if (wantMobile === wasMobile) return;
    document.body.classList.toggle('mobile-mode', wantMobile);
    if (wantMobile) {
      moveOpsPanesToSheet();
    } else {
      moveOpsPanesBackToPanel();
      setMobileSheetOpen(null);
      document.body.classList.remove('show-all-fields');
    }
  }
  function moveOpsPanesToSheet() {
    const sheet = document.getElementById('mobile-sheet');
    if (!sheet) return;
    document.querySelectorAll('.ops-panel .ops-tab-pane').forEach(p => sheet.appendChild(p));
    sheet.setAttribute('aria-hidden', 'true');
  }
  function moveOpsPanesBackToPanel() {
    const panel = document.querySelector('.ops-panel');
    const sheet = document.getElementById('mobile-sheet');
    if (!panel || !sheet) return;
    sheet.querySelectorAll('.ops-tab-pane').forEach(p => panel.appendChild(p));
    sheet.classList.remove('open');
  }
  function setMobileSheetOpen(tab) {
    const sheet = document.getElementById('mobile-sheet');
    const nav = document.getElementById('mobile-bottom-nav');
    if (!sheet || !nav) return;
    if (!tab) {
      sheet.classList.remove('open');
      sheet.setAttribute('aria-hidden', 'true');
      nav.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      return;
    }
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    sheet.querySelectorAll('.ops-tab-pane').forEach(p => p.classList.toggle('active', p.id === 'ops-tab-' + tab));
    nav.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.opsTab === tab));
  }

  // ----- DXCC prefix lookup -----
  // Each entry: [prefix, country_name, iso2_or_null, continent]
  // continent: EU NA SA AS AF OC
  // Sorted longest-first at build time for greedy prefix matching.
  const _DXCC = [
    // --- 4-char+ specials ---
    ['VK9C','Cocos-Keeling Is.',null,'OC'],['VK9L','Lord Howe Is.',null,'OC'],
    ['VK9M','Mellish Reef',null,'OC'],['VK9N','Norfolk Is.','NF','OC'],
    ['VK9W','Willis Is.',null,'OC'],['VK9X','Christmas Is.',null,'OC'],
    ['VK0M','Macquarie Is.',null,'OC'],['VK0H','Heard Is.',null,'AF'],
    // --- 3-char specials ---
    ['KH0','N.Mariana Is.','MP','OC'],['WH0','N.Mariana Is.','MP','OC'],['AH0','N.Mariana Is.','MP','OC'],
    ['KH1','Baker & Howland',null,'OC'],
    ['KH2','Guam','GU','OC'],['WH2','Guam','GU','OC'],['AH2','Guam','GU','OC'],
    ['KH3','Johnston Is.',null,'OC'],['KH4','Midway Is.',null,'OC'],
    ['KH5','Palmyra',null,'OC'],
    ['KH6','Hawaii','US','OC'],['WH6','Hawaii','US','OC'],['NH6','Hawaii','US','OC'],['AH6','Hawaii','US','OC'],
    ['KH7','Kure Is.',null,'OC'],
    ['KH8','American Samoa','AS','OC'],['WH8','American Samoa','AS','OC'],
    ['KH9','Wake Is.',null,'OC'],
    ['KL7','Alaska','US','NA'],['WL7','Alaska','US','NA'],['NL7','Alaska','US','NA'],['AL7','Alaska','US','NA'],
    ['KP1','Navassa Is.',null,'NA'],
    ['KP2','US Virgin Is.','VI','NA'],['WP2','US Virgin Is.','VI','NA'],['NP2','US Virgin Is.','VI','NA'],
    ['KP4','Puerto Rico','PR','NA'],['WP4','Puerto Rico','PR','NA'],['NP4','Puerto Rico','PR','NA'],
    ['KP5','Desecheo Is.',null,'NA'],
    ['VP2E','Anguilla','AI','NA'],['VP2M','Montserrat','MS','NA'],['VP2V','British Virgin Is.','VG','NA'],
    ['VP5','Turks & Caicos','TC','NA'],
    ['VP8','Falkland Is.',null,'SA'],
    ['VP9','Bermuda','BM','NA'],
    ['VQ9','Diego Garcia','IO','AF'],
    ['ZD7','St.Helena',null,'AF'],['ZD8','Ascension Is.',null,'AF'],['ZD9','Tristan da Cunha',null,'AF'],
    ['ZL7','Chatham Is.',null,'OC'],['ZL8','Kermadec Is.',null,'OC'],['ZL9','Auckland Is.',null,'OC'],
    ['ZK2','Niue','NU','OC'],['ZK3','Tokelau','TK','OC'],
    ['OH0','Aland Is.','AX','EU'],['OJ0','Market Reef',null,'EU'],
    ['HB0','Liechtenstein','LI','EU'],
    ['CT3','Madeira','PT','AF'],
    ['EA8','Canary Is.','ES','AF'],['EA9','Ceuta/Melilla','ES','EU'],
    ['IS0','Sardinia','IT','EU'],['IT9','Sicily','IT','EU'],['IH9','Pantelleria','IT','EU'],
    ['3D2','Fiji','FJ','OC'],['3DA','Eswatini','SZ','AF'],
    ['PJ2','Curacao','CW','NA'],['PJ4','Bonaire','BQ','NA'],
    ['PJ5','Saba',null,'NA'],['PJ7','Sint Maarten','SX','NA'],
    ['FP','St.Pierre-Miquelon',null,'NA'],
    ['FJ','St.Martin',null,'NA'],
    ['FW','Wallis & Futuna',null,'OC'],
    ['JD1','Ogasawara',null,'AS'],
    ['JW','Svalbard','SJ','EU'],['JX','Jan Mayen',null,'EU'],
    ['OX','Greenland','GL','NA'],
    ['XX9','Macao','MO','AS'],
    ['ZB','Gibraltar','GI','EU'],
    ['TK','Corsica','FR','EU'],
    ['SV5','Dodecanese','GR','EU'],['SV9','Crete','GR','EU'],
    ['UA2','Kaliningrad','RU','EU'],
    // --- 2-char (UK before G/M) ---
    ...['GW','MW','2W'].map(p=>[p,'Wales','GB','EU']),
    ...['GM','MM','2M'].map(p=>[p,'Scotland','GB','EU']),
    ...['GI','MI','2I'].map(p=>[p,'N.Ireland','GB','EU']),
    ['GD','Isle of Man','IM','EU'],['MD','Isle of Man','IM','EU'],
    ['GJ','Jersey','JE','EU'],['MJ','Jersey','JE','EU'],
    ['GU','Guernsey','GG','EU'],['MU','Guernsey','GG','EU'],
    ['G','UK','GB','EU'],['M','UK','GB','EU'],['2E','UK','GB','EU'],
    // Canada
    ...['VE','VA','VY'].map(p=>[p,'Canada','CA','NA']),
    // Australia / NZ / Cook Islands
    ['VK','Australia','AU','OC'],
    ...['ZL','ZM'].map(p=>[p,'New Zealand','NZ','OC']),
    ['ZK','Cook Islands','CK','OC'],
    // Germany
    ...['DA','DB','DC','DD','DE','DF','DG','DH','DJ','DK','DL','DM','DN','DO','DP'].map(p=>[p,'Germany','DE','EU']),
    // Japan (JA-JS; JT/JU/JV=Mongolia; JW/JX/JD1 handled above)
    ...['JA','JE','JF','JG','JH','JI','JJ','JK','JL','JM','JN','JO','JP','JQ','JR','JS'].map(p=>[p,'Japan','JP','AS']),
    ...['7J','7K','7L','7M','7N'].map(p=>[p,'Japan','JP','AS']),
    // Mongolia
    ...['JT','JU','JV'].map(p=>[p,'Mongolia','MN','AS']),
    // China / Taiwan
    ...['BA','BD','BG','BH','BI','BJ','BK','BL','BM','BN','BO','BP','BQ','BR','BS','BT','BY'].map(p=>[p,'China','CN','AS']),
    ['BV','Taiwan','TW','AS'],
    // Korea
    ...['HL','DS','DT','6K','6L','6M','6N'].map(p=>[p,'Korea (South)','KR','AS']),
    ['P5','N.Korea','KP','AS'],
    // France (FG/FM/FY/FO/FH/FR before F; FP/FJ/FW in 3-char section above)
    ['FG','Guadeloupe','GP','NA'],['FM','Martinique','MQ','NA'],
    ['FY','French Guiana','GF','SA'],['FO','Fr.Polynesia','PF','OC'],
    ['FH','Mayotte','YT','AF'],['FR','Reunion','RE','AF'],
    ['TM','France','FR','EU'],['F','France','FR','EU'],
    // Italy (IS0/IT9/IH9 handled above)
    ['I','Italy','IT','EU'],
    // Spain (EA8/EA9 handled above; AM/AN/AO also Spain per ITU allocation AMA-AOZ)
    ...['AM','AN','AO','EA','EB','EC','ED','EE','EF','EG','EH'].map(p=>[p,'Spain','ES','EU']),
    // Portugal (CT3 handled above)
    ['CU','Azores','PT','EU'],['CT','Portugal','PT','EU'],['CS','Portugal','PT','EU'],
    // Scandinavia (OH0 handled above)
    ...['OH','OF','OG'].map(p=>[p,'Finland','FI','EU']),
    ...['SM','SK','SL','8S'].map(p=>[p,'Sweden','SE','EU']),
    ...['LA','LB','LC','LD','LE','LF','LG','LI','LJ','LK','LL','LM','LN'].map(p=>[p,'Norway','NO','EU']),
    ...['OZ','OV','OU'].map(p=>[p,'Denmark','DK','EU']),
    ['OY','Faroe Is.','FO','EU'],
    ['TF','Iceland','IS','EU'],
    // BeNeLux (PJ* handled above)
    ...['PA','PB','PC','PD','PE','PF','PG','PH','PI'].map(p=>[p,'Netherlands','NL','EU']),
    ['PZ','Suriname','SR','SA'],['P4','Aruba','AW','NA'],
    ...['ON','OO','OP','OQ','OR','OS','OT'].map(p=>[p,'Belgium','BE','EU']),
    ['LX','Luxembourg','LU','EU'],
    // Eastern Europe
    ...['SP','SQ','SR','SN','3Z'].map(p=>[p,'Poland','PL','EU']),
    ...['OK','OL'].map(p=>[p,'Czech Rep.','CZ','EU']),
    ['OM','Slovakia','SK','EU'],
    ['OE','Austria','AT','EU'],
    ...['HB','HE'].map(p=>[p,'Switzerland','CH','EU']),
    ...['HA','HG'].map(p=>[p,'Hungary','HU','EU']),
    ...['YO','YP','YQ','YR'].map(p=>[p,'Romania','RO','EU']),
    ['LZ','Bulgaria','BG','EU'],
    ['SV','Greece','GR','EU'],['J4','Greece','GR','EU'],
    ...['TA','TB','TC','YM'].map(p=>[p,'Turkey','TR','AS']),
    // Balkans
    ['9A','Croatia','HR','EU'],['S5','Slovenia','SI','EU'],
    ...['E7','T9'].map(p=>[p,'Bosnia-Herzeg.','BA','EU']),
    ...['YU','YT','YZ'].map(p=>[p,'Serbia','RS','EU']),
    ['4O','Montenegro','ME','EU'],['Z3','N.Macedonia','MK','EU'],
    ['ZA','Albania','AL','EU'],['Z6','Kosovo','XK','EU'],
    // Baltics
    ['ES','Estonia','EE','EU'],['YL','Latvia','LV','EU'],['LY','Lithuania','LT','EU'],
    // Caucasus / Moldova
    ['ER','Moldova','MD','EU'],
    ['EK','Armenia','AM','AS'],
    ['4L','Georgia','GE','AS'],
    // Belarus
    ...['EU','EV','EW'].map(p=>[p,'Belarus','BY','EU']),
    // Ukraine
    ...['UR','US','UT','UU','UV','UW','UX','UY','UZ','EM','EN','EO'].map(p=>[p,'Ukraine','UA','EU']),
    // Russia (UA2/Kaliningrad handled above)
    ...['RA','RB','RC','RD','RE','RF','RG','RH','RI','RJ','RK','RL','RM','RN','RO','RP','RQ','RR','RS','RT','RU','RV','RW','RX','RY','RZ'].map(p=>[p,'Russia','RU','EU']),
    ...['UA','UB','UC','UD','UF','UG','UH','UI'].map(p=>[p,'Russia','RU','EU']),
    // Ireland
    ...['EI','EJ'].map(p=>[p,'Ireland','IE','EU']),
    // Small EU
    ['C3','Andorra','AD','EU'],['3A','Monaco','MC','EU'],
    ['T7','San Marino','SM','EU'],['HV','Vatican',null,'EU'],
    ['9H','Malta','MT','EU'],
    // Near East / Levant
    ...['5B','P3'].map(p=>[p,'Cyprus','CY','AS']),
    ...['4X','4Z'].map(p=>[p,'Israel','IL','AS']),
    ['E4','Palestine','PS','AS'],
    ...['HZ','7Z'].map(p=>[p,'Saudi Arabia','SA','AS']),
    ['A4','Oman','OM','AS'],['A6','UAE','AE','AS'],['A9','Bahrain','BH','AS'],
    ['9K','Kuwait','KW','AS'],['YI','Iraq','IQ','AS'],
    ['OD','Lebanon','LB','AS'],['YK','Syria','SY','AS'],
    ['JY','Jordan','JO','AS'],['A7','Qatar','QA','AS'],
    ['7O','Yemen','YE','AS'],
    ...['EP','EQ'].map(p=>[p,'Iran','IR','AS']),
    // Central Asia
    ...['4J','4K'].map(p=>[p,'Azerbaijan','AZ','AS']),
    ['UK','Uzbekistan','UZ','AS'],['EY','Tajikistan','TJ','AS'],
    ['EZ','Turkmenistan','TM','AS'],
    ...['UN','UO','UP','UQ'].map(p=>[p,'Kazakhstan','KZ','AS']),
    ['EX','Kyrgyzstan','KG','AS'],
    ['YA','Afghanistan','AF','AS'],
    // South Asia
    ...['VU','AT','AU','AV'].map(p=>[p,'India','IN','AS']),
    ['AP','Pakistan','PK','AS'],['4S','Sri Lanka','LK','AS'],
    ['S2','Bangladesh','BD','AS'],['9N','Nepal','NP','AS'],['A5','Bhutan','BT','AS'],
    ['8Q','Maldives','MV','AS'],
    // SE Asia
    ['XU','Cambodia','KH','AS'],
    ...['XV','3W'].map(p=>[p,'Vietnam','VN','AS']),
    ['XW','Laos','LA','AS'],
    ...['HS','E2'].map(p=>[p,'Thailand','TH','AS']),
    ['XZ','Myanmar','MM','AS'],
    ['9M','Malaysia','MY','AS'],
    ...['YB','YC','YD','YE','YF'].map(p=>[p,'Indonesia','ID','AS']),
    ...['DU','DV','DW','DX','DY','DZ'].map(p=>[p,'Philippines','PH','AS']),
    ['9V','Singapore','SG','AS'],['VR','Hong Kong','HK','AS'],['V8','Brunei','BN','AS'],
    ['4W','Timor-Leste','TL','AS'],
    // Pacific
    ['T8','Palau','PW','OC'],['E5','Cook Is.',null,'OC'],
    // USA (K*/W*/N*/A* after specials above)
    ['W','USA','US','NA'],['K','USA','US','NA'],['N','USA','US','NA'],
    ...['AA','AB','AC','AD','AE','AF','AG','AI','AJ','AK'].map(p=>[p,'USA','US','NA']),
    ...['WA','WB','WC','WD','WE','WF','WG','WI','WJ','WK','WM','WN','WO','WP','WQ','WR','WS','WT','WU','WV','WW','WX','WY','WZ'].map(p=>[p,'USA','US','NA']),
    ...['KA','KB','KC','KD','KE','KF','KG','KI','KJ','KK','KM','KN','KO','KP','KQ','KR','KS','KT','KU','KV','KW','KX','KY','KZ'].map(p=>[p,'USA','US','NA']),
    ...['NA','NB','NC','ND','NE','NF','NG','NI','NJ','NK','NM','NN','NO','NP','NQ','NR','NS','NT','NU','NV','NW','NX','NY','NZ'].map(p=>[p,'USA','US','NA']),
    // Mexico / Central America
    ...['XE','XF','XG','XH','XI'].map(p=>[p,'Mexico','MX','NA']),
    ['TI','Costa Rica','CR','NA'],['YN','Nicaragua','NI','NA'],
    ['TG','Guatemala','GT','NA'],
    ...['HQ','HR'].map(p=>[p,'Honduras','HN','NA']),
    ['YS','El Salvador','SV','NA'],
    ...['HP','HO'].map(p=>[p,'Panama','PA','NA']),
    ['V3','Belize','BZ','NA'],
    // Caribbean
    ['HH','Haiti','HT','NA'],['HI','Dominican Rep.','DO','NA'],
    ...['CO','CM','T4'].map(p=>[p,'Cuba','CU','NA']),
    ['C6','Bahamas','BS','NA'],['6Y','Jamaica','JM','NA'],
    ['J3','Grenada','GD','NA'],
    ...['J6','J7','J8'].map(p=>[p,'E.Caribbean',null,'NA']),
    ['V2','Antigua','AG','NA'],['V4','St.Kitts','KN','NA'],['8P','Barbados','BB','NA'],
    // South America
    ...['PY','PP','PQ','PR','PS','PT','PU','PV','PW','PX'].map(p=>[p,'Brazil','BR','SA']),
    ...['LU','AY','LO','LR','LS','LT','LV','LW'].map(p=>[p,'Argentina','AR','SA']),
    ['CE','Chile','CL','SA'],['OA','Peru','PE','SA'],['CX','Uruguay','UY','SA'],
    ['CP','Bolivia','BO','SA'],['HK','Colombia','CO','SA'],['HC','Ecuador','EC','SA'],
    ['ZP','Paraguay','PY','SA'],
    ...['YV','YW'].map(p=>[p,'Venezuela','VE','SA']),
    ['8R','Guyana','GY','SA'],
    ...['9Y','9Z'].map(p=>[p,'Trinidad & Tobago','TT','SA']),
    // Africa
    ...['ZS','ZR','ZU'].map(p=>[p,'South Africa','ZA','AF']),
    ['Z2','Zimbabwe','ZW','AF'],['9J','Zambia','ZM','AF'],
    ['5N','Nigeria','NG','AF'],['5Z','Kenya','KE','AF'],['5H','Tanzania','TZ','AF'],
    ...['9Q','9O'].map(p=>[p,'Congo (DRC)','CD','AF']),
    ['TL','C.African Rep.','CF','AF'],['TJ','Cameroon','CM','AF'],
    ['TR','Gabon','GA','AF'],['TT','Chad','TD','AF'],
    ['TN','Congo Rep.','CG','AF'],
    ['TY','Benin','BJ','AF'],
    ['XT','Burkina Faso','BF','AF'],
    ['5V','Togo','TG','AF'],['5U','Niger','NE','AF'],['5X','Uganda','UG','AF'],
    ['9G','Ghana','GH','AF'],['9L','Sierra Leone','SL','AF'],
    ['EL','Liberia','LR','AF'],
    ...['6W','6V'].map(p=>[p,'Senegal','SN','AF']),
    ['TU','Ivory Coast','CI','AF'],
    ['TS','Tunisia','TN','AF'],['3V','Tunisia','TN','AF'],
    ['CN','Morocco','MA','AF'],
    ...['7X','7T','7U','7V','7W','7Y'].map(p=>[p,'Algeria','DZ','AF']),
    ['ST','Sudan','SD','AF'],['ET','Ethiopia','ET','AF'],
    ['E3','Eritrea','ER','AF'],
    ['6O','Somalia','SO','AF'],['5A','Libya','LY','AF'],
    ['SU','Egypt','EG','AF'],['D2','Angola','AO','AF'],
    ['C5','Gambia','GM','AF'],['D4','Cape Verde','CV','AF'],
    ['3C','Eq.Guinea','GQ','AF'],['V5','Namibia','NA','AF'],
    ['7P','Lesotho','LS','AF'],['A2','Botswana','BW','AF'],
    ['7Q','Malawi','MW','AF'],['C9','Mozambique','MZ','AF'],
    ['9X','Rwanda','RW','AF'],['9U','Burundi','BI','AF'],
    ...['TZ','5O'].map(p=>[p,'Mali','ML','AF']),
    ['5T','Mauritania','MR','AF'],['3B','Mauritius','MU','AF'],
    ['5R','Madagascar','MG','AF'],['6X','Madagascar','MG','AF'],
    ['S7','Seychelles','SC','AF'],
    ['S9','Sao Tome','ST','AF'],
    ['3X','Guinea','GN','AF'],
    ['J2','Djibouti','DJ','AF'],
    ['J5','Guinea-Bissau','GW','AF'],
    ['D6','Comoros','KM','AF'],
    // Pacific
    ['FK','New Caledonia','NC','OC'],['V7','Marshall Is.','MH','OC'],
    ['V6','Micronesia','FM','OC'],['A3','Tonga','TO','OC'],
    ['5W','Samoa','WS','OC'],
    ['H4','Solomon Is.','SB','OC'],['P2','Papua New Guinea','PG','OC'],
    ['YJ','Vanuatu','VU','OC'],['T2','Tuvalu','TV','OC'],['T3','Kiribati','KI','OC'],
  ].sort((a, b) => b[0].length - a[0].length);

  function _callsignNormalize(raw) {
    let c = raw.toUpperCase().trim();
    if (!c.includes('/')) return c;
    const parts = c.split('/');
    if (parts.length !== 2) return parts[0];
    const [a, b] = parts;
    if (['P','M','MM','AM','QRP','A','B'].includes(b)) return a;
    return a.length <= b.length ? a : b;
  }

  function _iso2Flag(iso2) {
    if (!iso2) return '🏴';
    return [...iso2.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
  }

  function callsignToInfo(raw) {
    if (!raw) return { country: '', flag: '🏴', continent: '' };
    const call = _callsignNormalize(raw);
    for (const [pfx, name, iso2, cont] of _DXCC) {
      if (call.startsWith(pfx)) return { country: name, flag: _iso2Flag(iso2), continent: cont };
    }
    return { country: '', flag: '🏴', continent: '' };
  }

  function updateCallCountry(call) {
    const el = $('q-call-country');
    if (!el) return;
    if (!call || call.length < 2) { el.textContent = ''; return; }
    const info = callsignToInfo(call);
    el.textContent = info.country ? `${info.flag} ${info.country}` : '';
  }

  // ----- geo utilities -----

  function locatorToLatLon(loc) {
    if (!loc || loc.length < 4) return null;
    loc = loc.toUpperCase();
    const c0 = loc.charCodeAt(0) - 65, c1 = loc.charCodeAt(1) - 65;
    if (c0 < 0 || c0 > 17 || c1 < 0 || c1 > 17) return null;
    const d2 = parseInt(loc[2]), d3 = parseInt(loc[3]);
    if (isNaN(d2) || isNaN(d3)) return null;
    let lon = c0 * 20 - 180 + d2 * 2;
    let lat = c1 * 10 - 90  + d3;
    if (loc.length >= 6) {
      const s4 = loc.charCodeAt(4) - 65, s5 = loc.charCodeAt(5) - 65;
      if (s4 >= 0 && s4 < 24 && s5 >= 0 && s5 < 24) {
        lon += s4 / 12 + 1/24;
        lat += s5 / 24 + 1/48;
      } else { lon += 1; lat += 0.5; }
    } else { lon += 1; lat += 0.5; }
    return { lat, lon };
  }

  function bearingTo(lat1, lon1, lat2, lon2) {
    const R = Math.PI / 180;
    const φ1 = lat1 * R, φ2 = lat2 * R, Δλ = (lon2 - lon1) * R;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  function bearingCompass(deg) {
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
  }

  function distanceTo(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*toRad) * Math.cos(lat2*toRad) * Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function contestFreqUnit() {
    return me?.contest_freq_unit || 'kHz';
  }

  // Convert stored Hz to the contest's display unit (returns a string).
  function hzToDisplay(hz) {
    if (!hz) return '';
    switch (contestFreqUnit()) {
      case 'Hz':  return String(Math.round(hz));
      case 'MHz': return (hz / 1_000_000).toFixed(6);
      case 'GHz': return (hz / 1_000_000_000).toFixed(9);
      default:    return (hz / 1_000).toFixed(3); // kHz
    }
  }

  // Convert the display unit input value back to Hz for storage.
  function displayToHz(val) {
    const f = parseFloat(val);
    if (!f) return 0;
    switch (contestFreqUnit()) {
      case 'Hz':  return Math.round(f);
      case 'MHz': return Math.round(f * 1_000_000);
      case 'GHz': return Math.round(f * 1_000_000_000);
      default:    return Math.round(f * 1_000); // kHz
    }
  }

  // Convert display unit input value to kHz (for bandFromFreqKHz).
  function displayToKHz(val) {
    return displayToHz(val) / 1_000;
  }

  // Update the freq input label to reflect the current unit (overrides i18n text node).
  function updateFreqLabel() {
    const el = document.querySelector('label[data-qso-field="freq"]');
    if (!el) return;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        node.nodeValue = t('qso.frequency') + ' (' + contestFreqUnit() + ')\n';
        break;
      }
    }
  }

  function greatCirclePoints(lat1, lon1, lat2, lon2, n) {
    const R = Math.PI / 180;
    const φ1 = lat1*R, λ1 = lon1*R, φ2 = lat2*R, λ2 = lon2*R;
    const cosD = Math.sin(φ1)*Math.sin(φ2) + Math.cos(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
    const D = Math.acos(Math.max(-1, Math.min(1, cosD)));
    if (D < 1e-9) return [[lat1, lon1]];
    const sinD = Math.sin(D);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const A = Math.sin((1-f)*D)/sinD, B = Math.sin(f*D)/sinD;
      const x = A*Math.cos(φ1)*Math.cos(λ1) + B*Math.cos(φ2)*Math.cos(λ2);
      const y = A*Math.cos(φ1)*Math.sin(λ1) + B*Math.cos(φ2)*Math.sin(λ2);
      const z = A*Math.sin(φ1) + B*Math.sin(φ2);
      pts.push([Math.atan2(z, Math.sqrt(x*x+y*y))*180/Math.PI, Math.atan2(y,x)*180/Math.PI]);
    }
    return pts;
  }

  // Split great-circle waypoints into segments at antimeridian crossings.
  function splitAtAntimeridian(pts) {
    if (!pts.length) return [];
    const segs = [];
    let seg = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(pts[i][1] - pts[i-1][1]) > 180) {
        segs.push(seg); seg = [pts[i]];
      } else { seg.push(pts[i]); }
    }
    segs.push(seg);
    return segs;
  }

  // ----- Leaflet map (QSO bearing panel) -----
  let leafletMap = null;
  let qthMarker = null, tgtMarker = null;
  let pathLines = [];
  let arrowAnim = null;  // requestAnimationFrame handle for the flowing chevrons
  function stopArrowAnim() {
    if (arrowAnim !== null) { cancelAnimationFrame(arrowAnim); arrowAnim = null; }
  }

  // ----- Contest map (Map tab) -----
  let contestMap = null;
  let contestMapQthMarker = null;
  // [{ locKey, entries:[{q,band,color,paths:[]}], marker }]  — one per unique locator
  let contestMapItems = [];
  // { enabledBands: Set, knownBands: Set, showPaths: bool, contestId }
  let contestMapState = null;
  // 2D / 3D sub-tab state
  let contestMapActiveSubTab = '2d';
  // 3D globe state
  let contestGlobeInitialized = false;
  let contestGlobeLandData = null;   // GeoJSON country features, loaded once
  let contestGlobeLabels   = null;   // [{n,d,r,lat,lon}] label data, loaded once
  let contestGlobeZoom = 1.0;
  let contestGlobeCenterLon = 10;
  let contestGlobeCenterLat = 20;
  // [{ q, lat, lon, color, band }]
  let contestGlobeQsoItems = [];
  // [{ band, color, points:[{lat,lon}] }]
  let contestGlobeGcPaths = [];
  let contestGlobeQthLat = null;
  let contestGlobeQthLon = null;
  let contestGlobeQthLabel = '';
  // projected items from last render (for click detection)
  let contestGlobeLastVisItems = [];
  let contestGlobeLastQthProj = null;

  function initLeafletMap() {
    const el = $('map-canvas');
    if (!el || leafletMap || typeof L === 'undefined') return;
    try {
      leafletMap = L.map(el, {
        zoomControl: true,
        attributionControl: true,
        scrollWheelZoom: true,
      }).setView([20, 0], 1);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/">OSM</a> © <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 18,
      }).addTo(leafletMap);
    } catch (e) {
      leafletMap = null;
      console.warn('Leaflet init failed:', e);
    }
  }

  const $ = (id) => document.getElementById(id);

  // ----- state -----
  let me = null;          // {username, callsign, permissions, selected_rig, contest_id, contest_status, contest_call, contest_name, contest_qth}
  let csrfToken = null;
  let qsos = [];
  let operators = [];
  let globalOperators = [];
  let rigs = [];          // [{name, freq_hz, mode, band, in_use_by, connected, error, helper_count}]
  let settings = null;
  let allRoles = [];
  let allPerms = [];
  let allContests = [];
  let contestViewMode = localStorage.getItem('contestViewMode') || 'cards';
  let contestSortField = localStorage.getItem('contestSortField') || 'created_at';
  let contestSortDir = localStorage.getItem('contestSortDir') || 'desc';
  let contestStatusFilter = localStorage.getItem('contestStatusFilter') || '';
  let ws = null;
  let wsRetry = 0;
  let currentTargetLocator = null; // Maidenhead locator of the station being looked up
  let callsignFilter = null; // callsign to narrow QSO history while entering a contact
  let editingQsoId = null; // ID of the QSO being edited, or null for new entry
  let currentBandOps = {}; // band → [callsign, ...] of other ops on that band (updated by renderBandPills)
  let stashes = []; // [{id, callsign, freq_hz, ...}] stashed pre-QSOs for the current user+contest
  let lastRigFreqs = {}; // rig name → last known freq_hz, used to detect TRX QSY
  let stashAgeTimer = null;
  // True when q-nr-sent currently holds an auto-filled preview value (not user-typed).
  // Lets updateNrPreview refresh a stale preview after another QSO is logged/deleted
  // without overwriting a number the operator actually typed.
  let nrSentAutoFilled = false;

  function hasPerm(p) {
    if (!me) return false;
    return me.permissions.includes('*') || me.permissions.includes(p);
  }

  function isAdmin() {
    return !!(me && me.permissions && me.permissions.includes('*'));
  }

  function contestIsOpen() {
    return me && me.contest_status === 'open';
  }

  // ----- per-contest role helpers -----
  //
  // The server assigns each user one of {owner, editor, logger, ""} for the
  // currently selected contest (fetched via /select and refreshed on /api/me).
  // Owner can manage the contest; editor can edit/delete any QSO; logger
  // can log new QSOs and edit/delete only their own rows.
  const CONTEST_ROLE_RANK = { owner: 3, editor: 2, logger: 1, '': 0 };
  function contestRoleAtLeast(want) {
    const have = (me && me.contest_my_role) || '';
    return (CONTEST_ROLE_RANK[have] || 0) >= (CONTEST_ROLE_RANK[want] || 0);
  }
  // Can the current session log new QSOs in the selected contest?
  function canLogQSOs() {
    return hasPerm('qso.write') && contestIsOpen() && contestRoleAtLeast('logger');
  }
  // Can the current session edit or delete this specific QSO?
  // Editors + owners can touch any row; loggers can only touch their own.
  function canEditQSO(q) {
    if (!hasPerm('qso.write') || !contestIsOpen()) return false;
    if (contestRoleAtLeast('editor')) return true;
    if (!contestRoleAtLeast('logger')) return false;
    return q && q.operator_user_id && me && q.operator_user_id === me.user_id;
  }
  // Can the current session manage this contest (settings, participants,
  // groups, visibility)? Owner OR a matching global manager permission.
  function canManageThisContest() {
    if (!me) return false;
    if (hasPerm('contest.admin')) return true;
    const priv = !!me.contest_private || me.contest_visibility === 'private';
    if (priv && hasPerm('contests.manage_private')) return true;
    if (!priv && hasPerm('contests.manage')) return true;
    return me.contest_my_role === 'owner';
  }

  // ----- screens -----
  function show(which) {
    ['setup-screen', 'login-screen', 'contest-screen', 'global-settings-screen',
     'contests-admin-screen', 'users-admin-screen', 'groups-admin-screen', 'audit-admin-screen', 'syslog-admin-screen', 'featurerequests-admin-screen',
     'callsign-requests-admin-screen', 'backups-admin-screen',
     'my-featurerequests-screen', 'my-settings-screen', 'changelog-screen', 'dok-cache-screen', 'app'].forEach(id => $(id).classList.add('hidden'));
    $(which).classList.remove('hidden');
    if (which === 'setup-screen') $('setup-username').focus();
    if (which === 'login-screen') {
      $('login-username').focus();
      // Fire-and-forget: reveal the SSO button if the admin has
      // enabled OIDC in Global Settings. Function is defined below
      // in the OIDC section — the forward reference is safe at
      // call-time since show('login-screen') only fires post-boot.
      if (typeof showLoginScreenOIDC === 'function') showLoginScreenOIDC();
    }
  }

  // ----- API helper -----
  async function api(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (csrfToken && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      headers['X-CSRF-Token'] = csrfToken;
    }
    const res = await fetch(path, {
      ...opts,
      headers,
      credentials: 'same-origin',
    });
    if (res.status === 401 && me) {
      me = null;
      csrfToken = null;
      show('login-screen');
      throw new Error('unauthorized');
    }
    return res;
  }

  // ----- setup flow -----
  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('setup-error').textContent = '';
    const body = {
      username: $('setup-username').value.trim(),
      password: $('setup-password').value,
      callsign: $('setup-callsign').value.trim().toUpperCase(),
    };
    const res = await api('/api/setup', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('setup-error').textContent = j.error || t('setup.setupFailed');
      return;
    }
    await bootstrap();
  });

  // ----- login flow -----
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    const body = {
      username: $('login-username').value.trim(),
      password: $('login-password').value,
    };
    const res = await api('/api/login', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (res.status === 423) {
        $('login-error').textContent = t('login.accountLocked', { s: j.locked_seconds || '?' });
      } else {
        $('login-error').textContent = j.error || t('login.loginFailed');
      }
      return;
    }
    const loginData = await res.json().catch(() => ({}));
    csrfToken = loginData.csrf_token || null;
    await bootstrap();
  });

  // ----- OIDC (single sign-on) -----
  // The button is initially hidden; showLoginScreenOIDC() polls the public
  // /api/oidc/config endpoint on every visit to the login screen so admins
  // enabling SSO from Global Settings see it appear without a reload.
  async function showLoginScreenOIDC() {
    const btn = $('oidc-login-btn');
    const errEl = $('oidc-login-error');
    if (!btn) return;
    if (errEl) errEl.textContent = '';
    // Callback redirects here with #oidc_error=... on failure; surface it.
    if (location.hash.startsWith('#oidc_error=')) {
      try {
        const msg = decodeURIComponent(location.hash.slice('#oidc_error='.length));
        if (errEl) errEl.textContent = t('login.ssoLoginFailed', { msg });
      } catch {}
      // Clear the fragment so a reload doesn't keep showing it.
      history.replaceState(null, '', location.pathname + location.search);
    }
    try {
      const res = await fetch('/api/oidc/config', { credentials: 'same-origin' });
      if (!res.ok) { btn.classList.add('hidden'); return; }
      const cfg = await res.json();
      if (!cfg.enabled) { btn.classList.add('hidden'); return; }
      // Overwrite the default label with the admin-configured one when set;
      // otherwise the data-i18n default ("Sign in with SSO") stays in place.
      if (cfg.label && cfg.label !== 'Sign in with SSO') {
        btn.textContent = '\u{1F310} ' + cfg.label;
      }
      btn.classList.remove('hidden');
    } catch {
      btn.classList.add('hidden');
    }
  }
  $('oidc-login-btn')?.addEventListener('click', () => {
    // Full page navigation — the callback ends in a 302 back to "/", at
    // which point the app boots normally from a fresh session cookie.
    window.location.href = '/api/oidc/login';
  });

  $('logout-btn').addEventListener('click', doLogout);
  $('contest-logout-btn').addEventListener('click', doLogout);

  async function doLogout() {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    me = null;
    csrfToken = null;
    if (ws) try { ws.close(); } catch {}
    ws = null;
    clearChat();
    show('login-screen');
  }

  // ----- admin screens (accessed from contest selection) -----
  $('my-fr-nav-btn').addEventListener('click', () => showAdminScreen('my-featurerequests-screen', refreshMyFeatureRequests));
  $('dok-cache-nav-btn').addEventListener('click', () => { if (!hasPerm('dok.edit')) return; showAdminScreen('dok-cache-screen', loadDOKCache); });
  $('changelog-nav-btn').addEventListener('click', () => showAdminScreen('changelog-screen', renderChangelog));
  $('download-helper-btn').addEventListener('click', () => openDownloadModal(null));
  $('my-settings-nav-btn').addEventListener('click', () => showAdminScreen('my-settings-screen', loadMySettings));
  $('contests-admin-btn')?.addEventListener('click', () => showAdminScreen('contests-admin-screen', refreshContests));
  $('users-admin-btn').addEventListener('click', () => { if (!hasPerm('users.manage')) return; showAdminScreen('users-admin-screen', refreshUsers); });
  $('audit-admin-btn').addEventListener('click', () => { if (!hasPerm('audit.log')) return; showAdminScreen('audit-admin-screen', () => refreshAuditLog(true)); });
  $('syslog-admin-btn')?.addEventListener('click', () => { if (!hasPerm('system.log')) return; showAdminScreen('syslog-admin-screen', () => refreshSystemLog(true)); });
  $('featurerequests-admin-btn').addEventListener('click', () => { if (!hasPerm('feature_requests.read')) return; showAdminScreen('featurerequests-admin-screen', refreshFeatureRequests); });
  $('callsign-requests-admin-btn')?.addEventListener('click', () => { if (!hasPerm('callsign_requests.review')) return; showAdminScreen('callsign-requests-admin-screen', refreshCallsignRequests); });
  $('backups-admin-btn')?.addEventListener('click', () => { if (!hasPerm('backups.manage')) return; showAdminScreen('backups-admin-screen', refreshBackups); });
  $('groups-admin-btn')?.addEventListener('click', () => { if (!hasPerm('groups.manage')) return; showAdminScreen('groups-admin-screen', refreshGroups); });
  $('contest-templates-nav-btn')?.addEventListener('click', () => { if (!hasPerm('contest_templates.manage')) return; showAdminScreen('contest-templates-screen', refreshTemplates); });

  document.querySelectorAll('.admin-back-btn').forEach(btn => {
    btn.addEventListener('click', () => showContestScreen());
  });

  function showAdminScreen(id, loader) {
    show(id);
    if (loader) try { loader(); } catch {}
  }

  // ----- global settings screen -----
  $('global-settings-btn').addEventListener('click', () => showGlobalSettings());
  $('global-settings-back-btn').addEventListener('click', () => showContestScreen());
  $('global-settings-back-btn-top')?.addEventListener('click', () => showContestScreen());
  $('gs-cluster-log-refresh-btn').addEventListener('click', loadGlobalClusterLog);

  // Tracks the QRZ username last loaded from the server, so the submit handler
  // can detect "the user did not touch QRZ in this menu" and skip sending the
  // QRZ fields entirely.  Without this, the form would round-trip an empty
  // username on every save and wipe out credentials configured elsewhere.
  let _gsQrzLoadedUser = '';
  async function showGlobalSettings() {
    show('global-settings-screen');
    $('global-settings-error').textContent = '';
    let currentSound = '';
    _gsQrzLoadedUser = '';
    try {
      const res = await api('/api/settings');
      if (res.ok) {
        const s = await res.json();
        $('gs-cluster-server').value = s.cluster_server || '';
        $('gs-cluster-call').value = s.cluster_call || '';
        $('gs-cluster-retention').value = s.cluster_retention_days || 7;
        // BackupRetentionDays: allow 0 (means "keep forever") but
        // fall back to 30 if the field is missing (older backend).
        const bkRet = ('backup_retention_days' in s) ? s.backup_retention_days : 30;
        if ($('gs-backup-retention')) $('gs-backup-retention').value = bkRet;
        currentSound = s.chat_sound || '';
        $('gs-public-feature-requests').checked = !!s.public_feature_requests;
        if ('qrz_username' in s) {
          _gsQrzLoadedUser = s.qrz_username || '';
          $('gs-qrz-user').value = _gsQrzLoadedUser;
          $('gs-qrz-status').textContent = s.qrz_configured ? t('settings.qrzConfigured') : t('settings.qrzNotConfigured');
        }
        // OIDC (only present in the response when the caller has
        // settings.write permission; the fieldset is unconditional in
        // the DOM so we simply guard on the key's presence).
        if ('oidc_enabled' in s) {
          $('gs-oidc-enabled').checked = !!s.oidc_enabled;
          $('gs-oidc-auto-create').checked = !!s.oidc_auto_create;
          $('gs-oidc-issuer').value = s.oidc_issuer_url || '';
          $('gs-oidc-client-id').value = s.oidc_client_id || '';
          $('gs-oidc-client-secret').value = '';
          $('gs-oidc-secret-status').textContent = s.oidc_client_secret_configured
            ? t('globalSettings.oidcClientSecretConfigured')
            : t('globalSettings.oidcClientSecretMissing');
          $('gs-oidc-scopes').value = s.oidc_scopes || '';
          $('gs-oidc-button-label').value = s.oidc_button_label || '';
          $('gs-oidc-callsign-claim').value = s.oidc_callsign_claim || '';
          $('gs-oidc-redirect-url').value = s.oidc_redirect_url || '';
        }
      }
    } catch {}
    loadGlobalClusterLog();
    loadDummyRigs();
    loadCustomSounds(currentSound);
  }

  async function loadCustomSounds(currentVal) {
    try {
      const res = await api('/api/sounds');
      if (!res.ok) return;
      const data = await res.json();
      populateSoundDropdown(data.files || [], currentVal);
      renderCustomSoundsList(data.files || []);
    } catch {}
  }

  function populateSoundDropdown(customFiles, currentVal) {
    const sel = $('gs-chat-sound');
    if (!sel) return;
    // Remove existing custom options (anything with value starting 'custom:' or the separator)
    Array.from(sel.options).filter(o => o.value.startsWith('custom:') || o.dataset.customSep).forEach(o => o.remove());
    if (customFiles.length > 0) {
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.textContent = t('globalSettings.customSepLabel');
      sep.dataset.customSep = '1';
      sel.appendChild(sep);
      for (const f of customFiles) {
        const o = document.createElement('option');
        o.value = 'custom:' + f;
        o.textContent = f;
        sel.appendChild(o);
      }
    }
    sel.value = currentVal;
  }

  function renderCustomSoundsList(files) {
    const container = $('gs-custom-sounds-list');
    if (!container) return;
    if (!files.length) { container.innerHTML = ''; return; }
    let html = '<p class="muted small" style="margin-bottom:4px">' + escHtml(t('globalSettings.uploadedSounds')) + '</p>';
    container.innerHTML = html;
    for (const f of files) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:3px 0';
      const name = document.createElement('span');
      name.className = 'muted small';
      name.style.flex = '1';
      name.textContent = f;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost';
      del.style.cssText = 'width:auto;margin:0;padding:2px 8px;font-size:11px';
      del.textContent = t('common.delete');
      del.addEventListener('click', async () => {
        const res = await api('/api/sounds/' + encodeURIComponent(f), { method: 'DELETE' });
        if (res.ok) {
          const sel = $('gs-chat-sound');
          if (sel && sel.value === 'custom:' + f) sel.value = '';
          await loadCustomSounds($('gs-chat-sound')?.value || '');
        }
      });
      row.appendChild(name);
      row.appendChild(del);
      container.appendChild(row);
    }
  }

  async function loadGlobalClusterLog() {
    try {
      const res = await api('/api/cluster/log');
      if (!res.ok) return;
      const data = await res.json();
      $('gs-cluster-log-pre').textContent = (data.lines || []).join('\n');
      const conn = data.connected ? t('globalSettings.connected') : t('globalSettings.disconnected');
      const srv = data.server || 'dxc.ve7cc.net:23';
      $('gs-cluster-log-status').textContent = t('globalSettings.clusterStatus', { conn, srv, call: data.call || t('globalSettings.clusterCallNone') });
    } catch {}
  }

  $('global-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('global-settings-error').textContent = '';
    const body = {
      cluster_server: $('gs-cluster-server').value.trim(),
      cluster_call: $('gs-cluster-call').value.trim().toUpperCase(),
      cluster_retention_days: parseInt($('gs-cluster-retention').value) || 7,
      chat_sound: $('gs-chat-sound').value,
      public_feature_requests: $('gs-public-feature-requests').checked,
    };
    // Only include the backup retention field when the input exists
    // (perm-required fieldset hides it for non-backup-managers).
    const bkRetEl = $('gs-backup-retention');
    if (bkRetEl && bkRetEl.value !== '') {
      const bkRet = parseInt(bkRetEl.value);
      if (!Number.isNaN(bkRet) && bkRet >= 0) body.backup_retention_days = bkRet;
    }
    // Only include QRZ fields when the operator actually changed them in this
    // menu — server treats missing keys as "preserve current credentials".
    const qrzUser = $('gs-qrz-user').value.trim();
    const qrzPass = $('gs-qrz-pass').value;
    if (qrzUser !== _gsQrzLoadedUser) body.qrz_username = qrzUser;
    if (qrzPass !== '') body.qrz_password = qrzPass;
    // OIDC — always send the visible fields; the server preserves the
    // existing client secret when we omit it (i.e. when the input is empty).
    if ($('gs-oidc-enabled')) {
      body.oidc_enabled = $('gs-oidc-enabled').checked;
      body.oidc_auto_create = $('gs-oidc-auto-create').checked;
      body.oidc_issuer_url = $('gs-oidc-issuer').value.trim();
      body.oidc_client_id = $('gs-oidc-client-id').value.trim();
      const secret = $('gs-oidc-client-secret').value;
      if (secret !== '') body.oidc_client_secret = secret;
      body.oidc_scopes = $('gs-oidc-scopes').value.trim();
      body.oidc_button_label = $('gs-oidc-button-label').value.trim();
      body.oidc_callsign_claim = $('gs-oidc-callsign-claim').value.trim();
    }
    const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('global-settings-error').textContent = j.error || t('common.saveFailed');
      return;
    }
    $('gs-qrz-pass').value = '';
    // Clear the OIDC secret input after a successful save so the "leave
    // blank to keep existing" hint is accurate on the next open.
    if ($('gs-oidc-client-secret')) $('gs-oidc-client-secret').value = '';
    loadGlobalClusterLog();
    if (settings) {
      settings.chat_sound = body.chat_sound;
      settings.public_feature_requests = body.public_feature_requests;
    }
  });

  $('gs-oidc-redirect-copy')?.addEventListener('click', () => {
    const el = $('gs-oidc-redirect-url');
    if (!el || !el.value) return;
    try {
      navigator.clipboard.writeText(el.value);
    } catch {
      el.select();
      document.execCommand('copy');
    }
  });

  $('gs-chat-sound-preview').addEventListener('click', () => {
    const type = $('gs-chat-sound').value;
    if (type) playChatSound(type);
  });

  $('gs-qrz-test-btn').addEventListener('click', async () => {
    const username = $('gs-qrz-user').value.trim();
    const password = $('gs-qrz-pass').value;
    const statusEl = $('gs-qrz-status');
    if (!username) { statusEl.textContent = t('settings.qrzEnterUsername'); statusEl.style.color = 'var(--error)'; return; }
    $('gs-qrz-test-btn').disabled = true;
    statusEl.textContent = t('settings.qrzTesting');
    statusEl.style.color = '';
    const res = await api('/api/qrz/test', { method: 'POST', body: JSON.stringify({ username, password }) });
    $('gs-qrz-test-btn').disabled = false;
    const j = await res.json().catch(() => ({}));
    if (j.ok) { statusEl.textContent = t('settings.qrzConnected', { name: j.name || t('settings.qrzNoName') }); statusEl.style.color = 'var(--success)'; }
    else { statusEl.textContent = t('settings.qrzFailed', { err: j.error || t('common.unknownError') }); statusEl.style.color = 'var(--error)'; }
  });

  $('gs-sound-upload-btn').addEventListener('click', async () => {
    const fileInput = $('gs-sound-file');
    const errEl = $('gs-sound-upload-error');
    errEl.textContent = '';
    if (!fileInput.files.length) { errEl.textContent = t('globalSettings.selectFileFirst'); return; }
    const file = fileInput.files[0];
    if (file.size > 2 * 1024 * 1024) { errEl.textContent = t('globalSettings.fileTooLarge'); return; }
    const form = new FormData();
    form.append('sound', file);
    try {
      const res = await fetch('/api/sounds', {
        method: 'POST',
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
        credentials: 'same-origin',
        body: form,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        errEl.textContent = j.error || t('common.uploadFailed');
        return;
      }
      fileInput.value = '';
      const currentVal = $('gs-chat-sound')?.value || '';
      await loadCustomSounds(currentVal);
    } catch { errEl.textContent = t('common.uploadFailed'); }
  });

  // ----- contest selection screen -----
  $('back-to-overview-btn').addEventListener('click', () => showContestScreen());
  $('station-pill').addEventListener('click', () => {
    const c = getCurrentContestForEdit();
    if (c) contestEditModal(c);
  });
  $('create-contest-btn').addEventListener('click', () => contestCreateModal());
  $('create-private-contest-btn').addEventListener('click', () => contestCreateModal(true));
  $('create-contest-btn-list').addEventListener('click', () => contestCreateModal());
  $('create-private-contest-btn-list').addEventListener('click', () => contestCreateModal(true));
  $('import-share-btn')?.addEventListener('click', () => contestImportShareModal());
  $('import-share-btn-list')?.addEventListener('click', () => contestImportShareModal());

  // Toolbar: status filter pills
  document.querySelectorAll('.cpill[data-cf]').forEach(btn => {
    btn.addEventListener('click', () => {
      contestStatusFilter = btn.dataset.cf;
      localStorage.setItem('contestStatusFilter', contestStatusFilter);
      renderContestPicker();
    });
  });
  $('cf-recent').addEventListener('click', () => {
    if (contestSortField === 'last_activity_at' && contestSortDir === 'desc') {
      contestSortField = 'created_at';
      contestSortDir = 'desc';
    } else {
      contestSortField = 'last_activity_at';
      contestSortDir = 'desc';
    }
    localStorage.setItem('contestSortField', contestSortField);
    localStorage.setItem('contestSortDir', contestSortDir);
    renderContestPicker();
  });
  // Toolbar: view toggle
  document.querySelectorAll('.cvbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      contestViewMode = btn.dataset.cv;
      localStorage.setItem('contestViewMode', contestViewMode);
      renderContestPicker();
    });
  });
  // List view: sortable column headers
  document.querySelectorAll('.clt-head [data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (contestSortField === field) {
        contestSortDir = contestSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        contestSortField = field;
        contestSortDir = (field === 'name' || field === 'station_call') ? 'asc' : 'desc';
      }
      localStorage.setItem('contestSortField', contestSortField);
      localStorage.setItem('contestSortDir', contestSortDir);
      renderContestPicker();
    });
  });

  async function showContestScreen() {
    $('contest-pick-error').textContent = '';
    // Cede control over any selected rig when entering the contest overview.
    if (me?.selected_rig) {
      try { await api('/api/rigs/release', { method: 'POST' }); me.selected_rig = ''; } catch {}
    }
    const [cres, dres] = await Promise.all([
      api('/api/contests'),
      fetch('/api/downloads'),
    ]);
    if (cres.ok) allContests = await cres.json();
    let downloads = [];
    if (dres.ok) downloads = await dres.json().catch(() => []);
    renderContestPicker();
    renderDownloads(downloads);
    renderGlobalOperators();
    show('contest-screen');
    // Keep the WS alive on the contest picker so deploy warnings reach the user
    // even when they haven't entered a contest yet.  enterApp() will close and
    // reconnect if/when a contest is selected.
    if (!ws) connectWS();
    // If the user followed a share link (?share=TOKEN), open the import flow
    // pre-filled with that token.  Strip the query so a page reload does not
    // re-open the dialog after the operator dismissed it.
    const params = new URLSearchParams(window.location.search);
    const shareTok = params.get('share');
    if (shareTok) {
      params.delete('share');
      const qs = params.toString();
      const url = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      window.history.replaceState({}, '', url);
      contestImportShareModal(shareTok);
    }
  }

  function renderDownloads(files) {
    window.__downloadsCache = files || [];
  }

  function openDownloadModal(os) {
    const files = window.__downloadsCache || [];

    // Platform labels
    const PLAT_LABELS = {
      'windows-amd64': t('downloads.platformX64'),
      'darwin-amd64':  t('downloads.platformIntel'),
      'darwin-arm64':  t('downloads.platformAppleSilicon'),
      'linux-amd64':   t('downloads.platformX64'),
      'linux-arm64':   t('downloads.platformArm64'),
    };

    const OS_PLATFORMS = {
      windows: ['windows-amd64'],
      mac:     ['darwin-arm64', 'darwin-amd64'],
      linux:   ['linux-amd64', 'linux-arm64'],
    };

    const APP_DEFS = [
      {
        // Native desktop wrapper for the Noctalum web UI.  Same app the
        // browser sees, running inside the OS-native webview (WebView2 /
        // WebKit / WebKitGTK) with a persistent login.  Listed first so
        // operators see it before the CAT / WSJT-X helpers.
        type: 'desktop',
        icon: '🌙',
        nameKey: 'downloads.appDesktopName',
        variantKey: 'downloads.appDesktopVariant',
        descKey: 'downloads.appDesktopDesc',
      },
      {
        type: 'helper-gui',
        icon: '🖥️',
        nameKey: 'downloads.appHelperGuiName',
        variantKey: 'downloads.appHelperGuiVariant',
        descKey: 'downloads.appHelperGuiDesc',
      },
      {
        type: 'helper',
        icon: '⌨️',
        nameKey: 'downloads.appHelperCliName',
        variantKey: 'downloads.appHelperCliVariant',
        descKey: 'downloads.appHelperCliDesc',
      },
      {
        type: 'wsjtx',
        icon: '📡',
        nameKey: 'downloads.appWsjtxName',
        variantKey: null,
        descKey: 'downloads.appWsjtxDesc',
      },
      // C++ ports live under their own cards (Linux only for now) so
      // operators can pick between the Go original and the native
      // implementation without the two collapsing into one row.
      {
        // C++ helper-gui now cross-compiles for Windows and macOS too (Docker
        // + MXE for .exe, Docker + osxcross for .app.zip).  Card is visible
        // on every OS; if a per-platform artifact is missing, the empty
        // state below tells the user which platform we didn't build for.
        type: 'helper-gui-cpp',
        icon: '🖥️',
        nameKey: 'downloads.appHelperGuiCppName',
        variantKey: 'downloads.appHelperGuiCppVariant',
        descKey: 'downloads.appHelperGuiCppDesc',
      },
      {
        // CLI C++ helpers stay Linux-only — the terminal / rigctld setup
        // doesn't make sense on Windows/macOS where operators want the GUI.
        type: 'helper-cpp',
        icon: '⌨️',
        nameKey: 'downloads.appHelperCliCppName',
        variantKey: 'downloads.appHelperCliCppVariant',
        descKey: 'downloads.appHelperCliCppDesc',
        linuxOnly: true,
      },
      {
        type: 'wsjtx-cpp',
        icon: '📡',
        nameKey: 'downloads.appWsjtxCppName',
        variantKey: 'downloads.appWsjtxCppVariant',
        descKey: 'downloads.appWsjtxCppDesc',
        linuxOnly: true,
      },
      {
        // wsjtx-gui ships as AppImage (Linux), .exe (Windows), .app.zip (macOS).
        type: 'wsjtx-gui',
        icon: '📡',
        nameKey: 'downloads.appWsjtxGuiName',
        variantKey: 'downloads.appWsjtxGuiVariant',
        descKey: 'downloads.appWsjtxGuiDesc',
      },
    ];

    const OS_SVGS = {
      windows: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1" y="1" width="10.5" height="10.5" fill="#F25022"/><rect x="12.5" y="1" width="10.5" height="10.5" fill="#7FBA00"/><rect x="1" y="12.5" width="10.5" height="10.5" fill="#00A4EF"/><rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#FFB900"/></svg>`,
      mac: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.54 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>`,
      linux: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z"/></svg>`,
    };

    if (os === null || os === undefined) {
      // Step 1: OS picker
      // Auto-detect likely OS
      const ua = navigator.userAgent.toLowerCase();
      let detected = 'linux';
      if (ua.includes('win')) detected = 'windows';
      else if (ua.includes('mac')) detected = 'mac';

      const osOptions = [
        { id: 'windows', icon: OS_SVGS.windows, label: t('downloads.osWindows') },
        { id: 'mac',     icon: OS_SVGS.mac,     label: t('downloads.osMac')     },
        { id: 'linux',   icon: OS_SVGS.linux,   label: t('downloads.osLinux')   },
      ];

      const html = `
        <h3 style="margin:0 0 6px;font-size:18px">📥 ${escHtml(t('downloads.dlHelper'))}</h3>
        <p class="muted" style="margin:0 0 24px;font-size:13px">${escHtml(t('downloads.chooseOS'))}</p>
        <div class="dl-os-grid">
          ${osOptions.map(o => `
            <button class="dl-os-btn${o.id === detected ? ' dl-os-detected' : ''}" data-os="${escHtml(o.id)}">
              <span class="dl-os-icon">${o.icon}</span>
              <span class="dl-os-label">${escHtml(o.label)}</span>
              ${o.id === detected ? `<span class="dl-os-badge">${escHtml(t('downloads.detected'))}</span>` : ''}
            </button>
          `).join('')}
        </div>
        <div class="modal-actions"><button type="button" class="ghost cancel-btn">${escHtml(t('common.close'))}</button></div>
      `;
      showModal(html, null, { wide: false });

      // Wire up OS buttons
      document.querySelectorAll('.dl-os-btn').forEach(btn => {
        btn.addEventListener('click', () => openDownloadModal(btn.dataset.os));
      });
      return;
    }

    // Step 2: App list for selected OS
    const platforms = OS_PLATFORMS[os] || [];

    // Group files by type and platform.  The type alternation matches longer
    // names first so `helper-gui-cpp` doesn't get shortened to `helper` and
    // stolen by the Go-helper card.
    const grouped = {};
    for (const f of files) {
      const m = f.match(/^noctalum-(helper-gui-cpp|helper-gui|helper-cpp|helper|wsjtx-gui|wsjtx-cpp|wsjtx|desktop)-(.+?)(?:\.AppImage|\.exe|\.zip)?$/);
      if (!m) continue;
      const [, type, platform] = m;
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push({ file: f, platform, isAppImage: f.endsWith('.AppImage') });
    }

    const osIcons = OS_SVGS;
    const osLabels = { windows: t('downloads.osWindows'), mac: t('downloads.osMac'), linux: t('downloads.osLinux') };

    let appsHtml = '';

    for (const app of APP_DEFS) {
      // The native C++ AppImages only exist for Linux; hide their cards
      // entirely on Windows/Mac rather than showing a permanent "not
      // available" placeholder.
      if (app.linuxOnly && os !== 'linux') continue;
      const available = (grouped[app.type] || []).filter(d => platforms.includes(d.platform));
      // Sort by platform order defined in OS_PLATFORMS
      available.sort((a, b) => platforms.indexOf(a.platform) - platforms.indexOf(b.platform));

      const dlBtns = available.length > 0
        ? available.map(d => {
            const platLabel = available.length > 1 ? ` (${escHtml(PLAT_LABELS[d.platform] || d.platform)})` : '';
            const isRec = d.isAppImage;
            const recLabel = isRec ? `<span class="dl-recommended-label">★ ${escHtml(t('downloads.recommended'))}</span>` : '';
            const appImgPill = d.isAppImage ? `<span class="dl-appimage-pill">${escHtml(t('downloads.appImage'))}</span>` : '';
            const rowClass = isRec ? 'dl-btn-row dl-recommended-box' : 'dl-btn-row';
            return `<div class="dl-btn-group">${recLabel}<div class="${rowClass}"><a class="dl-app-download-btn" href="/downloads/${encodeURIComponent(d.file)}" download>⬇️ ${escHtml(t('downloads.dlBtn'))}${platLabel}</a>${appImgPill}</div></div>`;
          }).join('')
        : `<span class="dl-app-unavail">${escHtml(t('downloads.notAvail'))}</span>`;

      appsHtml += `
        <div class="dl-app-card${available.length === 0 ? ' dl-app-card-dim' : ''}">
          <div class="dl-app-icon">${app.icon}</div>
          <div class="dl-app-body">
            <div class="dl-app-name">${escHtml(t(app.nameKey))}${app.variantKey ? `<span class="dl-app-variant"> — ${escHtml(t(app.variantKey))}</span>` : ''}</div>
            <div class="dl-app-desc">${escHtml(t(app.descKey))}</div>
          </div>
          <div class="dl-app-actions">${dlBtns}</div>
        </div>
      `;
    }

    if (!files.length) {
      appsHtml = `<p class="muted" style="text-align:center;padding:24px 0">${escHtml(t('downloads.noFiles'))}</p>`;
    }

    const html = `
      <div class="dl-step2-header">
        <button class="ghost dl-back-btn">← ${escHtml(t('common.back'))}</button>
        <h3 style="margin:0;font-size:18px">📥 ${escHtml(t('downloads.dlHelper'))}</h3>
        <span class="dl-os-pill">${osIcons[os]} ${escHtml(osLabels[os])}</span>
      </div>
      <div class="dl-apps-list">${appsHtml}</div>
      <div class="modal-actions"><button type="button" class="ghost cancel-btn">${escHtml(t('common.close'))}</button></div>
    `;
    showModal(html, null, { wide: true });

    document.querySelector('.dl-back-btn')?.addEventListener('click', () => openDownloadModal(null));
  }

  function renderGlobalOperators() {
    const list = $('online-operators-list');
    if (!list) return;
    if (globalOperators.length === 0) {
      list.innerHTML = `<p class="muted" style="font-size:12px;margin:0">${escHtml(t('contestScreen.noOperatorsOnline'))}</p>`;
      return;
    }
    list.innerHTML = '';
    for (const op of globalOperators) {
      const div = document.createElement('div');
      div.className = 'online-op';
      if (me && op.callsign === me.callsign) div.classList.add('me');
      const call = document.createElement('span');
      call.className = 'online-op-call';
      call.textContent = fmtCall(op.callsign);
      const loc = document.createElement('span');
      loc.className = 'online-op-location';
      loc.textContent = op.location;
      div.appendChild(call);
      div.appendChild(loc);
      list.appendChild(div);
    }
  }

  function makePickerItem(c) {
    const item = document.createElement('div');
    item.className = 'contest-picker-item' + (c.status === 'finished' ? ' finished' : '');
    const isContestOwner = c.my_role === 'owner';
    const canManageAccess = hasPerm('contest.admin') || isContestOwner;
    const canEditThis = hasPerm('contests.manage') || (hasPerm('contests.manage_private') && c.private) || isContestOwner;
    const isFullManager = hasPerm('contests.manage');
    const canDuplicate = c.private
      ? (hasPerm('contests.manage') || hasPerm('contests.manage_private') || hasPerm('contests.create_private'))
      : hasPerm('contests.manage');
    const canShare = canEditThis;
    const editBtn = canEditThis
      ? `<button class="contest-edit-pill" title="Edit contest" tabindex="-1">&#128295;</button>`
      : '';
    const duplicateBtn = canDuplicate
      ? `<button class="contest-edit-pill contest-duplicate-pill" title="${escHtml(t('contestScreen.duplicateTitle'))}" tabindex="-1">&#128203;</button>`
      : '';
    const shareBtn = canShare
      ? `<button class="contest-edit-pill contest-share-pill" title="${escHtml(t('contestScreen.sharePillTitle'))}" tabindex="-1">&#128279;</button>`
      : '';
    // WSJT-X bridge token is per-contest and available to anyone who
    // can log QSOs into this contest — the server rejects submissions
    // from users without the effective role anyway, so a wide gate here
    // just avoids hiding an actionable button from participants of
    // open / groups-listed contests.
    const canWsjtx = hasPerm('qso.write') && c.status === 'open';
    const wsjtxBtn = canWsjtx
      ? `<button class="contest-edit-pill contest-wsjtx-pill" title="${escHtml(t('contestScreen.wsjtxPillTitle'))}" tabindex="-1">&#128225;</button>`
      : '';
    const accessBtn = canManageAccess
      ? `<button class="contest-edit-pill contest-access-pill" title="${escHtml(t('contestScreen.accessAuthorize'))}" tabindex="-1">${c.access_restricted ? '&#128274;' : '&#128275;'}</button>`
      : (c.access_restricted ? `<span class="contest-access-indicator" title="${escHtml(t('contestScreen.accessRestricted'))}">&#128274;</span>` : '');
    const statusLabel = c.status === 'open' ? t('contestScreen.statusOpen') : t('contestScreen.statusFinished');
    const needsJoinReq = (c.private || c.access_restricted) && !isContestOwner && !isFullManager;
    const joinBtn = needsJoinReq && !c.my_status
      ? `<button class="contest-join-req-btn" tabindex="-1">${escHtml(t('contestScreen.requestToJoin'))}</button>`
      : (needsJoinReq && c.my_status === 'pending'
        ? `<span class="participant-status-pill pending">${escHtml(t('contestScreen.participantPending'))}</span>`
        : '');
    item.innerHTML = `
      <div>
        <div class="contest-picker-name">${escHtml(c.name)}</div>
        <div class="contest-picker-call">${escHtml(fmtCall(c.station_call))}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="contest-picker-status ${c.status}">${escHtml(statusLabel)}</span>
        ${joinBtn}
        ${accessBtn}
        ${wsjtxBtn}
        ${shareBtn}
        ${duplicateBtn}
        ${editBtn}
      </div>
    `;
    if (canEditThis) {
      item.querySelector('.contest-edit-pill:not(.contest-access-pill):not(.contest-duplicate-pill):not(.contest-share-pill):not(.contest-wsjtx-pill)')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        contestEditModal(c);
      });
    }
    if (canDuplicate) {
      item.querySelector('.contest-duplicate-pill')?.addEventListener('click', (e) => {
        e.stopPropagation();
        contestDuplicateModal(c);
      });
    }
    if (canShare) {
      item.querySelector('.contest-share-pill')?.addEventListener('click', (e) => {
        e.stopPropagation();
        contestShareModal(c);
      });
    }
    if (canWsjtx) {
      item.querySelector('.contest-wsjtx-pill')?.addEventListener('click', (e) => {
        e.stopPropagation();
        contestWsjtxTokenModal(c);
      });
    }
    if (canManageAccess) {
      item.querySelector('.contest-access-pill')?.addEventListener('click', (e) => {
        e.stopPropagation();
        contestAccessModal(c);
      });
    }
    item.querySelector('.contest-join-req-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      const r = await api('/api/contests/' + c.id + '/participants', { method: 'POST' });
      if (r.ok) {
        c.my_status = 'pending';
        btn.outerHTML = `<span class="participant-status-pill pending">${escHtml(t('contestScreen.participantPending'))}</span>`;
        refreshContests();
      } else {
        btn.disabled = false;
        alert(t('contestScreen.participantRequestFail'));
      }
    });
    item.addEventListener('click', () => selectContest(c));
    return item;
  }

  async function selectContest(c) {
    $('contest-pick-error').textContent = '';
    const r = await api('/api/contests/' + c.id + '/select', { method: 'POST' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      $('contest-pick-error').textContent = j.error || t('contestScreen.failedSelect');
      return;
    }
    const j = await r.json();
    if (me) {
      me.contest_id = j.contest_id;
      me.contest_status = j.contest_status;
      me.contest_call = j.contest_call;
      me.contest_name = j.contest_name;
      me.contest_qth = j.contest_qth || '';
      me.contest_bands = (j.contest_bands || []).join(',');
      me.contest_objective = j.contest_objective || '';
      me.contest_station_id = j.contest_station_id || '';
      me.contest_qso_layout = j.contest_qso_layout || '';
      me.contest_fields = j.contest_fields || '';
      me.contest_log_columns = j.contest_log_columns || '';
      me.contest_private = j.contest_private || false;
      me.contest_visibility = j.contest_visibility || (j.contest_private ? 'private' : 'open');
      me.contest_owner_user_id = j.contest_owner_user_id || 0;
      me.contest_my_role = j.contest_my_role || '';
      me.contest_nr_padded = j.contest_nr_padded !== false;
      me.contest_freq_unit = j.contest_freq_unit || 'kHz';
    }
    await enterApp();
  }

  function renderContestPicker() {
    const canManage = hasPerm('contests.manage');
    const canPriv = hasPerm('contests.create_private') || hasPerm('contests.manage_private');

    // Sync toolbar visual state
    document.querySelectorAll('.cpill[data-cf]').forEach(el =>
      el.classList.toggle('active', el.dataset.cf === contestStatusFilter));
    const cfRecent = $('cf-recent');
    if (cfRecent) cfRecent.classList.toggle('active',
      contestSortField === 'last_activity_at' && contestSortDir === 'desc');
    document.querySelectorAll('.cvbtn').forEach(el =>
      el.classList.toggle('active', el.dataset.cv === contestViewMode));

    // Filter by status
    let contests = (allContests || []);
    if (contestStatusFilter === 'open') contests = contests.filter(c => c.status === 'open');
    else if (contestStatusFilter === 'finished') contests = contests.filter(c => c.status === 'finished');

    // Sort
    contests = [...contests].sort((a, b) => {
      let av, bv;
      const f = contestSortField;
      if (f === 'name') { av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); }
      else if (f === 'station_call') { av = (a.station_call || '').toLowerCase(); bv = (b.station_call || '').toLowerCase(); }
      else if (f === 'status') { av = a.status || ''; bv = b.status || ''; }
      else if (f === 'last_activity_at') {
        av = a.last_activity_at || a.created_at || '';
        bv = b.last_activity_at || b.created_at || '';
      } else { av = a.created_at || ''; bv = b.created_at || ''; }
      if (av < bv) return contestSortDir === 'asc' ? -1 : 1;
      if (av > bv) return contestSortDir === 'asc' ? 1 : -1;
      return 0;
    });

    if (contestViewMode === 'list') {
      $('contest-card-view').classList.add('hidden');
      $('contest-list-view').classList.remove('hidden');
      renderContestListView(contests, canManage, canPriv);
    } else {
      $('contest-list-view').classList.add('hidden');
      $('contest-card-view').classList.remove('hidden');
      renderContestCardView(contests, canManage, canPriv);
    }
  }

  function renderContestCardView(contests, canManage, canPriv) {
    const list = $('contest-picker-list');
    const privateList = $('private-contest-picker-list');
    const privateCol = $('private-contest-col');
    list.innerHTML = '';
    privateList.innerHTML = '';

    const publicContests = contests.filter(c => !c.private);
    const privateContests = contests.filter(c => c.private);
    // Show private column whenever there are private contests the backend authorized,
    // or when the user has broad manage_private rights.
    const showPrivateCol = canPriv || privateContests.length > 0;
    privateCol.classList.toggle('hidden', !showPrivateCol);

    if (publicContests.length === 0) {
      list.innerHTML = `<p class="muted" style="text-align:center;padding:20px">${escHtml(t('contestScreen.noContests'))}</p>`;
    } else {
      for (const c of publicContests) list.appendChild(makePickerItem(c));
    }
    if (showPrivateCol) {
      if (privateContests.length === 0) {
        privateList.innerHTML = `<p class="muted" style="text-align:center;padding:12px 0">${escHtml(t('contestScreen.noPrivateContests'))}</p>`;
      } else {
        for (const c of privateContests) privateList.appendChild(makePickerItem(c));
      }
    }
    $('contest-create-section').classList.toggle('hidden', !canManage);
    $('private-contest-create-section').classList.toggle('hidden', !canPriv);
  }

  function renderContestListView(contests, canManage, canPriv) {
    const body = $('contest-list-body');
    body.innerHTML = '';
    document.querySelectorAll('.clt-head [data-sort]').forEach(el => {
      el.classList.remove('sort-asc', 'sort-desc');
      if (el.dataset.sort === contestSortField)
        el.classList.add(contestSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    });
    if (contests.length === 0) {
      body.innerHTML = `<div class="cl-empty">${escHtml(t('contestScreen.noMatchFilter'))}</div>`;
    } else {
      for (const c of contests) body.appendChild(makeListItem(c));
    }
    $('contest-list-create-section').classList.toggle('hidden', !canManage);
    $('contest-list-create-private-section').classList.toggle('hidden', !canPriv);
  }

  function makeListItem(c) {
    const row = document.createElement('div');
    row.className = 'cl-row' + (c.status === 'finished' ? ' finished' : '');
    const createdDate = c.created_at ? new Date(c.created_at).toLocaleDateString(localeForFmt()) : '—';
    const actDate = fmtRelTime(c.last_activity_at);
    const privateBadge = c.private ? `<span class="cl-priv-badge">${escHtml(t('contestScreen.private'))}</span>` : '';
    const isContestOwner = c.my_role === 'owner';
    const canManageAccess = hasPerm('contest.admin') || isContestOwner;
    const canEditThis = hasPerm('contests.manage') || (hasPerm('contests.manage_private') && c.private) || isContestOwner;
    const isFullManager = hasPerm('contests.manage');
    const canDuplicate = c.private
      ? (hasPerm('contests.manage') || hasPerm('contests.manage_private') || hasPerm('contests.create_private'))
      : hasPerm('contests.manage');
    const canShare = canEditThis;
    const editBtn = canEditThis
      ? `<button class="contest-edit-pill" title="${escHtml(t('contestScreen.editTitle'))}" tabindex="-1">&#128295;</button>` : '';
    const duplicateBtn = canDuplicate
      ? `<button class="contest-edit-pill contest-duplicate-pill" title="${escHtml(t('contestScreen.duplicateTitle'))}" tabindex="-1">&#128203;</button>`
      : '';
    const shareBtn = canShare
      ? `<button class="contest-edit-pill contest-share-pill" title="${escHtml(t('contestScreen.sharePillTitle'))}" tabindex="-1">&#128279;</button>`
      : '';
    const canWsjtx = hasPerm('qso.write') && c.status === 'open';
    const wsjtxBtn = canWsjtx
      ? `<button class="contest-edit-pill contest-wsjtx-pill" title="${escHtml(t('contestScreen.wsjtxPillTitle'))}" tabindex="-1">&#128225;</button>`
      : '';
    const accessBtn = canManageAccess
      ? `<button class="contest-edit-pill contest-access-pill" title="${escHtml(t('contestScreen.accessAuthorize'))}" tabindex="-1">${c.access_restricted ? '&#128274;' : '&#128275;'}</button>`
      : (c.access_restricted ? `<span class="contest-access-indicator" title="${escHtml(t('contestScreen.accessRestricted'))}">&#128274;</span>` : '');
    const statusLabel = c.status === 'open' ? t('contestScreen.statusOpen') : t('contestScreen.statusFinished');
    const needsJoinReq = (c.private || c.access_restricted) && !isContestOwner && !isFullManager;
    const joinBtn = needsJoinReq && !c.my_status
      ? `<button class="contest-join-req-btn" tabindex="-1">${escHtml(t('contestScreen.requestToJoin'))}</button>`
      : (needsJoinReq && c.my_status === 'pending'
        ? `<span class="participant-status-pill pending">${escHtml(t('contestScreen.participantPending'))}</span>`
        : '');
    row.innerHTML = `
      <div class="cl-col cl-name">${escHtml(c.name)}${privateBadge}</div>
      <div class="cl-col cl-call">${escHtml(fmtCall(c.station_call))}</div>
      <div class="cl-col cl-status"><span class="contest-picker-status ${c.status}">${escHtml(statusLabel)}</span></div>
      <div class="cl-col cl-date">${createdDate}</div>
      <div class="cl-col cl-activity">${actDate}</div>
      <div class="cl-col cl-actions">${joinBtn}${accessBtn}${wsjtxBtn}${shareBtn}${duplicateBtn}${editBtn}</div>
    `;
    if (canEditThis) {
      row.querySelector('.contest-edit-pill:not(.contest-access-pill):not(.contest-duplicate-pill):not(.contest-share-pill):not(.contest-wsjtx-pill)')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        contestEditModal(c);
      });
    }
    if (canDuplicate) {
      row.querySelector('.contest-duplicate-pill')?.addEventListener('click', (e) => {
        e.stopPropagation();
        contestDuplicateModal(c);
      });
    }
    if (canShare) {
      row.querySelector('.contest-share-pill')?.addEventListener('click', (e) => {
        e.stopPropagation();
        contestShareModal(c);
      });
    }
    if (canWsjtx) {
      row.querySelector('.contest-wsjtx-pill')?.addEventListener('click', (e) => {
        e.stopPropagation();
        contestWsjtxTokenModal(c);
      });
    }
    if (canManageAccess) {
      row.querySelector('.contest-access-pill')?.addEventListener('click', (e) => {
        e.stopPropagation();
        contestAccessModal(c);
      });
    }
    row.querySelector('.contest-join-req-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      const r = await api('/api/contests/' + c.id + '/participants', { method: 'POST' });
      if (r.ok) {
        c.my_status = 'pending';
        btn.outerHTML = `<span class="participant-status-pill pending">${escHtml(t('contestScreen.participantPending'))}</span>`;
        refreshContests();
      } else {
        btn.disabled = false;
        alert(t('contestScreen.participantRequestFail'));
      }
    });
    row.addEventListener('click', () => selectContest(c));
    return row;
  }

  // ----- enter main app after contest selected -----
  async function enterApp() {
    show('app');
    // Always land on the Logging tab regardless of previous state
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab[data-tab="log"]').classList.add('active');
    document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
    $('tab-log').classList.add('active');
    updateContestDisplay();
    updateFreqLabel();
    updateQTimeLabel();
    applyContestReadonly();
    clearChat();
    qsos = [];
    stashes = [];
    editingQsoId = null;
    const [qres, ores, rres] = await Promise.all([
      api('/api/qsos'), api('/api/operators'), api('/api/rigs')
    ]);
    if (qres.ok) qsos = await qres.json();
    if (ores.ok) operators = await ores.json();
    if (rres.ok) rigs = await rres.json();
    applyDefaults();
    renderQsos();
    renderOperators();
    renderRigSelect();
    renderRigList();
    applySelectedRigToForm();
    // seed the per-rig freq cache so a fresh contest enter doesn't fire a stash on the next WS update
    lastRigFreqs = {};
    for (const r of rigs) {
      if (r && r.connected) lastRigFreqs[r.name] = r.freq_hz;
    }
    loadStashes();
    clearLeftPanel();
    renderBandPills();
    renderObjective();
    renderCustomFields();
    // Refresh cluster band/mode dropdowns so they reflect the newly selected contest's
    // bands instead of retaining stale options from the previous contest.
    updateClusterFilters();
    // Snap q-band to a valid contest band when the global default isn't available here.
    const cBands = contestBands();
    if (cBands.length) {
      const bandSel = $('q-band');
      if (bandSel && !cBands.includes(bandSel.value)) bandSel.value = cBands[0];
    }
    // Initialize Leaflet after the container is visible and laid out
    requestAnimationFrame(() => {
      initLeafletMap();
      if (leafletMap) leafletMap.invalidateSize();
      updateMap();
    });
    // Always reconnect so the server re-sends chat history for the current contest.
    if (ws) { ws.onclose = null; ws.onerror = null; try { ws.close(); } catch {} ws = null; }
    connectWS();
    $('q-call').focus();
    // Activate solo-panel mode last so it can hide chrome and reparent
    // the target panel without racing the tab/panel setup above.
    _applySoloPanelMode();
  }

  // If the URL carries ?solo-panel=<key>, hide the app chrome and every
  // other panel and let the requested panel fill the viewport.  Used by
  // the noctalum-desktop wrapper: when the operator pops out a panel it
  // spawns a fresh wrapper process pointed at this URL, which then
  // renders only that panel — the closest we can get to the browser
  // pop-out UX now that DOM adoption can't cross a webview-process
  // boundary.  Also works in a regular browser tab (it's plain URL
  // routing) if someone wants a bookmark-sized panel view.
  function _applySoloPanelMode() {
    const key = new URLSearchParams(window.location.search).get('solo-panel');
    if (!key) return;
    const info = _undockConfig(key);
    if (!info) return;
    const activate = () => {
      const node = document.querySelector(info.selector);
      if (!node) { setTimeout(activate, 50); return; }
      document.title = t(info.titleKey);
      document.body.classList.add('noctalum-undocked-window');
      document.body.classList.add('noctalum-solo-panel');
      if (node.parentNode !== document.body) {
        document.body.insertBefore(node, document.body.firstChild);
      }
      Array.from(document.body.children).forEach(child => {
        if (child !== node) child.style.display = 'none';
      });
    };
    activate();
  }

  function getCurrentContestForEdit() {
    if (!me?.contest_id) return null;
    const fromList = (allContests || []).find(c => c.id === me.contest_id);
    if (fromList) return fromList;
    const bands = me.contest_bands ? me.contest_bands.split(',').filter(Boolean) : [];
    const isOwner = me.contest_owner_user_id && me.contest_owner_user_id === me.user_id;
    return {
      id: me.contest_id,
      name: me.contest_name || '',
      station_call: me.contest_call || '',
      station_id: me.contest_station_id || '',
      qth: me.contest_qth || '',
      status: me.contest_status || 'open',
      bands,
      objective: me.contest_objective || '',
      custom_fields: me.contest_fields || '',
      qso_layout: me.contest_qso_layout || '',
      log_columns: me.contest_log_columns || '',
      private: me.contest_private || false,
      owner_user_id: me.contest_owner_user_id || 0,
      access_restricted: false,
      my_role: isOwner ? 'owner' : '',
      my_status: isOwner ? 'active' : '',
    };
  }

  function updateContestDisplay() {
    const call = me?.contest_call || '—';
    const name = me?.contest_name || '';
    const stationID = me?.contest_station_id || '';
    $('station-call').textContent = fmtCall(call);
    const sidEl = $('station-id');
    const sidPill = $('station-id-pill');
    if (sidEl) {
      if (stationID) {
        sidEl.textContent = '#' + stationID;
        if (sidPill) sidPill.classList.remove('hidden');
      } else {
        sidEl.textContent = '';
        if (sidPill) sidPill.classList.add('hidden');
      }
    }
    $('station-contest-name').textContent = name;
    $('ops-station-call').textContent = fmtCall(call);
  }

  function applyContestReadonly() {
    const isOpen = contestIsOpen();
    const banner = $('contest-readonly-banner');
    banner.classList.toggle('hidden', isOpen || !me?.contest_id);
    const form = $('qso-form');
    Array.from(form.elements).forEach(el => { el.disabled = !isOpen; });
    $('log-qso-btn').disabled = !isOpen;
    renderQsos();
  }
  // Reopen the active contest for editing from inside its log view (FR #62).
  // Admin-only — the perm-required attribute on the button hides it for
  // operators without contests.manage. The PUT mirrors the toggle in
  // contestAction(): UpdateContest validates the whole record, so we
  // fetch the existing row and resubmit it with status='open'.
  $('contest-reopen-btn')?.addEventListener('click', async () => {
    if (!me?.contest_id) return;
    if (!await showConfirm(t('topbar.reopenConfirm'), { ok: t('topbar.reopenButton'), safe: true })) return;
    const gr = await api('/api/contests/' + me.contest_id);
    if (!gr.ok) return;
    const c = await gr.json();
    const r = await api('/api/contests/' + me.contest_id, {
      method: 'PUT',
      body: JSON.stringify({
        name: c.name,
        station_call: c.station_call,
        station_id: c.station_id || '',
        qth: c.qth || '',
        status: 'open',
        bands: c.bands || [],
        objective: c.objective || '',
        custom_fields: c.custom_fields || '',
        qso_layout: c.qso_layout || '',
        log_columns: c.log_columns || '',
        nr_padded: c.nr_padded !== false,
        stash_expiry_minutes: c.stash_expiry_minutes || 0,
        freq_unit: c.freq_unit || 'kHz',
      }),
    });
    if (!r.ok) return;
    // The WS contest_updated event will flip me.contest_status and
    // re-run applyContestReadonly(); no local state mutation needed.
  });

  // ----- tabs -----
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
      tab.classList.add('active');
      $('tab-' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'log') {
        $('q-call').focus();
        requestAnimationFrame(() => { if (leafletMap) leafletMap.invalidateSize(); });
      }
      if (tab.dataset.tab === 'settings') { loadPasskeys(); }
      if (tab.dataset.tab === 'statistics') renderStatistics();
      if (tab.dataset.tab === 'map') renderContestMap();
      if (tab.dataset.tab === 'export') renderExportColumns();
    });
  });

  // ----- map 2D / 3D sub-tabs -----
  document.querySelectorAll('.cmap-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.subtab === contestMapActiveSubTab) return;
      document.querySelectorAll('.cmap-subtab').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      contestMapActiveSubTab = btn.dataset.subtab;
      hideCmapQsoTip();
      if (contestMapActiveSubTab === '3d') {
        $('contest-map-canvas').style.display = 'none';
        const canvas3d = $('contest-globe-canvas');
        canvas3d.classList.add('active');
        initContestGlobe();
        requestAnimationFrame(() => { resizeGlobeCanvas(); renderContestGlobe(); });
      } else {
        $('contest-globe-canvas').classList.remove('active');
        $('contest-map-canvas').style.display = '';
        if (contestMap) requestAnimationFrame(() => contestMap.invalidateSize());
      }
    });
  });

  // ----- export column picker (PDF) -----
  function getExportColumnDefs() {
    const customFields = parseCustomFields(me?.contest_fields);
    return getEffectiveLogCols(me?.contest_log_columns, customFields);
  }
  const EXPORT_COL_KEY_MAP = {
    'nr_sent':       'export.colNr',
    'time':          'export.colTime',
    'callsign':      'export.colCall',
    'band':          'export.colBand',
    'freq':          'export.colFreq',
    'mode':          'export.colMode',
    'rst_sent':      'export.colRstSent',
    'rst_received':  'export.colRstRcvd',
    'nr_received':   'export.colNrRcvd',
    'name':          'export.colName',
    'locator':       'export.colLoc',
    'itu':           'export.colItuCQ',
    'dok':           'export.colDok',
    'lighthouse':    'export.colLighthouse',
    'notes':         'export.colNotes',
    'operator':      'export.colOperator',
  };
  function exportColLabel(col) {
    if (col.isCustom) return col.label || col.key;
    const ek = EXPORT_COL_KEY_MAP[col.key];
    if (ek) {
      const suffix = col.key === 'freq' ? ' (' + contestFreqUnit() + ')' : '';
      return t(ek) + suffix;
    }
    if (col.key === 'freq') return t('qso.colFreq') + ' (' + contestFreqUnit() + ')';
    return col.labelKey ? t(col.labelKey) : col.key;
  }
  function renderExportColumns() {
    const host = $('export-cols');
    if (!host) return;
    const cols = getExportColumnDefs();
    if (!cols.length) { host.innerHTML = ''; updateExportPdfHref(); return; }
    host.innerHTML = `
      <div class="export-cols-hint muted small" data-i18n="export.colsHint">Columns (in the order they will appear in the PDF):</div>
      <div class="export-cols-sortable" id="export-cols-sortable">
        ${cols.map(c => `
          <div class="export-col-item" draggable="true" data-col-key="${escHtml(c.key)}">
            <span class="export-col-handle" aria-hidden="true">&#8942;&#8942;</span>
            <label class="export-col-label">
              <input type="checkbox"${c.on !== false ? ' checked' : ''}>
              <span>${escHtml(exportColLabel(c))}</span>
            </label>
          </div>`).join('')}
      </div>
      <div class="export-cols-actions">
        <button type="button" class="ghost" id="export-cols-all" data-i18n="export.selectAll">Select all</button>
        <button type="button" class="ghost" id="export-cols-none" data-i18n="export.selectNone">Select none</button>
        <button type="button" class="ghost" id="export-cols-reset" data-i18n="export.resetDefault">Reset to defaults</button>
      </div>
    `;
    applyI18n(host);

    const sortable = $('export-cols-sortable');
    let dragSrcItem = null;

    sortable.querySelectorAll('.export-col-item').forEach(item => {
      item.addEventListener('dragstart', e => {
        dragSrcItem = item;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        sortable.querySelectorAll('.export-col-item').forEach(x => x.classList.remove('drag-over'));
        dragSrcItem = null;
        updateExportPdfHref();
      });
      item.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!dragSrcItem || dragSrcItem === item) return;
        const rect = item.getBoundingClientRect();
        sortable.querySelectorAll('.export-col-item').forEach(x => x.classList.remove('drag-over'));
        item.classList.add('drag-over');
        if (e.clientY < rect.top + rect.height / 2) {
          sortable.insertBefore(dragSrcItem, item);
        } else {
          sortable.insertBefore(dragSrcItem, item.nextSibling);
        }
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.querySelector('input[type="checkbox"]').addEventListener('change', updateExportPdfHref);
    });

    $('export-cols-all').addEventListener('click', () => {
      sortable.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
      updateExportPdfHref();
    });
    $('export-cols-none').addEventListener('click', () => {
      sortable.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
      updateExportPdfHref();
    });
    $('export-cols-reset').addEventListener('click', renderExportColumns);
    updateExportPdfHref();
    setupExportPdfMapBtn();
  }
  function updateExportPdfHref() {
    const btn = $('export-pdf-btn');
    if (!btn) return;
    const sortable = $('export-cols-sortable');
    const keys = [];
    if (sortable) {
      sortable.querySelectorAll('.export-col-item[data-col-key]').forEach(item => {
        const cb = item.querySelector('input[type="checkbox"]');
        if (cb?.checked) keys.push(item.dataset.colKey);
      });
    }
    btn.href = '/api/export/pdf' + (keys.length ? '?cols=' + encodeURIComponent(keys.join(',')) : '');
  }

  // Renders the contest map to an offscreen canvas using a temporary Leaflet
  // map with the same CartoDB dark tiles and vector styles as the map page.
  // Returns a Promise that resolves to a canvas (or null if no locator data).
  function renderPdfMapCanvas() {
    if (typeof L === 'undefined') return Promise.resolve(null);

    const W = 1400, H = 875, MAP_H = 800, LEGEND_H = H - MAP_H;

    const myLocStr = me?.contest_qth || null;
    const myPos = myLocStr ? locatorToLatLon(myLocStr) : null;
    const qsosWithLoc = (qsos || []).filter(q => q.locator && q.locator.length >= 4);

    const allLatLngs = [];
    if (myPos) allLatLngs.push([myPos.lat, myPos.lon]);
    for (const q of qsosWithLoc) {
      const p = locatorToLatLon(q.locator);
      if (p) allLatLngs.push([p.lat, p.lon]);
    }
    if (!allLatLngs.length) return Promise.resolve(null);

    return new Promise((resolve) => {
      // Off-screen container: position:fixed far left so Leaflet can measure
      // the element size while remaining invisible to the user.
      const wrapper = document.createElement('div');
      wrapper.style.cssText = `position:fixed;left:-${W + 20}px;top:0;width:${W}px;height:${MAP_H}px`;
      document.body.appendChild(wrapper);

      // Use L.canvas() so all vector layers land in a single <canvas> that we
      // can read back without SVG-serialisation complexity.
      const canvasRenderer = L.canvas({ padding: 0 });
      const tmpMap = L.map(wrapper, {
        zoomControl: false,
        attributionControl: false,
        renderer: canvasRenderer,
      });

      // crossOrigin:'anonymous' is required so we can call drawImage() on the
      // tile <img> elements without tainting the output canvas. Use CartoDB's
      // "light_nolabels" basemap: the light_* family already gives a white
      // background with thin grey country/coastline ink, and the _nolabels
      // variant drops the place-name labels that account for the bulk of the
      // dark pixels on a printed log page. The result is a clean outline map
      // that still shows continents and country borders but does not bleed
      // toner across every populated area like light_all did.
      const tl = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 18,
        crossOrigin: 'anonymous',
      }).addTo(tmpMap);

      // Great-circle paths (drawn first so markers sit on top).
      if (myPos) {
        for (const q of qsosWithLoc) {
          const pos = locatorToLatLon(q.locator);
          if (!pos) continue;
          const col = bandColor(q.band);
          const gcPts = greatCirclePoints(myPos.lat, myPos.lon, pos.lat, pos.lon, 60);
          for (const seg of splitAtAntimeridian(gcPts)) {
            L.polyline(seg, { color: col, weight: 1.5, opacity: 0.55, dashArray: '5 5' }).addTo(tmpMap);
          }
        }
      }

      // QSO markers and own-QTH are NOT added to the Leaflet map here; they are
      // drawn directly on the output canvas after compositing so that grouping
      // and pie rendering work independently of the tile/vector pipeline.

      tmpMap.fitBounds(L.latLngBounds(allLatLngs).pad(0.1), { maxZoom: 10 });

      function capture() {
        const outCanvas = document.createElement('canvas');
        outCanvas.width = W; outCanvas.height = H;
        const ctx = outCanvas.getContext('2d');

        // White fallback background (visible if tiles fail) — matches the
        // light_all tile theme so the printed page stays clean even when the
        // tile fetch is offline or blocked.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, MAP_H);

        const mapRect = wrapper.getBoundingClientRect();

        // Clip drawing to the map area so partially-visible edge tiles don't
        // bleed into the legend strip.
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, W, MAP_H); ctx.clip();

        // Draw tile images.  getBoundingClientRect() accounts for all CSS
        // transforms Leaflet applies to the tile container, giving us the
        // correct on-canvas position for each tile.
        wrapper.querySelectorAll('img.leaflet-tile-loaded').forEach(img => {
          try {
            const r = img.getBoundingClientRect();
            ctx.drawImage(img,
              Math.round(r.left - mapRect.left), Math.round(r.top - mapRect.top),
              Math.round(r.width), Math.round(r.height));
          } catch (_) { /* skip any tile that couldn't be read (rare CORS edge case) */ }
        });

        // Draw vector canvas (paths + markers rendered by L.canvas()).
        // Leaflet sizes the renderer's backing store to size×devicePixelRatio
        // for hi-DPI crispness, so drawImage() without explicit dimensions
        // would paste the vector layer at 2–3× scale on phones and shift the
        // propagation lines off the actual QSO positions. Use the CSS-pixel
        // bounding rect (same approach as the tile <img>s above) so drawImage
        // scales the physical backing store back down to logical map space.
        const vecCanvas = canvasRenderer._container;
        if (vecCanvas) {
          try {
            const vr = vecCanvas.getBoundingClientRect();
            ctx.drawImage(vecCanvas,
              Math.round(vr.left - mapRect.left), Math.round(vr.top - mapRect.top),
              Math.round(vr.width), Math.round(vr.height));
          } catch (_) {}
        }

        ctx.restore();

        // Draw QSO dots as grouped pie markers, clipped to the map area.
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, W, MAP_H); ctx.clip();
        const _pdfGrp = new Map();
        for (const q of qsosWithLoc) {
          const pos = locatorToLatLon(q.locator);
          if (!pos) continue;
          const key = q.locator.toUpperCase().slice(0, 6);
          if (!_pdfGrp.has(key)) _pdfGrp.set(key, { pos, colors: [] });
          const grp = _pdfGrp.get(key);
          const col = bandColor(q.band);
          if (!grp.colors.includes(col)) grp.colors.push(col);
        }
        for (const { pos, colors } of _pdfGrp.values()) {
          const pt = tmpMap.latLngToContainerPoint([pos.lat, pos.lon]);
          _drawPie(ctx, pt.x, pt.y, 5, colors);
        }
        // Own QTH on top — darker green + dark outline so it stays prominent
        // against the light tile basemap.
        if (myPos) {
          const pt = tmpMap.latLngToContainerPoint([myPos.lat, myPos.lon]);
          ctx.fillStyle = '#2e7d32'; ctx.strokeStyle = '#222'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        ctx.restore();

        // Legend strip — white to match the light map theme so the swatch
        // colours and labels read correctly when printed.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, MAP_H, W, LEGEND_H);
        ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(0, MAP_H); ctx.lineTo(W, MAP_H); ctx.stroke();

        const bandsInUse = [...new Set(qsosWithLoc.map(q => q.band).filter(Boolean))]
          .sort((a, b) => BANDS.indexOf(a) - BANDS.indexOf(b));
        const LY = MAP_H + 52;
        let lx = 22;
        ctx.font = 'bold 13px sans-serif'; ctx.fillStyle = '#333';
        ctx.fillText(t('map.legend') + ':', lx, MAP_H + 22);
        if (myPos) {
          // QTH marker keeps a dark outline on light bg so the dot stays visible.
          ctx.fillStyle = '#2e7d32'; ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(lx + 6, LY - 4, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#222'; ctx.font = '13px sans-serif';
          const qthLbl = t('map.myQTH');
          ctx.fillText(qthLbl, lx + 16, LY); lx += 16 + Math.ceil(ctx.measureText(qthLbl).width) + 20;
        }
        for (const b of bandsInUse) {
          ctx.fillStyle = bandColor(b); ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.arc(lx + 6, LY - 4, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#222'; ctx.font = '13px sans-serif';
          const bLbl = fmtBand(b);
          ctx.fillText(bLbl, lx + 16, LY); lx += 16 + Math.ceil(ctx.measureText(bLbl).width) + 18;
        }

        tmpMap.remove();
        document.body.removeChild(wrapper);
        resolve(outCanvas);
      }

      // Wait for all visible tiles to load, then allow two animation frames for
      // the canvas renderer to finish painting before capturing.
      let tilesReady = false;
      tl.on('load', () => { tilesReady = true; });

      const deadline = Date.now() + 8000;
      function checkReady() {
        if (tilesReady || Date.now() > deadline) {
          requestAnimationFrame(() => requestAnimationFrame(capture));
        } else {
          setTimeout(checkReady, 150);
        }
      }
      // Small initial delay so Leaflet has time to lay out the map and start
      // loading tiles before we begin polling.
      setTimeout(checkReady, 250);
    });
  }

  function setupExportPdfMapBtn() {
    const btn = $('export-pdf-btn');
    if (!btn || btn.dataset.mapHandlerBound) return;
    btn.dataset.mapHandlerBound = '1';
    btn.addEventListener('click', async (e) => {
      const mapCb = $('export-include-map');
      if (!mapCb || !mapCb.checked) return;
      e.preventDefault();

      btn.classList.add('loading');
      try {
        const canvas = await renderPdfMapCanvas();
        const sortable = $('export-cols-sortable');
        const keys = [];
        if (sortable) {
          sortable.querySelectorAll('.export-col-item[data-col-key]').forEach(item => {
            const cb = item.querySelector('input[type="checkbox"]');
            if (cb?.checked) keys.push(item.dataset.colKey);
          });
        }
        const colsParam = keys.length ? '?cols=' + encodeURIComponent(keys.join(',')) : '';
        const body = canvas ? { mapImage: canvas.toDataURL('image/png').split(',')[1] } : {};
        const resp = await fetch('/api/export/pdf' + colsParam, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        if (!resp.ok) return;
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const cd = resp.headers.get('Content-Disposition');
        const fnMatch = cd && cd.match(/filename="([^"]+)"/);
        a.download = fnMatch ? fnMatch[1] : 'export.pdf';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('PDF map export error', err);
      } finally {
        btn.classList.remove('loading');
      }
    });
  }

  // ----- statistics -----
  function _statsEscape(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function _statsSvgBars(items, color) {
    if (!items.length) return '<div class="muted small">' + escHtml(t('stats.noDataShort')) + '</div>';
    const max = Math.max(...items.map(i => i.value)) || 1;
    const total = items.reduce((s, i) => s + i.value, 0) || 1;
    const rowH = 18, gap = 4, padL = 90, padR = 78;
    const w = 320, h = items.length * (rowH + gap) + 8;
    let svg = `<svg class="stats-svg" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;
    items.forEach((it, i) => {
      const y = 4 + i * (rowH + gap);
      const bw = Math.max(1, Math.round((w - padL - padR) * (it.value / max)));
      const label = String(it.label).slice(0, 12);
      const pct = ((it.value / total) * 100).toFixed(1);
      svg += `<text x="${padL - 4}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="11" fill="currentColor">${_statsEscape(label)}</text>`;
      svg += `<rect x="${padL}" y="${y}" width="${bw}" height="${rowH}" fill="${color}" rx="2"/>`;
      svg += `<text x="${padL + bw + 4}" y="${y + rowH / 2 + 4}" font-size="11" fill="currentColor">${it.value} (${pct}%)</text>`;
    });
    svg += '</svg>';
    return svg;
  }
  function _statsSvgPie(items, palette) {
    if (!items.length) return '<div class="muted small">' + escHtml(t('stats.noDataShort')) + '</div>';
    const total = items.reduce((s, i) => s + i.value, 0) || 1;
    const cx = 80, cy = 80, r = 70;
    let a0 = -Math.PI / 2;
    let svg = `<svg class="stats-svg" viewBox="0 0 320 170" xmlns="http://www.w3.org/2000/svg">`;
    items.forEach((it, i) => {
      const frac = it.value / total;
      const a1 = a0 + frac * Math.PI * 2;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const large = frac > 0.5 ? 1 : 0;
      const color = palette[i % palette.length];
      if (items.length === 1) {
        svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;
      } else {
        svg += `<path d="M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" fill="${color}"/>`;
      }
      a0 = a1;
    });
    items.forEach((it, i) => {
      const ly = 14 + i * 14;
      const color = palette[i % palette.length];
      svg += `<rect x="170" y="${ly - 9}" width="10" height="10" fill="${color}"/>`;
      const pct = ((it.value / total) * 100).toFixed(1);
      svg += `<text x="186" y="${ly}" font-size="11" fill="currentColor">${_statsEscape(it.label)} · ${it.value} (${pct}%)</text>`;
    });
    svg += '</svg>';
    return svg;
  }
  function _statsTally(arr, key) {
    const m = new Map();
    for (const q of arr) {
      const v = (q[key] || '').toString().trim() || '—';
      m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }
  function _statsByHour(arr) {
    const m = new Map();
    for (const q of arr) {
      const d = new Date(q.time_utc || q.time || 0);
      if (isNaN(d.getTime())) continue;
      const hh = String(d.getUTCHours()).padStart(2, '0');
      m.set(hh, (m.get(hh) || 0) + 1);
    }
    return [...m.entries()].map(([label, value]) => ({ label: label + 'Z', value }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  function _statsByCountry(arr) {
    const m = new Map();
    for (const q of arr) {
      const call = (q.callsign || '').toUpperCase();
      const dx = (typeof callsignToInfo === 'function') ? callsignToInfo(call) : null;
      const label = (dx && dx.country) ? dx.country : '—';
      m.set(label, (m.get(label) || 0) + 1);
    }
    return [...m.entries()].map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }
  function renderStatistics() {
    const grid = $('stats-grid');
    const sum = $('stats-summary');
    if (!grid) return;
    if (!qsos.length) {
      sum.textContent = '';
      grid.innerHTML = '<div class="muted small">' + escHtml(t('stats.noData')) + '</div>';
      return;
    }
    const total = qsos.length;
    const uniqueCalls = new Set(qsos.map(q => (q.callsign || '').toUpperCase())).size;
    sum.textContent = t('stats.summary', { total, uniq: uniqueCalls });
    const palette = ['#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'];
    const bands = _statsTally(qsos, 'band').map(it => ({ ...it, label: fmtBand(it.label) }));
    const modes = _statsTally(qsos, 'mode');
    const hours = _statsByHour(qsos);
    const countries = _statsByCountry(qsos).slice(0, 12);
    const ops = _statsTally(qsos, 'operator').map(it => ({ ...it, label: it.label === '—' ? it.label : it.label.toUpperCase() })).slice(0, 12);
    const card = (title, body) =>
      `<div class="stats-card"><h3>${escHtml(title)}</h3>${body}</div>`;
    grid.innerHTML =
      card(t('stats.qsoPerBand'), _statsSvgBars(bands, '#4e79a7')) +
      card(t('stats.qsoPerMode'), _statsSvgPie(modes, palette)) +
      card(t('stats.qsoPerHourUTC'), _statsSvgBars(hours, '#59a14f')) +
      card(t('stats.topCountries'), _statsSvgBars(countries, '#f28e2c')) +
      card(t('stats.qsoPerOperator'), _statsSvgBars(ops, '#af7aa1'));
  }

  // ----- Contest map tab -----
  function initContestMap() {
    if (contestMap || typeof L === 'undefined') return;
    const el = $('contest-map-canvas');
    if (!el) return;
    try {
      contestMap = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: true })
        .setView([20, 10], 2);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/">OSM</a> © <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 18,
      }).addTo(contestMap);
    } catch (e) { contestMap = null; }
  }

  function applyContestMapFilters() {
    if (!contestMapState) return;
    if (contestMapActiveSubTab === '3d') {
      renderContestGlobe();
      return;
    }
    if (!contestMap) return;
    for (const { entries, marker } of contestMapItems) {
      const activeCols = _uniqueColors(entries.filter(e => contestMapState.enabledBands.has(e.band)));
      if (activeCols.length === 0) {
        if (marker && contestMap.hasLayer(marker)) marker.remove();
      } else {
        if (marker) {
          marker.setIcon(_pieDivIcon(activeCols, 5));
          if (!contestMap.hasLayer(marker)) marker.addTo(contestMap);
        }
      }
      for (const e of entries) {
        const on = contestMapState.enabledBands.has(e.band);
        for (const line of e.paths) {
          if (on && contestMapState.showPaths) { if (!contestMap.hasLayer(line)) line.addTo(contestMap); }
          else                                 { if (contestMap.hasLayer(line))  line.remove(); }
        }
      }
    }
  }

  function buildQsoPopupHTML(q) {
    const time = q.time ? new Date(q.time).toISOString().substring(0, 16).replace('T', ' ') + ' UTC' : '';
    const bandMode = [fmtBand(q.band), q.mode].filter(Boolean).join(' · ');
    const rstPair = (q.rst_sent || q.rst_received) ? `${q.rst_sent || '—'} / ${q.rst_received || '—'}` : '';
    const rows = [
      q.callsign ? `<strong>${escHtml(q.callsign)}</strong>` : '',
      time       ? `<span class="cmap-tip-row">${escHtml(time)}</span>` : '',
      bandMode   ? `<span class="cmap-tip-row">${escHtml(bandMode)}</span>` : '',
      rstPair    ? `<span class="cmap-tip-row">${escHtml(rstPair)}</span>` : '',
      q.locator  ? `<span class="cmap-tip-row">${escHtml(q.locator)}</span>` : '',
      q.name     ? `<span class="cmap-tip-row">${escHtml(q.name)}</span>` : '',
      q.dok      ? `<span class="cmap-tip-row">DOK ${escHtml(q.dok)}</span>` : '',
      q.operator ? `<span class="cmap-tip-row">${escHtml(t('qso.colOp'))}: ${escHtml(q.operator)}</span>` : '',
    ].filter(Boolean).join('');
    return `<div class="cmap-qso-popup">${rows}</div>`;
  }

  function showCmapQsoTip(clientX, clientY, q, isQth) {
    const tip = $('cmap-qso-tip');
    if (!tip) return;
    if (isQth) {
      tip.innerHTML = `<strong>${escHtml(t('map.myQTH'))}</strong>` +
        (me?.contest_call ? `<span class="cmap-tip-row">${escHtml(me.contest_call)}</span>` : '') +
        (me?.contest_qth  ? `<span class="cmap-tip-row">${escHtml(me.contest_qth)}</span>` : '');
    } else if (q) {
      tip.innerHTML = buildQsoPopupHTML(q).replace(/^<div[^>]*>|<\/div>$/g, '');
    }
    tip.classList.remove('hidden');
    const vw = window.innerWidth, vh = window.innerHeight;
    const tW = tip.offsetWidth || 160, tH = tip.offsetHeight || 80;
    let tx = clientX + 14, ty = clientY + 14;
    if (tx + tW > vw - 8) tx = clientX - tW - 14;
    if (ty + tH > vh - 8) ty = clientY - tH - 14;
    tip.style.left = Math.max(8, tx) + 'px';
    tip.style.top  = Math.max(8, ty) + 'px';
  }

  function hideCmapQsoTip() {
    const tip = $('cmap-qso-tip');
    if (tip) tip.classList.add('hidden');
  }

  function renderContestMap() {
    initContestMap();

    // Clear previous 2D layers
    if (contestMapQthMarker) { contestMapQthMarker.remove(); contestMapQthMarker = null; }
    contestMapItems.forEach(({ marker, entries }) => {
      if (marker) marker.remove();
      entries.forEach(e => e.paths.forEach(p => p.remove()));
    });
    contestMapItems = [];

    const myLocStr = me?.contest_qth || null;
    const myPos    = myLocStr ? locatorToLatLon(myLocStr) : null;
    const qsosWithLoc = qsos.filter(q => q.locator && q.locator.length >= 4);

    const bandsInUse = [...new Set(qsosWithLoc.map(q => q.band).filter(Boolean))]
      .sort((a, b) => BANDS.indexOf(a) - BANDS.indexOf(b));

    // Initialise filter state; reset when the contest changes
    if (!contestMapState || contestMapState.contestId !== me?.contest_id) {
      contestMapState = {
        enabledBands: new Set(bandsInUse),
        knownBands:   new Set(bandsInUse),
        showPaths:    true,
        contestId:    me?.contest_id,
      };
    } else {
      for (const b of bandsInUse) {
        if (!contestMapState.knownBands.has(b)) {
          contestMapState.enabledBands.add(b);
          contestMapState.knownBands.add(b);
        }
      }
    }

    // ----- Legend -----
    const legend = $('contest-map-legend');
    let html = `<h3>${escHtml(t('map.legend'))}</h3>`;
    if (myPos) {
      html += `<div class="cmap-legend-item"><span class="cmap-dot" style="background:#66bb6a;border-color:#fff"></span>${escHtml(t('map.myQTH'))}</div>`;
    } else {
      html += `<p class="muted small" style="margin:0 0 6px">${escHtml(t('map.noQTH'))}</p>`;
    }
    html += `<div class="cmap-legend-sep"></div>
      <label class="cmap-toggle">
        <input type="checkbox" id="cmap-show-paths" ${contestMapState.showPaths ? 'checked' : ''}>
        <span>${escHtml(t('map.showPaths'))}</span>
      </label>`;
    if (bandsInUse.length) {
      html += `<div class="cmap-legend-sep"></div>`;
      for (const b of bandsInUse) {
        const col = bandColor(b);
        const chk = contestMapState.enabledBands.has(b) ? 'checked' : '';
        html += `<label class="cmap-toggle cmap-band-toggle" data-band="${escHtml(b)}">
          <input type="checkbox" ${chk}>
          <span class="cmap-dot" style="background:${col}"></span>
          <span>${escHtml(fmtBand(b))}</span>
        </label>`;
      }
    }
    if (!qsosWithLoc.length) {
      html += `<p class="muted small" style="margin-top:10px">${escHtml(t('map.noData'))}</p>`;
    }
    legend.innerHTML = html;

    $('cmap-show-paths').addEventListener('change', e => {
      contestMapState.showPaths = e.target.checked;
      applyContestMapFilters();
    });
    legend.querySelectorAll('.cmap-band-toggle').forEach(lbl => {
      lbl.querySelector('input').addEventListener('change', e => {
        const b = lbl.dataset.band;
        if (e.target.checked) contestMapState.enabledBands.add(b);
        else contestMapState.enabledBands.delete(b);
        applyContestMapFilters();
      });
    });

    // ----- Build 3D globe data -----
    contestGlobeQsoItems  = [];
    contestGlobeGcPaths   = [];
    contestGlobeQthLat    = myPos ? myPos.lat : null;
    contestGlobeQthLon    = myPos ? myPos.lon : null;
    contestGlobeQthLabel  = t('map.myQTH') +
      (me?.contest_call ? ' · ' + me.contest_call : '') +
      (myLocStr          ? ' · ' + myLocStr        : '');

    // Center globe on own QTH if first render
    if (myPos && contestGlobeCenterLat === 20 && contestGlobeCenterLon === 10) {
      contestGlobeCenterLat = myPos.lat;
      contestGlobeCenterLon = myPos.lon;
    }

    // ----- Own QTH marker (2D) -----
    if (myPos && contestMap) {
      const tip = t('map.myQTH') + (me?.contest_call ? ` · ${me.contest_call}` : '') + (myLocStr ? ` · ${myLocStr}` : '');
      contestMapQthMarker = L.circleMarker([myPos.lat, myPos.lon], {
        radius: 8, fillColor: '#66bb6a', color: '#fff', weight: 2, fillOpacity: 1,
      }).bindTooltip(tip).addTo(contestMap);
    }

    // ----- QSO layers -----
    // Paths and 3D data are kept per-QSO; dots are grouped by locator so that
    // multiple QSOs at the same grid square render as a single pie-chart marker.
    const _locGrp = new Map(); // locKey → { pos, entries:[{q,band,color,paths}] }

    for (const q of qsosWithLoc) {
      const pos = locatorToLatLon(q.locator);
      if (!pos) continue;
      const col = bandColor(q.band);
      const on  = contestMapState.enabledBands.has(q.band);

      // 3D item
      contestGlobeQsoItems.push({ q, lat: pos.lat, lon: pos.lon, color: col, band: q.band });

      // 3D great-circle path
      if (myPos) {
        const gcPts = greatCirclePoints(myPos.lat, myPos.lon, pos.lat, pos.lon, 60);
        contestGlobeGcPaths.push({ band: q.band, color: col, points: gcPts.map(p => ({ lat: p[0], lon: p[1] })) });
      }

      // 2D path (per-QSO)
      const paths = [];
      if (myPos && contestMap) {
        const gcPts = greatCirclePoints(myPos.lat, myPos.lon, pos.lat, pos.lon, 60);
        for (const seg of splitAtAntimeridian(gcPts)) {
          const line = L.polyline(seg, { color: col, weight: 1.5, opacity: 0.55, dashArray: '5 5' });
          if (on && contestMapState.showPaths) line.addTo(contestMap);
          paths.push(line);
        }
      }

      // Accumulate per-location entry for grouped pie marker
      if (contestMap) {
        const locKey = q.locator.toUpperCase().slice(0, 6);
        if (!_locGrp.has(locKey)) _locGrp.set(locKey, { pos, entries: [] });
        _locGrp.get(locKey).entries.push({ q, band: q.band, color: col, paths });
      }
    }

    // One Leaflet marker per unique location, with a pie-chart icon.
    for (const [locKey, { pos, entries }] of _locGrp) {
      const activeCols = _uniqueColors(entries.filter(e => contestMapState.enabledBands.has(e.band)));
      const allCols    = _uniqueColors(entries);
      const tip = entries.length === 1
        ? `${entries[0].q.callsign} · ${fmtBand(entries[0].q.band)}`
        : `${entries.length} QSOs · ${locKey}`;
      const popup = entries.map(e => buildQsoPopupHTML(e.q))
        .join('<hr style="margin:6px 0;border-color:rgba(255,255,255,0.1)">');
      const marker = L.marker([pos.lat, pos.lon], {
        icon: _pieDivIcon(activeCols.length ? activeCols : allCols, 5),
      }).bindTooltip(tip).bindPopup(popup, { maxWidth: 240 });
      if (activeCols.length) marker.addTo(contestMap);
      contestMapItems.push({ locKey, entries, marker });
    }

    // ----- Switch canvas visibility -----
    const canvas2d = $('contest-map-canvas');
    const canvas3d = $('contest-globe-canvas');
    if (contestMapActiveSubTab === '3d') {
      if (canvas2d) canvas2d.style.display = 'none';
      if (canvas3d) canvas3d.classList.add('active');
      initContestGlobe();
      requestAnimationFrame(() => {
        resizeGlobeCanvas();
        renderContestGlobe();
      });
    } else {
      if (canvas2d) canvas2d.style.display = '';
      if (canvas3d) canvas3d.classList.remove('active');
      if (contestMap) {
        requestAnimationFrame(() => {
          contestMap.invalidateSize();
          const pts = contestMapItems
            .filter(it => it.entries.some(e => contestMapState.enabledBands.has(e.band)))
            .map(it => it.marker);
          if (contestMapQthMarker) pts.push(contestMapQthMarker);
          if (pts.length) contestMap.fitBounds(L.featureGroup(pts).getBounds().pad(0.15), { maxZoom: 10 });
        });
      }
    }
  }

  // ----- 3D Globe -----
  function resizeGlobeCanvas() {
    const el = $('contest-globe-canvas');
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight - (el.previousElementSibling?.offsetHeight || 0);
    if (w > 0 && h > 0) { el.width = w; el.height = h; }
  }

  function initContestGlobe() {
    if (contestGlobeInitialized) return;
    const el = $('contest-globe-canvas');
    if (!el) return;
    contestGlobeInitialized = true;

    if (!contestGlobeLandData) {
      fetch('/world-countries.geojson')
        .then(r => r.json())
        .then(d => { contestGlobeLandData = d.features; renderContestGlobe(); })
        .catch(() => {});
    }
    if (!contestGlobeLabels) {
      fetch('/world-country-labels.json')
        .then(r => r.json())
        .then(d => { contestGlobeLabels = d; renderContestGlobe(); })
        .catch(() => {});
    }

    new ResizeObserver(() => {
      if (contestMapActiveSubTab === '3d') { resizeGlobeCanvas(); renderContestGlobe(); }
    }).observe(el.parentElement);

    let dragStart = null, dragLon = 0, dragLat = 0, didDrag = false;

    function onDragStart(cx, cy) {
      dragStart = { x: cx, y: cy };
      dragLon   = contestGlobeCenterLon;
      dragLat   = contestGlobeCenterLat;
      didDrag   = false;
    }
    function onDragMove(cx, cy) {
      if (!dragStart) return;
      const dx = cx - dragStart.x, dy = cy - dragStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
      const R = Math.min(el.width, el.height) * 0.45 * contestGlobeZoom;
      contestGlobeCenterLon = dragLon - (dx / R) * (180 / Math.PI) * 1.3;
      contestGlobeCenterLat = Math.max(-85, Math.min(85, dragLat + (dy / R) * (180 / Math.PI) * 1.3));
      renderContestGlobe();
    }
    function onDragEnd() { dragStart = null; }

    let pinchStartDist = 0, pinchStartZoom = 1;

    el.addEventListener('mousedown',  e => onDragStart(e.clientX, e.clientY));
    el.addEventListener('mousemove',  e => onDragMove(e.clientX, e.clientY));
    el.addEventListener('mouseup',    onDragEnd);
    el.addEventListener('mouseleave', onDragEnd);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      contestGlobeZoom = Math.max(0.5, Math.min(8, contestGlobeZoom * (e.deltaY > 0 ? 1 / 1.15 : 1.15)));
      renderContestGlobe();
    }, { passive: false });
    el.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length === 1) {
        onDragStart(e.touches[0].clientX, e.touches[0].clientY);
        pinchStartDist = 0;
      } else if (e.touches.length === 2) {
        dragStart = null;
        pinchStartDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        pinchStartZoom = contestGlobeZoom;
      }
    }, { passive: false });
    el.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1 && !pinchStartDist) {
        onDragMove(e.touches[0].clientX, e.touches[0].clientY);
      } else if (e.touches.length === 2 && pinchStartDist > 0) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        contestGlobeZoom = Math.max(0.5, Math.min(8, pinchStartZoom * dist / pinchStartDist));
        renderContestGlobe();
      }
    }, { passive: false });
    el.addEventListener('touchend', e => { if (e.touches.length === 0) { onDragEnd(); pinchStartDist = 0; } });

    el.addEventListener('click', e => {
      if (didDrag) { didDrag = false; return; }
      const rect = el.getBoundingClientRect();
      const scaleX = el.width  / (rect.width  || 1);
      const scaleY = el.height / (rect.height || 1);
      const mx = (e.clientX - rect.left) * scaleX;
      const my = (e.clientY - rect.top)  * scaleY;

      let nearest = null, nearestD2 = 12 * 12;
      for (const it of contestGlobeLastVisItems) {
        const d2 = (it.proj.sx - mx) ** 2 + (it.proj.sy - my) ** 2;
        if (d2 < nearestD2) { nearest = it; nearestD2 = d2; }
      }

      if (!nearest && contestGlobeLastQthProj?.visible) {
        const p = contestGlobeLastQthProj;
        if ((p.sx - mx) ** 2 + (p.sy - my) ** 2 < 15 * 15) {
          showCmapQsoTip(e.clientX, e.clientY, null, true);
          return;
        }
      }
      if (nearest) showCmapQsoTip(e.clientX, e.clientY, nearest.q, false);
      else hideCmapQsoTip();
    });
  }

  function _globeProject(W, H, lat, lon) {
    const R      = Math.min(W, H) * 0.45 * contestGlobeZoom;
    const cx     = W / 2, cy = H / 2;
    const phi    = lat * Math.PI / 180;
    const phi0   = contestGlobeCenterLat * Math.PI / 180;
    const dl     = (lon - contestGlobeCenterLon) * Math.PI / 180;
    const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
    const cosPhi0 = Math.cos(phi0), sinPhi0 = Math.sin(phi0);
    const cosDl = Math.cos(dl), sinDl = Math.sin(dl);
    const x = cosPhi * sinDl;
    const y = cosPhi0 * sinPhi - sinPhi0 * cosPhi * cosDl;
    const z = sinPhi0 * sinPhi + cosPhi0 * cosPhi * cosDl;
    return { sx: cx + x * R, sy: cy - y * R, visible: z > 0, z, R, cx, cy };
  }

  function renderContestGlobe() {
    const el = $('contest-globe-canvas');
    if (!el) return;
    if (el.width < 2 || el.height < 2) { resizeGlobeCanvas(); if (el.width < 2) return; }
    const ctx = el.getContext('2d');
    const W = el.width, H = el.height;
    const proj = (lat, lon) => _globeProject(W, H, lat, lon);
    const { R, cx, cy } = proj(0, 0);

    ctx.clearRect(0, 0, W, H);

    // Ocean sphere
    const grad = ctx.createRadialGradient(cx - R * 0.15, cy - R * 0.2, 0, cx, cy, R);
    grad.addColorStop(0, '#1a2a3a');
    grad.addColorStop(1, '#0a0f18');
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = grad; ctx.fill();

    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();

    // Land polygons (individual countries — fill + visible border)
    if (contestGlobeLandData) {
      ctx.fillStyle = '#2a3e28';
      ctx.strokeStyle = 'rgba(90,130,75,0.75)';
      ctx.lineWidth = 0.7;
      for (const feature of contestGlobeLandData) {
        const geom = feature.geometry;
        const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
        for (const poly of polys) {
          ctx.beginPath();
          for (const ring of poly) {
            let first = true;
            for (const [lon, lat] of ring) {
              const s = proj(lat, lon);
              if (!s.visible) { first = true; continue; }
              if (first) { ctx.moveTo(s.sx, s.sy); first = false; } else ctx.lineTo(s.sx, s.sy);
            }
            ctx.closePath();
          }
          ctx.fill('evenodd');
          ctx.stroke();
        }
      }
    }

    // Graticule
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]);
    for (let lat = -60; lat <= 60; lat += 30) {
      ctx.beginPath();
      let first = true;
      for (let lon = -180; lon <= 180; lon += 2) {
        const s = proj(lat, lon);
        if (!s.visible) { first = true; continue; }
        if (first) { ctx.moveTo(s.sx, s.sy); first = false; } else ctx.lineTo(s.sx, s.sy);
      }
      ctx.stroke();
    }
    for (let lon = -180; lon < 180; lon += 30) {
      ctx.beginPath();
      let first = true;
      for (let lat = -90; lat <= 90; lat += 2) {
        const s = proj(lat, lon);
        if (!s.visible) { first = true; continue; }
        if (first) { ctx.moveTo(s.sx, s.sy); first = false; } else ctx.lineTo(s.sx, s.sy);
      }
      ctx.stroke();
    }

    // Great-circle paths
    if (contestMapState?.showPaths) {
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      for (const p of contestGlobeGcPaths) {
        if (!contestMapState.enabledBands.has(p.band)) continue;
        ctx.strokeStyle = p.color + '8c';
        ctx.beginPath();
        let first = true;
        for (const pt of p.points) {
          const s = proj(pt.lat, pt.lon);
          if (!s.visible) { first = true; continue; }
          if (first) { ctx.moveTo(s.sx, s.sy); first = false; } else ctx.lineTo(s.sx, s.sy);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // QSO dots — sort back-to-front, then group by locator for pie rendering
    const visItems = contestGlobeQsoItems
      .filter(it => contestMapState?.enabledBands.has(it.band))
      .map(it => ({ ...it, proj: proj(it.lat, it.lon) }))
      .filter(it => it.proj.visible);
    visItems.sort((a, b) => a.proj.z - b.proj.z);
    // Group items at the same locator, preserving back-to-front order of first occurrence.
    const _globeGrp = new Map(); // locKey → { sx, sy, colors:[] }
    for (const it of visItems) {
      const key = it.q?.locator?.toUpperCase().slice(0, 6) ?? `${it.lat.toFixed(4)},${it.lon.toFixed(4)}`;
      if (!_globeGrp.has(key)) _globeGrp.set(key, { sx: it.proj.sx, sy: it.proj.sy, colors: [] });
      const grp = _globeGrp.get(key);
      if (!grp.colors.includes(it.color)) grp.colors.push(it.color);
    }
    for (const { sx, sy, colors } of _globeGrp.values()) {
      _drawPie(ctx, sx, sy, 5, colors);
    }
    contestGlobeLastVisItems = visItems;

    // Own QTH
    contestGlobeLastQthProj = null;
    if (contestGlobeQthLat !== null) {
      const s = proj(contestGlobeQthLat, contestGlobeQthLon);
      contestGlobeLastQthProj = s;
      if (s.visible) {
        ctx.beginPath(); ctx.arc(s.sx, s.sy, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#66bb6a'; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      }
    }

    // Country labels — LOD: more labels appear as zoom increases
    if (contestGlobeLabels) {
      // rank → minimum zoom to show label
      const rankThreshold = [0, 0.5, 0.8, 1.3, 2.0, 3.2, 5.0, 7.5];
      const fontSize = Math.min(13, Math.max(8, 8 + Math.log2(Math.max(1, contestGlobeZoom)) * 2));
      const lang = (window.I18N && window.I18N.lang) ? window.I18N.lang() : 'en';
      ctx.font = `${fontSize}px ${getComputedStyle(el).fontFamily || 'sans-serif'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const placed = [];
      for (const lbl of contestGlobeLabels) {
        const threshold = rankThreshold[Math.min(lbl.r, rankThreshold.length - 1)];
        if (contestGlobeZoom < threshold) continue;
        const s = proj(lbl.lat, lbl.lon);
        if (!s.visible) continue;
        const text = (lang === 'de' && lbl.d) ? lbl.d : lbl.n;
        const tw = ctx.measureText(text).width;
        const th = fontSize * 1.5;
        const bx = s.sx - tw / 2 - 2, by = s.sy - th / 2;
        const bw = tw + 4, bh = th;
        if (placed.some(p => bx < p.x + p.w && bx + bw > p.x && by < p.y + p.h && by + bh > p.y)) continue;
        placed.push({ x: bx, y: by, w: bw, h: bh });
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillText(text, s.sx + 1, s.sy + 1);
        ctx.fillStyle = 'rgba(225,245,215,0.92)';
        ctx.fillText(text, s.sx, s.sy);
      }
      ctx.textBaseline = 'alphabetic';
    }

    ctx.restore();

    // Globe border — only when the full sphere is visible in the canvas
    if (R + 4 < Math.min(W, H) / 2) {
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1.5; ctx.stroke();

      // Rotate/zoom hint below the globe
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.font = `12px ${getComputedStyle(el).fontFamily || 'sans-serif'}`;
      ctx.textAlign = 'center';
      ctx.fillText(t('map.dragToRotate'), cx, cy + R + 16);
    }
  }

  // ----- ops panel tabs -----
  function activateOpsTab(name, opts = {}) {
    document.querySelectorAll('.ops-tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.ops-tab-pane').forEach(x => x.classList.remove('active'));
    const desktopTab = document.querySelector('.ops-tab[data-ops-tab="' + name + '"]');
    if (desktopTab) desktopTab.classList.add('active');
    const pane = $('ops-tab-' + name);
    if (pane) pane.classList.add('active');
    if (name === 'cluster') loadClusterSpots();
    if (name === 'chat') {
      if (desktopTab) desktopTab.classList.remove('chat-notify');
      if (opts.focusChat !== false) {
        const inp = $('chat-input');
        if (inp) inp.focus();
      }
      const list = $('chat-list');
      if (list) list.scrollTop = list.scrollHeight;
    }
  }
  document.querySelectorAll('.ops-tab').forEach(tab => {
    tab.addEventListener('click', () => activateOpsTab(tab.dataset.opsTab));
  });

  // Bottom-sheet nav (mobile mode): tap to open/switch, tap same to close.
  document.querySelectorAll('#mobile-bottom-nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.opsTab;
      const sheet = document.getElementById('mobile-sheet');
      const isOpen = sheet && sheet.classList.contains('open');
      const wasActive = btn.classList.contains('active');
      if (isOpen && wasActive) {
        setMobileSheetOpen(null);
        return;
      }
      activateOpsTab(name, { focusChat: false });
      setMobileSheetOpen(name);
      if (name === 'chat') {
        // Defer focus until after the sheet is laid out so iOS scrolls to the input.
        setTimeout(() => { const inp = $('chat-input'); if (inp) inp.focus(); }, 50);
      }
    });
  });

  // "More fields" toggle inside the QSO entry form on mobile.
  {
    const btn = $('more-fields-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        const expanded = document.body.classList.toggle('show-all-fields');
        const span = btn.querySelector('span') || btn;
        span.textContent = expanded ? t('qso.fewerFields') : t('qso.moreFields');
        btn.setAttribute('data-i18n', expanded ? 'qso.fewerFields' : 'qso.moreFields');
      });
    }
  }

  // ESC closes the bottom sheet (in addition to its other dialog-close uses).
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('mobile-mode')) {
      const sheet = document.getElementById('mobile-sheet');
      if (sheet && sheet.classList.contains('open')) {
        setMobileSheetOpen(null);
      }
    }
  });

  // Apply mobile mode at startup and on viewport changes (rotation, resize).
  applyMobileMode();
  {
    let _resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(applyMobileMode, 150);
    });
  }

  // ----- stash (pre-QSO snapshots) -----
  function collectFormSnapshot() {
    // Mirrors the body assembled by the QSO submit handler, minus server-only fields.
    const snap = {
      callsign: $('q-call').value.trim().toUpperCase(),
      name: $('q-name').value.trim(),
      nr_received: parseInt($('q-nr-rcvd').value || '0', 10) || 0,
      nr_sent: parseInt($('q-nr-sent').value || '0', 10) || 0,
      mode: $('q-mode').value,
      band: $('q-band').value,
      freq_hz: displayToHz($('q-freq').value || '0'),
      rst_sent: $('q-rst-sent').value.trim(),
      rst_received: $('q-rst-rcvd').value.trim(),
      dok: $('q-dok').value.trim().toUpperCase(),
      locator: $('q-loc').value.trim().toUpperCase(),
      itu_zone: $('q-itu').value.trim(),
      cq_zone: $('q-cq').value.trim(),
      notes: $('q-notes').value.trim(),
      lighthouse: $('q-lh').value.trim(),
      utc_time: $('q-time').value || '',
    };
    const cf = (typeof collectCustomFieldsValues === 'function') ? collectCustomFieldsValues() : null;
    if (cf && cf.values && Object.keys(cf.values).length) {
      snap.extras = JSON.stringify(cf.values);
    } else {
      snap.extras = '';
    }
    return snap;
  }

  async function stashCurrentForm(opts) {
    if (!me?.contest_id) return null;
    if (!$('q-call').value.trim()) return null;
    const snap = collectFormSnapshot();
    if (opts && typeof opts.freqOverrideHz === 'number') {
      snap.freq_hz = opts.freqOverrideHz;
    }
    if (!snap.callsign) return null;
    const res = await api('/api/contests/' + me.contest_id + '/stashes', {
      method: 'POST', body: JSON.stringify(snap),
    });
    if (!res.ok) return null;
    const created = await res.json().catch(() => null);
    if (created) {
      if (!stashes.find(s => s.id === created.id)) stashes.unshift(created);
      renderStashList();
    }
    // Clear the form like ESC would.
    cancelQsoEdit();
    return created;
  }

  async function loadStashes() {
    if (!me?.contest_id) { stashes = []; renderStashList(); return; }
    const res = await api('/api/contests/' + me.contest_id + '/stashes');
    if (res.ok) {
      stashes = (await res.json()) || [];
    } else {
      stashes = [];
    }
    renderStashList();
  }

  function fmtStashAge(createdAt) {
    const t = new Date(createdAt).getTime();
    if (!Number.isFinite(t)) return '';
    const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (diffSec < 60) return t_safe('stash.ageJustNow', null, 'just now');
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return t_safe('stash.ageMinutes', { n: mins }, mins + ' min ago');
    const hrs = Math.floor(mins / 60);
    return t_safe('stash.ageHours', { n: hrs }, hrs + ' h ago');
  }

  // Wrapper that falls back to plain English if the i18n key isn't yet loaded.
  function t_safe(key, vars, fallback) {
    try {
      const out = t(key, vars || {});
      if (out && out !== key) return out;
    } catch {}
    if (!vars) return fallback;
    return Object.keys(vars).reduce((s, k) => s.replace('{' + k + '}', vars[k]), fallback);
  }

  function renderStashList() {
    const list = $('stash-list');
    const empty = $('stash-empty');
    const badge = $('stash-count-badge');
    if (!list) return;
    list.innerHTML = '';
    if (!stashes.length) {
      if (empty) empty.classList.remove('hidden');
      if (badge) { badge.classList.add('hidden'); badge.textContent = ''; }
      return;
    }
    if (empty) empty.classList.add('hidden');
    if (badge) { badge.textContent = String(stashes.length); badge.classList.remove('hidden'); }
    for (const st of stashes) {
      const li = document.createElement('li');
      li.className = 'stash-item';
      li.title = t_safe('stash.recallTitle', null, 'Tune TRX and reload form');
      const freqDisplay = st.freq_hz ? hzToDisplay(st.freq_hz) + ' ' + contestFreqUnit() : '';
      const bandLabel = (typeof fmtBand === 'function') ? fmtBand(st.band || '') : (st.band || '');
      const main = document.createElement('div');
      main.className = 'stash-main';
      main.innerHTML = `
        <div class="stash-line1">
          <strong>${escHtml(st.callsign || '')}</strong>
          <span class="stash-freq">${escHtml(freqDisplay)}</span>
          <span class="stash-band">${escHtml(bandLabel)}</span>
          <span class="stash-mode">${escHtml(st.mode || '')}</span>
        </div>
        <div class="stash-line2 muted small">
          ${st.name ? escHtml(st.name) + ' · ' : ''}${st.locator ? escHtml(st.locator) + ' · ' : ''}<span class="stash-age">${escHtml(fmtStashAge(st.created_at))}</span>
        </div>`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost small stash-delete-btn';
      del.textContent = '×';
      del.title = t_safe('common.delete', null, 'Delete');
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const res = await api('/api/contests/' + me.contest_id + '/stashes/' + st.id, { method: 'DELETE' });
        if (res.ok) {
          stashes = stashes.filter(x => x.id !== st.id);
          renderStashList();
        }
      });
      li.appendChild(main);
      li.appendChild(del);
      li.addEventListener('click', () => recallStash(st));
      list.appendChild(li);
    }
  }

  async function recallStash(stash) {
    if (!stash) return;
    // Auto-stash current form contents (if any) before overwriting.
    if ($('q-call').value.trim() !== '' && editingQsoId === null) {
      const sel = me?.selected_rig;
      const oldFreqHz = sel ? lastRigFreqs[sel] : undefined;
      await stashCurrentForm(typeof oldFreqHz === 'number' && oldFreqHz > 0 ? { freqOverrideHz: oldFreqHz } : null);
    }
    // Populate form from stash.
    $('q-call').value = stash.callsign || '';
    $('q-name').value = stash.name || '';
    $('q-nr-rcvd').value = stash.nr_received ? String(stash.nr_received) : '';
    $('q-nr-sent').value = '';
    if (stash.mode) $('q-mode').value = stash.mode;
    if (stash.band) $('q-band').value = stash.band;
    $('q-freq').value = stash.freq_hz ? hzToDisplay(stash.freq_hz) : '';
    $('q-rst-sent').value = stash.rst_sent || '';
    $('q-rst-rcvd').value = stash.rst_received || '';
    $('q-dok').value = stash.dok || '';
    $('q-loc').value = stash.locator || '';
    $('q-itu').value = stash.itu_zone || '';
    $('q-cq').value = stash.cq_zone || '';
    $('q-notes').value = stash.notes || '';
    $('q-lh').value = stash.lighthouse || '';
    $('q-time').value = stash.utc_time || '';
    // Restore custom field values.
    if (stash.extras && typeof applyCustomFieldsValues === 'function') {
      try { applyCustomFieldsValues(JSON.parse(stash.extras)); } catch {}
    }
    applyRSTDefaults($('q-mode').value);
    updateDuplicateBadge();
    updateOobBadge();
    // Tune the selected TRX to the stashed frequency.
    if (me?.selected_rig && stash.freq_hz > 0) {
      api('/api/rigs/set_freq', {
        method: 'POST',
        body: JSON.stringify({ freq_hz: stash.freq_hz, mode: stash.mode || '' }),
      }).catch(() => {});
      // Prevent the resulting WS rig update from re-stashing.
      lastRigFreqs[me.selected_rig] = stash.freq_hz;
    }
    // Trigger lookup so the left panel updates picture/locator.
    if (stash.callsign && stash.callsign.length >= 3 && typeof triggerQRZLookup === 'function') {
      clearLeftPanel();
      triggerQRZLookup(stash.callsign);
    }
    currentTargetLocator = stash.locator || null;
    if (typeof updateCallCountry === 'function') updateCallCountry(stash.callsign);
    if (typeof updateMap === 'function') updateMap();
    // Delete server-side.
    await api('/api/contests/' + me.contest_id + '/stashes/' + stash.id, { method: 'DELETE' }).catch(() => {});
    stashes = stashes.filter(x => x.id !== stash.id);
    renderStashList();
    $('q-call').focus();
  }

  // Periodically refresh age labels on the stash list.
  if (stashAgeTimer) clearInterval(stashAgeTimer);
  stashAgeTimer = setInterval(() => {
    if (!stashes.length) return;
    document.querySelectorAll('#stash-list .stash-age').forEach((el, i) => {
      const st = stashes[i];
      if (st) el.textContent = fmtStashAge(st.created_at);
    });
  }, 60000);

  // ----- chat -----
  const chatHistory = [];
  const chatSeen = new Set(); // fingerprints to deduplicate history replays
  function clearChat() {
    chatHistory.length = 0;
    chatSeen.clear();
    const list = $('chat-list');
    if (list) list.innerHTML = '';
  }
  function appendChatMessage(payload) {
    if (!payload) return;
    const fp = `${payload.time}|${payload.from}|${payload.text}`;
    if (chatSeen.has(fp)) return;
    chatSeen.add(fp);
    chatHistory.push(payload);
    if (chatHistory.length > 200) chatHistory.shift();
    const list = $('chat-list');
    if (!list) return;
    const li = document.createElement('li');
    li.className = 'chat-msg';
    const t = payload.time ? new Date(payload.time) : new Date();
    const hh = String(t.getUTCHours()).padStart(2, '0');
    const mm = String(t.getUTCMinutes()).padStart(2, '0');
    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    const who = document.createElement('strong');
    who.textContent = payload.from || payload.user || '?';
    meta.appendChild(who);
    meta.appendChild(document.createTextNode(` · ${hh}:${mm}Z`));
    const body = document.createElement('div');
    body.className = 'chat-body';
    // Config-offer chat messages (FR #23) are plain-text on the wire with a
    // sentinel prefix `[noctalum-cfg:TOKEN:Name]` (see buildConfigOfferText
    // in contestShareModal). When we see one, render an inline card with
    // an "Apply this config" button instead of the raw sentinel text.
    const cfgMatch = (payload.text || '').match(/^\[noctalum-cfg:([A-Za-z0-9_-]+):([^\]]*)\]$/);
    if (cfgMatch) {
      const token = cfgMatch[1];
      const name = cfgMatch[2].trim() || token;
      body.className = 'chat-body chat-config-offer';
      const card = document.createElement('div');
      card.className = 'chat-cfg-card';
      const label = document.createElement('div');
      label.className = 'chat-cfg-label';
      label.textContent = '🛠 ' + t('chat.configOffered') + ': ' + name;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary small';
      btn.textContent = t('chat.applyConfig');
      btn.addEventListener('click', () => contestImportShareModal(token));
      card.appendChild(label);
      card.appendChild(btn);
      body.appendChild(card);
    } else {
      body.textContent = payload.text || '';
    }
    li.appendChild(meta);
    li.appendChild(body);
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
  }
  function playChatSound(type) {
    if (!type || type === 'none') return;
    if (type.startsWith('custom:')) {
      const audio = new Audio('/sounds/' + encodeURIComponent(type.slice(7)));
      audio.volume = 0.7;
      audio.play().catch(() => {});
      return;
    }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      // All scheduling must happen after resume() so ctx.currentTime is live.
      ctx.resume().then(() => {
        const t = ctx.currentTime;
        osc.type = 'sine';
        if (type === 'beep') {
          osc.frequency.value = 800;
          gain.gain.setValueAtTime(0.25, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
          osc.start(t);
          osc.stop(t + 0.15);
        } else if (type === 'ding') {
          osc.frequency.value = 1200;
          gain.gain.setValueAtTime(0.3, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
          osc.start(t);
          osc.stop(t + 0.45);
        } else if (type === 'chime') {
          osc.type = 'triangle';
          osc.frequency.value = 1500;
          gain.gain.setValueAtTime(0.25, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
          osc.start(t);
          osc.stop(t + 0.7);
        }
        osc.onended = () => ctx.close();
      });
    } catch {}
  }
  function onChatMessage(payload) {
    appendChatMessage(payload);
    if (payload?.history) return;
    const tab = document.querySelector('.ops-tab[data-ops-tab="chat"]');
    if (tab && !tab.classList.contains('active')) {
      tab.classList.add('chat-notify');
    }
    const soundType = settings?.chat_sound;
    if (soundType && !isChatSoundMuted()) {
      playChatSound(soundType);
    }
  }
  function sendChat() {
    const inp = $('chat-input');
    if (!inp || !ws || ws.readyState !== WebSocket.OPEN) return;
    const text = (inp.value || '').trim();
    if (!text) return;
    try { ws.send(JSON.stringify({ type: 'chat', text })); } catch {}
    inp.value = '';
  }
  {
    const btn = $('chat-send-btn');
    const inp = $('chat-input');
    if (btn) btn.addEventListener('click', sendChat);
    if (inp) inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });
  }

  // "Show WSJT-X bridge token" button in the Status sidebar. The token
  // ties to the currently-selected contest, not the operator — so this
  // action lives inside the in-contest sidebar rather than in personal
  // settings. Delegates to the same modal the contest-picker pill opens.
  $('ops-wsjtx-token-btn')?.addEventListener('click', () => {
    if (!me?.contest_id) return;
    contestWsjtxTokenModal({
      id:           me.contest_id,
      name:         me.contest_name || '',
      station_call: me.contest_call || '',
    });
  });

  // ----- DX Cluster -----
  let clusterSpots = [];
  let clusterTimer = null;

  async function loadClusterSpots() {
    $('cluster-status').textContent = t('cluster.loading');
    try {
      const res = await api('/api/cluster/spots');
      if (!res.ok) {
        $('cluster-status').textContent = t('cluster.unavailable');
        return;
      }
      const data = await res.json();
      clusterSpots = data.spots || [];
      updateClusterFilters();
      renderClusterSpots();
      const connStr = data.connected ? t('cluster.live') : t('cluster.connecting');
      $('cluster-status').textContent = t('cluster.status', { count: clusterSpots.length, conn: connStr, time: new Date().toLocaleTimeString(localeForFmt()) });
    } catch {
      $('cluster-status').textContent = t('cluster.failed');
    }
    // auto-refresh every 60s while the tab is visible
    clearTimeout(clusterTimer);
    clusterTimer = setTimeout(() => {
      if ($('ops-tab-cluster').classList.contains('active')) loadClusterSpots();
    }, 60000);
  }

  function updateClusterFilters() {
    const bandSel = $('cluster-band-filter');
    const modeSel = $('cluster-mode-filter');
    const curBand = bandSel.value;
    const curMode = modeSel.value;

    // Bands: prefer the contest's configured bands; fall back to the bands present in spots.
    const contestBands = (me?.contest_bands || '').split(',').map(s => s.trim()).filter(Boolean);
    const spotBands = [...new Set(clusterSpots.map(s => s.band).filter(Boolean))];
    let bands;
    if (contestBands.length) {
      bands = contestBands.slice();
    } else {
      bands = spotBands.sort();
    }

    // Modes: include digimodes explicitly so users can filter by FT8/FT4/etc even
    // when no current spot uses that mode.
    const digimodes = ['FT8', 'FT4', 'RTTY', 'PSK31', 'PSK63', 'JT65', 'JT9', 'DIGI'];
    const modeSet = new Set(clusterSpots.map(s => (s.mode || '').toUpperCase()).filter(Boolean));
    ['CW', 'SSB', 'USB', 'LSB', 'FM', 'AM', ...digimodes].forEach(m => modeSet.add(m));
    const modes = [...modeSet].sort();

    bandSel.innerHTML = '<option value="">All bands</option>' +
      bands.map(b => `<option value="${escHtml(b)}"${b === curBand ? ' selected' : ''}>${escHtml(fmtBand(b))}</option>`).join('');
    modeSel.innerHTML = '<option value="">All modes</option>' +
      modes.map(m => `<option value="${escHtml(m)}"${m === curMode ? ' selected' : ''}>${escHtml(m)}</option>`).join('');
  }

  function renderClusterSpots() {
    const tbody = $('cluster-tbody');
    if (!tbody) return;
    const bandFilter = $('cluster-band-filter').value;
    const modeFilter = $('cluster-mode-filter').value;
    const spotterFilter = $('cluster-spotter-filter').value;

    let filtered = clusterSpots;
    if (bandFilter) filtered = filtered.filter(s => s.band === bandFilter);
    if (modeFilter) filtered = filtered.filter(s => s.mode === modeFilter);
    if (spotterFilter) {
      filtered = filtered.filter(s => {
        const info = callsignToInfo(s.spotter || '');
        if (spotterFilter === 'DE') return info.country === 'Germany';
        return info.continent === spotterFilter;
      });
    }

    tbody.innerHTML = '';
    for (const spot of filtered) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="muted">${escHtml(spot.time)}</td>
        <td class="cluster-dx">${escHtml(fmtCall(spot.dx))}</td>
        <td class="cluster-freq">${escHtml(spot.freq)}</td>
        <td>${escHtml(spot.mode)}</td>
        <td title="${escHtml(spot.spotter ? 'de ' + spot.spotter : '')}">${escHtml(spot.comment)}</td>
      `;
      tr.addEventListener('click', () => useClusterSpot(spot));
      tbody.appendChild(tr);
    }
    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted" style="text-align:center;padding:10px">No spots.</td></tr>';
    }
  }

  async function useClusterSpot(spot) {
    if (!contestIsOpen()) return;
    // Stash the in-flight entry BEFORE overwriting the form. The current
    // callsign belongs to the prior QSO attempt — not to the spot we just
    // clicked — so it must be captured at this moment, not later.
    if ($('q-call').value.trim() !== '' && editingQsoId === null) {
      const sel = me?.selected_rig;
      const oldFreqHz = sel ? lastRigFreqs[sel] : undefined;
      await stashCurrentForm(typeof oldFreqHz === 'number' && oldFreqHz > 0 ? { freqOverrideHz: oldFreqHz } : null);
    } else {
      cancelQsoEdit();
    }
    if (spot.dx) {
      $('q-call').value = spot.dx;
      callsignFilter = spot.dx;
      renderQsos();
    }
    if (spot.freq) $('q-freq').value = hzToDisplay(Math.round(parseFloat(spot.freq) * 1000));
    if (spot.band) $('q-band').value = spot.band;
    const inferredMode = (spot.mode && MODES.includes(spot.mode)) ? spot.mode : modeFromFreqKHz(spot.freq);
    if (inferredMode) $('q-mode').value = inferredMode;
    // Clear stale RST values so the mode-appropriate default takes effect
    $('q-rst-sent').value = '';
    $('q-rst-rcvd').value = '';
    applyRSTDefaults($('q-mode').value);
    updateDuplicateBadge();
    updateOobBadge();
    updateCallCountry($('q-call').value.trim().toUpperCase());
    updateNrPreview();
    // tune the selected rig if one is connected
    if (me?.selected_rig && spot.freq) {
      const freqHz = Math.round(parseFloat(spot.freq) * 1000);
      if (freqHz > 0) {
        api('/api/rigs/set_freq', { method: 'POST', body: JSON.stringify({ freq_hz: freqHz, mode: spot.mode || '' }) })
          .catch(() => {});
        // Suppress the WS rig update that's about to arrive — we don't want
        // it to re-stash the spot we just populated.
        lastRigFreqs[me.selected_rig] = freqHz;
      }
    }
    // trigger lookup for pic/locator
    const call = $('q-call').value.trim().toUpperCase();
    if (call.length >= 3) { clearLeftPanel(); triggerQRZLookup(call); }
    // switch to log tab if not already there
    document.querySelector('.tab[data-tab="log"]').click();
    $('q-call').focus();
  }

  // Wrapped in a re-callable function because the ops panel can be adopted
  // into a popup window/tab, and some browsers drop `change` listeners on
  // `<select>` elements during cross-document adoption even though the DOM
  // spec says they should persist. `_adoptPanelIntoWindow` and `redockPanel`
  // call this again after moving the panel; addEventListener is a no-op when
  // the same (event, handler, capture) triple is already registered, so the
  // repeat call is safe on browsers that preserve the listeners correctly.
  function wireClusterListeners() {
    const refresh = $('cluster-refresh-btn');
    const band = $('cluster-band-filter');
    const mode = $('cluster-mode-filter');
    const spotter = $('cluster-spotter-filter');
    if (refresh) refresh.addEventListener('click', loadClusterSpots);
    if (band) band.addEventListener('change', renderClusterSpots);
    if (mode) mode.addEventListener('change', renderClusterSpots);
    if (spotter) spotter.addEventListener('change', renderClusterSpots);
  }
  wireClusterListeners();

  // ----- markdown renderer -----
  function inlineMd(s) {
    return s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function renderMarkdown(md) {
    if (!md || !md.trim()) return '<p class="objective-empty">No objective set.</p>';
    const blocks = md.split(/\n{2,}/);
    return blocks.map(block => {
      const lines = block.split('\n');
      const first = lines[0];
      // Fenced code block
      if (first.startsWith('```')) {
        const code = lines.slice(1).filter(l => !l.startsWith('```')).map(l => escHtml(l)).join('\n');
        return `<pre><code>${code}</code></pre>`;
      }
      // Headings
      const hm = first.match(/^(#{1,4})\s+(.+)/);
      if (hm) return `<h${hm[1].length}>${inlineMd(hm[2])}</h${hm[1].length}>`;
      // Blockquote
      if (first.startsWith('> ')) {
        return `<blockquote>${lines.map(l => inlineMd(l.replace(/^>\s?/, ''))).join('<br>')}</blockquote>`;
      }
      // Unordered list
      if (first.match(/^[-*]\s/)) {
        const items = lines.filter(l => l.match(/^[-*]\s/)).map(l => `<li>${inlineMd(l.replace(/^[-*]\s+/, ''))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      // Ordered list
      if (first.match(/^\d+\.\s/)) {
        const items = lines.filter(l => l.match(/^\d+\.\s/)).map(l => `<li>${inlineMd(l.replace(/^\d+\.\s+/, ''))}</li>`).join('');
        return `<ol>${items}</ol>`;
      }
      // Paragraph
      return `<p>${lines.map(l => inlineMd(l)).join('<br>')}</p>`;
    }).join('');
  }

  function renderObjective() {
    const el = $('objective-content');
    if (!el) return;
    el.innerHTML = renderMarkdown(me?.contest_objective || '');
  }

  function applyPermissionsToUI() {
    document.querySelectorAll('.tab-perm').forEach(tab => {
      if (hasPerm(tab.dataset.perm)) tab.classList.add('visible');
      else tab.classList.remove('visible');
    });
    document.querySelectorAll('.perm-required').forEach(el => {
      const perms = (el.dataset.perm || '').split(' ').filter(Boolean);
      if (perms.some(p => hasPerm(p))) el.removeAttribute('data-perm-denied');
      else el.setAttribute('data-perm-denied', '1');
    });
    $('feature-request-btn').classList.toggle('hidden', !hasPerm('feature_requests.write'));
    $('new-role-btn').classList.toggle('hidden', !isAdmin());
  }

  // ----- mode/band fillers -----
  function fillSelect(sel, options, def, labelFn) {
    sel.innerHTML = '';
    for (const v of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = labelFn ? labelFn(v) : v;
      if (v === def) o.selected = true;
      sel.appendChild(o);
    }
  }
  // Refill the QSO band <select> from the contest's current bands list,
  // preserving the operator's existing selection if it is still in the new
  // option set. Used when the contest's bands change mid-session (e.g. the
  // operator adds 23 cm post-hoc): without this, the dropdown stays frozen
  // on the bands present at last applyDefaults() and the operator cannot
  // pick or edit a QSO into the newly-added band (FR #60b).
  function refreshContestBandSelect() {
    const sel = $('q-band');
    if (!sel) return;
    const current = sel.value;
    const cBands = contestBands();
    const options = cBands.length ? cBands : BANDS;
    const pick = options.includes(current) ? current : (settings?.default_band || '20m');
    fillSelect(sel, options, pick, fmtBand);
  }
  function applyDefaults() {
    fillSelect($('q-mode'), MODES, settings?.default_mode || 'SSB');
    const cBands = contestBands();
    fillSelect($('q-band'), cBands.length ? cBands : BANDS, settings?.default_band || '20m', fmtBand);
    fillSelect($('s-mode'), MODES, settings?.default_mode || 'SSB');
    fillSelect($('s-band'), BANDS, settings?.default_band || '20m', fmtBand);
    applyRSTDefaults($('q-mode').value);
  }
  function defaultRST(m) {
    if (['SSB','USB','LSB','FM','AM'].includes(m)) return '59';
    if (['CW','RTTY','FT8','FT4','PSK31','PSK63','JT65','JT9','MFSK','OLIVIA','DIGI'].includes(m)) return '599';
    return '';
  }
  // Infer likely mode from frequency (kHz) when a spot has no explicit mode.
  // Based on common amateur band plans.
  function modeFromFreqKHz(freqStr) {
    const f = parseFloat(freqStr);
    if (!f) return '';
    // FT8 and FT4 calling frequencies (worldwide)
    const ft8 = [1840, 3573, 5357, 7074, 10136, 14074, 18100, 21074, 24915, 28074, 50313, 144174];
    const ft4 = [3575, 7047.5, 10140, 14080, 18104, 21140, 24919, 28180, 50318];
    if (ft8.some(x => Math.abs(f - x) < 2)) return 'FT8';
    if (ft4.some(x => Math.abs(f - x) < 2)) return 'FT4';
    // RTTY segments
    if ((f >= 3580 && f <= 3600) || (f >= 7035 && f <= 7045) ||
        (f >= 14080 && f <= 14099) || (f >= 21080 && f <= 21099) ||
        (f >= 28080 && f <= 28099)) return 'RTTY';
    // CW segments (bottom of each band)
    if ((f >= 1800 && f <= 1838) || (f >= 3500 && f <= 3570) ||
        (f >= 7000 && f <= 7040) || (f >= 10100 && f <= 10130) ||
        (f >= 14000 && f <= 14070) || (f >= 18068 && f <= 18095) ||
        (f >= 21000 && f <= 21070) || (f >= 24890 && f <= 24915) ||
        (f >= 28000 && f <= 28070) || (f >= 50000 && f <= 50100) ||
        (f >= 144000 && f <= 144150)) return 'CW';
    // SSB / voice — rest of HF and VHF
    if (f < 10000 || (f >= 14100 && f < 30000) || (f >= 50100 && f < 300000)) return 'SSB';
    return '';
  }

  function bandFromFreqKHz(freq) {
    const f = parseFloat(freq);
    if (!f) return null;
    if (f >= 1800 && f < 2000) return '160m';
    if (f >= 3500 && f < 4000) return '80m';
    if (f >= 5250 && f < 5450) return '60m';
    if (f >= 7000 && f < 7300) return '40m';
    if (f >= 10100 && f < 10150) return '30m';
    if (f >= 14000 && f < 14350) return '20m';
    if (f >= 18068 && f < 18168) return '17m';
    if (f >= 21000 && f < 21450) return '15m';
    if (f >= 24890 && f < 24990) return '12m';
    if (f >= 28000 && f < 29700) return '10m';
    if (f >= 50000 && f < 54000) return '6m';
    if (f >= 70000 && f < 71000) return '4m';
    if (f >= 144000 && f < 148000) return '2m';
    if (f >= 430000 && f < 440000) return '70cm';
    if (f >= 1240000 && f < 1300000) return '23cm';
    if (f >= 2300000 && f < 2450000) return '13cm';
    if (f >= 10000000 && f < 10500000) return '3cm';
    return null;
  }

  function applyRSTDefaults(m) {
    const def = defaultRST(m);
    $('q-rst-sent').placeholder = def;
    $('q-rst-rcvd').placeholder = def;
  }
  $('q-mode').addEventListener('change', () => { applyRSTDefaults($('q-mode').value); updateDuplicateBadge(); });
  $('q-band').addEventListener('change', () => updateDuplicateBadge());
  $('q-freq').addEventListener('input', () => {
    const band = bandFromFreqKHz(displayToKHz($('q-freq').value));
    if (band) { $('q-band').value = band; updateDuplicateBadge(); }
    updateOobBadge();
  });

  // Enter submits the QSO form from any field — browsers do this natively for
  // <input type=text> but not from <select>, so band/mode would silently swallow
  // Enter.  The form already advertises "Enter" on the Log QSO button.
  $('qso-form').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag !== 'select') return;
    e.preventDefault();
    $('qso-form').requestSubmit();
  });

  // ----- left panel -----
  function updateLeftPanel(callsign, hasPicture, locator) {
    if (hasPicture) {
      $('left-pic').src = '/api/lookup/picture?callsign=' + encodeURIComponent(callsign);
      $('left-pic').classList.remove('hidden');
      $('left-pic-placeholder').classList.add('hidden');
    } else {
      $('left-pic').src = '';
      $('left-pic').classList.add('hidden');
      $('left-pic-placeholder').classList.remove('hidden');
    }
    currentTargetLocator = locator || null;
    updateMap();
  }

  function clearLeftPanel() {
    $('left-pic').src = '';
    $('left-pic').classList.add('hidden');
    $('left-pic-placeholder').classList.remove('hidden');
    currentTargetLocator = null;
    $('bearing-value').textContent = '—';
    $('distance-value').textContent = '—';
    stopArrowAnim();
    if (leafletMap) {
      if (qthMarker) { qthMarker.remove(); qthMarker = null; }
      if (tgtMarker) { tgtMarker.remove(); tgtMarker = null; }
      pathLines.forEach(l => l.remove()); pathLines = [];
    }
  }

  function showQsoPicture(callsign) {
    const img = $('left-pic');
    const ph  = $('left-pic-placeholder');
    img.onload  = () => { img.classList.remove('hidden'); ph.classList.add('hidden'); img.onload = img.onerror = null; };
    img.onerror = () => { img.classList.add('hidden'); ph.classList.remove('hidden'); img.onload = img.onerror = null; };
    img.src = '/api/lookup/picture?callsign=' + encodeURIComponent(callsign);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('modal-root').classList.contains('hidden')) {
      $('modal-root').classList.add('hidden');
      return;
    }
    if ($('tab-log').classList.contains('active')) cancelQsoEdit();
  });

  function updateMap() {
    if (typeof L === 'undefined') return;
    if (!leafletMap) initLeafletMap();
    if (!leafletMap) return;
    try {

    // Remove previous overlays
    stopArrowAnim();
    if (qthMarker)  { qthMarker.remove();  qthMarker  = null; }
    if (tgtMarker)  { tgtMarker.remove();  tgtMarker  = null; }
    pathLines.forEach(l => l.remove());
    pathLines = [];

    const myLocStr  = me?.contest_qth || null;
    const tgtLocStr = currentTargetLocator;
    const my  = myLocStr  ? locatorToLatLon(myLocStr)  : null;
    const tgt = tgtLocStr ? locatorToLatLon(tgtLocStr) : null;

    const circleOpts = (color) => ({
      radius: 6, fillColor: color, color: '#111', weight: 2, fillOpacity: 1, pane: 'markerPane',
    });

    if (my) {
      qthMarker = L.circleMarker([my.lat, my.lon], circleOpts('#66bb6a'))
        .bindTooltip('QTH').addTo(leafletMap);
    }
    if (tgt) {
      tgtMarker = L.circleMarker([tgt.lat, tgt.lon], circleOpts('#ef5350'))
        .addTo(leafletMap);
    }

    if (my && tgt) {
      const pts = greatCirclePoints(my.lat, my.lon, tgt.lat, tgt.lon, 100);
      for (const seg of splitAtAntimeridian(pts)) {
        pathLines.push(
          L.polyline(seg, { color: '#4fc3f7', weight: 2.5, opacity: 0.9, dashArray: '6 4' })
           .addTo(leafletMap)
        );
      }
      // Flowing direction chevrons: three arrows that slide along the great
      // circle from my QTH toward the target on a continuous loop, so the map
      // reads as active signal propagation rather than a static bearing line.
      // Each chevron is phase-offset by 1/N of the cycle so they stay evenly
      // spread out.  The animation runs off requestAnimationFrame and is
      // torn down by stopArrowAnim() at the top of updateMap() and in
      // clearLeftPanel(), so it never outlives the polyline it decorates.
      const ARROW_COUNT = 3;
      const ARROW_PERIOD_MS = 4000;  // full source→target traversal per chevron
      const arrows = [];
      const arrowGs = [];
      for (let k = 0; k < ARROW_COUNT; k++) {
        const icon = L.divIcon({
          className: 'gc-arrow',
          html: `<svg viewBox="0 0 24 24" width="16" height="16" style="display:block">`
              + `<g><path d="M12 3 L18 16 L12 12 L6 16 Z" fill="#4fc3f7" stroke="#0a1420" stroke-width="1" stroke-linejoin="round"/></g>`
              + `</svg>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });
        const m = L.marker(pts[0], { icon, interactive: false, keyboard: false })
                   .addTo(leafletMap);
        arrows.push(m);
        arrowGs.push(null);  // resolved lazily on first frame
        pathLines.push(m);
      }
      const t0 = performance.now();
      const step = (now) => {
        const t = (now - t0) / ARROW_PERIOD_MS;
        for (let k = 0; k < ARROW_COUNT; k++) {
          // Keep chevrons off the endpoint markers by clamping to [0.03, 0.97].
          const frac = 0.03 + 0.94 * (((t + k / ARROW_COUNT) % 1 + 1) % 1);
          const i = Math.min(Math.floor(frac * (pts.length - 1)), pts.length - 2);
          const [lat, lon] = pts[i];
          const heading = bearingTo(lat, lon, pts[i+1][0], pts[i+1][1]);
          arrows[k].setLatLng([lat, lon]);
          let g = arrowGs[k];
          if (!g) {
            const el = arrows[k].getElement();
            if (el) { g = el.querySelector('g'); arrowGs[k] = g; }
          }
          if (g) g.setAttribute('transform', `rotate(${heading.toFixed(1)} 12 12)`);
        }
        arrowAnim = requestAnimationFrame(step);
      };
      arrowAnim = requestAnimationFrame(step);
      // Fit the entire path in view
      const bounds = L.latLngBounds(pts.map(([a,b]) => [a, b]));
      leafletMap.fitBounds(bounds, { padding: [18, 18], maxZoom: 8 });

      const b = bearingTo(my.lat, my.lon, tgt.lat, tgt.lon);
      $('bearing-value').textContent = Math.round(b) + '° ' + bearingCompass(b);
      const dist = distanceTo(my.lat, my.lon, tgt.lat, tgt.lon);
      $('distance-value').textContent = Math.round(dist) + ' km';
    } else if (my) {
      leafletMap.setView([my.lat, my.lon], 3);
      $('bearing-value').textContent = '—';
      $('distance-value').textContent = '—';
    } else {
      leafletMap.setView([20, 0], 1);
      $('bearing-value').textContent = '—';
      $('distance-value').textContent = '—';
    }
    } catch (e) { console.warn('updateMap error:', e); }
  }

  // ----- QRZ lookup -----
  let qrzLookupTimer = null;
  let renderQsosTimer = null;
  // Tracks which field values were auto-populated by the last successful lookup
  // so we can reverse them when the final callsign has no entry.
  let _qrzAutoFilled = null; // { name?, locator?, dok? }
  // Monotonic sequence number for in-flight QRZ lookups. Each call to
  // triggerQRZLookup() bumps this and remembers its own value; when a
  // response arrives, it is only applied if its sequence still equals the
  // current one. This defeats the race that produced FR #60a's wrong-DOK
  // symptom: an in-flight lookup for an earlier callsign would resolve
  // after the operator had moved on, and the only existing guard (a string
  // comparison against the current q-call value) failed when the operator
  // happened to type the previous callsign back in (e.g. fixing a typo).
  let _qrzLookupSeq = 0;

  function clearQRZInfo() {
    $('q-name').value = '';
    $('q-loc').value = '';
    _qrzAutoFilled = null;
    // Invalidate any in-flight lookup so it cannot resurrect just-wiped
    // fields after the user has hit submit or navigated away.
    _qrzLookupSeq++;
    clearLeftPanel();
    renderBandPills();
    updateCallCountry('');
    $('qrz-pill').classList.add('hidden');
  }

  function updateDuplicateBadge() {
    const badge = $('dup-badge');
    if (editingQsoId !== null) { badge.className = 'dup-badge hidden'; renderBandPills(); return; }
    const call = $('q-call').value.trim().toUpperCase();
    if (!call) { badge.className = 'dup-badge hidden'; renderBandPills(); return; }
    const worked = qsos.filter(q => q.callsign === call);
    if (!worked.length) { badge.className = 'dup-badge hidden'; renderBandPills(); return; }
    const band = $('q-band').value;
    const mode = $('q-mode').value;
    if (worked.some(q => q.band === band && normMode(q.mode) === normMode(mode))) {
      badge.className = 'dup-badge dup-duplicate';
      badge.textContent = t('qso.duplicate');
    } else {
      badge.className = 'dup-badge dup-worked';
      badge.textContent = t('qso.workedOther');
    }
    renderBandPills();
  }

  function updateOobBadge() {
    const badge = $('oob-badge');
    if (!badge) return;
    const cBands = contestBands();
    if (!cBands.length) { badge.className = 'dup-badge hidden'; return; }
    const band = bandFromFreqKHz(displayToKHz($('q-freq').value));
    if (!band || cBands.includes(band)) { badge.className = 'dup-badge hidden'; return; }
    badge.className = 'dup-badge oob-band';
    badge.textContent = t('qso.outOfBand');
  }

  function contestBands() {
    const raw = me?.contest_bands || '';
    if (!raw) return [];
    return raw.split(',').filter(Boolean);
  }

  function renderBandPills() {
    const bar = $('band-pills-bar');
    if (!bar) return;
    const bands = contestBands();
    if (!bands.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }

    const call = $('q-call').value.trim().toUpperCase();
    const currentBand = $('q-band').value;
    const currentMode = $('q-mode').value;
    const worked = call ? qsos.filter(q => q.callsign === call) : [];

    // Detect which band the rig is on
    const rig = rigs.find(x => x.name === me?.selected_rig);
    const rigBand = rig?.band || null;

    // Build map of band → operator callsigns (excluding self)
    const bandOps = {};
    for (const op of operators) {
      if (me && op.callsign === me.callsign) continue;
      const rigForOp = rigs.find(r => Array.isArray(r.in_use_by) && r.in_use_by.includes(op.callsign));
      const opBand = op.band || (rigForOp ? rigForOp.band : '');
      if (opBand) {
        if (!bandOps[opBand]) bandOps[opBand] = [];
        bandOps[opBand].push(op.callsign);
      }
    }

    currentBandOps = bandOps;

    bar.innerHTML = '';
    for (const band of bands) {
      const pill = document.createElement('span');
      pill.className = 'band-pill';
      pill.textContent = fmtBand(band);

      const isRigBand = band === (rigBand || currentBand);
      const workedOnBand = worked.filter(q => q.band === band);
      const dupOnBand = workedOnBand.some(q => normMode(q.mode) === normMode(currentMode));
      const busyOps = bandOps[band] || [];
      const isBusy = busyOps.length > 0;

      if (!call) {
        pill.classList.add('bp-inactive');
      } else if (dupOnBand) {
        pill.classList.add('bp-dup');
      } else if (workedOnBand.length > 0) {
        pill.classList.add('bp-other');
      } else {
        pill.classList.add('bp-new');
      }
      if (isRigBand) pill.classList.add('bp-current');
      if (isBusy) {
        pill.title = t('ops.bandBusy', { band: fmtBand(band), ops: busyOps.map(fmtCall).join(', ') });
      }

      pill.addEventListener('click', () => {
        $('q-band').value = band;
        $('q-freq').value = '';
        updateDuplicateBadge();
      });

      bar.appendChild(pill);
    }
    bar.classList.remove('hidden');
  }

  async function triggerQRZLookup(callsign) {
    if (!callsign || callsign.length < 3) return;
    const mySeq = ++_qrzLookupSeq;
    try {
      const res = await api('/api/lookup?callsign=' + encodeURIComponent(callsign));
      if (!res.ok) return;
      // Two-layer staleness guard:
      //   1. mySeq vs _qrzLookupSeq — superseded by a later lookup (defeats
      //      the race where the operator briefly types back to this
      //      callsign and the simple value-comparison would wave us through).
      //   2. q-call.value vs callsign — defends against the case where the
      //      user has just navigated away, cleared the form, or accepted a
      //      different result; never apply a lookup whose callsign does not
      //      match what is currently in the input.
      if (mySeq !== _qrzLookupSeq) return;
      if ($('q-call').value.trim().toUpperCase() !== callsign) return;
      const j = await res.json();
      // No QRZ entry for this callsign — wipe any name/locator that were
      // auto-filled by an intermediate partial-callsign lookup.
      if (!j.found && _qrzAutoFilled) {
        if (_qrzAutoFilled.name && $('q-name').value === _qrzAutoFilled.name) $('q-name').value = '';
        if (_qrzAutoFilled.locator && $('q-loc').value === _qrzAutoFilled.locator) $('q-loc').value = '';
        _qrzAutoFilled = _qrzAutoFilled.dok ? { dok: _qrzAutoFilled.dok } : null;
        clearLeftPanel();
        $('qrz-pill').classList.add('hidden');
      }
      // No cached DOK for this callsign — wipe any DOK that was auto-filled earlier.
      if (!j.cached_dok && _qrzAutoFilled?.dok && $('q-dok').value === _qrzAutoFilled.dok) {
        $('q-dok').value = '';
        if (_qrzAutoFilled) delete _qrzAutoFilled.dok;
      }
      // Fill fields from the fresh lookup result and record what was auto-populated.
      const filled = {};
      if (j.name && !$('q-name').value) { $('q-name').value = j.name; filled.name = j.name; }
      if (j.locator && !$('q-loc').value) { $('q-loc').value = j.locator.toUpperCase(); filled.locator = j.locator.toUpperCase(); }
      if (j.cached_dok && !$('q-dok').value) { $('q-dok').value = j.cached_dok; filled.dok = j.cached_dok; }
      if (Object.keys(filled).length) _qrzAutoFilled = { ..._qrzAutoFilled, ...filled };
      const loc = j.locator ? j.locator.toUpperCase() : ($('q-loc').value.trim().toUpperCase() || null);
      updateLeftPanel(callsign, !!j.has_picture, loc);
      if (j.found) {
        const pill = $('qrz-pill');
        pill.href = 'https://www.qrz.com/db/' + encodeURIComponent(callsign);
        pill.classList.remove('hidden');
      }
      renderBandPills();
    } catch {}
  }

  // Redraw map when the locator field is edited manually.
  let locTimer = null;
  $('q-loc').addEventListener('input', () => {
    clearTimeout(locTimer);
    locTimer = setTimeout(() => {
      const loc = $('q-loc').value.trim().toUpperCase();
      currentTargetLocator = loc.length >= 4 ? loc : null;
      updateMap();
    }, 400);
  });

  // Reserve a serial number the first time the operator starts typing a callsign.
  $('q-call').addEventListener('input', async () => {
    // QRZ timer must be set synchronously before any await so rapid typing
    // always resets it correctly regardless of the NR reservation flight time.
    clearTimeout(qrzLookupTimer);
    const call = $('q-call').value.trim().toUpperCase();
    if (editingQsoId === null) {
      callsignFilter = call || null;
      clearTimeout(renderQsosTimer);
      renderQsosTimer = setTimeout(renderQsos, 150);
    }
    updateDuplicateBadge();
    updateCallCountry(call);
    if (call.length >= 3) {
      // Wipe stale autofill immediately so old data never lingers while the
      // new lookup is in-flight, even if the new callsign also has a QRZ entry.
      if (_qrzAutoFilled) {
        if (_qrzAutoFilled.name && $('q-name').value === _qrzAutoFilled.name) $('q-name').value = '';
        if (_qrzAutoFilled.locator && $('q-loc').value === _qrzAutoFilled.locator) $('q-loc').value = '';
        if (_qrzAutoFilled.dok && $('q-dok').value === _qrzAutoFilled.dok) $('q-dok').value = '';
        _qrzAutoFilled = null;
        $('qrz-pill').classList.add('hidden');
      }
      qrzLookupTimer = setTimeout(() => triggerQRZLookup(call), 600);
    } else {
      clearQRZInfo();
    }

    updateNrPreview();
  });

  // On blur, cancel any pending debounced lookup and fire one immediately for the
  // final callsign value so a quick-typed call that wasn't yet looked up gets resolved.
  $('q-call').addEventListener('blur', () => {
    const call = $('q-call').value.trim().toUpperCase();
    if (!call || call.length < 3) return;
    clearTimeout(qrzLookupTimer);
    qrzLookupTimer = null;
    triggerQRZLookup(call);
  });

  // Show the next expected NR as a read-only hint in the nr-sent field for new QSOs.
  // Actual assignment happens server-side at log time — no number is consumed here.
  function updateNrPreview() {
    if (editingQsoId !== null) return; // editing: NR is fixed, already shown
    const maxNr = qsos.reduce((m, q) => Math.max(m, q.nr_sent || 0), 0);
    const next = maxNr + 1;
    const preview = me && me.contest_nr_padded ? String(next).padStart(3, '0') : String(next);
    const field = $('q-nr-sent');
    field.placeholder = preview;
    // Refresh the field if empty OR if it still holds the auto-filled preview from
    // a prior state — otherwise a delete/insert elsewhere leaves a stale number
    // (e.g. field shows 11 after #11 was deleted).  Operator-typed values are
    // preserved (nrSentAutoFilled is cleared by the input listener).
    if (!field.value || nrSentAutoFilled) {
      field.value = preview;
      nrSentAutoFilled = true;
    }
  }
  $('q-nr-sent').addEventListener('input', () => { nrSentAutoFilled = false; });

  function loadQsoIntoForm(q) {
    editingQsoId = q.id;
    $('q-call').value = q.callsign;
    $('q-name').value = q.name || '';
    $('q-nr-rcvd').value = q.nr_received || '';
    $('q-nr-sent').value = q.nr_sent || '';
    // Sent NR is server-assigned and immutable — a UI edit would be silently
    // dropped by the backend, so we visibly disable the field during editing
    // and re-enable it in cancelQsoEdit() when the form returns to New-QSO
    // mode.
    $('q-nr-sent').readOnly = true;
    $('q-mode').value = q.mode;
    $('q-band').value = q.band;
    $('q-freq').value = q.freq_hz ? hzToDisplay(q.freq_hz) : '';
    $('q-rst-sent').value = q.rst_sent || '';
    $('q-rst-rcvd').value = q.rst_received || '';
    $('q-dok').value = q.dok || '';
    $('q-loc').value = q.locator || '';
    $('q-itu').value = q.itu_zone || '';
    $('q-cq').value = q.cq_zone || '';
    $('q-lh').value = q.lighthouse || '';
    $('q-notes').value = q.notes || '';
    const qTime = new Date(q.time);
    // datetime-local needs "YYYY-MM-DDTHH:MM" without a Z. Show the value in
    // the operator's chosen frame: UTC by default, or browser-local time
    // when time_input_mode is "local" (FR #29).
    $('q-time').value = (me?.time_input_mode === 'local')
      ? localDateTimeInputValue(qTime)
      : qTime.toISOString().substring(0, 16);
    // Restore custom-field values from q.extras (JSON object keyed by field name).
    if (q.extras) {
      try { applyCustomFieldsValues(JSON.parse(q.extras)); } catch {}
    }
    $('log-qso-btn').textContent = t('qso.saveEdit');
    // In read-only mode (closed contest) the mask is used purely for
    // inspection — the save button is disabled by applyContestReadonly()
    // and the panel title reflects that we're only viewing, not editing.
    $('entry-panel-title').textContent = contestIsOpen() ? t('qso.editQSO') : t('qso.viewQSO');
    callsignFilter = null;
    renderQsos();
    updateDuplicateBadge();
    updateOobBadge();
    updateCallCountry(q.callsign);
    currentTargetLocator = q.locator || null;
    updateMap();
    renderBandPills();
    $('q-call').focus();
    $('q-call').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function cancelQsoEdit() {
    editingQsoId = null;
    // Re-enable q-nr-sent — loadQsoIntoForm locks it during editing because
    // the backend refuses nr_sent updates (it's server-assigned at insert).
    $('q-nr-sent').readOnly = false;
    ['q-call','q-name','q-nr-rcvd','q-nr-sent','q-dok','q-loc','q-itu','q-cq','q-lh','q-notes','q-time'].forEach(id => $(id).value = '');
    clearQRZInfo();
    currentTargetLocator = null;
    callsignFilter = null;
    updateDuplicateBadge();
    updateOobBadge();
    renderQsos();
    updateNrPreview();
    $('log-qso-btn').textContent = t('qso.logQSO');
    $('entry-panel-title').textContent = t('qso.newQSO');
    $('q-call').focus();
    renderBandPills();
    // Collapse the mobile "More fields" expansion after each entry.
    if (document.body.classList.contains('mobile-mode')) {
      document.body.classList.remove('show-all-fields');
      const mfBtn = $('more-fields-btn');
      if (mfBtn) {
        const span = mfBtn.querySelector('span') || mfBtn;
        span.textContent = t('qso.moreFields');
        mfBtn.setAttribute('data-i18n', 'qso.moreFields');
      }
    }
  }

  $('cancel-edit-btn').addEventListener('click', cancelQsoEdit);

  // ----- QSO entry -----
  $('qso-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!contestIsOpen()) return;
    const body = {
      callsign: $('q-call').value.trim().toUpperCase(),
      name: $('q-name').value.trim(),
      nr_received: parseInt($('q-nr-rcvd').value || '0', 10) || 0,
      nr_sent: editingQsoId !== null ? (parseInt($('q-nr-sent').value || '0', 10) || 0) : 0,
      mode: $('q-mode').value,
      band: $('q-band').value,
      freq_hz: displayToHz($('q-freq').value || '0'),
      rst_sent: $('q-rst-sent').value.trim() || $('q-rst-sent').placeholder,
      rst_received: $('q-rst-rcvd').value.trim() || $('q-rst-rcvd').placeholder,
      dok: $('q-dok').value.trim().toUpperCase(),
      locator: $('q-loc').value.trim().toUpperCase(),
      itu_zone: $('q-itu').value.trim(),
      cq_zone: $('q-cq').value.trim(),
      lighthouse: $('q-lh').value.trim(),
      notes: $('q-notes').value.trim(),
    };
    const qTimeRaw = $('q-time').value;
    if (qTimeRaw) {
      // datetime-local emits "YYYY-MM-DDTHH:MM" (or :SS); see FR #29.
      // If the operator picked "local" mode in Personal Settings, treat the
      // raw value as browser-local time (new Date() without 'Z' uses the
      // local zone) and convert to UTC for storage. Otherwise — and by
      // default — the value is already UTC and we just append 'Z'.
      const treatAsLocal = me?.time_input_mode === 'local';
      body.time = treatAsLocal
        ? new Date(qTimeRaw).toISOString()
        : new Date(qTimeRaw + 'Z').toISOString();
    }
    // Custom fields: enforce mandatory ones and attach to body.extras as a JSON string.
    const cfResult = collectCustomFieldsValues();
    if (cfResult.error) {
      $('qso-error').textContent = cfResult.error;
      return;
    }
    if (cfResult.values && Object.keys(cfResult.values).length) {
      body.extras = JSON.stringify(cfResult.values);
    }

    // Frequency must fall inside the selected band's range.  bandFromFreqKHz()
    // also auto-snaps the band on freq input — this catches the case where the
    // operator typed a freq, then manually switched the band to something else,
    // or pasted a freq that isn't on any amateur band at all.
    const freqRaw = $('q-freq').value.trim();
    if (freqRaw) {
      const freqKHz = displayToKHz(freqRaw);
      if (freqKHz > 0) {
        const derivedBand = bandFromFreqKHz(freqKHz);
        if (!derivedBand) {
          $('qso-error').textContent = t('qso.freqNoBand', { freq: freqRaw, unit: contestFreqUnit() });
          return;
        }
        if (body.band && derivedBand !== body.band) {
          $('qso-error').textContent = t('qso.freqBandMismatch', { freq: freqRaw, unit: contestFreqUnit(), band: fmtBand(body.band) });
          return;
        }
      }
    }

    $('qso-error').textContent = '';

    if (editingQsoId !== null) {
      if (!await showConfirm(t('qso.confirmSaveEdit'), { ok: t('qso.confirmSave'), safe: true })) return;
      const res = await api('/api/qsos/' + editingQsoId, { method: 'PUT', body: JSON.stringify(body) });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        $('qso-error').textContent = j.error || t('qso.updateFail');
        return;
      }
      const updated = await res.json();
      const idx = qsos.findIndex(q => q.id === editingQsoId);
      if (idx !== -1) qsos[idx] = updated;
      cancelQsoEdit();
      return;
    }

    // Soft-lock: warn if another op is already on the selected band
    const selectedBand = body.band;
    const busyOpsOnBand = currentBandOps[selectedBand] || [];
    if (busyOpsOnBand.length > 0) {
      if (!await showConfirm(t('ops.bandBusyConfirm', { band: fmtBand(selectedBand), ops: busyOpsOnBand.map(fmtCall).join(', ') }), { ok: t('qso.confirmLogAnyway') })) return;
    }

    let res = await api('/api/qsos', { method: 'POST', body: JSON.stringify(body) });
    if (res.status === 409) {
      if (!await showConfirm(t('qso.confirmDuplicate'), { ok: t('qso.confirmLogAnyway') })) return;
      res = await api('/api/qsos?force=1', { method: 'POST', body: JSON.stringify(body) });
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('qso-error').textContent = j.error || t('qso.saveFail');
      return;
    }
    ['q-call','q-name','q-nr-rcvd','q-nr-sent','q-dok','q-loc','q-itu','q-cq','q-lh','q-notes','q-time'].forEach(id => $(id).value = '');
    clearQRZInfo();
    currentTargetLocator = null;
    callsignFilter = null;
    updateDuplicateBadge();
    updateOobBadge();
    renderQsos();
    updateNrPreview();
    $('q-call').focus();
  });

  // ----- rig selection / rig list -----
  function applySelectedRigToForm() {
    const r = rigs.find(x => x.name === me?.selected_rig);
    if (r && r.connected) {
      $('q-freq').value = hzToDisplay(r.freq_hz);
      if (r.band) $('q-band').value = r.band;
      updateOobBadge();
    }
  }
  function renderRigSelect() {
    const sel = $('rig-select');
    const cur = me?.selected_rig || '';
    sel.innerHTML = '<option value="">' + escHtml(t('qso.rigNone')) + '</option>';
    for (const r of rigs) {
      const o = document.createElement('option');
      o.value = r.name;
      let label = r.name;
      if (r.connected) label += ` — ${(r.freq_hz/1_000_000).toFixed(4)} MHz ${r.mode}`;
      else label += ' — disconnected';
      const others = (r.in_use_by || []).filter(c => c !== me?.callsign);
      if (others.length) label += ` (in use by ${others.map(fmtCall).join(', ')})`;
      o.textContent = label;
      if (r.name === cur) o.selected = true;
      sel.appendChild(o);
    }
    const r = rigs.find(x => x.name === cur);
    $('rig-bar-detail').textContent = r
      ? (r.connected
          ? `${(r.freq_hz/1_000_000).toFixed(4)} MHz · ${r.mode || ''} · ${fmtBand(r.band || '')}`
          : (r.error || t('ops.rigOfflineShort')))
      : '';
    updateRigStatusPill();
  }
  $('rig-select').addEventListener('change', async (e) => {
    const name = e.target.value;
    const res = await api('/api/rigs/select', { method: 'POST', body: JSON.stringify({ name }) });
    if (res.ok) {
      const j = await res.json();
      if (me) me.selected_rig = j.selected_rig || '';
      renderRigSelect();
      renderRigList();
      applySelectedRigToForm();
    }
  });
  function renderRigList() {
    const list = $('rig-list');
    list.innerHTML = '';
    if (rigs.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = t('ops.noHelpers');
      li.style.cursor = 'default';
      list.appendChild(li);
      return;
    }
    for (const r of rigs) {
      const li = document.createElement('li');
      if (r.name === me?.selected_rig) li.classList.add('selected');
      const data = r.connected
        ? `${escHtml((r.freq_hz/1_000_000).toFixed(4))} MHz · ${escHtml(r.mode || '-')} · ${escHtml(fmtBand(r.band || ''))}`
        : t('ops.rigDisconnected');
      const inUse = (r.in_use_by || []);
      const otherContests = (r.other_contests || []);
      let useLine = '';
      if (inUse.length) {
        useLine = `<div class="in-use">${escHtml(t('ops.inUseBy', { who: inUse.map(fmtCall).join(', ') }))}</div>`;
      }
      if (otherContests.length) {
        useLine += `<div class="in-use-other">${escHtml(t('ops.alsoIn', { list: otherContests.join(', ') }))}</div>`;
      }
      let errLine = (r.error && !r.connected) ? `<div class="rig-err">rigctld: ${escHtml(r.error)}</div>` : '';
      const displayName = r.dummy ? `${escHtml(r.name)} <span class="dummy-badge">${escHtml(t('globalSettings.dummyMarkedAs'))}</span>` : escHtml(r.name);
      li.innerHTML = `<div class="rig-name">${displayName}</div>
                     <div class="rig-data">${data}</div>${useLine}${errLine}`;
      li.addEventListener('click', async () => {
        const target = (r.name === me?.selected_rig) ? '' : r.name;
        const res = await api('/api/rigs/select', { method: 'POST', body: JSON.stringify({ name: target }) });
        if (res.ok) {
          const j = await res.json();
          if (me) me.selected_rig = j.selected_rig || '';
          renderRigSelect();
          renderRigList();
          applySelectedRigToForm();
        }
      });
      list.appendChild(li);
    }
  }
  function updateRigStatusPill() {
    const el = $('rig-status');
    el.classList.remove('ok', 'err');
    const detail = el.querySelector('.rig-detail');
    const cur = me?.selected_rig;
    if (!cur) { detail.textContent = t('topbar.rigNoneSelected'); return; }
    const r = rigs.find(x => x.name === cur);
    if (!r) { detail.textContent = t('ops.rigOffline', { name: cur }); return; }
    if (r.connected) {
      el.classList.add('ok');
      detail.textContent = t('ops.rigConnected', { name: cur, mhz: (r.freq_hz/1_000_000).toFixed(4) });
    } else {
      el.classList.add('err');
      detail.textContent = t('ops.rigError', { name: cur, err: r.error || t('ops.rigDisconnected') });
    }
  }

  // ----- operators panel -----
  function renderOperators() {
    const list = $('ops-list');
    list.innerHTML = '';
    const canRelease = hasPerm('rig.release');
    // Build band → callsigns map across all operators.
    const bandMap = {};
    for (const op of operators) {
      const rigForOp = rigs.find(r => Array.isArray(r.in_use_by) && r.in_use_by.includes(op.callsign));
      const band = op.band || (rigForOp ? rigForOp.band : '');
      if (band) {
        if (!bandMap[band]) bandMap[band] = [];
        bandMap[band].push(op.callsign);
      }
    }
    const conflictBands = Object.keys(bandMap).filter(b => bandMap[b].length > 1);

    for (const op of operators) {
      const li = document.createElement('li');
      const rigForOp = rigs.find(r => Array.isArray(r.in_use_by) && r.in_use_by.includes(op.callsign));
      const rigName = (op.rig && rigForOp) ? rigForOp.name : (op.rig || (rigForOp ? rigForOp.name : ''));
      // Prefer the band reported by the server (op.band derives from the helper-reported rig
      // band) and fall back to what the rig list says.
      const band = op.band || (rigForOp ? rigForOp.band : '');
      let label = fmtCall(op.callsign);
      if (rigName) label += ' · ' + rigName;
      if (band) label += ' (' + fmtBand(band) + ')';
      const span = document.createElement('span');
      span.textContent = label;
      li.appendChild(span);
      if (me && op.callsign === me.callsign) li.classList.add('me');
      // Allow admins with rig.release to forcibly release another op's rig.
      if (canRelease && rigName && me && op.callsign !== me.callsign) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'op-release-btn';
        btn.title = t('ops.releaseRigTitle', { rig: rigName, call: op.callsign });
        btn.textContent = '✕';
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!await showConfirm(t('ops.releaseRigQ', { rig: rigName, call: op.callsign }), { ok: t('ops.release') })) return;
          await api('/api/rigs/release', { method: 'POST', body: JSON.stringify({ callsign: op.callsign }) });
        });
        li.appendChild(btn);
      }
      list.appendChild(li);
    }

    // Band-conflict stripe.
    const banner = $('band-conflict-banner');
    if (banner) {
      if (conflictBands.length > 0) {
        banner.innerHTML = conflictBands
          .map(b => `<div>${escHtml(t('ops.multipleOnBand', { band: fmtBand(b) }))}</div>`)
          .join('');
        banner.classList.remove('hidden');
      } else {
        banner.classList.add('hidden');
      }
    }
  }

  // ----- QSO history table -----
  let qsoSortCol = 'nr_sent';
  let qsoSortDir = -1; // 1 = asc, -1 = desc, 0 = off

  function updateSortHeaders() {
    document.querySelectorAll('#qso-table thead th.sortable').forEach(th => {
      const col = th.dataset.col;
      const arrow = th.querySelector('.sort-arrow');
      if (col === qsoSortCol && qsoSortDir !== 0) {
        th.classList.add('sort-active');
        arrow.textContent = qsoSortDir === 1 ? ' ▲' : ' ▼';
      } else {
        th.classList.remove('sort-active');
        arrow.textContent = '';
      }
    });
  }

  document.querySelector('#qso-table thead').addEventListener('click', e => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const col = th.dataset.col;
    if (qsoSortCol !== col) { qsoSortCol = col; qsoSortDir = 1; }
    else {
      if (qsoSortDir === 1) qsoSortDir = -1;
      else if (qsoSortDir === -1) qsoSortDir = 0;
      else qsoSortDir = 1;
    }
    updateSortHeaders();
    renderQsos();
  });

  // ----- log column definitions & helpers -----
  const LOG_COL_DEFS = [
    { key: 'nr_sent',      labelKey: 'qso.colNr',      sortKey: 'nr_sent',      defaultOn: true  },
    { key: 'time',         labelKey: 'qso.colTimeUTC',  sortKey: 'time',         defaultOn: true  },
    { key: 'callsign',     labelKey: 'qso.colCall',     sortKey: 'callsign',     defaultOn: true  },
    { key: 'band',         labelKey: 'qso.colBand',     sortKey: 'band',         defaultOn: true  },
    { key: 'freq',         labelKey: 'qso.colFreq',     sortKey: 'freq_hz',      defaultOn: true  },
    { key: 'mode',         labelKey: 'qso.colMode',     sortKey: 'mode',         defaultOn: true  },
    { key: 'rst_sent',     labelKey: 'qso.colSent',     sortKey: 'rst_sent',     defaultOn: true  },
    { key: 'rst_received', labelKey: 'qso.colRcv',      sortKey: 'rst_received', defaultOn: true  },
    { key: 'nr_received',  labelKey: 'qso.nrReceived',  sortKey: 'nr_received',  defaultOn: false },
    { key: 'name',         labelKey: 'qso.name',        sortKey: 'name',         defaultOn: false },
    { key: 'locator',      labelKey: 'qso.colLoc',      sortKey: 'locator',      defaultOn: true  },
    { key: 'distance',     labelKey: 'qso.colDistance', sortKey: 'locator',      defaultOn: false },
    { key: 'itu',          labelKey: 'qso.colItuCQ',    sortKey: 'itu_zone',     defaultOn: true  },
    { key: 'dok',          labelKey: 'qso.dok',         sortKey: 'dok',          defaultOn: false },
    { key: 'lighthouse',   labelKey: 'qso.lighthouse',  sortKey: 'lighthouse',   defaultOn: false },
    { key: 'notes',        labelKey: 'qso.notes',       sortKey: 'notes',        defaultOn: false },
    { key: 'operator',     labelKey: 'qso.colOp',       sortKey: 'operator',     defaultOn: true  },
  ];

  function parseLogColumns(json) {
    if (!json) return null;
    try { const a = JSON.parse(json); return Array.isArray(a) ? a : null; } catch { return null; }
  }

  function getEffectiveLogCols(savedJson, customFields) {
    const saved = parseLogColumns(savedJson);
    const cfDefs = (customFields || []).map(f => ({ key: f.name, label: f.label || f.name, isCustom: true, sortKey: null, defaultOn: false }));
    const allDefs = [...LOG_COL_DEFS, ...cfDefs];
    if (!saved || !saved.length) return allDefs.map(d => ({ ...d, on: d.defaultOn !== false }));
    const result = [];
    const seen = new Set();
    for (const s of saved) {
      const def = allDefs.find(d => d.key === s.key);
      if (def) { result.push({ ...def, on: s.on !== false }); seen.add(s.key); }
    }
    for (const d of allDefs) {
      if (!seen.has(d.key)) result.push({ ...d, on: d.defaultOn !== false });
    }
    return result;
  }

  function qsoColValue(q, key, extras) {
    switch (key) {
      case 'nr_sent':      return escHtml(q.nr_sent ? (me?.contest_nr_padded ? String(q.nr_sent).padStart(3,'0') : String(q.nr_sent)) : '');
      case 'time':         return escHtml(new Date(q.time).toISOString().substring(0,19).replace('T',' '));
      case 'callsign':     return `<strong>${escHtml(fmtCall(q.callsign))}</strong>`;
      case 'band':         return escHtml(fmtBand(q.band || ''));
      case 'freq':         return escHtml(q.freq_hz ? hzToDisplay(q.freq_hz) : '');
      case 'mode':         return escHtml(q.mode || '');
      case 'rst_sent':     return escHtml(q.rst_sent || '');
      case 'rst_received': return escHtml(q.rst_received || '');
      case 'nr_received':  return escHtml(q.nr_received ? String(q.nr_received) : '');
      case 'name':         return escHtml(q.name || '');
      case 'locator':      return escHtml(q.locator || '');
      case 'distance': {
        // Great-circle km from the station QTH to the QSO's locator,
        // shown as a per-row column (FR #60c). Empty when either side
        // lacks a usable locator — the bearing panel already handles
        // the same missing-data case for the live target.
        if (!q.locator) return '';
        const myLoc = me?.contest_qth || null;
        if (!myLoc) return '';
        const a = locatorToLatLon(myLoc);
        const b = locatorToLatLon(q.locator);
        if (!a || !b) return '';
        return escHtml(Math.round(distanceTo(a.lat, a.lon, b.lat, b.lon)) + ' km');
      }
      case 'itu':          return (q.itu_zone||q.cq_zone) ? `${escHtml(q.itu_zone||'-')}/${escHtml(q.cq_zone||'-')}` : '';
      case 'dok':          return escHtml(q.dok || '');
      case 'lighthouse':   return escHtml(q.lighthouse || '');
      case 'notes':        return escHtml(q.notes || '');
      case 'operator':     return escHtml(fmtCall(q.operator));
      default:             return escHtml(extras?.[key] || '');
    }
  }

  function renderLogHeaders() {
    const customFields = parseCustomFields(me?.contest_fields);
    const cols = getEffectiveLogCols(me?.contest_log_columns, customFields).filter(c => c.on !== false);
    const tr = document.querySelector('#qso-table thead tr');
    if (!tr) return;
    tr.innerHTML = cols.map(col => {
      let label = col.isCustom ? escHtml(col.label || col.key) : escHtml(t(col.labelKey));
      if (col.key === 'freq') label = escHtml(t('qso.colFreq') + ' (' + contestFreqUnit() + ')');
      const sortKey = col.sortKey || col.key;
      return `<th class="sortable" data-col="${escHtml(sortKey)}"><span>${label}</span> <span class="sort-arrow"></span></th>`;
    }).join('') + '<th></th>';
    updateSortHeaders();
  }

  // Per-field filter matcher for the QSO history search box. The old
  // implementation concatenated every field into one haystack and substring-
  // matched, which produced a subtle false positive: the operator's own
  // callsign (e.g. "DL8AA") sits on every QSO they log, so filtering for
  // "DL" matched *every* row via the operator field, looking like the filter
  // had silently failed (FR #59, reported by dl8aa). Filters for "DD" or
  // "DJ" worked because those substrings are absent from "DL8AA".
  //
  // The replacement matches each space-separated token against the QSO's
  // fields independently:
  //   - callsign / band / mode / locator / DOK: prefix match (handles the
  //     common case of typing a country/region prefix, a band like "40",
  //     a mode like "FT8", etc.)
  //   - operator: exact full-string match only, so a 2-character prefix
  //     does not turn the operator into a universal match.
  function qsoMatchesFilter(q, filter) {
    const tokens = filter.split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const call = (q.callsign || '').toLowerCase();
    const band = (q.band || '').toLowerCase();
    const bandFmt = fmtBand(q.band || '').toLowerCase();
    const mode = (q.mode || '').toLowerCase();
    const locator = (q.locator || '').toLowerCase();
    const dok = (q.dok || '').toLowerCase();
    const operator = (q.operator || '').toLowerCase();
    return tokens.every(tok =>
      call.startsWith(tok) ||
      band.startsWith(tok) ||
      bandFmt.startsWith(tok) ||
      mode.startsWith(tok) ||
      locator.startsWith(tok) ||
      dok.startsWith(tok) ||
      operator === tok
    );
  }

  function renderQsos(highlightId) {
    if ($('tab-statistics')?.classList.contains('active')) renderStatistics();
    renderLogHeaders();
    const customFields = parseCustomFields(me?.contest_fields);
    const cols = getEffectiveLogCols(me?.contest_log_columns, customFields).filter(c => c.on !== false);
    const textFilter = $('history-filter').value.trim().toLowerCase();
    const tbody = $('qso-tbody');
    tbody.innerHTML = '';
    let shown = 0;

    let source = qsos;
    let csFiltered = false;
    if (callsignFilter) {
      const matches = qsos.filter(q => q.callsign === callsignFilter);
      if (matches.length > 0) { source = matches; csFiltered = true; }
    }

    if (qsoSortDir !== 0) {
      source = [...source].sort((a, b) => {
        let av = a[qsoSortCol] ?? '';
        let bv = b[qsoSortCol] ?? '';
        if (typeof av === 'number' && typeof bv === 'number') return qsoSortDir * (av - bv);
        return qsoSortDir * String(av).localeCompare(String(bv), undefined, { numeric: true });
      });
    }

    for (const q of source) {
      if (textFilter && !qsoMatchesFilter(q, textFilter)) continue;
      const tr = document.createElement('tr');
      if (q.id === highlightId) tr.classList.add('fresh');
      tr.className = (q.id === editingQsoId) ? 'editing-row' : '';
      tr.style.cursor = 'pointer';
      let extras = {};
      if (q.extras) { try { extras = JSON.parse(q.extras); } catch {} }
      const canDelRow = canEditQSO(q);
      tr.innerHTML = cols.map(col => `<td>${qsoColValue(q, col.key, extras)}</td>`).join('')
        + `<td>${canDelRow ? `<button class="del-btn" data-id="${Number(q.id)}">✕</button>` : ''}</td>`;
      tr.addEventListener('click', (e) => {
        if (e.target.closest('.del-btn')) return;
        const writable = canEditQSO(q);
        // Read-only inspect (FR #62): show QRZ photo *and* the rest of the
        // detail panel — country flag, locator, distance — for the clicked
        // station, even when the contest is finished. We populate the QSO
        // mask so `triggerQRZLookup`'s staleness guard (which compares the
        // fresh lookup's callsign against #q-call.value) accepts the reply;
        // applyContestReadonly() has already disabled every form field and
        // the save button, so the mask stays strictly non-editable.
        cancelQsoEdit();
        clearLeftPanel();
        triggerQRZLookup(q.callsign);
        loadQsoIntoForm(q);
        if (!writable) applyContestReadonly();
      });
      tbody.appendChild(tr);
      shown++;
    }
    const filterParts = [];
    if (csFiltered) filterParts.push(t('qso.filterWith', { call: callsignFilter }));
    if (textFilter) filterParts.push(t('qso.filterFrom', { n: qsos.length }));
    const base = shown === 1 ? t('qso.count', { n: shown }) : t('qso.countPlural', { n: shown });
    $('qso-count').textContent = filterParts.length ? `${base} (${filterParts.join(', ')})` : base;
    updateFilterClearPill();
  }
  function updateFilterClearPill() {
    const pill = $('history-filter-clear');
    if (!pill) return;
    const hasText = !!$('history-filter').value.trim();
    const active = hasText || !!callsignFilter;
    pill.classList.toggle('hidden', !active);
  }
  $('history-filter').addEventListener('input', () => renderQsos());
  $('history-filter-clear').addEventListener('click', () => {
    $('history-filter').value = '';
    callsignFilter = null;
    renderQsos();
  });
  $('qso-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('.del-btn');
    if (!btn) return;
    if (!contestIsOpen()) return;
    const id = parseInt(btn.dataset.id, 10);
    // Server also enforces this, but re-checking here avoids a wasted
    // round-trip when the row's operator_user_id doesn't match a logger
    // caller (e.g. someone stale-clicking a button that should have been
    // hidden by the last renderQsos()).
    const row = qsos.find(q => q.id === id);
    if (!canEditQSO(row)) return;
    if (!await showConfirm(t('qso.deleteConfirm'), { ok: t('common.delete') })) return;
    const res = await api('/api/qsos/' + id, { method: 'DELETE' });
    if (res.ok) { qsos = qsos.filter(q => q.id !== id); renderQsos(); }
  });

  // ----- settings -----
  function isChatSoundMuted() {
    return localStorage.getItem('chatSoundMuted') === '1';
  }
  function setChatSoundMuted(muted) {
    localStorage.setItem('chatSoundMuted', muted ? '1' : '0');
    const cb = $('s-chat-mute');
    if (cb) cb.checked = muted;
    updateMsChatMutePill();
  }
  function updateMsChatMutePill() {
    const pill = $('ms-chat-mute-pill');
    if (!pill) return;
    const muted = isChatSoundMuted();
    pill.textContent = muted ? t('contestScreen.chatSoundsOff') : t('contestScreen.chatSoundsOn');
    pill.classList.toggle('active', muted);
  }

  // Same dirty-tracking trick as the global-settings page: remember the QRZ
  // username loaded from the server, so save can skip sending the QRZ fields
  // when the operator did not touch them.
  let _sQrzLoadedUser = '';
  async function loadSettings() {
    const res = await api('/api/settings');
    if (!res.ok) return;
    settings = await res.json();
    fillSelect($('s-mode'), MODES, settings.default_mode || 'SSB');
    fillSelect($('s-band'), BANDS, settings.default_band || '20m', fmtBand);
    $('s-token').value = me?.helper_token || '';
    $('hint-token').textContent = me?.helper_token || '...';
    $('hint-server').textContent = location.origin;
    if ('qrz_username' in settings) {
      _sQrzLoadedUser = settings.qrz_username || '';
      $('s-qrz-user').value = _sQrzLoadedUser;
      $('qrz-status').textContent = settings.qrz_configured
        ? t('settings.qrzConfigured')
        : t('settings.qrzNotConfigured');
    }
    const cb = $('s-chat-mute');
    if (cb) cb.checked = isChatSoundMuted();
    const dm = $('s-display-mode');
    if (dm) dm.value = localStorage.getItem(DISPLAY_MODE_KEY) || 'auto';
    loadDummyRigs();
  }
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('settings-error').textContent = '';
    const body = {
      default_mode: $('s-mode').value,
      default_band: $('s-band').value,
    };
    const qrzUser = $('s-qrz-user')?.value?.trim() || '';
    const qrzPass = $('s-qrz-pass')?.value || '';
    if (qrzUser !== _sQrzLoadedUser) body.qrz_username = qrzUser;
    if (qrzPass !== '') body.qrz_password = qrzPass;
    const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('settings-error').textContent = j.error || t('common.saveFailed');
      return;
    }
    if ($('s-qrz-pass')) $('s-qrz-pass').value = '';
    const cb = $('s-chat-mute');
    if (cb) setChatSoundMuted(cb.checked);
    await loadSettings();
    applyDefaults();
  });
  {
    const cb = $('s-chat-mute');
    if (cb) cb.addEventListener('change', () => setChatSoundMuted(cb.checked));
  }
  {
    const dm = $('s-display-mode');
    if (dm) dm.addEventListener('change', () => {
      const v = dm.value;
      if (v === 'auto') localStorage.removeItem(DISPLAY_MODE_KEY);
      else localStorage.setItem(DISPLAY_MODE_KEY, v);
      applyMobileMode();
    });
  }
  $('ms-chat-mute-pill')?.addEventListener('click', () => setChatSoundMuted(!isChatSoundMuted()));
  $('qrz-test-btn').addEventListener('click', async () => {
    const username = $('s-qrz-user').value.trim();
    const password = $('s-qrz-pass').value;
    if (!username) {
      $('qrz-status').textContent = t('settings.qrzEnterUsername');
      $('qrz-status').style.color = 'var(--error)';
      return;
    }
    $('qrz-test-btn').disabled = true;
    $('qrz-status').textContent = t('settings.qrzTesting');
    $('qrz-status').style.color = '';
    const res = await api('/api/qrz/test', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    $('qrz-test-btn').disabled = false;
    const j = await res.json().catch(() => ({}));
    if (j.ok) {
      $('qrz-status').textContent = t('settings.qrzConnected', { name: j.name || t('settings.qrzNoName') });
      $('qrz-status').style.color = 'var(--success)';
    } else {
      $('qrz-status').textContent = t('settings.qrzFailed', { err: j.error || t('common.unknownError') });
      $('qrz-status').style.color = 'var(--error)';
    }
  });
  $('regen-token').addEventListener('click', async () => {
    if (!await showConfirm(t('settings.regenConfirm'), { ok: t('settings.regenButton') })) return;
    const res = await api('/api/me/helper-token', { method: 'POST' });
    if (res.ok) {
      const j = await res.json();
      if (j.helper_token) {
        if (me) me.helper_token = j.helper_token;
        $('s-token').value = j.helper_token;
        $('hint-token').textContent = j.helper_token;
      }
    }
  });
  $('copy-token').addEventListener('click', () => {
    const v = $('s-token').value;
    if (!v) return;
    navigator.clipboard.writeText(v).catch(() => {});
  });
  $('own-pwd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('op-error').textContent = '';
    const body = { Old: $('op-old').value, New: $('op-new').value };
    const res = await api('/api/me/password', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('op-error').textContent = j.error || t('settings.pwdChangeFail');
      return;
    }
    $('op-old').value = ''; $('op-new').value = '';
    $('op-error').textContent = t('settings.pwdChanged');
    $('op-error').style.color = 'var(--success)';
  });

  // ----- My Settings screen (accessible from contest picker) -----
  async function loadMySettings() {
    const res = await api('/api/settings');
    if (!res.ok) return;
    const s = await res.json();
    fillSelect($('ms-mode'), MODES, s.default_mode || 'SSB');
    fillSelect($('ms-band'), BANDS, s.default_band || '20m', fmtBand);
    const timeSel = $('ms-time-input-mode');
    if (timeSel) timeSel.value = (me?.time_input_mode === 'local') ? 'local' : 'utc';
    const themeSel = $('ms-theme');
    if (themeSel) themeSel.value = (me?.theme === 'light') ? 'light' : 'dark';
    const tokenInput = $('ms-token');
    if (tokenInput) tokenInput.value = me?.helper_token || '';
    const tokenHint = $('ms-hint-token');
    if (tokenHint) tokenHint.textContent = me?.helper_token || '...';
    const serverHint = $('ms-hint-server');
    if (serverHint) serverHint.textContent = location.origin;
    updateMsChatMutePill();
    applyPermissionsToUI();
    loadMyPasskeys();
    loadMyCallsignRequest();
  }

  // ----- WSJT-X bridge token ---------------------------------------------
  // The bridge accepts a copy-pasteable blob that packs four pieces of
  // config into one string: the server URL, the operator's helper token,
  // the contest ID to log QSOs into, and the contest's expected station
  // callsign.  The station_call ("sc") lets the Qt bridge silently drop
  // LOG_QSO datagrams that came from a WSJT-X session configured for a
  // different callsign, so an operator who forgot to switch the token
  // between contests doesn't pollute the wrong log.  The server checks
  // the same field on every submission as a safety net.
  //
  // The token is a per-contest artifact (each contest gets a different
  // blob because `c` + `sc` are baked in) so the UI lives as a per-
  // contest action, not a personal setting.  It confers no more access
  // than the operator already has — the server enforces per-contest
  // write permission on every submission, exactly like the browser flow.
  function encodeWsjtxToken({ server, helper_token, contest_id, station_call }) {
    const payload = { s: server, t: helper_token, c: contest_id };
    if (station_call) payload.sc = station_call;
    // Standard base64url (no padding) — mirrors the encoding the Qt
    // bridge uses when decoding.
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return 'noc1.' + b64;
  }
  $('ms-regen-token')?.addEventListener('click', async () => {
    if (!await showConfirm(t('settings.regenConfirm'), { ok: t('settings.regenButton') })) return;
    const res = await api('/api/me/helper-token', { method: 'POST' });
    if (!res.ok) return;
    const j = await res.json();
    if (!j.helper_token) return;
    if (me) me.helper_token = j.helper_token;
    $('ms-token').value = j.helper_token;
    $('ms-hint-token').textContent = j.helper_token;
    // Keep the legacy tab-settings inputs in sync for any code path that still reads them.
    if ($('s-token')) $('s-token').value = j.helper_token;
    if ($('hint-token')) $('hint-token').textContent = j.helper_token;
    // Regenerating the helper token invalidates every previously-issued
    // WSJT-X bridge token, since each blob embeds it. The per-contest
    // token modal recomputes on open, so nothing else to refresh here.
  });
  $('ms-copy-token')?.addEventListener('click', () => {
    const input = $('ms-token');
    if (!input || !input.value) return;
    input.select();
    try { document.execCommand('copy'); } catch (_) {}
    if (navigator.clipboard) navigator.clipboard.writeText(input.value).catch(() => {});
  });
  $('ms-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('ms-settings-error').textContent = '';
    // The default_mode / default_band selects are GLOBAL settings; only
    // operators with settings.write may persist them. Regular users still
    // see this form because it also holds per-user prefs (time input,
    // theme) — so we skip the /api/settings PUT silently for them rather
    // than 403'ing the whole save. The selects themselves are hidden for
    // non-admins via .perm-required on their label so they never reach
    // this branch with stale values.
    if (hasPerm('settings.write')) {
      const body = {
        default_mode: $('ms-mode').value,
        default_band: $('ms-band').value,
      };
      const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        $('ms-settings-error').textContent = j.error || t('common.saveFailed');
        return;
      }
    }
    // Persist the per-user time-input-mode separately — the legacy
    // /api/settings endpoint holds *global* defaults, but date/time
    // interpretation is per-operator (FR #29).
    const timeMode = $('ms-time-input-mode')?.value === 'local' ? 'local' : 'utc';
    if (me && me.time_input_mode !== timeMode) {
      const tr = await api('/api/me/time-input-mode', { method: 'PUT', body: JSON.stringify({ mode: timeMode }) });
      if (tr.ok) {
        me.time_input_mode = timeMode;
        updateQTimeLabel();
      }
    }
    // Same story for the colour-scheme preference (FR #65).
    const theme = $('ms-theme')?.value === 'light' ? 'light' : 'dark';
    if (me && me.theme !== theme) {
      const tr = await api('/api/me/theme', { method: 'PUT', body: JSON.stringify({ theme }) });
      if (tr.ok) {
        me.theme = theme;
        applyTheme(theme);
      }
    }
    await loadSettings();
    applyDefaults();
    $('ms-settings-error').textContent = t('common.saved');
    $('ms-settings-error').style.color = 'var(--success)';
    setTimeout(() => { $('ms-settings-error').textContent = ''; $('ms-settings-error').style.color = ''; }, 2000);
  });
  $('ms-pwd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('ms-op-error').textContent = '';
    const body = { Old: $('ms-op-old').value, New: $('ms-op-new').value };
    const res = await api('/api/me/password', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('ms-op-error').textContent = j.error || t('settings.pwdChangeFail');
      $('ms-op-error').style.color = 'var(--error)';
      return;
    }
    $('ms-op-old').value = ''; $('ms-op-new').value = '';
    $('ms-op-error').textContent = t('settings.pwdChanged');
    $('ms-op-error').style.color = 'var(--success)';
  });
  async function loadMyPasskeys() {
    const el = $('ms-passkey-list');
    if (!el) return;
    const res = await api('/api/passkey/credentials');
    if (!res.ok) return;
    const list = await res.json();
    if (!list || list.length === 0) {
      el.innerHTML = '<p class="muted small">' + escHtml(t('settings.passkeyNoneYet')) + '</p>';
      return;
    }
    el.innerHTML = list.map(pk => {
      const date = pk.created_at ? new Date(pk.created_at).toLocaleDateString(localeForFmt()) : '';
      return `<div class="passkey-item">
        <span class="passkey-name">&#128273; ${escHtml(pk.name || 'Passkey')}</span>
        <span class="muted small">${date}</span>
        <button class="ghost small" data-delete-passkey="${escHtml(pk.id)}">${escHtml(t('common.remove'))}</button>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-delete-passkey]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const credID = btn.dataset.deletePasskey;
        const r = await api('/api/passkey/credentials/' + encodeURIComponent(credID), { method: 'DELETE' });
        if (r.ok || r.status === 204) loadMyPasskeys();
      });
    });
  }
  $('ms-register-passkey-btn').addEventListener('click', async () => {
    $('ms-passkey-error').textContent = '';
    if (!passkeyAvailable()) { $('ms-passkey-error').textContent = t('login.passkeysNeedSecure'); return; }
    const name = encodeURIComponent($('ms-passkey-name').value.trim() || 'Passkey');
    try {
      const beginRes = await api('/api/passkey/register/begin', { method: 'POST' });
      if (!beginRes.ok) { const j = await beginRes.json().catch(() => ({})); throw new Error(j.error || t('settings.passkeyRegFail')); }
      const pk = await beginRes.json();
      pk.publicKey.challenge = fromB64url(pk.publicKey.challenge);
      pk.publicKey.user.id = fromB64url(pk.publicKey.user.id);
      if (pk.publicKey.excludeCredentials) {
        pk.publicKey.excludeCredentials = pk.publicKey.excludeCredentials.map(c => ({ ...c, id: fromB64url(c.id) }));
      }
      const cred = await navigator.credentials.create({ publicKey: pk.publicKey });
      const payload = { id: cred.id, rawId: b64url(cred.rawId), type: cred.type,
        response: { clientDataJSON: b64url(cred.response.clientDataJSON), attestationObject: b64url(cred.response.attestationObject) } };
      const finishRes = await api('/api/passkey/register/finish?name=' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!finishRes.ok) { const j = await finishRes.json().catch(() => ({})); throw new Error(j.error || t('settings.passkeyRegFail')); }
      $('ms-passkey-name').value = '';
      await loadMyPasskeys();
    } catch (err) {
      if (err.name !== 'NotAllowedError') $('ms-passkey-error').textContent = err.message || t('settings.passkeyRegFail');
    }
  });

  // ----- callsign change request (Personal Settings card) -----
  async function loadMyCallsignRequest() {
    const currentBox = $('ms-callsign-current');
    if (currentBox && me) currentBox.textContent = t('callsignRequest.currentCallsign', { call: me.callsign || '' });
    const pendingBox = $('ms-callsign-pending');
    const form = $('ms-callsign-form');
    const errEl = $('ms-callsign-error');
    if (errEl) { errEl.textContent = ''; errEl.style.color = ''; }
    const res = await api('/api/me/callsign-request');
    if (res.status === 204 || !res.ok) {
      pendingBox?.classList.add('hidden');
      if (form) form.classList.remove('hidden');
      return;
    }
    const cr = await res.json();
    if (form) form.classList.add('hidden');
    if (pendingBox) {
      pendingBox.classList.remove('hidden');
      const summary = $('ms-callsign-pending-summary');
      if (summary) summary.textContent = t('callsignRequest.pendingSummary', { from: cr.current_callsign, to: cr.requested_callsign });
      const meta = $('ms-callsign-pending-meta');
      if (meta) {
        const when = cr.created_at ? new Date(cr.created_at).toLocaleString(localeForFmt()) : '';
        meta.textContent = t('callsignRequest.pendingSubmitted', { when });
      }
    }
  }
  $('ms-callsign-withdraw-btn')?.addEventListener('click', async () => {
    if (!await showConfirm(t('callsignRequest.withdrawConfirm'), { ok: t('callsignRequest.withdraw') })) return;
    const res = await api('/api/me/callsign-request', { method: 'DELETE' });
    if (res.ok || res.status === 204) await loadMyCallsignRequest();
  });
  $('ms-callsign-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('ms-callsign-error');
    if (errEl) { errEl.textContent = ''; errEl.style.color = ''; }
    const newCall = ($('ms-callsign-new').value || '').trim().toUpperCase();
    const fileInput = $('ms-callsign-proof');
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!newCall) { errEl.textContent = t('callsignRequest.invalidCallsign'); return; }
    if (me && newCall === (me.callsign || '').toUpperCase()) {
      errEl.textContent = t('callsignRequest.sameAsCurrent');
      return;
    }
    if (!file) { errEl.textContent = t('callsignRequest.proofMissing'); return; }
    if (file.size > 5 * 1024 * 1024) { errEl.textContent = t('callsignRequest.proofTooLarge'); return; }
    const nameLc = (file.name || '').toLowerCase();
    const okExt = nameLc.endsWith('.jpg') || nameLc.endsWith('.jpeg') || nameLc.endsWith('.png') || nameLc.endsWith('.pdf');
    if (!okExt) { errEl.textContent = t('callsignRequest.proofBadType'); return; }
    const fd = new FormData();
    fd.append('callsign', newCall);
    fd.append('proof', file);
    // Bypass the api() helper so we don't force a JSON Content-Type header on
    // this multipart submission; still pass the CSRF cookie ourselves.
    const res = await fetch('/api/me/callsign-request', {
      method: 'POST',
      credentials: 'same-origin',
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
      body: fd,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      errEl.textContent = j.error || t('callsignRequest.submitFailed');
      return;
    }
    $('ms-callsign-new').value = '';
    if (fileInput) fileInput.value = '';
    errEl.textContent = t('callsignRequest.submitted');
    errEl.style.color = 'var(--success)';
    await loadMyCallsignRequest();
  });

  // ----- callsign change request (Admin review screen) -----
  async function refreshCallsignRequests() {
    if (!hasPerm('callsign_requests.review')) return;
    const res = await api('/api/callsign-requests');
    if (!res.ok) return;
    const list = await res.json();
    renderCallsignRequests(Array.isArray(list) ? list : []);
  }
  function renderCallsignRequests(list) {
    const tbody = $('cr-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const count = $('cr-count');
    if (count) {
      const n = list.length;
      if (n === 0) count.textContent = t('callsignRequestsAdmin.noRequests');
      else count.textContent = n === 1 ? t('callsignRequestsAdmin.count', { n }) : t('callsignRequestsAdmin.countPlural', { n });
    }
    for (const cr of list) {
      const tr = document.createElement('tr');
      const when = cr.created_at ? new Date(cr.created_at).toLocaleString(localeForFmt()) : '';
      const statusKey = 'callsignRequestsAdmin.status_' + cr.status;
      const statusLabel = t(statusKey) || cr.status;
      const statusClass = { pending: 'open', approved: 'finished', rejected: 'disabled' }[cr.status] || '';
      let proofCell = '';
      if (cr.status === 'pending') {
        proofCell = `<a href="/api/callsign-requests/${Number(cr.id)}/proof" target="_blank" rel="noopener">${escHtml(t('callsignRequestsAdmin.viewProof'))}</a>`;
      } else {
        proofCell = '<span class="muted small">—</span>';
      }
      let actionsCell = '';
      if (cr.status === 'pending') {
        actionsCell = `<button class="primary cr-approve-btn" data-id="${Number(cr.id)}" style="width:auto;font-size:12px;padding:4px 10px">${escHtml(t('callsignRequestsAdmin.approve'))}</button>
          <button class="ghost cr-decline-btn" data-id="${Number(cr.id)}" style="width:auto;font-size:12px;padding:4px 10px;margin-left:4px">${escHtml(t('callsignRequestsAdmin.decline'))}</button>`;
      } else {
        const decidedAt = cr.decided_at ? new Date(cr.decided_at).toLocaleString(localeForFmt()) : '';
        const who = cr.decided_by || '';
        let meta = who ? t('callsignRequestsAdmin.decidedBy', { who, when: decidedAt }) : decidedAt;
        if (cr.admin_note) meta += ' — ' + cr.admin_note;
        actionsCell = `<span class="muted small">${escHtml(meta)}</span>`;
      }
      tr.innerHTML = `
        <td class="muted small">${escHtml(when)}</td>
        <td>${escHtml(cr.username)}</td>
        <td>${escHtml(cr.current_callsign)}</td>
        <td><strong>${escHtml(cr.requested_callsign)}</strong></td>
        <td>${proofCell}</td>
        <td><span class="badge ${statusClass}">${escHtml(statusLabel)}</span></td>
        <td style="white-space:nowrap">${actionsCell}</td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.cr-approve-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        const row = list.find(x => Number(x.id) === id);
        if (!row) return;
        const ok = await showConfirm(t('callsignRequestsAdmin.approveConfirm', {
          from: row.current_callsign, to: row.requested_callsign, user: row.username,
        }), { ok: t('callsignRequestsAdmin.approve') });
        if (!ok) return;
        const res = await api('/api/callsign-requests/' + id + '/decide', {
          method: 'POST', body: JSON.stringify({ decision: 'approve' }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          alert(j.error || t('callsignRequestsAdmin.actionFailed'));
          return;
        }
        await refreshCallsignRequests();
      });
    });
    tbody.querySelectorAll('.cr-decline-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        const note = prompt(t('callsignRequestsAdmin.declinePrompt'), '');
        if (note === null) return; // admin cancelled the prompt
        const res = await api('/api/callsign-requests/' + id + '/decide', {
          method: 'POST', body: JSON.stringify({ decision: 'reject', note }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          alert(j.error || t('callsignRequestsAdmin.actionFailed'));
          return;
        }
        await refreshCallsignRequests();
      });
    });
  }
  $('cr-refresh-btn')?.addEventListener('click', refreshCallsignRequests);

  // ----- database backups -----
  async function refreshBackups() {
    if (!hasPerm('backups.manage')) return;
    const res = await api('/api/backups');
    if (!res.ok) return;
    const data = await res.json();
    const list = data.backups || [];
    const retention = data.backup_retention_days ?? 0;

    // Retention line: "Retention: 30 days" or "Retention: keep forever"
    const rline = $('backups-retention-line');
    if (rline) {
      const retentionText = retention > 0
        ? t('backups.retentionLine', { days: retention })
        : t('backups.retentionForever');
      rline.textContent = retentionText;
    }

    const tbody = $('backups-tbody');
    tbody.innerHTML = '';
    const count = $('backups-count');
    const n = list.length;
    if (n === 0) {
      count.textContent = t('backups.noBackups');
    } else {
      count.textContent = n === 1 ? t('backups.count', { n }) : t('backups.countPlural', { n });
    }

    for (const b of list) {
      const tr = document.createElement('tr');
      const created = new Date(b.created_at);
      const kindLabel = b.auto ? t('backups.kindAuto') : t('backups.kindManual');
      const kindClass = b.auto ? 'muted' : '';
      tr.innerHTML = `
        <td>${escHtml(created.toLocaleString())}</td>
        <td class="${kindClass}">${escHtml(kindLabel)}</td>
        <td>${escHtml(formatBytes(b.bytes))}</td>
        <td><code style="font-size:11px">${escHtml(b.hash || '')}</code></td>
        <td>
          <a class="primary" style="width:auto;font-size:12px;padding:4px 10px;text-decoration:none;display:inline-block" href="/api/backups/${encodeURIComponent(b.name)}" download>${escHtml(t('backups.download'))}</a>
          <button class="danger bk-restore-btn" data-name="${escHtml(b.name)}" style="width:auto;font-size:12px;padding:4px 10px;margin-left:4px">${escHtml(t('backups.restore'))}</button>
          <button class="ghost bk-delete-btn" data-name="${escHtml(b.name)}" style="width:auto;font-size:12px;padding:4px 10px;margin-left:4px">${escHtml(t('backups.delete'))}</button>
        </td>`;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('.bk-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const name = e.currentTarget.getAttribute('data-name');
        const ok = await showConfirm(t('backups.deleteConfirm', { name }));
        if (!ok) return;
        const res = await api('/api/backups/' + encodeURIComponent(name), { method: 'DELETE' });
        if (res.ok) refreshBackups();
        else showAlert(t('backups.deleteFailed'));
      });
    });
    tbody.querySelectorAll('.bk-restore-btn').forEach(btn => {
      btn.addEventListener('click', (e) => openRestoreModal(e.currentTarget.getAttribute('data-name')));
    });
  }

  // Type-to-confirm restore modal. Restore is the single most
  // destructive operation in the app (wipes the live DB, no undo),
  // so the button stays disabled until the operator types the target
  // filename verbatim — the same discipline GitHub / AWS impose for
  // repo/instance deletion. On submit we POST /api/backups/<name>/
  // restore; the server takes a safety backup, broadcasts
  // restore_starting to every browser, then writes the systemd
  // trigger file. This browser sees its own broadcast and drops into
  // the standard "deploy" overlay + polling flow.
  function openRestoreModal(name) {
    // The <form> wrapper is load-bearing: showModal() wires the
    // submit handler off `card.querySelector('form')` — no form, no
    // submit event, and the button appears frozen because its
    // enable/disable listener (which also selects `#modal-card form
    // input[name=confirm]`) never binds either. Earlier revisions
    // omitted the form and left the modal effectively inert on
    // click.
    showModal(`
      <h3>${escHtml(t('backups.restoreTitle'))}</h3>
      <form>
        <p>${escHtml(t('backups.restoreWarning'))}</p>
        <p><code style="font-size:12px;word-break:break-all">${escHtml(name)}</code></p>
        <p class="muted small">${escHtml(t('backups.restoreSafetyNote'))}</p>
        <label>${escHtml(t('backups.restoreConfirmLabel'))}</label>
        <input name="confirm" autocomplete="off" placeholder="${escHtml(name)}" />
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.cancel'))}</button>
          <button type="submit" class="danger" id="bk-restore-submit" disabled>${escHtml(t('backups.restoreConfirmButton'))}</button>
        </div>
      </form>
    `, async (form) => {
      if (form.confirm.value.trim() !== name) {
        throw new Error(t('backups.restoreConfirmMismatch'));
      }
      const res = await api('/api/backups/' + encodeURIComponent(name) + '/restore', { method: 'POST' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('backups.restoreFailed'));
      }
      // Success path: server broadcasts restore_starting on the WS,
      // which triggers the deploy-overlay via the ws handler. No
      // additional client-side action needed here.
    });
    // Enable submit only when the typed value matches the filename.
    setTimeout(() => {
      const form = document.querySelector('#modal-card form');
      if (!form) return;
      const btn = form.querySelector('#bk-restore-submit');
      const input = form.querySelector('input[name=confirm]');
      const check = () => { btn.disabled = input.value.trim() !== name; };
      input.addEventListener('input', check);
      check();
    }, 10);
  }
  $('backups-refresh-btn')?.addEventListener('click', refreshBackups);
  $('backups-take-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = t('backups.takingNow');
    try {
      const res = await api('/api/backups', { method: 'POST' });
      if (res.ok) {
        await refreshBackups();
      } else {
        const err = await res.json().catch(() => ({}));
        showAlert(t('backups.takeFailed', { error: err.error || res.status }));
      }
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  // formatBytes returns a short human-readable size (e.g. "812 kB",
  // "3.4 MB"). Small enough that we don't need a formatter library.
  function formatBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' kB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  // ----- dummy TRX management -----
  async function loadDummyRigs() {
    if (!hasPerm('rig.simulate')) return;
    const res = await api('/api/rigs/dummy');
    if (!res.ok) return;
    const list = await res.json();
    const el = $('dummy-rig-list');
    if (!el) return;
    el.innerHTML = '';
    if (!list || list.length === 0) {
      el.innerHTML = '<p class="muted small">' + escHtml(t('globalSettings.noDummies')) + '</p>';
      return;
    }
    for (const d of list) {
      const row = document.createElement('div');
      row.className = 'row dummy-rig-row';
      row.innerHTML = `<span class="dummy-rig-name">${escHtml(d.name)}</span>
        <span class="muted small">${escHtml(t('globalSettings.dummyDefaultMHz', { mhz: (d.default_freq_hz/1_000_000).toFixed(4) }))}</span>
        <button class="ghost" data-name="${escHtml(d.name)}" style="margin-left:auto;width:auto;margin-top:0">${escHtml(t('common.delete'))}</button>`;
      row.querySelector('button').addEventListener('click', async (e) => {
        const name = e.currentTarget.dataset.name;
        if (!await showConfirm(t('globalSettings.deleteDummyQ', { name }), { ok: t('common.delete') })) return;
        const r = await api('/api/rigs/dummy/' + encodeURIComponent(name), { method: 'DELETE' });
        if (r.ok) await loadDummyRigs();
      });
      el.appendChild(row);
    }
  }
  const addDummyRigBtn = $('add-dummy-rig-btn');
  if (addDummyRigBtn) {
    addDummyRigBtn.addEventListener('click', async () => {
      const nameEl = $('dummy-rig-name');
      const freqEl = $('dummy-rig-freq');
      const errEl  = $('dummy-rig-error');
      errEl.textContent = '';
      const name = nameEl.value.trim();
      const freqHz = Math.round(parseFloat(freqEl.value) * 1_000_000);
      if (!name)   { errEl.textContent = t('globalSettings.nameRequired'); return; }
      if (!freqHz || freqHz <= 0) { errEl.textContent = t('globalSettings.validFreqRequired'); return; }
      const res = await api('/api/rigs/dummy', {
        method: 'POST',
        body: JSON.stringify({ name, default_freq_hz: freqHz }),
      });
      if (res.ok) {
        nameEl.value = '';
        freqEl.value = '14.074';
        await loadDummyRigs();
      } else {
        const j = await res.json().catch(() => ({}));
        errEl.textContent = j.error || t('globalSettings.addDummyFail');
      }
    });
  }

  // ----- contests tab -----
  $('new-contest-btn').addEventListener('click', () => contestCreateModal());

  async function refreshContests() {
    if (!hasPerm('contests.manage') && !hasPerm('contests.manage_private')) return;
    const res = await api('/api/contests');
    if (!res.ok) return;
    allContests = await res.json();
    renderContestsTable();
    renderContestPicker();
  }

  function renderContestsTable() {
    const tbody = $('contests-tbody');
    tbody.innerHTML = '';
    if (!hasPerm('contests.manage') && !hasPerm('contests.manage_private')) return;
    const fullManager = hasPerm('contests.manage');
    for (const c of allContests) {
      const canEditRow = fullManager || (hasPerm('contests.manage_private') && c.private);
      const tr = document.createElement('tr');
      const date = c.created_at ? new Date(c.created_at).toLocaleDateString(localeForFmt()) : '';
      const statusLabel = c.status === 'open' ? t('contestScreen.statusOpen') : t('contestScreen.statusFinished');
      const privBadge = c.private ? ` <span class="cl-priv-badge">${escHtml(t('contestScreen.private'))}</span>` : '';
      tr.innerHTML = `
        <td>${escHtml(c.name)}${privBadge}</td>
        <td style="color:var(--accent);font-weight:600">${escHtml(fmtCall(c.station_call))}</td>
        <td class="muted">${escHtml(c.qth || '—')}</td>
        <td><span class="badge ${c.status}">${escHtml(statusLabel)}</span></td>
        <td class="muted">${date}</td>
        <td class="actions">
          ${canEditRow ? `<button class="ghost" data-action="edit" data-id="${Number(c.id)}">${escHtml(t('common.edit'))}</button>
          <button class="ghost" data-action="toggle" data-id="${Number(c.id)}"
            data-status="${escHtml(c.status)}">${c.status === 'open' ? escHtml(t('contestScreen.markFinished')) : escHtml(t('contestScreen.reopen'))}</button>` : ''}
        </td>
      `;
      if (canEditRow) {
        tr.querySelectorAll('button').forEach(b => b.addEventListener('click', () => contestAction(c, b.dataset.action)));
      }
      tbody.appendChild(tr);
    }
  }

  async function contestAction(c, action) {
    if (action === 'edit') {
      contestEditModal(c);
    } else if (action === 'toggle') {
      const newStatus = c.status === 'open' ? 'finished' : 'open';
      const label = newStatus === 'finished' ? t('contestScreen.markFinishedQ') : t('contestScreen.reopenQ');
      if (!await showConfirm(label, { ok: newStatus === 'finished' ? t('contestScreen.markFinished') : t('contestScreen.reopen'), safe: newStatus !== 'finished' })) return;
      api('/api/contests/' + c.id, {
        method: 'PUT',
        body: JSON.stringify({ name: c.name, station_call: c.station_call, station_id: c.station_id || '', qth: c.qth || '', status: newStatus, bands: c.bands || [], objective: c.objective || '', custom_fields: c.custom_fields || '', qso_layout: c.qso_layout || '' }),
      }).then(r => { if (r.ok) refreshContests(); });
    }
  }

  function buildBandSelectHTML(selectedBands) {
    return `<label>${escHtml(t('contestScreen.activeBands'))}</label>
      <div class="band-select-grid" id="modal-band-grid">
        ${BANDS.map(b => `<span class="band-select-pill${selectedBands.includes(b) ? ' selected' : ''}" data-band="${escHtml(b)}">${escHtml(fmtBand(b))}</span>`).join('')}
      </div>`;
  }

  function attachBandSelectListeners() {
    document.querySelectorAll('#modal-band-grid .band-select-pill').forEach(pill => {
      pill.addEventListener('click', () => pill.classList.toggle('selected'));
    });
  }

  function selectedBandsFromModal() {
    return Array.from(document.querySelectorAll('#modal-band-grid .band-select-pill.selected')).map(p => p.dataset.band);
  }

  // Contest start/end date pickers used by both create and edit modals.
  // Values are ISO date strings ("YYYY-MM-DD") — an empty string means unset.
  // Server-side, both dates are optional; leaving end blank makes it a
  // single-day contest, leaving both blank disables auto-close.
  function buildContestDatesHTML(startIso, endIso, readOnly) {
    const d = readOnly ? ' disabled' : '';
    const s = (startIso || '').substring(0, 10);
    const e = (endIso || '').substring(0, 10);
    return `<div class="contest-dates-row">
        <label class="contest-dates-cell">
          <span class="muted small">${escHtml(t('contestScreen.contestStartDate'))}</span>
          <span class="contest-date-input-wrap">
            <input type="date" name="start_date" value="${escHtml(s)}"${d} />
            ${readOnly ? '' : `<button type="button" class="ghost small contest-date-clear" data-target="start_date" title="${escHtml(t('contestScreen.clearDate'))}">&times;</button>`}
          </span>
        </label>
        <label class="contest-dates-cell">
          <span class="muted small">${escHtml(t('contestScreen.contestEndDate'))}</span>
          <span class="contest-date-input-wrap">
            <input type="date" name="end_date" value="${escHtml(e)}"${d} />
            ${readOnly ? '' : `<button type="button" class="ghost small contest-date-clear" data-target="end_date" title="${escHtml(t('contestScreen.clearDate'))}">&times;</button>`}
          </span>
        </label>
      </div>
      <p class="muted small" style="margin:2px 0 0">${escHtml(t('contestScreen.contestDatesHint'))}</p>`;
  }

  function attachContestDatesListeners() {
    document.querySelectorAll('#modal-card .contest-date-clear').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.target;
        const inp = document.querySelector('#modal-card input[name="' + name + '"]');
        if (inp) { inp.value = ''; inp.dispatchEvent(new Event('change')); }
      });
    });
  }

  // Rejects an invalid start/end pairing before submit. Returns an error
  // string on failure or null when the values are usable (either or both
  // may be empty — that's allowed).
  function validateContestDates(form) {
    const s = (form.start_date?.value || '').trim();
    const e = (form.end_date?.value || '').trim();
    if (s && e && e < s) return t('contestScreen.endBeforeStart');
    return null;
  }

  // Contest templates. This catalogue used to be a hardcoded CONTEST_PRESETS
  // object right here (FR #58); it now lives in the contest_templates table
  // and is maintained by operators themselves on the "Contest templates"
  // screen. allTemplates backs both that screen and the dropdown at the top
  // of contestCreateModal. The list the server returns is already filtered to
  // what the caller may use — their own templates plus every shared one —
  // with their own sorted first.
  let allTemplates = [];
  async function refreshTemplates() {
    const r = await api('/api/contest-templates');
    if (!r.ok) return;
    allTemplates = await r.json();
    renderTemplates();
  }

  // Applies a template's shape to whichever contest/template form is
  // currently in the modal. Shared by the create-contest dropdown so the
  // pre-fill logic lives in exactly one place. Returns the fields the caller
  // has to carry itself because the form has no input for them.
  function applyTemplateToForm(tpl) {
    const nameInput = document.querySelector('#modal-card input[name=name]');
    if (nameInput && !nameInput.value.trim()) nameInput.value = tpl.default_name || '';
    document.querySelectorAll('#modal-band-grid .band-select-pill').forEach(pill => {
      pill.classList.toggle('selected', (tpl.bands || []).includes(pill.dataset.band));
    });
    // Replace the custom-field rows wholesale — the operator picked a
    // template, so any half-typed rows are intentionally overridden.
    const fields = parseCustomFields(tpl.custom_fields || '');
    const cfRows = document.querySelector('#cf-editor .cf-editor-rows');
    if (cfRows) cfRows.innerHTML = fields.map((f, i) => customFieldRowHTML(f, i)).join('');
    // The layout editor keys off the custom fields, so it has to be re-seeded
    // after the rows above changed or it would keep dangling cf:* entries.
    if (_layoutState) {
      _layoutState.json = tpl.qso_layout || '';
      renderLayoutEditor();
    }
    const objective = document.querySelector('#modal-card textarea[name=objective]');
    if (objective) {
      objective.value = tpl.objective || '';
      objective.dispatchEvent(new Event('input'));
    }
    const nrPadded = document.querySelector('#modal-card input[name=nr_padded]');
    if (nrPadded) nrPadded.checked = tpl.nr_padded !== false;
    // The mapping editor is rebuilt rather than patched: its rows depend on
    // the custom fields, which the template just replaced.
    const mapEd = document.getElementById('adif-map-editor');
    if (mapEd) {
      mapEd.outerHTML = buildADIFMappingEditorHTML(tpl.adif_mapping || '', fields, false);
      attachADIFMappingListeners(fields);
    attachCabrilloMappingListeners(fields);
    }
    return {
      log_columns: tpl.log_columns || '',
      freq_unit: tpl.freq_unit || 'kHz',
      stash_expiry_minutes: tpl.stash_expiry_minutes > 0 ? tpl.stash_expiry_minutes : 60,
    };
  }

  async function contestCreateModal(forcePrivate = false) {
    const canPriv = hasPerm('contests.create_private') || hasPerm('contests.manage_private');
    const canSaveTemplates = hasPerm('contest_templates.manage');
    // Fetched every time the dialog opens so a template saved in another tab
    // — or shared by another operator since the last page load — shows up
    // without a reload.
    await refreshTemplates();
    const presetOptions = allTemplates.map(tpl => {
      const owner = tpl.my_role === 'owner' || !tpl.owner_user_id ? '' : ' — ' + (tpl.owner_username || '');
      return `<option value="${Number(tpl.id)}">${escHtml(tpl.name + owner)}</option>`;
    }).join('');
    // Template fields the create dialog has no input of its own for. Applying
    // a template stashes them here and the POST body picks them up, so a new
    // contest starts with the template's log-column order, frequency unit and
    // stash expiry already in place instead of the server defaults.
    let carried = { log_columns: '', freq_unit: 'kHz', stash_expiry_minutes: 60 };
    const templateRow = allTemplates.length
      ? `<label>${escHtml(t('contestScreen.preset'))} <span class="muted small">${escHtml(t('contestScreen.presetHint'))}</span></label>
         <select name="preset" id="cm-preset">
           <option value="">${escHtml(t('contestScreen.presetNone'))}</option>
           ${presetOptions}
         </select>`
      : '';
    // Save-as-template lives inline rather than in a nested dialog: the app
    // has a single modal root, so opening a second modal would destroy the
    // half-filled contest form behind it.
    const saveTemplateRow = canSaveTemplates
      ? `<div class="tpl-save-row" id="cm-save-tpl-row">
           <button type="button" class="ghost" id="cm-save-tpl-btn">${escHtml(t('templates.saveAsTemplate'))}</button>
           <span id="cm-save-tpl-form" class="hidden">
             <input id="cm-save-tpl-name" maxlength="120" placeholder="${escHtml(t('templates.namePlaceholder'))}" />
             <button type="button" class="ghost" id="cm-save-tpl-confirm">${escHtml(t('common.save'))}</button>
           </span>
           <span id="cm-save-tpl-status" class="muted small"></span>
         </div>`
      : '';
    showModal(`
      <h3>${escHtml(t('contestScreen.createTitle'))}</h3>
      <form>
        ${templateRow}
        <label>${escHtml(t('contestScreen.contestName'))}</label>
        <input name="name" placeholder="${escHtml(t('contestScreen.contestNamePlaceholder'))}" required />
        <label>${escHtml(t('contestScreen.stationCall'))}</label>
        <input name="station_call" autocapitalize="characters" placeholder="${escHtml(t('contestScreen.stationCallPlaceholder'))}" required />
        <label>${escHtml(t('contestScreen.stationIdentifier'))} <span class="muted small">${escHtml(t('contestScreen.stationIdentifierOptionalOp'))}</span></label>
        <input name="station_id" placeholder="${escHtml(t('contestScreen.stationIdPlaceholder'))}" />
        <label>${escHtml(t('contestScreen.qthLocator'))}</label>
        <input name="qth" placeholder="${escHtml(t('contestScreen.qthPlaceholder'))}" maxlength="6" autocapitalize="characters" style="text-transform:uppercase" />
        ${buildBandSelectHTML([])}
        <label style="margin-top:10px">${escHtml(t('contestScreen.contestDates'))} <span class="muted small">${escHtml(t('contestScreen.contestDatesOptional'))}</span></label>
        ${buildContestDatesHTML('', '')}
        ${canPriv ? `<label style="margin-top:10px"><input type="checkbox" name="private"${forcePrivate ? ' checked' : ''} /> ${escHtml(t('contestScreen.privateContest'))} <span class="muted small">${escHtml(t('contestScreen.privateOnlyYou'))}</span></label>` : ''}
        <label style="margin-top:10px"><input type="checkbox" name="nr_padded" checked /> ${escHtml(t('contestScreen.nrPadded'))}</label>
        <label style="margin-top:10px">${escHtml(t('contestScreen.customFields'))} <span class="muted small">${escHtml(t('contestScreen.customFieldsPerQSO'))}</span></label>
        ${buildCustomFieldsEditorHTML([])}
        <label style="margin-top:10px">${escHtml(t('contestScreen.layoutEditor'))} <span class="muted small">${escHtml(t('contestScreen.layoutHint'))}</span></label>
        ${buildLayoutEditorHTML()}
        <label style="margin-top:10px">${escHtml(t('contestScreen.adifMapping'))} <span class="muted small">${escHtml(t('contestScreen.adifMappingHint'))}</span></label>
        ${buildADIFMappingEditorHTML('', [], false)}
        <label style="margin-top:10px">${escHtml(t('contestScreen.cabrilloMapping'))} <span class="muted small">${escHtml(t('contestScreen.cabrilloMappingHint'))}</span></label>
        ${buildCabrilloMappingEditorHTML('', [], false)}
        <label style="margin-top:10px">${escHtml(t('contestScreen.objective'))} <span class="muted small">${escHtml(t('contestScreen.objectiveMdOptional'))}</span></label>
        <div class="md-editor-wrap">
          <textarea name="objective" placeholder="${escHtml(t('contestScreen.objectivePlaceholder'))}"></textarea>
          <div class="md-preview-pane objective-content" id="modal-md-preview"></div>
        </div>
        ${saveTemplateRow}
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.cancel'))}</button>
          <button type="submit" class="primary">${escHtml(t('contestScreen.create'))}</button>
        </div>
      </form>
    `, async (form) => {
      const dateErr = validateContestDates(form);
      if (dateErr) throw new Error(dateErr);
      const res = await api('/api/contests', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.value.trim(),
          station_call: form.station_call.value.trim().toUpperCase(),
          station_id: (form.station_id?.value || '').trim(),
          qth: form.qth.value.trim().toUpperCase(),
          bands: selectedBandsFromModal(),
          objective: form.objective.value,
          private: forcePrivate || !!(form.private && form.private.checked),
          custom_fields: serializeCustomFieldsEditor(),
          qso_layout: serializeQSOLayout(),
          adif_mapping: serializeADIFMappingEditor(),
          cabrillo_mapping: serializeCabrilloMappingEditor(),
          log_columns: carried.log_columns,
          freq_unit: carried.freq_unit,
          stash_expiry_minutes: carried.stash_expiry_minutes,
          nr_padded: form.nr_padded.checked,
          start_date: (form.start_date?.value || '').trim(),
          end_date: (form.end_date?.value || '').trim(),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('contestScreen.createFail'));
      }
      await refreshContests();
      // Also refresh the picker list if we're on contest-screen
      if (!$('contest-screen').classList.contains('hidden')) {
        const r = await api('/api/contests');
        if (r.ok) allContests = await r.json();
        renderContestPicker();
      }
    }, { wide: true });
    attachBandSelectListeners();
    attachContestDatesListeners();
    attachCustomFieldsEditorListeners();
    attachLayoutEditorListeners('');
    attachADIFMappingListeners([]);
    attachCabrilloMappingListeners([]);
    const taC = document.querySelector('#modal-card textarea[name=objective]');
    const previewC = $('modal-md-preview');
    if (taC && previewC) {
      taC.addEventListener('input', () => { previewC.innerHTML = renderMarkdown(taC.value); });
    }
    // Apply a template on selection. Everything it touches stays editable
    // before submit — the template is a one-shot pre-fill, never a live link.
    const presetSel = document.getElementById('cm-preset');
    if (presetSel) presetSel.addEventListener('change', () => {
      const tpl = allTemplates.find(x => String(x.id) === presetSel.value);
      if (!tpl) { carried = { log_columns: '', freq_unit: 'kHz', stash_expiry_minutes: 60 }; return; }
      carried = applyTemplateToForm(tpl);
    });
    // Save the contest currently being composed as a reusable template.
    const saveTplBtn = document.getElementById('cm-save-tpl-btn');
    if (saveTplBtn) {
      const nameInput = document.getElementById('cm-save-tpl-name');
      const statusEl = document.getElementById('cm-save-tpl-status');
      const doSave = async () => {
        const tplName = (nameInput.value || '').trim();
        if (!tplName) { nameInput.focus(); return; }
        statusEl.textContent = t('common.loading');
        const body = {
          name: tplName,
          default_name: document.querySelector('#modal-card input[name=name]')?.value.trim() || '',
          bands: selectedBandsFromModal(),
          objective: document.querySelector('#modal-card textarea[name=objective]')?.value || '',
          custom_fields: serializeCustomFieldsEditor(),
          qso_layout: serializeQSOLayout(),
          adif_mapping: serializeADIFMappingEditor(),
          cabrillo_mapping: serializeCabrilloMappingEditor(),
          log_columns: carried.log_columns,
          freq_unit: carried.freq_unit,
          stash_expiry_minutes: carried.stash_expiry_minutes,
          nr_padded: !!document.querySelector('#modal-card input[name=nr_padded]')?.checked,
          shared: false,
        };
        const r = await api('/api/contest-templates', { method: 'POST', body: JSON.stringify(body) });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          statusEl.textContent = j.error || t('common.saveFailed');
          return;
        }
        statusEl.textContent = t('templates.saved');
        document.getElementById('cm-save-tpl-form').classList.add('hidden');
        saveTplBtn.classList.remove('hidden');
        await refreshTemplates();
      };
      saveTplBtn.addEventListener('click', () => {
        document.getElementById('cm-save-tpl-form').classList.remove('hidden');
        saveTplBtn.classList.add('hidden');
        // Seed the template name from the contest name — for a recurring
        // contest the two are usually the same modulo the year.
        if (!nameInput.value) nameInput.value = document.querySelector('#modal-card input[name=name]')?.value.trim() || '';
        nameInput.focus();
      });
      document.getElementById('cm-save-tpl-confirm').addEventListener('click', doSave);
      // Enter inside the template-name field must save the template, not
      // submit the half-filled contest form behind it.
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doSave(); }
      });
    }
  }

  function contestEditModal(c) {
    const existingFields = parseCustomFields(c.custom_fields);
    let pendingStatus = c.status;
    const canManageContest = hasPerm('contests.manage') || (hasPerm('contests.manage_private') && c.private);
    const isOwner = c.my_role === 'owner';
    const canEdit = canManageContest || isOwner;
    const readOnly = !canEdit;
    const canSeeParticipants = canManageContest || isOwner;
    const d = readOnly ? ' disabled' : '';
    // Visibility + group access — owner-only, editable inline via the
    // dedicated /visibility and /groups endpoints (the main PUT
    // /api/contests/{id} intentionally never touches visibility).
    const curVisibility = c.visibility || (c.private ? 'private' : 'open');
    const visibilitySection = canEdit
      ? `<div class="participants-section" style="margin-top:8px">
           <div class="participants-section-header">${escHtml(t('contestScreen.visibility'))}</div>
           <div class="vis-controls" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
             <select id="edit-visibility-select">
               <option value="open"    ${curVisibility === 'open'    ? 'selected' : ''}>${escHtml(t('contestScreen.visibilityOpen'))}</option>
               <option value="groups"  ${curVisibility === 'groups'  ? 'selected' : ''}>${escHtml(t('contestScreen.visibilityGroups'))}</option>
               <option value="private" ${curVisibility === 'private' ? 'selected' : ''}>${escHtml(t('contestScreen.visibilityPrivate'))}</option>
             </select>
             <span id="edit-visibility-status" class="muted small"></span>
           </div>
           <div id="edit-visibility-groups" class="hidden" style="margin-top:8px">
             <div class="muted small">${escHtml(t('contestScreen.visibilityGroupsHelp'))}</div>
             <div id="edit-visibility-groups-list" style="margin-top:4px"><span class="muted small">${escHtml(t('common.loading'))}</span></div>
           </div>
         </div>`
      : '';
    const participantsSection = canSeeParticipants
      ? `<div class="participants-section">
           <div class="participants-section-header">${escHtml(t('contestScreen.participants'))}</div>
           <div id="modal-participants-list" class="participants-list"><span class="muted small">${escHtml(t('common.loading'))}</span></div>
         </div>`
      : '';
    const statusToggleHtml = readOnly
      ? `<div style="margin-bottom:14px">
           <span class="status-toggle-pill ${escHtml(c.status)}" style="cursor:default">
             <span class="status-dot"></span>
             <span class="status-label">${escHtml(c.status === 'open' ? t('contestScreen.statusOpen') : t('contestScreen.statusFinished'))}</span>
           </span>
         </div>`
      : `<div style="margin-bottom:14px">
           <button type="button" id="edit-status-toggle" class="status-toggle-pill ${escHtml(c.status)}">
             <span class="status-dot"></span>
             <span class="status-label">${escHtml(c.status === 'open' ? t('contestScreen.statusOpen') : t('contestScreen.statusFinished'))}</span>
             <span class="status-toggle-arrow">&#8644;</span>
           </button>
         </div>`;
    const actionsHtml = readOnly
      ? `<div class="modal-actions">
           <button type="button" class="ghost cancel-btn">${escHtml(t('common.close'))}</button>
         </div>`
      : `<div class="modal-actions">
           ${hasPerm('contest.admin') || isOwner ? `<button type="button" id="modal-delete-contest-btn" class="danger" style="margin-right:auto">${escHtml(t('contestScreen.deleteContest'))}</button>` : ''}
           <button type="button" class="ghost cancel-btn">${escHtml(t('common.cancel'))}</button>
           <button type="submit" class="primary">${escHtml(t('common.save'))}</button>
         </div>`;
    showModal(`
      <h3>${escHtml(readOnly ? t('topbar.contestSettings') : t('contestScreen.editTitle'))}</h3>
      ${statusToggleHtml}
      ${visibilitySection}
      ${participantsSection}
      <form${readOnly ? ' class="contest-modal-readonly"' : ''}>
        <label>${escHtml(t('contestScreen.contestName'))}</label>
        <input name="name" value="${escHtml(c.name)}"${d} required />
        <label>${escHtml(t('contestScreen.stationCall'))}</label>
        <input name="station_call" value="${escHtml(c.station_call)}" autocapitalize="characters"${d} required />
        <label>${escHtml(t('contestScreen.stationIdentifier'))} <span class="muted small">${escHtml(t('contestScreen.stationIdentifierOptional'))}</span></label>
        <input name="station_id" value="${escHtml(c.station_id || '')}" placeholder="${escHtml(t('contestScreen.stationIdPlaceholder'))}"${d} />
        <label>${escHtml(t('contestScreen.qthLocator'))}</label>
        <input name="qth" value="${escHtml(c.qth || '')}" placeholder="${escHtml(t('contestScreen.qthPlaceholder'))}" maxlength="6" autocapitalize="characters" style="text-transform:uppercase"${d} />
        ${buildBandSelectHTML(c.bands || [])}
        <label style="margin-top:10px">${escHtml(t('contestScreen.contestDates'))} <span class="muted small">${escHtml(t('contestScreen.contestDatesOptional'))}</span></label>
        ${buildContestDatesHTML(c.start_date || '', c.end_date || '', readOnly)}
        <label style="margin-top:10px"><input type="checkbox" name="nr_padded" ${c.nr_padded !== false ? 'checked' : ''}${d} /> ${escHtml(t('contestScreen.nrPadded'))}</label>
        <label style="margin-top:10px">${escHtml(t('contestScreen.freqUnit'))}
          <select name="freq_unit"${d}>
            ${['Hz','kHz','MHz','GHz'].map(u => `<option value="${u}"${(c.freq_unit || 'kHz') === u ? ' selected' : ''}>${escHtml(u)}</option>`).join('')}
          </select>
        </label>
        <label style="margin-top:10px">${escHtml(t('contestScreen.stashExpiryMinutes'))}
          <input type="number" name="stash_expiry_minutes" min="1" max="10080" value="${escHtml(String(c.stash_expiry_minutes && c.stash_expiry_minutes > 0 ? c.stash_expiry_minutes : 60))}"${d} style="width:120px" />
          <span class="muted small">${escHtml(t('contestScreen.stashExpiryHint'))}</span>
        </label>
        <label style="margin-top:10px">${escHtml(t('contestScreen.customFields'))} <span class="muted small">${escHtml(t('contestScreen.customFieldsPerQSO2'))}</span></label>
        ${buildCustomFieldsEditorHTML(existingFields)}
        <label style="margin-top:10px">${escHtml(t('contestScreen.layoutEditor'))} <span class="muted small">${escHtml(t('contestScreen.layoutHint'))}</span></label>
        ${buildLayoutEditorHTML()}
        <label style="margin-top:10px">${escHtml(t('contestScreen.objective'))} <span class="muted small">${escHtml(t('contestScreen.objectiveMd'))}</span></label>
        <div class="md-editor-wrap">
          <textarea name="objective" placeholder="${escHtml(t('contestScreen.objectivePlaceholder'))}"${d}>${escHtml(c.objective || '')}</textarea>
          <div class="md-preview-pane objective-content" id="modal-md-preview"></div>
        </div>
        <label style="margin-top:14px">${escHtml(t('contestScreen.logColumns'))}</label>
        <p class="muted small" style="margin:2px 0 0">${escHtml(t('contestScreen.logColumnsHint'))}</p>
        ${buildLogColumnsEditorHTML(c.log_columns || '', existingFields)}
        <label style="margin-top:14px">${escHtml(t('contestScreen.adifMapping'))} <span class="muted small">${escHtml(t('contestScreen.adifMappingHint'))}</span></label>
        ${buildADIFMappingEditorHTML(c.adif_mapping || '', existingFields, readOnly)}
        <label style="margin-top:14px">${escHtml(t('contestScreen.cabrilloMapping'))} <span class="muted small">${escHtml(t('contestScreen.cabrilloMappingHint'))}</span></label>
        ${buildCabrilloMappingEditorHTML(c.cabrillo_mapping || '', existingFields, readOnly)}
        <div class="modal-err error"></div>
        ${actionsHtml}
      </form>
    `, readOnly ? null : async (form) => {
      const dateErr = validateContestDates(form);
      if (dateErr) throw new Error(dateErr);
      const res = await api('/api/contests/' + c.id, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name.value.trim(),
          station_call: form.station_call.value.trim().toUpperCase(),
          station_id: (form.station_id?.value || '').trim(),
          qth: form.qth.value.trim().toUpperCase(),
          status: pendingStatus,
          bands: selectedBandsFromModal(),
          objective: form.objective.value,
          custom_fields: serializeCustomFieldsEditor(),
          qso_layout: serializeQSOLayout(),
          adif_mapping: serializeADIFMappingEditor(),
          cabrillo_mapping: serializeCabrilloMappingEditor(),
          log_columns: serializeLogColumnsEditor(),
          nr_padded: form.nr_padded.checked,
          stash_expiry_minutes: Math.max(1, parseInt(form.stash_expiry_minutes?.value || '60', 10) || 60),
          freq_unit: form.freq_unit?.value || 'kHz',
          start_date: (form.start_date?.value || '').trim(),
          end_date: (form.end_date?.value || '').trim(),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('contestScreen.updateFail'));
      }
      await refreshContests();
    }, { wide: true });
    if (!readOnly) {
      const statusToggleBtn = document.getElementById('edit-status-toggle');
      if (statusToggleBtn) {
        statusToggleBtn.addEventListener('click', () => {
          pendingStatus = pendingStatus === 'open' ? 'finished' : 'open';
          statusToggleBtn.className = 'status-toggle-pill ' + pendingStatus;
          statusToggleBtn.querySelector('.status-label').textContent =
            pendingStatus === 'open' ? t('contestScreen.statusOpen') : t('contestScreen.statusFinished');
        });
      }
      attachBandSelectListeners();
      attachContestDatesListeners();
      attachCustomFieldsEditorListeners();
      attachLayoutEditorListeners(c.qso_layout || '');
      initLogColDragDrop();
    }
    attachADIFMappingListeners(existingFields);
    attachCabrilloMappingListeners(existingFields);
    // Live markdown preview (always shown, read-only preview still renders)
    const ta = document.querySelector('#modal-card textarea[name=objective]');
    const preview = $('modal-md-preview');
    if (ta && preview) {
      const updatePreview = () => { preview.innerHTML = renderMarkdown(ta.value); };
      updatePreview();
      if (!readOnly) ta.addEventListener('input', updatePreview);
    }
    // Load participants if visible
    if (canSeeParticipants) loadModalParticipants(c.id, canManageContest);
    // Visibility + group-access controls (owner-only). Uses the dedicated
    // /visibility and /groups sub-endpoints — the main PUT never touches
    // these so an accidental edit can't silently flip access rules.
    const visSel = document.getElementById('edit-visibility-select');
    const visStatus = document.getElementById('edit-visibility-status');
    const visGroupsWrap = document.getElementById('edit-visibility-groups');
    const visGroupsList = document.getElementById('edit-visibility-groups-list');
    async function loadContestGroupSelection() {
      if (!visGroupsList) return;
      const [allR, curR] = await Promise.all([
        api('/api/groups'),
        api('/api/contests/' + c.id + '/groups'),
      ]);
      if (!allR.ok || !curR.ok) {
        visGroupsList.innerHTML = `<span class="error small">${escHtml(t('contestScreen.visibilityGroupsLoadFail'))}</span>`;
        return;
      }
      const allGrp = await allR.json();
      const curGrp = await curR.json();
      const curIds = new Set((curGrp || []).map(g => g.id));
      if (!allGrp.length) {
        visGroupsList.innerHTML = `<span class="muted small">${escHtml(t('contestScreen.visibilityGroupsEmpty'))}</span>`;
        return;
      }
      visGroupsList.innerHTML = allGrp.map(g => `
        <label class="checkbox-row" style="display:flex;gap:6px;align-items:center;margin:2px 0">
          <input type="checkbox" class="vis-group-cb" value="${Number(g.id)}" ${curIds.has(g.id) ? 'checked' : ''} />
          <span>${escHtml(g.name)} <span class="muted small">(${Number(g.member_count || 0)})</span></span>
        </label>
      `).join('') + `
        <button type="button" id="vis-groups-save" class="ghost small" style="margin-top:6px">${escHtml(t('common.save'))}</button>
        <span id="vis-groups-status" class="muted small" style="margin-left:8px"></span>`;
      document.getElementById('vis-groups-save').addEventListener('click', async () => {
        const ids = Array.from(document.querySelectorAll('.vis-group-cb:checked')).map(cb => Number(cb.value));
        const statusEl = document.getElementById('vis-groups-status');
        const r = await api('/api/contests/' + c.id + '/groups', {
          method: 'PUT', body: JSON.stringify({ group_ids: ids }),
        });
        if (r.ok) {
          if (statusEl) statusEl.textContent = t('common.saved');
        } else {
          const j = await r.json().catch(() => ({}));
          if (statusEl) statusEl.textContent = j.error || t('common.saveFailed');
        }
      });
    }
    function reflectVisibilityGroupsPanel() {
      if (!visGroupsWrap) return;
      if (visSel.value === 'groups') {
        visGroupsWrap.classList.remove('hidden');
        loadContestGroupSelection();
      } else {
        visGroupsWrap.classList.add('hidden');
      }
    }
    if (visSel) {
      reflectVisibilityGroupsPanel();
      visSel.addEventListener('change', async () => {
        const newVis = visSel.value;
        if (visStatus) visStatus.textContent = t('common.loading');
        const r = await api('/api/contests/' + c.id + '/visibility', {
          method: 'PUT', body: JSON.stringify({ visibility: newVis }),
        });
        if (r.ok) {
          if (visStatus) visStatus.textContent = t('common.saved');
          c.visibility = newVis;
          c.private = newVis === 'private';
          reflectVisibilityGroupsPanel();
        } else {
          const j = await r.json().catch(() => ({}));
          if (visStatus) visStatus.textContent = j.error || t('common.saveFailed');
          // Revert the dropdown to what the server still holds.
          visSel.value = curVisibility;
        }
      });
    }
    // Delete contest button
    const deleteBtn = document.getElementById('modal-delete-contest-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        if (!await showConfirm(t('contestScreen.deleteContestConfirm', { name: c.name }), { ok: t('common.delete') })) return;
        const r = await api('/api/contests/' + c.id, { method: 'DELETE' });
        if (r.ok) {
          $('modal-root').classList.add('hidden');
          await refreshContests();
          if (me && me.contest_id === c.id) {
            me.contest_id = null;
            await showContestScreen();
          }
        } else {
          const j = await r.json().catch(() => ({}));
          alert(j.error || t('contestScreen.deleteFail'));
        }
      });
    }
  }

  async function loadModalParticipants(contestID, canManage) {
    const list = document.getElementById('modal-participants-list');
    if (!list) return;
    const r = await api('/api/contests/' + contestID + '/participants');
    if (!r.ok) { list.innerHTML = `<span class="error small">${escHtml(t('contestScreen.participantLoadFail'))}</span>`; return; }
    const participants = await r.json();

    // Role vocabulary: owner / editor / logger. Legacy "user" is treated
    // as an alias for "logger" on read so old rows render sensibly.
    const roleLabel = (r) => {
      if (r === 'owner') return t('contestScreen.roleOwner');
      if (r === 'editor') return t('contestScreen.roleEditor');
      return t('contestScreen.roleLogger'); // logger, or legacy user
    };
    const roleSelect = (p) => {
      const cur = p.role === 'user' ? 'logger' : p.role;
      return `<select class="ptc-role-select small" data-uid="${p.user_id}">
        <option value="logger" ${cur === 'logger' ? 'selected' : ''}>${escHtml(t('contestScreen.roleLogger'))}</option>
        <option value="editor" ${cur === 'editor' ? 'selected' : ''}>${escHtml(t('contestScreen.roleEditor'))}</option>
        <option value="owner"  ${cur === 'owner'  ? 'selected' : ''}>${escHtml(t('contestScreen.roleOwner'))}</option>
      </select>`;
    };
    const rows = (participants && participants.length)
      ? participants.map(p => {
          const cur = p.role === 'user' ? 'logger' : p.role;
          const rolePill = `<span class="participant-role-pill ${escHtml(cur)}">${escHtml(roleLabel(p.role))}</span>`;
          const statusPill = `<span class="participant-status-pill ${escHtml(p.status)}">${escHtml(p.status === 'active' ? t('contestScreen.participantActive') : t('contestScreen.participantPending'))}</span>`;
          const isSelf = p.user_id === me?.user_id;
          let actions = '';
          if (p.status === 'pending') {
            actions += `<button class="ghost small ptc-approve" data-uid="${p.user_id}">${escHtml(t('contestScreen.approveRequest'))}</button>`;
          }
          // Owner-only can promote/demote; owner may always demote self.
          // A logger cannot self-promote; the dropdown is only rendered
          // when the caller has manage rights.
          if (p.status === 'active' && canManage) {
            actions += roleSelect(p);
          }
          if (canManage || (isSelf && cur !== 'owner')) {
            actions += `<button class="ghost small ptc-remove" data-uid="${p.user_id}">&times;</button>`;
          }
          return `<div class="participant-row" data-uid="${p.user_id}">
            <span class="participant-name">${escHtml(p.username)}${p.callsign ? ` <span class="muted small">${escHtml(fmtCall(p.callsign))}</span>` : ''}</span>
            <span class="participant-pills">${rolePill}${statusPill}</span>
            <span class="participant-actions">${actions}</span>
          </div>`;
        }).join('')
      : `<p class="muted small" style="margin:4px 0">${escHtml(t('contestScreen.noParticipants'))}</p>`;

    list.innerHTML = `
      <div id="ptc-rows">${rows}</div>
      <div class="ptc-add-row">
        <input id="ptc-add-input" type="text" placeholder="${escHtml(t('contestScreen.addParticipantPlaceholder'))}" autocomplete="off" />
        <button type="button" id="ptc-add-btn" class="primary small">${escHtml(t('common.add'))}</button>
        <span id="ptc-add-err" class="error small"></span>
      </div>
    `;

    const doAdd = async () => {
      const inp = document.getElementById('ptc-add-input');
      const errEl = document.getElementById('ptc-add-err');
      const username = inp?.value.trim();
      if (!username) return;
      errEl.textContent = '';
      const res = await api('/api/contests/' + contestID + '/participants', {
        method: 'POST', body: JSON.stringify({ username }),
      });
      if (res.ok) {
        inp.value = '';
        loadModalParticipants(contestID, canManage);
      } else {
        const j = await res.json().catch(() => ({}));
        errEl.textContent = j.error || t('contestScreen.participantAddFail');
      }
    };
    document.getElementById('ptc-add-btn')?.addEventListener('click', doAdd);
    document.getElementById('ptc-add-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });

    list.querySelectorAll('.ptc-approve').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = Number(btn.dataset.uid);
        const p = (participants || []).find(x => x.user_id === uid);
        if (!p) return;
        const res = await api('/api/contests/' + contestID + '/participants/' + uid, {
          method: 'PUT', body: JSON.stringify({ role: p.role, status: 'active' }),
        });
        if (res.ok) loadModalParticipants(contestID, canManage);
        else alert(t('contestScreen.participantUpdateFail'));
      });
    });
    list.querySelectorAll('.ptc-role-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const uid = Number(sel.dataset.uid);
        const role = sel.value;
        const res = await api('/api/contests/' + contestID + '/participants/' + uid, {
          method: 'PUT', body: JSON.stringify({ role, status: 'active' }),
        });
        if (res.ok) {
          loadModalParticipants(contestID, canManage);
        } else {
          const j = await res.json().catch(() => ({}));
          alert(j.error || t('contestScreen.participantUpdateFail'));
          // Reload to reflect actual server state (e.g. the "cannot
          // demote the last owner" server-side guard).
          loadModalParticipants(contestID, canManage);
        }
      });
    });
    list.querySelectorAll('.ptc-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = Number(btn.dataset.uid);
        const res = await api('/api/contests/' + contestID + '/participants/' + uid, { method: 'DELETE' });
        if (res.ok) loadModalParticipants(contestID, canManage);
        else alert(t('contestScreen.participantUpdateFail'));
      });
    });
  }

  // ----- Contest WSJT-X bridge token modal -----
  // Shows the copy-pasteable "noc1.…" blob for THIS contest. The token
  // authorises the operator (via their per-account helper token) to log
  // QSOs into this one contest and no other — the contest ID is baked
  // in, so pasting the same blob into a bridge always targets the same
  // contest even if the operator later selects a different one in the
  // web UI.
  function contestWsjtxTokenModal(c) {
    if (!me?.helper_token) {
      showModal(`
        <h3>${escHtml(t('wsjtxToken.title'))}: ${escHtml(c.name)}</h3>
        <p class="error">${escHtml(t('wsjtxToken.noHelperToken'))}</p>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.close'))}</button>
        </div>
      `, null);
      return;
    }
    const token = encodeWsjtxToken({
      server: location.origin,
      helper_token: me.helper_token,
      contest_id: c.id,
      station_call: c.station_call || '',
    });
    showModal(`
      <h3>${escHtml(t('wsjtxToken.title'))}: ${escHtml(c.name)}</h3>
      <p class="muted small">${escHtml(t('wsjtxToken.intro'))}</p>
      <div class="row" style="margin-top:8px">
        <input id="wsjtx-token-out" type="text" readonly value="${escHtml(token)}" style="font-family:monospace" />
        <button type="button" id="wsjtx-token-copy" class="primary">${escHtml(t('settings.copy'))}</button>
      </div>
      <p class="muted small" style="margin-top:10px">${escHtml(t('wsjtxToken.regenHint'))}</p>
      <div class="modal-actions">
        <button type="button" class="ghost cancel-btn">${escHtml(t('common.close'))}</button>
      </div>
    `, null);

    const btn = document.querySelector('#modal-card #wsjtx-token-copy');
    const input = document.querySelector('#modal-card #wsjtx-token-out');
    btn?.addEventListener('click', async () => {
      if (!input) return;
      input.select();
      try { document.execCommand('copy'); } catch (_) {}
      if (navigator.clipboard) {
        try { await navigator.clipboard.writeText(input.value); } catch (_) {}
      }
      const original = btn.textContent;
      btn.textContent = t('contestScreen.shareCopied');
      setTimeout(() => { btn.textContent = original; }, 1500);
    });
  }

  // ----- Contest share-link modal -----
  // Renders the list of existing share tokens for the contest plus a button
  // to mint a new one.  Each row shows the URL with copy + revoke actions.
  function contestShareModal(c) {
    const rowsHtml = `<div id="share-list-rows" class="share-list-rows"><span class="muted small">${escHtml(t('common.loading'))}</span></div>`;
    showModal(`
      <h3>${escHtml(t('contestScreen.shareTitle'))}: ${escHtml(c.name)}</h3>
      <p class="muted small">${escHtml(t('contestScreen.shareCreateHint'))}</p>
      <div class="modal-actions" style="margin:8px 0 4px">
        <button type="button" id="share-create-btn" class="primary">${escHtml(t('contestScreen.shareCreate'))}</button>
      </div>
      <label style="margin-top:14px">${escHtml(t('contestScreen.shareList'))}</label>
      ${rowsHtml}
      <div class="modal-err error"></div>
      <div class="modal-actions">
        <button type="button" class="ghost cancel-btn">${escHtml(t('common.close'))}</button>
      </div>
    `, null);

    const errEl = document.querySelector('#modal-card .modal-err');

    function shareUrl(tok) {
      return `${window.location.origin}/?share=${encodeURIComponent(tok)}`;
    }

    function renderShareRow(s) {
      const url = shareUrl(s.token);
      const created = s.created_at ? new Date(s.created_at).toLocaleString(localeForFmt()) : '';
      // The "Send to chat" button is shown only when this contest is also
      // the active contest in the operator's session — chat is per-contest,
      // so it would be confusing (and useless) to offer the action when
      // they're not currently in the room (FR #23).
      const canSendChat = me?.contest_id === c.id;
      return `<div class="share-row" data-token="${escHtml(s.token)}">
        <div class="share-row-meta">
          <code class="share-row-url">${escHtml(url)}</code>
          <span class="muted small">${escHtml(t('contestScreen.shareCreated'))}: ${escHtml(created)}</span>
        </div>
        <div class="share-row-actions">
          <button class="ghost small share-copy-btn">${escHtml(t('contestScreen.shareCopyUrl'))}</button>
          ${canSendChat ? `<button class="ghost small share-chat-btn">${escHtml(t('contestScreen.shareSendChat'))}</button>` : ''}
          <button class="danger small share-revoke-btn">${escHtml(t('contestScreen.shareRevoke'))}</button>
        </div>
      </div>`;
    }

    function bindRowHandlers(container) {
      container.querySelectorAll('.share-copy-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.share-row');
          const tok = row?.dataset.token;
          if (!tok) return;
          const url = shareUrl(tok);
          try {
            await navigator.clipboard.writeText(url);
            const original = btn.textContent;
            btn.textContent = t('contestScreen.shareCopied');
            setTimeout(() => { btn.textContent = original; }, 1500);
          } catch {
            // Fallback for browsers without clipboard permission
            const ta = document.createElement('textarea');
            ta.value = url;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch {}
            document.body.removeChild(ta);
          }
        });
      });
      container.querySelectorAll('.share-revoke-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.share-row');
          const tok = row?.dataset.token;
          if (!tok) return;
          if (!await showConfirm(t('contestScreen.shareRevokeConfirm'), { ok: t('contestScreen.shareRevoke') })) return;
          const res = await api(`/api/contests/${c.id}/shares/${encodeURIComponent(tok)}`, { method: 'DELETE' });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            if (errEl) errEl.textContent = j.error || t('contestScreen.shareRevokeFail');
            return;
          }
          if (errEl) errEl.textContent = '';
          row.remove();
          ensureEmptyHint();
        });
      });
      // "Send to chat" — emit a sentinel-tagged chat message that the
      // recipient's chat renderer detects and turns into an "Apply this
      // config" card (FR #23). No backend chat change required; chat is
      // plain text on the wire and the prefix is just a convention.
      container.querySelectorAll('.share-chat-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const row = btn.closest('.share-row');
          const tok = row?.dataset.token;
          if (!tok) return;
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          const text = buildConfigOfferText(tok, c.name);
          try { ws.send(JSON.stringify({ type: 'chat', text })); } catch { return; }
          const original = btn.textContent;
          btn.textContent = t('contestScreen.shareSentChat');
          setTimeout(() => { btn.textContent = original; }, 1500);
        });
      });
    }

    // Build the sentinel message text used to ship a config offer through
    // the plain-text chat channel. Format:
    //   [noctalum-cfg:TOKEN:Contest Name]
    // The chat renderer (appendChatMessage) detects this exact prefix and
    // renders the "Apply this config" card instead of plain text.
    // Defined inside contestShareModal so c.name is in scope for the call
    // site above; the renderer itself uses its own regex against the raw
    // text and does not call this helper.
    function buildConfigOfferText(token, contestName) {
      // Strip ']' and ':' from the visible name part so the regex stays
      // unambiguous; both are not legal in tokens (base64-url) so the
      // colon between token and name is safe.
      const safeName = String(contestName || '').replace(/[\]:]/g, ' ');
      return `[noctalum-cfg:${token}:${safeName}]`;
    }

    function ensureEmptyHint() {
      const list = document.getElementById('share-list-rows');
      if (!list) return;
      if (!list.querySelector('.share-row')) {
        list.innerHTML = `<span class="muted small">${escHtml(t('contestScreen.shareNone'))}</span>`;
      }
    }

    async function refreshList() {
      const list = document.getElementById('share-list-rows');
      if (!list) return;
      const res = await api(`/api/contests/${c.id}/shares`);
      if (!res.ok) {
        list.innerHTML = `<span class="error small">${escHtml(t('contestScreen.shareLoadFail'))}</span>`;
        return;
      }
      const shares = await res.json();
      if (!shares || !shares.length) {
        list.innerHTML = `<span class="muted small">${escHtml(t('contestScreen.shareNone'))}</span>`;
        return;
      }
      list.innerHTML = shares.map(renderShareRow).join('');
      bindRowHandlers(list);
    }

    document.getElementById('share-create-btn')?.addEventListener('click', async () => {
      if (errEl) errEl.textContent = '';
      const res = await api(`/api/contests/${c.id}/shares`, { method: 'POST' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (errEl) errEl.textContent = j.error || t('contestScreen.shareCreateFail');
        return;
      }
      await refreshList();
    });

    refreshList();
  }

  // ----- Import shared configuration modal -----
  // Lets the operator paste a share URL or token, previews the contained
  // configuration, then creates a fresh contest from it (their station call /
  // QTH, the source contest's layout + custom fields + columns + bands).
  function contestImportShareModal(initialToken) {
    const canPriv = hasPerm('contests.create_private') || hasPerm('contests.manage_private');
    showModal(`
      <h3>${escHtml(t('contestScreen.importShareTitle'))}</h3>
      <form>
        <label>${escHtml(t('contestScreen.importSharePrompt'))}</label>
        <input name="token" autocomplete="off" required value="${escHtml(initialToken || '')}" />
        <div id="import-share-preview" class="muted small" style="margin-top:8px"></div>
        <hr style="margin:14px 0;border:none;border-top:1px solid var(--border)">
        <label>${escHtml(t('contestScreen.importShareNewName'))}</label>
        <input name="name" autocomplete="off" required />
        <label>${escHtml(t('contestScreen.stationCall'))}</label>
        <input name="station_call" autocomplete="off" autocapitalize="characters" required />
        <label>${escHtml(t('contestScreen.qthLocator'))}</label>
        <input name="qth" maxlength="6" autocapitalize="characters" style="text-transform:uppercase" />
        ${canPriv ? `<label style="margin-top:10px"><input type="checkbox" name="private" /> ${escHtml(t('contestScreen.privateContest'))}</label>` : ''}
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.cancel'))}</button>
          <button type="submit" class="primary">${escHtml(t('contestScreen.importShareSubmit'))}</button>
        </div>
      </form>
    `, async (form) => {
      const tok = extractShareToken(form.token.value);
      if (!tok) throw new Error(t('contestScreen.importShareLookupFail'));
      const res = await api('/api/import-share', {
        method: 'POST',
        body: JSON.stringify({
          token: tok,
          name: form.name.value.trim(),
          station_call: form.station_call.value.trim().toUpperCase(),
          qth: form.qth.value.trim().toUpperCase(),
          private: !!(form.private && form.private.checked),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('contestScreen.importShareCreateFail'));
      }
      await refreshContests();
      if (!$('contest-screen').classList.contains('hidden')) {
        const r = await api('/api/contests');
        if (r.ok) allContests = await r.json();
        renderContestPicker();
      }
    });

    const tokenInput = document.querySelector('#modal-card input[name="token"]');
    const preview = document.getElementById('import-share-preview');
    const nameInput = document.querySelector('#modal-card input[name="name"]');

    async function refreshPreview() {
      const tok = extractShareToken(tokenInput.value);
      if (!tok) { preview.textContent = ''; return; }
      const res = await fetch(`/api/share/${encodeURIComponent(tok)}`);
      if (!res.ok) {
        preview.innerHTML = `<span class="error">${escHtml(t('contestScreen.importShareLookupFail'))}</span>`;
        return;
      }
      const j = await res.json();
      const s = j.summary || {};
      preview.innerHTML = `
        <div><b>${escHtml(t('contestScreen.importSharePreviewTitle'))}</b> ${escHtml(j.source_name || '')}</div>
        <div>${escHtml(t('contestScreen.importSharePreviewFields'))} ${s.custom_field_count || 0}</div>
        <div>${escHtml(t('contestScreen.importSharePreviewLayout'))} ${s.layout_item_count || 0}</div>
        <div>${escHtml(t('contestScreen.importSharePreviewBands'))} ${escHtml((s.bands || []).map(fmtBand).join(', ') || '—')}</div>`;
      if (nameInput && !nameInput.value && j.source_name) {
        nameInput.value = j.source_name + t('contestScreen.duplicateSuffix');
      }
    }
    if (tokenInput) {
      tokenInput.addEventListener('input', () => {
        clearTimeout(tokenInput._previewTimer);
        tokenInput._previewTimer = setTimeout(refreshPreview, 250);
      });
      if (tokenInput.value) refreshPreview();
    }
  }

  // Extract the share token from either a raw token string or a full share
  // URL (?share=TOKEN).  Returns '' if nothing token-like is present.
  function extractShareToken(input) {
    const raw = (input || '').trim();
    if (!raw) return '';
    try {
      const u = new URL(raw, window.location.origin);
      const fromQuery = u.searchParams.get('share');
      if (fromQuery) return fromQuery.trim();
    } catch {}
    // Bare token — strip any leading "share=" prefix users sometimes paste.
    return raw.replace(/^share=/, '');
  }

  // ----- Contest duplicate modal -----
  function contestDuplicateModal(c) {
    const suggested = (c.name || '') + t('contestScreen.duplicateSuffix');
    showModal(`
      <h3>${escHtml(t('contestScreen.duplicateTitle'))}</h3>
      <form>
        <label>${escHtml(t('contestScreen.duplicatePrompt'))}</label>
        <input name="name" value="${escHtml(suggested)}" autocomplete="off" required />
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.cancel'))}</button>
          <button type="submit" class="primary">${escHtml(t('contestScreen.duplicateTitle'))}</button>
        </div>
      </form>
    `, async (form) => {
      const name = form.name.value.trim();
      if (!name) throw new Error(t('contestScreen.duplicatePrompt'));
      const res = await api('/api/contests/' + c.id + '/copy', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('contestScreen.duplicateFail'));
      }
      await refreshContests();
    });
    // Pre-select the suggested name so typing replaces it.
    setTimeout(() => {
      const inp = document.querySelector('#modal-card input[name="name"]');
      if (inp) inp.select();
    }, 0);
  }

  // ----- Contest access modal -----
  async function contestAccessModal(c) {
    const res = await api('/api/contests/' + c.id + '/access');
    if (!res.ok) { alert(t('contestScreen.accessLoadFail')); return; }
    const users = await res.json();

    const restrictedChecked = c.access_restricted ? 'checked' : '';
    const userRows = users.length ? users.map(u => `
      <div class="access-user-row" data-uid="${Number(u.user_id)}">
        <span>${escHtml(u.username)}${u.callsign ? ` <span class="muted small">${escHtml(fmtCall(u.callsign))}</span>` : ''}</span>
        <button type="button" class="ghost access-revoke-btn" data-uid="${Number(u.user_id)}">${escHtml(t('common.remove'))}</button>
      </div>
    `).join('') : `<p class="muted small">${escHtml(t('contestScreen.accessNoUsers'))}</p>`;

    const root = $('modal-root');
    const card = $('modal-card');
    card.classList.remove('modal-wide');
    card.innerHTML = `
      <h3>${escHtml(t('contestScreen.accessTitle', { name: c.name }))}</h3>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer">
        <input type="checkbox" id="access-restricted-toggle" ${restrictedChecked} />
        ${escHtml(t('contestScreen.accessRestrict'))}
      </label>
      <div id="access-user-list">${userRows}</div>
      <div style="display:flex;gap:8px;margin-top:12px;align-items:flex-end">
        <label style="flex:1;margin:0">${escHtml(t('contestScreen.accessAddUser'))}
          <input id="access-add-input" type="text" placeholder="${escHtml(t('contestScreen.accessAddPlaceholder'))}" autocomplete="off" style="margin-top:4px" />
        </label>
        <button type="button" id="access-add-btn" class="primary" style="width:auto;margin:0">${escHtml(t('common.add'))}</button>
      </div>
      <div id="access-modal-err" class="error" style="margin-top:6px"></div>
      <div class="modal-actions">
        <button type="button" class="ghost cancel-btn">${escHtml(t('common.close'))}</button>
      </div>
    `;
    root.classList.remove('hidden');
    card.querySelector('.cancel-btn').addEventListener('click', () => root.classList.add('hidden'));

    const toggle = document.getElementById('access-restricted-toggle');
    toggle?.addEventListener('change', async () => {
      const errEl = document.getElementById('access-modal-err');
      errEl.textContent = '';
      const r = await api('/api/contests/' + c.id + '/access', {
        method: 'PUT',
        body: JSON.stringify({ restricted: toggle.checked }),
      });
      if (!r.ok) {
        toggle.checked = !toggle.checked;
        errEl.textContent = t('contestScreen.accessRestrictFail');
        return;
      }
      c.access_restricted = toggle.checked;
      renderContestPicker();
    });

    document.querySelectorAll('.access-revoke-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.uid;
        const errEl = document.getElementById('access-modal-err');
        errEl.textContent = '';
        const r = await api('/api/contests/' + c.id + '/access/' + uid, { method: 'DELETE' });
        if (r.ok) {
          btn.closest('.access-user-row').remove();
        } else {
          errEl.textContent = t('contestScreen.accessRemoveFail');
        }
      });
    });

    document.getElementById('access-add-btn')?.addEventListener('click', async () => {
      const username = (document.getElementById('access-add-input')?.value || '').trim();
      if (!username) return;
      const errEl = document.getElementById('access-modal-err');
      errEl.textContent = '';
      const r = await api('/api/contests/' + c.id + '/access', {
        method: 'POST',
        body: JSON.stringify({ username }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        errEl.textContent = j.error || t('contestScreen.accessAddFail');
        return;
      }
      root.classList.add('hidden');
      contestAccessModal(c);
    });

    document.getElementById('access-add-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('access-add-btn')?.click(); }
    });
  }

  // ----- Custom fields editor -----
  function parseCustomFields(json) {
    if (!json) return [];
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) return [];
      return arr.filter(f => f && f.name);
    } catch { return []; }
  }
  // ----- ADIF field catalogue -----
  // The full ADIF QSO-field set, generated from the published specification
  // into adif-fields.js (see cmd/gen-adif-fields). Every field the spec
  // defines is offered here; `status` says why some of them cannot simply be
  // added:
  //   ''           the operator may add it to the contest
  //   'builtin'    Noctalum already logs it in a dedicated field (Call, Band,
  //                DOK, …), so adding it again would duplicate the ADIF tag
  //   'intl'       UTF-8 sibling of another field; the exporter switches to it
  //                on its own when a value needs it
  //   'deprecated' import-only per the spec — exporting it produces a file
  //                strict validators reject
  const ADIF_FIELDS = window.ADIF_FIELDS || [];
  const ADIF_GROUPS = window.ADIF_GROUPS || [];
  const ADIF_BY_NAME = new Map(ADIF_FIELDS.map(f => [f.name, f]));
  const ADIF_ADDABLE = ADIF_FIELDS.filter(f => !f.status);

  function adifFieldLabel(name) {
    // Falls back to the bare tag for a name the operator invented themselves.
    const key = 'adifField.' + name;
    const label = t(key);
    return label === key ? name : label;
  }

  // Why a catalogue entry cannot be added, as a sentence for the picker.
  function adifUnavailableReason(f) {
    switch (f.status) {
      case 'builtin': return t('contestScreen.cfPickerWhyBuiltin');
      case 'intl': {
        const base = f.name.replace(/_INTL$/, '');
        return t('contestScreen.cfPickerWhyIntl', { base });
      }
      case 'deprecated':
        return f.replaces
          ? t('contestScreen.cfPickerWhyDeprecated', { base: f.replaces })
          : t('contestScreen.cfPickerWhyDeprecatedNoAlt');
      default: return '';
    }
  }

  function buildCustomFieldsEditorHTML(fields) {
    const rows = (fields || []).map((f, i) => customFieldRowHTML(f, i)).join('');
    // <datalist> is emitted once per editor; each cf-name input references it
    // via list=. Browsers show it as typeahead but still accept free text, so
    // operators can keep inventing their own names. Only addable fields are
    // listed — suggesting a tag that would end up in the APP_ namespace is
    // worse than not suggesting it.
    const opts = ADIF_ADDABLE.map(f =>
      `<option value="${escHtml(f.name)}">${escHtml(adifFieldLabel(f.name))}</option>`).join('');
    return `
      <div class="cf-editor" id="cf-editor">
        <datalist id="cf-adif-suggestions">${opts}</datalist>
        <div class="cf-editor-rows">${rows}</div>
        <div class="cf-editor-actions">
          <button type="button" class="ghost cf-add-btn" id="cf-add-btn">${escHtml(t('contestScreen.cfAdd'))}</button>
          <button type="button" class="ghost cf-browse-btn" id="cf-browse-btn">${escHtml(t('contestScreen.cfBrowse'))}</button>
        </div>
        <div class="cf-picker hidden" id="cf-picker">
          <div class="cf-picker-intro muted small">${escHtml(t('contestScreen.cfPickerIntro', { v: window.ADIF_SPEC_VERSION || '' }))}</div>
          <input type="search" class="cf-picker-search" id="cf-picker-search" placeholder="${escHtml(t('contestScreen.cfPickerSearch'))}" />
          <label class="cf-picker-toggle">
            <input type="checkbox" id="cf-picker-showall" />
            <span>${escHtml(t('contestScreen.cfPickerShowUnavailable'))}</span>
          </label>
          <div class="cf-picker-list" id="cf-picker-list"></div>
          <div class="cf-picker-count muted small" id="cf-picker-count"></div>
        </div>
        <div class="cf-adif-hint muted small">${escHtml(t('contestScreen.cfAdifHint'))}</div>
      </div>`;
  }

  // Input kinds offered per field. `select` needs the options box; date/time
  // and textarea map onto the matching native controls in the QSO mask.
  const CF_TYPES = ['text', 'number', 'select', 'date', 'time', 'textarea'];

  function customFieldRowHTML(f, i) {
    const type = CF_TYPES.includes(f.type) ? f.type : 'text';
    const tOpt = CF_TYPES.map(tp => `<option value="${tp}"${type === tp ? ' selected' : ''}>${tp}</option>`).join('');
    return `
      <div class="cf-row" data-i="${i}">
        <div class="cf-row-fields">
          <input class="cf-name" list="cf-adif-suggestions" placeholder="${escHtml(t('contestScreen.cfNamePlaceholder'))}" value="${escHtml(f.name || '')}" />
          <input class="cf-label" placeholder="${escHtml(t('contestScreen.cfLabelPlaceholder'))}" value="${escHtml(f.label || '')}" />
          <select class="cf-type">${tOpt}</select>
          <input class="cf-options" placeholder="${escHtml(t('contestScreen.cfOptionsPlaceholder'))}" value="${escHtml((f.options || []).join(','))}" />
          <button type="button" class="ghost cf-del" title="${escHtml(t('contestScreen.cfRemoveTitle'))}">✕</button>
        </div>
        <div class="cf-row-opts">
          <label class="cf-req">
            <input type="checkbox" class="cf-required"${f.required ? ' checked' : ''} />
            <span>${escHtml(t('contestScreen.cfRequired'))}</span>
          </label>
        </div>
      </div>`;
  }

  // Row pre-filled from a catalogue entry: the operator gets the spec's label,
  // the right input control, and — for the closed enumerations — the legal
  // values, so they never have to look the tag up in the ADIF document.
  function customFieldRowFromADIF(f, i) {
    return customFieldRowHTML({
      name: f.name,
      label: adifFieldLabel(f.name),
      type: f.input,
      options: f.options || [],
    }, i);
  }

  function attachCustomFieldsEditorListeners() {
    const editor = document.getElementById('cf-editor');
    if (!editor) return;
    const rowsEl = editor.querySelector('.cf-editor-rows');
    const appendRow = (html) => {
      rowsEl.insertAdjacentHTML('beforeend', html);
      return rowsEl.lastElementChild;
    };

    document.getElementById('cf-add-btn')?.addEventListener('click', () => {
      appendRow(customFieldRowHTML({}, rowsEl.querySelectorAll('.cf-row').length));
    });

    const picker = document.getElementById('cf-picker');
    const browseBtn = document.getElementById('cf-browse-btn');
    browseBtn?.addEventListener('click', () => {
      const open = picker.classList.toggle('hidden') === false;
      browseBtn.textContent = t(open ? 'contestScreen.cfBrowseHide' : 'contestScreen.cfBrowse');
      if (open) {
        renderADIFPicker();
        document.getElementById('cf-picker-search')?.focus();
      }
    });
    document.getElementById('cf-picker-search')?.addEventListener('input', renderADIFPicker);
    document.getElementById('cf-picker-showall')?.addEventListener('change', renderADIFPicker);

    editor.addEventListener('click', (e) => {
      if (e.target && e.target.classList.contains('cf-del')) {
        e.target.closest('.cf-row')?.remove();
        renderADIFPicker();
        return;
      }
      const pick = e.target.closest?.('.cf-picker-item[data-adif]');
      if (pick) {
        const f = ADIF_BY_NAME.get(pick.dataset.adif);
        if (f) {
          const row = appendRow(customFieldRowFromADIF(f, rowsEl.querySelectorAll('.cf-row').length));
          renderADIFPicker();
          row?.scrollIntoView({ block: 'nearest' });
        }
      }
    });

    // Typing (or datalist-picking) a known ADIF tag fills in the rest of the
    // row, but only where the operator has left it untouched — re-typing a
    // name must never overwrite a label they wrote themselves.
    editor.addEventListener('change', (e) => {
      const nameInput = e.target;
      if (!nameInput?.classList?.contains('cf-name')) return;
      const f = ADIF_BY_NAME.get(nameInput.value.trim().toUpperCase());
      if (!f || f.status) return;
      const row = nameInput.closest('.cf-row');
      const labelEl = row.querySelector('.cf-label');
      const typeEl = row.querySelector('.cf-type');
      const optsEl = row.querySelector('.cf-options');
      if (!labelEl.value.trim()) labelEl.value = adifFieldLabel(f.name);
      if (typeEl.value === 'text') typeEl.value = f.input;
      if (!optsEl.value.trim() && f.options) optsEl.value = f.options.join(',');
      renderADIFPicker();
    });
  }

  function renderADIFPicker() {
    const list = document.getElementById('cf-picker-list');
    if (!list || document.getElementById('cf-picker')?.classList.contains('hidden')) return;
    const query = (document.getElementById('cf-picker-search')?.value || '').trim().toLowerCase();
    const showAll = !!document.getElementById('cf-picker-showall')?.checked;
    // Names already on a row are shown as "added" rather than hidden, so the
    // picker stays a stable map of the spec instead of shrinking as you work.
    const taken = new Set(_readCustomFieldsFromEditor().map(f => f.name.toUpperCase()));

    const matches = ADIF_FIELDS.filter(f => {
      if (f.status && !showAll) return false;
      if (!query) return true;
      return f.name.toLowerCase().includes(query) || adifFieldLabel(f.name).toLowerCase().includes(query);
    });

    if (!matches.length) {
      list.innerHTML = `<div class="cf-picker-empty muted small">${escHtml(t('contestScreen.cfPickerNoMatch', { q: query }))}</div>`;
    } else {
      list.innerHTML = ADIF_GROUPS.map(g => {
        const inGroup = matches.filter(f => f.group === g);
        if (!inGroup.length) return '';
        const items = inGroup.map(f => {
          const label = escHtml(adifFieldLabel(f.name));
          const tag = `<span class="cf-picker-tag">${escHtml(f.name)}</span><span class="cf-picker-label">${label}</span>`;
          if (f.status) {
            return `<div class="cf-picker-item unavailable">${tag}<span class="cf-picker-why">${escHtml(adifUnavailableReason(f))}</span></div>`;
          }
          if (taken.has(f.name)) {
            return `<div class="cf-picker-item added">${tag}<span class="cf-picker-why">${escHtml(t('contestScreen.cfPickerAdded'))}</span></div>`;
          }
          return `<button type="button" class="cf-picker-item" data-adif="${escHtml(f.name)}">${tag}</button>`;
        }).join('');
        return `<div class="cf-picker-group"><div class="cf-picker-group-title">${escHtml(t('adifGroup.' + g))}</div>${items}</div>`;
      }).join('');
    }
    const count = document.getElementById('cf-picker-count');
    if (count) {
      const total = showAll ? ADIF_FIELDS.length : ADIF_ADDABLE.length;
      count.textContent = t('contestScreen.cfPickerCount', { n: matches.length, total });
    }
  }

  // ----- ADIF export mapping editor -----
  // Which ADIF tag each Noctalum data field lands on. The list and the default
  // tags mirror adifSourceFields in internal/server/adif_mapping.go — keep in
  // sync; the server is authoritative and ignores anything it does not know.
  //
  // `fixed` marks a field whose mapping cannot be changed because it does not
  // correspond to a single tag (the QSO timestamp feeds QSO_DATE + TIME_ON).
  // An empty `def` means the field is not exported until the operator maps it.
  const ADIF_SOURCE_FIELDS = [
    { key: 'callsign',     def: 'CALL' },
    { key: 'name',         def: 'NAME' },
    { key: 'time',         def: 'QSO_DATE', fixed: true, also: 'TIME_ON' },
    { key: 'band',         def: 'BAND' },
    { key: 'freq',         def: 'FREQ' },
    { key: 'mode',         def: 'MODE',     also: 'SUBMODE' },
    { key: 'rst_sent',     def: 'RST_SENT' },
    { key: 'rst_received', def: 'RST_RCVD' },
    { key: 'nr_sent',      def: 'STX' },
    { key: 'nr_received',  def: 'SRX' },
    { key: 'dok',          def: 'DARC_DOK' },
    { key: 'locator',      def: 'GRIDSQUARE' },
    { key: 'itu',          def: 'ITUZ' },
    { key: 'cq',           def: 'CQZ' },
    { key: 'lighthouse',   def: 'SIG_INFO', also: 'SIG' },
    { key: 'operator',     def: 'OPERATOR' },
    { key: 'station_call', def: 'STATION_CALLSIGN' },
    { key: 'my_locator',   def: 'MY_GRIDSQUARE' },
    { key: 'contest_name', def: 'CONTEST_ID' },
    { key: 'notes',        def: 'NOTES' },
    { key: 'distance',     def: '' },
  ];
  // Sentinel for "export nothing for this field". It has to be distinct from
  // the empty string, which means "leave it on its default" — the same
  // distinction the stored blob makes on the server. Hyphens keep it out of
  // the ADIF tag namespace, so it can never collide with a real target.
  const ADIF_MAP_OFF = '--off--';

  function parseADIFMapping(json) {
    if (!json) return {};
    try {
      const o = JSON.parse(json);
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch { return {}; }
  }

  // Label for the left-hand column. The source keys are the same ones the log
  // column and QSO mask editors use, so the existing translations cover them.
  const ADIF_SOURCE_LABEL_KEYS = {
    callsign: 'qso.callsign', name: 'qso.name', time: 'qso.utcTime',
    band: 'qso.band', freq: 'qso.frequency', mode: 'qso.mode',
    rst_sent: 'qso.rstSent', rst_received: 'qso.rstReceived',
    nr_sent: 'qso.nrSent', nr_received: 'qso.nrReceived',
    dok: 'qso.dok', locator: 'qso.locator', itu: 'qso.itu', cq: 'qso.cq',
    lighthouse: 'qso.lighthouse', operator: 'contestScreen.adifMapOperator',
    station_call: 'contestScreen.stationCall', my_locator: 'contestScreen.adifMapMyLocator',
    contest_name: 'contestScreen.contestName', notes: 'qso.notes',
    distance: 'contestScreen.adifMapDistance',
  };
  function adifSourceLabel(key) {
    const k = ADIF_SOURCE_LABEL_KEYS[key];
    return k ? t(k) : key;
  }

  // One <select> holding every tag a field may be pointed at, grouped the way
  // the field picker groups them. Import-only fields are left out: exporting
  // one produces a file strict validators reject, and the server refuses them
  // anyway.
  function adifTargetOptions(src, current) {
    const opts = [];
    const defLabel = src.def
      ? t('contestScreen.adifMapDefaultIs', { tag: src.def })
      : t('contestScreen.adifMapDefaultNone');
    opts.push(`<option value=""${current === undefined ? ' selected' : ''}>${escHtml(defLabel)}</option>`);
    opts.push(`<option value="${ADIF_MAP_OFF}"${current === '' ? ' selected' : ''}>${escHtml(t('contestScreen.adifMapOff'))}</option>`);
    for (const g of ADIF_GROUPS) {
      const inGroup = ADIF_FIELDS.filter(f => f.group === g && f.status !== 'deprecated');
      if (!inGroup.length) continue;
      const items = inGroup.map(f =>
        `<option value="${escHtml(f.name)}"${current === f.name ? ' selected' : ''}>${escHtml(f.name)} — ${escHtml(adifFieldLabel(f.name))}</option>`
      ).join('');
      opts.push(`<optgroup label="${escHtml(t('adifGroup.' + g))}">${items}</optgroup>`);
    }
    return opts.join('');
  }

  function adifMappingRowHTML(src, mapping, readOnly) {
    const current = Object.prototype.hasOwnProperty.call(mapping, src.key) ? mapping[src.key] : undefined;
    const effective = current === undefined ? src.def : current;
    const d = readOnly ? ' disabled' : '';
    let control;
    if (src.fixed) {
      // Shown but not editable — "view" is half of what this editor is for.
      control = `<span class="adif-map-fixed">${escHtml(src.def)}${src.also ? ' + ' + escHtml(src.also) : ''}</span>`;
    } else {
      control = `<select class="adif-map-target" data-src="${escHtml(src.key)}"${d}>${adifTargetOptions(src, current)}</select>`;
    }
    // The companion tag only rides along while the field sits on its default.
    const companion = (src.also && !src.fixed && effective === src.def)
      ? `<span class="adif-map-also">+ ${escHtml(src.also)}</span>` : '';
    return `
      <div class="adif-map-row${src.fixed ? ' fixed' : ''}" data-src="${escHtml(src.key)}">
        <span class="adif-map-source">${escHtml(adifSourceLabel(src.key))}</span>
        <span class="adif-map-arrow">&rarr;</span>
        <span class="adif-map-control">${control}${companion}</span>
      </div>`;
  }

  // Custom fields get the same dropdown as the built-in fields. Their default
  // is derived from the field's own name, which is often not what the operator
  // means — a column called "Region" would land on ADIF's REGION (the WAE/CQ
  // region) when they wanted STATE — so being able to re-point one without
  // renaming the field is the whole point.
  function adifCustomRowsHTML(customFields, mapping, readOnly) {
    return (customFields || []).map(cf => {
      const key = ADIF_CF_PREFIX + cf.name;
      const current = Object.prototype.hasOwnProperty.call(mapping || {}, key) ? mapping[key] : undefined;
      const src = { key, def: adifTagForCustomField(cf.name) };
      const control = readOnly
        ? `<span class="adif-map-fixed">${escHtml(current === undefined ? src.def : (current || t('contestScreen.adifMapOff')))}</span>`
        : `<select class="adif-map-target" data-src="${escHtml(key)}">${adifTargetOptions(src, current)}</select>`;
      return `
        <div class="adif-map-row" data-src="${escHtml(key)}">
          <span class="adif-map-source">${escHtml(cf.label || cf.name)}</span>
          <span class="adif-map-arrow">&rarr;</span>
          <span class="adif-map-control">${control}</span>
        </div>`;
    }).join('');
  }

  // Namespaces a custom field inside the mapping blob, matching
  // adifCustomKeyPrefix in internal/server/adif_mapping.go.
  const ADIF_CF_PREFIX = 'cf:';

  // Mirrors adifFieldName + adif.Exportable in the Go exporter: a custom field
  // named after a standard ADIF tag lands on that tag, anything else on
  // APP_NOCTALUM_<NAME>.
  function adifTagForCustomField(name) {
    const tag = String(name || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_') || 'FIELD';
    const f = ADIF_BY_NAME.get(tag);
    if (f && f.status !== 'builtin' && f.status !== 'deprecated') return tag;
    return 'APP_NOCTALUM_' + tag;
  }

  function buildADIFMappingEditorHTML(mappingJSON, customFields, readOnly) {
    const mapping = parseADIFMapping(mappingJSON);
    const rows = ADIF_SOURCE_FIELDS.map(src => adifMappingRowHTML(src, mapping, readOnly)).join('');
    const reset = readOnly ? '' :
      `<button type="button" class="ghost" id="adif-map-reset">${escHtml(t('contestScreen.resetDefaults'))}</button>`;
    return `
      <div class="adif-map-editor" id="adif-map-editor" data-readonly="${readOnly ? '1' : '0'}">
        <div class="adif-map-intro muted small">${escHtml(t('contestScreen.adifMapIntro'))}</div>
        ${rows}
        <div id="adif-map-custom">${adifCustomBlockHTML(customFields, mapping, readOnly)}</div>
        <div class="adif-map-warn error small" id="adif-map-warn"></div>
        <div class="adif-map-actions">${reset}</div>
      </div>`;
  }

  function adifCustomBlockHTML(customFields, mapping, readOnly) {
    const custom = adifCustomRowsHTML(customFields, mapping, readOnly);
    return custom
      ? `<div class="adif-map-subhead">${escHtml(t('contestScreen.adifMapCustomHead'))}</div>${custom}`
      : '';
  }

  // The custom fields the mapping editors describe. Read live from the
  // custom-fields editor when one is on screen — all three contest dialogs
  // render both editors, and a field added in this session has to appear in
  // the mapping straight away.
  function _mappingCustomFields(fallback) {
    return document.getElementById('cf-editor') ? _readCustomFieldsFromEditor() : (fallback || []);
  }

  // Re-renders just the custom-field rows after the custom-fields editor
  // changed, carrying over any selections the operator has already made. A
  // full rebuild would discard them mid-edit.
  function refreshADIFMappingCustomRows() {
    const host = document.getElementById('adif-map-custom');
    const editor = document.getElementById('adif-map-editor');
    if (!host || !editor) return;
    const readOnly = editor.dataset.readonly === '1';
    const mapping = {};
    host.querySelectorAll('.adif-map-target').forEach(sel => {
      if (sel.value === '') return;
      mapping[sel.dataset.src] = sel.value === ADIF_MAP_OFF ? '' : sel.value;
    });
    host.innerHTML = adifCustomBlockHTML(_mappingCustomFields(), mapping, readOnly);
  }

  function attachADIFMappingListeners(customFields) {
    const editor = document.getElementById('adif-map-editor');
    if (!editor) return;
    const recheck = () => checkADIFMappingCollisions(_mappingCustomFields(customFields));
    editor.addEventListener('change', e => {
      if (!e.target?.classList?.contains('adif-map-target')) return;
      refreshADIFMappingRow(e.target.closest('.adif-map-row'));
      recheck();
    });
    document.getElementById('adif-map-reset')?.addEventListener('click', () => {
      editor.querySelectorAll('.adif-map-target').forEach(sel => { sel.value = ''; });
      editor.querySelectorAll('.adif-map-row').forEach(refreshADIFMappingRow);
      recheck();
    });
    // Adding, removing or renaming a custom field has to show up here too.
    // Deferred so the cf editor's own click handler has finished adding or
    // removing its row before we read the list back.
    const cfEd = document.getElementById('cf-editor');
    if (cfEd) {
      const sync = () => setTimeout(() => { refreshADIFMappingCustomRows(); recheck(); }, 0);
      cfEd.addEventListener('input', sync);
      cfEd.addEventListener('click', sync);
    }
    recheck();
  }

  // Keeps the "+ SIG" / "+ SUBMODE" hint honest as the operator changes a row.
  function refreshADIFMappingRow(row) {
    if (!row) return;
    const src = ADIF_SOURCE_FIELDS.find(f => f.key === row.dataset.src);
    const sel = row.querySelector('.adif-map-target');
    if (!src || !src.also || !sel) return;
    const onDefault = sel.value === '';
    let also = row.querySelector('.adif-map-also');
    if (onDefault && !also) {
      also = document.createElement('span');
      also.className = 'adif-map-also';
      also.textContent = '+ ' + src.also;
      row.querySelector('.adif-map-control').appendChild(also);
    } else if (!onDefault && also) {
      also.remove();
    }
  }

  // Reads the tag a row currently resolves to, following the same three-way
  // rule the stored blob uses: default / switched off / an explicit tag.
  function adifEffectiveTag(src) {
    if (src.fixed) return src.def;
    const sel = document.querySelector(`.adif-map-target[data-src="${src.key}"]`);
    if (!sel) return src.def;
    if (sel.value === '') return src.def;
    return sel.value === ADIF_MAP_OFF ? '' : sel.value;
  }

  // ADIF forbids a field name appearing twice in one record, so two Noctalum
  // fields pointed at the same tag means the later one is silently dropped on
  // export. Say so here rather than letting the operator find out from a
  // missing column in their log check.
  function checkADIFMappingCollisions(customFields) {
    const warn = document.getElementById('adif-map-warn');
    if (!warn) return;
    const byTag = new Map();
    const add = (tag, label) => {
      if (!tag) return;
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(label);
    };
    for (const src of ADIF_SOURCE_FIELDS) add(adifEffectiveTag(src), adifSourceLabel(src.key));
    for (const cf of (customFields || [])) {
      add(adifEffectiveTag({ key: ADIF_CF_PREFIX + cf.name, def: adifTagForCustomField(cf.name) }),
          cf.label || cf.name);
    }
    const clashes = [...byTag.entries()].filter(([, names]) => names.length > 1);
    warn.textContent = clashes.length
      ? clashes.map(([tag, names]) => t('contestScreen.adifMapCollision', { tag, fields: names.join(', ') })).join(' ')
      : '';
  }

  // Serialises overrides only — a field left on its default contributes no
  // key, so a later Noctalum that changes a default still applies it here.
  function serializeADIFMappingEditor() {
    const editor = document.getElementById('adif-map-editor');
    if (!editor) return '';
    const out = {};
    editor.querySelectorAll('.adif-map-target').forEach(sel => {
      const key = sel.dataset.src;
      if (sel.value === '') return;                            // default
      out[key] = sel.value === ADIF_MAP_OFF ? '' : sel.value;  // off, or a tag
    });
    return Object.keys(out).length ? JSON.stringify(out) : '';
  }

  // ----- Cabrillo exchange mapping editor -----
  // Cabrillo's QSO line is positional, not tagged. The format only fixes the
  // spine — frequency, mode, date, time, and the two callsigns — and
  // everything after each callsign is "the exchange", whose contents are
  // decided by the contest's rules. So where the ADIF editor asks "which tag
  // does this field land on", this one asks "which fields fill the exchange,
  // in what order".
  //
  // Mirrors cabrilloExchangeFields / cabrilloDefault* in
  // internal/server/cabrillo_mapping.go — keep in sync.
  const CABRILLO_EXCHANGE_FIELDS = [
    'rst_sent', 'rst_received', 'nr_sent', 'nr_received',
    'itu', 'cq', 'dok', 'locator', 'my_locator',
    'name', 'lighthouse', 'band', 'operator',
  ];
  const CABRILLO_DEFAULT = { sent: ['rst_sent', 'itu'], received: ['rst_received', 'cq'] };

  function parseCabrilloMapping(json) {
    if (!json) return null;
    try {
      const o = JSON.parse(json);
      if (!o || typeof o !== 'object') return null;
      if (!Array.isArray(o.sent) && !Array.isArray(o.received)) return null;
      return {
        sent: Array.isArray(o.sent) ? o.sent.filter(k => typeof k === 'string') : [],
        received: Array.isArray(o.received) ? o.received.filter(k => typeof k === 'string') : [],
      };
    } catch { return null; }
  }

  // Label for an exchange field. Built-ins reuse the ADIF editor's label map;
  // a custom field shows the label the operator gave it.
  function cabrilloFieldLabel(key, customFields) {
    const name = key.startsWith(ADIF_CF_PREFIX) ? key.slice(ADIF_CF_PREFIX.length) : null;
    if (name !== null) {
      const cf = (customFields || []).find(f => f.name === name);
      return (cf && cf.label) ? cf.label : name;
    }
    return adifSourceLabel(key);
  }

  function cabrilloFieldOptions(selected, customFields) {
    const keys = CABRILLO_EXCHANGE_FIELDS.concat(
      (customFields || []).filter(cf => cf.name).map(cf => ADIF_CF_PREFIX + cf.name));
    return keys.map(k =>
      `<option value="${escHtml(k)}"${k === selected ? ' selected' : ''}>${escHtml(cabrilloFieldLabel(k, customFields))}</option>`
    ).join('');
  }

  function cabrilloRowHTML(group, key, customFields, readOnly) {
    if (readOnly) {
      return `<div class="cbr-map-row" data-group="${group}">
        <span class="cbr-map-fixed">${escHtml(cabrilloFieldLabel(key, customFields))}</span>
      </div>`;
    }
    return `<div class="cbr-map-row" data-group="${group}">
      <select class="cbr-map-field">${cabrilloFieldOptions(key, customFields)}</select>
      <button type="button" class="ghost cbr-map-move" data-dir="-1" title="${escHtml(t('contestScreen.cbrMapMoveUp'))}">&uarr;</button>
      <button type="button" class="ghost cbr-map-move" data-dir="1" title="${escHtml(t('contestScreen.cbrMapMoveDown'))}">&darr;</button>
      <button type="button" class="ghost cbr-map-del" title="${escHtml(t('contestScreen.cbrMapRemove'))}">&#10005;</button>
    </div>`;
  }

  function cabrilloGroupHTML(group, keys, customFields, readOnly) {
    const titleKey = group === 'sent' ? 'contestScreen.cbrMapSent' : 'contestScreen.cbrMapReceived';
    const rows = keys.length
      ? keys.map(k => cabrilloRowHTML(group, k, customFields, readOnly)).join('')
      : `<div class="cbr-map-empty muted small">${escHtml(t('contestScreen.cbrMapEmpty'))}</div>`;
    const add = readOnly ? '' :
      `<button type="button" class="ghost cbr-map-add" data-group="${group}">${escHtml(t('contestScreen.cbrMapAdd'))}</button>`;
    return `
      <div class="cbr-map-group" data-group="${group}">
        <div class="cbr-map-group-title">${escHtml(t(titleKey))}</div>
        <div class="cbr-map-rows">${rows}</div>
        ${add}
      </div>`;
  }

  function buildCabrilloMappingEditorHTML(mappingJSON, customFields, readOnly) {
    const m = parseCabrilloMapping(mappingJSON) || CABRILLO_DEFAULT;
    const reset = readOnly ? '' :
      `<button type="button" class="ghost" id="cbr-map-reset">${escHtml(t('contestScreen.resetDefaults'))}</button>`;
    return `
      <div class="cbr-map-editor" id="cbr-map-editor" data-readonly="${readOnly ? '1' : '0'}">
        <div class="cbr-map-intro muted small">${escHtml(t('contestScreen.cbrMapIntro'))}</div>
        <div class="cbr-map-preview" id="cbr-map-preview"></div>
        ${cabrilloGroupHTML('sent', m.sent, customFields, readOnly)}
        ${cabrilloGroupHTML('received', m.received, customFields, readOnly)}
        <div class="cbr-map-actions">${reset}</div>
      </div>`;
  }

  function cabrilloGroupKeys(group) {
    const wrap = document.querySelector(`#cbr-map-editor .cbr-map-group[data-group="${group}"]`);
    if (!wrap) return [];
    return [...wrap.querySelectorAll('.cbr-map-row')].map(r =>
      r.querySelector('.cbr-map-field')?.value ?? r.dataset.key).filter(Boolean);
  }

  // A sample QSO line built from the current selection. Cabrillo's whole
  // difficulty is that the columns are positional and unlabelled, so showing
  // the shape of the line is worth more than any amount of prose.
  function renderCabrilloPreview(customFields) {
    const el = document.getElementById('cbr-map-preview');
    if (!el) return;
    const slot = keys => keys.map(k => '<' + cabrilloFieldLabel(k, customFields) + '>').join(' ');
    // Date and time are separate columns in the real line, so the preview
    // shows them separately too — the point of it is column-for-column
    // fidelity.
    const parts = ['QSO:', '<' + t('qso.frequency') + '>', '<' + t('qso.mode') + '>',
      '<' + t('contestScreen.cbrMapDate') + '>', '<' + t('contestScreen.cbrMapTime') + '>',
      '<' + t('contestScreen.stationCall') + '>'];
    const sent = slot(cabrilloGroupKeys('sent'));
    if (sent) parts.push(sent);
    parts.push('<' + t('qso.callsign') + '>');
    const rcvd = slot(cabrilloGroupKeys('received'));
    if (rcvd) parts.push(rcvd);
    el.textContent = parts.join(' ');
  }

  function attachCabrilloMappingListeners(customFields) {
    const editor = document.getElementById('cbr-map-editor');
    if (!editor) return;
    const fields = () => _mappingCustomFields(customFields);
    const redraw = () => renderCabrilloPreview(fields());

    editor.addEventListener('click', e => {
      const add = e.target.closest('.cbr-map-add');
      if (add) {
        const rows = editor.querySelector(`.cbr-map-group[data-group="${add.dataset.group}"] .cbr-map-rows`);
        rows.querySelector('.cbr-map-empty')?.remove();
        rows.insertAdjacentHTML('beforeend',
          cabrilloRowHTML(add.dataset.group, CABRILLO_EXCHANGE_FIELDS[0], fields(), false));
        redraw();
        return;
      }
      const del = e.target.closest('.cbr-map-del');
      if (del) {
        const row = del.closest('.cbr-map-row');
        const rows = row.parentElement;
        row.remove();
        if (!rows.querySelector('.cbr-map-row')) {
          rows.innerHTML = `<div class="cbr-map-empty muted small">${escHtml(t('contestScreen.cbrMapEmpty'))}</div>`;
        }
        redraw();
        return;
      }
      const move = e.target.closest('.cbr-map-move');
      if (move) {
        const row = move.closest('.cbr-map-row');
        const sibling = move.dataset.dir === '-1' ? row.previousElementSibling : row.nextElementSibling;
        if (sibling?.classList.contains('cbr-map-row')) {
          if (move.dataset.dir === '-1') sibling.before(row); else sibling.after(row);
        }
        redraw();
      }
    });
    editor.addEventListener('change', e => {
      if (e.target?.classList?.contains('cbr-map-field')) redraw();
    });
    document.getElementById('cbr-map-reset')?.addEventListener('click', () => {
      const ro = editor.dataset.readonly === '1';
      for (const g of ['sent', 'received']) {
        const wrap = editor.querySelector(`.cbr-map-group[data-group="${g}"] .cbr-map-rows`);
        wrap.innerHTML = CABRILLO_DEFAULT[g].map(k => cabrilloRowHTML(g, k, fields(), ro)).join('');
      }
      redraw();
    });
    // A custom field removed or renamed in the custom-fields editor must not
    // stay selectable here — the server drops unknown keys, and a stale option
    // would let the operator build an exchange that silently loses a column.
    const cfEd = document.getElementById('cf-editor');
    if (cfEd) {
      const sync = () => setTimeout(() => {
        const list = fields();
        const valid = new Set(CABRILLO_EXCHANGE_FIELDS.concat(
          list.filter(cf => cf.name).map(cf => ADIF_CF_PREFIX + cf.name)));
        editor.querySelectorAll('.cbr-map-row').forEach(row => {
          const sel = row.querySelector('.cbr-map-field');
          if (!sel) return;
          const keep = valid.has(sel.value) ? sel.value : CABRILLO_EXCHANGE_FIELDS[0];
          sel.innerHTML = cabrilloFieldOptions(keep, list);
          sel.value = keep;
        });
        redraw();
      }, 0);
      cfEd.addEventListener('input', sync);
      cfEd.addEventListener('click', sync);
    }
    redraw();
  }

  // Returns '' when the layout still matches the built-in default, so an
  // untouched contest stores nothing and keeps following the default if a
  // later Noctalum changes it.
  function serializeCabrilloMappingEditor() {
    if (!document.getElementById('cbr-map-editor')) return '';
    const out = { sent: cabrilloGroupKeys('sent'), received: cabrilloGroupKeys('received') };
    const same = g => out[g].length === CABRILLO_DEFAULT[g].length
      && out[g].every((k, i) => k === CABRILLO_DEFAULT[g][i]);
    if (same('sent') && same('received')) return '';
    return JSON.stringify(out);
  }

  // ----- New QSO mask layout -----
  // labelKey resolves through t() at render time so the editor matches the active language.
  const QSO_FIELD_DEFS = [
    { key: 'callsign',     labelKey: 'qso.callsign',     defaultW: 3, defaultPos: { x: 0, y: 0 } },
    { key: 'rst_sent',     labelKey: 'qso.rstSent',      defaultW: 2, defaultPos: { x: 3, y: 0 } },
    { key: 'rst_received', labelKey: 'qso.rstReceived',  defaultW: 2, defaultPos: { x: 5, y: 0 } },
    { key: 'nr_received',  labelKey: 'qso.nrReceived',   defaultW: 2, defaultPos: { x: 7, y: 0 } },
    { key: 'nr_sent',      labelKey: 'qso.nrSent',       defaultW: 2, defaultPos: { x: 9, y: 0 } },
    { key: 'mode',         labelKey: 'qso.mode',         defaultW: 2, defaultPos: { x: 0, y: 1 } },
    { key: 'band',         labelKey: 'qso.band',         defaultW: 2, defaultPos: { x: 2, y: 1 } },
    { key: 'freq',         labelKey: 'qso.frequency',    defaultW: 3, defaultPos: { x: 4, y: 1 } },
    { key: 'name',         labelKey: 'qso.name',         defaultW: 3, defaultPos: { x: 7, y: 1 } },
    { key: 'dok',          labelKey: 'qso.dok',          defaultW: 2, defaultHidden: true, defaultPos: { x: 0, y: 2 } },
    { key: 'locator',      labelKey: 'qso.locator',      defaultW: 3, defaultPos: { x: 2, y: 2 } },
    { key: 'itu',          labelKey: 'qso.itu',          defaultW: 2, defaultHidden: true, defaultPos: { x: 5, y: 2 } },
    { key: 'cq',           labelKey: 'qso.cq',           defaultW: 2, defaultHidden: true, defaultPos: { x: 7, y: 2 } },
    { key: 'lighthouse',   labelKey: 'qso.lighthouse',   defaultW: 3, defaultHidden: true, defaultPos: { x: 9, y: 2 } },
    { key: 'notes',        labelKey: 'qso.notes',        defaultW: 6, defaultPos: { x: 0, y: 3 } },
    { key: 'time',         labelKey: 'qso.utcTime',      defaultW: 3, defaultPos: { x: 6, y: 3 } },
  ];
  function _qsoFieldLabel(def) { return def && def.labelKey ? t(def.labelKey) : (def?.label || ''); }
  // Mandatory fields cannot be removed from the layout but can be moved/resized.
  const QSO_MANDATORY_KEYS = new Set([
    'callsign', 'rst_sent', 'rst_received',
    'mode', 'band', 'freq', 'time',
  ]);
  const LAYOUT_COLS = 12;

  function parseQSOLayout(json) {
    if (!json) return null;
    try {
      const o = JSON.parse(json);
      if (!o || typeof o !== 'object' || !Array.isArray(o.items)) return null;
      const items = o.items
        .filter(it => it && typeof it.key === 'string')
        .map(it => ({
          key: it.key,
          x: Math.max(0, Math.min(LAYOUT_COLS - 1, parseInt(it.x, 10) || 0)),
          y: Math.max(0, parseInt(it.y, 10) || 0),
          w: Math.max(1, Math.min(LAYOUT_COLS, parseInt(it.w, 10) || 1)),
        }));
      const removed = Array.isArray(o.removed)
        ? o.removed.filter(k => typeof k === 'string')
        : [];
      return { cols: LAYOUT_COLS, items, removed };
    } catch { return null; }
  }

  function defaultQSOLayout(customFields) {
    const items = QSO_FIELD_DEFS.filter(d => !d.defaultHidden).map(d => ({
      key: d.key,
      x: d.defaultPos.x,
      y: d.defaultPos.y,
      w: d.defaultW,
    }));
    let nextY = 4;
    for (const cf of (customFields || [])) {
      items.push({ key: 'cf:' + cf.name, x: 0, y: nextY, w: 3 });
      nextY++;
    }
    return { cols: LAYOUT_COLS, items };
  }

  function buildEffectiveLayout(layoutJSON, customFields) {
    const parsed = parseQSOLayout(layoutJSON);
    const def = defaultQSOLayout(customFields);
    const layout = parsed || def;
    const byKey = new Map(layout.items.map(it => [it.key, it]));
    // Honour the user's explicit removals: fields in `removed` are not auto-added back.
    // (Mandatory fields are exempt — they always reappear at their default position.)
    const removedSet = new Set((layout.removed || []).filter(k => !QSO_MANDATORY_KEYS.has(k)));
    // Ensure every known + cf field has an entry; place missing items at the bottom
    // (skip defaultHidden built-in fields and explicitly-removed fields).
    const known = new Set(QSO_FIELD_DEFS.map(d => d.key));
    const cfKeys = (customFields || []).map(cf => 'cf:' + cf.name);
    for (const k of cfKeys) known.add(k);
    let maxY = 0;
    for (const it of byKey.values()) maxY = Math.max(maxY, it.y);
    for (const k of known) {
      if (!byKey.has(k)) {
        if (removedSet.has(k)) continue;
        const def = QSO_FIELD_DEFS.find(d => d.key === k);
        if (def && def.defaultHidden) continue;
        const w = def ? def.defaultW : 3;
        byKey.set(k, { key: k, x: 0, y: ++maxY, w });
      }
    }
    // Drop items whose key is no longer known (e.g. removed custom field)
    for (const k of [...byKey.keys()]) if (!known.has(k)) byKey.delete(k);
    // Keep `removed` entries that still refer to known keys (drop stale ones)
    const finalRemoved = [...removedSet].filter(k => known.has(k));
    return { cols: LAYOUT_COLS, items: [...byKey.values()], removed: finalRemoved };
  }

  function applyQSOLayout() {
    const grid = document.getElementById('qso-grid');
    if (!grid) return;
    const customFields = parseCustomFields(me?.contest_fields);
    // Inject/update CF tiles into the grid
    syncCustomFieldTiles(grid, customFields);
    const layout = buildEffectiveLayout(me?.contest_qso_layout, customFields);
    const tiles = grid.querySelectorAll('[data-qso-field]');
    const present = new Map();
    for (const t of tiles) present.set(t.dataset.qsoField, t);
    for (const it of layout.items) {
      const tile = present.get(it.key);
      if (!tile) continue;
      tile.style.gridColumn = `${it.x + 1} / span ${it.w}`;
      tile.style.gridRow = `${it.y + 1}`;
      tile.classList.remove('hidden');
    }
    // Hide tiles that are not in the layout (shouldn't happen, but defensive)
    for (const [key, tile] of present) {
      if (!layout.items.some(it => it.key === key)) {
        tile.classList.add('hidden');
        const f = tile.querySelector('input, select, textarea');
        if (f) f.tabIndex = -1;
      }
    }
    // Assign tabindex in visual reading order (top-to-bottom, left-to-right)
    const sorted = [...layout.items].sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
    let tabIdx = 1;
    for (const it of sorted) {
      const tile = present.get(it.key);
      if (!tile) continue;
      const f = tile.querySelector('input, select, textarea');
      if (f) f.tabIndex = tabIdx++;
    }
  }

  function syncCustomFieldTiles(grid, customFields) {
    // Remove old CF tiles
    grid.querySelectorAll('[data-qso-field^="cf:"]').forEach(el => el.remove());
    for (const f of customFields) {
      const reqClass = f.required ? ' qso-cf-required' : '';
      const reqAttr = f.required ? ' required' : '';
      const inputId = 'qcf-' + cssIdSafe(f.name);
      const attrs = `id="${inputId}" data-cf-name="${escHtml(f.name)}" data-cf-required="${f.required ? '1' : '0'}"${reqAttr}`;
      let inputHtml = '';
      if (f.type === 'select' && Array.isArray(f.options) && f.options.length) {
        const opts = f.options.map(o => `<option value="${escHtml(o)}">${escHtml(o)}</option>`).join('');
        inputHtml = `<select ${attrs}><option value=""></option>${opts}</select>`;
      } else if (f.type === 'textarea') {
        // ADIF MultilineString fields (ADDRESS, QSLMSG, RIG, …). The export
        // rewrites the line breaks to CR/LF, which is what the spec wants.
        inputHtml = `<textarea ${attrs} rows="2"></textarea>`;
      } else if (f.type === 'number' || f.type === 'date' || f.type === 'time') {
        // date/time produce "2026-03-22" / "14:05"; internal/adif.Normalize
        // converts them to the ADIF forms on export.
        inputHtml = `<input ${attrs} type="${f.type}" />`;
      } else {
        inputHtml = `<input ${attrs} type="text" />`;
      }
      const label = document.createElement('label');
      label.className = 'qso-cf' + reqClass;
      label.dataset.qsoField = 'cf:' + f.name;
      label.innerHTML = (escHtml(f.label || f.name) + (f.required ? ' *' : '')) + inputHtml;
      grid.appendChild(label);
    }
  }

  // Render the active contest's custom fields and apply layout to the QSO entry form.
  function renderCustomFields() {
    applyQSOLayout();
  }
  function cssIdSafe(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }
  function collectCustomFieldsValues() {
    const grid = document.getElementById('qso-grid');
    if (!grid) return { values: {} };
    const values = {};
    const inputs = grid.querySelectorAll('[data-cf-name]');
    for (const el of inputs) {
      const name = el.dataset.cfName;
      const required = el.dataset.cfRequired === '1';
      const v = (el.value || '').trim();
      if (required && !v) {
        return { error: t('qso.requiredField', { name }) };
      }
      if (v) values[name] = v;
    }
    return { values };
  }

  function applyCustomFieldsValues(values) {
    if (!values || typeof values !== 'object') return;
    const grid = document.getElementById('qso-grid');
    if (!grid) return;
    grid.querySelectorAll('[data-cf-name]').forEach(el => {
      const name = el.dataset.cfName;
      if (name in values) el.value = values[name];
    });
  }

  function serializeCustomFieldsEditor() {
    const editor = document.getElementById('cf-editor');
    if (!editor) return '';
    const out = [];
    editor.querySelectorAll('.cf-row').forEach((row, i) => {
      const name = row.querySelector('.cf-name').value.trim();
      if (!name) return;
      const label = row.querySelector('.cf-label').value.trim() || name;
      const type = row.querySelector('.cf-type').value;
      const required = row.querySelector('.cf-required').checked;
      const optsStr = row.querySelector('.cf-options').value.trim();
      const options = optsStr ? optsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
      out.push({ name, label, type, required, options, order: i });
    });
    return JSON.stringify(out);
  }

  // ----- Log columns editor -----
  function buildLogColumnsEditorHTML(savedJson, customFields) {
    const cols = getEffectiveLogCols(savedJson, customFields);
    const items = cols.map(col => {
      const label = col.isCustom ? escHtml(col.label || col.key) : escHtml(t(col.labelKey));
      const on = col.on !== false;
      return `<div class="log-col-item" draggable="true" data-key="${escHtml(col.key)}">
        <span class="log-col-drag">⠿</span>
        <span class="log-col-label">${label}</span>
        <button type="button" class="cpill log-col-pill${on?' active':''}">${escHtml(on?t('contestScreen.logColVisible'):t('contestScreen.logColHidden'))}</button>
      </div>`;
    }).join('');
    return `<div id="log-cols-editor" class="log-cols-editor">${items}</div>`;
  }

  function serializeLogColumnsEditor() {
    const editor = document.getElementById('log-cols-editor');
    if (!editor) return '';
    const result = [];
    editor.querySelectorAll('.log-col-item[data-key]').forEach(item => {
      result.push({ key: item.dataset.key, on: item.querySelector('.log-col-pill')?.classList.contains('active') ?? false });
    });
    return result.length ? JSON.stringify(result) : '';
  }

  function initLogColDragDrop() {
    const editor = document.getElementById('log-cols-editor');
    if (!editor) return;
    let dragSrc = null;
    editor.addEventListener('dragstart', e => {
      dragSrc = e.target.closest('.log-col-item');
      if (dragSrc) { e.dataTransfer.effectAllowed = 'move'; dragSrc.classList.add('dragging'); }
    });
    editor.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = e.target.closest('.log-col-item');
      if (target && target !== dragSrc) {
        const rect = target.getBoundingClientRect();
        if (e.clientY > rect.top + rect.height / 2) target.after(dragSrc);
        else target.before(dragSrc);
      }
    });
    editor.addEventListener('dragend', () => { dragSrc?.classList.remove('dragging'); dragSrc = null; });
    editor.addEventListener('click', e => {
      const pill = e.target.closest('.log-col-pill');
      if (!pill) return;
      const on = pill.classList.toggle('active');
      pill.textContent = on ? t('contestScreen.logColVisible') : t('contestScreen.logColHidden');
    });
  }

  // ----- QSO layout editor (used inside contest modals) -----
  function buildLayoutEditorHTML() {
    return `
      <div class="layout-editor" id="layout-editor"></div>
      <div class="layout-suggested-wrap">
        <div class="layout-suggested-title">${escHtml(t('contestScreen.suggestedTitle'))}</div>
        <div class="layout-suggested" id="layout-suggested"></div>
      </div>
      <div class="layout-editor-help">
        ${escHtml(t('contestScreen.layoutHelp1'))}
        ${escHtml(t('contestScreen.layoutHelp2'))}
        ${escHtml(t('contestScreen.layoutHelp3'))}
        <button type="button" class="ghost" id="layout-reset-btn" style="margin-left:8px">${escHtml(t('contestScreen.resetDefaults'))}</button>
      </div>`;
  }

  // _layoutState holds the working copy used by the editor.
  let _layoutState = null;

  function _layoutFieldLabel(key) {
    if (key.startsWith('cf:')) {
      const name = key.slice(3);
      const cf = (_layoutState?.cfList || []).find(f => f.name === name);
      return (cf && cf.label) ? cf.label : name;
    }
    const def = QSO_FIELD_DEFS.find(d => d.key === key);
    return def ? _qsoFieldLabel(def) : key;
  }

  function _layoutItemsForEditor() {
    // Use current cf list (read live from the cf editor) for known keys.
    const cfList = _readCustomFieldsFromEditor();
    _layoutState.cfList = cfList;
    const layout = buildEffectiveLayout(_layoutState.json, cfList);
    _layoutState.json = JSON.stringify(layout);
    return layout;
  }

  function _readCustomFieldsFromEditor() {
    const editor = document.getElementById('cf-editor');
    if (!editor) return [];
    const out = [];
    editor.querySelectorAll('.cf-row').forEach((row, i) => {
      const name = (row.querySelector('.cf-name').value || '').trim();
      if (!name) return;
      const label = (row.querySelector('.cf-label').value || '').trim() || name;
      const type = row.querySelector('.cf-type').value;
      const required = row.querySelector('.cf-required').checked;
      const optsStr = (row.querySelector('.cf-options').value || '').trim();
      const options = optsStr ? optsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
      out.push({ name, label, type, required, options, order: i });
    });
    return out;
  }

  function renderLayoutEditor() {
    const root = document.getElementById('layout-editor');
    if (!root) return;
    const layout = _layoutItemsForEditor();
    const items = layout.items;
    root.innerHTML = items.map(it => {
      const mandatory = QSO_MANDATORY_KEYS.has(it.key);
      const lbl = _layoutFieldLabel(it.key);
      const cls = mandatory ? ' mandatory' : '';
      const prefix = mandatory ? '★ ' : '';
      return `
        <div class="layout-tile${cls}"
             data-layout-key="${escHtml(it.key)}"
             style="grid-column:${it.x + 1} / span ${it.w}; grid-row:${it.y + 1};">
          <span class="layout-tile-resize-handle" data-resize="left" title="Drag to resize"></span>
          <span class="layout-tile-label">${prefix}${escHtml(lbl)}</span>
          <span class="layout-tile-resize-handle" data-resize="right" title="Drag to resize"></span>
        </div>`;
    }).join('');
    _attachLayoutDragHandlers();
    renderSuggestedBox(items, layout.removed);
  }

  function renderSuggestedBox(currentItems, removed) {
    const root = document.getElementById('layout-suggested');
    if (!root) return;
    const usedKeys = new Set((currentItems || []).map(i => i.key));
    const suggestedKeys = new Set();
    for (const d of QSO_FIELD_DEFS) {
      if (d.defaultHidden && !usedKeys.has(d.key)) suggestedKeys.add(d.key);
    }
    for (const k of (removed || [])) {
      if (!usedKeys.has(k) && QSO_FIELD_DEFS.some(d => d.key === k)) suggestedKeys.add(k);
    }
    const suggested = [...suggestedKeys]
      .map(k => QSO_FIELD_DEFS.find(d => d.key === k))
      .filter(Boolean);
    if (suggested.length === 0) {
      root.innerHTML = '<span class="muted small" style="padding:2px 4px">' + escHtml(t('contestScreen.suggestedAllUsed')) + '</span>';
      return;
    }
    root.innerHTML = suggested.map(d =>
      `<div class="layout-suggested-tile" data-suggested-key="${escHtml(d.key)}">+ ${escHtml(_qsoFieldLabel(d))}</div>`
    ).join('');
    _attachSuggestedDragHandlers();
  }

  function _attachSuggestedDragHandlers() {
    const root = document.getElementById('layout-suggested');
    const editor = document.getElementById('layout-editor');
    if (!root || !editor) return;
    root.onpointerdown = (e) => {
      const tile = e.target.closest('.layout-suggested-tile');
      if (!tile) return;
      e.preventDefault();
      const key = tile.dataset.suggestedKey;
      const def = QSO_FIELD_DEFS.find(d => d.key === key);
      if (!def) return;

      // Insert the field at the bottom of the layout, then track the cursor
      // and snap the tile into the grid cell under the pointer.
      const layout = buildEffectiveLayout(_layoutState.json, _layoutState.cfList || []);
      let maxY = 0;
      for (const it of layout.items) maxY = Math.max(maxY, it.y);
      layout.items.push({ key, x: 0, y: maxY + 1, w: def.defaultW });
      layout.removed = (layout.removed || []).filter(k => k !== key);
      _layoutState.json = JSON.stringify(layout);
      renderLayoutEditor();

      const rowH = 50;
      const onMove = (ev) => {
        const rect = editor.getBoundingClientRect();
        if (ev.clientY < rect.top || ev.clientY > rect.bottom + 200) return;
        const colW = rect.width / LAYOUT_COLS;
        const relX = ev.clientX - rect.left;
        const relY = ev.clientY - rect.top;
        const nx = Math.max(0, Math.min(LAYOUT_COLS - 1, Math.floor(relX / colW)));
        const ny = Math.max(0, Math.floor(relY / rowH));
        _layoutMove(key, nx, ny);
        renderLayoutEditor();
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    };
  }

  // Find a non-overlapping placement for a tile of width `w`, preferring the row
  // and column closest to (targetX, targetY). Searches the target row first, then
  // expands outward; if no row at all has a gap that fits, falls back to a new row.
  function _findPlacement(others, targetX, targetY, w) {
    const clampedW = Math.max(1, Math.min(LAYOUT_COLS, w));
    function gapsInRow(y) {
      const occupied = others
        .filter(it => it.y === y)
        .map(it => [Math.max(0, it.x), Math.min(LAYOUT_COLS, it.x + it.w)])
        .filter(([s, e]) => e > s)
        .sort((a, b) => a[0] - b[0]);
      const gaps = [];
      let cursor = 0;
      for (const [s, e] of occupied) {
        if (s > cursor) gaps.push([cursor, s]);
        cursor = Math.max(cursor, e);
      }
      if (cursor < LAYOUT_COLS) gaps.push([cursor, LAYOUT_COLS]);
      return gaps;
    }
    function tryRow(y) {
      const gaps = gapsInRow(y);
      let best = null;
      for (const [s, e] of gaps) {
        const len = e - s;
        if (len < clampedW) continue;
        const minX = s;
        const maxX = s + len - clampedW;
        const snapped = Math.max(minX, Math.min(maxX, targetX));
        const dist = Math.abs(snapped - targetX);
        if (best === null || dist < best.dist) best = { x: snapped, dist };
      }
      return best;
    }
    const startY = Math.max(0, targetY);
    const r0 = tryRow(startY);
    if (r0) return { x: r0.x, y: startY, w: clampedW };
    for (let d = 1; d <= 64; d++) {
      if (startY - d >= 0) {
        const rUp = tryRow(startY - d);
        if (rUp) return { x: rUp.x, y: startY - d, w: clampedW };
      }
      const rDn = tryRow(startY + d);
      if (rDn) return { x: rDn.x, y: startY + d, w: clampedW };
    }
    let maxY = 0;
    for (const it of others) maxY = Math.max(maxY, it.y);
    return { x: 0, y: maxY + 1, w: clampedW };
  }

  // Collision-aware move: keeps `w`, snaps to the nearest gap that fits.
  function _layoutMove(key, targetX, targetY) {
    const layout = buildEffectiveLayout(_layoutState.json, _layoutState.cfList || []);
    const me = layout.items.find(i => i.key === key);
    if (!me) return;
    const others = layout.items.filter(it => it.key !== key);
    const p = _findPlacement(others, targetX, Math.max(0, targetY), me.w);
    me.x = p.x;
    me.y = p.y;
    me.w = p.w;
    _layoutState.json = JSON.stringify(layout);
  }

  // Collision-aware resize by edge ('left' or 'right'). origX/origW are the
  // pre-drag values; deltaCols is the snapped column delta of the pointer.
  function _layoutResizeTo(key, edge, origX, origW, deltaCols) {
    const layout = buildEffectiveLayout(_layoutState.json, _layoutState.cfList || []);
    const me = layout.items.find(i => i.key === key);
    if (!me) return;
    const sameRow = layout.items.filter(it => it.key !== key && it.y === me.y);
    if (edge === 'right') {
      let rightLimit = LAYOUT_COLS;
      for (const o of sameRow) {
        if (o.x >= origX + 1) rightLimit = Math.min(rightLimit, o.x);
      }
      const maxW = Math.max(1, rightLimit - origX);
      const newW = Math.max(1, Math.min(maxW, origW + deltaCols));
      me.x = origX;
      me.w = newW;
    } else {
      const rightEdge = origX + origW;
      let leftLimit = 0;
      for (const o of sameRow) {
        if (o.x < origX && o.x + o.w <= rightEdge) {
          leftLimit = Math.max(leftLimit, o.x + o.w);
        }
      }
      const maxW = Math.max(1, rightEdge - leftLimit);
      const newW = Math.max(1, Math.min(maxW, origW - deltaCols));
      me.x = rightEdge - newW;
      me.w = newW;
    }
    _layoutState.json = JSON.stringify(layout);
  }

  function _removeFieldFromLayout(key) {
    if (QSO_MANDATORY_KEYS.has(key)) return;
    const layout = buildEffectiveLayout(_layoutState.json, _layoutState.cfList || []);
    layout.items = layout.items.filter(it => it.key !== key);
    const removed = new Set(layout.removed || []);
    removed.add(key);
    layout.removed = [...removed];
    _layoutState.json = JSON.stringify(layout);
    renderLayoutEditor();
  }

  function _closeLayoutContextMenu() {
    document.querySelectorAll('.layout-context-menu').forEach(m => m.remove());
    document.removeEventListener('pointerdown', _layoutContextOutsideHandler, true);
    document.removeEventListener('keydown', _layoutContextKeyHandler, true);
  }
  function _layoutContextOutsideHandler(e) {
    if (!e.target.closest('.layout-context-menu')) _closeLayoutContextMenu();
  }
  function _layoutContextKeyHandler(e) {
    if (e.key === 'Escape') _closeLayoutContextMenu();
  }

  function _showLayoutContextMenu(x, y, key) {
    _closeLayoutContextMenu();
    const menu = document.createElement('div');
    menu.className = 'layout-context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layout-context-item';
    btn.textContent = t('common.remove');
    btn.addEventListener('click', () => {
      _closeLayoutContextMenu();
      _removeFieldFromLayout(key);
    });
    menu.appendChild(btn);
    document.body.appendChild(menu);
    // Clamp to viewport
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 4) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 4) + 'px';
    setTimeout(() => {
      document.addEventListener('pointerdown', _layoutContextOutsideHandler, true);
      document.addEventListener('keydown', _layoutContextKeyHandler, true);
    }, 0);
  }

  function _attachLayoutDragHandlers() {
    const root = document.getElementById('layout-editor');
    if (!root) return;
    root.oncontextmenu = (e) => {
      const tile = e.target.closest('.layout-tile');
      if (!tile) return;
      const key = tile.dataset.layoutKey;
      if (QSO_MANDATORY_KEYS.has(key)) return;
      e.preventDefault();
      _showLayoutContextMenu(e.clientX, e.clientY, key);
    };
    root.onpointerdown = (e) => {
      if (e.button === 2) return;
      const resize = e.target.closest('[data-resize]');
      const tile = e.target.closest('.layout-tile');
      if (!tile) return;
      const key = tile.dataset.layoutKey;
      const rect = root.getBoundingClientRect();
      const colW = rect.width / LAYOUT_COLS;
      const rowH = 50;
      const layout = buildEffectiveLayout(_layoutState.json, _layoutState.cfList || []);
      const it = layout.items.find(i => i.key === key);
      const startX = e.clientX, startY = e.clientY;
      const origX = it.x, origY = it.y, origW = it.w;
      const mode = resize ? 'resize' : 'move';
      const edge = resize ? resize.dataset.resize : null;

      let dragStarted = resize != null; // resize handles start immediately
      let longPressTimer = null;

      const beginDrag = () => {
        if (dragStarted) return;
        dragStarted = true;
        tile.classList.add('dragging');
      };

      if (dragStarted) {
        tile.classList.add('dragging');
      } else {
        // Long-press (500 ms) opens the context menu instead of dragging.
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          tile.releasePointerCapture?.(e.pointerId);
          if (!QSO_MANDATORY_KEYS.has(key)) {
            _showLayoutContextMenu(startX, startY, key);
          }
        }, 500);
      }

      tile.setPointerCapture?.(e.pointerId);

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        // Cancel long-press if pointer moves more than a few pixels.
        if (longPressTimer && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
          beginDrag();
        }
        if (!dragStarted) return;
        if (mode === 'move') {
          const nx = Math.round(origX + dx / colW);
          const ny = Math.round(origY + dy / rowH);
          _layoutMove(key, nx, Math.max(0, ny));
        } else {
          const deltaCols = Math.round(dx / colW);
          _layoutResizeTo(key, edge, origX, origW, deltaCols);
        }
        renderLayoutEditor();
      };
      const onUp = () => {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        tile.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      e.preventDefault();
    };
  }

  function attachLayoutEditorListeners(initialJSON) {
    _layoutState = { json: initialJSON || '' };
    renderLayoutEditor();
    document.getElementById('layout-reset-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      _layoutState.json = '';
      renderLayoutEditor();
    });
    // Re-render whenever the custom fields editor changes (add/remove rows or rename).
    const cfEd = document.getElementById('cf-editor');
    if (cfEd) {
      cfEd.addEventListener('input', () => renderLayoutEditor());
      cfEd.addEventListener('click', () => setTimeout(renderLayoutEditor, 0));
    }
  }

  function serializeQSOLayout() {
    if (!_layoutState) return '';
    // Recompute against the current cf list to drop dangling cf:* entries.
    const cfList = _readCustomFieldsFromEditor();
    const layout = buildEffectiveLayout(_layoutState.json, cfList);
    return JSON.stringify(layout);
  }

  // ----- users tab -----
  async function refreshUsers() {
    if (!hasPerm('users.manage')) return;
    const [uR, rR, pR] = await Promise.all([
      api('/api/users'), api('/api/roles'), api('/api/permissions')
    ]);
    if (!uR.ok || !rR.ok || !pR.ok) return;
    const users = await uR.json();
    allRoles = await rR.json();
    allPerms = await pR.json();
    renderUsers(users);
    renderRoles();
  }
  function renderUsers(users) {
    window.__usersCache = users || [];
    const tbody = $('users-tbody');
    tbody.innerHTML = '';
    if (!hasPerm('users.manage')) return;
    for (const u of users) {
      const tr = document.createElement('tr');
      const roles = (u.roles || []).map(r =>
        `<span class="badge ${r === 'admin' ? 'admin' : ''}">${escHtml(r)}</span>`).join('');
      const status = [];
      if (u.disabled) status.push(`<span class="badge disabled">${escHtml(t('users.statusDisabled'))}</span>`);
      if (u.locked_until && new Date(u.locked_until) > new Date()) {
        status.push(`<span class="badge locked">${escHtml(t('users.lockedFailures', { n: Number(u.failed_attempts) }))}</span>`);
      }
      if (!status.length) status.push(`<span class="muted">${escHtml(t('users.statusActive'))}</span>`);
      const lastAct = u.last_activity_at ? fmtRelTime(u.last_activity_at) : `<span class="muted">${escHtml(t('users.never'))}</span>`;
      tr.innerHTML = `
        <td>${escHtml(u.username)}</td>
        <td>${escHtml(fmtCall(u.callsign))}</td>
        <td>${roles}</td>
        <td>${status.join(' ')}</td>
        <td class="muted small">${lastAct}</td>
        <td class="actions">
          <button class="ghost" data-action="edit" data-id="${Number(u.id)}">${escHtml(t('common.edit'))}</button>
          <button class="ghost" data-action="password" data-id="${Number(u.id)}">${escHtml(t('users.resetPassword'))}</button>
          ${isAdmin() ? `<button class="ghost" data-action="unlock" data-id="${Number(u.id)}">${escHtml(t('users.unlock'))}</button>` : ''}
          ${isAdmin() ? `<button class="ghost" data-action="toggle" data-id="${Number(u.id)}" data-disabled="${u.disabled ? '1' : ''}">${u.disabled ? escHtml(t('users.enable')) : escHtml(t('users.disable'))}</button>` : ''}
          ${isAdmin() ? `<button class="ghost" data-action="delete" data-id="${Number(u.id)}">${escHtml(t('common.delete'))}</button>` : ''}
        </td>
      `;
      tr.querySelectorAll('button').forEach(b => b.addEventListener('click', () => userAction(u, b.dataset.action)));
      tbody.appendChild(tr);
    }
  }
  function renderRoles() {
    const root = $('roles-list');
    root.innerHTML = '';
    if (!hasPerm('users.manage')) return;
    for (const r of allRoles) {
      const card = document.createElement('div');
      card.className = 'role-card';
      const perms = (r.permissions || []).map(p =>
        `<span class="perm-chip">${p === '*' ? escHtml(t('users.allPermissions')) : escHtml(p)}</span>`).join('');
      card.innerHTML = `
        <div class="role-head">
          <div>
            <span class="role-name">${escHtml(r.name)}</span>
            ${r.is_builtin ? `<span class="badge">${escHtml(t('users.builtin'))}</span>` : ''}
          </div>
          <div>
            ${isAdmin() && r.name !== 'admin' ? `<button class="ghost" data-action="edit-role" data-id="${Number(r.id)}">${escHtml(t('users.editPerms'))}</button>` : ''}
            ${isAdmin() && !r.is_builtin ? `<button class="ghost" data-action="del-role" data-id="${Number(r.id)}">${escHtml(t('common.delete'))}</button>` : ''}
          </div>
        </div>
        <div class="perms">${perms}</div>
      `;
      card.querySelectorAll('button').forEach(b => b.addEventListener('click', () => roleAction(r, b.dataset.action)));
      root.appendChild(card);
    }
  }

  $('new-user-btn').addEventListener('click', () => userModal(null));
  $('new-role-btn').addEventListener('click', () => roleModal(null));

  async function userAction(u, action) {
    switch (action) {
      case 'edit': userModal(u); return;
      case 'password': passwordModal(u); return;
      case 'unlock':
        api('/api/users/' + u.id + '/unlock', { method: 'POST' }).then(refreshUsers);
        return;
      case 'toggle':
        api('/api/users/' + u.id, {
          method: 'PUT',
          body: JSON.stringify({ disabled: !u.disabled }),
        }).then(refreshUsers);
        return;
      case 'delete':
        if (await showConfirm(t('users.deleteConfirm', { u: u.username }), { ok: t('common.delete') })) {
          api('/api/users/' + u.id, { method: 'DELETE' }).then(refreshUsers);
        }
        return;
    }
  }

  async function roleAction(r, action) {
    switch (action) {
      case 'edit-role': roleModal(r); return;
      case 'del-role':
        if (await showConfirm(t('users.deleteRoleConfirm', { r: r.name }), { ok: t('common.delete') })) {
          api('/api/roles/' + r.id, { method: 'DELETE' }).then(refreshUsers);
        }
        return;
    }
  }

  // ----- modals -----
  function showModal(html, onSubmit, opts) {
    const root = $('modal-root');
    const card = $('modal-card');
    card.innerHTML = html;
    card.scrollTop = 0;
    card.classList.toggle('modal-wide', !!(opts && opts.wide));
    root.classList.remove('hidden');
    const form = card.querySelector('form');
    // Reported live: in the Map tab, clicking "Edit Contest", typing into a
    // field, then hitting Esc occasionally left the user with no way back to
    // normal interaction — the page needed a full reload. Two robustness
    // improvements close every plausible failure mode:
    //
    //   1. close() actively blurs the focused element before hiding the
    //      modal so the browser cannot leave focus stranded on a node
    //      that is about to enter display:none (which on some browsers
    //      means subsequent keystrokes go to nowhere).
    //   2. The modal-card carries its own Esc-keydown handler (capture
    //      phase, in case some upstream listener stopPropagation's). The
    //      existing document-level Esc handler stays in place as a
    //      second layer.
    //   3. Clicking the backdrop (outside the card) closes the modal —
    //      the standard expectation for centre-of-screen dialogs.
    //   4. The first form input is auto-focused so the operator can
    //      always see where their keystrokes will land.
    const close = () => {
      try { document.activeElement?.blur(); } catch {}
      root.classList.add('hidden');
      card.classList.remove('modal-wide');
      root.onclick = null;
      card.onkeydown = null;
    };
    card.querySelector('.cancel-btn')?.addEventListener('click', close);
    card.onkeydown = (e) => {
      if (e.key === 'Escape' && !root.classList.contains('hidden')) {
        e.preventDefault();
        close();
      }
    };
    root.onclick = (e) => {
      // Only fires on the backdrop (modal-root itself) — clicks inside
      // the card bubble through here too but e.target === card or its
      // descendants, never modal-root.
      if (e.target === root) close();
    };
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await onSubmit(form);
          close();
        } catch (err) {
          const errEl = card.querySelector('.modal-err');
          if (errEl) errEl.textContent = err.message;
        }
      });
    }
    // Auto-focus the first visible input/select/textarea so the
    // operator immediately knows where their keystrokes go, and a
    // subsequent Esc has an active element to bubble from.
    setTimeout(() => {
      const first = card.querySelector('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
      if (first) try { first.focus(); } catch {}
    }, 0);
  }

  function showConfirm(msg, opts = {}) {
    return new Promise(resolve => {
      const root = $('confirm-root');
      $('confirm-msg').textContent = msg;
      const okBtn = $('confirm-ok');
      okBtn.textContent = opts.ok || t('common.confirm');
      okBtn.className = opts.safe ? 'primary' : 'danger';
      // Re-apply i18n on the (static) Cancel button so it follows the active language.
      const cancelBtn = $('confirm-cancel');
      if (cancelBtn) cancelBtn.textContent = t('common.cancel');
      root.classList.remove('hidden');
      // Escape cancels any confirm; Enter accepts only *safe* confirms so a stray
      // Enter can never trigger a destructive action (delete, revoke, ...).
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter' && opts.safe && !e.isComposing) { e.preventDefault(); finish(true); }
      };
      const finish = (result) => {
        document.removeEventListener('keydown', onKey, true);
        root.classList.add('hidden');
        resolve(result);
      };
      document.addEventListener('keydown', onKey, true);
      $('confirm-cancel').onclick = () => finish(false);
      $('confirm-ok').onclick = () => finish(true);
      if (opts.safe) { try { okBtn.focus(); } catch {} }
    });
  }

  function userModal(u) {
    const isNew = u === null;
    const roleOptions = allRoles.map(r =>
      `<label><input type="checkbox" value="${escHtml(r.name)}" ${(!isNew && u.roles?.includes(r.name)) || (isNew && r.name === 'user') ? 'checked' : ''}/> ${escHtml(r.name)}</label>`
    ).join('');
    showModal(`
      <h3>${isNew ? escHtml(t('users.modalCreateUser')) : escHtml(t('users.modalEditUserNamed', { u: u.username }))}</h3>
      <form>
        ${isNew ? `<label>${escHtml(t('users.colUsername'))}</label><input name="username" required />
          <label>${escHtml(t('users.passwordMin'))}</label><input type="password" name="password" minlength="8" required />`
          : `<label>${escHtml(t('users.colUsername'))}</label>
             <input name="username" value="${escHtml(u.username)}" required autocapitalize="off" autocomplete="off" spellcheck="false" />
             <p class="muted small">${escHtml(t('users.usernameEditHint'))}</p>`}
        <label>${escHtml(t('users.colCallsign'))}</label>
        <input name="callsign" value="${isNew ? '' : escHtml(u.callsign)}" required />
        ${isAdmin() ? `<label>${escHtml(t('users.colRoles'))}</label>
        <div class="perm-grid">${roleOptions}</div>` : ''}
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.cancel'))}</button>
          <button type="submit" class="primary">${escHtml(t('common.save'))}</button>
        </div>
      </form>
    `, async (form) => {
      const roles = isAdmin()
        ? Array.from(form.querySelectorAll('input[type=checkbox]:checked')).map(i => i.value)
        : (isNew ? ['user'] : (u.roles || []));
      const callsign = form.callsign.value.trim().toUpperCase();
      let res;
      if (isNew) {
        res = await api('/api/users', { method: 'POST', body: JSON.stringify({
          username: form.username.value.trim(),
          password: form.password.value,
          callsign, roles,
        })});
      } else {
        const username = form.username.value.trim().toLowerCase();
        res = await api('/api/users/' + u.id, { method: 'PUT', body: JSON.stringify({ username, callsign, roles })});
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('common.saveFailed'));
      }
      refreshUsers();
    });
  }

  function passwordModal(u) {
    showModal(`
      <h3>${escHtml(t('users.resetPwdTitle', { u: u.username }))}</h3>
      <form>
        <label>${escHtml(t('users.resetPwdField'))}</label>
        <input type="password" name="password" minlength="8" required />
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.cancel'))}</button>
          <button type="submit" class="primary">${escHtml(t('users.resetPassword'))}</button>
        </div>
      </form>
    `, async (form) => {
      const res = await api('/api/users/' + u.id + '/password', {
        method: 'POST',
        body: JSON.stringify({ Password: form.password.value }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('common.saveFailed'));
      }
    });
  }

  function roleModal(r) {
    const isNew = r === null;
    const isAdmin = !isNew && r.name === 'admin';
    const checks = allPerms.map(p => {
      const checked = !isNew && r.permissions?.includes(p);
      return `<label><input type="checkbox" value="${escHtml(p)}" ${checked ? 'checked' : ''} ${isAdmin ? 'disabled' : ''}/> ${escHtml(p)}</label>`;
    }).join('');
    showModal(`
      <h3>${isNew ? escHtml(t('users.modalCreateRole')) : escHtml(t('users.modalEditRoleNamed', { r: r.name }))}</h3>
      <form>
        ${isNew ? `<label>${escHtml(t('users.roleNameLabel'))}</label><input name="name" required />` : ''}
        ${isAdmin ? `<p class="muted small">${escHtml(t('users.adminImmutable'))}</p>` : ''}
        <label>${escHtml(t('users.permissionsLabel'))}</label>
        <div class="perm-grid">${checks}</div>
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.cancel'))}</button>
          <button type="submit" class="primary" ${isAdmin ? 'disabled' : ''}>${escHtml(t('common.save'))}</button>
        </div>
      </form>
    `, async (form) => {
      const perms = Array.from(form.querySelectorAll('input[type=checkbox]:checked')).map(i => i.value);
      let res;
      if (isNew) {
        res = await api('/api/roles', { method: 'POST', body: JSON.stringify({
          name: form.name.value.trim(),
          permissions: perms,
        })});
      } else {
        res = await api('/api/roles/' + r.id, { method: 'PUT', body: JSON.stringify({ permissions: perms })});
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('common.saveFailed'));
      }
      refreshUsers();
    });
  }

  // ----- groups admin -----
  //
  // Groups are reusable sets of users a contest owner can grant access to.
  // Any authed user with groups.manage may create a group and becomes its
  // first owner; only the group's owners (or someone with users.manage)
  // may rename it, delete it, or change membership. The server enforces
  // this authoritatively — this UI just hides affordances the caller
  // wouldn't be able to use.
  let allGroups = [];
  async function refreshGroups() {
    if (!hasPerm('groups.manage')) return;
    const r = await api('/api/groups');
    if (!r.ok) return;
    allGroups = await r.json();
    renderGroups();
  }
  function renderGroups() {
    const tbody = $('groups-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const empty = $('groups-empty');
    if (!allGroups.length) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    for (const g of allGroups) {
      const tr = document.createElement('tr');
      const canManage = isAdmin() || hasPerm('users.manage') || g.my_role === 'owner';
      const roleLabel = g.my_role === 'owner'
        ? escHtml(t('groups.roleOwner'))
        : (g.my_role === 'member' ? escHtml(t('groups.roleMember')) : `<span class="muted">${escHtml(t('groups.roleNone'))}</span>`);
      tr.innerHTML = `
        <td>${escHtml(g.name)}</td>
        <td>${Number(g.member_count || 0)}</td>
        <td>${roleLabel}</td>
        <td class="actions">
          <button class="ghost" data-action="view" data-id="${Number(g.id)}">${escHtml(t('common.view'))}</button>
          ${canManage ? `<button class="ghost" data-action="edit" data-id="${Number(g.id)}">${escHtml(t('common.edit'))}</button>` : ''}
          ${canManage ? `<button class="ghost" data-action="delete" data-id="${Number(g.id)}">${escHtml(t('common.delete'))}</button>` : ''}
        </td>
      `;
      tr.querySelectorAll('button').forEach(b => b.addEventListener('click', () => groupAction(g, b.dataset.action)));
      tbody.appendChild(tr);
    }
  }
  async function groupAction(g, action) {
    if (action === 'view' || action === 'edit') {
      const r = await api('/api/groups/' + g.id);
      if (!r.ok) return;
      const detail = await r.json();
      const canManage = isAdmin() || hasPerm('users.manage') || (detail.members || []).some(m => m.user_id === me.user_id && m.is_owner);
      groupModal(detail, action === 'edit' && canManage);
    } else if (action === 'delete') {
      if (!await showConfirm(t('groups.deleteConfirm', { name: g.name }), { ok: t('common.delete') })) return;
      const r = await api('/api/groups/' + g.id, { method: 'DELETE' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error || t('common.deleteFailed'));
        return;
      }
      refreshGroups();
    }
  }
  $('new-group-btn')?.addEventListener('click', () => groupCreateModal());
  function groupCreateModal() {
    showModal(`
      <h3>${escHtml(t('groups.newGroup'))}</h3>
      <form>
        <label>${escHtml(t('groups.name'))}</label>
        <input name="name" required maxlength="120" />
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.cancel'))}</button>
          <button type="submit" class="primary">${escHtml(t('common.create'))}</button>
        </div>
      </form>
    `, async (form) => {
      const res = await api('/api/groups', { method: 'POST', body: JSON.stringify({ name: form.name.value.trim() }) });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('common.saveFailed'));
      }
      refreshGroups();
    });
  }
  // groupModal renders a rich view: rename input (editable only when
  // canManage) plus a members list with add / remove / owner-toggle.
  // Because member mutations happen synchronously (one HTTP call each),
  // the modal re-renders itself after every change instead of relying on
  // form submit. The form submit only handles the rename.
  function groupModal(group, canManage) {
    const memberRows = (group.members || []).map(m => `
      <tr>
        <td>${escHtml(m.username)}</td>
        <td>${escHtml(fmtCall(m.callsign))}</td>
        <td>${canManage
          ? `<input type="checkbox" data-owner-toggle data-uid="${Number(m.user_id)}" ${m.is_owner ? 'checked' : ''} />`
          : (m.is_owner ? '✓' : '')}</td>
        <td>${canManage ? `<button class="ghost small" data-member-remove data-uid="${Number(m.user_id)}">${escHtml(t('common.remove'))}</button>` : ''}</td>
      </tr>
    `).join('');
    showModal(`
      <h3>${escHtml(t('groups.modalTitle'))}: ${escHtml(group.name)}</h3>
      <form>
        <label>${escHtml(t('groups.name'))}</label>
        <input name="name" value="${escHtml(group.name)}" ${canManage ? '' : 'disabled'} required maxlength="120" />
        <h4 style="margin-top:16px">${escHtml(t('groups.members'))}</h4>
        ${canManage ? `
          <div class="group-add-row" style="display:flex;gap:8px;align-items:end;margin-bottom:8px">
            <label style="flex:1">${escHtml(t('groups.addUsername'))}
              <input id="gm-add-username" type="text" autocomplete="off" />
            </label>
            <label style="display:flex;align-items:center;gap:6px;padding-bottom:6px">
              <input id="gm-add-is-owner" type="checkbox" />
              <span>${escHtml(t('groups.owner'))}</span>
            </label>
            <button type="button" id="gm-add-btn" class="primary">${escHtml(t('groups.addMember'))}</button>
          </div>
          <div id="gm-add-error" class="error small"></div>
        ` : ''}
        <table>
          <thead>
            <tr>
              <th>${escHtml(t('users.colUsername'))}</th>
              <th>${escHtml(t('users.colCallsign'))}</th>
              <th>${escHtml(t('groups.owner'))}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${memberRows}</tbody>
        </table>
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.close'))}</button>
          ${canManage ? `<button type="submit" class="primary">${escHtml(t('common.save'))}</button>` : ''}
        </div>
      </form>
    `, async (form) => {
      const newName = form.name.value.trim();
      if (newName !== group.name) {
        const r = await api('/api/groups/' + group.id, { method: 'PUT', body: JSON.stringify({ name: newName }) });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || t('common.saveFailed'));
        }
      }
      refreshGroups();
    });
    // Wire the per-member controls only when the caller can manage.
    if (!canManage) return;
    const addErr = document.getElementById('gm-add-error');
    document.getElementById('gm-add-btn')?.addEventListener('click', async () => {
      if (addErr) addErr.textContent = '';
      const username = document.getElementById('gm-add-username').value.trim();
      const isOwner = document.getElementById('gm-add-is-owner').checked;
      if (!username) return;
      const r = await api('/api/groups/' + group.id + '/members', {
        method: 'POST',
        body: JSON.stringify({ username, is_owner: isOwner }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (addErr) addErr.textContent = j.error || t('common.saveFailed');
        return;
      }
      // Reload the modal with fresh state.
      const g2 = await (await api('/api/groups/' + group.id)).json();
      groupModal(g2, true);
    });
    document.querySelectorAll('[data-owner-toggle]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const uid = Number(cb.dataset.uid);
        const r = await api('/api/groups/' + group.id + '/members/' + uid, {
          method: 'PUT',
          body: JSON.stringify({ is_owner: cb.checked }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          alert(j.error || t('common.saveFailed'));
          // Reload to reflect actual server state.
          const g2 = await (await api('/api/groups/' + group.id)).json();
          groupModal(g2, true);
        }
      });
    });
    document.querySelectorAll('[data-member-remove]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = Number(btn.dataset.uid);
        if (!await showConfirm(t('groups.removeConfirm'), { ok: t('common.remove') })) return;
        const r = await api('/api/groups/' + group.id + '/members/' + uid, { method: 'DELETE' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          alert(j.error || t('common.deleteFailed'));
          return;
        }
        const g2 = await (await api('/api/groups/' + group.id)).json();
        groupModal(g2, true);
      });
    });
  }

  // ----- contest templates -----
  //
  // A template is a stored contest shape: bands, custom fields, the New QSO
  // mask layout, log columns, objective markdown, NR padding, frequency unit
  // and stash expiry. Station callsign / station ID / QTH are deliberately
  // not part of it so a template can be shared across a club without
  // dragging one operator's station identity along.
  //
  // Any user with contest_templates.manage (in the default "user" role) may
  // keep their own catalogue; ticking "shared" publishes one to everybody.
  // Editing and deleting is restricted to the template's owner or someone
  // with contests.manage — the server enforces that authoritatively, this UI
  // just hides affordances the caller could not use anyway.
  function renderTemplates() {
    const tbody = $('templates-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const empty = $('templates-empty');
    if (!allTemplates.length) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    for (const tpl of allTemplates) {
      const tr = document.createElement('tr');
      const canManage = tpl.my_role === 'owner' || hasPerm('contests.manage') || hasPerm('contest.admin');
      const fieldCount = parseCustomFields(tpl.custom_fields || '').length;
      const bands = (tpl.bands || []).length
        ? (tpl.bands || []).map(b => escHtml(fmtBand(b))).join(', ')
        : `<span class="muted">${escHtml(t('templates.noBands'))}</span>`;
      const owner = tpl.owner_user_id
        ? escHtml(tpl.owner_username || '')
        : `<span class="muted">${escHtml(t('templates.builtIn'))}</span>`;
      tr.innerHTML = `
        <td>${escHtml(tpl.name)}</td>
        <td>${bands}</td>
        <td>${fieldCount}</td>
        <td>${owner}</td>
        <td>${tpl.shared ? escHtml(t('common.yes')) : `<span class="muted">${escHtml(t('common.no'))}</span>`}</td>
        <td class="actions">
          <button class="ghost" data-action="view">${escHtml(canManage ? t('common.edit') : t('common.view'))}</button>
          ${canManage ? `<button class="ghost" data-action="delete">${escHtml(t('common.delete'))}</button>` : ''}
        </td>
      `;
      tr.querySelectorAll('button').forEach(b => b.addEventListener('click', () => templateAction(tpl, b.dataset.action, canManage)));
      tbody.appendChild(tr);
    }
  }

  async function templateAction(tpl, action, canManage) {
    if (action === 'view') {
      templateModal(tpl, false, canManage);
    } else if (action === 'delete') {
      if (!await showConfirm(t('templates.deleteConfirm', { name: tpl.name }), { ok: t('common.delete') })) return;
      const r = await api('/api/contest-templates/' + tpl.id, { method: 'DELETE' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error || t('common.deleteFailed'));
        return;
      }
      // Deleting a template never touches contests already created from it.
      refreshTemplates();
    }
  }

  // templateModal reuses the very same custom-fields / layout / log-column
  // editors as the contest dialogs, so a shape built here lands in a contest
  // without any translation step — both sides speak the same JSON.
  function templateModal(tpl, isNew, canManage = true) {
    const t0 = tpl || { bands: [], nr_padded: true, freq_unit: 'kHz', stash_expiry_minutes: 60, shared: false };
    const fields = parseCustomFields(t0.custom_fields || '');
    const readOnly = !isNew && !canManage;
    const d = readOnly ? ' disabled' : '';
    showModal(`
      <h3>${escHtml(isNew ? t('templates.newTemplate') : (readOnly ? t('templates.viewTitle') : t('templates.editTitle')))}</h3>
      <form${readOnly ? ' class="contest-modal-readonly"' : ''}>
        <label>${escHtml(t('templates.name'))}</label>
        <input name="tpl_name" value="${escHtml(t0.name || '')}" maxlength="120" placeholder="${escHtml(t('templates.namePlaceholder'))}"${d} required />
        <label>${escHtml(t('templates.defaultName'))} <span class="muted small">${escHtml(t('templates.defaultNameHint'))}</span></label>
        <input name="default_name" value="${escHtml(t0.default_name || '')}" placeholder="${escHtml(t('contestScreen.contestNamePlaceholder'))}"${d} />
        <label style="margin-top:10px"><input type="checkbox" name="shared" ${t0.shared ? 'checked' : ''}${d} /> ${escHtml(t('templates.shared'))} <span class="muted small">${escHtml(t('templates.sharedHint'))}</span></label>
        ${buildBandSelectHTML(t0.bands || [])}
        <label style="margin-top:10px"><input type="checkbox" name="nr_padded" ${t0.nr_padded !== false ? 'checked' : ''}${d} /> ${escHtml(t('contestScreen.nrPadded'))}</label>
        <label style="margin-top:10px">${escHtml(t('contestScreen.freqUnit'))}
          <select name="freq_unit"${d}>
            ${['Hz','kHz','MHz','GHz'].map(u => `<option value="${u}"${(t0.freq_unit || 'kHz') === u ? ' selected' : ''}>${escHtml(u)}</option>`).join('')}
          </select>
        </label>
        <label style="margin-top:10px">${escHtml(t('contestScreen.stashExpiryMinutes'))}
          <input type="number" name="stash_expiry_minutes" min="1" max="10080" value="${escHtml(String(t0.stash_expiry_minutes > 0 ? t0.stash_expiry_minutes : 60))}"${d} style="width:120px" />
          <span class="muted small">${escHtml(t('contestScreen.stashExpiryHint'))}</span>
        </label>
        <label style="margin-top:10px">${escHtml(t('contestScreen.customFields'))} <span class="muted small">${escHtml(t('contestScreen.customFieldsPerQSO2'))}</span></label>
        ${buildCustomFieldsEditorHTML(fields)}
        <label style="margin-top:10px">${escHtml(t('contestScreen.layoutEditor'))} <span class="muted small">${escHtml(t('contestScreen.layoutHint'))}</span></label>
        ${buildLayoutEditorHTML()}
        <label style="margin-top:10px">${escHtml(t('contestScreen.objective'))} <span class="muted small">${escHtml(t('contestScreen.objectiveMdOptional'))}</span></label>
        <div class="md-editor-wrap">
          <textarea name="objective" placeholder="${escHtml(t('contestScreen.objectivePlaceholder'))}"${d}>${escHtml(t0.objective || '')}</textarea>
          <div class="md-preview-pane objective-content" id="modal-md-preview"></div>
        </div>
        <label style="margin-top:14px">${escHtml(t('contestScreen.logColumns'))}</label>
        <p class="muted small" style="margin:2px 0 0">${escHtml(t('contestScreen.logColumnsHint'))}</p>
        ${buildLogColumnsEditorHTML(t0.log_columns || '', fields)}
        <label style="margin-top:14px">${escHtml(t('contestScreen.adifMapping'))} <span class="muted small">${escHtml(t('contestScreen.adifMappingHint'))}</span></label>
        ${buildADIFMappingEditorHTML(t0.adif_mapping || '', fields, readOnly)}
        <label style="margin-top:14px">${escHtml(t('contestScreen.cabrilloMapping'))} <span class="muted small">${escHtml(t('contestScreen.cabrilloMappingHint'))}</span></label>
        ${buildCabrilloMappingEditorHTML(t0.cabrillo_mapping || '', fields, readOnly)}
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(readOnly ? t('common.close') : t('common.cancel'))}</button>
          ${readOnly ? '' : `<button type="submit" class="primary">${escHtml(isNew ? t('common.create') : t('common.save'))}</button>`}
        </div>
      </form>
    `, readOnly ? null : async (form) => {
      const body = {
        name: form.tpl_name.value.trim(),
        default_name: (form.default_name?.value || '').trim(),
        bands: selectedBandsFromModal(),
        objective: form.objective.value,
        custom_fields: serializeCustomFieldsEditor(),
        qso_layout: serializeQSOLayout(),
        adif_mapping: serializeADIFMappingEditor(),
        cabrillo_mapping: serializeCabrilloMappingEditor(),
        log_columns: serializeLogColumnsEditor(),
        nr_padded: form.nr_padded.checked,
        freq_unit: form.freq_unit?.value || 'kHz',
        stash_expiry_minutes: Math.max(1, parseInt(form.stash_expiry_minutes?.value || '60', 10) || 60),
        shared: !!form.shared?.checked,
      };
      const res = isNew
        ? await api('/api/contest-templates', { method: 'POST', body: JSON.stringify(body) })
        : await api('/api/contest-templates/' + tpl.id, { method: 'PUT', body: JSON.stringify(body) });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('common.saveFailed'));
      }
      await refreshTemplates();
    }, { wide: true });
    attachBandSelectListeners();
    attachCustomFieldsEditorListeners();
    attachLayoutEditorListeners(t0.qso_layout || '');
    initLogColDragDrop();
    attachADIFMappingListeners(fields);
    const ta = document.querySelector('#modal-card textarea[name=objective]');
    const preview = $('modal-md-preview');
    if (ta && preview) {
      preview.innerHTML = renderMarkdown(ta.value);
      ta.addEventListener('input', () => { preview.innerHTML = renderMarkdown(ta.value); });
    }
  }

  $('new-template-btn')?.addEventListener('click', () => templateModal(null, true));

  // ----- websocket -----
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws');
    ws.onopen = () => {
      if (wsRetry > 0 && me?.contest_id) {
        api('/api/qsos').then(r => r.ok ? r.json() : null).then(d => {
          if (d) { qsos = d; renderQsos(); }
        }).catch(() => {});
      }
      wsRetry = 0;
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'qso':
          if (msg.payload && msg.payload.contest_id === me?.contest_id &&
              !qsos.find(q => q.id === msg.payload.id)) {
            qsos.unshift(msg.payload);
            renderQsos(msg.payload.id);
            updateDuplicateBadge();
            updateNrPreview();
          }
          break;
        case 'qso_updated': {
          const idx = qsos.findIndex(q => q.id === msg.payload.id);
          if (idx !== -1) qsos[idx] = msg.payload;
          renderQsos();
          updateDuplicateBadge();
          updateNrPreview();
          break;
        }
        case 'qso_deleted':
          qsos = qsos.filter(q => q.id !== msg.payload.id);
          renderQsos();
          updateDuplicateBadge();
          updateNrPreview();
          break;

        case 'operators':
          operators = msg.payload || [];
          renderOperators();
          break;
        case 'global_operators':
          globalOperators = msg.payload || [];
          renderGlobalOperators();
          break;
        case 'rigs': {
          rigs = msg.payload || [];
          // Detect a TRX-driven frequency change on the currently selected rig.
          // Triggers a stash when:
          //   - a callsign has been entered
          //   - we're not in QSO-edit mode
          //   - the selected rig is connected and its freq moved by >= 100 Hz
          const selName = me?.selected_rig;
          if (selName) {
            const r = rigs.find(x => x.name === selName);
            const newFreq = r && r.connected ? r.freq_hz : null;
            const oldFreq = lastRigFreqs[selName];
            const haveCall = $('q-call').value.trim() !== '';
            if (newFreq != null && typeof oldFreq === 'number' && oldFreq > 0 &&
                Math.abs(newFreq - oldFreq) >= 100 &&
                haveCall && editingQsoId === null) {
              // Stash the in-flight pre-QSO using the OLD freq, then fall through to
              // applySelectedRigToForm() which will set q-freq to the new value.
              stashCurrentForm({ freqOverrideHz: oldFreq });
            }
            lastRigFreqs[selName] = newFreq;
          }
          renderRigSelect();
          renderRigList();
          renderOperators();
          applySelectedRigToForm();
          renderBandPills();
          break;
        }
        case 'stash_created':
          if (msg.payload && !stashes.find(s => s.id === msg.payload.id)) {
            stashes.unshift(msg.payload);
            renderStashList();
          }
          break;
        case 'stash_deleted':
          if (msg.payload) {
            const sid = msg.payload.id;
            const before = stashes.length;
            stashes = stashes.filter(s => s.id !== sid);
            if (stashes.length !== before) renderStashList();
          }
          break;
        case 'contest_updated':
          if (me && msg.payload.id === me.contest_id) {
            me.contest_status = msg.payload.status;
            me.contest_call = msg.payload.station_call;
            me.contest_name = msg.payload.name;
            if ('qth' in msg.payload) me.contest_qth = msg.payload.qth;
            if ('bands' in msg.payload) {
              me.contest_bands = (msg.payload.bands || []).join(',');
              // Repopulate the q-band <select> so newly-added bands appear
              // immediately and edits can move QSOs onto them (FR #60b).
              refreshContestBandSelect();
            }
            if ('objective' in msg.payload) me.contest_objective = msg.payload.objective;
            if ('station_id' in msg.payload) me.contest_station_id = msg.payload.station_id;
            const layoutAffected = ('custom_fields' in msg.payload) || ('qso_layout' in msg.payload);
            if ('custom_fields' in msg.payload) me.contest_fields = msg.payload.custom_fields;
            if ('qso_layout' in msg.payload) me.contest_qso_layout = msg.payload.qso_layout;
            if ('log_columns' in msg.payload) { me.contest_log_columns = msg.payload.log_columns; renderQsos(); }
            if ('nr_padded' in msg.payload) me.contest_nr_padded = msg.payload.nr_padded !== false;
            if ('freq_unit' in msg.payload) { me.contest_freq_unit = msg.payload.freq_unit || 'kHz'; updateFreqLabel(); renderQsos(); }
            // Visibility flip (owner toggled open/groups/private): update
            // cached mode so canManageThisContest / helpers reflect it,
            // then re-render the log to refresh row-level affordances.
            if ('visibility' in msg.payload) {
              me.contest_visibility = msg.payload.visibility;
              me.contest_private = msg.payload.visibility === 'private';
              renderQsos();
            }
            updateContestDisplay();
            applyContestReadonly();
            updateMap();
            renderBandPills();
            renderObjective();
            if (typeof renderCustomFields === 'function') renderCustomFields();
            // applyQSOLayout assigns gridColumn/gridRow + tabIndex from the layout
            // JSON.  Without this call the QSO-form positions update on next
            // page load but Tab order stays frozen on whatever order was applied
            // at form init — the symptom users see as "Tab jumps wildly".
            if (layoutAffected && typeof applyQSOLayout === 'function') applyQSOLayout();
          }
          break;
        case 'rig_select_denied':
          if (msg.payload && msg.payload.reason) {
            alert(t('ops.cannotSelectRig', { reason: msg.payload.reason }));
          }
          break;
        case 'chat':
          if (typeof onChatMessage === 'function') onChatMessage(msg.payload);
          break;
        case 'deploy_warning':
          // Snapshot the current startup_id before the restart so we can
          // detect a fast restart that completes before we see a network error.
          fetch('/api/ping').then(r => r.ok ? r.json() : null).then(j => {
            if (j?.startup_id) {
              _deployStartupId = j.startup_id;
              try { sessionStorage.setItem('noctalum.deployStartupId', j.startup_id); } catch {}
            }
          }).catch(() => {});
          showDeployWarning(msg.payload?.seconds || 60);
          break;
        case 'restore_starting':
          // A UI-triggered database restore is starting. The host-side
          // systemd unit will stop this container within a couple of
          // seconds, feed the requested backup into psql, then start
          // the container again. From the browser's POV it's the same
          // "server goes down briefly then comes back" flow as a
          // deploy — reuse the same modal + polling with a short
          // countdown and restore-specific copy.
          fetch('/api/ping').then(r => r.ok ? r.json() : null).then(j => {
            if (j?.startup_id) {
              _deployStartupId = j.startup_id;
              try { sessionStorage.setItem('noctalum.deployStartupId', j.startup_id); } catch {}
            }
          }).catch(() => {});
          showDeployWarning(5, {
            title: t('backups.restoreStartingTitle'),
            body: t('backups.restoreStartingBody', { filename: msg.payload?.backup_file || '' }),
          });
          break;
      }
    };
    ws.onclose = () => {
      ws = null;
      if (!me) return;
      const delay = Math.min(15000, 500 * Math.pow(2, wsRetry++));
      setTimeout(connectWS, delay);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  // ----- bootstrap -----
  async function refreshMe() {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (!res.ok) return false;
    const j = await res.json();
    if (j.setup_required) {
      show('setup-screen');
      return false;
    }
    me = j;
    csrfToken = j.csrf_token || null;
    if (me.language && window.I18N && me.language !== window.I18N.lang()) {
      window.I18N.setLang(me.language);
    }
    $('current-op').textContent = me.username + ' / ' + fmtCall(me.callsign);
    $('contest-current-op').textContent = me.username + ' / ' + fmtCall(me.callsign);
    return true;
  }

  // ----- Deploy warning -----
  // Phase progression: 'countdown' → 'restarting' → 'polling'
  let _deployCountdown = 0;
  let _deployInterval = null;
  let _deployPhase = 'countdown'; // 'countdown' | 'restarting' | 'polling'
  let _deployWentDown = false;    // true once we confirm the server stopped responding
  let _deployPollStart = 0;       // Date.now() when polling began
  let _deployPollTimer = null;    // setInterval for poll ticks
  let _deployStartupId = null;    // startup_id recorded before the restart

  function _deploySetText(timerText) {
    const ribbonText = t('deploy.title') + ' — ' + t('deploy.body') + ' ' + timerText;
    const timerEl = $('deploy-modal-timer');
    if (timerEl) timerEl.textContent = timerText;
    const ribbonEl = $('deploy-ribbon-text');
    if (ribbonEl) ribbonEl.textContent = ribbonText;
  }

  function _deployUpdateDisplays() {
    if (_deployPhase === 'countdown') {
      _deploySetText(_deployCountdown > 0
        ? t('deploy.countdown', { n: _deployCountdown })
        : t('deploy.restarting'));
    } else if (_deployPhase === 'restarting') {
      _deploySetText(t('deploy.restarting'));
    } else if (_deployPhase === 'polling') {
      const elapsed = Math.floor((Date.now() - _deployPollStart) / 1000);
      _deploySetText(elapsed < 5
        ? t('deploy.checkingAvailability')
        : t('deploy.stillWaiting', { n: elapsed }));
    }
  }

  async function _deployPollServer() {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch('/api/ping', { signal: ctrl.signal });
      clearTimeout(tid);
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        const sid = j.startup_id || null;
        // Reload when the server confirms it has restarted: either we saw it
        // go down first, or the startup token changed (covers fast restarts
        // that complete before the first poll fires a network error).
        if (_deployWentDown || (sid && _deployStartupId && sid !== _deployStartupId)) {
          try { sessionStorage.removeItem('noctalum.deployDeadline'); } catch {}
          try { sessionStorage.removeItem('noctalum.deployStartupId'); } catch {}
          window.location.reload();
          return;
        }
        // Server still appears to be the same process — keep waiting.
      }
    } catch (_) {
      // Network error / timeout — server is down or unreachable.
      _deployWentDown = true;
    }
    _deployUpdateDisplays();
  }

  function _startDeployPolling() {
    _deployPhase = 'polling';
    _deployWentDown = false;
    _deployPollStart = Date.now();
    _deployUpdateDisplays();
    if (_deployPollTimer) clearInterval(_deployPollTimer);
    // Update elapsed counter every second; poll server every 5 s.
    let _pollTick = 0;
    _deployPollTimer = setInterval(() => {
      _pollTick++;
      _deployUpdateDisplays();
      if (_pollTick % 5 === 0) _deployPollServer();
    }, 1000);
    // Kick off first poll immediately (don't wait 5 s).
    _deployPollServer();
  }

  function showDeployWarning(seconds, opts) {
    _deployCountdown = seconds;
    _deployPhase = 'countdown';
    const titleEl = $('deploy-modal-title');
    if (titleEl) titleEl.textContent = (opts && opts.title) || t('deploy.title');
    const bodyEl = $('deploy-modal-body');
    if (bodyEl) bodyEl.textContent = (opts && opts.body) || t('deploy.body');
    _deployUpdateDisplays();
    $('deploy-modal').classList.remove('hidden');
    // Save deadline AFTER showing the modal so a storage error can't prevent display.
    try { sessionStorage.setItem('noctalum.deployDeadline', String(Date.now() + seconds * 1000)); } catch {}
    if (_deployInterval) clearInterval(_deployInterval);
    _deployInterval = setInterval(() => {
      if (_deployCountdown > 0) {
        _deployCountdown--;
        _deployUpdateDisplays();
      }
      if (_deployCountdown === 0) {
        clearInterval(_deployInterval);
        _deployInterval = null;
        _deployPhase = 'restarting';
        _deployUpdateDisplays();
        // Ensure ribbon is visible even if user never clicked OK.
        $('deploy-ribbon').classList.remove('hidden');
        document.body.classList.add('deploy-ribbon-active');
        _startDeployPolling();
      }
    }, 1000);
  }

  $('deploy-modal-ok').addEventListener('click', () => {
    $('deploy-modal').classList.add('hidden');
    _deployUpdateDisplays();
    $('deploy-ribbon').classList.remove('hidden');
    document.body.classList.add('deploy-ribbon-active');
  });

  async function bootstrap() {
    const ok = await refreshMe();
    if (!ok) return;
    applyPermissionsToUI();
    await loadSettings();
    applyDefaults();
    // Fire the device-pair approver prompt asynchronously — it must not
    // block navigation into the contest screen / app.
    maybeShowApproverPrompt().catch(() => {});
    if (!me.contest_id) {
      await showContestScreen();
      return;
    }
    await enterApp();
  }

  // ----- passkey helpers -----
  function passkeyAvailable() {
    if (typeof window.PublicKeyCredential === 'undefined') return false;
    if (typeof navigator.credentials === 'undefined') return false;
    return true;
  }

  function b64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  function fromB64url(s) {
    const pad = s + '==='.slice((s.length + 3) % 4);
    const bin = atob(pad.replace(/-/g, '+').replace(/_/g, '/'));
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b.buffer;
  }

  // ----- passkey login -----
  $('passkey-login-btn').addEventListener('click', async () => {
    $('passkey-login-error').textContent = '';
    if (!passkeyAvailable()) {
      $('passkey-login-error').textContent = t('login.passkeysNeedSecure');
      return;
    }
    try {
      const beginRes = await fetch('/api/passkey/login/begin', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!beginRes.ok) {
        const j = await beginRes.json().catch(() => ({}));
        throw new Error(j.error || t('login.passkeyLoginFailed'));
      }
      const pk = await beginRes.json();
      pk.publicKey.challenge = fromB64url(pk.publicKey.challenge);
      if (pk.publicKey.allowCredentials) {
        pk.publicKey.allowCredentials = pk.publicKey.allowCredentials.map(c => ({
          ...c, id: fromB64url(c.id),
        }));
      }

      const assertion = await navigator.credentials.get({ publicKey: pk.publicKey });
      const payload = {
        id: assertion.id,
        rawId: b64url(assertion.rawId),
        type: assertion.type,
        response: {
          clientDataJSON: b64url(assertion.response.clientDataJSON),
          authenticatorData: b64url(assertion.response.authenticatorData),
          signature: b64url(assertion.response.signature),
          userHandle: assertion.response.userHandle ? b64url(assertion.response.userHandle) : null,
        },
      };

      const finishRes = await fetch('/api/passkey/login/finish', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!finishRes.ok) {
        const j = await finishRes.json().catch(() => ({}));
        throw new Error(j.error || t('login.passkeyLoginFailed'));
      }
      await bootstrap();
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        $('passkey-login-error').textContent = err.message || t('login.passkeyLoginFailed');
      }
    }
  });

  // ----- device-pairing login (unauthenticated device shows a QR) -----
  //
  // Flow:
  //   1. User clicks "Login with other device" on the login page.
  //   2. POST /api/login-request/create returns { id, ttl_seconds }.
  //   3. We render a QR of the current origin + "#approve=<id>", which any
  //      already-logged-in Noctalum tab reacts to by opening its approver
  //      modal.
  //   4. We long-poll /api/login-request/status?id=<id> until the server
  //      hands back a "approved" verdict — at which point it has already
  //      set the session cookie in the response, so we just call
  //      bootstrap() to enter the app.
  //
  // The modal covers the entire lifecycle including cancel/expire/deny.
  let devicePairAbort = null; // AbortController for the outstanding poll

  function stopDevicePair() {
    if (devicePairAbort) {
      try { devicePairAbort.abort(); } catch {}
      devicePairAbort = null;
    }
  }
  function closeDevicePairModal() {
    stopDevicePair();
    $('device-login-modal').classList.add('hidden');
    $('device-login-qr').innerHTML = '';
    $('device-login-status').textContent = '';
    $('device-login-error').textContent = '';
  }
  $('device-login-cancel').addEventListener('click', closeDevicePairModal);

  function renderPairQR(url) {
    const host = $('device-login-qr');
    host.innerHTML = '';
    if (typeof window.qrcode !== 'function') {
      host.textContent = url;
      return;
    }
    // qrcode-generator: use type 0 (auto) with error-correction "M".
    const q = window.qrcode(0, 'M');
    q.addData(url);
    q.make();
    // 5px per module, 8-module quiet zone → fits nicely inside the modal.
    host.innerHTML = q.createImgTag(5, 16);
    const img = host.querySelector('img');
    if (img) { img.style.width = '240px'; img.style.height = '240px'; }
  }

  async function pollDevicePair(id) {
    devicePairAbort = new AbortController();
    while (devicePairAbort) {
      let res;
      try {
        res = await fetch('/api/login-request/status?id=' + encodeURIComponent(id), {
          credentials: 'same-origin',
          signal: devicePairAbort.signal,
        });
      } catch (err) {
        if (err.name === 'AbortError') return;
        // Transient network error — pause and retry.
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      if (!res.ok) {
        $('device-login-error').textContent = t('devicelogin.pollFailed');
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (j.status === 'approved') {
        devicePairAbort = null;
        csrfToken = (j.session && j.session.csrf_token) || null;
        closeDevicePairModal();
        await bootstrap();
        return;
      }
      if (j.status === 'denied') {
        $('device-login-status').textContent = t('devicelogin.denied');
        return;
      }
      if (j.status === 'expired' || j.status === 'consumed') {
        $('device-login-status').textContent = t('devicelogin.expired');
        return;
      }
      // still pending — the long-poll already spent ~25s server-side, so
      // no client-side delay is needed before re-polling.
    }
  }

  $('device-login-btn').addEventListener('click', async () => {
    $('device-login-error').textContent = '';
    $('device-login-status').textContent = t('devicelogin.waiting');
    $('device-login-modal').classList.remove('hidden');
    try {
      const res = await fetch('/api/login-request/create', {
        method: 'POST', credentials: 'same-origin',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        $('device-login-error').textContent = j.error || t('devicelogin.createFailed');
        return;
      }
      const j = await res.json();
      const url = window.location.origin + '/#approve=' + encodeURIComponent(j.id);
      renderPairQR(url);
      pollDevicePair(j.id);
    } catch (err) {
      $('device-login-error').textContent = err.message || t('devicelogin.createFailed');
    }
  });

  // ----- device-pairing login (approver side) -----
  //
  // Scanning the QR opens Noctalum with "#approve=<id>" in the URL fragment.
  // If the user is logged in, we surface a modal showing the requester's
  // IP + User-Agent so they can approve or deny.  If they are NOT logged
  // in, the login screen appears first; we re-check the hash after
  // bootstrap so the approval prompt appears once they finish signing in.
  function pendingApproveID() {
    const m = /(?:^|[#&])approve=([A-Za-z0-9._-]+)/.exec(window.location.hash || '');
    return m ? m[1] : '';
  }
  function clearApproveHash() {
    if (window.location.hash.includes('approve=')) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }
  function fmtDeviceAge(iso) {
    try {
      const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
      if (secs < 60) return t('devicelogin.ageSecs', { s: secs });
      return t('devicelogin.ageMins', { m: Math.round(secs / 60) });
    } catch { return ''; }
  }
  // Very small User-Agent parser — collapses the typical UA into
  // "Firefox 128 on Windows 10" style labels.  Deliberately conservative.
  function summarizeUA(ua) {
    if (!ua) return '—';
    let os = '';
    if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
    else if (/Windows NT 6\.3/.test(ua)) os = 'Windows 8.1';
    else if (/Windows NT 6\.1/.test(ua)) os = 'Windows 7';
    else if (/Android ([\d.]+)/.test(ua)) os = 'Android ' + RegExp.$1;
    else if (/iPhone OS ([\d_]+)/.test(ua)) os = 'iOS ' + RegExp.$1.replace(/_/g, '.');
    else if (/Mac OS X ([\d_]+)/.test(ua)) os = 'macOS ' + RegExp.$1.replace(/_/g, '.');
    else if (/CrOS /.test(ua)) os = 'ChromeOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    let br = '';
    if (/Edg\/([\d.]+)/.test(ua)) br = 'Edge ' + RegExp.$1.split('.')[0];
    else if (/OPR\/([\d.]+)/.test(ua)) br = 'Opera ' + RegExp.$1.split('.')[0];
    else if (/Firefox\/([\d.]+)/.test(ua)) br = 'Firefox ' + RegExp.$1.split('.')[0];
    else if (/Chrome\/([\d.]+)/.test(ua)) br = 'Chrome ' + RegExp.$1.split('.')[0];
    else if (/Version\/([\d.]+).*Safari/.test(ua)) br = 'Safari ' + RegExp.$1.split('.')[0];
    if (br && os) return br + ' — ' + os;
    return br || os || ua;
  }

  async function maybeShowApproverPrompt() {
    const id = pendingApproveID();
    if (!id || !me) return;
    // Clear the hash immediately so a refresh doesn't re-open the prompt.
    clearApproveHash();
    const res = await api('/api/login-request/' + encodeURIComponent(id));
    if (!res.ok) {
      // Expired / consumed / not-found requests aren't actionable, but
      // log so a legitimate operator can see why the prompt did not
      // appear rather than being left silently on the main menu.
      try {
        const ej = await res.json();
        console.warn('device-pair: request unavailable', res.status, ej && ej.error);
      } catch { console.warn('device-pair: request unavailable', res.status); }
      return;
    }
    const j = await res.json();
    if (j.status !== 'pending') { console.warn('device-pair: request status is', j.status); return; }
    $('device-approve-ip').textContent = j.requester_ip || '—';
    $('device-approve-ua').textContent = summarizeUA(j.requester_ua || '');
    $('device-approve-age').textContent = fmtDeviceAge(j.created_at);
    $('device-approve-error').textContent = '';
    $('device-approve-modal').classList.remove('hidden');

    const okBtn = $('device-approve-ok');
    const denyBtn = $('device-approve-deny');
    const close = () => $('device-approve-modal').classList.add('hidden');
    const decide = async (approve) => {
      okBtn.disabled = true; denyBtn.disabled = true;
      const r = await api('/api/login-request/' + encodeURIComponent(id) + '/' + (approve ? 'approve' : 'deny'), { method: 'POST' });
      okBtn.disabled = false; denyBtn.disabled = false;
      if (!r.ok && r.status !== 204) {
        const ej = await r.json().catch(() => ({}));
        $('device-approve-error').textContent = ej.error || t('devicelogin.decisionFailed');
        return;
      }
      close();
    };
    okBtn.onclick = () => decide(true);
    denyBtn.onclick = () => decide(false);
  }

  // Some phone QR-scanners open the URL in an existing Noctalum tab.
  // In that case the browser only updates the fragment — no reload,
  // no bootstrap — so we react to hashchange as well.
  window.addEventListener('hashchange', () => {
    if (me && pendingApproveID()) maybeShowApproverPrompt().catch(() => {});
  });

  // ----- passkey management -----
  async function loadPasskeys() {
    const el = $('passkey-list');
    const res = await api('/api/passkey/credentials');
    if (!res.ok) return;
    const list = await res.json();
    if (!list || list.length === 0) {
      el.innerHTML = '<p class="muted small">' + escHtml(t('settings.passkeyNoneYet')) + '</p>';
      return;
    }
    el.innerHTML = list.map(pk => {
      const date = pk.created_at ? new Date(pk.created_at).toLocaleDateString(localeForFmt()) : '';
      return `<div class="passkey-item">
        <span class="passkey-name">&#128273; ${escHtml(pk.name || 'Passkey')}</span>
        <span class="muted small">${date}</span>
        <button class="ghost small" data-delete-passkey="${escHtml(pk.id)}">${escHtml(t('common.remove'))}</button>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-delete-passkey]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const credID = btn.dataset.deletePasskey;
        const res = await api('/api/passkey/credentials/' + encodeURIComponent(credID), { method: 'DELETE' });
        if (res.ok || res.status === 204) loadPasskeys();
      });
    });
  }

  $('register-passkey-btn').addEventListener('click', async () => {
    $('passkey-error').textContent = '';
    if (!passkeyAvailable()) {
      $('passkey-error').textContent = t('login.passkeysNeedSecure');
      return;
    }
    const name = encodeURIComponent($('passkey-name').value.trim() || 'Passkey');
    try {
      const beginRes = await api('/api/passkey/register/begin', { method: 'POST' });
      if (!beginRes.ok) {
        const j = await beginRes.json().catch(() => ({}));
        throw new Error(j.error || t('settings.passkeyRegFail'));
      }
      const pk = await beginRes.json();
      pk.publicKey.challenge = fromB64url(pk.publicKey.challenge);
      pk.publicKey.user.id = fromB64url(pk.publicKey.user.id);
      if (pk.publicKey.excludeCredentials) {
        pk.publicKey.excludeCredentials = pk.publicKey.excludeCredentials.map(c => ({
          ...c, id: fromB64url(c.id),
        }));
      }

      const cred = await navigator.credentials.create({ publicKey: pk.publicKey });
      const payload = {
        id: cred.id,
        rawId: b64url(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: b64url(cred.response.clientDataJSON),
          attestationObject: b64url(cred.response.attestationObject),
        },
      };

      const finishRes = await api('/api/passkey/register/finish?name=' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!finishRes.ok) {
        const j = await finishRes.json().catch(() => ({}));
        throw new Error(j.error || t('settings.passkeyRegFail'));
      }
      $('passkey-name').value = '';
      await loadPasskeys();
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        $('passkey-error').textContent = err.message || t('settings.passkeyRegFail');
      }
    }
  });

  // ----- audit log -----
  let auditEntries = [];
  let auditTotal = 0;
  let auditOffset = 0;
  const auditPageSize = 100;
  let auditSort = { col: 'timestamp', desc: true };
  let auditActions = [];

  const AUDIT_TZ_KEY = 'auditTimezone';
  function getAuditTZ() { return localStorage.getItem(AUDIT_TZ_KEY) || 'UTC'; }
  function setAuditTZ(tz) { localStorage.setItem(AUDIT_TZ_KEY, tz); }

  // Format a UTC ISO timestamp for display in the selected timezone.
  function formatAuditTimestamp(isoStr) {
    const tz = getAuditTZ();
    const d = new Date(isoStr);
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(d);
      const get = name => parts.find(p => p.type === name)?.value || '00';
      return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
    } catch {
      return d.toISOString().substring(0, 19).replace('T', ' ');
    }
  }

  // Compute tz offset in ms at a given UTC date: (UTC moment) - (same wall-clock read back as UTC).
  function tzOffsetMs(tz, utcDate) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(utcDate);
    const get = name => parts.find(p => p.type === name)?.value || '00';
    const apparent = new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`);
    return utcDate.getTime() - apparent.getTime();
  }

  // Interpret a datetime-local string as a wall-clock time in the selected tz, return UTC ISO.
  function auditLocalToUTC(str) {
    if (!str) return null;
    const tz = getAuditTZ();
    const rough = new Date(str + ':00Z'); // treat input as UTC to get a Date object
    if (tz === 'UTC') return rough.toISOString();
    try {
      const offset = tzOffsetMs(tz, rough);
      return new Date(rough.getTime() + offset).toISOString();
    } catch {
      return rough.toISOString();
    }
  }

  function updateAuditTZHeader() {
    const tz = getAuditTZ();
    const h = $('audit-ts-header');
    if (h) h.textContent = tz === 'UTC' ? t('audit.colTime') : t('audit.colTimeTZ', { tz });
  }

  function initAuditTZSelect() {
    const sel = $('audit-tz');
    if (!sel) return;
    const saved = getAuditTZ();
    let zones = ['UTC'];
    try { zones = ['UTC', ...Intl.supportedValuesOf('timeZone').filter(z => z !== 'UTC')]; } catch {}
    for (const z of zones) {
      const o = document.createElement('option');
      o.value = z; o.textContent = z;
      if (z === saved) o.selected = true;
      sel.appendChild(o);
    }
    // If saved value wasn't in the list, add it at top
    if (!zones.includes(saved)) {
      const o = document.createElement('option');
      o.value = saved; o.textContent = saved; o.selected = true;
      sel.insertBefore(o, sel.firstChild);
    }
    sel.addEventListener('change', () => {
      setAuditTZ(sel.value);
      updateAuditTZHeader();
      renderAuditLog();
    });
    updateAuditTZHeader();
  }

  initAuditTZSelect();

  function auditFilterParams(offset) {
    const params = new URLSearchParams();
    const level = $('audit-level').value;
    const action = $('audit-action').value;
    const search = $('audit-search').value.trim();
    const sinceUTC = auditLocalToUTC($('audit-since').value);
    const untilUTC = auditLocalToUTC($('audit-until').value);
    if (level) params.set('level', level);
    if (action) params.set('action', action);
    if (search) params.set('search', search);
    if (sinceUTC) params.set('since', sinceUTC);
    if (untilUTC) params.set('until', untilUTC);
    params.set('sort', auditSort.col);
    params.set('dir', auditSort.desc ? 'desc' : 'asc');
    params.set('limit', String(auditPageSize));
    params.set('offset', String(offset));
    return params;
  }

  async function refreshAuditLog(reset) {
    if (!hasPerm('audit.log')) return;
    if (reset) { auditEntries = []; auditOffset = 0; }
    const res = await api('/api/audit?' + auditFilterParams(auditOffset));
    if (!res.ok) return;
    const j = await res.json();
    auditTotal = j.total || 0;
    if (reset) auditEntries = j.entries || [];
    else auditEntries = auditEntries.concat(j.entries || []);
    auditOffset = auditEntries.length;
    // Populate action dropdown on first load
    if (auditActions.length === 0 && j.actions && j.actions.length) {
      auditActions = j.actions;
      const sel = $('audit-action');
      for (const a of auditActions) {
        const o = document.createElement('option');
        o.value = a; o.textContent = a;
        sel.appendChild(o);
      }
    }
    renderAuditLog();
  }

  function renderAuditLog() {
    const tbody = $('audit-tbody');
    tbody.innerHTML = '';
    for (const e of auditEntries) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${escHtml(formatAuditTimestamp(e.timestamp))}</td>
        <td><span class="audit-level audit-level-${escHtml(e.level)}">${escHtml(e.level)}</span></td>
        <td class="mono small">${escHtml(e.action)}</td>
        <td>${escHtml(e.actor)}</td>
        <td>${escHtml(e.target)}</td>
        <td class="muted small">${escHtml(e.details)}</td>
        <td class="mono small muted">${escHtml(e.ip)}</td>
      `;
      tbody.appendChild(tr);
    }
    const shown = auditEntries.length;
    $('audit-status').textContent = t('audit.showing', { shown, total: auditTotal });
    const moreBtn = $('audit-load-more');
    if (shown < auditTotal) {
      moreBtn.classList.remove('hidden');
      moreBtn.textContent = t('audit.loadMoreCount', { n: auditTotal - shown });
    } else {
      moreBtn.classList.add('hidden');
    }
    updateAuditSortArrows();
  }

  function updateAuditSortArrows() {
    document.querySelectorAll('#audit-table th.sortable').forEach(th => {
      const arrow = th.querySelector('.sort-arrow');
      if (th.dataset.col === auditSort.col) {
        arrow.textContent = auditSort.desc ? ' ▼' : ' ▲';
        th.classList.add('sort-active');
      } else {
        arrow.textContent = '';
        th.classList.remove('sort-active');
      }
    });
  }

  document.querySelectorAll('#audit-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (auditSort.col === col) {
        auditSort.desc = !auditSort.desc;
      } else {
        auditSort.col = col;
        auditSort.desc = col === 'timestamp'; // default desc for time, asc for text cols
      }
      refreshAuditLog(true);
    });
  });

  $('audit-apply').addEventListener('click', () => refreshAuditLog(true));
  $('audit-reset').addEventListener('click', () => {
    $('audit-level').value = '';
    $('audit-action').value = '';
    $('audit-search').value = '';
    $('audit-since').value = '';
    $('audit-until').value = '';
    auditSort = { col: 'timestamp', desc: true };
    refreshAuditLog(true);
  });
  $('audit-load-more').addEventListener('click', () => refreshAuditLog(false));
  $('audit-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') refreshAuditLog(true);
  });

  // ----- system log -----
  //
  // Deliberately mirrors the audit-log module (state variables, filter
  // shape, sort/pagination flow, timezone handling) so future edits can
  // touch both consistently. The two logs are conceptually similar —
  // filtered, paginated, timestamped tables — but backed by different
  // tables and different permission gates, so we don't factor them into
  // one component; the duplication is intentional and small.
  let syslogEntries = [];
  let syslogTotal = 0;
  let syslogOffset = 0;
  const syslogPageSize = 100;
  let syslogSort = { col: 'timestamp', desc: true };
  let syslogSources = [];

  const SYSLOG_TZ_KEY = 'systemLogTimezone';
  function getSysLogTZ() { return localStorage.getItem(SYSLOG_TZ_KEY) || getAuditTZ(); }
  function setSysLogTZ(tz) { localStorage.setItem(SYSLOG_TZ_KEY, tz); }

  function formatSysLogTimestamp(isoStr) {
    const tz = getSysLogTZ();
    const d = new Date(isoStr);
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(d);
      const get = name => parts.find(p => p.type === name)?.value || '00';
      return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
    } catch {
      return d.toISOString().substring(0, 19).replace('T', ' ');
    }
  }

  function syslogLocalToUTC(str) {
    if (!str) return null;
    const tz = getSysLogTZ();
    const rough = new Date(str + ':00Z');
    if (tz === 'UTC') return rough.toISOString();
    try {
      const offset = tzOffsetMs(tz, rough);
      return new Date(rough.getTime() + offset).toISOString();
    } catch {
      return rough.toISOString();
    }
  }

  function updateSysLogTZHeader() {
    const tz = getSysLogTZ();
    const h = $('syslog-ts-header');
    if (h) h.textContent = tz === 'UTC' ? t('audit.colTime') : t('audit.colTimeTZ', { tz });
  }

  function initSysLogTZSelect() {
    const sel = $('syslog-tz');
    if (!sel) return;
    const saved = getSysLogTZ();
    let zones = ['UTC'];
    try { zones = ['UTC', ...Intl.supportedValuesOf('timeZone').filter(z => z !== 'UTC')]; } catch {}
    for (const z of zones) {
      const o = document.createElement('option');
      o.value = z; o.textContent = z;
      if (z === saved) o.selected = true;
      sel.appendChild(o);
    }
    if (!zones.includes(saved)) {
      const o = document.createElement('option');
      o.value = saved; o.textContent = saved; o.selected = true;
      sel.insertBefore(o, sel.firstChild);
    }
    sel.addEventListener('change', () => {
      setSysLogTZ(sel.value);
      updateSysLogTZHeader();
      renderSystemLog();
    });
    updateSysLogTZHeader();
  }
  initSysLogTZSelect();

  function syslogFilterParams(offset) {
    const params = new URLSearchParams();
    const level = $('syslog-level').value;
    const source = $('syslog-source').value;
    const search = $('syslog-search').value.trim();
    const sinceUTC = syslogLocalToUTC($('syslog-since').value);
    const untilUTC = syslogLocalToUTC($('syslog-until').value);
    if (level) params.set('level', level);
    if (source) params.set('source', source);
    if (search) params.set('search', search);
    if (sinceUTC) params.set('since', sinceUTC);
    if (untilUTC) params.set('until', untilUTC);
    params.set('sort', syslogSort.col);
    params.set('dir', syslogSort.desc ? 'desc' : 'asc');
    params.set('limit', String(syslogPageSize));
    params.set('offset', String(offset));
    return params;
  }

  async function refreshSystemLog(reset) {
    if (!hasPerm('system.log')) return;
    if (reset) { syslogEntries = []; syslogOffset = 0; }
    const res = await api('/api/system-log?' + syslogFilterParams(syslogOffset));
    if (!res.ok) return;
    const j = await res.json();
    syslogTotal = j.total || 0;
    if (reset) syslogEntries = j.entries || [];
    else syslogEntries = syslogEntries.concat(j.entries || []);
    syslogOffset = syslogEntries.length;
    // Refresh the source dropdown every load so newly-seen sources
    // appear without a page reload.
    const incomingSources = j.sources || [];
    const same = incomingSources.length === syslogSources.length &&
                 incomingSources.every((v, i) => v === syslogSources[i]);
    if (!same) {
      syslogSources = incomingSources;
      const sel = $('syslog-source');
      const current = sel.value;
      // Keep the "All sources" placeholder (first option) intact.
      while (sel.options.length > 1) sel.remove(1);
      for (const src of syslogSources) {
        const o = document.createElement('option');
        o.value = src; o.textContent = src;
        sel.appendChild(o);
      }
      if (current && syslogSources.includes(current)) sel.value = current;
    }
    renderSystemLog();
  }

  function renderSystemLog() {
    const tbody = $('syslog-tbody');
    tbody.innerHTML = '';
    for (const e of syslogEntries) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${escHtml(formatSysLogTimestamp(e.timestamp))}</td>
        <td><span class="audit-level audit-level-${escHtml(e.level)}">${escHtml(e.level)}</span></td>
        <td class="mono small">${escHtml(e.source)}</td>
        <td class="small">${escHtml(e.message)}</td>
      `;
      tbody.appendChild(tr);
    }
    const shown = syslogEntries.length;
    $('syslog-status').textContent = t('audit.showing', { shown, total: syslogTotal });
    const moreBtn = $('syslog-load-more');
    if (shown < syslogTotal) {
      moreBtn.classList.remove('hidden');
      moreBtn.textContent = t('audit.loadMoreCount', { n: syslogTotal - shown });
    } else {
      moreBtn.classList.add('hidden');
    }
    updateSysLogSortArrows();
  }

  function updateSysLogSortArrows() {
    document.querySelectorAll('#syslog-table th.sortable').forEach(th => {
      const arrow = th.querySelector('.sort-arrow');
      if (th.dataset.col === syslogSort.col) {
        arrow.textContent = syslogSort.desc ? ' ▼' : ' ▲';
        th.classList.add('sort-active');
      } else {
        arrow.textContent = '';
        th.classList.remove('sort-active');
      }
    });
  }

  document.querySelectorAll('#syslog-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (syslogSort.col === col) {
        syslogSort.desc = !syslogSort.desc;
      } else {
        syslogSort.col = col;
        syslogSort.desc = col === 'timestamp';
      }
      refreshSystemLog(true);
    });
  });

  $('syslog-apply')?.addEventListener('click', () => refreshSystemLog(true));
  $('syslog-reset')?.addEventListener('click', () => {
    $('syslog-level').value = '';
    $('syslog-source').value = '';
    $('syslog-search').value = '';
    $('syslog-since').value = '';
    $('syslog-until').value = '';
    syslogSort = { col: 'timestamp', desc: true };
    refreshSystemLog(true);
  });
  $('syslog-load-more')?.addEventListener('click', () => refreshSystemLog(false));
  $('syslog-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') refreshSystemLog(true);
  });

  // ----- feature requests -----
  let featureRequests = [];
  let myFeatureRequests = [];
  // sort state per table: { key: string|null, dir: 'asc'|'desc'|null }
  // 3-state cycle on repeated clicks: asc → desc → unsorted
  const frSort = { key: null, dir: null };
  const myFrSort = { key: null, dir: null };

  function cmpVal(a, b) {
    const av = (a == null) ? '' : a;
    const bv = (b == null) ? '' : b;
    // ISO dates and strings both compare lex-correctly
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  }

  function applySort(list, state) {
    if (!state.key || !state.dir) return list;
    const sign = state.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => sign * cmpVal(a[state.key], b[state.key]));
  }

  function paintSortArrows(tableId, state) {
    const table = $(tableId);
    if (!table) return;
    table.querySelectorAll('thead th.sortable').forEach(th => {
      let arrow = th.querySelector('.sort-arrow');
      if (!arrow) {
        arrow = document.createElement('span');
        arrow.className = 'sort-arrow';
        arrow.style.marginLeft = '4px';
        th.appendChild(arrow);
      }
      if (th.dataset.sortKey === state.key && state.dir) {
        arrow.textContent = state.dir === 'asc' ? '▲' : '▼';
        th.classList.add('sort-active');
      } else {
        arrow.textContent = '';
        th.classList.remove('sort-active');
      }
    });
  }

  function wireSortableTable(tableId, state, onChange) {
    const table = $(tableId);
    if (!table) return;
    table.querySelectorAll('thead th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sortKey;
        if (state.key !== key) {
          state.key = key;
          state.dir = 'asc';
        } else if (state.dir === 'asc') {
          state.dir = 'desc';
        } else {
          state.key = null;
          state.dir = null;
        }
        onChange();
      });
    });
  }

  $('feature-request-btn').addEventListener('click', () => featureRequestSubmitModal());
  $('my-fr-submit-btn').addEventListener('click', () => {
    featureRequestSubmitModal(() => refreshMyFeatureRequests());
  });
  wireSortableTable('fr-table', frSort, () => renderFeatureRequests());
  wireSortableTable('my-fr-table', myFrSort, () => renderMyFeatureRequests());

  function featureRequestSubmitModal(afterSubmit) {
    // Files chosen so far, kept in JS state instead of relying on the
    // <input type="file">'s FileList. The native picker replaces its
    // FileList on every open, so without our own state a user who picks
    // a second batch loses the first batch. We use "Add files…" as the
    // affordance and rebuild the visible list from staged[] on every
    // change, with per-file remove buttons.
    const staged = [];
    showModal(`
      <h3>${escHtml(t('topbar.featureRequest'))}</h3>
      <form>
        <label>${escHtml(t('featureRequests.colFrom'))}</label>
        <input name="from" value="${escHtml(me?.username || '')}" readonly style="opacity:0.6;cursor:not-allowed" />
        <label>${escHtml(t('featureRequests.colRequest'))}</label>
        <textarea name="text" rows="5" required style="width:100%;resize:vertical;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:inherit;font:inherit"></textarea>
        <label>${escHtml(t('featureRequests.attachmentLabel'))}</label>
        <input type="file" name="attachment" multiple accept=".pdf,.txt,.jpg,.jpeg,.png,application/pdf,text/plain,image/jpeg,image/png" style="display:none" />
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px">
          <button type="button" class="ghost fr-add-files-btn">${escHtml(t('featureRequests.attachmentAddFiles'))}</button>
          <span class="muted small fr-staged-count"></span>
        </div>
        <div class="fr-staged-list" style="display:flex;flex-direction:column;gap:3px;margin-top:6px"></div>
        <div class="muted small" style="margin-top:4px">${escHtml(t('featureRequests.attachmentHint'))}</div>
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.cancel'))}</button>
          <button type="submit" class="primary">${escHtml(t('chat.send'))}</button>
        </div>
      </form>
    `, async (form) => {
      const text = form.text.value.trim();
      if (!text) throw new Error(t('featureRequests.pleaseEnter'));
      // Client-side gate mirrors the server: per-file size and extension
      // whitelist, plus a max count so a slip of the Shift-click doesn't
      // upload someone's entire folder. All duplicates and validation
      // happen in acceptFiles() as files are added, so the submit path
      // just needs to check we're not empty on either side.
      if (staged.length > 10) throw new Error(t('featureRequests.attachmentTooMany'));
      const fd = new FormData();
      fd.append('text', text);
      for (const file of staged) fd.append('attachment', file);
      // Skip the api() JSON helper so we don't force a JSON Content-Type on
      // this multipart body; forward the CSRF token by hand instead.
      const res = await fetch('/api/feature-requests', {
        method: 'POST',
        credentials: 'same-origin',
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
        body: fd,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('featureRequests.submitFail'));
      }
      if (typeof afterSubmit === 'function') afterSubmit();
    });

    const card = $('modal-card');
    const fileInput = card.querySelector('input[name="attachment"]');
    const addBtn = card.querySelector('.fr-add-files-btn');
    const listEl = card.querySelector('.fr-staged-list');
    const countEl = card.querySelector('.fr-staged-count');
    const errEl = card.querySelector('.modal-err');

    function renderStaged() {
      listEl.innerHTML = '';
      staged.forEach((file, i) => {
        const type = featureRequestAttachmentType(file.type);
        const kb = file.size ? Math.max(1, Math.round(file.size / 1024)) : 0;
        const bits = [];
        if (type.label) bits.push(type.label);
        if (kb) bits.push(kb + ' kB');
        const suffix = bits.length ? ' (' + bits.join(' · ') + ')' : '';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px';
        row.innerHTML =
          `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(file.name)}<span class="muted small">${escHtml(suffix)}</span></span>` +
          `<button type="button" class="ghost fr-staged-remove" data-i="${i}" title="${escHtml(t('common.remove'))}" style="padding:0 8px;font-size:14px;line-height:1">×</button>`;
        listEl.appendChild(row);
      });
      countEl.textContent = staged.length
        ? t('featureRequests.attachmentSelectedCount', { n: staged.length })
        : '';
    }

    function acceptFiles(fileList) {
      errEl.textContent = '';
      for (const file of fileList) {
        const nameLc = (file.name || '').toLowerCase();
        const okType = nameLc.endsWith('.pdf') || nameLc.endsWith('.txt')
          || nameLc.endsWith('.jpg') || nameLc.endsWith('.jpeg') || nameLc.endsWith('.png');
        if (!okType) { errEl.textContent = t('featureRequests.attachmentBadType'); continue; }
        if (file.size > 5 * 1024 * 1024) { errEl.textContent = t('featureRequests.attachmentTooLarge'); continue; }
        // Skip exact-duplicate re-picks (same name + size) so a user who
        // reopens the picker and re-selects the same file doesn't end up
        // uploading it twice.
        const dup = staged.some(s => s.name === file.name && s.size === file.size);
        if (dup) continue;
        if (staged.length >= 10) { errEl.textContent = t('featureRequests.attachmentTooMany'); break; }
        staged.push(file);
      }
      renderStaged();
    }

    addBtn.addEventListener('click', () => {
      // Reset the input's FileList so re-picking the same file after a
      // remove still triggers a fresh change event.
      fileInput.value = '';
      fileInput.click();
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length) acceptFiles(Array.from(fileInput.files));
    });
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.fr-staged-remove');
      if (!btn) return;
      const i = Number(btn.dataset.i);
      if (Number.isFinite(i) && i >= 0 && i < staged.length) {
        staged.splice(i, 1);
        renderStaged();
      }
    });
  }

  // Map a MIME type to (a) a short type badge like "PNG" and (b) the file
  // extension we'd expect for that type. Used to render a type label next
  // to every attachment and to synthesize a reasonable filename for legacy
  // rows uploaded before v0.79 (when we started capturing the original
  // filename). Falls back to the subtype in uppercase for anything we
  // don't recognize.
  function featureRequestAttachmentType(mime) {
    const m = String(mime || '').toLowerCase();
    if (m === 'image/png') return { label: 'PNG', ext: '.png' };
    if (m === 'image/jpeg') return { label: 'JPG', ext: '.jpg' };
    if (m === 'application/pdf') return { label: 'PDF', ext: '.pdf' };
    if (m.indexOf('text/plain') === 0) return { label: 'TXT', ext: '.txt' };
    const sub = m.split('/').pop() || '';
    return { label: sub.toUpperCase(), ext: sub ? '.' + sub : '' };
  }

  // Renders one line per attachment. Returns the inner HTML for a single
  // <td>. Empty attachments array (or no download permission) collapses
  // to the em-dash placeholder.
  function featureRequestAttachmentCell(fr) {
    if (!fr || !Array.isArray(fr.attachments) || fr.attachments.length === 0) {
      return `<td class="muted small">${escHtml(t('featureRequests.attachmentNone'))}</td>`;
    }
    // Server enforces "admin OR submitter"; client mirrors the check so
    // a non-admin looking at someone else's row in public mode doesn't
    // get a link that 403s when clicked.
    const canDownload = (me && fr.from === me.username) || hasPerm('feature_requests.read');
    if (!canDownload) {
      return `<td class="muted small">${escHtml(t('featureRequests.attachmentNone'))}</td>`;
    }
    const rows = fr.attachments.map(att => renderFeatureRequestAttachmentRow(fr, att)).join('');
    return `<td><div style="display:flex;flex-direction:column;gap:3px">${rows}</div></td>`;
  }

  // Render one line inside the attachment cell. Image attachments get a
  // click-to-preview link + a small ↓ download affordance; other types
  // (PDF/TXT) render as a plain "open inline in a new tab" link.
  function renderFeatureRequestAttachmentRow(fr, att) {
    const type = featureRequestAttachmentType(att.mime);
    const name = att.original_name || ('attachment' + type.ext);
    const kb = att.size ? Math.max(1, Math.round(att.size / 1024)) : 0;
    const infoBits = [];
    if (type.label) infoBits.push(type.label);
    if (kb) infoBits.push(kb + ' kB');
    const infoSuffix = infoBits.length ? ' (' + infoBits.join(' · ') + ')' : '';
    const href = '/api/feature-requests/' + Number(fr.id) + '/attachments/' + Number(att.id);
    const dlAttr = ` download="${escHtml(name)}"`;
    const isImage = typeof att.mime === 'string' && att.mime.indexOf('image/') === 0;
    if (isImage) {
      const previewTitle = escHtml(t('featureRequests.attachmentPreview'));
      const dlTitle = escHtml(t('featureRequests.attachmentDownload'));
      return `<div>` +
        `<a href="${escHtml(href)}" class="fr-img-preview-btn" data-fr-id="${Number(fr.id)}" data-att-id="${Number(att.id)}" title="${previewTitle}">${escHtml(name)}</a>` +
        `<span class="muted small">${escHtml(infoSuffix)}</span> ` +
        `<a class="fr-attach-download" href="${escHtml(href)}"${dlAttr} title="${dlTitle}" aria-label="${dlTitle}" style="margin-left:6px">↓</a>` +
        `</div>`;
    }
    // Non-image attachments (PDF/TXT) keep the "open inline in a new tab"
    // behaviour — most browsers can display them and users can Ctrl+S to
    // save. No download attribute here so we don't force a save-as dialog.
    return `<div><a href="${escHtml(href)}" target="_blank" rel="noopener">${escHtml(name + infoSuffix)}</a></div>`;
  }

  function openFeatureRequestImagePreview(fr, att) {
    if (!fr || !att) return;
    const href = '/api/feature-requests/' + Number(fr.id) + '/attachments/' + Number(att.id);
    const type = featureRequestAttachmentType(att.mime);
    const name = att.original_name || ('attachment' + type.ext);
    const kb = att.size ? Math.max(1, Math.round(att.size / 1024)) : 0;
    const infoBits = [];
    if (type.label) infoBits.push(type.label);
    if (kb) infoBits.push(kb + ' kB');
    const infoSuffix = infoBits.length ? ' (' + infoBits.join(' · ') + ')' : '';
    const dlAttr = ` download="${escHtml(name)}"`;
    showModal(`
      <h3>${escHtml(name)}<span class="muted small" style="font-weight:normal">${escHtml(infoSuffix)}</span></h3>
      <div style="text-align:center;margin:12px 0">
        <img src="${escHtml(href)}" alt="${escHtml(name)}" style="max-width:100%;max-height:70vh;border:1px solid var(--border);border-radius:6px;background:var(--bg-elev-2)" />
      </div>
      <div class="modal-actions">
        <a class="as-button" href="${escHtml(href)}"${dlAttr} style="text-decoration:none">${escHtml(t('featureRequests.attachmentDownload'))}</a>
        <button type="button" class="ghost cancel-btn">${escHtml(t('common.close'))}</button>
      </div>
    `, null, { wide: true });
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.fr-img-preview-btn');
    if (!btn) return;
    // Let modifier-clicks (Ctrl/Cmd/Shift/middle) fall through so the
    // browser can open the raw image in a new tab — same escape hatch as
    // any other in-app link.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const frId = Number(btn.dataset.frId);
    const attId = Number(btn.dataset.attId);
    const fr = featureRequests.find(f => Number(f.id) === frId)
      || myFeatureRequests.find(f => Number(f.id) === frId);
    if (!fr || !Array.isArray(fr.attachments)) return;
    const att = fr.attachments.find(a => Number(a.id) === attId);
    if (att) openFeatureRequestImagePreview(fr, att);
  });

  async function refreshFeatureRequests() {
    if (!hasPerm('feature_requests.read')) return;
    const res = await api('/api/feature-requests');
    if (!res.ok) return;
    featureRequests = await res.json();
    renderFeatureRequests();
  }

  function renderFeatureRequests() {
    const tbody = $('fr-tbody');
    tbody.innerHTML = '';
    $('fr-select-all').checked = false;
    paintSortArrows('fr-table', frSort);
    const rows = applySort(featureRequests, frSort);
    for (const fr of rows) {
      const tr = document.createElement('tr');
      const date = fr.created_at ? new Date(fr.created_at).toLocaleString(localeForFmt()) : '';
      const statusClass = { pending: 'open', accepted: 'admin', declined: 'disabled', implemented: 'finished' }[fr.status] || '';
      const statusLabel = t('featureRequests.status_' + fr.status) || fr.status;
      tr.innerHTML = `
        <td><input type="checkbox" class="fr-check" data-id="${Number(fr.id)}" /></td>
        <td>${escHtml(fr.from)}</td>
        <td class="muted small">${escHtml(date)}</td>
        <td><span class="badge ${statusClass}">${escHtml(statusLabel)}</span></td>
        <td style="white-space:pre-wrap;max-width:360px">${escHtml(fr.text)}</td>
        ${featureRequestAttachmentCell(fr)}
        <td style="min-width:160px">
          <textarea class="fr-comment-input" data-id="${Number(fr.id)}" rows="2" style="width:100%;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:4px;padding:4px 6px;color:inherit;font:inherit;font-size:12px;resize:vertical">${escHtml(fr.admin_comment || '')}</textarea>
          <button class="ghost fr-comment-save-btn" data-id="${Number(fr.id)}" style="font-size:11px;padding:2px 8px;margin-top:3px">${escHtml(t('featureRequests.saveComment'))}</button>
        </td>
        <td class="actions" style="white-space:nowrap">
          <select class="fr-status-sel ghost" data-id="${Number(fr.id)}" style="font-size:12px;padding:2px 6px;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:4px;color:inherit">
            <option value="pending" ${fr.status==='pending'?'selected':''}>${escHtml(t('featureRequests.status_pending'))}</option>
            <option value="accepted" ${fr.status==='accepted'?'selected':''}>${escHtml(t('featureRequests.status_accepted'))}</option>
            <option value="declined" ${fr.status==='declined'?'selected':''}>${escHtml(t('featureRequests.status_declined'))}</option>
            <option value="implemented" ${fr.status==='implemented'?'selected':''}>${escHtml(t('featureRequests.status_implemented'))}</option>
          </select>
          <button class="ghost fr-del-btn" data-id="${Number(fr.id)}">${escHtml(t('common.delete'))}</button>
        </td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.fr-status-sel').forEach(sel => {
      sel.addEventListener('change', async () => {
        const id = Number(sel.dataset.id);
        const res = await api('/api/feature-requests/' + id, {
          method: 'PUT',
          body: JSON.stringify({ status: sel.value }),
        });
        if (res.ok) refreshFeatureRequests();
      });
    });
    tbody.querySelectorAll('.fr-comment-save-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        const textarea = tbody.querySelector(`.fr-comment-input[data-id="${id}"]`);
        const comment = textarea ? textarea.value : '';
        const res = await api('/api/feature-requests/' + id, {
          method: 'PUT',
          body: JSON.stringify({ admin_comment: comment }),
        });
        if (res.ok) {
          btn.textContent = t('featureRequests.commentSaved');
          setTimeout(() => { btn.textContent = t('featureRequests.saveComment'); }, 1500);
        }
      });
    });
    tbody.querySelectorAll('.fr-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await showConfirm(t('featureRequests.deleteConfirm'), { ok: t('common.delete') })) return;
        const id = Number(btn.dataset.id);
        const res = await api('/api/feature-requests/' + id, { method: 'DELETE' });
        if (res.ok) refreshFeatureRequests();
      });
    });
    const n = featureRequests.length;
    $('fr-count').textContent = n === 1 ? t('featureRequests.count', { n }) : t('featureRequests.countPlural', { n });
  }

  async function refreshMyFeatureRequests() {
    await loadSettings();
    const res = await api('/api/feature-requests/mine');
    if (!res.ok) return;
    myFeatureRequests = await res.json();
    renderMyFeatureRequests();
  }

  function renderMyFeatureRequests() {
    const tbody = $('my-fr-tbody');
    tbody.innerHTML = '';
    const isPublic = !!(settings && settings.public_feature_requests);
    const thFrom = $('my-fr-th-from');
    if (thFrom) thFrom.classList.toggle('hidden', !isPublic);
    const titleEl = $('my-fr-title');
    if (titleEl) titleEl.textContent = isPublic
      ? t('featureRequests.publicTitle')
      : t('featureRequests.myTitle');
    // If the "From" column is hidden, clear a stale sort on it
    if (!isPublic && myFrSort.key === 'from') { myFrSort.key = null; myFrSort.dir = null; }
    paintSortArrows('my-fr-table', myFrSort);
    // Columns: Date, [From], Status, Request, Attachment, Admin comment.
    const colspan = isPublic ? 6 : 5;
    const emptyMsg = isPublic
      ? t('featureRequests.noPublicRequests')
      : t('featureRequests.noMyRequests');
    if (!myFeatureRequests.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="${colspan}" class="muted" style="text-align:center;padding:20px">${escHtml(emptyMsg)}</td>`;
      tbody.appendChild(tr);
      $('my-fr-count').textContent = '';
      return;
    }
    const rows = applySort(myFeatureRequests, myFrSort);
    for (const fr of rows) {
      const tr = document.createElement('tr');
      const date = fr.created_at ? new Date(fr.created_at).toLocaleString(localeForFmt()) : '';
      const statusClass = { pending: 'open', accepted: 'admin', declined: 'disabled', implemented: 'finished' }[fr.status] || '';
      const statusLabel = t('featureRequests.status_' + fr.status) || fr.status;
      const fromCell = isPublic ? `<td>${escHtml(fr.from || '')}</td>` : '';
      tr.innerHTML = `
        <td class="muted small">${escHtml(date)}</td>
        ${fromCell}
        <td><span class="badge ${statusClass}">${escHtml(statusLabel)}</span></td>
        <td style="white-space:pre-wrap;max-width:480px">${escHtml(fr.text)}</td>
        ${featureRequestAttachmentCell(fr)}
        <td style="max-width:300px;white-space:pre-wrap;color:var(--accent)">${fr.admin_comment ? escHtml(fr.admin_comment) : '<span class="muted">—</span>'}</td>
      `;
      tbody.appendChild(tr);
    }
    const n = myFeatureRequests.length;
    $('my-fr-count').textContent = n === 1 ? t('featureRequests.count', { n }) : t('featureRequests.countPlural', { n });
  }

  $('fr-select-all').addEventListener('change', (e) => {
    document.querySelectorAll('.fr-check').forEach(cb => { cb.checked = e.target.checked; });
  });

  $('fr-export-btn').addEventListener('click', () => {
    const selected = Array.from(document.querySelectorAll('.fr-check:checked')).map(cb => Number(cb.dataset.id));
    const items = featureRequests.filter(fr => selected.includes(Number(fr.id)));
    if (!items.length) { alert(t('featureRequests.selectExport')); return; }
    const body = t('featureRequests.exportHeader') + '\n\n' +
      items.map(fr => fr.text).join('\n----------\n');
    const blob = new Blob([body], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'feature-requests.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('fr-delete-selected-btn').addEventListener('click', async () => {
    const selected = Array.from(document.querySelectorAll('.fr-check:checked')).map(cb => Number(cb.dataset.id));
    if (!selected.length) { alert(t('featureRequests.selectDelete')); return; }
    if (!await showConfirm(t('featureRequests.deleteManyConfirm', { n: selected.length }), { ok: t('common.delete') })) return;
    await Promise.all(selected.map(id => api('/api/feature-requests/' + id, { method: 'DELETE' })));
    refreshFeatureRequests();
  });

  // ----- DOK Cache screen -----
  let dokEntries = [];

  async function loadDOKCache() {
    const res = await api('/api/dok-cache');
    if (!res.ok) return;
    dokEntries = await res.json();
    renderDOKCache();
  }

  function renderDOKCache() {
    const query = ($('dok-search')?.value || '').trim().toLowerCase();
    const tbody = $('dok-cache-tbody');
    if (!tbody) return;
    const filtered = query
      ? dokEntries.filter(e => e.callsign.toLowerCase().includes(query) || e.dok.toLowerCase().includes(query))
      : dokEntries;
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:20px">${escHtml(t('dok.noEntries'))}</td></tr>`;
      return;
    }
    tbody.innerHTML = filtered.map(e => `
      <tr data-callsign="${escHtml(e.callsign)}">
        <td class="dok-col-call">${escHtml(fmtCall(e.callsign))}</td>
        <td class="dok-col-dok">${escHtml(e.dok)}</td>
        <td class="dok-col-updated muted small">${escHtml(e.updated_at ? e.updated_at.replace('T', ' ').replace('Z', ' UTC').substring(0, 20) : '')}</td>
        <td class="dok-col-action"><button class="ghost small dok-delete-btn" data-callsign="${escHtml(e.callsign)}" data-i18n="common.delete">${escHtml(t('common.delete'))}</button></td>
      </tr>
    `).join('');
    tbody.querySelectorAll('.dok-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const call = btn.dataset.callsign;
        if (!await showConfirm(t('dok.deleteConfirm', { call: fmtCall(call) }), { ok: t('common.delete') })) return;
        const res = await api('/api/dok-cache/' + encodeURIComponent(call), { method: 'DELETE' });
        if (res.ok || res.status === 204) {
          dokEntries = dokEntries.filter(e => e.callsign !== call);
          renderDOKCache();
        }
      });
    });
  }

  $('dok-search')?.addEventListener('input', renderDOKCache);

  $('dok-add-btn')?.addEventListener('click', async () => {
    const callsign = ($('dok-add-callsign').value || '').trim().toUpperCase();
    const dok = ($('dok-add-dok').value || '').trim().toUpperCase();
    if (!callsign || !dok) return;
    const statusEl = $('dok-status');
    const res = await api('/api/dok-cache', { method: 'POST', body: JSON.stringify({ callsign, dok }) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (statusEl) statusEl.textContent = j.error || t('common.saveFailed');
      return;
    }
    $('dok-add-callsign').value = '';
    $('dok-add-dok').value = '';
    if (statusEl) statusEl.textContent = t('common.saved');
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
    await loadDOKCache();
  });

  $('dok-add-callsign')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('dok-add-dok').focus(); });
  $('dok-add-dok')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('dok-add-btn').click(); });

  $('dok-export-btn')?.addEventListener('click', () => {
    window.location.href = '/api/dok-cache/export';
  });

  $('dok-import-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const statusEl = $('dok-status');
    const res = await api('/api/dok-cache/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: text,
    });
    e.target.value = '';
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (statusEl) statusEl.textContent = j.error || t('common.uploadFailed');
      return;
    }
    const j = await res.json();
    if (statusEl) statusEl.textContent = t('dok.importedN', { n: j.imported });
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
    await loadDOKCache();
  });

  // ----- Changelog -----
  const CHANGELOG = [
    {
      version: '0.85',
      date: '2026-09-04',
      en: 'v0.85: Single sign-on, your own contest templates, and full ADIF field support.\n- Sign in with SSO — a new OIDC login button next to password, passkey and device pairing; admins set it up in Global Settings\n- Build, edit and share your own contest templates right in the UI — the fixed preset list is gone\n- Every field in the ADIF specification can now be added to a contest, with its label and permitted values filled in for you\n- New “ADIF export mapping” section shows which ADIF tag each field exports as — and lets you change it or switch it off\n- ADIF exports fixed: newer spec fields, dates and times, and umlauts now land on the right tags instead of being hidden away\n- OmniRig support in both helpers on Windows — no Hamlib rigctld needed if you already run OmniRig\n- Statistics gained a “QSOs per operator” card, and every bar chart now shows percentages next to the counts',
      de: 'v0.85: Single Sign-on, eigene Contest-Vorlagen und volle ADIF-Feldunterstützung.\n- Anmeldung per SSO — neuer OIDC-Login neben Passwort, Passkey und Geräte-Kopplung; Admins richten ihn in den globalen Einstellungen ein\n- Eigene Contest-Vorlagen direkt in der Oberfläche bauen, bearbeiten und teilen — die feste Preset-Liste ist weg\n- Jedes Feld der ADIF-Spezifikation lässt sich jetzt einem Contest hinzufügen — Beschriftung und erlaubte Werte werden für dich ausgefüllt\n- Neuer Bereich „ADIF-Export-Zuordnung“ zeigt, als welches ADIF-Tag jedes Feld exportiert wird — du kannst es ändern oder abschalten\n- ADIF-Export korrigiert: neuere Spezifikationsfelder, Datums- und Zeitwerte sowie Umlaute landen jetzt auf den richtigen Tags\n- OmniRig-Unterstützung in beiden Helpern unter Windows — kein Hamlib-rigctld nötig, wenn du schon OmniRig nutzt\n- Die Statistik hat eine neue Karte „QSOs pro Operator“, und alle Balkendiagramme zeigen jetzt Prozentwerte neben den Zahlen',
    },
    {
      version: '0.84',
      date: '2026-08-15',
      en: 'v0.84: New "Noctalum Desktop" download, persistent System Log, and an important deadlock fix.\n- New Noctalum Desktop download — a native app that keeps you signed in across restarts and pops each panel out into its own real window\n- New "System Log" screen for roles with the new system.log permission — every server warning and error kept for 365 days, filterable by level, source and time; server panics now leave a full stack trace\n- Fixed a rare deadlock that could freeze "click a contest" for everyone once two operators worked simultaneously\n- The System Log now also warns whenever any request stalls past 5 seconds, and live diagnostic endpoints let ops root-cause incidents without a restart\n- QSO map draws animated direction arrows flowing along the great-circle path from your QTH toward the target\n- Enter in safe confirmation dialogs (edit-QSO save, etc.) now confirms; Escape always cancels — destructive confirms still need a click\n- Contest serial numbers are allocated atomically per contest — no more duplicates even across concurrent operators or a rolling deploy\n- Cluster band/mode/spotter filters keep working after the Ops panel is popped out\n- Left-panel distance readout resets together with the bearing after each QSO',
      de: 'v0.84: Neuer „Noctalum Desktop"-Download, dauerhaftes „System Log" und ein wichtiger Deadlock-Fix.\n- Neuer Noctalum-Desktop-Download — eine native App, die dich zwischen Starts angemeldet hält und jedes Panel in ein eigenes echtes Fenster löst\n- Neue „System Log"-Ansicht für Rollen mit der neuen Berechtigung system.log — jede Server-Warnung und jeder Fehler bleiben 365 Tage sichtbar, filterbar nach Level, Quelle und Zeit; Server-Panics hinterlassen jetzt einen vollständigen Stack-Trace\n- Ein seltener Deadlock ist behoben, der bei parallelem Betrieb „Contest anklicken" für alle einfrieren konnte\n- Das System Log warnt jetzt zusätzlich, sobald ein Request länger als 5 Sekunden hängt, und Live-Diagnose-Endpunkte erlauben Ops die Ursachenklärung ohne Neustart\n- Auf der QSO-Karte fließen animierte Richtungspfeile entlang des Großkreises von deinem QTH zum Ziel\n- Enter bestätigt in sicheren Dialogen (QSO-Änderung speichern u. ä.) jetzt automatisch; Escape bricht immer ab — destruktive Bestätigungen brauchen weiterhin einen Klick\n- Contest-Laufnummern werden pro Contest atomar vergeben — keine Doppelvergabe mehr, selbst bei mehreren gleichzeitig arbeitenden Operatoren oder einem Rolling Deploy\n- Cluster-Filter für Band, Mode und Spotter funktionieren nach dem Auskoppeln des Ops-Panels weiter\n- Die Distanzanzeige im linken Panel wird zusammen mit der Peilung nach jedem QSO zurückgesetzt',
    },
    {
      version: '0.83',
      date: '2026-07-31',
      en: 'v0.83: Rearrange the log tab freely, plus a wsjtx-gui startup crash fix.\n- New "Re-Arrange" button in the topbar (tile icon) opens a drag-and-drop panel-layout editor\n- Swap any of the four panels (New QSO, QSO history, Pic & Map, Ops) between the four layout slots\n- Push individual panels into their own browser tabs — the tab opens immediately, even before you drop a panel into it\n- The Rearrange arrangement persists across page reloads; browser tabs don\'t (browsers need a fresh user gesture to reopen)\n- Closing a browser tab returns its panel to the main window automatically — no more "lost panel" forcing a reset\n- wsjtx-gui: the desktop bridge now actually starts instead of panicking on the auth-mode radio group before its window paints',
      de: 'v0.83: Log-Tab frei umbauen, plus ein wsjtx-gui-Startup-Fix.\n- Neuer „Re-Arrange"-Button in der obersten Leiste (Kachel-Icon) öffnet einen Drag-and-Drop-Editor für das Panel-Layout\n- Beliebige der vier Panels (Neues QSO, QSO-Verlauf, Bild & Karte, Op-Panel) zwischen den vier Positionen tauschen\n- Einzelne Panels in eigene Browser-Tabs verschieben — der Tab öffnet sich sofort, sogar bevor du ein Panel hineinziehst\n- Die Anordnung bleibt beim Neuladen erhalten; Browser-Tabs nicht (Browser brauchen dafür eine neue Nutzergeste)\n- Schließt du einen Browser-Tab, kehrt das Panel automatisch ins Hauptfenster zurück — kein „verlorenes Panel" mehr, das einen Reset erzwingt\n- wsjtx-gui: die Desktop-Bridge startet jetzt wirklich, statt schon vor dem ersten Fensteraufbau am Auth-Modus-Radio zu panikieren',
    },
    {
      version: '0.82',
      date: '2026-07-31',
      en: 'v0.82: Undockable panels now offer a "new tab" option next to the "new window" option.\n- New QSO and QSO history each have two pop-out buttons in their header\n- One opens the panel in its own browser window (drag it to a second monitor)\n- The other opens the panel in a new tab of the current browser window\n- While the panel is detached, only the redock button stays visible\n- Hitting the back button, F5, or navigating away in the popped-out window automatically redocks the panel',
      de: 'v0.82: Abkoppelbare Panels haben jetzt zusätzlich zur „neues Fenster"-Option auch einen „neuer Tab"-Button.\n- Neues QSO und QSO-Verlauf haben je zwei Abkoppel-Buttons in ihrer Kopfzeile\n- Einer öffnet das Panel in einem eigenen Browserfenster (auf einen zweiten Monitor ziehen)\n- Der andere öffnet das Panel in einem neuen Tab des aktuellen Browserfensters\n- Solange das Panel abgekoppelt ist, bleibt nur der Andocken-Button sichtbar\n- Zurück-Taste, F5 oder Wegnavigieren im abgekoppelten Fenster dockt das Panel automatisch wieder an',
    },
    {
      version: '0.81',
      date: '2026-07-31',
      en: 'v0.81: Undockable New QSO and QSO history panels for multi-monitor logging, plus a smoother feature-request attachment picker.\n- New QSO mask and QSO history each have a small pop-out button in their header\n- Undocked panels open in a separate browser window you can drag onto a second monitor\n- Close the window or press "Move back here" on the placeholder card to redock\n- The remaining docked panel grows to fill the freed space in the middle column\n- The placeholder in the main window names the missing panel (e.g. "New QSO is open in a separate window.")\n- Feature-request attachments: pick files across multiple picker rounds without losing earlier selections\n- Remove individual staged files with an "×" button before sending\n- Duplicates in the picker are skipped silently; invalid files surface inline instead of at submit',
      de: 'v0.81: Abkoppelbare Panels „Neues QSO" und „QSO-Verlauf" fürs Loggen mit mehreren Monitoren, plus ein komfortablerer Dateien-Picker bei Feature-Wünschen.\n- Neues QSO und QSO-Verlauf haben je einen kleinen Abkoppeln-Button in der Kopfzeile\n- Abgekoppelte Panels landen in einem eigenen Browserfenster, das du auf einen zweiten Monitor ziehen kannst\n- Fenster schließen oder auf der Platzhalter-Karte „Wieder hier anzeigen" klicken dockt das Panel zurück\n- Das verbleibende, angedockte Panel füllt den freigewordenen Platz in der Mittelspalte\n- Der Platzhalter im Hauptfenster nennt das fehlende Panel (z. B. „Neues QSO ist in einem separaten Fenster geöffnet.")\n- Feature-Wunsch-Anhänge: Dateien in mehreren Picker-Runden hinzufügen, ohne vorherige zu verlieren\n- Einzelne bereitgelegte Dateien vor dem Absenden per „×"-Button wieder entfernen\n- Duplikate im Picker werden still übergangen; ungültige Dateien zeigen sofort einen Fehler statt erst beim Absenden',
    },
    {
      version: '0.80',
      date: '2026-07-30',
      en: 'v0.80: Feature requests can now carry multiple attachments — each with its real filename.\n- Attach several files to a single feature request in one go (up to 10 files, 5 MB each)\n- Each attachment shows up on its own line with filename, type (PNG/JPG/PDF/TXT), and size\n- Click any image attachment to preview it in a modal without leaving the page\n- Saved files keep their original name whether you use the ↓ button, right-click Save As, or open the raw URL\n- Older single-attachment requests keep working — their file appears in the new list without loss',
      de: 'v0.80: Feature-Wünsche können jetzt mehrere Anhänge tragen — jeder mit seinem echten Dateinamen.\n- Häng mehrere Dateien in einem Rutsch an einen Feature-Wunsch (bis zu 10 Dateien, je 5 MB)\n- Jeder Anhang erscheint in einer eigenen Zeile mit Dateiname, Typ (PNG/JPG/PDF/TXT) und Größe\n- Klick einen Bild-Anhang an, um ihn direkt in einem Fenster zu betrachten, ohne die Seite zu verlassen\n- Gespeicherte Dateien behalten ihren Originalnamen — egal ob per ↓-Button, Rechtsklick „Speichern unter" oder direktem URL-Aufruf\n- Ältere Anfragen mit einzelnem Anhang funktionieren weiterhin — ihre Datei taucht ohne Verlust in der neuen Liste auf',
    },
    {
      version: '0.79',
      date: '2026-07-30',
      en: 'v0.79: Feature-request attachments now include screenshots — with names and in-app preview.\n- Upload JPG or PNG images to a feature request in addition to PDF and TXT\n- Attachments are labelled with the file you actually uploaded, not just "Download"\n- Click an image attachment to preview it in a modal without leaving the page\n- The download button saves the file under its original name\n- PDF and TXT attachments keep opening inline in a new tab as before\n- 5 MB size limit unchanged; older uploads still show as "Download" since their filename wasn\'t captured back then',
      de: 'v0.79: Feature-Wünsche können jetzt Screenshots enthalten — mit Namen und Vorschau in der App.\n- Lade JPG- oder PNG-Bilder an einen Feature-Wunsch an, zusätzlich zu PDF und TXT\n- Anhänge werden jetzt mit dem tatsächlichen Dateinamen angezeigt, nicht mehr nur „Download"\n- Klick einen Bild-Anhang an, um ihn direkt in einem Fenster zu betrachten, ohne die Seite zu verlassen\n- Der Download-Button speichert die Datei unter ihrem Originalnamen\n- PDF- und TXT-Anhänge werden wie bisher in einem neuen Tab geöffnet\n- 5-MB-Grenze bleibt; ältere Anhänge zeigen weiterhin „Download", weil damals kein Dateiname erfasst wurde',
    },
    {
      version: '0.78',
      date: '2026-07-28',
      en: 'v0.78: The contest selection screen is now smartphone-friendly.\n- On phones, the main menu now stacks vertically and uses the full screen width — no more horizontal overflow or cramped tap targets\n- The left navigation (My Requests, Users, Groups, Audit Log, …) becomes a 2-column grid of larger, thumb-friendly buttons\n- Download Helper stays prominent as a full-width action button at the top of the navigation\n- The contest list drops date and activity columns on mobile so name, call, and status all fit — tap a row to enter the contest\n- Filter pills (All / Active / Closed) and the Cards / List toggle get bigger tap targets\n- The "Online Now" panel moves to the bottom of the screen where it stays out of the way',
      de: 'v0.78: Die Contest-Auswahl ist jetzt auch auf dem Smartphone komfortabel bedienbar.\n- Auf dem Handy stapelt sich das Hauptmenü jetzt vertikal und nutzt die volle Bildschirmbreite — kein horizontaler Überlauf oder gequetschte Tap-Ziele mehr\n- Die linke Navigation (Meine Requests, Benutzer, Gruppen, Audit-Log, …) wird zu einem 2-Spalten-Raster größerer, daumenfreundlicher Buttons\n- „Download Helper" bleibt als voll­breiter Aktions-Button oben in der Navigation prominent sichtbar\n- Die Contest-Liste blendet auf dem Handy Datum und Aktivität aus, damit Name, Rufzeichen und Status vollständig passen — tippe eine Zeile an, um in den Contest zu wechseln\n- Filter-Pills (Alle / Aktiv / Geschlossen) und der Karten-/Listen-Umschalter haben jetzt größere Tap-Ziele\n- Das „Online jetzt"-Panel rutscht ans untere Ende des Bildschirms und stört so den Blick auf die Contests nicht mehr',
    },
    {
      version: '0.77',
      date: '2026-07-28',
      en: 'v0.77: The QSO history stays reachable even on short screens.\n- On short viewports, the middle column now scrolls as a whole — scroll down to reach the past-QSO list below the New QSO mask\n- Every field of the New QSO mask stays fully visible at all times — no more inputs hidden behind an internal scrollbar\n- The mid-panel drag handle is gone; the layout adapts to your window size automatically',
      de: 'v0.77: Die QSO-Historie bleibt auch auf kurzen Bildschirmen erreichbar.\n- Auf kurzen Bildschirmen scrollt jetzt die ganze mittlere Spalte — einfach nach unten scrollen, um die alten QSOs unter der Eingabemaske zu erreichen\n- Jedes Feld der QSO-Eingabemaske bleibt immer vollständig sichtbar — keine Eingabefelder mehr hinter einer internen Scrollleiste versteckt\n- Der Schieber zwischen Eingabe und Historie entfällt; das Layout passt sich automatisch an deine Fenstergröße an',
    },
    {
      version: '0.76',
      date: '2026-07-28',
      en: 'v0.76: Per-contest roles + groups, one-scan device login, and a single-file WSJT-X bridge.\n- New per-contest roles (owner / editor / logger): loggers can only edit or delete QSOs they logged themselves, editors can touch anything in the contest, owners run the show\n- Contest visibility now has three modes — open, groups, private — and a new Groups tab lets you assemble teams once and grant them access per contest\n- Sign in on a new device by scanning a QR code with any already-signed-in phone or laptop — no more typing a password in someone else\'s browser\n- WSJT-X Bridge redesigned as a single-file binary for Linux, macOS and Windows; the graphical version is on the downloads page for every OS\n- Bridge now caches QSOs on disk and retries in the background, so a server restart or WiFi hiccup no longer costs QSOs WSJT-X already reported\n- Every contest has a "📡" pill next to Share that opens a copy-pasteable token — one paste into the bridge, no username or password needed\n- Bridge rejects QSOs logged under the wrong station callsign so a leftover WSJT-X configuration can\'t quietly pollute the log',
      de: 'v0.76: Rollen pro Contest und Gruppen, Login per QR-Scan, plus eine schlanke Einzeldatei-WSJT-X-Bridge.\n- Neue Rollen pro Contest (Owner / Editor / Logger): Logger können nur eigene QSOs bearbeiten oder löschen, Editoren dürfen alles im Contest anfassen, Owner haben die volle Kontrolle\n- Contest-Sichtbarkeit hat jetzt drei Modi — offen, Gruppen, privat — und im neuen Tab „Gruppen" stellst du einmal ein Team zusammen und gibst es pro Contest frei\n- Auf einem neuen Gerät anmelden per QR-Scan mit einem bereits angemeldeten Handy oder Laptop — kein Passwort mehr im fremden Browser tippen\n- WSJT-X-Bridge komplett neu als Einzeldatei-Programm für Linux, macOS und Windows; die grafische Version steht jetzt für jedes Betriebssystem auf der Downloads-Seite\n- Die Bridge speichert QSOs zwischen und wiederholt den Sendevorgang im Hintergrund — ein Server-Neustart oder WLAN-Aussetzer kostet dich keine bereits gemeldeten QSOs mehr\n- Jeder Contest hat ein „📡"-Pill neben „Teilen", das einen kopierbaren Token anzeigt — einmal in die Bridge einfügen, kein Benutzername oder Passwort nötig\n- Die Bridge lehnt QSOs ab, die WSJT-X mit dem falschen Stationsrufzeichen protokolliert hat — eine vergessene Konfiguration verschmutzt das Log nicht mehr still und leise',
    },
    {
      version: '0.75',
      date: '2026-07-27',
      en: 'v0.75: Graphical WSJT-X bridge with optional credential caching, plus a mobile map-export fix.\n- New desktop WSJT-X bridge in the Noctalum look: log in, pick a contest, and QSOs flow straight into the log — no terminal, no CLI flags\n- Optional "Remember credentials on this device" so the bridge starts with one click next time; a Forget button wipes the saved copy\n- Live activity log shows each QSO as it lands, with duplicates and server errors flagged in colour\n- Cross-platform sources (Linux/macOS/Windows); the Linux AppImage is on the downloads page today, native macOS/Windows builds coming\n- Map export on smartphones (hi-DPI screens) now draws propagation lines exactly on top of the QSOs instead of shifted off the map',
      de: 'v0.75: Grafische WSJT-X-Bridge mit optionaler Zugangsdaten-Speicherung, plus ein Fix für den Karten-Export auf dem Handy.\n- Neue Desktop-WSJT-X-Bridge im Noctalum-Look: anmelden, Contest wählen, und die QSOs laufen direkt ins Log — kein Terminal, keine CLI-Flags\n- Optional „Zugangsdaten auf diesem Gerät merken", damit die Bridge beim nächsten Start mit einem Klick loslegt; ein Vergessen-Button löscht die gespeicherte Kopie\n- Live-Aktivitätsprotokoll zeigt jedes QSO sofort an; Dubletten und Server-Fehler werden farbig markiert\n- Plattformübergreifende Quellen (Linux/macOS/Windows); das Linux-AppImage steht heute auf der Downloads-Seite, native macOS/Windows-Builds folgen\n- Karten-Export auf dem Smartphone (hi-DPI-Bildschirmen) zeichnet die Ausbreitungslinien jetzt exakt über den QSOs — vorher waren sie oft neben die Karte verschoben',
    },
    {
      version: '0.74',
      date: '2026-07-26',
      en: 'v0.74: C++ helper alternatives, PDF/TXT attachments on feature requests, admin rename, and a real staging environment.\n- Native C++ AppImages of the helper, WSJT-X bridge and desktop GUI — no Go runtime or WebKit needed, single-file download that runs anywhere\n- Feature requests can now carry an optional PDF or plain-text file (up to 5 MB); shows up as a download link for admins and the submitter\n- Admins with users.manage can rename user accounts without deleting and recreating them\n- New staging environment at log-staging.dm2lap.com so risky changes get dogfooded against a copy of real data before touching prod\n- A full-width caution-tape STAGING banner across the top of every non-prod page — impossible to miss which instance you\'re on\n- Deploys support -nohelpers to skip the helper/GUI/wsjtx rebuild and upload for server-only iterations',
      de: 'v0.74: C++-Helper-Varianten, PDF/TXT-Anhänge für Feature-Wünsche, Admin-Umbenennung und eine echte Staging-Umgebung.\n- Native C++-AppImages für Helper, WSJT-X-Bridge und Desktop-GUI — kein Go-Runtime, kein WebKit nötig, einzelne Datei, läuft überall\n- Feature-Wünsche können jetzt optional eine PDF- oder Textdatei mitliefern (bis 5 MB); wird als Download-Link für Admins und die einreichende Person angezeigt\n- Admins mit users.manage können Benutzerkonten umbenennen, ohne sie zu löschen und neu anzulegen\n- Neue Staging-Umgebung unter log-staging.dm2lap.com, damit riskante Änderungen an einer Kopie echter Daten getestet werden können, bevor sie in die Produktion gehen\n- Ein bildschirmbreites Warnstreifen-STAGING-Banner am oberen Rand jeder Nicht-Prod-Seite — du siehst sofort, auf welcher Instanz du bist\n- Deploys unterstützen -nohelpers, um Helper/GUI/wsjtx bei reinen Server-Iterationen zu überspringen',
    },
    {
      version: '0.73',
      date: '2026-07-17',
      en: 'v0.73: Cluster band filter follows the contest you\'re in.\n- Switching to a different contest now refreshes the cluster view\'s band dropdown right away instead of keeping stale bands\n- Behind the scenes: bumped the Go builder image to 1.25-bookworm — nothing changes for you, just a housekeeping refresh',
      de: 'v0.73: Der Band-Filter in der Cluster-Ansicht folgt dem gewählten Contest.\n- Beim Wechsel in einen anderen Contest wird das Band-Dropdown in der Cluster-Ansicht jetzt sofort aktualisiert, statt alte Bänder stehen zu lassen\n- Im Hintergrund: das Go-Builder-Image steht jetzt auf 1.25-bookworm — für dich ändert sich nichts, nur eine Wartungsauffrischung',
    },
    {
      version: '0.72',
      date: '2026-07-17',
      en: 'v0.72: Contest scheduling by date + closed-contest browsing.\n- Contests can carry an optional start and end date; leave the end blank for a single-day contest, leave both blank to disable auto-close\n- Any dated contest is closed automatically the day after it ends (UTC); open UIs slide into read-only mode without a reload\n- Clicking a QSO in a closed contest again fills the mask read-only, so QRZ photo, country flag and bearing distance load like they should\n- Restore-a-backup modal actually accepts the type-to-confirm input now — the previous button did nothing\n- Automatic daily backup takes and retention prunes now show up in the audit log; retention edits also record their new value\n- Deploy is upload-first with a recovery trap and SSH keep-alive — a hung upload can no longer strand prod\n- New branded 504 page at log.dm2lap.com with contact address and a looping "TV losing signal" sequence when the server is down',
      de: 'v0.72: Conteste mit Datum planen + Browsen geschlossener Conteste.\n- Conteste bekommen ein optionales Start- und Enddatum; ohne Enddatum ist es ein eintägiger Contest, ohne beide bleibt der Automatik-Abschluss aus\n- Datierte Conteste werden am Tag nach dem Ende automatisch abgeschlossen (UTC); offene Oberflächen wechseln ohne Reload in den Lesemodus\n- Ein Klick auf ein QSO in einem abgeschlossenen Contest füllt die Maske wieder schreibgeschützt — QRZ-Foto, Länderflagge und Peil-Distanz laden wieder wie erwartet\n- Der „Backup wiederherstellen"-Dialog nimmt die Tippbestätigung jetzt wirklich an — der Button war zuletzt komplett tot\n- Automatische tägliche Backups und Retention-Löschungen erscheinen jetzt im Audit-Log; Retention-Änderungen zeigen den neuen Wert\n- Der Deploy lädt jetzt zuerst hoch, hat eine Wiederanlauf-Absicherung und SSH-Keep-Alive — ein hängender Upload legt prod nicht mehr lahm\n- Neue gebrandete 504-Seite auf log.dm2lap.com mit Kontakt-Adresse und einer Endlos-„TV verliert Signal"-Sequenz, wenn der Server aus ist',
    },
    {
      version: '0.71',
      date: '2026-07-16',
      en: 'v0.71: Restore a database backup with one click.\n- New Restore button in the Backups admin screen next to Download / Delete\n- Type-to-confirm modal: the button stays disabled until you type the exact filename\n- A fresh safety backup is taken automatically right before the restore runs — a misclick is always one step recoverable\n- Every browser sees a "restore in progress" overlay for ~30 seconds while the container is stopped, the database reloaded, and the container brought back\n- Requires the backups.manage permission (same as taking / downloading / deleting backups)\n- Restore is executed by a host-side systemd unit that ships with the deploy, so no manual SSH steps',
      de: 'v0.71: Datenbank-Backup mit einem Klick wiederherstellen.\n- Neuer „Wiederherstellen"-Button im Backups-Bildschirm neben Herunterladen / Löschen\n- Bestätigen durch Tippen: der Button bleibt inaktiv, bis du den exakten Dateinamen eingibst\n- Direkt vor dem Restore wird automatisch ein frisches Sicherheits-Backup erstellt — ein Vertipper ist immer einen Schritt zurück reparierbar\n- Alle Browser sehen für ca. 30 Sekunden ein Overlay „Restore läuft", während der Container gestoppt, die Datenbank neu geladen und der Container wieder gestartet wird\n- Erfordert die Berechtigung backups.manage (dieselbe wie für Erstellen / Herunterladen / Löschen von Backups)\n- Der Restore wird von einer hostseitigen systemd-Unit ausgeführt, die mit dem Deploy mitgeliefert wird — kein manueller SSH-Zugriff nötig',
    },
    {
      version: '0.70',
      date: '2026-07-16',
      en: 'v0.70: Automatic daily database backups, plus a cleaner deploy.\n- Postgres backups now run automatically every day, deduplicated by content and pruned after the retention window (default 30 days)\n- New Backups admin screen — take manual backups, download, delete, all gated behind a new backups.manage permission\n- Restore stays out of the UI on purpose; the screen shows the SSH recipe operators use to load a snapshot back with the app stopped\n- Retention window is configurable in Global Settings; set to 0 to keep every backup forever\n- Deploys are back to giving you the full 30-second shutdown warning — the pipeline no longer races the countdown\n- Ghost restart after the previous deploy is fixed: a stale shutdown trigger is now cleared on startup instead of firing a second time',
      de: 'v0.70: Automatische tägliche Datenbank-Backups, dazu ein sauberer Deploy.\n- Die Postgres-Datenbank wird jetzt automatisch täglich gesichert, per Inhalt dedupliziert und nach dem Aufbewahrungsfenster gelöscht (Standard: 30 Tage)\n- Neuer „Backups"-Bildschirm für Admins — manuelle Backups anstoßen, herunterladen, löschen, alles hinter der neuen Berechtigung backups.manage\n- Der Restore bleibt bewusst außerhalb der UI; der Bildschirm zeigt das SSH-Rezept, mit dem du bei gestopptem Server ein Snapshot wieder einspielst\n- Die Aufbewahrungsdauer stellst du in den globalen Einstellungen ein; 0 bedeutet: jedes Backup wird für immer behalten\n- Deploys spielen die 30-Sekunden-Abschaltwarnung wieder vollständig aus — die Pipeline überholt den Countdown nicht mehr\n- Der Geister-Neustart nach dem letzten Deploy ist gefixt: ein liegengebliebener Shutdown-Trigger wird beim Start jetzt sauber weggeräumt statt ein zweites Mal auszulösen',
    },
    {
      version: '0.69',
      date: '2026-07-16',
      en: 'v0.69: Moved storage to PostgreSQL; ADIF export tightened.\n- Database backend is now PostgreSQL 16 — SQLite is out\n- Backups run via pg_dump (see backup.sh); pgdata is bind-mounted for easy access\n- ADIF export now declares 3.1.5 and uses CR/LF line breaks in NOTES\n- Partner GRIDSQUARE is uppercased for LotW/eQSL compatibility\n- Custom-field editor suggests standard ADIF tags (STATE, POTA_REF, TX_PWR, …)\n- Custom fields named after a standard ADIF tag now export as that tag instead of APP_NOCTALUM_*\n- Cluster spots with non-UTF-8 comments (e.g. Latin-1 from European spotters) are now sanitised and saved instead of silently dropped',
      de: 'v0.69: Umstellung auf PostgreSQL-Speicher; ADIF-Export präziser.\n- Datenbank läuft jetzt auf PostgreSQL 16 — SQLite ist raus\n- Backups laufen über pg_dump (siehe backup.sh); pgdata liegt als Bind-Mount für einfachen Zugriff\n- ADIF-Export meldet jetzt Version 3.1.5 und nutzt CR/LF in NOTES\n- GRIDSQUARE der Gegenstation wird in Großbuchstaben ausgegeben (LotW/eQSL-konform)\n- Der Feld-Editor schlägt jetzt Standard-ADIF-Tags vor (STATE, POTA_REF, TX_PWR, …)\n- Eigene Felder mit ADIF-Standard-Namen werden als dieses Tag exportiert, nicht mehr als APP_NOCTALUM_*\n- Cluster-Spots mit nicht-UTF-8-Kommentaren (z. B. Latin-1 von europäischen Spottern) werden jetzt bereinigt gespeichert statt stillschweigend verworfen',
    },
    {
      version: '0.68',
      date: '2026-07-15',
      en: 'v0.68: Cleaner ADIF exports and a way to update your own callsign.\n- New "Request callsign change" card in Personal Settings — upload a licence scan, an admin approves or declines\n- Approved changes update your callsign live in every open session, no re-login\n- ADIF now carries the contest running number in STX/SRX; CSV gains nr_sent and nr_received columns\n- FT8/FT4/PSK31/PSK63 written as proper MODE+SUBMODE pairs, lighthouses via SIG/SIG_INFO — strict importers stop rejecting records\n- CONTEST_ID only for known ADIF contests; local activities land in NOTES instead of failing import\n- MY_GRIDSQUARE from your contest QTH is now emitted on every QSO\n- Names with umlauts (Jörg, José) go into the ADIF _INTL fields so LotW/eQSL show them correctly',
      de: 'v0.68: Saubere ADIF-Exports und ein Weg, dein eigenes Rufzeichen zu ändern.\n- Neue Karte „Rufzeichenänderung beantragen" in den persönlichen Einstellungen — Lizenznachweis hochladen, Admin gibt frei oder lehnt ab\n- Nach der Freigabe ist dein neues Rufzeichen sofort in jeder offenen Session aktiv, ohne Neuanmeldung\n- ADIF trägt jetzt die laufende Nummer in STX/SRX; CSV bekommt zusätzlich nr_sent und nr_received\n- FT8/FT4/PSK31/PSK63 werden als korrekte MODE+SUBMODE-Paare geschrieben, Leuchttürme über SIG/SIG_INFO — strenge Importer verwerfen keine Datensätze mehr\n- CONTEST_ID nur noch für bekannte ADIF-Conteste; lokale Aktivitäten landen in NOTES statt den Import zu sprengen\n- MY_GRIDSQUARE aus deinem Contest-QTH wird bei jedem QSO mitgeschrieben\n- Namen mit Umlauten (Jörg, José) landen in den ADIF-_INTL-Feldern, damit LotW/eQSL sie richtig anzeigen',
    },
    {
      version: '0.67',
      date: '2026-06-23',
      en: 'v0.67: "Edit Contest" no longer wedges keyboard focus.\n- Opening Edit Contest from the Map tab and typing in a field used to trap focus — Esc and Tab stopped working until a full page reload\n- Esc now reliably closes any modal, including via a second listener on the dialog itself\n- Clicking the dark backdrop outside the dialog also closes it\n- The first input in every modal is auto-focused so you always know where typing goes\n- Focus is released cleanly when a modal closes',
      de: 'v0.67: „Contest bearbeiten" friert die Tastatur nicht mehr ein.\n- Wenn du im Karten-Tab „Contest bearbeiten" geöffnet und in einem Feld getippt hast, blieb der Fokus stecken — Esc und Tab gingen erst nach Seiten-Neuladen wieder\n- Esc schließt jetzt zuverlässig jeden Dialog, abgesichert über einen zweiten Listener direkt am Dialog\n- Ein Klick auf den dunklen Bereich außerhalb des Dialogs schließt ihn ebenfalls\n- Das erste Eingabefeld in jedem Dialog wird automatisch fokussiert, damit du immer siehst, wohin Tippen geht\n- Der Fokus wird beim Schließen sauber freigegeben',
    },
    {
      version: '0.66',
      date: '2026-06-23',
      en: 'v0.66: Umlauts in export filenames are readable on every client.\n- Download managers and proxies that ignored the v0.60 RFC 5987 fix saw "Notfunk_bung.pdf"; they now see "Notfunkuebung.pdf"\n- Modern browsers still get the exact "Notfunkübung.pdf" via the unchanged filename* parameter\n- Transliteration covers ä/ö/ü/ß and their uppercase variants',
      de: 'v0.66: Umlaute in Export-Dateinamen sind auf jedem Client lesbar.\n- Download-Manager und Proxies, die den v0.60-RFC-5987-Fix ignoriert haben, lieferten „Notfunk_bung.pdf"; jetzt liefern sie „Notfunkuebung.pdf"\n- Moderne Browser bekommen weiterhin exakt „Notfunkübung.pdf" über den unveränderten filename*-Parameter\n- Die Transliteration umfasst ä/ö/ü/ß und die Großschreibungen',
    },
    {
      version: '0.65',
      date: '2026-06-23',
      en: 'v0.65: Personal Settings now save for regular users.\n- The Save button in Personal Settings was admin-only by mistake — it\'s back for everyone\n- Light theme and local-time pick now actually persist when a non-admin clicks Save\n- Default mode / default band selects are hidden for non-admins since they\'re global settings',
      de: 'v0.65: Persönliche Einstellungen lassen sich jetzt auch als regulärer Nutzer speichern.\n- Der Speichern-Button in den persönlichen Einstellungen war versehentlich admin-only — jetzt für alle wieder da\n- Helles Farbschema und Ortszeit-Auswahl werden beim Speichern als regulärer Nutzer wirklich übernommen\n- Standard-Mode / Standard-Band sind für Nicht-Admins ausgeblendet, da das globale Einstellungen sind',
    },
    {
      version: '0.64',
      date: '2026-06-23',
      en: 'v0.64: Hand off a contest config to another OM right from the chat.\n- New "Send to chat" button on every share — fires a one-click "Apply this config" card to everyone in the room\n- Recipients see the card inline in their chat; click Apply, fill in their own call + QTH, and they\'re set up\n- The card reuses the existing import flow so the operator picks a new contest name and stays in control\n- Old offers in the rolling 24-hour chat window keep rendering as cards on reconnect\n- "Send to chat" only appears for the contest you\'re currently in — chat is per-contest so cross-room offers can\'t happen by accident',
      de: 'v0.64: Contest-Konfig direkt aus dem Chat an einen anderen OM übergeben.\n- Neuer „In Chat senden"-Button auf jedem Share — schickt allen im Raum eine Ein-Klick-Karte „Diese Konfig übernehmen"\n- Empfänger sehen die Karte direkt im Chat; auf Übernehmen klicken, eigenes Rufzeichen + QTH eintragen, fertig\n- Die Karte nutzt den bestehenden Import-Dialog, sodass du den neuen Contest-Namen frei wählst\n- Alte Angebote im rollierenden 24-Stunden-Chatfenster erscheinen beim Reconnect wieder als Karten\n- „In Chat senden" erscheint nur für den Contest, in dem du gerade bist — Chat ist contest-gebunden, kein versehentlicher Versand in fremde Räume',
    },
    {
      version: '0.63',
      date: '2026-06-23',
      en: 'v0.63: Per-QSO distance in km and a one-click EU DX Contest preset.\n- New optional "km" column in the QSO log shows great-circle distance from your QTH to each station\n- Same distance column lands in the PDF export so printed logs carry it too\n- Distance values match the bearing panel exactly — same earth radius, same formula\n- New "Preset" dropdown in the Create Contest dialog with an EU DX Contest preset\n- The preset pre-fills bands (80/40/20/15/10 m) and a required region_code field for exchanges like 59 DE10\n- Region codes round-trip into ADIF and CSV via the existing custom-field plumbing',
      de: 'v0.63: Entfernung pro QSO in km und eine Ein-Klick-Vorlage für den EU DX Contest.\n- Neue optionale „km"-Spalte im QSO-Log zeigt die Großkreis-Entfernung von deinem QTH zu jeder Station\n- Dieselbe Spalte landet auch im PDF-Export, ausgedruckte Logs tragen sie also mit\n- Die Werte stimmen exakt mit dem Bearing-Panel überein — gleicher Erdradius, gleiche Formel\n- Neues „Vorlage"-Dropdown im Dialog „Neuer Contest" mit einer EU-DX-Contest-Vorlage\n- Die Vorlage füllt die Bänder (80/40/20/15/10 m) und ein Pflichtfeld region_code für Austausche wie 59 DE10 vor\n- Region-Codes laufen über die bestehende Custom-Field-Mechanik in ADIF und CSV mit',
    },
    {
      version: '0.62',
      date: '2026-06-23',
      en: 'v0.62: Light theme for outdoor use, finished logs you can browse, clearer helper setup.\n- New "Light (outdoor / high contrast)" theme in Personal Settings — dark text on a white background, AA contrast accents\n- Finished contests are browsable again: clicking a QSO row refreshes QRZ photo, country flag, locator and bearing distance\n- Admins get a "Reopen for editing" button on the read-only banner — no need to leave the contest to flip it back to open\n- Helper error messages now name the server URL you configured, so a wrong "localhost" is obvious at a glance\n- Helper-GUI shows a hint under the Server URL field: enter the Noctalum server, not your local browser',
      de: 'v0.62: Helles Farbschema für draußen, beendete Logs wieder durchstöberbar, klarere Helper-Einrichtung.\n- Neues „Hell (für draußen / hoher Kontrast)"-Farbschema in den persönlichen Einstellungen — dunkle Schrift auf weißem Hintergrund mit AA-Kontrast\n- Beendete Contests sind wieder durchstöberbar: Ein Klick auf eine QSO-Zeile aktualisiert QRZ-Foto, Länderflagge, Locator und Entfernung\n- Admins bekommen einen „Zum Bearbeiten wieder öffnen"-Button im Read-only-Banner — kein Wechsel zum Contest-Picker mehr nötig\n- Helper-Fehlermeldungen nennen jetzt die konfigurierte Server-URL, sodass ein falsches „localhost" sofort sichtbar ist\n- Im Helper-GUI steht ein Hinweis unter dem Server-URL-Feld: gib den Noctalum-Server ein, nicht deinen lokalen Browser',
    },
    {
      version: '0.61',
      date: '2026-06-23',
      en: 'v0.61: QSO entry hardening — local-time mode, band/freq guard, lookup race fix.\n- New choice in Personal Settings: type QSO times in UTC or in your local time (auto-converted to UTC)\n- The QSO time field label flips between "UTC date & time" and "Local date & time" so you always see the active frame\n- The form now rejects mismatched band/frequency combinations with a clear error (e.g. 144 MHz on the 20 m band)\n- "Wrong DOK after typing a new callsign" is fixed: stale lookup responses are now reliably discarded\n- Adding a band to a running contest now shows that band in the QSO form\'s dropdown immediately — you can edit existing QSOs onto it\n- Date/time field no longer overflows its grid cell (minute precision instead of seconds)\n- German RST labels match the Nr style: "RST geg." / "RST empf."',
      de: 'v0.61: QSO-Eingabe gehärtet — Ortszeit-Modus, Band/Frequenz-Prüfung, Lookup-Race behoben.\n- Neue Auswahl in den persönlichen Einstellungen: QSO-Zeit in UTC oder in deiner Ortszeit eingeben (wird automatisch in UTC umgerechnet)\n- Das Label am QSO-Zeitfeld wechselt zwischen „UTC-Datum & Zeit" und „Ortszeit Datum & Zeit", damit du den aktiven Modus immer siehst\n- Das Formular weist nicht zusammenpassende Band/Frequenz-Kombinationen mit einer klaren Fehlermeldung zurück (z.B. 144 MHz auf 20 m)\n- „Falscher DOK nach Rufzeichenwechsel" ist behoben: veraltete Lookup-Antworten werden zuverlässig verworfen\n- Wird einem laufenden Contest ein Band hinzugefügt, erscheint es sofort im Band-Dropdown der QSO-Eingabe — du kannst bestehende QSOs darauf umstellen\n- Das Datum/Zeit-Feld passt jetzt sauber ins Raster (Minutenauflösung statt Sekunden)\n- Deutsche RST-Bezeichnungen folgen dem Nr-Stil: „RST geg." / „RST empf."',
    },
    {
      version: '0.60',
      date: '2026-06-23',
      en: 'v0.60: Export polish, smarter QSO filter, portable callsigns supported.\n- DOK is now included in ADIF and CSV exports\n- Export filenames with umlauts (e.g. "Notfunkübung") download with their proper name instead of mojibake\n- PDF map page uses less toner — country labels removed, only outlines remain\n- QSO history filter fixed: "DL" no longer matches every row via the operator field; multi-token search like "dl 40 cw" now works\n- Callsigns with ITU prefix (F/DM2LAP) or portable suffix (DM2LAP/P, DM2LAP/MM, F/DM2LAP/QRP) are accepted in entry, lookup and exports\n- QRZ photo and known DOK still resolve correctly for portable calls — looked up under the home callsign',
      de: 'v0.60: Bessere Exporte, schlauerer QSO-Filter, Portable-Rufzeichen werden unterstützt.\n- DOK ist jetzt im ADIF- und CSV-Export enthalten\n- Dateinamen mit Umlauten (z.B. „Notfunkübung") laden mit dem richtigen Namen herunter statt mit Zeichensalat\n- PDF-Karte verbraucht weniger Toner — Beschriftungen sind weg, nur die Umrisse bleiben\n- QSO-Filter behoben: „DL" passt nicht mehr auf jeden Eintrag über das Operator-Feld; mehrere Token wie „dl 40 cw" funktionieren jetzt\n- Rufzeichen mit ITU-Präfix (F/DM2LAP) oder Portable-Suffix (DM2LAP/P, DM2LAP/MM, F/DM2LAP/QRP) werden bei Eingabe, Lookup und Export akzeptiert\n- QRZ-Foto und bekannter DOK werden für Portable-Calls weiterhin richtig gefunden — Lookup über das Heim-Rufzeichen',
    },
    {
      version: '0.59',
      date: '2026-06-11',
      en: 'v0.59: World map and 3D globe views in every contest, plus an optional map page in PDF exports.\n- New Map tab: 2D world map with band-coloured QSO dots, own-QTH marker and great-circle paths\n- 3D globe sub-tab: Google Earth-style zoom, country borders and labels that appear as you zoom in\n- Click a QSO dot (2D or 3D) to see its full QSO info; "Show paths" and per-band toggles in the legend\n- QSOs from the same locator across multiple bands now show as a multi-colour pie dot on every map\n- PDF export gets an optional map page, now rendered on a clean white background for print\n- PDF column picker is drag-and-drop — the order you set is the order in the PDF\n- Helper token is back in Personal Settings (Copy + Regenerate, with the noctalum-helper snippet)\n- ADIF and CSV exports now carry the contest\'s custom fields (Cabrillo/EDI unchanged on purpose)\n- Internal: the unauthenticated /api/shutdown endpoint is gone, replaced by a file-based trigger',
      de: 'v0.59: Karten- und 3D-Globus-Ansicht in jedem Contest und eine optionale Kartenseite im PDF-Export.\n- Neuer Karten-Tab: 2D-Weltkarte mit nach Band gefärbten QSO-Punkten, eigenem QTH und Großkreis-Pfaden\n- 3D-Globus als Unteransicht: Google-Earth-artiges Zoomen, Ländergrenzen und Labels je nach Zoomstufe\n- Klick auf einen QSO-Punkt (2D oder 3D) zeigt die vollen QSO-Daten; „Pfade anzeigen" und Band-Filter in der Legende\n- QSOs aus demselben Locator über mehrere Bänder erscheinen jetzt als mehrfarbiger Tortenpunkt auf allen Karten\n- PDF-Export bekommt eine optionale Kartenseite, jetzt mit sauberem weißem Hintergrund für den Druck\n- Spaltenauswahl im PDF-Export ist Drag-and-Drop — die Reihenfolge im PDF folgt deiner\n- Helper-Token ist zurück in den persönlichen Einstellungen (Kopieren + Neu generieren, mit dem noctalum-helper-Snippet)\n- ADIF- und CSV-Exporte enthalten jetzt die Custom Fields des Contests (Cabrillo/EDI bewusst unverändert)\n- Intern: der nicht-authentifizierte /api/shutdown-Endpoint ist weg, ersetzt durch einen dateibasierten Trigger',
    },
    {
      version: '0.58',
      date: '2026-06-02',
      en: 'v0.58: QRZ autofill clears reliably when you edit the callsign.\n- Autofilled name, locator and DOK are wiped the moment you change the callsign\n- Stale autofill no longer stays when the final callsign has no QRZ entry\n- Bearing panel distance is always shown in km (Mm abbreviation removed)',
      de: 'v0.58: QRZ-Autofill wird zuverlässig geleert, wenn du das Rufzeichen änderst.\n- Automatisch gefüllte Name, Locator und DOK werden sofort gelöscht, wenn du das Rufzeichen änderst\n- Veraltete Autofill-Daten bleiben nicht stehen, wenn das endgültige Rufzeichen keinen QRZ-Eintrag hat\n- Entfernung im Bearing-Panel wird immer in km angezeigt (Mm-Kürzel entfernt)',
    },
    {
      version: '0.57',
      date: '2026-06-02',
      en: 'New in v0.57: deploy-warning system, per-contest frequency unit, and bearing-panel distance.\n- Deploy countdown modal appears before server restarts; ribbon persists across page refresh\n- After countdown, app polls and auto-reloads once the server is back up\n- Contest settings now include an Hz/kHz/MHz/GHz frequency unit selector\n- Chosen unit applies everywhere: QSO form, log, PDF exports, and band error messages\n- Bearing panel now shows great-circle distance to target in km\n- QRZ lookups no longer race: stale responses from previous callsigns are discarded\n- Band dropdown correctly rebuilds when switching contests from the picker',
      de: 'Neu in v0.57: Deploy-Warnsystem, Frequenzeinheit pro Contest und Entfernung im Bearing-Panel.\n- Vor Server-Neustarts erscheint ein Countdown-Modal; das Ribbon bleibt auch nach Seitenaktualisierung\n- Nach dem Countdown prüft die App die Verfügbarkeit und lädt automatisch neu\n- In den Contest-Einstellungen gibt es jetzt eine Frequenzeinheit (Hz/kHz/MHz/GHz)\n- Die gewählte Einheit gilt im QSO-Formular, Log, PDF-Exporten und Band-Fehlermeldungen\n- Das Bearing-Panel zeigt jetzt die Großkreis-Entfernung zum Ziel in km an\n- QRZ-Suchen überschreiben sich nicht mehr: Antworten für veraltete Rufzeichen werden verworfen\n- Das Band-Dropdown aktualisiert sich jetzt korrekt beim Contestwechsel im Picker',
    },
    {
      version: '0.56',
      date: '2026-06-01',
      en: 'Band selector in the QSO form is now limited to contest bands, and a warning pill flags off-contest frequencies.\n- Band dropdown lists only the bands configured for the active contest.\n- New amber "NOT A CONTEST BAND" pill appears when rig, spot, or typed frequency is outside contest bands.\n- Pill sits next to the existing Duplicate / Worked Other badge.',
      de: 'Die Bandauswahl in der QSO-Maske zeigt jetzt nur Contest-Bänder, und eine Pill warnt bei Frequenzen außerhalb.\n- Das Band-Dropdown listet nur die im Contest konfigurierten Bänder auf.\n- Neue gelbe Pill „KEIN CONTEST-BAND" erscheint, wenn Rig, Spot oder eingegebene Frequenz außerhalb der Contest-Bänder liegt.\n- Die Pill sitzt neben dem bestehenden Duplikat-/Gearbeitet-Badge.',
    },
    {
      version: '0.55',
      date: '2026-05-29',
      en: 'This release is mostly about contest configuration reuse and a class of settings-save bugs. Every contest tile now has two new actions: Duplicate (clone the contest\'s custom fields, layout, log columns, bands, padding and stash expiry into a fresh empty contest of your own) and Share configuration (mint a URL another operator can open to import the same config, with a preview of what\'s in the package — number of custom fields, layout tiles, bands — before they commit). Share links don\'t carry station identity, so the importer fills in their own callsign and QTH. The contest picker also gains a top-level "Import shared config" button, and opening a share URL directly auto-fills the dialog. A series of polish fixes to the New-QSO mask: the date/time tile no longer bursts out of its grid slot, the Tab order now follows whatever custom layout you\'ve saved (it used to ignore re-arranging until the next page load), pressing Enter inside the Band or Mode dropdown logs the QSO, and the form now rejects mismatched frequency/band combinations with a clear error message. Several QSO fields including ITU/CQ got autocomplete="off" to stop browsers from prefilling stale values — this also explains the puzzling "ITU/CQ auto-filled with wrong zones" report: the app doesn\'t look up zones anywhere; what was happening was the browser\'s own form memory. The big settings-save fix: the shared /api/settings endpoint used to wipe any field a given form didn\'t explicitly populate — saving Global Settings cleared the band/mode defaults (this is what the "defaults can\'t be saved" report was actually about), saving Personal Settings cleared the DX cluster server and chat sound, and any save could clear QRZ.com credentials. Every settings field is now treated as "preserve unless explicitly sent" on the server. Global Settings also gained a top toolbar with Back-to-contests + Save so you don\'t have to scroll to the bottom. Two sidebar labels were renamed for clarity: the operator-facing pill is now "Feature Requests" (was "My Requests"), and the admin-only button is now "View all Feature Requests".',
      de: 'Diese Version dreht sich vor allem um die Wiederverwendung von Contest-Konfigurationen und eine ganze Klasse von Speicher-Bugs in den Einstellungen. Jede Contest-Kachel hat jetzt zwei neue Aktionen: „Duplizieren" (klont Custom Fields, Layout, Protokollspalten, Bänder, NR-Padding und Stash-Ablauf in einen neuen leeren Contest unter deinem Account) und „Konfiguration teilen" (erzeugt eine URL, mit der ein anderer OM dieselbe Konfiguration importieren kann — mit Vorschau, was im Paket steckt: Anzahl Custom Fields, Layout-Kacheln, Bänder, bevor er bestätigt). Share-Links enthalten keine Stationsdaten; der Importierende trägt sein eigenes Rufzeichen und QTH ein. Im Contest-Picker gibt es zusätzlich oben einen „Geteilte Konfig importieren"-Button, und wer eine Share-URL direkt öffnet, bekommt den Dialog vorausgefüllt. In der QSO-Eingabemaske eine Reihe Politur-Fixes: Die Datum/Uhrzeit-Kachel überschießt nicht mehr ihre Spalte, die Tab-Reihenfolge folgt jetzt deinem gespeicherten Layout (vorher blieb sie nach dem Umsortieren bis zum nächsten Seitenladen falsch), Enter in den Band- oder Mode-Dropdowns loggt das QSO wie in jedem anderen Feld, und die Maske weist nicht zueinander passende Frequenz/Band-Kombinationen mit einer klaren Fehlermeldung zurück. Mehrere QSO-Felder einschließlich ITU/CQ haben autocomplete="off" bekommen, damit Browser keine veralteten Werte mehr vorausfüllen — das ist auch die Auflösung des rätselhaften Berichts „ITU/CQ wird mit falschen Zonen automatisch ausgefüllt": Die App schlägt Zonen nirgends nach; was du gesehen hast, war das Formular-Gedächtnis deines eigenen Browsers. Der große Settings-Speicher-Fix: Der gemeinsame /api/settings-Endpoint hat vorher jedes Feld, das ein Formular nicht explizit gefüllt hat, mit dem Leerwert überschrieben — Speichern in den globalen Einstellungen hat Standard-Mode/Band gelöscht (genau das war der Bericht „die Standardwerte lassen sich nicht speichern"), Speichern in den persönlichen Einstellungen hat den DX-Cluster-Server und den Chat-Sound gelöscht, und jedes Speichern konnte die QRZ.com-Zugangsdaten löschen. Jedes Settings-Feld wird jetzt auf dem Server als „behalten, falls nicht explizit gesendet" behandelt. Die globalen Einstellungen haben zusätzlich oben eine Werkzeugleiste mit „Zurück zu den Contests" + „Speichern" bekommen, damit du dafür nicht mehr bis ans Ende scrollen musst. Zum Schluss zwei umbenannte Sidebar-Labels: Die für alle sichtbare Pille heißt jetzt „Feature Requests" (vorher „My Requests"), und der nur für Admins sichtbare Button heißt jetzt „View all Feature Requests".',
    },
    {
      version: '0.54',
      date: '2026-05-29',
      en: 'Sortable columns on the feature-requests tables. Both the admin Feature Requests screen and the (admin- or public-mode) My Feature Requests screen now let you click any column header to sort by that column. The first click sorts ascending, the second click sorts descending, and the third click clears the sort and returns the list to its original order — an arrow (▲ / ▼) next to the column title shows the current direction. Each table keeps its own sort state so flipping between the two views does not reset the other. Sorting works on the client side, so it is instant even on long lists, and the read-only public view of feature requests respects the toggle just like the admin view.',
      de: 'Sortierbare Spalten in den Feature-Wunsch-Tabellen. Sowohl im Admin-Bildschirm „Feature-Wünsche" als auch im Bildschirm „Meine Feature-Wünsche" (im persönlichen wie im öffentlichen Modus) kannst du jetzt auf jede Spaltenüberschrift klicken, um nach dieser Spalte zu sortieren. Der erste Klick sortiert aufsteigend, der zweite absteigend, und der dritte Klick hebt die Sortierung auf und zeigt die Liste wieder in der ursprünglichen Reihenfolge — ein Pfeil (▲ / ▼) neben der Spaltenüberschrift zeigt die aktuelle Richtung. Jede Tabelle hat einen eigenen Sortierzustand, sodass ein Wechsel zwischen beiden Ansichten den anderen Zustand nicht zurücksetzt. Sortiert wird auf der Client-Seite, daher ist es auch bei langen Listen sofort sichtbar; die schreibgeschützte öffentliche Ansicht der Feature-Wünsche verhält sich dabei genauso wie die Admin-Ansicht.',
    },
    {
      version: '0.53',
      date: '2026-05-29',
      en: 'Feature requests can now be made public. A new toggle in Global Settings (admin only) — "Make feature requests public to all logged-in users" — switches the My Feature Requests screen for every logged-in user from a personal list to a strictly read-only view of every submitted request (with a From column showing who sent each one). Users can still submit their own new requests, but cannot edit, delete, or comment on anyone else\'s; all status changes and admin comments remain reserved for the admin Feature Requests screen. The setting persists in the global settings table and is read by GET /api/feature-requests/mine, which now serves the full list when the toggle is on.',
      de: 'Feature-Wünsche können jetzt öffentlich gemacht werden. Ein neuer Schalter in den globalen Einstellungen (nur für Admins) — „Feature-Wünsche für alle angemeldeten Nutzer sichtbar machen" — schaltet bei jedem angemeldeten Nutzer den Bildschirm „Meine Feature-Wünsche" von der persönlichen Liste auf eine strikt schreibgeschützte Ansicht aller eingereichten Wünsche um (mit einer Spalte „Von", die zeigt, wer den Wunsch eingereicht hat). Nutzer können weiterhin eigene neue Wünsche einreichen, aber fremde Wünsche weder bearbeiten, löschen noch kommentieren; Statusänderungen und Admin-Kommentare bleiben dem Admin-Bildschirm für Feature-Wünsche vorbehalten. Die Einstellung wird in der globalen Settings-Tabelle gespeichert und von GET /api/feature-requests/mine ausgewertet, das bei aktiviertem Schalter die vollständige Liste liefert.',
    },
    {
      version: '0.52',
      date: '2026-05-29',
      en: 'Telegram notifier catches up on multiple unposted versions. Previously, if you bumped the version several times between deploys, only the newest entry was announced and the intermediate ones were silently skipped. Now the notifier walks back from the latest entry to the last-posted one and sends each missing entry as a separate message in chronological order (oldest first), with a 1.5 s pause between messages so Telegram does not throttle the bot. The cursor is moved after each successful send, so a network blip in the middle of a catch-up batch resumes from where it left off on the next deploy rather than replaying earlier messages. Empty cursor (first run after --setup) and unknown cursor (the recorded version is no longer in the array) both still post only the top entry, to make sure the bot can never spam fifty historical messages by accident.',
      de: 'Der Telegram-Notifier holt verpasste Versionen jetzt nach. Vorher wurde bei mehreren Versions-Bumps zwischen zwei Deploys nur der neueste Eintrag angekündigt; die dazwischenliegenden fielen still unter den Tisch. Jetzt läuft der Notifier vom neuesten Eintrag zurück bis zur zuletzt geposteten Version und schickt jeden verpassten Eintrag in chronologischer Reihenfolge (älteste zuerst) als eigene Nachricht — mit 1,5 s Pause dazwischen, damit Telegram den Bot nicht ausbremst. Der Cursor wird nach jedem erfolgreichen Senden weitergesetzt, sodass ein Netzwerkproblem mitten in einem Nachhol-Batch beim nächsten Deploy nahtlos da weitermacht, wo es aufgehört hat, statt frühere Nachrichten zu wiederholen. Leerer Cursor (erster Lauf nach --setup) und unbekannter Cursor (die gespeicherte Version steht nicht mehr im Array) führen weiterhin dazu, dass nur der oberste Eintrag gepostet wird — damit der Bot nie versehentlich fünfzig historische Nachrichten in die Gruppe spammt.',
    },
    {
      version: '0.51',
      date: '2026-05-29',
      en: 'Deploy script now announces new versions in a Telegram group. After the production deploy finishes, a small new helper (noctalum-notify-telegram) reads the latest CHANGELOG entry, posts the German body to the configured group via the Telegram Bot API, and remembers what it posted — so a repeat redeploy at the same version does not double-post. Run the binary with --setup once to paste the bot token and let it auto-detect the group chat_id as soon as you add the bot and send a message; the config lives in ~/.config/noctalum/telegram.json (chmod 0600). The notifier never aborts a deploy: missing config or Telegram errors just print a warning and exit 0.',
      de: 'Das Deploy-Skript kündigt neue Versionen jetzt in einer Telegram-Gruppe an. Nach erfolgreichem Produktions-Deploy liest ein neues kleines Hilfsprogramm (noctalum-notify-telegram) den neuesten CHANGELOG-Eintrag, schickt den deutschen Text über die Telegram-Bot-API in die konfigurierte Gruppe und merkt sich, was es gepostet hat — ein erneuter Deploy derselben Version wird also nicht doppelt angekündigt. Führe das Binary einmalig mit --setup aus, um den Bot-Token einzugeben; es erkennt die chat_id automatisch, sobald du den Bot in die Gruppe einlädst und dort eine Nachricht schickst. Die Konfiguration liegt in ~/.config/noctalum/telegram.json (chmod 0600). Schlägt die Benachrichtigung fehl, wird der Deploy nicht abgebrochen — du siehst nur eine Warnung.',
    },
    {
      version: '0.50',
      date: '2026-05-24',
      en: 'QSO entry: the "NR given" field now refreshes when another QSO is logged or deleted elsewhere. Previously the auto-filled preview was treated like a typed value, so it stayed put even when the underlying next-number changed — leaving the field showing a stale number that was already in use or just freed. A new flag tracks whether the field holds an auto-filled preview vs. a number you actually typed; only auto-filled values get overwritten on refresh.',
      de: 'QSO-Eingabe: Das Feld „NR gegeben" wird jetzt aktualisiert, wenn anderswo ein QSO geloggt oder gelöscht wird. Vorher wurde die automatisch eingetragene Vorschau wie ein eingetippter Wert behandelt und blieb stehen, auch wenn sich die nächste Nummer geändert hatte — das Feld zeigte dann eine veraltete Nummer, die bereits vergeben oder gerade freigeworden war. Ein neues Flag unterscheidet jetzt zwischen automatisch eingetragener Vorschau und tatsächlich eingetippter Nummer; nur die Vorschau wird beim Refresh überschrieben.',
    },
    {
      version: '0.49',
      date: '2026-05-24',
      en: 'Serial-number recycling: deleting a QSO now frees its number on the server. The next number handed out is max(nr_sent) + 1 over the remaining QSOs, so deleting the top-most QSO immediately makes its number available again. An operator already mid-entry keeps their pre-filled number (the empty-form preview is what refreshes); the atomic assignment at log time then gives them whichever number is current.',
      de: 'NR-Recycling: Beim Löschen eines QSOs wird dessen Nummer auf dem Server wieder freigegeben. Die nächste vergebene Nummer ist nun max(nr_sent) + 1 über die verbleibenden QSOs — wird also das oberste QSO gelöscht, ist dessen Nummer sofort wieder verfügbar. Wenn du gerade mitten in einer Eingabe bist, behältst du die bereits eingetragene Nummer (nur die leere Formular-Vorschau aktualisiert sich); die atomare Zuweisung beim Speichern vergibt dann die aktuell niedrigste freie Nummer.',
    },
    {
      version: '0.48',
      date: '2026-05-22',
      en: 'Fixed typos.',
      de: 'Tippfehler korrigiert.',
    },
    {
      version: '0.47',
      date: '2026-05-22',
      en: 'Contest picker: a credits footer at the bottom of the screen acknowledges DM2LAP and Claude as co-creators (with the DARC O35 club), states the GPLv3 license, links to the source on GitHub, and links to panthera.org for donations toward wild-cat conservation.',
      de: 'Contest-Auswahl: Eine Credits-Zeile am unteren Seitenrand würdigt DM2LAP und Claude als Mit-Entwickler (mit dem DARC-OV O35), nennt die GPLv3-Lizenz, verlinkt den Quellcode auf GitHub und panthera.org für Spenden zum Schutz von Wildkatzen.',
    },
    {
      version: '0.46',
      date: '2026-05-22',
      en: 'PDF export footer now prints the current app version in the bottom-left corner (was a stale "Noctalum 0.3.0"). The server-side `programVersion` constant is now kept in sync with the CHANGELOG entry on every release, and the footer reads "Noctalum v0.46" to match how the changelog displays it.',
      de: 'PDF-Export-Fußzeile zeigt jetzt unten links die aktuelle App-Version (vorher veralteter Wert „Noctalum 0.3.0"). Die serverseitige `programVersion`-Konstante wird jetzt bei jedem Release mit dem CHANGELOG-Eintrag synchron gehalten, und die Fußzeile schreibt „Noctalum v0.46", passend zur Anzeige im Changelog.',
    },
    {
      version: '0.45',
      date: '2026-05-22',
      en: 'Cluster spot click: the in-flight entry is now stashed BEFORE the spot\'s data is written into the form, so the stash carries the callsign you had typed, not the one you clicked. The rig-tune broadcast that follows is also suppressed (lastRigFreqs is pre-set to the spot frequency) so it can no longer re-stash the freshly-loaded spot.',
      de: 'Klick auf Cluster-Spot: Das laufende Formular wird jetzt gestasht, BEVOR die Spot-Daten ins Formular geschrieben werden — der Stash enthält also das vorher eingegebene Rufzeichen, nicht das angeklickte. Die nachfolgende TRX-QSY-Meldung wird ebenfalls unterdrückt (lastRigFreqs wird vorab auf die Spot-Frequenz gesetzt), damit sie den frisch geladenen Spot nicht erneut stasht.',
    },
    {
      version: '0.44',
      date: '2026-05-22',
      en: 'Brand wordmark in the contest-overview topbar now uses the same blue, bold, slightly tracked-out style as the logging-window topbar. The `.topbar .brand` rule (and its mobile-mode tweaks) was scoped to `.topbar` only; the contest topbar lives under `.contest-topbar` so it had been falling back to default text styling.',
      de: 'Die Wortmarke in der Contest-Übersicht hat jetzt dasselbe blaue, fette, leicht gesperrte Schriftbild wie im Logging-Fenster. Die Regel `.topbar .brand` (und ihre Mobile-Mode-Varianten) war nur auf `.topbar` beschränkt; die Contest-Topbar nutzt `.contest-topbar` und fiel daher auf das Standardtext-Styling zurück.',
    },
    {
      version: '0.43',
      date: '2026-05-22',
      en: 'Contest picker uses the full width of the page: `.contest-screen-layout` now stretches to 100 % (capped at 1800 px on ultra-wide screens). The middle card keeps its `flex: 1`, so it absorbs all the extra horizontal space while the nav-pill on the left and the Online-Now panel on the right keep their compact widths.',
      de: 'Contest-Auswahl nutzt die gesamte Seitenbreite: `.contest-screen-layout` dehnt sich jetzt auf 100 % (max. 1800 px auf Ultra-Wide-Monitoren). Die mittlere Karte behält ihr `flex: 1`, sodass sie den zusätzlichen Platz aufnimmt, während Nav-Pill links und Online-Panel rechts ihre kompakten Breiten behalten.',
    },
    {
      version: '0.42',
      date: '2026-05-22',
      en: 'CSV export now starts with a UTF-8 byte-order mark, so Excel opens the file as UTF-8 and umlauts (ä, ö, ü, ß) render correctly instead of as mojibake. The file is unchanged for text editors and tools that already handle UTF-8.',
      de: 'CSV-Export beginnt jetzt mit einem UTF-8-Byte-Order-Mark, damit Excel die Datei als UTF-8 öffnet und Umlaute (ä, ö, ü, ß) korrekt anzeigt statt als Zeichensalat. Für Texteditoren und Tools, die UTF-8 ohnehin verstehen, ändert sich nichts.',
    },
    {
      version: '0.41',
      date: '2026-05-22',
      en: 'Edit QSO: custom-field values (text, number, dropdown) are now populated into the form when a logged QSO is selected for editing. Previously only the built-in fields were filled, so a dropdown saved on the QSO appeared blank in the Edit mask.',
      de: 'QSO bearbeiten: Werte benutzerdefinierter Felder (Text, Zahl, Dropdown) werden jetzt ins Formular übernommen, wenn ein bereits geloggtes QSO zur Bearbeitung gewählt wird. Vorher waren nur die fest eingebauten Felder gefüllt, sodass ein gespeichertes Dropdown in der Bearbeiten-Maske leer erschien.',
    },
    {
      version: '0.40',
      date: '2026-05-22',
      en: 'Main menu: the icon next to "Users" is now a smiling face (☺, U+263A) instead of the frowning one (☹, U+2639).',
      de: 'Hauptmenü: Das Symbol neben „Benutzer" ist jetzt ein lächelndes Gesicht (☺, U+263A) statt des verdriesslichen (☹, U+2639).',
    },
    {
      version: '0.39',
      date: '2026-05-22',
      en: 'QSO history: a red "× Filter" pill appears next to the filter input when any filter is active (typed text or callsign drill-down). One click clears both filters.',
      de: 'QSO-Verlauf: Ein roter „× Filter"-Pill erscheint neben dem Filterfeld, sobald ein Filter aktiv ist (eingetippter Text oder Rufzeichen-Drilldown). Ein Klick entfernt beide Filter.',
    },
    {
      version: '0.38',
      date: '2026-05-22',
      en: 'PDF export: long cell values (Notes, Name, custom fields, …) now wrap onto multiple lines instead of being truncated at the column edge. Each row grows to the height of its tallest wrapped cell; zebra stripes and column borders stay aligned.',
      de: 'PDF-Export: Lange Zellinhalte (Notizen, Name, benutzerdefinierte Felder …) werden jetzt auf mehrere Zeilen umgebrochen, statt am Spaltenrand abgeschnitten zu werden. Jede Zeile wächst auf die Höhe der höchsten umgebrochenen Zelle; Zebra-Streifen und Spaltenrahmen bleiben ausgerichtet.',
    },
    {
      version: '0.37',
      date: '2026-05-22',
      en: 'PDF export: column titles in the table header are now left-aligned (they were centred), matching the body cells and giving long labels room to read.',
      de: 'PDF-Export: Spaltenüberschriften in der Tabellenkopfzeile sind jetzt linksbündig (vorher zentriert), passend zu den Datenzeilen und mit mehr Platz für lange Bezeichnungen.',
    },
    {
      version: '0.36',
      date: '2026-05-22',
      en: 'Export: new PDF report with a Noctalum logo header, contest meta block, repeated table header on each page, and zebra-striped rows. The Export tab now has a column picker — checkboxes default to the columns currently visible in Past QSOs, and the chosen columns are passed to the PDF in the contest\'s saved column order.',
      de: 'Export: neuer PDF-Bericht mit Noctalum-Logo-Kopfzeile, Contest-Metablock, wiederholter Tabellenkopfzeile auf jeder Seite und Zebra-Streifen. Der Export-Tab hat jetzt eine Spaltenauswahl — die Checkboxen sind vorausgewählt auf die im QSO-Verlauf sichtbaren Spalten, und die gewählten Spalten werden in der gespeicherten Reihenfolge des Contests an das PDF übergeben.',
    },
    {
      version: '0.35',
      date: '2026-05-22',
      en: 'New QSO form: the optional UTC-time input is now a full date-and-time picker — pick the date and the time together when back-logging a QSO that happened on a different day.',
      de: 'Neue-QSO-Formular: Die optionale UTC-Zeit ist jetzt eine kombinierte Datum-und-Zeit-Auswahl — wähle Datum und Uhrzeit zusammen, wenn du ein QSO nachträglich für einen anderen Tag eintragen willst.',
    },
    {
      version: '0.34',
      date: '2026-05-22',
      en: 'Mobile mode: auto-engages on phones (and on any viewport ≤640 px) with a touch-optimised layout — compact topbar, single-column QSO entry form with a "+ More fields" toggle for everything past callsign/RST/mode/band, larger 44 px tap targets, and a fixed bottom navigation bar that opens Status / Stash / Cluster / Chat / Objective as a full-screen sheet. Manual override (Auto / Desktop / Mobile) in Settings, plus a `?mode=mobile|desktop` URL flag for testing.',
      de: 'Mobilmodus: aktiviert sich automatisch auf Telefonen (und auf jedem Viewport ≤640 px) mit Touch-optimiertem Layout — kompakte Topleiste, einspaltiges QSO-Formular mit Umschalter „+ Weitere Felder" für alles ausser Rufzeichen/RST/Mode/Band, grössere 44-px-Tap-Ziele und eine untere Navigationsleiste, die Status / Stash / Cluster / Chat / Ziel als Vollbild-Sheet öffnet. Manuelle Umschaltung (Automatisch / Desktop / Mobil) in den Einstellungen sowie ein URL-Flag `?mode=mobile|desktop` zum Testen.',
    },
    {
      version: '0.33',
      date: '2026-05-22',
      en: 'Right sidebar tabs (Status, Stash, Cluster, Chat, Objective) now wrap to a second row when the panel is too narrow instead of overflowing past the panel edge.',
      de: 'Tabs der rechten Seitenleiste (Status, Stash, Cluster, Chat, Ziel) brechen jetzt in eine zweite Zeile um, wenn das Panel zu schmal ist, statt über den Panelrand hinauszuragen.',
    },
    {
      version: '0.32',
      date: '2026-05-22',
      en: 'Chat tab: the message input and Send button are now pinned to the bottom and the tab header stays in place — only the message list scrolls.',
      de: 'Chat-Tab: Das Nachrichtenfeld und der Senden-Knopf bleiben jetzt unten fixiert und der Tab-Kopf bleibt an Ort und Stelle — nur die Nachrichtenliste scrollt.',
    },
    {
      version: '0.31',
      date: '2026-05-22',
      en: 'New "Stash" tab next to Status: when the TRX moves to a different frequency mid-entry, the in-flight QSO is auto-stashed (callsign + all other fields kept). Click an entry to retune the TRX and refill the form. Auto-delete after a configurable time (default 60 min, set per contest).',
      de: 'Neuer Tab „Stash" neben Status: Wenn der TRX während der Eingabe die Frequenz wechselt, wird das laufende QSO automatisch gestasht (Rufzeichen + alle weiteren Felder bleiben erhalten). Klicke einen Eintrag an, um den TRX zurückzustimmen und die Maske wiederherzustellen. Automatisches Löschen nach konfigurierbarer Zeit (Standard 60 min, pro Contest einstellbar).',
    },
    {
      version: '0.30',
      date: '2026-05-22',
      en: 'Fix: band selector in New QSO now shows "20 m", "70 cm" etc. correctly; notes field no longer forced to uppercase. (CSS specificity fix)',
      de: 'Fix: Bandauswahl im neuen QSO zeigt jetzt korrekt „20 m", „70 cm" usw.; Notizfeld nicht mehr in Großbuchstaben erzwungen.',
    },
    {
      version: '0.29',
      date: '2026-05-22',
      en: 'Duplicate detection: SSB, USB and LSB are now treated as the same mode. A QSO logged as USB counts as a duplicate of a prior SSB or LSB contact on the same band.',
      de: 'Duplikaterkennung: SSB, USB und LSB werden jetzt als gleiche Betriebsart behandelt. Ein als USB geloggtes QSO gilt als Duplikat eines früheren SSB- oder LSB-Kontakts im selben Band.',
    },
    {
      version: '0.28',
      date: '2026-05-22',
      en: 'Band labels now display with a space before the unit everywhere: "20 m", "70 cm", "2 m", etc. Internal identifiers are unchanged.',
      de: 'Bandbezeichnungen werden überall mit Leerzeichen vor der Einheit angezeigt: „20 m", „70 cm", „2 m" usw. Interne Bezeichner bleiben unverändert.',
    },
    {
      version: '0.27',
      date: '2026-05-22',
      en: 'New: slim "← Back to overview" pill below the logo in the contest view; clicking the station pill now opens contest settings (read-only for users without edit rights).',
      de: 'Neu: Schlanke „← Zur Übersicht"-Pill unter dem Logo in der Contest-Ansicht; Klick auf die Station-Pill öffnet jetzt die Contest-Einstellungen (nur lesend für Nutzer ohne Bearbeitungsrechte).',
    },
    {
      version: '0.26',
      date: '2026-05-22',
      en: 'New: "What\'s New?" dialog shows missed changelog entries after a version update. German UI now uses informal "du" throughout.',
      de: 'Neu: „Was ist neu?"-Dialog zeigt verpasste Changelog-Einträge nach einem Update. Deutsche Oberfläche nutzt jetzt durchgehend „du".',
    },
    {
      version: '0.25',
      date: '2026-05-22 17:00 UTC',
      en: 'Fix: chat message history now loads reliably when entering a contest (force WebSocket reconnect on contest entry so the server re-sends the history replay).',
      de: 'Fix: Chat-Nachrichtenverlauf wird beim Betreten eines Contests zuverlässig geladen (WebSocket wird beim Contest-Eintritt neu verbunden, damit der Server den Verlauf erneut sendet).',
    },
    {
      version: '0.24',
      date: '2026-05-22 16:00 UTC',
      en: 'Notes field no longer forced uppercase. Contest edit modal: draggable log-column picker below WYSIWYG editor configures which columns appear in QSO history.',
      de: 'Notizfeld nicht mehr Großschreibung. Contest-Bearbeitungsmaske: Ziehbarer Spalten-Auswähler unterhalb des WYSIWYG-Editors konfiguriert sichtbare QSO-Protokollspalten.',
    },
    {
      version: '0.23',
      date: '2026-05-22 15:30 UTC',
      en: 'QRZ.com credentials moved to Global Settings (one account for all server-side lookups).',
      de: 'QRZ.com-Zugangsdaten in die Globalen Einstellungen verschoben (ein Konto für alle serverseitigen Abfragen).',
    },
    {
      version: '0.22',
      date: '2026-05-22 15:00 UTC',
      en: 'Fixed chat sounds (broken updateChatSoundToggleBtn reference). Settings tab removed from contest view.',
      de: 'Chat-Töne repariert (fehlerhafte updateChatSoundToggleBtn-Referenz). Settings-Tab aus der Contest-Ansicht entfernt.',
    },
    {
      version: '0.21',
      date: '2026-05-22 14:30 UTC',
      en: 'Chat sound mute button removed from contest picker; replaced by a toggleable pill in Personal Settings.',
      de: 'Chat-Ton-Stummschalttaste aus der Contest-Auswahl entfernt; durch eine umschaltbare Pill in den Persönlichen Einstellungen ersetzt.',
    },
    {
      version: '0.20',
      date: '2026-05-22 14:00 UTC',
      en: 'Typing a frequency now auto-selects the correct band. Contest settings button removed from topbar; "My Settings" renamed to "Personal Settings" in the main menu.',
      de: 'Frequenzeingabe wählt automatisch das passende Band. Contest-Einstellungs-Schaltfläche aus der Topbar entfernt; "Meine Einstellungen" in "Persönliche Einstellungen" umbenannt.',
    },
    {
      version: '0.19',
      date: '2026-05-22 13:15 UTC',
      en: 'Download Helper: AppImage pill is now shown below the download button (inside the recommended box).',
      de: 'Download-Helper: AppImage-Pill wird jetzt unterhalb der Download-Schaltfläche angezeigt (innerhalb des Empfohlen-Rahmens).',
    },
    {
      version: '0.18',
      date: '2026-05-22 13:00 UTC',
      en: 'Download Helper: AppImage label moved into a pill next to the button. Recommended downloads get a light blue box around button and pill, with "Recommended" text above.',
      de: 'Download-Helper: AppImage-Label als Pill neben den Button verschoben. Empfohlene Downloads erhalten einen hellblauen Rahmen um Schaltfläche und Pill, mit "Empfohlen"-Text darüber.',
    },
    {
      version: '0.17',
      date: '2026-05-22 12:30 UTC',
      en: 'Download Helper polished: Linux OS icon replaced with official Tux (Simple Icons). All download buttons are now exactly the same width. AppImage downloads show "Recommended" text above with an accent-colored border rim.',
      de: 'Download-Helper verfeinert: Linux-OS-Symbol durch offiziellen Tux (Simple Icons) ersetzt. Alle Download-Schaltflächen haben jetzt exakt dieselbe Breite. AppImage-Downloads zeigen "Empfohlen" darüber mit farbigem Rahmen.',
    },
    {
      version: '0.16',
      date: '2026-05-22 12:00 UTC',
      en: 'Download Helper refined: OS buttons now show official brand logos (Windows, Apple, Linux). The Linux AppImage download is labeled as such and marked as recommended. The GUI helper description now mentions that rigctld is included — no separate installation needed.',
      de: 'Download-Helper verfeinert: OS-Buttons zeigen jetzt offizielle Markenlogos (Windows, Apple, Linux). Der Linux-AppImage-Download ist entsprechend gekennzeichnet und als empfohlen markiert. Die GUI-Helper-Beschreibung weist nun darauf hin, dass rigctld enthalten ist – keine separate Installation nötig.',
    },
    {
      version: '0.15',
      date: '2026-05-22 11:00 UTC',
      en: 'Download Helper: the sidebar download panel is replaced by a "Download Helper" button that opens a two-step modal — first choose your OS, then see each application with description and download links.',
      de: 'Download-Helper: Das Sidebar-Download-Panel wurde durch einen "Helper herunterladen"-Button ersetzt, der ein zweistufiges Modal öffnet — zuerst das Betriebssystem wählen, dann jede Anwendung mit Beschreibung und Download-Links.',
    },
    {
      version: '0.14',
      date: '2026-05-22 10:00 UTC',
      en: 'DOK Database: new management screen (dok.edit permission) with full CRUD, CSV import/export. Auto-commit now only stores a callsign\'s DOK the first time; existing entries are never overwritten automatically.',
      de: 'DOK-Datenbank: Neuer Verwaltungsbildschirm (Berechtigung dok.edit) mit vollständigem CRUD, CSV-Import/-Export. Auto-Commit speichert das DOK eines Rufzeichens jetzt nur beim ersten Auftreten; bestehende Einträge werden nie automatisch überschrieben.',
    },
    {
      version: '0.13',
      date: '2026-05-21 16:30 UTC',
      en: 'Band-conflict warning revised: a pulsing red stripe "MULTIPLE STATIONS ON [BAND]" now appears below the operator list in the Status tab instead of orange pill highlights.',
      de: 'Bandkonflikt-Warnung überarbeitet: Ein pulsierender roter Streifen „MEHRERE STATIONEN AUF [BAND]" erscheint jetzt unterhalb der Operatorliste im Status-Tab anstelle der orangen Band-Markierungen.',
    },
    {
      version: '0.12',
      date: '2026-05-21 16:20 UTC',
      en: 'Reverted: "View log →" badge on finished contests in the contest picker has been removed.',
      de: 'Rückgängig gemacht: Das "Log ansehen →"-Badge bei beendeten Contests in der Contestauswahl wurde entfernt.',
    },
    {
      version: '0.11',
      date: '2026-05-21 16:05 UTC',
      en: 'Version number now displayed next to "Noctalum" in the title bar on all screens.',
      de: 'Versionsnummer wird jetzt neben "Noctalum" in der Titelleiste auf allen Seiten angezeigt.',
    },
    {
      version: '0.10',
      date: '2026-05-21 16:00 UTC',
      en: 'Changelog now shows date and time (UTC) for each entry.',
      de: 'Das Changelog zeigt jetzt Datum und Uhrzeit (UTC) für jeden Eintrag.',
    },
    {
      version: '0.9',
      date: '2026-05-21 15:52 UTC',
      en: 'DOK callsign caching: when a callsign is re-entered, the DOK field is auto-filled from the last logged QSO with that callsign.',
      de: 'DOK-Rufzeichenzwischenspeicher: Wird ein Rufzeichen erneut eingegeben, wird das DOK-Feld automatisch aus dem letzten geloggten QSO mit diesem Rufzeichen befüllt.',
    },
    {
      version: '0.8',
      date: '2026-05-21 15:50 UTC',
      en: 'Multi-op band-busy warning: band pills highlight in orange when another operator is already on that band. A confirmation dialog warns before logging a QSO on a busy band.',
      de: 'Mehroperator-Bandwarnung: Band-Pills werden orange hervorgehoben, wenn ein anderer Operator bereits auf diesem Band ist. Ein Bestätigungsdialog warnt vor dem Loggen eines QSOs auf einem belegten Band.',
    },
    {
      version: '0.7',
      date: '2026-05-21 15:46 UTC',
      en: 'Manual QSO time entry now uses a time-only (HH:MM:SS) UTC input, fixing the bug where local time was logged as UTC.',
      de: 'Manuelle QSO-Zeiteingabe verwendet jetzt ein reines Zeitfeld (HH:MM:SS) in UTC, was den Fehler behebt, bei dem Ortszeit als UTC gespeichert wurde.',
    },
    {
      version: '0.6',
      date: '2026-05-21 15:44 UTC',
      en: '"My Settings" button in the contest picker nav gives access to personal settings (band/mode defaults, QRZ, password, passkeys) without entering a contest.',
      de: '"Meine Einstellungen"-Button im Contest-Auswahl-Nav ermöglicht Zugang zu persönlichen Einstellungen (Band/Modus-Standards, QRZ, Passwort, Passkeys) ohne Contest-Auswahl.',
    },
    {
      version: '0.5',
      date: '2026-05-21 15:41 UTC',
      en: 'Contest owners and admins can now delete a contest from the edit modal. Requires confirmation.',
      de: 'Contest-Besitzer und Admins können einen Contest jetzt direkt aus dem Bearbeitungs-Modal löschen. Bestätigung erforderlich.',
    },
    {
      version: '0.3',
      date: '2026-05-21 15:38 UTC',
      en: 'Fix: chat tab (message list and input field) now displays correctly on iPad and other narrow viewports.',
      de: 'Behoben: Chat-Tab (Nachrichtenliste und Eingabefeld) wird jetzt auf iPad und anderen schmalen Bildschirmen korrekt angezeigt.',
    },
    {
      version: '0.2',
      date: '2026-05-21 15:37 UTC',
      en: 'Serial number padding: contest serial numbers can now be padded to 3 digits (001, 042) — enabled by default. Toggle in contest settings.',
      de: 'Seriennummern-Auffüllung: Contest-Seriennummern können jetzt auf 3 Stellen aufgefüllt werden (001, 042) – standardmäßig aktiviert. Umschalter in den Contest-Einstellungen.',
    },
    {
      version: '0.1',
      date: '2026-05-20 08:07 UTC',
      en: 'Initial release of Noctalum ham radio contest logger.',
      de: 'Erste Veröffentlichung des Noctalum Ham-Radio-Contestloggers.',
    },
  ];

  function renderChangelog() {
    const el = $('changelog-content');
    if (!el) return;
    const lang = (window.I18N && window.I18N.lang && window.I18N.lang()) || 'en';
    el.innerHTML = CHANGELOG.map(entry => `
      <div class="changelog-entry">
        <div class="changelog-version-row">
          <span class="changelog-version">v${escHtml(entry.version)}</span>
          ${entry.date ? `<span class="changelog-date">${escHtml(entry.date)}</span>` : ''}
        </div>
        <div class="changelog-text">${escHtml(lang === 'de' ? entry.de : entry.en)}</div>
      </div>
    `).join('');
  }

  // Populate version badge in both topbars.
  const _ver = 'v' + (CHANGELOG[0] ? CHANGELOG[0].version : '');
  ['app-version-contest', 'app-version-main'].forEach(id => {
    const el = $(id);
    if (el) el.textContent = _ver;
  });

  function parseVer(v) {
    const m = String(v || '').match(/^0\.(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function showWhatsNew(entries, currentVer) {
    const lang = window.I18N ? window.I18N.lang() : 'en';
    const entriesHtml = entries.map(e => `
      <div class="changelog-entry">
        <div class="changelog-version-row">
          <span class="changelog-version">v${escHtml(e.version)}</span>
          ${e.date ? `<span class="changelog-date">${escHtml(e.date)}</span>` : ''}
        </div>
        <div class="changelog-text">${escHtml(lang === 'de' ? e.de : e.en)}</div>
      </div>
    `).join('');
    showModal(`
      <h3>${escHtml(t('whatsNew.title'))}</h3>
      <div style="max-height:380px;overflow-y:auto;margin:12px 0">${entriesHtml}</div>
      <div class="modal-actions">
        <button type="button" class="primary cancel-btn" id="whats-new-ok-btn">${escHtml(t('common.ok'))}</button>
      </div>
    `, null, { wide: true });
    document.getElementById('whats-new-ok-btn').addEventListener('click', () => {
      fetch('/api/me/last-seen-version', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        credentials: 'same-origin',
        body: JSON.stringify({ version: currentVer }),
      });
      me.last_seen_version = currentVer;
    });
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtCall(s) {
    return String(s).replace(/0/g, 'Ø');
  }

  function fmtBand(b) {
    return String(b).replace(/^(\d+)(cm|m)$/, '$1 $2');
  }

  // Format a Date as "YYYY-MM-DDTHH:MM" in the *browser-local* timezone —
  // the shape datetime-local <input> needs. Date.toISOString() returns UTC
  // (with a 'Z' suffix), which is the wrong frame when the operator has
  // chosen FR #29's "local" time-input mode.
  function localDateTimeInputValue(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Apply the user's colour scheme by toggling the .theme-light class on
  // <body>. CSS variables under that selector override the dark defaults
  // (see style.css). Called from the /api/me handler at startup and from
  // the personal-settings save handler after a successful PUT (FR #65).
  function applyTheme(theme) {
    document.body.classList.toggle('theme-light', theme === 'light');
  }

  // Swap the QSO time-tile label between "UTC date & time" and
  // "Local date & time" to match the active time_input_mode (FR #29).
  // Called after a contest is entered and after the personal-settings
  // form persists a mode change.
  function updateQTimeLabel() {
    const lbl = document.querySelector('label[data-qso-field="time"]');
    if (!lbl) return;
    const key = me?.time_input_mode === 'local' ? 'qso.localDateTimeOptional' : 'qso.utcDateTimeOptional';
    lbl.setAttribute('data-i18n', key);
    // Replace just the leading text node (the label caption) — keep any
    // nested elements such as the <input> intact.
    const first = lbl.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) first.nodeValue = t(key);
  }

  function normMode(m) {
    return (m === 'USB' || m === 'LSB') ? 'SSB' : m;
  }

  function fmtRelTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 0) return d.toLocaleDateString(localeForFmt());
    const s = Math.floor(diff / 1000);
    if (s < 60) return t('relTime.justNow');
    const m = Math.floor(s / 60);
    if (m < 60) return t('relTime.mAgo', { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('relTime.hAgo', { n: h });
    const dy = Math.floor(h / 24);
    if (dy < 30) return t('relTime.dAgo', { n: dy });
    return d.toLocaleDateString(localeForFmt());
  }

  // ----- Panel resizers -----
  function initPanelResizers() {
    const outer = document.getElementById('layout-outer');
    if (!outer) return;

    const savedLeft  = localStorage.getItem('panel-left-w');
    const savedRight = localStorage.getItem('panel-right-w');
    if (savedLeft)  outer.style.setProperty('--left-w',  savedLeft  + 'px');
    if (savedRight) outer.style.setProperty('--right-w', savedRight + 'px');

    function makeVResizer(id, getPanel, sign, storageKey) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('pointerdown', e => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
        const startX = e.clientX;
        const startW = getPanel().offsetWidth;
        function onMove(ev) {
          const newW = Math.max(80, Math.min(600, startW + sign * (ev.clientX - startX)));
          outer.style.setProperty(storageKey === 'panel-left-w' ? '--left-w' : '--right-w', newW + 'px');
          localStorage.setItem(storageKey, String(Math.round(newW)));
        }
        function onUp() {
          el.classList.remove('dragging');
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerup', onUp);
        }
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
      });
    }

    makeVResizer('resizer-left',  () => outer.querySelector('.layout-slot[data-slot="left"]'),  1,  'panel-left-w');
    makeVResizer('resizer-right', () => outer.querySelector('.layout-slot[data-slot="right"]'), -1, 'panel-right-w');

    // Horizontal resizer between the two center slots (re-added for the
    // "Rearrange panels" feature — one slot has flex:1, the other has an
    // explicit --center-top-h that this resizer nudges).
    const midEl = document.getElementById('resizer-mid');
    if (midEl) {
      const savedMid = localStorage.getItem('panel-center-top-h');
      if (savedMid) outer.style.setProperty('--center-top-h', savedMid + 'px');
      midEl.addEventListener('pointerdown', e => {
        const centerTop = outer.querySelector('.layout-slot[data-slot="centerTop"]');
        if (!centerTop) return;
        e.preventDefault();
        midEl.setPointerCapture(e.pointerId);
        midEl.classList.add('dragging');
        const startY = e.clientY;
        const startH = centerTop.offsetHeight;
        function onMove(ev) {
          const newH = Math.max(120, Math.min(2000, startH + (ev.clientY - startY)));
          outer.style.setProperty('--center-top-h', newH + 'px');
          localStorage.setItem('panel-center-top-h', String(Math.round(newH)));
        }
        function onUp() {
          midEl.classList.remove('dragging');
          midEl.removeEventListener('pointermove', onMove);
          midEl.removeEventListener('pointerup', onUp);
        }
        midEl.addEventListener('pointermove', onMove);
        midEl.addEventListener('pointerup', onUp);
      });
    }

    function initPanelCollapse(btnId, panelSel, cssVar, storageKey, iconCollapse, iconExpand) {
      const btn = document.getElementById(btnId);
      const panel = outer.querySelector(panelSel);
      if (!btn || !panel) return;
      let collapsed = localStorage.getItem(storageKey + '-collapsed') === '1';

      function apply(animate) {
        if (collapsed) {
          panel.classList.add('panel-collapsed');
          btn.textContent = iconExpand;
          btn.title = t('topbar.expandPanel');
        } else {
          panel.classList.remove('panel-collapsed');
          btn.textContent = iconCollapse;
          btn.title = t('topbar.collapsePanel');
          const saved = localStorage.getItem(storageKey);
          if (saved) outer.style.setProperty(cssVar, saved + 'px');
        }
        if (animate && leafletMap) requestAnimationFrame(() => leafletMap.invalidateSize());
      }

      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', e => {
        e.stopPropagation();
        collapsed = !collapsed;
        localStorage.setItem(storageKey + '-collapsed', collapsed ? '1' : '0');
        apply(true);
      });

      apply(false);
    }

    initPanelCollapse('collapse-left-btn',  '.layout-slot[data-slot="left"]',  '--left-w',  'panel-left-w',  '‹', '›');
    initPanelCollapse('collapse-right-btn', '.layout-slot[data-slot="right"]', '--right-w', 'panel-right-w', '›', '‹');
  }
  initPanelResizers();

  // ----- Undockable panels (New QSO, QSO history) -----
  // Users can pop the New QSO mask and/or the QSO history table into a
  // separate browser window OR a new tab (e.g. to display them on a second
  // monitor, or to switch back and forth via the browser's own tab bar).
  // The panel's DOM node is moved (adopted) into the target document; all
  // event listeners are preserved by the browser during cross-document
  // adoption and the shared JS realm in the opener keeps working with the
  // node via the `$`/`document.getElementById` shims below.
  const _undockedPanels = new Map(); // key -> { win, node, placeholder, pollTimer, mode }

  function _undockConfig(key) {
    if (key === 'entry')   return { selector: '.entry-panel',   titleKey: 'qso.newQSO',           width: 640, height: 720 };
    if (key === 'history') return { selector: '.history-panel', titleKey: 'qso.history',          width: 960, height: 720 };
    if (key === 'left')    return { selector: '.left-panel',    titleKey: 'rearrange.panelLeft',  width: 320, height: 640 };
    if (key === 'ops')     return { selector: '.ops-panel',     titleKey: 'rearrange.panelOps',   width: 400, height: 720 };
    return null;
  }
  function _undockWindowIconHTML() {
    // Arrow escaping from a small window — signals "detach to its own OS window".
    return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4v4"/><path d="M13 3l-5.5 5.5"/><path d="M11 9v3.5H3.5V5H7"/></svg>';
  }
  function _undockTabIconHTML() {
    // Browser-tab silhouette with a plus — signals "open in a new tab of this browser".
    return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h4l1.2-2h6.8v8.5H2z"/><path d="M9.5 8v3.5"/><path d="M7.75 9.75h3.5"/></svg>';
  }
  function _redockIconHTML() {
    return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 13H3V9"/><path d="M3 13l5.5-5.5"/><path d="M5 7V3.5h7.5V11H9"/></svg>';
  }
  function _refreshUndockBtn(key) {
    const info = _undockConfig(key);
    if (!info) return;
    // The panel may currently live in the main doc or in an undocked popup —
    // querySelector is shimmed further down to search both.
    const panel = document.querySelector(info.selector);
    if (!panel) return;
    const btns = panel.querySelectorAll('.panel-undock-btn[data-undock-key="' + key + '"]');
    const undocked = _undockedPanels.has(key);
    btns.forEach(btn => {
      const mode = btn.dataset.undockMode || 'window';
      if (undocked) {
        // Only one of the two buttons stays visible while undocked and it
        // acts as the redock affordance. The `window`-mode button is the
        // one we keep, arbitrarily but consistently.
        if (mode === 'window') {
          btn.style.display = '';
          btn.title = t('topbar.redockPanel');
          btn.setAttribute('aria-label', btn.title);
          btn.innerHTML = _redockIconHTML();
        } else {
          btn.style.display = 'none';
        }
      } else {
        btn.style.display = '';
        const titleKey = mode === 'tab' ? 'topbar.undockPanelTab' : 'topbar.undockPanelWindow';
        btn.title = t(titleKey);
        btn.setAttribute('aria-label', btn.title);
        btn.innerHTML = mode === 'tab' ? _undockTabIconHTML() : _undockWindowIconHTML();
      }
    });
  }
  function _makePlaceholder(key) {
    const info = _undockConfig(key);
    const el = document.createElement('div');
    el.className = 'panel-undocked-placeholder card';
    el.dataset.undockKey = key;
    const msg = document.createElement('div');
    msg.textContent = t('topbar.undockedPlaceholder', { name: t(info.titleKey) });
    msg.dataset.i18nText = 'topbar.undockedPlaceholder';
    msg.dataset.i18nName = info.titleKey;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.textContent = t('topbar.undockedRedockBtn');
    btn.dataset.i18nText = 'topbar.undockedRedockBtn';
    btn.addEventListener('click', () => redockPanel(key));
    el.appendChild(msg);
    el.appendChild(btn);
    return el;
  }
  function _refreshPlaceholderI18n() {
    document.querySelectorAll('.panel-undocked-placeholder [data-i18n-text]').forEach(el => {
      const nameKey = el.dataset.i18nName;
      el.textContent = nameKey
        ? t(el.dataset.i18nText, { name: t(nameKey) })
        : t(el.dataset.i18nText);
    });
  }
  // Adopt the panel identified by `key` into an already-open browser window
  // `win`. Shared by both `undockPanel` (which opens the window itself)
  // and the Rearrange dialog (which pre-opens empty tabs at click time so
  // the operator sees them immediately, then hands them over here on save).
  function _adoptPanelIntoWindow(key, win, mode) {
    if (_undockedPanels.has(key)) return false;
    const info = _undockConfig(key);
    if (!info) return false;
    const node = document.querySelector(info.selector);
    if (!node || !win || win.closed) return false;
    const doc = win.document;
    // Overwrite whatever was in the (possibly-placeholder) doc.
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    doc.close();
    doc.title = t(info.titleKey);
    // Copy stylesheets so the panel keeps its look inside the popup.
    document.querySelectorAll('link[rel="stylesheet"], style').forEach(el => {
      doc.head.appendChild(doc.importNode(el, true));
    });
    doc.body.className = document.body.className;
    doc.body.classList.add('noctalum-undocked-window');
    // Insert a placeholder in the main window so the user can see (and
    // reverse) the change; adopting the panel node into the popup body
    // implicitly detaches it from the main doc.
    const placeholder = _makePlaceholder(key);
    const containingSlot = node.closest('.layout-slot');
    node.parentNode.insertBefore(placeholder, node);
    doc.body.appendChild(node);
    // Slot-level classes: the slot holding the placeholder collapses to
    // natural height; the sibling center slot (if any) grows to fill.
    if (containingSlot) {
      containingSlot.classList.add('slot-has-placeholder');
      const sibling = _siblingCenterSlot(containingSlot);
      if (sibling) sibling.classList.add('slot-fill-remaining');
    }
    // Poll for the popup being closed via the OS window controls, since
    // `pagehide` isn't reliably delivered before the popup vanishes.
    const pollTimer = setInterval(() => {
      if (win.closed) redockPanel(key);
    }, 500);
    try {
      win.addEventListener('beforeunload', () => { redockPanel(key); });
    } catch {}
    _undockedPanels.set(key, { win, node, placeholder, pollTimer, mode, containingSlot });
    _refreshUndockBtn(key);
    try { window.I18N && window.I18N.apply(doc); } catch {}
    // Re-attach inner-panel listeners that some browsers drop during
    // cross-document adoption. addEventListener dedupes identical
    // registrations so this is a no-op on browsers that preserve them.
    if (key === 'ops') { try { wireClusterListeners(); } catch {} }
    return true;
  }
  function undockPanel(key, mode) {
    if (_undockedPanels.has(key)) return;
    const info = _undockConfig(key);
    if (!info) return;
    mode = mode === 'tab' ? 'tab' : 'window';
    // Window features:
    //   'tab'    → empty features → browser routes it to a new tab (in
    //              tab-happy browsers) with full chrome shared from this window.
    //   'window' → width/height only, deliberately NOT `popup=yes`, so the
    //              browser opens a fully-fledged window with address bar,
    //              tab strip, and reload — the operator can drag it to a
    //              second monitor and treat it like any other Noctalum tab.
    const features = mode === 'tab' ? '' : `width=${info.width},height=${info.height}`;
    const win = window.open('', 'noctalum-' + key + '-' + Date.now(), features);
    if (!win) {
      alert(t('topbar.undockPopupBlocked'));
      return;
    }
    _adoptPanelIntoWindow(key, win, mode);
  }
  function redockPanel(key) {
    const info = _undockedPanels.get(key);
    if (!info) return;
    _undockedPanels.delete(key);
    clearInterval(info.pollTimer);
    const { win, node, placeholder, containingSlot } = info;
    if (placeholder && placeholder.parentNode) {
      placeholder.parentNode.insertBefore(node, placeholder);
      placeholder.parentNode.removeChild(placeholder);
    }
    if (containingSlot) {
      containingSlot.classList.remove('slot-has-placeholder');
      const sibling = _siblingCenterSlot(containingSlot);
      if (sibling) sibling.classList.remove('slot-fill-remaining');
    }
    try { if (win && !win.closed) win.close(); } catch {}
    _refreshUndockBtn(key);
    // Same re-wire as on undock — the redock also crosses a document boundary
    // (popup → main), and any listeners dropped in that direction need to be
    // put back before the operator interacts with the panel again.
    if (key === 'ops') { try { wireClusterListeners(); } catch {} }
  }
  function _siblingCenterSlot(slot) {
    if (!slot) return null;
    const which = slot.getAttribute('data-slot');
    if (which === 'centerTop')    return document.querySelector('.layout-slot[data-slot="centerBottom"]');
    if (which === 'centerBottom') return document.querySelector('.layout-slot[data-slot="centerTop"]');
    return null;
  }
  function initUndockButtons() {
    document.querySelectorAll('.panel-undock-btn').forEach(btn => {
      const key = btn.dataset.undockKey;
      if (!key) return;
      _refreshUndockBtn(key);
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        if (_undockedPanels.has(key)) redockPanel(key);
        else undockPanel(key, btn.dataset.undockMode || 'window');
      });
    });
  }
  initUndockButtons();

  // When the main window closes, tear down the popups so the user isn't
  // left with orphan windows whose scripts have died.
  window.addEventListener('pagehide', () => {
    for (const [, info] of _undockedPanels) {
      try { if (info.win && !info.win.closed) info.win.close(); } catch {}
    }
  });

  // ----- Rearrange panels dialog -----
  // Operators can shuffle the four core panels (Pic & Map, New QSO, QSO
  // history, Ops) between the four layout slots (left, center-top,
  // center-bottom, right) and push individual panels into new browser tabs.
  // The dialog is a drag-and-drop editor; hitting Save moves DOM nodes into
  // their new slots, opens browser tabs for panels routed there, and
  // persists the main-slot arrangement in localStorage.
  const REARRANGE_PANELS = [
    { id: 'left',    labelKey: 'rearrange.panelLeft' },
    { id: 'entry',   labelKey: 'rearrange.panelEntry' },
    { id: 'history', labelKey: 'rearrange.panelHistory' },
    { id: 'ops',     labelKey: 'rearrange.panelOps' },
  ];
  const MAIN_SLOTS = ['left', 'centerTop', 'centerBottom', 'right'];
  const DEFAULT_LAYOUT = { left: 'left', centerTop: 'entry', centerBottom: 'history', right: 'ops' };
  const LAYOUT_STORAGE_KEY = 'noctalum.panelLayout';

  let _rearrangeDraft = null;
  let _rearrangeDragSrc = null;

  function _panelNode(panelId) { return document.querySelector('[data-panel-id="' + panelId + '"]'); }
  function _slotNode(slotId)   { return document.querySelector('.layout-slot[data-slot="' + slotId + '"]'); }

  // Derive the layout from the current DOM instead of caching it in a
  // variable — otherwise auto-redocks (poll timer, beforeunload) that
  // move a panel back into a slot without going through applyLayout()
  // leave the cache lying, and the next dialog open shows the panel
  // as "missing" (no chip, no tab slot, save-validator refuses).
  function _currentDOMLayout() {
    const layout = { left: null, centerTop: null, centerBottom: null, right: null };
    REARRANGE_PANELS.forEach(p => {
      const node = _panelNode(p.id);
      if (!node) return;
      const slot = node.closest('.layout-slot');
      if (!slot) return;
      const s = slot.getAttribute('data-slot');
      if (MAIN_SLOTS.includes(s)) layout[s] = p.id;
    });
    return layout;
  }

  function _panelLabel(panelId) {
    const p = REARRANGE_PANELS.find(x => x.id === panelId);
    return p ? t(p.labelKey) : panelId;
  }
  function _getStoredLayout() {
    try {
      const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Validate: every main slot must map to a known panel, and every
      // panel must appear exactly once.
      const values = MAIN_SLOTS.map(s => parsed[s]);
      if (values.some(v => !REARRANGE_PANELS.some(p => p.id === v))) return null;
      if (new Set(values).size !== 4) return null;
      return parsed;
    } catch { return null; }
  }
  function _saveLayoutToStorage(layout) {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)); } catch {}
  }
  // Fold tab-routed panels back into the main-slot layout for persistence.
  // Browser tabs don't survive a reload, so a saved layout with `null`
  // slots wouldn't validate on the way back in — leaving the operator
  // with an unstable / partially-defaulted layout after they refresh.
  // Each tabbed panel goes to its pre-undock slot if free, otherwise its
  // default slot, otherwise the first empty slot.
  function _persistableLayout(mainDraft, tabsDraft) {
    const out = { ...mainDraft };
    (tabsDraft || []).forEach(tab => {
      if (!tab.panelId) return;
      let target = null;
      const info = _undockedPanels.get(tab.panelId);
      if (info && info.containingSlot) {
        const s = info.containingSlot.getAttribute('data-slot');
        if (MAIN_SLOTS.includes(s) && !out[s]) target = s;
      }
      if (!target) {
        const def = Object.keys(DEFAULT_LAYOUT).find(s => DEFAULT_LAYOUT[s] === tab.panelId);
        if (def && !out[def]) target = def;
      }
      if (!target) target = MAIN_SLOTS.find(s => !out[s]);
      if (target) out[target] = tab.panelId;
    });
    return out;
  }
  function applyLayout(layout) {
    // Two-pass move: first detach every panel, then re-attach into its
    // target slot. Doing it in one pass would cause a panel to displace
    // another mid-loop; detaching first sidesteps that.
    const nodes = {};
    REARRANGE_PANELS.forEach(p => { nodes[p.id] = _panelNode(p.id); });
    // Only rearrange panels that are actually in the main DOM (undocked
    // ones live in their popup; leave them alone).
    MAIN_SLOTS.forEach(slotId => {
      const panelId = layout[slotId];
      const node = nodes[panelId];
      if (!node) return;
      // Skip if the panel is currently detached to a popup.
      if (!node.closest('.layout-slot')) return;
      node.parentNode.removeChild(node);
    });
    MAIN_SLOTS.forEach(slotId => {
      const panelId = layout[slotId];
      const node = nodes[panelId];
      const slot = _slotNode(slotId);
      if (!node || !slot) return;
      // If the panel is currently in a popup, applyLayout can't put it
      // in the slot (it isn't in this document). It'll re-enter the
      // default slot when the user redocks.
      if (node.ownerDocument !== document) return;
      slot.appendChild(node);
    });
    // Leaflet caches viewport size — if the map moved to a differently-
    // sized slot, it'd otherwise render at the old dimensions until the
    // next window resize.
    if (typeof leafletMap !== 'undefined' && leafletMap) {
      requestAnimationFrame(() => { try { leafletMap.invalidateSize(); } catch {} });
    }
  }
  function restoreLayoutOnLoad() {
    const stored = _getStoredLayout();
    if (stored) applyLayout(stored);
  }

  function openRearrangeDialog() {
    const root = document.getElementById('rearrange-modal');
    if (!root) return;
    // Layout draft starts from the physical DOM (so any auto-redock
    // between the last save and now is reflected) and is augmented with
    // the pre-undock slot of every currently-undocked panel, so the
    // "starting layout" snapshot below can send a removed tab slot back
    // to where the panel actually came from.
    const layoutDraft = _currentDOMLayout();
    const startingLayout = { ...layoutDraft };
    Array.from(_undockedPanels.entries()).forEach(([panelId, info]) => {
      if (!info.containingSlot) return;
      const s = info.containingSlot.getAttribute('data-slot');
      if (!MAIN_SLOTS.includes(s)) return;
      if (!startingLayout[s]) startingLayout[s] = panelId;
    });
    // Undocked panels show up as existing tab slots (reusing the same
    // window) and are stripped from the main-slot draft — a panel can't
    // be in two places at once.
    const tabsDraft = [];
    Array.from(_undockedPanels.entries()).forEach(([panelId, info]) => {
      MAIN_SLOTS.forEach(s => { if (layoutDraft[s] === panelId) layoutDraft[s] = null; });
      tabsDraft.push({ id: 'tab-existing-' + panelId, panelId, win: info.win, existing: true });
    });
    _rearrangeDraft = { layout: layoutDraft, tabs: tabsDraft, startingLayout };
    _renderRearrangeDialog();
    root.classList.remove('hidden');
  }
  function closeRearrangeDialog(commit) {
    const root = document.getElementById('rearrange-modal');
    if (root) root.classList.add('hidden');
    // On cancel/backdrop-close, close any speculatively-opened empty tabs
    // that never got a panel assigned. Existing (already-undocked) tabs
    // stay open — the operator didn't ask to close them.
    if (!commit && _rearrangeDraft) {
      _rearrangeDraft.tabs.forEach(tab => {
        if (tab.existing) return;
        try { if (tab.win && !tab.win.closed) tab.win.close(); } catch {}
      });
    }
    _rearrangeDraft = null;
    _rearrangeDragSrc = null;
  }
  function _makeRearrangeChip(panelId) {
    const chip = document.createElement('div');
    chip.className = 'rearrange-chip';
    chip.setAttribute('draggable', 'true');
    chip.dataset.panelId = panelId;
    chip.innerHTML = '<span class="rearrange-chip-icon">⣿</span><span>' + escHtml(_panelLabel(panelId)) + '</span>';
    chip.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', panelId);
      chip.classList.add('dragging');
      _rearrangeDragSrc = { panelId };
    });
    chip.addEventListener('dragend', () => {
      chip.classList.remove('dragging');
      _rearrangeDragSrc = null;
    });
    return chip;
  }
  function _makeRearrangeTabSlot(tab) {
    const el = document.createElement('div');
    el.className = 'rearrange-tab-slot';
    el.dataset.tabId = tab.id;
    el.dataset.dropTarget = '1';
    const label = document.createElement('div');
    label.className = 'rearrange-tab-slot-label';
    label.textContent = t('rearrange.tabSlotLabel');
    el.appendChild(label);
    if (tab.panelId) el.appendChild(_makeRearrangeChip(tab.panelId));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'rearrange-tab-remove';
    remove.textContent = '×';
    remove.title = t('common.remove');
    remove.addEventListener('click', () => _removeRearrangeTabSlot(tab.id));
    el.appendChild(remove);
    return el;
  }
  function _renderRearrangeDialog() {
    const root = document.getElementById('rearrange-modal');
    if (!root || !_rearrangeDraft) return;
    MAIN_SLOTS.forEach(slotId => {
      const slotEl = root.querySelector('.rearrange-slot[data-slot="' + slotId + '"]');
      if (!slotEl) return;
      slotEl.innerHTML = '';
      const panelId = _rearrangeDraft.layout[slotId];
      if (panelId) slotEl.appendChild(_makeRearrangeChip(panelId));
    });
    const strip = document.getElementById('rearrange-tabs-strip');
    if (strip) {
      strip.innerHTML = '';
      strip.setAttribute('data-empty-hint', t('rearrange.tabsEmptyHint'));
      _rearrangeDraft.tabs.forEach(tab => strip.appendChild(_makeRearrangeTabSlot(tab)));
    }
  }
  function _removeRearrangeTabSlot(tabId) {
    if (!_rearrangeDraft) return;
    const idx = _rearrangeDraft.tabs.findIndex(t => t.id === tabId);
    if (idx < 0) return;
    const removed = _rearrangeDraft.tabs.splice(idx, 1)[0];
    // Close the browser tab that was speculatively opened for this slot
    // (unless it belonged to a panel that's currently undocked — in that
    // case the tab has real content and the operator's "×" click means
    // "redock, don't kill the tab"; the redock step below will close it).
    try { if (removed.win && !removed.win.closed) removed.win.close(); } catch {}
    // If the removed tab held a panel, put it back into the main slot the
    // panel sat in at the moment the dialog opened. If that slot is
    // already occupied in the draft, the two panels swap.
    if (removed.panelId) {
      const start = _rearrangeDraft.startingLayout || {};
      const origSlot = Object.keys(start).find(s => start[s] === removed.panelId)
        || Object.keys(DEFAULT_LAYOUT).find(s => DEFAULT_LAYOUT[s] === removed.panelId);
      if (origSlot) {
        const displaced = _rearrangeDraft.layout[origSlot];
        _rearrangeDraft.layout[origSlot] = removed.panelId;
        if (displaced && displaced !== removed.panelId) {
          const empty = MAIN_SLOTS.find(s => !_rearrangeDraft.layout[s]);
          if (empty) _rearrangeDraft.layout[empty] = displaced;
          else _rearrangeDraft.tabs.push({ id: 'tab-' + Date.now(), panelId: displaced });
        }
      }
    }
    _renderRearrangeDialog();
  }
  function _handleRearrangeDrop(panelId, targetEl) {
    if (!_rearrangeDraft) return;
    const fromSlot = Object.keys(_rearrangeDraft.layout).find(s => _rearrangeDraft.layout[s] === panelId);
    const fromTab  = _rearrangeDraft.tabs.find(t => t.panelId === panelId);
    const toSlot   = targetEl.dataset.slot;
    const toTabId  = targetEl.dataset.tabId;
    if (toSlot) {
      const occupant = _rearrangeDraft.layout[toSlot];
      if (occupant === panelId) return;
      _rearrangeDraft.layout[toSlot] = panelId;
      if (fromSlot) _rearrangeDraft.layout[fromSlot] = occupant || null;
      if (fromTab)  fromTab.panelId = occupant || null;
    } else if (toTabId) {
      const tab = _rearrangeDraft.tabs.find(t => t.id === toTabId);
      if (!tab) return;
      const occupant = tab.panelId;
      if (occupant === panelId) return;
      tab.panelId = panelId;
      if (fromSlot) _rearrangeDraft.layout[fromSlot] = occupant || null;
      if (fromTab && fromTab !== tab) fromTab.panelId = occupant || null;
    }
    _renderRearrangeDialog();
  }
  function _initRearrangeDropZones() {
    const root = document.getElementById('rearrange-modal');
    if (!root) return;
    root.addEventListener('dragover', e => {
      const target = e.target.closest('[data-drop-target="1"]');
      if (!target) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      root.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      target.classList.add('drag-over');
    });
    root.addEventListener('dragleave', e => {
      const target = e.target && e.target.closest && e.target.closest('[data-drop-target="1"]');
      if (target && !target.contains(e.relatedTarget)) target.classList.remove('drag-over');
    });
    root.addEventListener('drop', e => {
      const target = e.target.closest('[data-drop-target="1"]');
      if (!target || !_rearrangeDragSrc) return;
      e.preventDefault();
      root.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      _handleRearrangeDrop(_rearrangeDragSrc.panelId, target);
      _rearrangeDragSrc = null;
    });
  }
  function _saveRearrangeDialog() {
    if (!_rearrangeDraft) return;
    // Every panel must be either in a main slot or in a browser-tab slot.
    const inTabs = new Set(_rearrangeDraft.tabs.filter(x => x.panelId).map(x => x.panelId));
    const inMain = new Set();
    MAIN_SLOTS.forEach(s => { if (_rearrangeDraft.layout[s]) inMain.add(_rearrangeDraft.layout[s]); });
    const missing = REARRANGE_PANELS.filter(p => !inMain.has(p.id) && !inTabs.has(p.id));
    if (missing.length) {
      alert(t('rearrange.missingPanels', { list: missing.map(p => t(p.labelKey)).join(', ') }));
      return;
    }
    // Redock everything so all panels are available to move. Then apply the
    // new main-slot layout and hand each tab-assigned panel to the tab's
    // pre-opened window (opened at "+ Add tab" click time).
    Array.from(_undockedPanels.keys()).forEach(k => redockPanel(k));
    applyLayout(_rearrangeDraft.layout);
    // Persist a *complete* layout — panels routed to tabs get placed back
    // into their pre-undock or default main slot, so a reload (which
    // doesn't restore tabs) has a valid, full arrangement to apply.
    _saveLayoutToStorage(_persistableLayout(_rearrangeDraft.layout, _rearrangeDraft.tabs));
    _rearrangeDraft.tabs.forEach(tab => {
      if (!tab.panelId) {
        // Empty tab slot — close its speculatively-opened window.
        try { if (tab.win && !tab.win.closed) tab.win.close(); } catch {}
        return;
      }
      // If the pre-opened window is still around, reuse it. Otherwise fall
      // back to opening a fresh tab via undockPanel.
      if (tab.win && !tab.win.closed) {
        _adoptPanelIntoWindow(tab.panelId, tab.win, 'tab');
      } else {
        undockPanel(tab.panelId, 'tab');
      }
    });
    closeRearrangeDialog(true);
  }
  function _resetRearrangeDialog() {
    if (!confirm(t('rearrange.confirmReset'))) return;
    Array.from(_undockedPanels.keys()).forEach(k => redockPanel(k));
    applyLayout({ ...DEFAULT_LAYOUT });
    try { localStorage.removeItem(LAYOUT_STORAGE_KEY); } catch {}
    closeRearrangeDialog();
  }
  function _addRearrangeTabSlot() {
    if (!_rearrangeDraft) return;
    // Open the browser tab immediately (this click is a user gesture, so
    // the popup blocker won't get in the way). The tab starts empty with
    // a small placeholder message; on Save the assigned panel is adopted
    // into the same window via _adoptPanelIntoWindow, which overwrites
    // the placeholder doc. If the operator removes the slot or cancels
    // the dialog, the tab is closed programmatically.
    const win = window.open('', 'noctalum-tab-' + Date.now(), '');
    if (!win) {
      alert(t('topbar.undockPopupBlocked'));
      return;
    }
    _writeEmptyTabPlaceholder(win);
    _rearrangeDraft.tabs.push({ id: 'tab-' + Date.now(), panelId: null, win, existing: false });
    _renderRearrangeDialog();
  }
  function _writeEmptyTabPlaceholder(win) {
    try {
      const doc = win.document;
      doc.open();
      doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      doc.close();
      doc.title = t('rearrange.emptyTabTitle');
      document.querySelectorAll('link[rel="stylesheet"], style').forEach(el => {
        doc.head.appendChild(doc.importNode(el, true));
      });
      doc.body.className = document.body.className;
      doc.body.classList.add('noctalum-undocked-window');
      const hint = doc.createElement('div');
      hint.className = 'noctalum-empty-tab-hint';
      hint.textContent = t('rearrange.emptyTabHint');
      doc.body.appendChild(hint);
    } catch {}
  }
  function initRearrangeButton() {
    const btn = document.getElementById('rearrange-panels-btn');
    if (btn) btn.addEventListener('click', openRearrangeDialog);
    const cancel = document.getElementById('rearrange-cancel-btn');
    if (cancel) cancel.addEventListener('click', closeRearrangeDialog);
    const save = document.getElementById('rearrange-save-btn');
    if (save) save.addEventListener('click', _saveRearrangeDialog);
    const reset = document.getElementById('rearrange-reset-btn');
    if (reset) reset.addEventListener('click', _resetRearrangeDialog);
    const addTab = document.getElementById('rearrange-add-tab-btn');
    if (addTab) addTab.addEventListener('click', _addRearrangeTabSlot);
    _initRearrangeDropZones();
    const modal = document.getElementById('rearrange-modal');
    if (modal) modal.addEventListener('click', e => {
      if (e.target === modal) closeRearrangeDialog();
    });
  }
  initRearrangeButton();
  restoreLayoutOnLoad();

  // Extend element lookups so code that expects the panel in the main doc
  // still finds it after it has been moved into a popup. The override only
  // adds a fallback — same-doc lookups are unchanged.
  (function shimLookupsForUndockedPanels() {
    const origGetById = Document.prototype.getElementById;
    Document.prototype.getElementById = function(id) {
      const el = origGetById.call(this, id);
      if (el || this !== document) return el;
      for (const info of _undockedPanels.values()) {
        if (info.win && !info.win.closed) {
          const found = origGetById.call(info.win.document, id);
          if (found) return found;
        }
      }
      return null;
    };
    const origQS = Document.prototype.querySelector;
    Document.prototype.querySelector = function(sel) {
      const el = origQS.call(this, sel);
      if (el || this !== document) return el;
      for (const info of _undockedPanels.values()) {
        if (info.win && !info.win.closed) {
          try {
            const found = origQS.call(info.win.document, sel);
            if (found) return found;
          } catch {}
        }
      }
      return null;
    };
    const origQSA = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function(sel) {
      const main = origQSA.call(this, sel);
      if (this !== document || _undockedPanels.size === 0) return main;
      const extras = [];
      for (const info of _undockedPanels.values()) {
        if (info.win && !info.win.closed) {
          try {
            const found = origQSA.call(info.win.document, sel);
            for (const n of found) extras.push(n);
          } catch {}
        }
      }
      if (!extras.length) return main;
      // Return a plain array — every caller uses .forEach / iteration /
      // .length / indexed access, all of which arrays support natively.
      return Array.from(main).concat(extras);
    };
  })();

  // Mount language switchers and react to language changes.
  ['lang-switcher-login', 'lang-switcher-setup', 'lang-switcher-contest', 'lang-switcher-topbar']
    .forEach(id => { const el = $(id); if (el && window.I18N) window.I18N.mountSwitcher(el); });
  if (window.I18N) {
    window.I18N.onChange(() => {
      // Re-render anything that builds text in JS.
      try { renderQsos(); } catch {}
      try { renderOperators(); } catch {}
      try { renderRigList(); } catch {}
      try { renderRigSelect(); } catch {}
      try { updateRigStatusPill(); } catch {}
      try { renderClusterSpots(); } catch {}
      try { renderContestPicker(); } catch {}
      try { renderContestsTable(); } catch {}
      try { renderUsers(window.__usersCache || []); } catch {}
      try { renderRoles(); } catch {}
      try { renderAuditLog(); } catch {}
      try { renderSystemLog(); } catch {}
      try { renderFeatureRequests(); } catch {}
      try { updateMsChatMutePill(); } catch {}
      try { updateAuditTZHeader(); } catch {}
      try { updateSysLogTZHeader(); } catch {}
      try { renderStatistics(); } catch {}
      try { renderDownloads(window.__downloadsCache || []); } catch {}
      try { renderGlobalOperators(); } catch {}
      try { updateContestDisplay(); } catch {}
      try { updateFreqLabel(); } catch {}
      try {
        const lo = document.getElementById('layout-outer');
        if (lo) {
          const lb = document.getElementById('collapse-left-btn');
          const rb = document.getElementById('collapse-right-btn');
          if (lb) lb.title = t('topbar.' + (lo.querySelector('.layout-slot[data-slot="left"]')?.classList.contains('panel-collapsed') ? 'expandPanel' : 'collapsePanel'));
          if (rb) rb.title = t('topbar.' + (lo.querySelector('.layout-slot[data-slot="right"]')?.classList.contains('panel-collapsed') ? 'expandPanel' : 'collapsePanel'));
        }
      } catch {}
      // Refresh undock button tooltips and the placeholder card left behind
      // in the main window when a panel is undocked. Also re-run I18N.apply
      // inside each popup doc so its own [data-i18n*] nodes update.
      try {
        _undockedPanels.forEach((info, key) => {
          _refreshUndockBtn(key);
          if (info && info.win && !info.win.closed) {
            info.win.document.title = t(_undockConfig(key).titleKey);
            window.I18N && window.I18N.apply(info.win.document);
          }
        });
        _refreshPlaceholderI18n();
      } catch {}
    });
  }
  // Expose CSRF token to i18n.js so language changes can be persisted.
  try {
    Object.defineProperty(window, '__noctalumCSRF', {
      get() { return csrfToken; },
      configurable: true,
    });
  } catch {}

  // Initial route.
  (async () => {
    // Restore deploy warning ribbon if the page was refreshed during a countdown.
    let _storedDeadline = 0;
    try { _storedDeadline = parseInt(sessionStorage.getItem('noctalum.deployDeadline') || '0', 10); } catch {}
    try { const sid = sessionStorage.getItem('noctalum.deployStartupId'); if (sid) _deployStartupId = sid; } catch {}
    if (_storedDeadline) {
      const _remaining = Math.round((_storedDeadline - Date.now()) / 1000);
      $('deploy-ribbon').classList.remove('hidden');
      document.body.classList.add('deploy-ribbon-active');
      if (_remaining > 0) {
        // Countdown still in progress — show ribbon only (skip re-showing the modal).
        showDeployWarning(_remaining);
        $('deploy-modal').classList.add('hidden');
      } else {
        // Deadline already passed — jump straight to polling.
        _deployWentDown = true; // treat as gone-down so first response triggers reload
        _startDeployPolling();
      }
    }

    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.ok) {
      const j = await res.json();
      if (j.setup_required) { show('setup-screen'); return; }
      me = j;
      csrfToken = j.csrf_token || null;
      if (me.language && window.I18N && me.language !== window.I18N.lang()) {
        window.I18N.setLang(me.language);
      }
      applyTheme(me.theme);
      $('current-op').textContent = me.username + ' / ' + fmtCall(me.callsign);
      $('contest-current-op').textContent = me.username + ' / ' + fmtCall(me.callsign);
      applyPermissionsToUI();
      await loadSettings();
      applyDefaults();
      // If the page was opened from a QR-code deep link
      // (…/#approve=<id>), pop the approver modal now that
      // me / csrfToken are populated.  Fire-and-forget so it
      // does not block navigation into the contest screen.
      maybeShowApproverPrompt().catch(() => {});
      if (!me.contest_id) {
        await showContestScreen();
      } else {
        await enterApp();
      }
      const currentVer = CHANGELOG[0] ? CHANGELOG[0].version : '';
      if (me.last_seen_version === '') {
        // First login — silently record current version, no dialog needed.
        fetch('/api/me/last-seen-version', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          credentials: 'same-origin',
          body: JSON.stringify({ version: currentVer }),
        });
        me.last_seen_version = currentVer;
      } else {
        const newEntries = CHANGELOG.filter(e => parseVer(e.version) > parseVer(me.last_seen_version));
        if (newEntries.length > 0) {
          showWhatsNew(newEntries, currentVer);
        }
      }
    } else if (res.status === 401) {
      show('login-screen');
    } else {
      show('login-screen');
    }
  })();
})();
