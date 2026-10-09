/* Haushaltsbuch – App-Logik */
const P = window.FinParser;
const cfg = window.FIN_CONFIG;
const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const S = { userRules: [], noUserRules: false, dupReview: [], accounts: [], acc: 'alle', cats: [], subs: [], txs: [], rules: new Map(), view: 'tx',
  f: { year: 'alle', month: 'alle', cat: 'offen', q: '' }, yearSel: null, expanded: new Set() };

const MONTHS = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
const DEFAULTS = [
  ['Lebensmittel','ausgabe',['Edeka','Rewe','Aldi','Lidl','Sonstiges']],
  ['Essen & Trinken','ausgabe',['Restaurant','Café & Bäckerei','Sonstiges']],
  ['Wohnen','ausgabe',['Miete','Nebenkosten','Strom','Internet & Telefon','Sonstiges']],
  ['Mobilität','ausgabe',['Tanken','ÖPNV','Auto','Sonstiges']],
  ['Kinder','ausgabe',['Verein','Kita & Schule','Sonstiges']],
  ['Freizeit','ausgabe',['Sport','Urlaub','Sonstiges']],
  ['Versicherungen','ausgabe',['Sonstiges']],
  ['Gesundheit','ausgabe',['Apotheke','Sonstiges']],
  ['Shopping','ausgabe',['Kleidung','Online','Sonstiges']],
  ['Sonstige Ausgaben','ausgabe',['Sonstiges']],
  ['Einkommen','einnahme',['Gehalt','Kindergeld','Sonstiges']],
  ['Umbuchungen','umbuchung',['Sparen','Kreditkarte','Sonstiges']],
];

// ---------- Helfer ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const eur = n => (n || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const sign = n => n < 0 ? 'neg' : n > 0 ? 'pos' : 'muted';
const fmtDate = d => d.split('-').reverse().join('.');
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); }
function fail(err) { console.error(err); toast('Fehler: ' + (err.message || err)); }
const subById = id => S.subs.find(s => s.id === id);
const catById = id => S.cats.find(c => c.id === id);
const catOfTx = t => { const s = subById(t.subcategory_id); return s ? catById(s.category_id) : null; };
const keyOf = t => P.keyFor(t);
const accById = id => S.accounts.find(a => a.id === id);
// Kategorie sichtbar für Konto? (account_id leer = alle Konten)
const catVisible = (c, accId) => !c.account_id || !accId || accId === 'alle' || c.account_id === accId;
const scopeTxt = c => c.account_id ? 'nur ' + (accById(c.account_id)?.name || '?') : 'alle Konten';
// Buchungen im gewählten Konto (oder alle)
const scoped = () => S.acc === 'alle' ? S.txs : S.txs.filter(t => t.account_id === S.acc);
const years = () => [...new Set(scoped().map(t => +t.booking_date.slice(0, 4)))].sort((a, b) => b - a);

// ---------- Daten ----------
async function loadAll() {
  const [a, c, s, r] = await Promise.all([
    sb.from('accounts').select('*').order('sort'),
    sb.from('categories').select('*').order('sort'),
    sb.from('subcategories').select('*').order('name'),
    sb.from('rules').select('*'),
  ]);
  for (const x of [a, c, s, r]) if (x.error) throw x.error;
  S.accounts = a.data; S.cats = c.data; S.subs = s.data;
  S.rules = new Map(r.data.map(x => [x.match_key, x]));
  const ur = await sb.from('user_rules').select('*').order('sort').order('created_at');
  S.noUserRules = !!ur.error; S.userRules = ur.error ? [] : ur.data;
  // Buchungen seitenweise laden (Supabase liefert max. 1000 pro Abfrage)
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('transactions').select('*').order('booking_date', { ascending: false }).range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  S.txs = all.map(t => ({ ...t, amount: +t.amount }));
  if (!S.cats.length) await seedDefaults();
  if (!S.accounts.length) {
    const { data, error } = await sb.from('accounts').insert([{ name: 'Gemeinschaft', sort: 0 }, { name: 'Privat', sort: 1 }]).select();
    if (error) throw error;
    S.accounts = data.sort((x, y) => x.sort - y.sort);
  }
  if (S.acc !== 'alle' && !accById(S.acc)) S.acc = 'alle';
  await repairProcessorRules();
}

// Einmalige Reparatur: Sammelregeln für Zahlungsdienste (z. B. "paypal europe ...") entfernen
// und automatisch zugeordnete PayPal-Buchungen mit den neuen Händler-Schlüsseln neu bewerten
async function repairProcessorRules() {
  const bad = [...S.rules.values()].filter(r => P.isProcessor(r.match_key) && r.match_key !== 'paypal guthaben');
  if (!bad.length) return;
  const { error } = await sb.from('rules').delete().in('id', bad.map(r => r.id));
  if (error) throw error;
  bad.forEach(r => S.rules.delete(r.match_key));
  let reset = 0;
  for (const t of S.txs.filter(t => P.isProcessor(t.counterparty_raw) && t.assign_state !== 'manuell')) {
    if (findUserRule(t)) continue;
    const m = findRule(keyOf(t));
    const patch = { payee: P.displayName(t.counterparty_raw, t.purpose),
      subcategory_id: m?.rule.subcategory_id || null, assign_state: m?.rule.subcategory_id ? m.state : null };
    if (patch.subcategory_id !== t.subcategory_id) reset++;
    await updateTxs([t.id], patch);
  }
  setTimeout(() => toast(`PayPal-Zuordnungen bereinigt: ${reset} Buchung(en) neu bewertet`), 300);
}

async function seedDefaults() {
  const { data: cats, error } = await sb.from('categories')
    .insert(DEFAULTS.map(([name, kind], i) => ({ name, kind, sort: i }))).select();
  if (error) throw error;
  const subs = [];
  for (const [name, , list] of DEFAULTS) {
    const cat = cats.find(c => c.name === name);
    list.forEach(n => subs.push({ category_id: cat.id, name: n }));
  }
  const r = await sb.from('subcategories').insert(subs).select();
  if (r.error) throw r.error;
  S.cats = cats.sort((a, b) => a.sort - b.sort); S.subs = r.data;
}

// Eigene Regeln: "enthält"-Bedingung, haben Vorrang
function ruleMatches(r, t) {
  if (r.account_id && t.account_id && r.account_id !== t.account_id) return false;
  if (r.direction === 'ausgabe' && t.amount >= 0) return false;
  if (r.direction === 'einnahme' && t.amount < 0) return false;
  const who = `${t.counterparty_raw || ''} ${t.payee || ''}`.toLowerCase(), why = (t.purpose || '').toLowerCase();
  if (!r.pattern && !r.purpose_pattern) return false;
  if (r.pattern) {
    const hay = r.field === 'empfaenger' ? who : r.field === 'zweck' ? why : who + ' ' + why;
    if (!hay.includes(r.pattern.toLowerCase())) return false;
  }
  if (r.purpose_pattern && !why.includes(r.purpose_pattern.toLowerCase())) return false;
  return true;
}
const findUserRule = t => S.userRules.find(r => ruleMatches(r, t));

// Regel finden: exakt = auto, ähnlicher Anfang = Vorschlag
function findRule(key) {
  if (!key) return null;
  const exact = S.rules.get(key);
  if (exact) return { rule: exact, state: 'auto' };
  const first = key.split(' ')[0];
  if (first.length < 4) return null;
  let best = null;
  for (const r of S.rules.values()) {
    if (r.match_key.split(' ')[0] === first && (!best || r.hits > best.hits)) best = r;
  }
  return best ? { rule: best, state: 'vorschlag' } : null;
}

async function saveRule(key, patch) {
  if (!key) return;
  const old = S.rules.get(key);
  const row = { match_key: key, payee: old?.payee ?? null, subcategory_id: old?.subcategory_id ?? null,
    hits: (old?.hits || 0) + 1, updated_at: new Date().toISOString(), ...patch };
  const { data, error } = await sb.from('rules').upsert(row, { onConflict: 'user_id,match_key' }).select().single();
  if (error) throw error;
  S.rules.set(key, data);
}

async function updateTxs(ids, patch) {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await sb.from('transactions').update(patch).in('id', ids.slice(i, i + 200));
    if (error) throw error;
  }
  S.txs.forEach(t => { if (ids.includes(t.id)) Object.assign(t, patch); });
}

// ---------- Import ----------
async function importFile(file, accountId) {
  if (!accountId) throw new Error('Bitte zuerst ein Konto wählen.');
  const text = P.decode(await file.arrayBuffer());
  const { rows, skippedPending } = P.parseDKB(text);
  // 1) Falsches Konto? Gleiche Buchungen schon in einem anderen Konto
  const baseOf = h => h.slice(h.indexOf('|') + 1);
  const elsewhere = new Map(S.txs.filter(t => t.account_id !== accountId).map(t => [baseOf(t.hash), t.account_id]));
  const hitAcc = {};
  rows.forEach(r => { const a = elsewhere.get(r.hash); if (a) hitAcc[a] = (hitAcc[a] || 0) + 1; });
  const hitTotal = Object.values(hitAcc).reduce((x, y) => x + y, 0);
  if (hitTotal) {
    const where = Object.entries(hitAcc).map(([a, n]) => `${n} im Konto „${accById(a)?.name}"`).join(', ');
    if (!confirm(`${file.name}: ${hitTotal} von ${rows.length} Buchungen gibt es schon (${where}).\n\nIst das das richtige Konto „${accById(accountId)?.name}"?\nOK = trotzdem importieren, Abbrechen = nichts importieren.`))
      return { aborted: true };
  }
  rows.forEach(r => { r.account_id = accountId; r.hash = accountId + '|' + r.hash; });
  const known = new Set(S.txs.map(t => t.hash));
  let fresh = rows.filter(r => !known.has(r.hash));
  // 2) Mögliche Duplikate: gleiches Konto, Datum, Betrag – aber anderer Text
  const fileHashes = new Set(rows.map(r => r.hash));
  const pool = S.txs.filter(t => t.account_id === accountId && !fileHashes.has(t.hash));
  const used = new Set(), dups = [];
  fresh = fresh.filter(r => {
    const ex = pool.find(t => !used.has(t.id) && t.booking_date === r.booking_date && t.amount === r.amount);
    if (!ex) return true;
    used.add(ex.id); dups.push({ row: r, existing: ex }); return false;
  });
  let auto = 0, sugg = 0;
  for (const r of [...fresh, ...dups.map(d => d.row)]) {
    r.subcategory_id = null; r.assign_state = null;
    const ur = findUserRule(r);
    if (ur) { r.subcategory_id = ur.subcategory_id; r.assign_state = 'auto'; if (ur.payee) r.payee = ur.payee; continue; }
    const m = findRule(keyOf(r));
    if (m && m.rule.subcategory_id) {
      r.subcategory_id = m.rule.subcategory_id; r.assign_state = m.state;
      if (m.state === 'auto' && m.rule.payee) r.payee = m.rule.payee;
    }
  }
  fresh.forEach(r => { if (r.assign_state === 'auto') auto++; else if (r.assign_state === 'vorschlag') sugg++; });
  for (let i = 0; i < fresh.length; i += 500) {
    const { error } = await sb.from('transactions').insert(fresh.slice(i, i + 500));
    if (error) throw error;
  }
  await loadAll();
  S.dupReview.push(...dups);
  return { total: rows.length, fresh: fresh.length, dup: rows.length - fresh.length - dups.length, check: dups.length, auto, sugg,
    open: fresh.length - auto - sugg, skippedPending };
}

// ---------- Bearbeiten ----------
async function setCategory(id, subId) {
  const t = S.txs.find(x => x.id === id);
  const key = keyOf(t);
  await updateTxs([id], { subcategory_id: subId || null, assign_state: subId ? 'manuell' : null });
  if (!subId) return render();
  if (!key) { toast('Gespeichert (ohne Lernen – Händler unbekannt)'); return render(); }
  await saveRule(key, { subcategory_id: subId, payee: t.payee });
  // Lernen: gleiche Händler, die noch nicht manuell zugeordnet sind, mitziehen
  const others = S.txs.filter(x => x.id !== id && x.assign_state !== 'manuell' && keyOf(x) === key && x.subcategory_id !== subId);
  await updateTxs(others.map(x => x.id), { subcategory_id: subId, assign_state: 'auto' });
  toast(others.length ? `Gespeichert – ${others.length} ähnliche Buchung(en) ebenfalls zugeordnet` : 'Gespeichert');
  render();
}

async function setPayee(id, name) {
  const t = S.txs.find(x => x.id === id);
  name = name.trim();
  if (!name || name === t.payee) return;
  const key = keyOf(t), old = t.payee;
  await updateTxs([id], { payee: name });
  if (!key) { toast('Umbenannt'); return render(); }
  await saveRule(key, { payee: name, hits: S.rules.get(key)?.hits || 0 });
  const same = S.txs.filter(x => x.id !== id && keyOf(x) === key && x.payee === old);
  await updateTxs(same.map(x => x.id), { payee: name });
  toast(same.length ? `Umbenannt – auch bei ${same.length} weiteren Buchung(en)` : 'Umbenannt');
  render();
}

async function deleteTx(id) {
  if (!confirm('Buchung löschen?')) return;
  const { error } = await sb.from('transactions').delete().eq('id', id);
  if (error) throw error;
  S.txs = S.txs.filter(t => t.id !== id); render();
}

// ---------- Ansichten ----------
function subOptions(selected, withNew = true, accId = null) {
  let h = `<option value="">– offen –</option>${withNew ? '<option value="__new">＋ Neu anlegen…</option>' : ''}`;
  const selCat = subById(selected)?.category_id;
  for (const c of S.cats.filter(c => catVisible(c, accId) || c.id === selCat)) {
    h += `<optgroup label="${esc(c.name)}">`;
    for (const s of S.subs.filter(s => s.category_id === c.id))
      h += `<option value="${s.id}"${s.id === selected ? ' selected' : ''}>${esc(c.name)} › ${esc(s.name)}</option>`;
    h += `</optgroup>`;
  }
  return h;
}

function viewImport() {
  const def = S.acc !== 'alle' ? S.acc : (S.importAcc || '');
  return `<div class="card"><h2>DKB-Umsätze importieren</h2>
    <div class="filters"><label for="impAcc">In Konto:</label>
      <select id="impAcc"><option value="">– Konto wählen –</option>${S.accounts.map(a => `<option value="${a.id}"${a.id === def ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
    <div class="drop" id="drop">
      <p>CSV-Datei hierher ziehen oder</p>
      <label class="btn">Datei wählen<input type="file" id="file" accept=".csv,text/csv" hidden multiple></label>
      <p class="muted">Bereits importierte Buchungen werden erkannt und übersprungen. Vorgemerkte Umsätze werden erst übernommen, wenn sie gebucht sind.</p>
    </div><div id="importResult"></div></div>${viewDupReview()}`;
}

function viewDupReview() {
  if (!S.dupReview.length) return '';
  const rows = S.dupReview.map((d, i) => `<tr>
      <td class="num muted">${fmtDate(d.row.booking_date)}</td><td class="muted">${esc(accById(d.row.account_id)?.name)}</td>
      <td class="num ${sign(d.row.amount)}">${eur(d.row.amount)}</td>
      <td><b>${esc(d.row.payee)}</b><div class="purpose">${esc(d.row.purpose)}</div></td>
      <td><b>${esc(d.existing.payee)}</b><div class="purpose">${esc(d.existing.purpose)}</div></td>
      <td style="white-space:nowrap"><button class="ghost" data-dupimp="${i}">Importieren</button> <button class="ghost" data-dupskip="${i}">Verwerfen</button></td></tr>`).join('');
  return `<div class="card"><div class="filters"><h2 style="margin:0">Mögliche Duplikate (${S.dupReview.length})</h2>
      <span class="spacer" style="flex:1"></span>
      <button class="ghost" data-dupall="imp">Alle importieren</button><button class="ghost" data-dupall="skip">Alle verwerfen</button></div>
    <p class="muted">Gleiches Konto, Datum und Betrag wie eine vorhandene Buchung, aber anderer Text. Bei echten zwei Käufen: importieren. Wenn DKB nur den Text geändert hat: verwerfen.</p>
    <div class="tablewrap"><table><thead><tr><th>Datum</th><th>Konto</th><th class="num">Betrag</th><th>Neu aus Datei</th><th>Schon vorhanden</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
}

async function resolveDups(idxs, doImport) {
  const items = idxs.map(i => S.dupReview[i]);
  if (doImport) {
    const { data, error } = await sb.from('transactions').insert(items.map(d => d.row)).select();
    if (error) throw error;
    S.txs.push(...data.map(t => ({ ...t, amount: +t.amount })));
  }
  S.dupReview = S.dupReview.filter(d => !items.includes(d));
  toast(doImport ? `${items.length} importiert` : `${items.length} verworfen`);
  render();
}

function filteredTxs() {
  const { year, month, cat, q } = S.f;
  const ql = q.toLowerCase();
  return scoped().filter(t => {
    if (year !== 'alle' && t.booking_date.slice(0, 4) !== year) return false;
    if (month !== 'alle' && +t.booking_date.slice(5, 7) !== +month) return false;
    if (cat === 'offen' && t.subcategory_id && t.assign_state !== 'vorschlag') return false;
    if (cat.startsWith('sub:')) { if (t.subcategory_id !== cat.slice(4) || t.assign_state === 'vorschlag') return false; }
    else if (cat !== 'alle' && cat !== 'offen' && catOfTx(t)?.id !== cat) return false;
    if (ql && !(t.payee + ' ' + t.purpose + ' ' + t.counterparty_raw).toLowerCase().includes(ql)) return false;
    return true;
  });
}

function viewTx() {
  const list = filteredTxs();
  const sum = list.reduce((a, t) => a + t.amount, 0);
  const rows = list.slice(0, 600).map(t => {
    const st = !t.subcategory_id ? '<span class="state offen">offen</span>'
      : t.assign_state === 'vorschlag' ? `<span class="state vorschlag">Vorschlag</span> <button class="icon" data-ok="${t.id}" title="Vorschlag bestätigen">✓</button>`
      : t.assign_state === 'auto' ? '<span class="state auto">auto</span>' : '';
    return `<tr>
      <td class="num muted">${fmtDate(t.booking_date)}</td>
      ${S.acc === 'alle' ? `<td class="muted">${esc(accById(t.account_id)?.name || '–')}</td>` : ''}
      <td><input class="payee" data-payee="${t.id}" value="${esc(t.payee)}" title="Original: ${esc(t.counterparty_raw)}"></td>
      <td class="purpose" title="${esc(t.purpose)}">${esc(t.purpose)}</td>
      <td class="num ${sign(t.amount)}">${eur(t.amount)}</td>
      <td><select data-sub="${t.id}">${subOptions(t.subcategory_id, true, t.account_id)}</select></td>
      <td>${st}</td>
      <td style="white-space:nowrap"><button class="icon" data-edit="${t.id}" title="Bearbeiten">✎</button><button class="icon" data-del="${t.id}" title="Löschen">×</button></td></tr>`;
  }).join('');
  const y = years();
  return `<div class="card">
    <div class="filters">
      <select id="fYear"><option value="alle">Alle Jahre</option>${y.map(v => `<option${S.f.year == v ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <select id="fMonth"><option value="alle">Alle Monate</option>${MONTHS.map((m, i) => `<option value="${i + 1}"${S.f.month == i + 1 ? ' selected' : ''}>${m}</option>`).join('')}</select>
      <select id="fCat">
        <option value="offen"${S.f.cat === 'offen' ? ' selected' : ''}>Offen &amp; Vorschläge</option>
        <option value="alle"${S.f.cat === 'alle' ? ' selected' : ''}>Alle Kategorien</option>
        ${S.cats.filter(c => catVisible(c, S.acc) || S.f.cat === c.id).map(c => `<option value="${c.id}"${S.f.cat === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
        ${S.f.cat.startsWith('sub:') ? (s => `<option value="${S.f.cat}" selected>${esc(catById(s?.category_id)?.name)} › ${esc(s?.name)}</option>`)(subById(S.f.cat.slice(4))) : ''}
      </select>
      <input id="fQ" placeholder="Suche…" value="${esc(S.f.q)}">
      <span class="spacer" style="flex:1"></span>
      <span class="muted">${list.length} Buchungen · Summe <b class="num ${sign(sum)}">${eur(sum)}</b></span>
    </div>
    ${list.length ? `<div class="tablewrap"><table>
      <thead><tr><th>Datum</th>${S.acc === 'alle' ? '<th>Konto</th>' : ''}<th>Empfänger / Auftraggeber</th><th>Verwendungszweck</th><th class="num">Betrag</th><th>Kategorie</th><th></th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>${list.length > 600 ? '<p class="muted">Die ersten 600 werden angezeigt – Filter eingrenzen.</p>' : ''}`
      : `<p class="muted">${S.f.cat === 'offen' ? 'Alles zugeordnet. 👌' : 'Keine Buchungen für diesen Filter.'}</p>`}
  </div>`;
}

// Summen je Unterkategorie × Monat für ein Jahr
function aggregate(year) {
  const m = new Map(); // subId|'none+'|'none-' -> [12]
  for (const t of scoped()) {
    if (+t.booking_date.slice(0, 4) !== year) continue;
    const k = t.subcategory_id && t.assign_state !== 'vorschlag' ? t.subcategory_id : (t.amount < 0 ? 'none-' : 'none+');
    if (!m.has(k)) m.set(k, Array(12).fill(0));
    m.get(k)[+t.booking_date.slice(5, 7) - 1] += t.amount;
  }
  return m;
}
const add = (a, b) => a.map((v, i) => v + b[i]);
const total = a => a.reduce((x, y) => x + y, 0);

function viewYear() {
  const ys = years();
  if (!ys.length) return `<div class="card muted">Noch keine Buchungen – zuerst importieren.</div>`;
  const year = S.yearSel && ys.includes(S.yearSel) ? S.yearSel : ys[0];
  S.yearSel = year;
  const agg = aggregate(year);
  const monthsWithData = Math.max(1, new Set(scoped().filter(t => +t.booking_date.slice(0, 4) === year).map(t => t.booking_date.slice(5, 7))).size);

  const section = (title, kind, flip) => {
    let rowsHtml = '', sec = Array(12).fill(0);
    const cell = (v, key, m, extra = '') => `<td class="num${key ? ' drill' : ''} ${extra}"${key ? ` data-drill="${key}|${m}" title="Buchungen anzeigen"` : ''}>${v ? eur(flip * v) : '<span class="muted">–</span>'}</td>`;
    const line = (cls, label, arr, attr = '', key = '') => `<tr class="${cls}" ${attr}><td>${label}</td>${arr.map((v, i) => cell(v, key, i + 1, flip === 1 && kind === 'umbuchung' ? sign(v) : '')).join('')}
      ${cell(total(arr), key, 0, 'b')}<td class="num muted">${eur(flip * total(arr) / monthsWithData)}</td></tr>`;
    for (const c of S.cats.filter(c => c.kind === kind)) {
      const subs = S.subs.filter(s => s.category_id === c.id);
      let cs = Array(12).fill(0);
      subs.forEach(s => { if (agg.has(s.id)) cs = add(cs, agg.get(s.id)); });
      if (!total(cs.map(Math.abs))) continue;
      sec = add(sec, cs);
      const open = S.expanded.has(c.id);
      rowsHtml += line('cat clickable', `${open ? '▾' : '▸'} ${esc(c.name)}`, cs, `data-exp="${c.id}"`, c.id);
      if (open) subs.forEach(s => { if (agg.has(s.id)) rowsHtml += line('sub', esc(s.name), agg.get(s.id), '', 'sub:' + s.id); });
    }
    const none = kind === 'umbuchung' ? null : agg.get(flip < 0 ? 'none-' : 'none+');
    if (none) { sec = add(sec, none); rowsHtml += line('cat', '<span class="state offen">nicht zugeordnet</span>', none, '', 'offen'); }
    if (!rowsHtml) return { html: '', sum: sec };
    return { html: `<tr><th colspan="15" style="padding-top:16px;font-size:13px;color:var(--ink)">${title}</th></tr>${rowsHtml}${line('total', 'Summe ' + title, sec)}`, sum: sec };
  };
  const inc = section('Einnahmen', 'einnahme', 1);
  const exp = section('Ausgaben', 'ausgabe', -1);
  const umb = section('Umbuchungen', 'umbuchung', 1);
  const saldo = add(add(inc.sum, exp.sum), umb.sum);
  return `<div class="card">
    <div class="filters"><h2 style="margin:0">Übersicht</h2>
      <select id="ySel">${ys.map(v => `<option${v === year ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <span class="muted">Ausgaben positiv · Umbuchungen mit Vorzeichen · Kategorie anklicken = Unterkategorien · Betrag anklicken = Buchungen</span></div>
    <div class="tablewrap"><table>
      <thead><tr><th></th>${MONTHS.map(m => `<th class="num">${m}</th>`).join('')}<th class="num">Jahr</th><th class="num">Ø Monat</th></tr></thead>
      <tbody>${inc.html}${exp.html}${umb.html}
      <tr class="total"><td>Saldo</td>${saldo.map(v => `<td class="num ${sign(v)}">${v ? eur(v) : '<span class="muted">–</span>'}</td>`).join('')}<td class="num ${sign(total(saldo))}">${eur(total(saldo))}</td><td class="num muted">${eur(total(saldo) / monthsWithData)}</td></tr>
      </tbody></table></div></div>`;
}

function viewCompare() {
  const ys = years().slice().reverse();
  if (ys.length < 1) return `<div class="card muted">Noch keine Buchungen – zuerst importieren.</div>`;
  const byYear = Object.fromEntries(ys.map(y => [y, aggregate(y)]));
  const catSum = (c, y) => S.subs.filter(s => s.category_id === c.id).reduce((a, s) => a + total(byYear[y].get(s.id) || []), 0);
  const rows = S.cats.map(c => {
    const flip = c.kind === 'ausgabe' ? -1 : 1;
    const vals = ys.map(y => flip * catSum(c, y));
    return { c, vals };
  }).filter(r => r.vals.some(v => v) || scoped().some(t => t.assign_state !== 'vorschlag' && catOfTx(t)?.id === r.c.id));
  const last = ys.length - 1;
  const delta = (v) => {
    if (ys.length < 2) return '';
    const a = v[last - 1], b = v[last];
    const d = b - a, pct = a ? (d / Math.abs(a)) * 100 : null;
    return `<td class="num">${eur(d)}</td><td class="num muted">${pct === null ? '–' : (pct > 0 ? '+' : '') + pct.toFixed(0) + ' %'}</td>`;
  };
  return `<div class="card"><h2>Jahresvergleich</h2>
    <div style="height:320px;margin-bottom:16px"><canvas id="cmpChart"></canvas></div>
    <div class="tablewrap"><table><thead><tr><th>Kategorie</th>${ys.map(y => `<th class="num">${y}</th>`).join('')}
      ${ys.length > 1 ? `<th class="num">Δ ${ys[last]} vs ${ys[last - 1]}</th><th class="num">%</th>` : ''}</tr></thead>
      <tbody>${rows.map(r => `<tr><td>${esc(r.c.name)} <span class="kind">${r.c.kind}</span></td>${r.vals.map(v => `<td class="num">${eur(v)}</td>`).join('')}${delta(r.vals)}</tr>`).join('')}</tbody>
    </table></div>
    <p class="muted">Hinweis: Das laufende Jahr ist noch nicht vollständig – Vergleich entsprechend lesen.</p></div>`;
}

function drawCompareChart() {
  const el = $('#cmpChart'); if (!el || !window.Chart) return;
  const ys = years().slice().reverse();
  const exp = S.cats.filter(c => c.kind === 'ausgabe');
  const val = (c, y) => -scoped().filter(t => +t.booking_date.slice(0, 4) === y && t.assign_state !== 'vorschlag' && catOfTx(t)?.id === c.id).reduce((a, t) => a + t.amount, 0);
  const used = exp.filter(c => ys.some(y => val(c, y)));
  const css = getComputedStyle(document.documentElement);
  const palette = ['#1f6f5c', '#c08a2e', '#5b6abf', '#b03a2e', '#7a8b84'];
  new Chart(el, {
    type: 'bar',
    data: { labels: used.map(c => c.name), datasets: ys.map((y, i) => ({ label: String(y), data: used.map(c => Math.round(val(c, y))),
      backgroundColor: palette[(ys.length - 1 - i) % palette.length], borderRadius: 3 })) },
    options: { maintainAspectRatio: false, plugins: { legend: { labels: { color: css.getPropertyValue('--ink') } },
      tooltip: { callbacks: { label: c => `${c.dataset.label}: ${eur(c.raw)}` } } },
      scales: { x: { ticks: { color: css.getPropertyValue('--muted') }, grid: { display: false } },
        y: { ticks: { color: css.getPropertyValue('--muted'), callback: v => eur(v) }, grid: { color: css.getPropertyValue('--line') } } } },
  });
}

function viewCats() {
  // Anzahl Buchungen je Unterkategorie (im gewählten Konto, ohne offene Vorschläge)
  const cnt = new Map();
  scoped().forEach(t => { if (t.subcategory_id && t.assign_state !== 'vorschlag') cnt.set(t.subcategory_id, (cnt.get(t.subcategory_id) || 0) + 1); });
  const catCnt = c => S.subs.filter(s => s.category_id === c.id).reduce((a, s) => a + (cnt.get(s.id) || 0), 0);
  const badge = (n, filter) => `<button class="count${n ? '' : ' zero'}" data-showtx="${filter}" title="Buchungen anzeigen"${n ? '' : ' disabled'}>${n}</button>`;
  const shown = S.cats.filter(c => catVisible(c, S.acc)), hidden = S.cats.filter(c => !catVisible(c, S.acc));
  const scopeSel = c => `<select class="scope" data-scope="${c.id}" title="Für welche Konten?"><option value="">alle Konten</option>${S.accounts.map(a => `<option value="${a.id}"${c.account_id === a.id ? ' selected' : ''}>nur ${esc(a.name)}</option>`).join('')}</select>`;
  const cards = shown.map(c => `<div class="card"><h2>${esc(c.name)} ${badge(catCnt(c), c.id)}<span class="kind">${c.kind}</span>
      <button class="icon" data-rencat="${c.id}" title="Umbenennen">✎</button><button class="icon" data-delcat="${c.id}" title="Löschen">×</button></h2>
      <div style="margin:-6px 0 8px">${scopeSel(c)}</div>
      ${S.subs.filter(s => s.category_id === c.id).map(s => `<span class="chip">${esc(s.name)} ${badge(cnt.get(s.id) || 0, 'sub:' + s.id)}<button class="icon" data-rensub="${s.id}">✎</button><button class="icon" data-delsub="${s.id}">×</button></span>`).join('')}
      <div style="margin-top:8px"><button class="ghost" data-addsub="${c.id}">+ Unterkategorie</button></div></div>`).join('');
  const rules = [...S.rules.values()].filter(r => r.subcategory_id).sort((a, b) => a.match_key.localeCompare(b.match_key));
  const accCard = `<div class="card"><div class="filters"><h2 style="margin:0">Konten</h2>
      ${S.accounts.map(a => `<span class="chip">${esc(a.name)} <span class="muted">(${S.txs.filter(t => t.account_id === a.id).length})</span><button class="icon" data-renacc="${a.id}">✎</button><button class="icon" data-delacc="${a.id}">×</button></span>`).join('')}
      <button class="ghost" id="addAcc">+ Konto</button></div></div>`;
  return accCard + `<div class="card"><div class="filters"><h2 style="margin:0">Kategorien</h2>
      <input id="newCat" placeholder="Neue Kategorie"><select id="newKind"><option value="ausgabe">Ausgabe</option><option value="einnahme">Einnahme</option><option value="umbuchung">Umbuchung</option></select>
      <select id="newScope"><option value="">alle Konten</option>${S.accounts.map(a => `<option value="${a.id}"${S.acc === a.id ? ' selected' : ''}>nur ${esc(a.name)}</option>`).join('')}</select>
      <button class="btn" id="addCat">Anlegen</button></div>
      <p class="muted">„Umbuchung" (z. B. aufs Sparkonto) zählt weder als Einnahme noch als Ausgabe.</p></div>
    <div class="catgrid">${cards}</div>
    ${hidden.length ? `<p class="muted" style="margin-top:8px">Für „${esc(accById(S.acc)?.name)}" ausgeblendet: ${hidden.map(c => `${esc(c.name)} <span class="kind">(${scopeTxt(c)})</span>`).join(', ')} – sichtbar unter „Alle Konten".</p>` : ''}
    ${viewUserRules()}
    <div class="card" style="margin-top:16px"><h2>Gelernte Regeln (${rules.length})</h2>
      <p class="muted">Entstehen automatisch, wenn du eine Buchung zuordnest. Löschen = App vergisst diese Zuordnung.</p>
      ${rules.length ? `<div class="tablewrap"><table><thead><tr><th>Erkennung</th><th>Anzeigename</th><th>Kategorie</th><th class="num">Treffer</th><th></th></tr></thead><tbody>
      ${rules.map(r => { const s = subById(r.subcategory_id); return `<tr><td class="num" style="text-align:left">${esc(r.match_key)}</td><td>${esc(r.payee || '')}</td>
        <td>${s ? esc(catById(s.category_id)?.name + ' › ' + s.name) : '<span class="muted">–</span>'}</td><td class="num">${r.hits}</td>
        <td><button class="icon" data-delrule="${r.id}">×</button></td></tr>`; }).join('')}</tbody></table></div>` : ''}
    </div>`;
}

// ---------- Neu anlegen aus der Buchungsliste ----------
let ndTxId = null;
function toggleNewBox() { $('#ndNewBox').classList.toggle('hidden', $('#ndCat').value !== '__newcat'); }
function openNewDialog(txId) {
  ndTxId = txId;
  const t = S.txs.find(x => x.id === txId), cur = catOfTx(t);
  $('#ndTx').textContent = `${t.payee} · ${eur(t.amount)}`;
  $('#ndScope').innerHTML = `<option value="">Alle Konten</option>` + (accById(t.account_id) ? `<option value="${t.account_id}">nur ${esc(accById(t.account_id).name)}</option>` : '');
  $('#ndCat').innerHTML = `<option value="__newcat">＋ Neue Kategorie…</option>` +
    S.cats.filter(c => catVisible(c, t.account_id) || c.id === cur?.id).map(c => `<option value="${c.id}"${cur?.id === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  if (!cur) $('#ndCat').value = '__newcat';
  $('#ndCatName').value = ''; $('#ndSub').value = '';
  $('#ndKind').value = t.amount < 0 ? 'ausgabe' : 'einnahme';
  toggleNewBox();
  $('#newDlg').showModal();
  ($('#ndCat').value === '__newcat' ? $('#ndCatName') : $('#ndSub')).focus();
}
function closeNewDialog() { $('#newDlg').close(); ndTxId = null; render(); }

async function submitNewDialog() {
  let catId = $('#ndCat').value;
  const subName = $('#ndSub').value.trim() || 'Sonstiges';
  if (catId === '__newcat') {
    const name = $('#ndCatName').value.trim();
    if (!name) { $('#ndCatName').focus(); return; }
    const existing = S.cats.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (existing) catId = existing.id;
    else {
      const { data, error } = await sb.from('categories').insert({ name, kind: $('#ndKind').value, sort: S.cats.length, ...($('#ndScope').value ? { account_id: $('#ndScope').value } : {}) }).select().single();
      if (error) throw error;
      S.cats.push(data); catId = data.id;
    }
  }
  const want = [subName, 'Sonstiges'].filter((n, i, a) => a.indexOf(n) === i);
  for (const n of want) {
    if (S.subs.some(s => s.category_id === catId && s.name.toLowerCase() === n.toLowerCase())) continue;
    const { data, error } = await sb.from('subcategories').insert({ category_id: catId, name: n }).select().single();
    if (error) throw error;
    S.subs.push(data);
  }
  S.subs.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const sub = S.subs.find(s => s.category_id === catId && s.name.toLowerCase() === subName.toLowerCase());
  const txId = ndTxId;
  $('#newDlg').close(); ndTxId = null;
  await setCategory(txId, sub.id);
}

$('#newForm').addEventListener('submit', e => { e.preventDefault(); submitNewDialog().catch(fail); });
$('#ndCancel').onclick = closeNewDialog;
$('#newDlg').addEventListener('cancel', e => { e.preventDefault(); closeNewDialog(); });

// ---------- Eigene Regeln ----------
const FIELD_TXT = { alle: 'Empfänger oder Zweck', empfaenger: 'Empfänger', zweck: 'Verwendungszweck' };
const condTxt = r => [r.pattern ? `${FIELD_TXT[r.field]} enthält „<b>${esc(r.pattern)}</b>"` : '',
  r.purpose_pattern ? `Zweck enthält „<b>${esc(r.purpose_pattern)}</b>"` : ''].filter(Boolean).join(' <span class="muted">und</span> ');
const DIR_TXT = { beide: '', ausgabe: ' · nur Ausgaben', einnahme: ' · nur Einnahmen' };
function viewUserRules() {
  if (S.noUserRules) return `<div class="card" style="margin-top:16px"><h2>Eigene Regeln</h2>
    <p class="neg">Bitte zuerst <code>migrations/003_eigene_regeln.sql</code> im Supabase SQL Editor ausführen und die Seite neu laden.</p></div>`;
  const rows = S.userRules.map(r => {
    const s = subById(r.subcategory_id), n = S.txs.filter(t => ruleMatches(r, t)).length;
    return `<tr><td>${condTxt(r)}<span class="muted">${DIR_TXT[r.direction]}${r.account_id ? ' · ' + esc(accById(r.account_id)?.name) : ''}</span></td>
      <td>${s ? esc(catById(s.category_id)?.name + ' › ' + s.name) : '–'}</td><td>${esc(r.payee || '')}</td>
      <td class="num">${n}</td>
      <td style="white-space:nowrap"><button class="icon" data-editrule="${r.id}" title="Bearbeiten">✎</button><button class="icon" data-deluserrule="${r.id}" title="Löschen">×</button></td></tr>`;
  }).join('');
  return `<div class="card" style="margin-top:16px"><div class="filters"><h2 style="margin:0">Eigene Regeln (${S.userRules.length})</h2>
      <span class="spacer" style="flex:1"></span><button class="btn" id="addUserRule">+ Regel</button></div>
    <p class="muted">Haben Vorrang vor gelernten Regeln. Gelten beim Import und werden beim Speichern auf alle nicht manuell zugeordneten Buchungen angewendet.</p>
    ${rows ? `<div class="tablewrap"><table><thead><tr><th>Bedingung</th><th>Kategorie</th><th>Anzeigename</th><th class="num">Treffer</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}</div>`;
}

let ruId = null, ruLegacyAlle = false, ruLegacyPattern = '';
function openRuleDialog(rule = null, prefill = {}) {
  ruId = rule?.id || null;
  const r = rule || { field: 'empfaenger', direction: 'beide', account_id: null, payee: '', subcategory_id: null, pattern: '', purpose_pattern: '', ...prefill };
  $('#ruTitle').textContent = rule ? 'Regel bearbeiten' : 'Neue Regel';
  // Alte Regeln: Text stand in "Zweck" bzw. "Empfänger oder Zweck"
  let emp = r.field === 'zweck' ? '' : (r.pattern || ''), zweck = r.purpose_pattern || (r.field === 'zweck' ? r.pattern : '') || '';
  ruLegacyAlle = r.field === 'alle' && !!r.pattern;
  $('#ruLegacy').textContent = ruLegacyAlle ? 'Diese Regel sucht den Empfänger-Text bisher auch im Verwendungszweck – bleibt so, solange du das Feld nicht änderst.' : '';
  ruLegacyPattern = emp;
  $('#ruPattern').value = emp; $('#ruPurpose').value = zweck; $('#ruDir').value = r.direction;
  $('#ruAcc').innerHTML = `<option value="">Alle Konten</option>` + S.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  $('#ruAcc').value = r.account_id || '';
  $('#ruSub').innerHTML = subOptions(r.subcategory_id, false, r.account_id).replace('<option value="">– offen –</option>', '<option value="">– Kategorie wählen –</option>');
  $('#ruPayee').value = r.payee || '';
  updateRulePreview();
  $('#ruleDlg').showModal(); $('#ruPattern').focus();
}
function ruleFromDialog() {
  const emp = $('#ruPattern').value.trim(), zweck = $('#ruPurpose').value.trim();
  const keepAlle = ruLegacyAlle && emp === ruLegacyPattern;
  return { field: emp ? (keepAlle ? 'alle' : 'empfaenger') : 'zweck', pattern: emp || zweck, purpose_pattern: emp && zweck ? zweck : null,
    direction: $('#ruDir').value,
    account_id: $('#ruAcc').value || null, subcategory_id: $('#ruSub').value || null, payee: $('#ruPayee').value.trim() || null };
}
function updateRulePreview() {
  const r = ruleFromDialog();
  if (!r.pattern) { $('#ruPreview').textContent = 'Empfänger und/oder Verwendungszweck eingeben.'; return; }
  const hits = S.txs.filter(t => ruleMatches(r, t));
  const manual = hits.filter(t => t.assign_state === 'manuell').length;
  const names = [...new Set(hits.map(t => t.payee))].slice(0, 4).join(', ');
  $('#ruPreview').textContent = hits.length
    ? `${hits.length} passende Buchung(en)${manual ? `, davon ${manual} manuell zugeordnet (bleiben unverändert)` : ''} – z. B. ${names}`
    : 'Noch keine passende Buchung – gilt dann für künftige Importe.';
}
const migHint = e => /purpose_pattern/.test(e.message || '') ? new Error('Bitte migrations/004_regel_zweck.sql in Supabase ausführen') : e;
async function submitRuleDialog() {
  const r = ruleFromDialog();
  if (!r.pattern) { $('#ruPattern').focus(); return toast('Empfänger oder Verwendungszweck eingeben'); }
  if (!r.subcategory_id) { $('#ruSub').focus(); return toast('Bitte Kategorie wählen'); }
  if (ruId) {
    const { data, error } = await sb.from('user_rules').update(r).eq('id', ruId).select().single();
    if (error) throw migHint(error);
    Object.assign(S.userRules.find(x => x.id === ruId), data);
  } else {
    const { data, error } = await sb.from('user_rules').insert({ ...r, sort: S.userRules.length }).select().single();
    if (error) throw migHint(error);
    S.userRules.push(data);
  }
  $('#ruleDlg').close(); ruId = null;
  // Auf vorhandene, nicht manuell zugeordnete Buchungen anwenden
  const hits = S.txs.filter(t => t.assign_state !== 'manuell' && ruleMatches(r, t));
  const bySub = hits.filter(t => t.subcategory_id !== r.subcategory_id || t.assign_state === 'vorschlag');
  await updateTxs(bySub.map(t => t.id), { subcategory_id: r.subcategory_id, assign_state: 'auto' });
  if (r.payee) await updateTxs(hits.filter(t => t.payee !== r.payee).map(t => t.id), { payee: r.payee });
  toast(`Regel gespeichert – ${bySub.length} Buchung(en) zugeordnet`);
  render();
}
$('#ruleForm').addEventListener('submit', e => { e.preventDefault(); submitRuleDialog().catch(fail); });
$('#ruCancel').onclick = () => { $('#ruleDlg').close(); ruId = null; };
['ruPattern', 'ruPurpose', 'ruDir', 'ruAcc'].forEach(id => $('#' + id).addEventListener('input', updateRulePreview));
$('#edRule').onclick = () => {
  const t = S.txs.find(x => x.id === edId); if (!t) return;
  $('#editDlg').close(); edId = null;
  const party = P.isProcessor(t.counterparty_raw) ? '' : (t.counterparty_raw || '').split('/')[0].trim();
  openRuleDialog(null, { field: party ? 'empfaenger' : 'zweck', pattern: party || P.displayName(t.counterparty_raw, t.purpose).replace(/^PayPal$/, ''), subcategory_id: t.subcategory_id,
    direction: t.amount < 0 ? 'ausgabe' : 'einnahme' });
};

// ---------- Buchung bearbeiten ----------
let edId = null;
function openEditDialog(id) {
  const t = S.txs.find(x => x.id === id); edId = id;
  $('#edOrig').textContent = `Original: ${t.counterparty_raw || '–'} · ${t.tx_type || ''}`;
  $('#edDate').value = t.booking_date;
  $('#edAmount').value = t.amount.toFixed(2).replace('.', ',');
  $('#edPayee').value = t.payee; $('#edPurpose').value = t.purpose;
  $('#edAcc').innerHTML = S.accounts.map(a => `<option value="${a.id}"${a.id === t.account_id ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  $('#edSub').innerHTML = subOptions(t.subcategory_id, false, t.account_id);
  $('#editDlg').showModal();
}
async function submitEditDialog() {
  const t = S.txs.find(x => x.id === edId);
  const amount = P.parseAmount($('#edAmount').value);
  if (isNaN(amount)) { $('#edAmount').focus(); return toast('Betrag ungültig'); }
  const patch = { booking_date: $('#edDate').value, amount, purpose: $('#edPurpose').value.trim(), account_id: $('#edAcc').value };
  // Kontowechsel: Fingerabdruck mitziehen, damit ein späterer Import ins neue Konto nicht doppelt
  if (patch.account_id !== t.account_id) patch.hash = patch.account_id + '|' + t.hash.slice(t.hash.indexOf('|') + 1);
  const payee = $('#edPayee').value, sub = $('#edSub').value || null;
  $('#editDlg').close(); edId = null;
  await updateTxs([t.id], patch);
  if (payee.trim() && payee.trim() !== t.payee) await setPayee(t.id, payee);
  if (sub !== t.subcategory_id) await setCategory(t.id, sub);
  else { toast('Gespeichert'); render(); }
}
$('#editForm').addEventListener('submit', e => { e.preventDefault(); submitEditDialog().catch(fail); });
$('#edCancel').onclick = () => { $('#editDlg').close(); edId = null; };

// ---------- Render & Events ----------
function render() {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === S.view));
  const open = scoped().filter(t => !t.subcategory_id || t.assign_state === 'vorschlag').length;
  const badge = $('#openBadge'); badge.textContent = open; badge.classList.toggle('hidden', !open);
  $('#accSel').innerHTML = `<option value="alle">Alle Konten</option>` + S.accounts.map(a => `<option value="${a.id}"${a.id === S.acc ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  if (S.acc === 'alle') $('#accSel').value = 'alle';
  const v = { import: viewImport, tx: viewTx, year: viewYear, compare: viewCompare, cats: viewCats }[S.view];
  $('#view').innerHTML = v();
  if (S.view === 'compare') drawCompareChart();
  if (S.view === 'import') bindImport();
}

function bindImport() {
  const drop = $('#drop'), input = $('#file');
  const run = async files => {
    $('#importResult').innerHTML = '<p class="muted">Importiere…</p>';
    try {
      let msg = '';
      for (const f of files) {
        const r = await importFile(f, $('#impAcc').value);
        if (r.aborted) { msg += `<p class="muted">${esc(f.name)}: Import abgebrochen.</p>`; continue; }
        msg += `<div class="stats"><div><span class="muted">${esc(f.name)} → ${esc(accById($('#impAcc').value)?.name)}</span></div>
          <div><b>${r.fresh}</b>neu</div><div><b>${r.dup}</b>schon vorhanden</div>${r.check ? `<div><b class="neg">${r.check}</b>prüfen (s. unten)</div>` : ''}<div><b>${r.auto}</b>automatisch zugeordnet</div>
          <div><b>${r.sugg}</b>Vorschläge</div><div><b>${r.open}</b>offen</div>${r.skippedPending ? `<div><b>${r.skippedPending}</b>vorgemerkt (übersprungen)</div>` : ''}</div>`;
      }
      render();
      $('#importResult').innerHTML = msg + `<p><button class="btn" id="goOpen">Offene Buchungen zuordnen</button></p>`;
      $('#goOpen').onclick = () => { S.view = 'tx'; S.f = { year: 'alle', month: 'alle', cat: 'offen', q: '' }; render(); };
    } catch (e) { $('#importResult').innerHTML = `<p class="neg">${esc(e.message)}</p>`; }
  };
  input.onchange = () => run([...input.files]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); run([...e.dataTransfer.files]); };
}

const guard = fn => (...a) => Promise.resolve(fn(...a)).catch(fail);

document.addEventListener('change', guard(async e => {
  const t = e.target;
  if (t.dataset.sub) return t.value === '__new' ? openNewDialog(t.dataset.sub) : setCategory(t.dataset.sub, t.value);
  if (t.id === 'ndCat') return toggleNewBox();
  if (t.dataset.scope) {
    const c = catById(t.dataset.scope), account_id = t.value || null;
    const { error } = await sb.from('categories').update({ account_id }).eq('id', c.id);
    if (error) { render(); throw /account_id/.test(error.message) ? new Error('Bitte migrations/005_kategorie_konto.sql in Supabase ausführen') : error; }
    c.account_id = account_id; toast(`${c.name}: ${scopeTxt(c)}`); return render();
  }
  if (t.id === 'edAcc') { const cur = $('#edSub').value; $('#edSub').innerHTML = subOptions(cur, false, t.value); $('#edSub').value = cur; return; }
  if (t.id === 'ruAcc') { const cur = $('#ruSub').value; $('#ruSub').innerHTML = subOptions(cur, false, t.value || null).replace('<option value="">– offen –</option>', '<option value="">– Kategorie wählen –</option>'); $('#ruSub').value = cur; return; }
  if (t.dataset.payee) return setPayee(t.dataset.payee, t.value);
  if (t.id === 'fYear') { S.f.year = t.value; return render(); }
  if (t.id === 'fMonth') { S.f.month = t.value; return render(); }
  if (t.id === 'fCat') { S.f.cat = t.value; return render(); }
  if (t.id === 'ySel') { S.yearSel = +t.value; return render(); }
  if (t.id === 'accSel') { S.acc = t.value; try { localStorage.setItem('fin_acc', S.acc); } catch {} return render(); }
  if (t.id === 'impAcc') { S.importAcc = t.value; return; }
}));

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset.payee) e.target.blur();
});

let qTimer;
document.addEventListener('input', e => {
  if (e.target.id !== 'fQ') return;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { S.f.q = e.target.value; render(); const q = $('#fQ'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 250);
});

document.addEventListener('click', guard(async e => {
  const dr = e.target.closest('td[data-drill]');
  if (dr) {
    const [key, m] = dr.dataset.drill.split('|');
    S.view = 'tx'; S.f = { year: String(S.yearSel), month: m === '0' ? 'alle' : m, cat: key, q: '' };
    return render();
  }
  const b = e.target.closest('button, tr[data-exp]'); if (!b) return;
  const d = b.dataset;
  if (d.view) { S.view = d.view; return render(); }
  if (d.exp) { S.expanded.has(d.exp) ? S.expanded.delete(d.exp) : S.expanded.add(d.exp); return render(); }
  if (d.ok) { const t = S.txs.find(x => x.id === d.ok); return setCategory(t.id, t.subcategory_id); }
  if (d.del) return deleteTx(d.del);
  if (d.edit) return openEditDialog(d.edit);
  if (d.showtx) { S.view = 'tx'; S.f = { year: 'alle', month: 'alle', cat: d.showtx, q: '' }; return render(); }
  if (d.dupimp) return resolveDups([+d.dupimp], true);
  if (d.dupskip) return resolveDups([+d.dupskip], false);
  if (d.dupall) return resolveDups(S.dupReview.map((_, i) => i), d.dupall === 'imp');
  if (b.id === 'addCat') {
    const name = $('#newCat').value.trim(); if (!name) return;
    const { data, error } = await sb.from('categories').insert({ name, kind: $('#newKind').value, sort: S.cats.length, ...($('#newScope').value ? { account_id: $('#newScope').value } : {}) }).select().single();
    if (error) throw error;
    const s = await sb.from('subcategories').insert({ category_id: data.id, name: 'Sonstiges' }).select().single();
    if (s.error) throw s.error;
    S.cats.push(data); S.subs.push(s.data); return render();
  }
  if (d.addsub) {
    const name = prompt('Name der Unterkategorie'); if (!name?.trim()) return;
    const { data, error } = await sb.from('subcategories').insert({ category_id: d.addsub, name: name.trim() }).select().single();
    if (error) throw error;
    S.subs.push(data); return render();
  }
  if (d.rencat || d.rensub) {
    const tbl = d.rencat ? 'categories' : 'subcategories', id = d.rencat || d.rensub;
    const obj = (d.rencat ? S.cats : S.subs).find(x => x.id === id);
    const name = prompt('Neuer Name', obj.name); if (!name?.trim()) return;
    const { error } = await sb.from(tbl).update({ name: name.trim() }).eq('id', id);
    if (error) throw error;
    obj.name = name.trim(); return render();
  }
  if (d.delcat || d.delsub) {
    const id = d.delcat || d.delsub;
    const subIds = d.delcat ? S.subs.filter(s => s.category_id === id).map(s => s.id) : [id];
    const hit = S.txs.filter(t => subIds.includes(t.subcategory_id));
    const per = S.accounts.map(a => [a.name, hit.filter(t => t.account_id === a.id).length]).filter(([, n]) => n);
    const nRules = [...S.rules.values()].filter(r => subIds.includes(r.subcategory_id)).length + S.userRules.filter(r => subIds.includes(r.subcategory_id)).length;
    const label = d.delcat ? `Kategorie „${catById(id).name}"` : `Unterkategorie „${subById(id).name}"`;
    const msg = `${label} löschen?\n\nGilt für alle Konten.\n` +
      (hit.length ? `${hit.length} Buchung(en) werden wieder „offen": ${per.map(([a, n]) => `${n} ${a}`).join(', ')}.\n` : 'Keine Buchungen betroffen.\n') +
      (nRules ? `${nRules} Regel(n) werden mitgelöscht.` : '');
    if (!confirm(msg)) return;
    const { error } = await sb.from(d.delcat ? 'categories' : 'subcategories').delete().eq('id', id);
    if (error) throw error;
    await loadAll(); return render();
  }
  if (b.id === 'addAcc') {
    const name = prompt('Name des Kontos'); if (!name?.trim()) return;
    const { data, error } = await sb.from('accounts').insert({ name: name.trim(), sort: S.accounts.length }).select().single();
    if (error) throw error;
    S.accounts.push(data); return render();
  }
  if (d.renacc) {
    const a = accById(d.renacc), name = prompt('Neuer Name', a.name); if (!name?.trim()) return;
    const { error } = await sb.from('accounts').update({ name: name.trim() }).eq('id', a.id);
    if (error) throw error;
    a.name = name.trim(); return render();
  }
  if (d.delacc) {
    const a = accById(d.delacc), n = S.txs.filter(t => t.account_id === a.id).length;
    if (!confirm(`Konto „${a.name}" löschen?${n ? ` Dabei werden ${n} Buchung(en) endgültig gelöscht!` : ''}`)) return;
    const { error } = await sb.from('accounts').delete().eq('id', a.id);
    if (error) throw error;
    await loadAll(); return render();
  }
  if (b.id === 'addUserRule') return openRuleDialog();
  if (d.editrule) return openRuleDialog(S.userRules.find(r => r.id === d.editrule));
  if (d.deluserrule) {
    if (!confirm('Regel löschen? Bereits zugeordnete Buchungen bleiben zugeordnet.')) return;
    const { error } = await sb.from('user_rules').delete().eq('id', d.deluserrule);
    if (error) throw error;
    S.userRules = S.userRules.filter(r => r.id !== d.deluserrule); return render();
  }
  if (d.delrule) {
    const { error } = await sb.from('rules').delete().eq('id', d.delrule);
    if (error) throw error;
    for (const [k, r] of S.rules) if (r.id === d.delrule) S.rules.delete(k);
    return render();
  }
}));

// ---------- Start ----------
async function start() {
  if (cfg.SUPABASE_URL.includes('DEIN-PROJEKT')) {
    document.body.innerHTML = '<div class="login card"><h2>Fast fertig</h2><p>Trage in <code>config.js</code> die Supabase-URL und den Anon-Key ein.</p></div>';
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { $('#login').classList.remove('hidden'); return; }
  $('#app').classList.remove('hidden');
  $('#view').innerHTML = '<p class="muted">Lade…</p>';
  try { S.acc = localStorage.getItem('fin_acc') || 'alle'; } catch {}
  try { await loadAll(); } catch (e) { return fail(e); }
  S.view = S.txs.length ? 'tx' : 'import';
  render();
}

$('#loginBtn').onclick = async () => {
  const { error } = await sb.auth.signInWithPassword({ email: $('#email').value, password: $('#pw').value });
  if (error) { $('#loginMsg').textContent = 'Anmeldung fehlgeschlagen.'; return; }
  $('#login').classList.add('hidden'); start();
};
$('#pw').onkeydown = e => { if (e.key === 'Enter') $('#loginBtn').click(); };
$('#logout').onclick = async () => { await sb.auth.signOut(); location.reload(); };

start();
