// DKB-CSV-Parser + Normalisierung. Läuft im Browser (window.FinParser) und in Node (Tests).
(function (root) {
  function decode(buffer) {
    const bytes = new Uint8Array(buffer);
    // UTF-8 BOM oder gültiges UTF-8 -> utf-8, sonst Windows-1252 (DKB-Standard)
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return new TextDecoder('windows-1252').decode(bytes); }
  }

  function splitLine(line, sep) {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === sep) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  function parseAmount(s) {
    if (!s) return NaN;
    return Math.round(parseFloat(s.replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.')) * 100) / 100;
  }

  function parseDate(s) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(s || '');
    if (!m) return null;
    let y = +m[3]; if (y < 100) y += 2000;
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }

  // Schlüssel für das Regel-Lernen: robust gegen Filialnummern, Orte, Satzzeichen
  const NOISE = new Set(['gmbh', 'co', 'kg', 'ag', 'se', 'ohg', 'ug', 'ev', 'e', 'v', 'sagt', 'danke', 'filiale', 'fil', 'markt', 'py', 'sumup', 'zettle', 'izettle']);
  function matchKey(raw) {
    let s = (raw || '').toLowerCase().split('/')[0];
    s = s.replace(/[^a-zäöüß ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = s.split(' ').filter(t => t.length > 1 && !NOISE.has(t));
    return tokens.slice(0, 3).join(' ');
  }

  // Zahlungsdienste: der echte Händler steht (wenn überhaupt) im Verwendungszweck
  const PROCESSOR = /paypal|klarna|amazon payments|google payment|unzer/i;
  function isProcessor(raw) { return PROCESSOR.test(raw || ''); }
  // Liefert den Händler; bei Zahlungsdiensten ohne erkennbaren Händler: '' (= unbekannt)
  function effectiveParty(raw, purpose) {
    if (!isProcessor(raw)) return raw || '';
    const p = purpose || '';
    let m = /(?:ihr einkauf bei|ihre zahlung an|zahlung an|einkauf bei)\s+([^,;]+)/i.exec(p);
    if (m) return m[1].trim();
    if (/abbuchung vom paypal|paypal[- ]guthaben|auszahlung/i.test(p)) return 'PayPal-Guthaben';
    m = /PP\.\d+\.PP\/\.?\s*([^,/]+)/i.exec(p);
    if (m && /[a-zäöü]{3}/i.test(m[1]) && !/abbuchung|lastschrift/i.test(m[1])) return m[1].trim();
    return '';
  }
  // Lern-Schlüssel; leer = nicht lernen (z. B. PayPal ohne Händler)
  function keyFor(row) {
    const party = effectiveParty(row.counterparty_raw, row.purpose);
    return party ? matchKey(party) : '';
  }
  function displayName(raw, purpose) {
    const party = effectiveParty(raw, purpose);
    if (party) return prettyPayee(party);
    const m = (raw || '').match(PROCESSOR);
    return m ? m[0].replace(/^./, c => c.toUpperCase()).replace(/^Paypal$/, 'PayPal') : prettyPayee(raw);
  }

  // Lesbarer Vorschlag für den Anzeigenamen
  function prettyPayee(raw) {
    let s = (raw || '').split('/')[0].replace(/[._*]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s === s.toUpperCase() || s === s.toLowerCase()) {
      s = s.toLowerCase().replace(/(^|[\s-])([a-zäöü])/g, (m, a, b) => a + b.toUpperCase());
    }
    return s;
  }

  function parseDKB(text) {
    const lines = text.split(/\r?\n/);
    const hi = lines.findIndex(l => /buchungs(datum|tag)/i.test(l));
    if (hi < 0) throw new Error('Keine Kopfzeile mit "Buchungsdatum" gefunden – ist das eine DKB-CSV?');
    const sep = (lines[hi].match(/;/g) || []).length >= (lines[hi].match(/,/g) || []).length ? ';' : ',';
    const head = splitLine(lines[hi], sep);
    const col = re => head.findIndex(h => re.test(h));
    const c = {
      date: col(/^buchungs(datum|tag)/i),
      status: col(/^status/i),
      payer: col(/zahlungspflichtig/i),
      payee: col(/zahlungsempf/i),
      legacyParty: col(/auftraggeber|begünstigt/i),
      purpose: col(/verwendungszweck/i),
      type: col(/umsatztyp|buchungstext/i),
      iban: col(/^iban|kontonummer/i),
      amount: col(/^betrag/i),
    };
    if (c.date < 0 || c.amount < 0) throw new Error('Spalten "Buchungsdatum" oder "Betrag" fehlen.');

    const rows = []; let skippedPending = 0; const seen = {};
    for (let i = hi + 1; i < lines.length; i++) {
      const f = splitLine(lines[i], sep);
      const g = k => (c[k] >= 0 ? f[c[k]] || '' : '');
      const date = parseDate(g('date'));
      const amount = parseAmount(g('amount'));
      if (!date || isNaN(amount)) continue;               // leere Zeilen etc.
      if (g('status') && !/gebucht/i.test(g('status'))) { skippedPending++; continue; }
      const party = c.legacyParty >= 0 ? g('legacyParty') : (amount < 0 ? g('payee') : g('payer'));
      const r = {
        booking_date: date, amount,
        counterparty_raw: party, payee: displayName(party, g('purpose')),
        purpose: g('purpose'), iban: g('iban'), tx_type: g('type'),
      };
      // Hash inkl. laufender Nummer, damit zwei identische Käufe am selben Tag beide zählen
      const base = [date, amount.toFixed(2), party, r.purpose].join('|');
      seen[base] = (seen[base] || 0) + 1;
      r.hash = base + '|' + seen[base];
      rows.push(r);
    }
    return { rows, skippedPending };
  }

  const api = { decode, parseDKB, matchKey, keyFor, prettyPayee, displayName, isProcessor, parseAmount, parseDate };
  if (typeof module !== 'undefined') module.exports = api; else root.FinParser = api;
})(this);
