// ContestLog frontend
(() => {
  const MODES = ['CW', 'SSB', 'USB', 'LSB', 'FM', 'AM', 'RTTY', 'FT8', 'FT4', 'PSK31', 'PSK63', 'JT65', 'DIGI'];
  const BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm', '23cm', '13cm', '3cm'];

  // ----- DXCC prefix lookup -----
  // Each entry: [prefix, country_name, iso2_or_null, continent]
  // continent: EU NA SA AS AF OC
  // Sorted longest-first at build time for greedy prefix matching.
  const _DXCC = [
    // --- 4-char specials ---
    ['VK9C','Cocos-Keeling Is.',null,'OC'],['VK9L','Lord Howe Is.',null,'OC'],
    ['VK9N','Norfolk Is.','NF','OC'],['VK9W','Willis Is.',null,'OC'],
    ['VK9X','Christmas Is.',null,'OC'],['VK0M','Macquarie Is.',null,'OC'],
    ['VK0H','Heard Is.',null,'AF'],
    // --- 3-char specials ---
    ['KH0','N.Mariana Is.','MP','OC'],['WH0','N.Mariana Is.','MP','OC'],['AH0','N.Mariana Is.','MP','OC'],
    ['KH1','Baker & Howland',null,'OC'],
    ['KH2','Guam','GU','OC'],['WH2','Guam','GU','OC'],
    ['KH3','Johnston Is.',null,'OC'],
    ['KH4','Midway Is.',null,'OC'],
    ['KH5','Palmyra',null,'OC'],
    ['KH6','Hawaii','US','OC'],['WH6','Hawaii','US','OC'],['NH6','Hawaii','US','OC'],['AH6','Hawaii','US','OC'],
    ['KH7','Kure Is.',null,'OC'],
    ['KH8','American Samoa','AS','OC'],['WH8','American Samoa','AS','OC'],
    ['KH9','Wake Is.',null,'OC'],
    ['KL7','Alaska','US','NA'],['WL7','Alaska','US','NA'],['NL7','Alaska','US','NA'],['AL7','Alaska','US','NA'],
    ['KP1','Navassa Is.',null,'NA'],
    ['KP2','US Virgin Is.',null,'NA'],['WP2','US Virgin Is.',null,'NA'],['NP2','US Virgin Is.',null,'NA'],
    ['KP4','Puerto Rico','PR','NA'],['WP4','Puerto Rico','PR','NA'],['NP4','Puerto Rico','PR','NA'],
    ['VP2','Br.Virgin Is.',null,'NA'],
    ['VP5','Turks & Caicos','TC','NA'],
    ['VP9','Bermuda','BM','NA'],
    ['ZD7','St.Helena',null,'AF'],['ZD8','Ascension Is.',null,'AF'],['ZD9','Tristan da Cunha',null,'AF'],
    ['ZL7','Chatham Is.',null,'OC'],['ZL8','Kermadec Is.',null,'OC'],['ZL9','Auckland Is.',null,'OC'],
    ['OH0','Aland Is.','AX','EU'],['OJ0','Market Reef',null,'EU'],
    ['HB0','Liechtenstein','LI','EU'],
    ['CT3','Madeira','PT','AF'],
    ['EA8','Canary Is.','ES','AF'],['EA9','Ceuta/Melilla','ES','EU'],
    ['IS0','Sardinia','IT','EU'],['IT9','Sicily','IT','EU'],['IH9','Pantelleria','IT','EU'],
    ['3D2','Fiji','FJ','OC'],
    ['PJ2','Curacao','CW','NA'],['PJ4','Bonaire','BQ','NA'],
    ['PJ5','Saba',null,'NA'],['PJ7','Sint Maarten','SX','NA'],
    ['FP','St.Pierre-Miquelon',null,'NA'],
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
    // Australia / NZ
    ['VK','Australia','AU','OC'],
    ...['ZL','ZM'].map(p=>[p,'New Zealand','NZ','OC']),
    // Germany
    ...['DA','DB','DC','DD','DE','DF','DG','DH','DJ','DK','DL','DM','DN','DO','DP'].map(p=>[p,'Germany','DE','EU']),
    // Japan
    ...['JA','JE','JF','JG','JH','JI','JJ','JK','JL','JM','JN','JO','JP','JQ','JR','JS'].map(p=>[p,'Japan','JP','AS']),
    ...['7J','7K','7L','7M','7N'].map(p=>[p,'Japan','JP','AS']),
    // China / Taiwan
    ...['BA','BD','BG','BH','BI','BJ','BK','BL','BM','BN','BO','BP','BQ','BR','BS','BT','BY'].map(p=>[p,'China','CN','AS']),
    ['BV','Taiwan','TW','AS'],
    // Korea
    ...['HL','DS','DT','6K','6L','6M','6N'].map(p=>[p,'Korea (South)','KR','AS']),
    ['P5','N.Korea','KP','AS'],
    // France (FG/FM/FY/FO/FH/FR before F)
    ['FG','Guadeloupe','GP','NA'],['FM','Martinique','MQ','NA'],
    ['FY','French Guiana','GF','SA'],['FO','Fr.Polynesia','PF','OC'],
    ['FH','Mayotte','YT','AF'],['FR','Reunion','RE','AF'],
    ['TM','France','FR','EU'],['F','France','FR','EU'],
    // Italy (IS0/IT9 handled above)
    ['I','Italy','IT','EU'],
    // Spain (EA8/EA9 handled above)
    ...['EA','EB','EC','ED','EE','EF','EG','EH'].map(p=>[p,'Spain','ES','EU']),
    // Portugal (CT3 handled above)
    ['CU','Azores','PT','EU'],['CT','Portugal','PT','EU'],['CS','Portugal','PT','EU'],
    // Scandinavia (OH0 handled above)
    ...['OH','OF','OG'].map(p=>[p,'Finland','FI','EU']),
    ...['SM','SK','SL','8S'].map(p=>[p,'Sweden','SE','EU']),
    ...['LA','LB'].map(p=>[p,'Norway','NO','EU']),
    ...['OZ','OV','OU'].map(p=>[p,'Denmark','DK','EU']),
    ['OY','Faroe Is.','FO','EU'],
    ['TF','Iceland','IS','EU'],
    // BeNeLux (PJ* handled above)
    ...['PA','PB','PC','PD','PE','PF','PG','PH','PI'].map(p=>[p,'Netherlands','NL','EU']),
    ['PZ','Suriname','SR','SA'],
    ...['ON','OO','OP','OQ','OR','OS','OT'].map(p=>[p,'Belgium','BE','EU']),
    ['LX','Luxembourg','LU','EU'],
    // Eastern Europe
    ...['SP','SQ','SR','3Z'].map(p=>[p,'Poland','PL','EU']),
    ...['OK','OL'].map(p=>[p,'Czech Rep.','CZ','EU']),
    ['OM','Slovakia','SK','EU'],
    ['OE','Austria','AT','EU'],
    // HB0 handled above
    ...['HB','HE'].map(p=>[p,'Switzerland','CH','EU']),
    ...['HA','HG'].map(p=>[p,'Hungary','HU','EU']),
    ...['YO','YP','YQ','YR'].map(p=>[p,'Romania','RO','EU']),
    ['LZ','Bulgaria','BG','EU'],
    ...['SV','J4'].map(p=>[p,'Greece','GR','EU']),
    ...['TA','TB','TC','YM'].map(p=>[p,'Turkey','TR','AS']),
    // Balkans
    ['9A','Croatia','HR','EU'],['S5','Slovenia','SI','EU'],
    ...['E7','T9'].map(p=>[p,'Bosnia-Herzeg.','BA','EU']),
    ...['YU','YT','YZ'].map(p=>[p,'Serbia','RS','EU']),
    ['4O','Montenegro','ME','EU'],['Z3','N.Macedonia','MK','EU'],
    ['ZA','Albania','AL','EU'],['Z6','Kosovo','XK','EU'],
    // Baltics
    ['ES','Estonia','EE','EU'],['YL','Latvia','LV','EU'],['LY','Lithuania','LT','EU'],
    // Belarus
    ...['EU','EV','EW'].map(p=>[p,'Belarus','BY','EU']),
    // Ukraine
    ...['UR','US','UT','UU','UV','UW','UX','UY','UZ','EM','EN','EO'].map(p=>[p,'Ukraine','UA','EU']),
    // Russia (UA1-UA6 EU, UA8-UA0 AS — we can't easily tell from prefix alone)
    ...['RA','RB','RC','RD','RE','RF','RG','RH','RI','RJ','RK','RL','RM','RN','RO','RP','RQ','RR','RS','RT','RU','RV','RW','RX','RY','RZ'].map(p=>[p,'Russia','RU','EU']),
    ...['UA','UB','UC','UD','UF','UG','UH','UI'].map(p=>[p,'Russia','RU','EU']),
    // Ireland
    ...['EI','EJ'].map(p=>[p,'Ireland','IE','EU']),
    // Small EU
    ['C3','Andorra','AD','EU'],['3A','Monaco','MC','EU'],
    ['T7','San Marino','SM','EU'],['HV','Vatican',null,'EU'],
    ['9H','Malta','MT','EU'],
    // Near East / Asia
    ...['5B','P3'].map(p=>[p,'Cyprus','CY','AS']),
    ...['4X','4Z'].map(p=>[p,'Israel','IL','AS']),
    ...['HZ','7Z'].map(p=>[p,'Saudi Arabia','SA','AS']),
    ['A4','Oman','OM','AS'],['A6','UAE','AE','AS'],['A9','Bahrain','BH','AS'],
    ['9K','Kuwait','KW','AS'],['YI','Iraq','IQ','AS'],
    ['OD','Lebanon','LB','AS'],['YK','Syria','SY','AS'],
    ['JY','Jordan','JO','AS'],['A7','Qatar','QA','AS'],
    ...['EP','EQ'].map(p=>[p,'Iran','IR','AS']),
    ...['4J','4K'].map(p=>[p,'Azerbaijan','AZ','AS']),
    ['UK','Uzbekistan','UZ','AS'],['EY','Tajikistan','TJ','AS'],
    ['EZ','Turkmenistan','TM','AS'],
    ...['UN','UO','UP','UQ'].map(p=>[p,'Kazakhstan','KZ','AS']),
    ['EX','Kyrgyzstan','KG','AS'],
    // South Asia
    ...['VU','AT','AU','AV'].map(p=>[p,'India','IN','AS']),
    ['AP','Pakistan','PK','AS'],['4S','Sri Lanka','LK','AS'],
    ['S2','Bangladesh','BD','AS'],['9N','Nepal','NP','AS'],['A5','Bhutan','BT','AS'],
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
    // USA (all K*/W*/N*/A* after the specials above)
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
    ...['J6','J7','J8'].map(p=>[p,'E.Caribbean',null,'NA']),
    ['V2','Antigua','AG','NA'],['V4','St.Kitts','KN','NA'],['8P','Barbados','BB','NA'],
    // South America
    ...['PY','PP','PQ','PR','PS','PT','PU','PV','PW','PX'].map(p=>[p,'Brazil','BR','SA']),
    ...['LU','AY','LO'].map(p=>[p,'Argentina','AR','SA']),
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
    ['5V','Togo','TG','AF'],['5U','Niger','NE','AF'],['5X','Uganda','UG','AF'],
    ['9G','Ghana','GH','AF'],['9L','Sierra Leone','SL','AF'],
    ['EL','Liberia','LR','AF'],
    ...['6W','6V'].map(p=>[p,'Senegal','SN','AF']),
    ['TU','Ivory Coast','CI','AF'],['TS','Tunisia','TN','AF'],
    ['CN','Morocco','MA','AF'],['7X','Algeria','DZ','AF'],
    ['ST','Sudan','SD','AF'],['ET','Ethiopia','ET','AF'],
    ['6O','Somalia','SO','AF'],['5A','Libya','LY','AF'],
    ['SU','Egypt','EG','AF'],['D2','Angola','AO','AF'],
    ['C5','Gambia','GM','AF'],['D4','Cape Verde','CV','AF'],
    ['3C','Eq.Guinea','GQ','AF'],['V5','Namibia','NA','AF'],
    ['7P','Lesotho','LS','AF'],['A2','Botswana','BW','AF'],
    ['7Q','Malawi','MW','AF'],['C9','Mozambique','MZ','AF'],
    ['9X','Rwanda','RW','AF'],['9U','Burundi','BI','AF'],
    ...['TZ','5O'].map(p=>[p,'Mali','ML','AF']),
    ['5T','Mauritania','MR','AF'],['3B','Mauritius','MU','AF'],
    // Pacific
    ['FK','New Caledonia','NC','OC'],['V7','Marshall Is.','MH','OC'],
    ['V6','Micronesia','FM','OC'],['A3','Tonga','TO','OC'],
    ['5W','Samoa','WS','OC'],['ZK','Tokelau','TK','OC'],
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

  // ----- Leaflet map -----
  let leafletMap = null;
  let qthMarker = null, tgtMarker = null;
  let pathLines = [];

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
  let rigs = [];          // [{name, freq_hz, mode, band, in_use_by, connected, error, helper_count}]
  let settings = null;
  let allRoles = [];
  let allPerms = [];
  let allContests = [];
  let ws = null;
  let wsRetry = 0;
  let nrReserved = false; // true once a serial number has been reserved for the current QSO entry
  let currentTargetLocator = null; // Maidenhead locator of the station being looked up
  let callsignFilter = null; // callsign to narrow QSO history while entering a contact
  let editingQsoId = null; // ID of the QSO being edited, or null for new entry

  function hasPerm(p) {
    if (!me) return false;
    return me.permissions.includes('*') || me.permissions.includes(p);
  }

  function contestIsOpen() {
    return me && me.contest_status === 'open';
  }

  // ----- screens -----
  function show(which) {
    ['setup-screen', 'login-screen', 'contest-screen', 'global-settings-screen', 'app'].forEach(id => $(id).classList.add('hidden'));
    $(which).classList.remove('hidden');
    if (which === 'setup-screen') $('setup-username').focus();
    if (which === 'login-screen') $('login-username').focus();
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
      $('setup-error').textContent = j.error || 'Setup failed';
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
        $('login-error').textContent = `Account locked for ${j.locked_seconds || '?'}s`;
      } else {
        $('login-error').textContent = j.error || 'Login failed';
      }
      return;
    }
    const loginData = await res.json().catch(() => ({}));
    csrfToken = loginData.csrf_token || null;
    await bootstrap();
  });

  $('logout-btn').addEventListener('click', doLogout);
  $('contest-logout-btn').addEventListener('click', doLogout);

  async function doLogout() {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    me = null;
    csrfToken = null;
    if (ws) try { ws.close(); } catch {}
    ws = null;
    show('login-screen');
  }

  // ----- global settings screen -----
  $('global-settings-btn').addEventListener('click', () => showGlobalSettings());
  $('global-settings-back-btn').addEventListener('click', () => showContestScreen());
  $('gs-cluster-log-refresh-btn').addEventListener('click', loadGlobalClusterLog);

  async function showGlobalSettings() {
    show('global-settings-screen');
    $('global-settings-error').textContent = '';
    try {
      const res = await api('/api/settings');
      if (res.ok) {
        const s = await res.json();
        $('gs-cluster-server').value = s.cluster_server || '';
        $('gs-cluster-call').value = s.cluster_call || '';
        $('gs-cluster-retention').value = s.cluster_retention_days || 7;
      }
    } catch {}
    loadGlobalClusterLog();
  }

  async function loadGlobalClusterLog() {
    try {
      const res = await api('/api/cluster/log');
      if (!res.ok) return;
      const data = await res.json();
      $('gs-cluster-log-pre').textContent = (data.lines || []).join('\n');
      const conn = data.connected ? 'Connected' : 'Disconnected';
      const srv = data.server || 'dxc.ve7cc.net:23';
      $('gs-cluster-log-status').textContent = `${conn} · ${srv} · callsign: ${data.call || 'none'}`;
    } catch {}
  }

  $('global-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('global-settings-error').textContent = '';
    const body = {
      cluster_server: $('gs-cluster-server').value.trim(),
      cluster_call: $('gs-cluster-call').value.trim().toUpperCase(),
      cluster_retention_days: parseInt($('gs-cluster-retention').value) || 7,
    };
    const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('global-settings-error').textContent = j.error || 'Save failed';
      return;
    }
    loadGlobalClusterLog();
  });

  // ----- contest selection screen -----
  $('station-pill').addEventListener('click', () => showContestScreen());

  $('create-contest-btn').addEventListener('click', () => contestCreateModal());

  async function showContestScreen() {
    $('contest-pick-error').textContent = '';
    const res = await api('/api/contests');
    if (res.ok) allContests = await res.json();
    renderContestPicker();
    show('contest-screen');
  }

  function renderContestPicker() {
    const list = $('contest-picker-list');
    list.innerHTML = '';
    if (!allContests || allContests.length === 0) {
      list.innerHTML = '<p class="muted" style="text-align:center;padding:20px">No contests yet.</p>';
    } else {
      for (const c of allContests) {
        const item = document.createElement('div');
        item.className = 'contest-picker-item' + (c.status === 'finished' ? ' finished' : '');
        item.innerHTML = `
          <div>
            <div class="contest-picker-call">${escHtml(fmtCall(c.station_call))}</div>
            <div class="contest-picker-name">${escHtml(c.name)}</div>
          </div>
          <span class="contest-picker-status ${c.status}">${c.status}</span>
        `;
        item.addEventListener('click', async () => {
          $('contest-pick-error').textContent = '';
          const r = await api('/api/contests/' + c.id + '/select', { method: 'POST' });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            $('contest-pick-error').textContent = j.error || 'Failed to select contest';
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
          }
          await enterApp();
        });
        list.appendChild(item);
      }
    }
    $('contest-create-section').classList.toggle('hidden', !hasPerm('contests.manage'));
  }

  // ----- enter main app after contest selected -----
  async function enterApp() {
    show('app');
    updateContestDisplay();
    applyContestReadonly();
    qsos = [];
    nrReserved = false;
    editingQsoId = null;
    const [qres, ores, rres] = await Promise.all([
      api('/api/qsos'), api('/api/operators'), api('/api/rigs')
    ]);
    if (qres.ok) qsos = await qres.json();
    if (ores.ok) operators = await ores.json();
    if (rres.ok) rigs = await rres.json();
    renderQsos();
    renderOperators();
    renderRigSelect();
    renderRigList();
    applySelectedRigToForm();
    clearLeftPanel();
    renderBandPills();
    renderObjective();
    // Initialize Leaflet after the container is visible and laid out
    requestAnimationFrame(() => {
      initLeafletMap();
      if (leafletMap) leafletMap.invalidateSize();
      updateMap();
    });
    if (!ws) connectWS();
    $('q-call').focus();
  }

  function updateContestDisplay() {
    const call = me?.contest_call || '—';
    const name = me?.contest_name || '';
    $('station-call').textContent = fmtCall(call);
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

  // ----- tabs -----
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $('tab-' + t.dataset.tab).classList.add('active');
      if (t.dataset.tab === 'log') {
        $('q-call').focus();
        requestAnimationFrame(() => { if (leafletMap) leafletMap.invalidateSize(); });
      }
      if (t.dataset.tab === 'users') refreshUsers();
      if (t.dataset.tab === 'contests') refreshContests();
      if (t.dataset.tab === 'settings') loadPasskeys();
      if (t.dataset.tab === 'audit') refreshAuditLog(true);
      if (t.dataset.tab === 'featurerequests') refreshFeatureRequests();
    });
  });

  // ----- ops panel tabs -----
  document.querySelectorAll('.ops-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.ops-tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.ops-tab-pane').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $('ops-tab-' + t.dataset.opsTab).classList.add('active');
      if (t.dataset.opsTab === 'cluster') loadClusterSpots();
    });
  });

  // ----- DX Cluster -----
  let clusterSpots = [];
  let clusterTimer = null;

  async function loadClusterSpots() {
    $('cluster-status').textContent = 'Loading…';
    try {
      const res = await api('/api/cluster/spots');
      if (!res.ok) {
        $('cluster-status').textContent = 'Cluster unavailable.';
        return;
      }
      const data = await res.json();
      clusterSpots = data.spots || [];
      updateClusterFilters();
      renderClusterSpots();
      const connStr = data.connected ? 'live' : 'connecting…';
      $('cluster-status').textContent = `${clusterSpots.length} spots · ${connStr} · ${new Date().toLocaleTimeString()}`;
    } catch {
      $('cluster-status').textContent = 'Failed to load cluster.';
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

    const bands = [...new Set(clusterSpots.map(s => s.band).filter(Boolean))].sort();
    const modes = [...new Set(clusterSpots.map(s => s.mode).filter(Boolean))].sort();

    bandSel.innerHTML = '<option value="">All bands</option>' +
      bands.map(b => `<option value="${escHtml(b)}"${b === curBand ? ' selected' : ''}>${escHtml(b)}</option>`).join('');
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
    // Discard any in-progress entry (as if Esc was pressed)
    cancelQsoEdit();
    if (spot.dx) {
      $('q-call').value = spot.dx;
      callsignFilter = spot.dx;
      renderQsos();
    }
    if (spot.freq) $('q-freq').value = spot.freq;
    if (spot.band) $('q-band').value = spot.band;
    if (spot.mode && MODES.includes(spot.mode)) $('q-mode').value = spot.mode;
    // Clear stale RST values so the mode-appropriate default takes effect
    $('q-rst-sent').value = '';
    $('q-rst-rcvd').value = '';
    applyRSTDefaults($('q-mode').value);
    updateDuplicateBadge();
    updateCallCountry($('q-call').value.trim().toUpperCase());
    // Reserve a serial number via the server (mutex-protected, no cross-station duplicates).
    // The callsign was set programmatically so the q-call input event never fired.
    if ($('q-call').value.trim()) {
      nrReserved = true;
      try {
        const res = await api('/api/qsos/reserve-nr', { method: 'POST' });
        if (res.ok) {
          const j = await res.json();
          $('q-nr-sent').value = j.nr;
        }
      } catch {}
    }
    // tune the selected rig if one is connected
    if (me?.selected_rig && spot.freq) {
      const freqHz = Math.round(parseFloat(spot.freq) * 1000);
      if (freqHz > 0) {
        api('/api/rigs/set_freq', { method: 'POST', body: JSON.stringify({ freq_hz: freqHz, mode: spot.mode || '' }) })
          .catch(() => {});
      }
    }
    // trigger lookup for pic/locator
    const call = $('q-call').value.trim().toUpperCase();
    if (call.length >= 3) { clearLeftPanel(); triggerQRZLookup(call); }
    // switch to log tab if not already there
    document.querySelector('.tab[data-tab="log"]').click();
    $('q-call').focus();
  }

  $('cluster-refresh-btn').addEventListener('click', loadClusterSpots);
  $('cluster-band-filter').addEventListener('change', renderClusterSpots);
  $('cluster-mode-filter').addEventListener('change', renderClusterSpots);
  $('cluster-spotter-filter').addEventListener('change', renderClusterSpots);

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
    document.querySelectorAll('.tab-perm').forEach(t => {
      if (hasPerm(t.dataset.perm)) t.classList.add('visible');
      else t.classList.remove('visible');
    });
    document.querySelectorAll('.perm-required').forEach(el => {
      if (hasPerm(el.dataset.perm)) el.removeAttribute('data-perm-denied');
      else el.setAttribute('data-perm-denied', '1');
    });
    $('feature-request-btn').classList.toggle('hidden', !hasPerm('feature_requests'));
  }

  // ----- mode/band fillers -----
  function fillSelect(sel, options, def) {
    sel.innerHTML = '';
    for (const v of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      if (v === def) o.selected = true;
      sel.appendChild(o);
    }
  }
  function applyDefaults() {
    fillSelect($('q-mode'), MODES, settings?.default_mode || 'SSB');
    fillSelect($('q-band'), BANDS, settings?.default_band || '20m');
    fillSelect($('s-mode'), MODES, settings?.default_mode || 'SSB');
    fillSelect($('s-band'), BANDS, settings?.default_band || '20m');
    applyRSTDefaults($('q-mode').value);
  }
  function defaultRST(m) {
    if (['SSB','USB','LSB','FM','AM'].includes(m)) return '59';
    if (['CW','RTTY','FT8','FT4','PSK31','PSK63','JT65','JT9','MFSK','OLIVIA','DIGI'].includes(m)) return '599';
    return '';
  }
  function applyRSTDefaults(m) {
    const def = defaultRST(m);
    $('q-rst-sent').placeholder = def;
    $('q-rst-rcvd').placeholder = def;
  }
  $('q-mode').addEventListener('change', () => { applyRSTDefaults($('q-mode').value); updateDuplicateBadge(); });
  $('q-band').addEventListener('change', () => updateDuplicateBadge());

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
      // Fit the entire path in view
      const bounds = L.latLngBounds(pts.map(([a,b]) => [a, b]));
      leafletMap.fitBounds(bounds, { padding: [18, 18], maxZoom: 8 });

      const b = bearingTo(my.lat, my.lon, tgt.lat, tgt.lon);
      $('bearing-value').textContent = Math.round(b) + '° ' + bearingCompass(b);
    } else if (my) {
      leafletMap.setView([my.lat, my.lon], 3);
      $('bearing-value').textContent = '—';
    } else {
      leafletMap.setView([20, 0], 1);
      $('bearing-value').textContent = '—';
    }
    } catch (e) { console.warn('updateMap error:', e); }
  }

  // ----- QRZ lookup -----
  let qrzLookupTimer = null;

  function clearQRZInfo() {
    $('q-name').value = '';
    $('q-loc').value = '';
    clearLeftPanel();
    renderBandPills();
    updateCallCountry('');
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
    if (worked.some(q => q.band === band && q.mode === mode)) {
      badge.className = 'dup-badge dup-duplicate';
      badge.textContent = 'DUPLICATE';
    } else {
      badge.className = 'dup-badge dup-worked';
      badge.textContent = 'WORKED OTHER BAND/MODE';
    }
    renderBandPills();
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

    bar.innerHTML = '';
    for (const band of bands) {
      const pill = document.createElement('span');
      pill.className = 'band-pill';
      pill.textContent = band;

      const isRigBand = band === (rigBand || currentBand);
      const workedOnBand = worked.filter(q => q.band === band);
      const dupOnBand = workedOnBand.some(q => q.mode === currentMode);

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
    try {
      const res = await api('/api/lookup?callsign=' + encodeURIComponent(callsign));
      if (!res.ok) return;
      const j = await res.json();
      if (j.name && !$('q-name').value) $('q-name').value = j.name;
      if (j.locator && !$('q-loc').value) $('q-loc').value = j.locator.toUpperCase();
      const loc = j.locator ? j.locator.toUpperCase() : ($('q-loc').value.trim().toUpperCase() || null);
      updateLeftPanel(callsign, !!j.has_picture, loc);
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
      renderQsos();
    }
    updateDuplicateBadge();
    updateCallCountry(call);
    if (call.length >= 3) {
      qrzLookupTimer = setTimeout(() => triggerQRZLookup(call), 600);
    } else {
      clearQRZInfo();
    }

    if (!nrReserved && contestIsOpen() && call.length > 0) {
      nrReserved = true;
      const res = await api('/api/qsos/reserve-nr', { method: 'POST' });
      if (res.ok) {
        const j = await res.json();
        $('q-nr-sent').value = j.nr;
      }
    }
  });

  function loadQsoIntoForm(q) {
    editingQsoId = q.id;
    $('q-call').value = q.callsign;
    $('q-name').value = q.name || '';
    $('q-nr-rcvd').value = q.nr_received || '';
    $('q-nr-sent').value = q.nr_sent || '';
    $('q-mode').value = q.mode;
    $('q-band').value = q.band;
    $('q-freq').value = q.freq_hz ? (q.freq_hz / 1000).toFixed(2) : '';
    $('q-rst-sent').value = q.rst_sent || '';
    $('q-rst-rcvd').value = q.rst_received || '';
    $('q-dok').value = q.dok || '';
    $('q-loc').value = q.locator || '';
    $('q-itu').value = q.itu_zone || '';
    $('q-cq').value = q.cq_zone || '';
    $('q-lh').value = q.lighthouse || '';
    $('q-notes').value = q.notes || '';
    const t = new Date(q.time);
    $('q-time').value = t.toISOString().substring(0, 19);
    $('log-qso-btn').textContent = 'Save Edit';
    $('entry-panel-title').textContent = 'Edit QSO';
    nrReserved = true;
    callsignFilter = null;
    renderQsos();
    updateDuplicateBadge();
    updateCallCountry(q.callsign);
    currentTargetLocator = q.locator || null;
    updateMap();
    renderBandPills();
    $('q-call').focus();
    $('q-call').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function cancelQsoEdit() {
    editingQsoId = null;
    ['q-call','q-name','q-nr-rcvd','q-nr-sent','q-dok','q-loc','q-itu','q-cq','q-lh','q-notes','q-time'].forEach(id => $(id).value = '');
    clearQRZInfo();
    currentTargetLocator = null;
    nrReserved = false;
    callsignFilter = null;
    updateDuplicateBadge();
    renderQsos();
    $('log-qso-btn').textContent = 'Log QSO';
    $('entry-panel-title').textContent = 'New QSO';
    $('q-call').focus();
    renderBandPills();
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
      nr_sent: parseInt($('q-nr-sent').value || '0', 10) || 0,
      mode: $('q-mode').value,
      band: $('q-band').value,
      freq_hz: Math.round(parseFloat($('q-freq').value || '0') * 1000),
      rst_sent: $('q-rst-sent').value.trim() || $('q-rst-sent').placeholder,
      rst_received: $('q-rst-rcvd').value.trim() || $('q-rst-rcvd').placeholder,
      dok: $('q-dok').value.trim().toUpperCase(),
      locator: $('q-loc').value.trim().toUpperCase(),
      itu_zone: $('q-itu').value.trim(),
      cq_zone: $('q-cq').value.trim(),
      lighthouse: $('q-lh').value.trim(),
      notes: $('q-notes').value.trim(),
    };
    const t = $('q-time').value;
    if (t) body.time = new Date(t + 'Z').toISOString();

    $('qso-error').textContent = '';

    if (editingQsoId !== null) {
      const res = await api('/api/qsos/' + editingQsoId, { method: 'PUT', body: JSON.stringify(body) });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        $('qso-error').textContent = j.error || 'Failed to update QSO';
        return;
      }
      const updated = await res.json();
      const idx = qsos.findIndex(q => q.id === editingQsoId);
      if (idx !== -1) qsos[idx] = updated;
      cancelQsoEdit();
      return;
    }

    let res = await api('/api/qsos', { method: 'POST', body: JSON.stringify(body) });
    if (res.status === 409) {
      if (!confirm('Possible duplicate QSO with this station, band, and mode in the last 10 minutes. Log anyway?')) return;
      res = await api('/api/qsos?force=1', { method: 'POST', body: JSON.stringify(body) });
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('qso-error').textContent = j.error || 'Failed to save QSO';
      return;
    }
    ['q-call','q-name','q-nr-rcvd','q-nr-sent','q-dok','q-loc','q-itu','q-cq','q-lh','q-notes','q-time'].forEach(id => $(id).value = '');
    clearQRZInfo();
    currentTargetLocator = null;
    nrReserved = false;
    callsignFilter = null;
    updateDuplicateBadge();
    renderQsos();
    $('q-call').focus();
  });

  // ----- rig selection / rig list -----
  function applySelectedRigToForm() {
    const r = rigs.find(x => x.name === me?.selected_rig);
    if (r && r.connected) {
      $('q-freq').value = (r.freq_hz / 1000).toFixed(2);
      if (r.band) $('q-band').value = r.band;
    }
  }
  function renderRigSelect() {
    const sel = $('rig-select');
    const cur = me?.selected_rig || '';
    sel.innerHTML = '<option value="">— none (manual entry) —</option>';
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
          ? `${(r.freq_hz/1_000_000).toFixed(4)} MHz · ${r.mode || ''} · ${r.band || ''}`
          : (r.error || 'rig offline'))
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
      li.textContent = 'No helpers connected.';
      li.style.cursor = 'default';
      list.appendChild(li);
      return;
    }
    for (const r of rigs) {
      const li = document.createElement('li');
      if (r.name === me?.selected_rig) li.classList.add('selected');
      const data = r.connected
        ? `${escHtml((r.freq_hz/1_000_000).toFixed(4))} MHz · ${escHtml(r.mode || '-')} · ${escHtml(r.band || '-')}`
        : 'disconnected';
      const inUse = (r.in_use_by || []);
      let useLine = '';
      if (inUse.length) {
        useLine = `<div class="in-use">in use by ${escHtml(inUse.map(fmtCall).join(', '))}</div>`;
      }
      let errLine = (r.error && !r.connected) ? `<div class="rig-err">rigctld: ${escHtml(r.error)}</div>` : '';
      li.innerHTML = `<div class="rig-name">${escHtml(r.name)}</div>
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
    if (!cur) { detail.textContent = 'no rig selected'; return; }
    const r = rigs.find(x => x.name === cur);
    if (!r) { detail.textContent = `${cur} (offline)`; return; }
    if (r.connected) {
      el.classList.add('ok');
      detail.textContent = `${cur} · ${(r.freq_hz/1_000_000).toFixed(4)} MHz`;
    } else {
      el.classList.add('err');
      detail.textContent = `${cur}: ${r.error || 'disconnected'}`;
    }
  }

  // ----- operators panel -----
  function renderOperators() {
    const list = $('ops-list');
    list.innerHTML = '';
    for (const op of operators) {
      const li = document.createElement('li');
      const rigForOp = rigs.find(r => Array.isArray(r.in_use_by) && r.in_use_by.includes(op.callsign));
      li.textContent = fmtCall(op.callsign) + (rigForOp ? ' · ' + rigForOp.name : '');
      if (me && op.callsign === me.callsign) li.classList.add('me');
      list.appendChild(li);
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

  document.querySelectorAll('#qso-table thead th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (qsoSortCol !== col) {
        qsoSortCol = col;
        qsoSortDir = 1;
      } else {
        if (qsoSortDir === 1)       qsoSortDir = -1;
        else if (qsoSortDir === -1) qsoSortDir = 0;
        else                        qsoSortDir = 1;
      }
      updateSortHeaders();
      renderQsos();
    });
  });

  updateSortHeaders();

  function renderQsos(highlightId) {
    const textFilter = $('history-filter').value.trim().toLowerCase();
    const tbody = $('qso-tbody');
    tbody.innerHTML = '';
    let shown = 0;
    const canDelete = hasPerm('qso.write') && contestIsOpen();

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
      if (textFilter) {
        const hay = `${q.callsign} ${q.band} ${q.mode} ${q.operator} ${q.locator} ${q.dok || ''}`.toLowerCase();
        if (!hay.includes(textFilter)) continue;
      }
      const tr = document.createElement('tr');
      if (q.id === highlightId) tr.classList.add('fresh');
      const t = new Date(q.time);
      const utc = t.toISOString().substring(0, 19).replace('T', ' ');
      const mhz = q.freq_hz ? (q.freq_hz / 1_000_000).toFixed(4) : '';
      const zone = (q.itu_zone || q.cq_zone) ? `${escHtml(q.itu_zone || '-')}/${escHtml(q.cq_zone || '-')}` : '';
      const isEditing = q.id === editingQsoId;
      tr.className = isEditing ? 'editing-row' : '';
      tr.style.cursor = 'pointer';
      tr.innerHTML = `
        <td>${q.nr_sent ? escHtml(String(q.nr_sent)) : ''}</td>
        <td>${escHtml(utc)}</td>
        <td><strong>${escHtml(fmtCall(q.callsign))}</strong></td>
        <td>${escHtml(q.band)}</td>
        <td>${escHtml(mhz)}</td>
        <td>${escHtml(q.mode)}</td>
        <td>${escHtml(q.rst_sent)}</td>
        <td>${escHtml(q.rst_received)}</td>
        <td>${escHtml(q.locator || '')}</td>
        <td>${zone}</td>
        <td>${escHtml(fmtCall(q.operator))}</td>
        <td>${canDelete ? `<button class="del-btn" data-id="${Number(q.id)}">✕</button>` : ''}</td>
      `;
      tr.addEventListener('click', (e) => {
        if (e.target.closest('.del-btn')) return;
        if (hasPerm('qso.write') && contestIsOpen()) {
          if (editingQsoId === null) { clearLeftPanel(); triggerQRZLookup(q.callsign); }
          loadQsoIntoForm(q);
        } else {
          showQsoPicture(q.callsign);
        }
      });
      tbody.appendChild(tr);
      shown++;
    }
    const filterParts = [];
    if (csFiltered) filterParts.push(`with ${callsignFilter}`);
    if (textFilter) filterParts.push(`filtered from ${qsos.length}`);
    $('qso-count').textContent = `${shown} QSO${shown===1?'':'s'}` + (filterParts.length ? ` (${filterParts.join(', ')})` : '');
  }
  $('history-filter').addEventListener('input', () => renderQsos());
  $('qso-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('.del-btn');
    if (!btn) return;
    if (!contestIsOpen()) return;
    if (!confirm('Delete this QSO?')) return;
    const id = parseInt(btn.dataset.id, 10);
    const res = await api('/api/qsos/' + id, { method: 'DELETE' });
    if (res.ok) { qsos = qsos.filter(q => q.id !== id); renderQsos(); }
  });

  // ----- settings -----
  async function loadSettings() {
    const res = await api('/api/settings');
    if (!res.ok) return;
    settings = await res.json();
    fillSelect($('s-mode'), MODES, settings.default_mode || 'SSB');
    fillSelect($('s-band'), BANDS, settings.default_band || '20m');
    if ('helper_token' in settings) {
      $('s-token').value = settings.helper_token || '';
      $('hint-token').textContent = settings.helper_token || '...';
    }
    $('hint-server').textContent = location.origin;
    if ('qrz_username' in settings) {
      $('s-qrz-user').value = settings.qrz_username || '';
      $('qrz-status').textContent = settings.qrz_configured
        ? 'QRZ.com lookup is configured.'
        : 'QRZ.com lookup is not configured.';
    }
  }
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('settings-error').textContent = '';
    const body = {
      default_mode: $('s-mode').value,
      default_band: $('s-band').value,
      qrz_username: $('s-qrz-user')?.value?.trim() || '',
      qrz_password: $('s-qrz-pass')?.value || '',
    };
    const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('settings-error').textContent = j.error || 'Save failed';
      return;
    }
    if ($('s-qrz-pass')) $('s-qrz-pass').value = '';
    await loadSettings();
    applyDefaults();
  });
  $('qrz-test-btn').addEventListener('click', async () => {
    const username = $('s-qrz-user').value.trim();
    const password = $('s-qrz-pass').value;
    if (!username) {
      $('qrz-status').textContent = 'Enter a username first.';
      $('qrz-status').style.color = 'var(--error)';
      return;
    }
    $('qrz-test-btn').disabled = true;
    $('qrz-status').textContent = 'Testing…';
    $('qrz-status').style.color = '';
    const res = await api('/api/qrz/test', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    $('qrz-test-btn').disabled = false;
    const j = await res.json().catch(() => ({}));
    if (j.ok) {
      $('qrz-status').textContent = `Connected — W1AW: ${j.name || '(no name)'}`;
      $('qrz-status').style.color = 'var(--success)';
    } else {
      $('qrz-status').textContent = 'Failed: ' + (j.error || 'unknown error');
      $('qrz-status').style.color = 'var(--error)';
    }
  });
  $('regen-token').addEventListener('click', async () => {
    if (!confirm('Generate a new helper token?  All existing helpers will need to be restarted with the new value.')) return;
    const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify({
      default_mode: $('s-mode').value,
      default_band: $('s-band').value,
      regen_helper_token: true,
    })});
    if (res.ok) {
      const j = await res.json();
      if (j.helper_token) {
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
      $('op-error').textContent = j.error || 'Change failed';
      return;
    }
    $('op-old').value = ''; $('op-new').value = '';
    $('op-error').textContent = 'Password changed.';
    $('op-error').style.color = 'var(--success)';
  });

  // ----- contests tab -----
  $('new-contest-btn').addEventListener('click', () => contestCreateModal());

  async function refreshContests() {
    if (!hasPerm('contests.manage')) return;
    const res = await api('/api/contests');
    if (!res.ok) return;
    allContests = await res.json();
    renderContestsTable();
  }

  function renderContestsTable() {
    const tbody = $('contests-tbody');
    tbody.innerHTML = '';
    for (const c of allContests) {
      const tr = document.createElement('tr');
      const date = c.created_at ? new Date(c.created_at).toLocaleDateString() : '';
      tr.innerHTML = `
        <td>${escHtml(c.name)}</td>
        <td style="color:var(--accent);font-weight:600">${escHtml(fmtCall(c.station_call))}</td>
        <td class="muted">${escHtml(c.qth || '—')}</td>
        <td><span class="badge ${c.status}">${escHtml(c.status)}</span></td>
        <td class="muted">${date}</td>
        <td class="actions">
          <button class="ghost" data-action="edit" data-id="${Number(c.id)}">Edit</button>
          <button class="ghost" data-action="toggle" data-id="${Number(c.id)}"
            data-status="${escHtml(c.status)}">${c.status === 'open' ? 'Finish' : 'Reopen'}</button>
        </td>
      `;
      tr.querySelectorAll('button').forEach(b => b.addEventListener('click', () => contestAction(c, b.dataset.action)));
      tbody.appendChild(tr);
    }
  }

  function contestAction(c, action) {
    if (action === 'edit') {
      contestEditModal(c);
    } else if (action === 'toggle') {
      const newStatus = c.status === 'open' ? 'finished' : 'open';
      const label = newStatus === 'finished' ? 'Mark this contest as finished (read-only)?' : 'Reopen this contest?';
      if (!confirm(label)) return;
      api('/api/contests/' + c.id, {
        method: 'PUT',
        body: JSON.stringify({ name: c.name, station_call: c.station_call, qth: c.qth || '', status: newStatus }),
      }).then(r => { if (r.ok) refreshContests(); });
    }
  }

  function buildBandSelectHTML(selectedBands) {
    return `<label>Active bands</label>
      <div class="band-select-grid" id="modal-band-grid">
        ${BANDS.map(b => `<span class="band-select-pill${selectedBands.includes(b) ? ' selected' : ''}" data-band="${escHtml(b)}">${escHtml(b)}</span>`).join('')}
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

  function contestCreateModal() {
    showModal(`
      <h3>New Contest</h3>
      <form>
        <label>Contest name</label>
        <input name="name" placeholder="e.g. CQ-WW-DX-CW 2025" required />
        <label>Station callsign</label>
        <input name="station_call" autocapitalize="characters" placeholder="e.g. DK0XYZ" required />
        <label>QTH locator (optional)</label>
        <input name="qth" placeholder="e.g. JO50de" maxlength="6" autocapitalize="characters" style="text-transform:uppercase" />
        ${buildBandSelectHTML([])}
        <label style="margin-top:10px">Objective <span class="muted small">(Markdown, optional)</span></label>
        <div class="md-editor-wrap">
          <textarea name="objective" placeholder="Describe the contest objective…"></textarea>
          <div class="md-preview-pane objective-content" id="modal-md-preview"></div>
        </div>
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">Cancel</button>
          <button type="submit" class="primary">Create</button>
        </div>
      </form>
    `, async (form) => {
      const res = await api('/api/contests', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.value.trim(),
          station_call: form.station_call.value.trim().toUpperCase(),
          qth: form.qth.value.trim().toUpperCase(),
          bands: selectedBandsFromModal(),
          objective: form.objective.value,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to create contest');
      }
      await refreshContests();
      // Also refresh the picker list if we're on contest-screen
      if (!$('contest-screen').classList.contains('hidden')) {
        const r = await api('/api/contests');
        if (r.ok) allContests = await r.json();
        renderContestPicker();
      }
    });
    attachBandSelectListeners();
    const taC = document.querySelector('#modal-card textarea[name=objective]');
    const previewC = $('modal-md-preview');
    if (taC && previewC) {
      taC.addEventListener('input', () => { previewC.innerHTML = renderMarkdown(taC.value); });
    }
  }

  function contestEditModal(c) {
    showModal(`
      <h3>Edit Contest</h3>
      <form>
        <label>Contest name</label>
        <input name="name" value="${escHtml(c.name)}" required />
        <label>Station callsign</label>
        <input name="station_call" value="${escHtml(c.station_call)}" autocapitalize="characters" required />
        <label>QTH locator (optional)</label>
        <input name="qth" value="${escHtml(c.qth || '')}" placeholder="e.g. JO50de" maxlength="6" autocapitalize="characters" style="text-transform:uppercase" />
        ${buildBandSelectHTML(c.bands || [])}
        <label style="margin-top:10px">Objective <span class="muted small">(Markdown)</span></label>
        <div class="md-editor-wrap">
          <textarea name="objective" placeholder="Describe the contest objective…">${escHtml(c.objective || '')}</textarea>
          <div class="md-preview-pane objective-content" id="modal-md-preview"></div>
        </div>
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">Cancel</button>
          <button type="submit" class="primary">Save</button>
        </div>
      </form>
    `, async (form) => {
      const res = await api('/api/contests/' + c.id, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name.value.trim(),
          station_call: form.station_call.value.trim().toUpperCase(),
          qth: form.qth.value.trim().toUpperCase(),
          status: c.status,
          bands: selectedBandsFromModal(),
          objective: form.objective.value,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to update contest');
      }
      await refreshContests();
    });
    attachBandSelectListeners();
    // Live markdown preview
    const ta = document.querySelector('#modal-card textarea[name=objective]');
    const preview = $('modal-md-preview');
    if (ta && preview) {
      const updatePreview = () => { preview.innerHTML = renderMarkdown(ta.value); };
      updatePreview();
      ta.addEventListener('input', updatePreview);
    }
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
    const tbody = $('users-tbody');
    tbody.innerHTML = '';
    for (const u of users) {
      const tr = document.createElement('tr');
      const roles = (u.roles || []).map(r =>
        `<span class="badge ${r === 'admin' ? 'admin' : ''}">${escHtml(r)}</span>`).join('');
      const status = [];
      if (u.disabled) status.push('<span class="badge disabled">disabled</span>');
      if (u.locked_until && new Date(u.locked_until) > new Date()) {
        status.push(`<span class="badge locked">locked (${Number(u.failed_attempts)} fails)</span>`);
      }
      if (!status.length) status.push('<span class="muted">active</span>');
      tr.innerHTML = `
        <td>${escHtml(u.username)}</td>
        <td>${escHtml(fmtCall(u.callsign))}</td>
        <td>${roles}</td>
        <td>${status.join(' ')}</td>
        <td class="actions">
          <button class="ghost" data-action="edit" data-id="${Number(u.id)}">Edit</button>
          <button class="ghost" data-action="password" data-id="${Number(u.id)}">Reset password</button>
          <button class="ghost" data-action="unlock" data-id="${Number(u.id)}">Unlock</button>
          <button class="ghost" data-action="toggle" data-id="${Number(u.id)}" data-disabled="${u.disabled ? '1' : ''}">${u.disabled ? 'Enable' : 'Disable'}</button>
          <button class="ghost" data-action="delete" data-id="${Number(u.id)}">Delete</button>
        </td>
      `;
      tr.querySelectorAll('button').forEach(b => b.addEventListener('click', () => userAction(u, b.dataset.action)));
      tbody.appendChild(tr);
    }
  }
  function renderRoles() {
    const root = $('roles-list');
    root.innerHTML = '';
    for (const r of allRoles) {
      const card = document.createElement('div');
      card.className = 'role-card';
      const perms = (r.permissions || []).map(p =>
        `<span class="perm-chip">${p === '*' ? 'all permissions' : escHtml(p)}</span>`).join('');
      card.innerHTML = `
        <div class="role-head">
          <div>
            <span class="role-name">${escHtml(r.name)}</span>
            ${r.is_builtin ? '<span class="badge">built-in</span>' : ''}
          </div>
          <div>
            ${r.name === 'admin' ? '' : `<button class="ghost" data-action="edit-role" data-id="${Number(r.id)}">Edit perms</button>`}
            ${r.is_builtin ? '' : `<button class="ghost" data-action="del-role" data-id="${Number(r.id)}">Delete</button>`}
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

  function userAction(u, action) {
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
        if (confirm(`Delete user ${u.username}?`)) {
          api('/api/users/' + u.id, { method: 'DELETE' }).then(refreshUsers);
        }
        return;
    }
  }

  function roleAction(r, action) {
    switch (action) {
      case 'edit-role': roleModal(r); return;
      case 'del-role':
        if (confirm(`Delete role ${r.name}?`)) {
          api('/api/roles/' + r.id, { method: 'DELETE' }).then(refreshUsers);
        }
        return;
    }
  }

  // ----- modals -----
  function showModal(html, onSubmit) {
    const root = $('modal-root');
    const card = $('modal-card');
    card.innerHTML = html;
    root.classList.remove('hidden');
    const form = card.querySelector('form');
    const close = () => root.classList.add('hidden');
    card.querySelector('.cancel-btn')?.addEventListener('click', close);
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
  }

  function userModal(u) {
    const isNew = u === null;
    const roleOptions = allRoles.map(r =>
      `<label><input type="checkbox" value="${escHtml(r.name)}" ${(!isNew && u.roles?.includes(r.name)) || (isNew && r.name === 'user') ? 'checked' : ''}/> ${escHtml(r.name)}</label>`
    ).join('');
    showModal(`
      <h3>${isNew ? 'New user' : 'Edit user: ' + escHtml(u.username)}</h3>
      <form>
        ${isNew ? `<label>Username</label><input name="username" required />
          <label>Password (min 8)</label><input type="password" name="password" minlength="8" required />` : ''}
        <label>Callsign</label>
        <input name="callsign" value="${isNew ? '' : escHtml(u.callsign)}" required />
        <label>Roles</label>
        <div class="perm-grid">${roleOptions}</div>
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">Cancel</button>
          <button type="submit" class="primary">Save</button>
        </div>
      </form>
    `, async (form) => {
      const roles = Array.from(form.querySelectorAll('input[type=checkbox]:checked')).map(i => i.value);
      const callsign = form.callsign.value.trim().toUpperCase();
      let res;
      if (isNew) {
        res = await api('/api/users', { method: 'POST', body: JSON.stringify({
          username: form.username.value.trim(),
          password: form.password.value,
          callsign, roles,
        })});
      } else {
        res = await api('/api/users/' + u.id, { method: 'PUT', body: JSON.stringify({ callsign, roles })});
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'failed');
      }
      refreshUsers();
    });
  }

  function passwordModal(u) {
    showModal(`
      <h3>Reset password for ${escHtml(u.username)}</h3>
      <form>
        <label>New password (min 8)</label>
        <input type="password" name="password" minlength="8" required />
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">Cancel</button>
          <button type="submit" class="primary">Set password</button>
        </div>
      </form>
    `, async (form) => {
      const res = await api('/api/users/' + u.id + '/password', {
        method: 'POST',
        body: JSON.stringify({ Password: form.password.value }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'failed');
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
      <h3>${isNew ? 'New role' : 'Edit role: ' + escHtml(r.name)}</h3>
      <form>
        ${isNew ? '<label>Name</label><input name="name" required />' : ''}
        ${isAdmin ? '<p class="muted small">The admin role has all permissions and cannot be modified.</p>' : ''}
        <label>Permissions</label>
        <div class="perm-grid">${checks}</div>
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">Cancel</button>
          <button type="submit" class="primary" ${isAdmin ? 'disabled' : ''}>Save</button>
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
        throw new Error(j.error || 'failed');
      }
      refreshUsers();
    });
  }

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
          }
          break;
        case 'qso_updated': {
          const idx = qsos.findIndex(q => q.id === msg.payload.id);
          if (idx !== -1) qsos[idx] = msg.payload;
          renderQsos();
          updateDuplicateBadge();
          break;
        }
        case 'qso_deleted':
          qsos = qsos.filter(q => q.id !== msg.payload.id);
          renderQsos();
          updateDuplicateBadge();
          break;

        case 'operators':
          operators = msg.payload || [];
          renderOperators();
          break;
        case 'rigs':
          rigs = msg.payload || [];
          renderRigSelect();
          renderRigList();
          renderOperators();
          applySelectedRigToForm();
          renderBandPills();
          break;
        case 'contest_updated':
          if (me && msg.payload.id === me.contest_id) {
            me.contest_status = msg.payload.status;
            me.contest_call = msg.payload.station_call;
            me.contest_name = msg.payload.name;
            if ('qth' in msg.payload) me.contest_qth = msg.payload.qth;
            if ('bands' in msg.payload) me.contest_bands = (msg.payload.bands || []).join(',');
            if ('objective' in msg.payload) me.contest_objective = msg.payload.objective;
            updateContestDisplay();
            applyContestReadonly();
            updateMap();
            renderBandPills();
            renderObjective();
          }
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
    $('current-op').textContent = me.username + ' / ' + fmtCall(me.callsign);
    return true;
  }

  async function bootstrap() {
    const ok = await refreshMe();
    if (!ok) return;
    applyPermissionsToUI();
    await loadSettings();
    applyDefaults();
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
      $('passkey-login-error').textContent = 'Passkeys require a secure connection (HTTPS or localhost).';
      return;
    }
    try {
      const beginRes = await fetch('/api/passkey/login/begin', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!beginRes.ok) {
        const j = await beginRes.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to start passkey login');
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
        throw new Error(j.error || 'Passkey login failed');
      }
      await bootstrap();
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        $('passkey-login-error').textContent = err.message || 'Passkey login failed';
      }
    }
  });

  // ----- passkey management -----
  async function loadPasskeys() {
    const el = $('passkey-list');
    const res = await api('/api/passkey/credentials');
    if (!res.ok) return;
    const list = await res.json();
    if (!list || list.length === 0) {
      el.innerHTML = '<p class="muted small">No passkeys registered yet.</p>';
      return;
    }
    el.innerHTML = list.map(pk => {
      const date = pk.created_at ? new Date(pk.created_at).toLocaleDateString() : '';
      return `<div class="passkey-item">
        <span class="passkey-name">&#128273; ${escHtml(pk.name || 'Passkey')}</span>
        <span class="muted small">${date}</span>
        <button class="ghost small" data-delete-passkey="${escHtml(pk.id)}">Remove</button>
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
      $('passkey-error').textContent = 'Passkeys require a secure connection (HTTPS or localhost).';
      return;
    }
    const name = encodeURIComponent($('passkey-name').value.trim() || 'Passkey');
    try {
      const beginRes = await api('/api/passkey/register/begin', { method: 'POST' });
      if (!beginRes.ok) {
        const j = await beginRes.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to start passkey registration');
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
        throw new Error(j.error || 'Passkey registration failed');
      }
      $('passkey-name').value = '';
      await loadPasskeys();
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        $('passkey-error').textContent = err.message || 'Registration failed';
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

  function auditFilterParams(offset) {
    const params = new URLSearchParams();
    const level = $('audit-level').value;
    const action = $('audit-action').value;
    const search = $('audit-search').value.trim();
    const since = $('audit-since').value;
    const until = $('audit-until').value;
    if (level) params.set('level', level);
    if (action) params.set('action', action);
    if (search) params.set('search', search);
    if (since) params.set('since', new Date(since).toISOString());
    if (until) params.set('until', new Date(until).toISOString());
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
      const ts = new Date(e.timestamp);
      const utc = ts.toISOString().substring(0, 19).replace('T', ' ');
      tr.innerHTML = `
        <td class="mono">${escHtml(utc)}</td>
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
    $('audit-status').textContent = `Showing ${shown} of ${auditTotal} entries`;
    const moreBtn = $('audit-load-more');
    if (shown < auditTotal) {
      moreBtn.classList.remove('hidden');
      moreBtn.textContent = `Load more (${auditTotal - shown} remaining)`;
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

  // ----- feature requests -----
  let featureRequests = [];

  $('feature-request-btn').addEventListener('click', () => featureRequestSubmitModal());

  function featureRequestSubmitModal() {
    showModal(`
      <h3>Feature Request</h3>
      <form>
        <label>From</label>
        <input name="from" value="${escHtml(me?.username || '')}" readonly style="opacity:0.6;cursor:not-allowed" />
        <label>Request</label>
        <textarea name="text" rows="5" required style="width:100%;resize:vertical;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:inherit;font:inherit"></textarea>
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">Cancel</button>
          <button type="submit" class="primary">Send</button>
        </div>
      </form>
    `, async (form) => {
      const text = form.text.value.trim();
      if (!text) throw new Error('Please enter your request.');
      const res = await api('/api/feature-requests', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to submit');
      }
    });
  }

  async function refreshFeatureRequests() {
    if (!hasPerm('feature_requests')) return;
    const res = await api('/api/feature-requests');
    if (!res.ok) return;
    featureRequests = await res.json();
    renderFeatureRequests();
  }

  function renderFeatureRequests() {
    const tbody = $('fr-tbody');
    tbody.innerHTML = '';
    $('fr-select-all').checked = false;
    for (const fr of featureRequests) {
      const tr = document.createElement('tr');
      const date = fr.created_at ? new Date(fr.created_at).toLocaleString() : '';
      const statusClass = { pending: 'open', accepted: 'admin', declined: 'disabled', implemented: 'finished' }[fr.status] || '';
      tr.innerHTML = `
        <td><input type="checkbox" class="fr-check" data-id="${Number(fr.id)}" /></td>
        <td>${escHtml(fr.from)}</td>
        <td class="muted small">${escHtml(date)}</td>
        <td><span class="badge ${statusClass}">${escHtml(fr.status)}</span></td>
        <td style="white-space:pre-wrap;max-width:480px">${escHtml(fr.text)}</td>
        <td class="actions" style="white-space:nowrap">
          <select class="fr-status-sel ghost" data-id="${Number(fr.id)}" style="font-size:12px;padding:2px 6px;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:4px;color:inherit">
            <option value="pending" ${fr.status==='pending'?'selected':''}>Pending</option>
            <option value="accepted" ${fr.status==='accepted'?'selected':''}>Accepted</option>
            <option value="declined" ${fr.status==='declined'?'selected':''}>Declined</option>
            <option value="implemented" ${fr.status==='implemented'?'selected':''}>Implemented</option>
          </select>
          <button class="ghost fr-del-btn" data-id="${Number(fr.id)}">Delete</button>
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
    tbody.querySelectorAll('.fr-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this feature request?')) return;
        const id = Number(btn.dataset.id);
        const res = await api('/api/feature-requests/' + id, { method: 'DELETE' });
        if (res.ok) refreshFeatureRequests();
      });
    });
    $('fr-count').textContent = featureRequests.length + ' request' + (featureRequests.length !== 1 ? 's' : '');
  }

  $('fr-select-all').addEventListener('change', (e) => {
    document.querySelectorAll('.fr-check').forEach(cb => { cb.checked = e.target.checked; });
  });

  $('fr-export-btn').addEventListener('click', () => {
    const selected = Array.from(document.querySelectorAll('.fr-check:checked')).map(cb => Number(cb.dataset.id));
    const items = featureRequests.filter(fr => selected.includes(Number(fr.id)));
    if (!items.length) { alert('Select at least one request to export.'); return; }
    const body = 'The following changes are requested for this application: \n\n' +
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
    if (!selected.length) { alert('Select at least one request to delete.'); return; }
    if (!confirm(`Delete ${selected.length} selected request(s)?`)) return;
    await Promise.all(selected.map(id => api('/api/feature-requests/' + id, { method: 'DELETE' })));
    refreshFeatureRequests();
  });

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtCall(s) {
    return String(s).replace(/0/g, 'Ø');
  }

  // Initial route.
  (async () => {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.ok) {
      const j = await res.json();
      if (j.setup_required) { show('setup-screen'); return; }
      me = j;
      csrfToken = j.csrf_token || null;
      $('current-op').textContent = me.username + ' / ' + fmtCall(me.callsign);
      applyPermissionsToUI();
      await loadSettings();
      applyDefaults();
      if (!me.contest_id) {
        await showContestScreen();
      } else {
        await enterApp();
      }
    } else if (res.status === 401) {
      show('login-screen');
    } else {
      show('login-screen');
    }
  })();
})();
