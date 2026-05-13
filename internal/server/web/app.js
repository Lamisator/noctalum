// Noctalum frontend
(() => {
  const MODES = ['CW', 'SSB', 'USB', 'LSB', 'FM', 'AM', 'RTTY', 'FT8', 'FT4', 'PSK31', 'PSK63', 'JT65', 'DIGI'];
  const BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm', '23cm', '13cm', '3cm'];

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
  let rigs = [];          // [{name, freq_hz, mode, band, in_use_by, connected, error, helper_count}]
  let settings = null;
  let allRoles = [];
  let allPerms = [];
  let allContests = [];
  let ws = null;
  let wsRetry = 0;
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
    ['setup-screen', 'login-screen', 'contest-screen', 'global-settings-screen',
     'contests-admin-screen', 'users-admin-screen', 'audit-admin-screen', 'featurerequests-admin-screen',
     'app'].forEach(id => $(id).classList.add('hidden'));
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

  // ----- admin screens (accessed from contest selection) -----
  $('contests-admin-btn').addEventListener('click', () => showAdminScreen('contests-admin-screen', refreshContests));
  $('users-admin-btn').addEventListener('click', () => showAdminScreen('users-admin-screen', refreshUsers));
  $('audit-admin-btn').addEventListener('click', () => showAdminScreen('audit-admin-screen', () => refreshAuditLog(true)));
  $('featurerequests-admin-btn').addEventListener('click', () => showAdminScreen('featurerequests-admin-screen', refreshFeatureRequests));

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
  $('create-private-contest-btn').addEventListener('click', () => contestCreateModal(true));

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
    show('contest-screen');
  }

  function renderDownloads(files) {
    const list = $('downloads-list');
    const panel = $('downloads-panel');
    if (!files || files.length === 0) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');

    const OS_LABELS = {
      'linux-amd64':   'Linux (x86-64)',
      'linux-arm64':   'Linux (ARM64)',
      'darwin-amd64':  'macOS (Intel)',
      'darwin-arm64':  'macOS (Apple Silicon)',
      'windows-amd64': 'Windows (x86-64)',
    };
    // Three types matched in one regex: helper-gui must come BEFORE helper
    // (greedy alternation), or "noctalum-helper-gui-linux-amd64" lands in
    // the plain-helper bucket with platform=="gui-linux-amd64", and the user
    // sees an unlabelled link they can't distinguish from the curses CLI.
    const GROUP_LABELS = {
      'helper-gui': 'Rig Control Helper — GUI (recommended)',
      'helper':     'Rig Control Helper — CLI / curses',
      'wsjtx':      'WSJT-X Bridge',
    };
    const GROUP_ORDER = ['helper-gui', 'helper', 'wsjtx'];

    const groups = {};
    for (const f of files) {
      const m = f.match(/^noctalum-(helper-gui|helper|wsjtx)-(.+?)(?:\.AppImage|\.exe)?$/);
      if (!m) continue;
      const [, type, platform] = m;
      if (!groups[type]) groups[type] = [];
      groups[type].push({ file: f, platform });
    }

    let html = '';
    for (const type of GROUP_ORDER) {
      const items = groups[type];
      if (!items || items.length === 0) continue;
      const groupName = GROUP_LABELS[type] || type;
      html += `<div class="downloads-group"><div class="downloads-group-name">${escHtml(groupName)}</div>`;
      for (const { file, platform } of items) {
        const label = OS_LABELS[platform] || platform;
        html += `<a class="downloads-link" href="/downloads/${encodeURIComponent(file)}" download>${escHtml(label)}</a>`;
      }
      html += '</div>';
    }
    list.innerHTML = html || '<p class="muted" style="font-size:12px;margin:0">No files available.</p>';
  }

  function makePickerItem(c) {
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
    return item;
  }

  function renderContestPicker() {
    const list = $('contest-picker-list');
    const privateList = $('private-contest-picker-list');
    const privateCol = $('private-contest-col');
    list.innerHTML = '';
    privateList.innerHTML = '';

    const canPriv = hasPerm('contests.create_private');
    privateCol.classList.toggle('hidden', !canPriv);

    const publicContests = (allContests || []).filter(c => !c.private);
    const privateContests = (allContests || []).filter(c => c.private);

    if (publicContests.length === 0) {
      list.innerHTML = '<p class="muted" style="text-align:center;padding:20px">No contests yet.</p>';
    } else {
      for (const c of publicContests) list.appendChild(makePickerItem(c));
    }

    if (canPriv) {
      if (privateContests.length === 0) {
        privateList.innerHTML = '<p class="muted" style="text-align:center;padding:12px 0">No private contests yet.</p>';
      } else {
        for (const c of privateContests) privateList.appendChild(makePickerItem(c));
      }
    }

    $('contest-create-section').classList.toggle('hidden', !hasPerm('contests.manage'));
    $('private-contest-create-section').classList.toggle('hidden', !canPriv);
  }

  // ----- enter main app after contest selected -----
  async function enterApp() {
    show('app');
    updateContestDisplay();
    applyContestReadonly();
    qsos = [];
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
    renderCustomFields();
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
      if (t.dataset.tab === 'settings') loadPasskeys();
      if (t.dataset.tab === 'statistics') renderStatistics();
    });
  });

  // ----- statistics -----
  function _statsEscape(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function _statsSvgBars(items, color) {
    if (!items.length) return '<div class="muted small">No data.</div>';
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
    if (!items.length) return '<div class="muted small">No data.</div>';
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
      grid.innerHTML = '<div class="muted small">No QSOs logged yet.</div>';
      return;
    }
    const total = qsos.length;
    const uniqueCalls = new Set(qsos.map(q => (q.callsign || '').toUpperCase())).size;
    sum.textContent = `${total} QSOs · ${uniqueCalls} unique callsigns`;
    const palette = ['#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'];
    const bands = _statsTally(qsos, 'band');
    const modes = _statsTally(qsos, 'mode');
    const hours = _statsByHour(qsos);
    const countries = _statsByCountry(qsos).slice(0, 12);
    const card = (title, body) =>
      `<div class="stats-card"><h3>${title}</h3>${body}</div>`;
    grid.innerHTML =
      card('QSOs per band', _statsSvgBars(bands, '#4e79a7')) +
      card('QSOs per mode', _statsSvgPie(modes, palette)) +
      card('QSOs per hour (UTC)', _statsSvgBars(hours, '#59a14f')) +
      card('Top countries', _statsSvgBars(countries, '#f28e2c'));
  }

  // ----- ops panel tabs -----
  document.querySelectorAll('.ops-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.ops-tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.ops-tab-pane').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $('ops-tab-' + t.dataset.opsTab).classList.add('active');
      if (t.dataset.opsTab === 'cluster') loadClusterSpots();
      if (t.dataset.opsTab === 'chat') {
        t.classList.remove('chat-notify');
        const inp = $('chat-input');
        if (inp) inp.focus();
        const list = $('chat-list');
        if (list) list.scrollTop = list.scrollHeight;
      }
    });
  });

  // ----- chat -----
  const chatHistory = [];
  function appendChatMessage(payload) {
    if (!payload) return;
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
  function onChatMessage(payload) {
    appendChatMessage(payload);
    const tab = document.querySelector('.ops-tab[data-ops-tab="chat"]');
    if (tab && !tab.classList.contains('active')) {
      tab.classList.add('chat-notify');
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
    document.querySelectorAll('.tab-perm').forEach(t => {
      if (hasPerm(t.dataset.perm)) t.classList.add('visible');
      else t.classList.remove('visible');
    });
    document.querySelectorAll('.perm-required').forEach(el => {
      if (hasPerm(el.dataset.perm)) el.removeAttribute('data-perm-denied');
      else el.setAttribute('data-perm-denied', '1');
    });
    $('feature-request-btn').classList.toggle('hidden', !hasPerm('feature_requests.write'));
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
  let renderQsosTimer = null;

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
    const preview = String(maxNr + 1);
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
    const t = new Date(q.time);
    $('q-time').value = t.toISOString().substring(0, 19);
    $('log-qso-btn').textContent = 'Save Edit';
    $('entry-panel-title').textContent = 'Edit QSO';
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
    const t = $('q-time').value;
    if (t) body.time = new Date(t + 'Z').toISOString();
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
      if (!await showConfirm('Save changes to this QSO?', { ok: 'Save', safe: true })) return;
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
      if (!await showConfirm('Possible duplicate QSO with this station, band, and mode in the last 10 minutes. Log anyway?', { ok: 'Log anyway' })) return;
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
      const otherContests = (r.other_contests || []);
      let useLine = '';
      if (inUse.length) {
        useLine = `<div class="in-use">in use by ${escHtml(inUse.map(fmtCall).join(', '))}</div>`;
      }
      if (otherContests.length) {
        useLine += `<div class="in-use-other">also in: ${escHtml(otherContests.join(', '))}</div>`;
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
    const canRelease = hasPerm('rig.release');
    for (const op of operators) {
      const li = document.createElement('li');
      const rigForOp = rigs.find(r => Array.isArray(r.in_use_by) && r.in_use_by.includes(op.callsign));
      const rigName = (op.rig && rigForOp) ? rigForOp.name : (op.rig || (rigForOp ? rigForOp.name : ''));
      // Prefer the band reported by the server (op.band derives from the helper-reported rig
      // band) and fall back to what the rig list says.
      const band = op.band || (rigForOp ? rigForOp.band : '');
      let label = fmtCall(op.callsign);
      if (rigName) label += ' · ' + rigName;
      if (band) label += ' (' + band + ')';
      const span = document.createElement('span');
      span.textContent = label;
      li.appendChild(span);
      if (me && op.callsign === me.callsign) li.classList.add('me');
      // Allow admins with rig.release to forcibly release another op's rig.
      if (canRelease && rigName && me && op.callsign !== me.callsign) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'op-release-btn';
        btn.title = 'Release ' + rigName + ' from ' + op.callsign;
        btn.textContent = '✕';
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!await showConfirm('Release ' + rigName + ' from ' + op.callsign + '?', { ok: 'Release' })) return;
          await api('/api/rigs/release', { method: 'POST', body: JSON.stringify({ callsign: op.callsign }) });
        });
        li.appendChild(btn);
      }
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
    if ($('tab-statistics')?.classList.contains('active')) renderStatistics();
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
    if (csFiltered) filterParts.push(`with ${callsignFilter}`);
    if (textFilter) filterParts.push(`filtered from ${qsos.length}`);
    $('qso-count').textContent = `${shown} QSO${shown===1?'':'s'}` + (filterParts.length ? ` (${filterParts.join(', ')})` : '');
  }
  $('history-filter').addEventListener('input', () => renderQsos());
  $('qso-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('.del-btn');
    if (!btn) return;
    if (!contestIsOpen()) return;
    if (!await showConfirm('Delete this QSO?', { ok: 'Delete' })) return;
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
    $('s-token').value = me?.helper_token || '';
    $('hint-token').textContent = me?.helper_token || '...';
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
    if (!await showConfirm('Generate a new helper token? Your helper will need to be restarted with the new value.', { ok: 'Generate' })) return;
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

  async function contestAction(c, action) {
    if (action === 'edit') {
      contestEditModal(c);
    } else if (action === 'toggle') {
      const newStatus = c.status === 'open' ? 'finished' : 'open';
      const label = newStatus === 'finished' ? 'Mark this contest as finished (read-only)?' : 'Reopen this contest?';
      if (!await showConfirm(label, { ok: newStatus === 'finished' ? 'Mark finished' : 'Reopen', safe: newStatus !== 'finished' })) return;
      api('/api/contests/' + c.id, {
        method: 'PUT',
        body: JSON.stringify({ name: c.name, station_call: c.station_call, station_id: c.station_id || '', qth: c.qth || '', status: newStatus, bands: c.bands || [], objective: c.objective || '', custom_fields: c.custom_fields || '', qso_layout: c.qso_layout || '' }),
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

  function contestCreateModal(forcePrivate = false) {
    const canPriv = hasPerm('contests.create_private');
    showModal(`
      <h3>New Contest</h3>
      <form>
        <label>Contest name</label>
        <input name="name" placeholder="e.g. CQ-WW-DX-CW 2025" required />
        <label>Station callsign</label>
        <input name="station_call" autocapitalize="characters" placeholder="e.g. DK0XYZ" required />
        <label>Station identifier <span class="muted small">(optional, e.g. operator number)</span></label>
        <input name="station_id" placeholder="e.g. 042" />
        <label>QTH locator (optional)</label>
        <input name="qth" placeholder="e.g. JO50de" maxlength="6" autocapitalize="characters" style="text-transform:uppercase" />
        ${buildBandSelectHTML([])}
        ${canPriv ? `<label style="margin-top:10px"><input type="checkbox" name="private"${forcePrivate ? ' checked' : ''} /> Private contest <span class="muted small">(only visible to you)</span></label>` : ''}
        <label style="margin-top:10px">Custom fields <span class="muted small">(per-QSO; optional)</span></label>
        ${buildCustomFieldsEditorHTML([])}
        <label style="margin-top:10px">New QSO mask layout <span class="muted small">(drag tiles to arrange)</span></label>
        ${buildLayoutEditorHTML()}
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
          station_id: (form.station_id?.value || '').trim(),
          qth: form.qth.value.trim().toUpperCase(),
          bands: selectedBandsFromModal(),
          objective: form.objective.value,
          private: forcePrivate || !!(form.private && form.private.checked),
          custom_fields: serializeCustomFieldsEditor(),
          qso_layout: serializeQSOLayout(),
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
    showModal(`
      <h3>Edit Contest</h3>
      <form>
        <label>Contest name</label>
        <input name="name" value="${escHtml(c.name)}" required />
        <label>Station callsign</label>
        <input name="station_call" value="${escHtml(c.station_call)}" autocapitalize="characters" required />
        <label>Station identifier <span class="muted small">(optional)</span></label>
        <input name="station_id" value="${escHtml(c.station_id || '')}" placeholder="e.g. 042" />
        <label>QTH locator (optional)</label>
        <input name="qth" value="${escHtml(c.qth || '')}" placeholder="e.g. JO50de" maxlength="6" autocapitalize="characters" style="text-transform:uppercase" />
        ${buildBandSelectHTML(c.bands || [])}
        <label style="margin-top:10px">Custom fields <span class="muted small">(per-QSO)</span></label>
        ${buildCustomFieldsEditorHTML(existingFields)}
        <label style="margin-top:10px">New QSO mask layout <span class="muted small">(drag tiles to arrange)</span></label>
        ${buildLayoutEditorHTML()}
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
          station_id: (form.station_id?.value || '').trim(),
          qth: form.qth.value.trim().toUpperCase(),
          status: c.status,
          bands: selectedBandsFromModal(),
          objective: form.objective.value,
          custom_fields: serializeCustomFieldsEditor(),
          qso_layout: serializeQSOLayout(),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to update contest');
      }
      await refreshContests();
    }, { wide: true });
    attachBandSelectListeners();
    attachCustomFieldsEditorListeners();
    attachLayoutEditorListeners(c.qso_layout || '');
    // Live markdown preview
    const ta = document.querySelector('#modal-card textarea[name=objective]');
    const preview = $('modal-md-preview');
    if (ta && preview) {
      const updatePreview = () => { preview.innerHTML = renderMarkdown(ta.value); };
      updatePreview();
      ta.addEventListener('input', updatePreview);
    }
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
        <button type="button" class="ghost cf-add-btn" id="cf-add-btn">+ Add field</button>
      </div>`;
  }
  function customFieldRowHTML(f, i) {
    const types = ['text', 'number', 'select'];
    const tOpt = types.map(t => `<option value="${t}"${f.type === t ? ' selected' : ''}>${t}</option>`).join('');
    return `
      <div class="cf-row" data-i="${i}">
        <div class="cf-row-fields">
          <input class="cf-name" placeholder="name (e.g. exchange)" value="${escHtml(f.name || '')}" />
          <input class="cf-label" placeholder="label" value="${escHtml(f.label || '')}" />
          <select class="cf-type">${tOpt}</select>
          <input class="cf-options" placeholder="options (comma-separated, for select)" value="${escHtml((f.options || []).join(','))}" />
          <button type="button" class="ghost cf-del" title="Remove field">✕</button>
        </div>
        <div class="cf-row-opts">
          <label class="cf-req">
            <input type="checkbox" class="cf-required"${f.required ? ' checked' : ''} />
            <span>Required</span>
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
  const QSO_FIELD_DEFS = [
    { key: 'callsign',     label: 'Callsign',     defaultW: 3, defaultPos: { x: 0, y: 0 } },
    { key: 'rst_sent',     label: 'RST sent',     defaultW: 2, defaultPos: { x: 3, y: 0 } },
    { key: 'rst_received', label: 'RST rcvd',     defaultW: 2, defaultPos: { x: 5, y: 0 } },
    { key: 'nr_received',  label: 'Nr rcvd',      defaultW: 2, defaultPos: { x: 7, y: 0 } },
    { key: 'nr_sent',      label: 'Nr sent',      defaultW: 2, defaultPos: { x: 9, y: 0 } },
    { key: 'mode',         label: 'Mode',         defaultW: 2, defaultPos: { x: 0, y: 1 } },
    { key: 'band',         label: 'Band',         defaultW: 2, defaultPos: { x: 2, y: 1 } },
    { key: 'freq',         label: 'Frequency',    defaultW: 3, defaultPos: { x: 4, y: 1 } },
    { key: 'name',         label: 'Name',         defaultW: 3, defaultPos: { x: 7, y: 1 } },
    { key: 'dok',          label: 'DOK',          defaultW: 2, defaultHidden: true, defaultPos: { x: 0, y: 2 } },
    { key: 'locator',      label: 'Locator',      defaultW: 3, defaultPos: { x: 2, y: 2 } },
    { key: 'itu',          label: 'ITU',          defaultW: 2, defaultHidden: true, defaultPos: { x: 5, y: 2 } },
    { key: 'cq',           label: 'CQ',           defaultW: 2, defaultHidden: true, defaultPos: { x: 7, y: 2 } },
    { key: 'lighthouse',   label: 'Lighthouse',   defaultW: 3, defaultHidden: true, defaultPos: { x: 9, y: 2 } },
    { key: 'notes',        label: 'Notes',        defaultW: 6, defaultPos: { x: 0, y: 3 } },
    { key: 'time',         label: 'UTC time',     defaultW: 3, defaultPos: { x: 6, y: 3 } },
  ];
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
      if (!layout.items.some(it => it.key === key)) tile.classList.add('hidden');
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
        return { error: 'Field "' + name + '" is required' };
      }
      if (v) values[name] = v;
    }
    return { values };
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

  // ----- QSO layout editor (used inside contest modals) -----
  function buildLayoutEditorHTML() {
    return `
      <div class="layout-editor" id="layout-editor"></div>
      <div class="layout-suggested-wrap">
        <div class="layout-suggested-title">Suggested (drag into the mask above)</div>
        <div class="layout-suggested" id="layout-suggested"></div>
      </div>
      <div class="layout-editor-help">
        Drag tiles to rearrange — they snap to the grid and never overlap.
        Drag a left or right edge to resize. Right-click a tile to remove it.
        ★ mandatory tiles (Callsign, RST, Mode, Band, Frequency, UTC time, …) can be moved but not removed.
        <button type="button" class="ghost" id="layout-reset-btn" style="margin-left:8px">Reset to defaults</button>
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
    return def ? def.label : key;
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
      root.innerHTML = '<span class="muted small" style="padding:2px 4px">All suggested fields are in the mask.</span>';
      return;
    }
    root.innerHTML = suggested.map(d =>
      `<div class="layout-suggested-tile" data-suggested-key="${escHtml(d.key)}">+ ${escHtml(d.label)}</div>`
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
    btn.textContent = 'Remove';
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
      tile.classList.add('dragging');
      tile.setPointerCapture?.(e.pointerId);
      const layout = buildEffectiveLayout(_layoutState.json, _layoutState.cfList || []);
      const it = layout.items.find(i => i.key === key);
      const startX = e.clientX, startY = e.clientY;
      const origX = it.x, origY = it.y, origW = it.w;
      const mode = resize ? 'resize' : 'move';
      const edge = resize ? resize.dataset.resize : null;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
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
        if (await showConfirm(`Delete user ${u.username}?`, { ok: 'Delete' })) {
          api('/api/users/' + u.id, { method: 'DELETE' }).then(refreshUsers);
        }
        return;
    }
  }

  async function roleAction(r, action) {
    switch (action) {
      case 'edit-role': roleModal(r); return;
      case 'del-role':
        if (await showConfirm(`Delete role ${r.name}?`, { ok: 'Delete' })) {
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
      okBtn.textContent = opts.ok || 'Confirm';
      okBtn.className = opts.safe ? 'primary' : 'danger';
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
            if ('station_id' in msg.payload) me.contest_station_id = msg.payload.station_id;
            if ('custom_fields' in msg.payload) me.contest_fields = msg.payload.custom_fields;
            if ('qso_layout' in msg.payload) me.contest_qso_layout = msg.payload.qso_layout;
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
            alert('Cannot select rig: ' + msg.payload.reason);
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
        if (!await showConfirm('Delete this feature request?', { ok: 'Delete' })) return;
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
    if (!await showConfirm(`Delete ${selected.length} selected request(s)?`, { ok: 'Delete' })) return;
    await Promise.all(selected.map(id => api('/api/feature-requests/' + id, { method: 'DELETE' })));
    refreshFeatureRequests();
  });

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtCall(s) {
    return String(s).replace(/0/g, 'Ø');
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
