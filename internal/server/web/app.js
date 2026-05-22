// Noctalum frontend
(() => {
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

  // ----- screens -----
  function show(which) {
    ['setup-screen', 'login-screen', 'contest-screen', 'global-settings-screen',
     'contests-admin-screen', 'users-admin-screen', 'audit-admin-screen', 'featurerequests-admin-screen',
     'my-featurerequests-screen', 'my-settings-screen', 'changelog-screen', 'dok-cache-screen', 'app'].forEach(id => $(id).classList.add('hidden'));
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
  $('featurerequests-admin-btn').addEventListener('click', () => { if (!hasPerm('feature_requests.read')) return; showAdminScreen('featurerequests-admin-screen', refreshFeatureRequests); });

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
  $('gs-cluster-log-refresh-btn').addEventListener('click', loadGlobalClusterLog);

  async function showGlobalSettings() {
    show('global-settings-screen');
    $('global-settings-error').textContent = '';
    let currentSound = '';
    try {
      const res = await api('/api/settings');
      if (res.ok) {
        const s = await res.json();
        $('gs-cluster-server').value = s.cluster_server || '';
        $('gs-cluster-call').value = s.cluster_call || '';
        $('gs-cluster-retention').value = s.cluster_retention_days || 7;
        currentSound = s.chat_sound || '';
        if ('qrz_username' in s) {
          $('gs-qrz-user').value = s.qrz_username || '';
          $('gs-qrz-status').textContent = s.qrz_configured ? t('settings.qrzConfigured') : t('settings.qrzNotConfigured');
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
      qrz_username: $('gs-qrz-user').value.trim(),
      qrz_password: $('gs-qrz-pass').value,
    };
    const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('global-settings-error').textContent = j.error || t('common.saveFailed');
      return;
    }
    $('gs-qrz-pass').value = '';
    loadGlobalClusterLog();
    if (settings) settings.chat_sound = body.chat_sound;
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

    // Group files by type and platform
    const grouped = {};
    for (const f of files) {
      const m = f.match(/^noctalum-(helper-gui|helper|wsjtx)-(.+?)(?:\.AppImage|\.exe)?$/);
      if (!m) continue;
      const [, type, platform] = m;
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push({ file: f, platform, isAppImage: f.endsWith('.AppImage') });
    }

    const osIcons = OS_SVGS;
    const osLabels = { windows: t('downloads.osWindows'), mac: t('downloads.osMac'), linux: t('downloads.osLinux') };

    let appsHtml = '';

    for (const app of APP_DEFS) {
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
    const editBtn = canEditThis
      ? `<button class="contest-edit-pill" title="Edit contest" tabindex="-1">&#128295;</button>`
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
        ${editBtn}
      </div>
    `;
    if (canEditThis) {
      item.querySelector('.contest-edit-pill:not(.contest-access-pill)')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        contestEditModal(c);
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
      me.contest_owner_user_id = j.contest_owner_user_id || 0;
      me.contest_nr_padded = j.contest_nr_padded !== false;
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
    const editBtn = canEditThis
      ? `<button class="contest-edit-pill" title="${escHtml(t('contestScreen.editTitle'))}" tabindex="-1">&#128295;</button>` : '';
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
      <div class="cl-col cl-actions">${joinBtn}${accessBtn}${editBtn}</div>
    `;
    if (canEditThis) {
      row.querySelector('.contest-edit-pill:not(.contest-access-pill)')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        contestEditModal(c);
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
    });
  });

  // ----- statistics -----
  function _statsEscape(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function _statsSvgBars(items, color) {
    if (!items.length) return '<div class="muted small">' + escHtml(t('stats.noDataShort')) + '</div>';
    const max = Math.max(...items.map(i => i.value)) || 1;
    const rowH = 18, gap = 4, padL = 90, padR = 40;
    const w = 320, h = items.length * (rowH + gap) + 8;
    let svg = `<svg class="stats-svg" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;
    items.forEach((it, i) => {
      const y = 4 + i * (rowH + gap);
      const bw = Math.max(1, Math.round((w - padL - padR) * (it.value / max)));
      const label = String(it.label).slice(0, 12);
      svg += `<text x="${padL - 4}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="11" fill="currentColor">${_statsEscape(label)}</text>`;
      svg += `<rect x="${padL}" y="${y}" width="${bw}" height="${rowH}" fill="${color}" rx="2"/>`;
      svg += `<text x="${padL + bw + 4}" y="${y + rowH / 2 + 4}" font-size="11" fill="currentColor">${it.value}</text>`;
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
    const card = (title, body) =>
      `<div class="stats-card"><h3>${escHtml(title)}</h3>${body}</div>`;
    grid.innerHTML =
      card(t('stats.qsoPerBand'), _statsSvgBars(bands, '#4e79a7')) +
      card(t('stats.qsoPerMode'), _statsSvgPie(modes, palette)) +
      card(t('stats.qsoPerHourUTC'), _statsSvgBars(hours, '#59a14f')) +
      card(t('stats.topCountries'), _statsSvgBars(countries, '#f28e2c'));
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
      freq_hz: Math.round(parseFloat($('q-freq').value || '0') * 1000),
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
      const freqKHz = (st.freq_hz / 1000).toFixed(2);
      const bandLabel = (typeof fmtBand === 'function') ? fmtBand(st.band || '') : (st.band || '');
      const main = document.createElement('div');
      main.className = 'stash-main';
      main.innerHTML = `
        <div class="stash-line1">
          <strong>${escHtml(st.callsign || '')}</strong>
          <span class="stash-freq">${escHtml(freqKHz)} kHz</span>
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
    $('q-freq').value = stash.freq_hz ? (stash.freq_hz / 1000).toFixed(2) : '';
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
    body.textContent = payload.text || '';
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
    // Discard any in-progress entry (as if Esc was pressed)
    cancelQsoEdit();
    if (spot.dx) {
      $('q-call').value = spot.dx;
      callsignFilter = spot.dx;
      renderQsos();
    }
    if (spot.freq) $('q-freq').value = spot.freq;
    if (spot.band) $('q-band').value = spot.band;
    const inferredMode = (spot.mode && MODES.includes(spot.mode)) ? spot.mode : modeFromFreqKHz(spot.freq);
    if (inferredMode) $('q-mode').value = inferredMode;
    // Clear stale RST values so the mode-appropriate default takes effect
    $('q-rst-sent').value = '';
    $('q-rst-rcvd').value = '';
    applyRSTDefaults($('q-mode').value);
    updateDuplicateBadge();
    updateCallCountry($('q-call').value.trim().toUpperCase());
    updateNrPreview();
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
  function applyDefaults() {
    fillSelect($('q-mode'), MODES, settings?.default_mode || 'SSB');
    fillSelect($('q-band'), BANDS, settings?.default_band || '20m', fmtBand);
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
    const band = bandFromFreqKHz($('q-freq').value);
    if (band) { $('q-band').value = band; updateDuplicateBadge(); }
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
  let renderQsosTimer = null;

  function clearQRZInfo() {
    $('q-name').value = '';
    $('q-loc').value = '';
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
    try {
      const res = await api('/api/lookup?callsign=' + encodeURIComponent(callsign));
      if (!res.ok) return;
      const j = await res.json();
      if (j.name && !$('q-name').value) $('q-name').value = j.name;
      if (j.locator && !$('q-loc').value) $('q-loc').value = j.locator.toUpperCase();
      if (j.cached_dok && !$('q-dok').value) $('q-dok').value = j.cached_dok;
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
      qrzLookupTimer = setTimeout(() => triggerQRZLookup(call), 600);
    } else {
      clearQRZInfo();
    }

    updateNrPreview();
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
    if (!field.value) field.value = preview;
  }

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
    const qTime = new Date(q.time);
    $('q-time').value = qTime.toISOString().substring(0, 19); // YYYY-MM-DDTHH:MM:SS in UTC
    $('log-qso-btn').textContent = t('qso.saveEdit');
    $('entry-panel-title').textContent = t('qso.editQSO');
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
    callsignFilter = null;
    updateDuplicateBadge();
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
    const qTimeRaw = $('q-time').value;
    if (qTimeRaw) {
      // datetime-local emits "YYYY-MM-DDTHH:MM" or "YYYY-MM-DDTHH:MM:SS" — treat as UTC.
      body.time = new Date(qTimeRaw + 'Z').toISOString();
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
    renderQsos();
    updateNrPreview();
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
      case 'freq':         return escHtml(q.freq_hz ? (q.freq_hz/1_000_000).toFixed(4) : '');
      case 'mode':         return escHtml(q.mode || '');
      case 'rst_sent':     return escHtml(q.rst_sent || '');
      case 'rst_received': return escHtml(q.rst_received || '');
      case 'nr_received':  return escHtml(q.nr_received ? String(q.nr_received) : '');
      case 'name':         return escHtml(q.name || '');
      case 'locator':      return escHtml(q.locator || '');
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
      const label = col.isCustom ? escHtml(col.label || col.key) : escHtml(t(col.labelKey));
      const sortKey = col.sortKey || col.key;
      return `<th class="sortable" data-col="${escHtml(sortKey)}"><span>${label}</span> <span class="sort-arrow"></span></th>`;
    }).join('') + '<th></th>';
    updateSortHeaders();
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
        const hay = `${q.callsign} ${q.band} ${fmtBand(q.band)} ${q.mode} ${q.operator} ${q.locator} ${q.dok || ''}`.toLowerCase();
        if (!hay.includes(textFilter)) continue;
      }
      const tr = document.createElement('tr');
      if (q.id === highlightId) tr.classList.add('fresh');
      tr.className = (q.id === editingQsoId) ? 'editing-row' : '';
      tr.style.cursor = 'pointer';
      let extras = {};
      if (q.extras) { try { extras = JSON.parse(q.extras); } catch {} }
      tr.innerHTML = cols.map(col => `<td>${qsoColValue(q, col.key, extras)}</td>`).join('')
        + `<td>${canDelete ? `<button class="del-btn" data-id="${Number(q.id)}">✕</button>` : ''}</td>`;
      tr.addEventListener('click', (e) => {
        if (e.target.closest('.del-btn')) return;
        if (hasPerm('qso.write') && contestIsOpen()) {
          cancelQsoEdit();
          clearLeftPanel(); triggerQRZLookup(q.callsign);
          loadQsoIntoForm(q);
        } else {
          showQsoPicture(q.callsign);
        }
      });
      tbody.appendChild(tr);
      shown++;
    }
    const filterParts = [];
    if (csFiltered) filterParts.push(t('qso.filterWith', { call: callsignFilter }));
    if (textFilter) filterParts.push(t('qso.filterFrom', { n: qsos.length }));
    const base = shown === 1 ? t('qso.count', { n: shown }) : t('qso.countPlural', { n: shown });
    $('qso-count').textContent = filterParts.length ? `${base} (${filterParts.join(', ')})` : base;
  }
  $('history-filter').addEventListener('input', () => renderQsos());
  $('qso-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('.del-btn');
    if (!btn) return;
    if (!contestIsOpen()) return;
    if (!await showConfirm(t('qso.deleteConfirm'), { ok: t('common.delete') })) return;
    const id = parseInt(btn.dataset.id, 10);
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
      $('s-qrz-user').value = settings.qrz_username || '';
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
      qrz_username: $('s-qrz-user')?.value?.trim() || '',
      qrz_password: $('s-qrz-pass')?.value || '',
    };
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
    updateMsChatMutePill();
    applyPermissionsToUI();
    loadMyPasskeys();
  }
  $('ms-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('ms-settings-error').textContent = '';
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

  function contestCreateModal(forcePrivate = false) {
    const canPriv = hasPerm('contests.create_private') || hasPerm('contests.manage_private');
    showModal(`
      <h3>${escHtml(t('contestScreen.createTitle'))}</h3>
      <form>
        <label>${escHtml(t('contestScreen.contestName'))}</label>
        <input name="name" placeholder="${escHtml(t('contestScreen.contestNamePlaceholder'))}" required />
        <label>${escHtml(t('contestScreen.stationCall'))}</label>
        <input name="station_call" autocapitalize="characters" placeholder="${escHtml(t('contestScreen.stationCallPlaceholder'))}" required />
        <label>${escHtml(t('contestScreen.stationIdentifier'))} <span class="muted small">${escHtml(t('contestScreen.stationIdentifierOptionalOp'))}</span></label>
        <input name="station_id" placeholder="${escHtml(t('contestScreen.stationIdPlaceholder'))}" />
        <label>${escHtml(t('contestScreen.qthLocator'))}</label>
        <input name="qth" placeholder="${escHtml(t('contestScreen.qthPlaceholder'))}" maxlength="6" autocapitalize="characters" style="text-transform:uppercase" />
        ${buildBandSelectHTML([])}
        ${canPriv ? `<label style="margin-top:10px"><input type="checkbox" name="private"${forcePrivate ? ' checked' : ''} /> ${escHtml(t('contestScreen.privateContest'))} <span class="muted small">${escHtml(t('contestScreen.privateOnlyYou'))}</span></label>` : ''}
        <label style="margin-top:10px"><input type="checkbox" name="nr_padded" checked /> ${escHtml(t('contestScreen.nrPadded'))}</label>
        <label style="margin-top:10px">${escHtml(t('contestScreen.customFields'))} <span class="muted small">${escHtml(t('contestScreen.customFieldsPerQSO'))}</span></label>
        ${buildCustomFieldsEditorHTML([])}
        <label style="margin-top:10px">${escHtml(t('contestScreen.layoutEditor'))} <span class="muted small">${escHtml(t('contestScreen.layoutHint'))}</span></label>
        ${buildLayoutEditorHTML()}
        <label style="margin-top:10px">${escHtml(t('contestScreen.objective'))} <span class="muted small">${escHtml(t('contestScreen.objectiveMdOptional'))}</span></label>
        <div class="md-editor-wrap">
          <textarea name="objective" placeholder="${escHtml(t('contestScreen.objectivePlaceholder'))}"></textarea>
          <div class="md-preview-pane objective-content" id="modal-md-preview"></div>
        </div>
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.cancel'))}</button>
          <button type="submit" class="primary">${escHtml(t('contestScreen.create'))}</button>
        </div>
      </form>
    `, async (form) => {
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
          nr_padded: form.nr_padded.checked,
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
    attachCustomFieldsEditorListeners();
    attachLayoutEditorListeners('');
    const taC = document.querySelector('#modal-card textarea[name=objective]');
    const previewC = $('modal-md-preview');
    if (taC && previewC) {
      taC.addEventListener('input', () => { previewC.innerHTML = renderMarkdown(taC.value); });
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
        <label style="margin-top:10px"><input type="checkbox" name="nr_padded" ${c.nr_padded !== false ? 'checked' : ''}${d} /> ${escHtml(t('contestScreen.nrPadded'))}</label>
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
        <div class="modal-err error"></div>
        ${actionsHtml}
      </form>
    `, readOnly ? null : async (form) => {
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
          log_columns: serializeLogColumnsEditor(),
          nr_padded: form.nr_padded.checked,
          stash_expiry_minutes: Math.max(1, parseInt(form.stash_expiry_minutes?.value || '60', 10) || 60),
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
      attachCustomFieldsEditorListeners();
      attachLayoutEditorListeners(c.qso_layout || '');
      initLogColDragDrop();
    }
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

    const rows = (participants && participants.length)
      ? participants.map(p => {
          const rolePill = `<span class="participant-role-pill ${escHtml(p.role)}">${escHtml(p.role === 'owner' ? t('contestScreen.roleOwner') : t('contestScreen.roleUser'))}</span>`;
          const statusPill = `<span class="participant-status-pill ${escHtml(p.status)}">${escHtml(p.status === 'active' ? t('contestScreen.participantActive') : t('contestScreen.participantPending'))}</span>`;
          const isSelf = p.user_id === me?.user_id;
          let actions = '';
          if (p.status === 'pending') {
            actions += `<button class="ghost small ptc-approve" data-uid="${p.user_id}">${escHtml(t('contestScreen.approveRequest'))}</button>`;
          }
          if (p.status === 'active' && p.role === 'user') {
            actions += `<button class="ghost small ptc-promote" data-uid="${p.user_id}">&uarr;</button>`;
          }
          if (p.status === 'active' && p.role === 'owner' && isSelf) {
            actions += `<button class="ghost small ptc-demote" data-uid="${p.user_id}">&darr;</button>`;
          }
          if (canManage || (isSelf && p.role !== 'owner')) {
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
    list.querySelectorAll('.ptc-promote').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = Number(btn.dataset.uid);
        const res = await api('/api/contests/' + contestID + '/participants/' + uid, {
          method: 'PUT', body: JSON.stringify({ role: 'owner', status: 'active' }),
        });
        if (res.ok) loadModalParticipants(contestID, canManage);
        else alert(t('contestScreen.participantUpdateFail'));
      });
    });
    list.querySelectorAll('.ptc-demote').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = Number(btn.dataset.uid);
        const res = await api('/api/contests/' + contestID + '/participants/' + uid, {
          method: 'PUT', body: JSON.stringify({ role: 'user', status: 'active' }),
        });
        if (res.ok) loadModalParticipants(contestID, canManage);
        else alert(t('contestScreen.participantUpdateFail'));
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
  function buildCustomFieldsEditorHTML(fields) {
    const rows = (fields || []).map((f, i) => customFieldRowHTML(f, i)).join('');
    return `
      <div class="cf-editor" id="cf-editor">
        <div class="cf-editor-rows">${rows}</div>
        <button type="button" class="ghost cf-add-btn" id="cf-add-btn">${escHtml(t('contestScreen.cfAdd'))}</button>
      </div>`;
  }
  function customFieldRowHTML(f, i) {
    const types = ['text', 'number', 'select'];
    const tOpt = types.map(tp => `<option value="${tp}"${f.type === tp ? ' selected' : ''}>${tp}</option>`).join('');
    return `
      <div class="cf-row" data-i="${i}">
        <div class="cf-row-fields">
          <input class="cf-name" placeholder="${escHtml(t('contestScreen.cfNamePlaceholder'))}" value="${escHtml(f.name || '')}" />
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
  function attachCustomFieldsEditorListeners() {
    const editor = document.getElementById('cf-editor');
    if (!editor) return;
    const addBtn = document.getElementById('cf-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => {
      const rows = editor.querySelector('.cf-editor-rows');
      const idx = rows.querySelectorAll('.cf-row').length;
      rows.insertAdjacentHTML('beforeend', customFieldRowHTML({}, idx));
    });
    editor.addEventListener('click', (e) => {
      if (e.target && e.target.classList.contains('cf-del')) {
        const row = e.target.closest('.cf-row');
        if (row) row.remove();
      }
    });
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
      let inputHtml = '';
      if (f.type === 'select' && Array.isArray(f.options) && f.options.length) {
        const opts = f.options.map(o => `<option value="${escHtml(o)}">${escHtml(o)}</option>`).join('');
        inputHtml = `<select id="${inputId}" data-cf-name="${escHtml(f.name)}" data-cf-required="${f.required ? '1' : '0'}"${reqAttr}><option value=""></option>${opts}</select>`;
      } else if (f.type === 'number') {
        inputHtml = `<input id="${inputId}" type="number" data-cf-name="${escHtml(f.name)}" data-cf-required="${f.required ? '1' : '0'}"${reqAttr} />`;
      } else {
        inputHtml = `<input id="${inputId}" type="text" data-cf-name="${escHtml(f.name)}" data-cf-required="${f.required ? '1' : '0'}"${reqAttr} />`;
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
    const close = () => {
      root.classList.add('hidden');
      card.classList.remove('modal-wide');
    };
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
      const finish = (result) => { root.classList.add('hidden'); resolve(result); };
      $('confirm-cancel').onclick = () => finish(false);
      $('confirm-ok').onclick = () => finish(true);
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
          <label>${escHtml(t('users.passwordMin'))}</label><input type="password" name="password" minlength="8" required />` : ''}
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
        res = await api('/api/users/' + u.id, { method: 'PUT', body: JSON.stringify({ callsign, roles })});
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
            if ('bands' in msg.payload) me.contest_bands = (msg.payload.bands || []).join(',');
            if ('objective' in msg.payload) me.contest_objective = msg.payload.objective;
            if ('station_id' in msg.payload) me.contest_station_id = msg.payload.station_id;
            if ('custom_fields' in msg.payload) me.contest_fields = msg.payload.custom_fields;
            if ('qso_layout' in msg.payload) me.contest_qso_layout = msg.payload.qso_layout;
            if ('log_columns' in msg.payload) { me.contest_log_columns = msg.payload.log_columns; renderQsos(); }
            if ('nr_padded' in msg.payload) me.contest_nr_padded = msg.payload.nr_padded !== false;
            updateContestDisplay();
            applyContestReadonly();
            updateMap();
            renderBandPills();
            renderObjective();
            if (typeof renderCustomFields === 'function') renderCustomFields();
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

  // ----- feature requests -----
  let featureRequests = [];
  let myFeatureRequests = [];

  $('feature-request-btn').addEventListener('click', () => featureRequestSubmitModal());
  $('my-fr-submit-btn').addEventListener('click', () => {
    featureRequestSubmitModal(() => refreshMyFeatureRequests());
  });

  function featureRequestSubmitModal(afterSubmit) {
    showModal(`
      <h3>${escHtml(t('topbar.featureRequest'))}</h3>
      <form>
        <label>${escHtml(t('featureRequests.colFrom'))}</label>
        <input name="from" value="${escHtml(me?.username || '')}" readonly style="opacity:0.6;cursor:not-allowed" />
        <label>${escHtml(t('featureRequests.colRequest'))}</label>
        <textarea name="text" rows="5" required style="width:100%;resize:vertical;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:inherit;font:inherit"></textarea>
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">${escHtml(t('common.cancel'))}</button>
          <button type="submit" class="primary">${escHtml(t('chat.send'))}</button>
        </div>
      </form>
    `, async (form) => {
      const text = form.text.value.trim();
      if (!text) throw new Error(t('featureRequests.pleaseEnter'));
      const res = await api('/api/feature-requests', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('featureRequests.submitFail'));
      }
      if (typeof afterSubmit === 'function') afterSubmit();
    });
  }

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
    for (const fr of featureRequests) {
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
    const res = await api('/api/feature-requests/mine');
    if (!res.ok) return;
    myFeatureRequests = await res.json();
    renderMyFeatureRequests();
  }

  function renderMyFeatureRequests() {
    const tbody = $('my-fr-tbody');
    tbody.innerHTML = '';
    if (!myFeatureRequests.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="4" class="muted" style="text-align:center;padding:20px">${escHtml(t('featureRequests.noMyRequests'))}</td>`;
      tbody.appendChild(tr);
      $('my-fr-count').textContent = '';
      return;
    }
    for (const fr of myFeatureRequests) {
      const tr = document.createElement('tr');
      const date = fr.created_at ? new Date(fr.created_at).toLocaleString(localeForFmt()) : '';
      const statusClass = { pending: 'open', accepted: 'admin', declined: 'disabled', implemented: 'finished' }[fr.status] || '';
      const statusLabel = t('featureRequests.status_' + fr.status) || fr.status;
      tr.innerHTML = `
        <td class="muted small">${escHtml(date)}</td>
        <td><span class="badge ${statusClass}">${escHtml(statusLabel)}</span></td>
        <td style="white-space:pre-wrap;max-width:480px">${escHtml(fr.text)}</td>
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
    const centerCol = outer.querySelector('.center-col');

    const savedLeft  = localStorage.getItem('panel-left-w');
    const savedRight = localStorage.getItem('panel-right-w');
    const savedEntry = localStorage.getItem('panel-entry-h');
    if (savedLeft)  outer.style.setProperty('--left-w',  savedLeft  + 'px');
    if (savedRight) outer.style.setProperty('--right-w', savedRight + 'px');
    if (savedEntry && centerCol) centerCol.style.setProperty('--entry-h', savedEntry + 'px');

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

    makeVResizer('resizer-left',  () => outer.querySelector('.left-panel'),  1,  'panel-left-w');
    makeVResizer('resizer-right', () => outer.querySelector('.ops-panel'),   -1, 'panel-right-w');

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

    initPanelCollapse('collapse-left-btn',  '.left-panel', '--left-w',  'panel-left-w',  '‹', '›');
    initPanelCollapse('collapse-right-btn', '.ops-panel',  '--right-w', 'panel-right-w', '›', '‹');

    const resizerMid = document.getElementById('resizer-mid');
    if (resizerMid && centerCol) {
      resizerMid.addEventListener('pointerdown', e => {
        e.preventDefault();
        resizerMid.setPointerCapture(e.pointerId);
        resizerMid.classList.add('dragging');
        const startY = e.clientY;
        const entryPanel = centerCol.querySelector('.entry-panel');
        const startH = entryPanel ? entryPanel.offsetHeight : 200;
        // Compute the content height by temporarily letting the panel size to its content.
        // scrollHeight reflects the natural layout height including all form fields and the
        // action buttons — never compress below this.
        let minH = 80;
        if (entryPanel) {
          const prev = entryPanel.style.height;
          entryPanel.style.height = 'auto';
          minH = entryPanel.scrollHeight;
          entryPanel.style.height = prev;
        }
        function onMove(ev) {
          const totalH = centerCol.offsetHeight;
          const maxH = Math.max(minH, totalH - 100);
          const newH = Math.max(minH, Math.min(maxH, startH + (ev.clientY - startY)));
          centerCol.style.setProperty('--entry-h', newH + 'px');
          localStorage.setItem('panel-entry-h', String(Math.round(newH)));
        }
        function onUp() {
          resizerMid.classList.remove('dragging');
          resizerMid.removeEventListener('pointermove', onMove);
          resizerMid.removeEventListener('pointerup', onUp);
        }
        resizerMid.addEventListener('pointermove', onMove);
        resizerMid.addEventListener('pointerup', onUp);
      });
    }
  }
  initPanelResizers();

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
      try { renderFeatureRequests(); } catch {}
      try { updateMsChatMutePill(); } catch {}
      try { updateAuditTZHeader(); } catch {}
      try { renderStatistics(); } catch {}
      try { renderDownloads(window.__downloadsCache || []); } catch {}
      try { renderGlobalOperators(); } catch {}
      try { updateContestDisplay(); } catch {}
      try {
        const lo = document.getElementById('layout-outer');
        if (lo) {
          const lb = document.getElementById('collapse-left-btn');
          const rb = document.getElementById('collapse-right-btn');
          if (lb) lb.title = t('topbar.' + (lo.querySelector('.left-panel')?.classList.contains('panel-collapsed') ? 'expandPanel' : 'collapsePanel'));
          if (rb) rb.title = t('topbar.' + (lo.querySelector('.ops-panel')?.classList.contains('panel-collapsed') ? 'expandPanel' : 'collapsePanel'));
        }
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
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.ok) {
      const j = await res.json();
      if (j.setup_required) { show('setup-screen'); return; }
      me = j;
      csrfToken = j.csrf_token || null;
      if (me.language && window.I18N && me.language !== window.I18N.lang()) {
        window.I18N.setLang(me.language);
      }
      $('current-op').textContent = me.username + ' / ' + fmtCall(me.callsign);
      $('contest-current-op').textContent = me.username + ' / ' + fmtCall(me.callsign);
      applyPermissionsToUI();
      await loadSettings();
      applyDefaults();
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
