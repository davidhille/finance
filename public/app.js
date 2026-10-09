/* Haushaltsbuch – App-Logik */
const P = window.FinParser;
const cfg = window.FIN_CONFIG;
const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const S = { userRules: [], noUserRules: false, dupReview: [], accounts: [], acc: 'alle', cats: [], subs: [], txs: [], rules: new Map(), view: 'home',
  f: { year: 'alle', month: 'alle', cat: 'offen', sub: '', tag: '', q: '' }, yearSel: null, expanded: new Set(),
  sel: new Set(), from: null, homeMonth: null, showEnded: false };
const F0 = { year: 'alle', month: 'alle', cat: 'alle', sub: '', tag: '', q: '', ids: null, idsLabel: '' };

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
// Fehlende Spalten → Hinweis auf Migration 007
const mig7 = e => /\b(note|tags|budget)\b/.test(e?.message || '') ? new Error('Bitte migrations/007_notizen_tags_budget.sql in Supabase ausführen') : e;
const subById = id => S.subs.find(s => s.id === id);
const catById = id => S.cats.find(c => c.id === id);
const catOfTx = t => { const s = subById(t.subcategory_id); return s ? catById(s.category_id) : null; };
const keyOf = t => P.keyFor(t);
const accById = id => S.accounts.find(a => a.id === id);
// Unterkategorien alphabetisch, "Sonstiges" immer zuletzt
const subCmp = (a, b) => (a.name === 'Sonstiges') - (b.name === 'Sonstiges') || a.name.localeCompare(b.name, 'de');
const sortSubs = () => S.subs.sort(subCmp);
// Kategorie sichtbar für Konto? (account_id leer = alle Konten)
const catVisible = (c, accId) => !c.account_id || !accId || accId === 'alle' || c.account_id === accId;
// Unterkategorie für das Konto der Buchung erlaubt?
const subAllowed = (subId, accId) => { const s = subById(subId), c = catById(s?.category_id); return !!c && catVisible(c, accId) && catVisible(s, accId); };
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
  S.accounts = a.data; S.cats = c.data; S.subs = s.data; sortSubs();
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
    if (ur && subAllowed(ur.subcategory_id, accountId)) { r.subcategory_id = ur.subcategory_id; r.assign_state = 'auto'; if (ur.payee) r.payee = ur.payee; continue; }
    const m = findRule(keyOf(r));
    if (m && m.rule.subcategory_id && subAllowed(m.rule.subcategory_id, accountId)) {
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
  const others = S.txs.filter(x => x.id !== id && x.assign_state !== 'manuell' && keyOf(x) === key && x.subcategory_id !== subId && subAllowed(subId, x.account_id));
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
    for (const s of S.subs.filter(s => s.category_id === c.id && (catVisible(s, accId) || s.id === selected)))
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

// Betragssuche: "36,73" · "-36,73" · "36" (36,00–36,99) · ">100" · "<=20" · "50-100" / "50..100" / "50 bis 100"
function num(sv) {
  sv = sv.replace(/[€\s]/g, '');
  if (sv.includes(',')) sv = sv.replace(/\./g, '').replace(',', '.');
  else if (!/^[+-]?\d+\.\d{1,2}$/.test(sv)) sv = sv.replace(/\./g, '');
  return sv === '' || isNaN(+sv) ? NaN : +sv;
}
function amountMatcher(q) {
  const x = q.trim().replace(/€/g, '').trim();
  let m;
  if ((m = /^(<=|>=|<|>)\s*([\d.,]+)$/.exec(x))) {
    const v = num(m[2]); if (isNaN(v)) return null;
    return a => { a = Math.abs(a); return m[1] === '<' ? a < v : m[1] === '<=' ? a <= v : m[1] === '>' ? a > v : a >= v; };
  }
  if ((m = /^([\d.,]+)\s*(?:-|–|\.\.|bis)\s*([\d.,]+)$/.exec(x))) {
    const lo = num(m[1]), hi = num(m[2]); if (isNaN(lo) || isNaN(hi)) return null;
    return a => Math.abs(a) >= Math.min(lo, hi) && Math.abs(a) <= Math.max(lo, hi);
  }
  if ((m = /^([+-])?\s*([\d.,]+)$/.exec(x))) {
    const v = num(m[2]); if (isNaN(v)) return null;
    const exact = /[.,]\d{1,2}$/.test(m[2]);
    return a => (m[1] === '-' ? a < 0 : m[1] === '+' ? a > 0 : true) &&
      (exact ? Math.round(Math.abs(a) * 100) === Math.round(v * 100) : Math.floor(Math.abs(a)) === Math.floor(v));
  }
  return null;
}

// "sub:<id>" (aus Drilldown/Badges) in Kategorie + Unterkategorie aufteilen
function normFilter() {
  if (S.f.cat?.startsWith('sub:')) { const sId = S.f.cat.slice(4); S.f.sub = sId; S.f.cat = subById(sId)?.category_id || 'alle'; }
  if (S.f.sub && (S.f.cat === 'alle' || S.f.cat === 'offen' || subById(S.f.sub)?.category_id !== S.f.cat)) S.f.sub = '';
  S.f.sub = S.f.sub || ''; S.f.tag = S.f.tag || ''; S.f.q = S.f.q || '';
}
function filteredTxs() {
  normFilter();
  const { year, month, cat, sub, tag, q, ids } = S.f;
  const ql = (q || '').toLowerCase(), amt = ql.trim() ? amountMatcher(q) : null, idSet = ids ? new Set(ids) : null;
  return scoped().filter(t => {
    if (idSet && !idSet.has(t.id)) return false;
    if (tag && !(t.tags || []).includes(tag)) return false;
    if (year !== 'alle' && t.booking_date.slice(0, 4) !== year) return false;
    if (month !== 'alle' && +t.booking_date.slice(5, 7) !== +month) return false;
    if (cat === 'offen' && t.subcategory_id && t.assign_state !== 'vorschlag') return false;
    if (sub) { if (t.subcategory_id !== sub || t.assign_state === 'vorschlag') return false; }
    else if (cat !== 'alle' && cat !== 'offen' && catOfTx(t)?.id !== cat) return false;
    if (ql && !(amt ? amt(t.amount) : `${t.payee} ${t.purpose} ${t.counterparty_raw} ${t.note || ''} ${(t.tags || []).join(' ')}`.toLowerCase().includes(ql))) return false;
    return true;
  });
}

function viewTx() {
  const list = filteredTxs().sort((a, b) => b.booking_date.localeCompare(a.booking_date));
  const sum = list.reduce((a, t) => a + t.amount, 0);
  const rows = list.slice(0, 600).map(t => {
    const st = !t.subcategory_id ? '<span class="state offen">offen</span>'
      : t.assign_state === 'vorschlag' ? `<span class="state vorschlag">Vorschlag</span> <button class="icon" data-ok="${t.id}" title="Vorschlag bestätigen">✓</button>`
      : t.assign_state === 'auto' ? '<span class="state auto">auto</span>' : '';
    const tags = (t.tags || []).length ? `<div class="tags">${t.tags.map(g => `<button class="tag t" data-tagf="${esc(g)}" title="Nach Tag filtern">#${esc(g)}</button>`).join('')}</div>` : '';
    return `<tr>
      <td class="c-sel"><input type="checkbox" data-selid="${t.id}"${S.sel.has(t.id) ? ' checked' : ''} aria-label="Auswählen"></td>
      <td class="c-date num muted">${fmtDate(t.booking_date)}</td>
      ${S.acc === 'alle' ? `<td class="c-acc muted">${esc(accById(t.account_id)?.name || '–')}</td>` : ''}
      <td class="c-payee"><input class="payee" data-payee="${t.id}" value="${esc(t.payee)}" title="Original: ${esc(t.counterparty_raw)}">${tags}</td>
      <td class="c-purpose purpose" title="${esc(t.purpose)}">${esc(t.purpose)}${t.note ? `<div class="note">📝 ${esc(t.note)}</div>` : ''}</td>
      <td class="c-amt num ${sign(t.amount)}">${eur(t.amount)}</td>
      <td class="c-cat"><select data-sub="${t.id}">${subOptions(t.subcategory_id, true, t.account_id)}</select></td>
      <td class="c-state">${st}</td>
      <td class="c-act" style="white-space:nowrap"><button class="icon" data-edit="${t.id}" title="Bearbeiten">✎</button><button class="icon" data-del="${t.id}" title="Löschen">×</button></td></tr>`;
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
      </select>
      ${catById(S.f.cat) ? `<select id="fSub"><option value="">Alle Unterkategorien</option>${S.subs.filter(x => x.category_id === S.f.cat && (catVisible(x, S.acc) || x.id === S.f.sub)).map(x => `<option value="${x.id}"${S.f.sub === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
      ${allTags().length ? `<select id="fTag"><option value="">Alle Tags</option>${allTags().map(g => `<option${S.f.tag === g ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>` : ''}
      <input id="fQ" placeholder="Text oder Betrag (36,73 · >100 · 50-100)" title="Text: Empfänger/Zweck · Betrag: 36,73 genau · 36 = 36,00–36,99 · -36,73 nur Ausgaben · >100 · <=20 · 50-100" style="min-width:240px" value="${esc(S.f.q)}">
      ${S.f.ids ? `<span class="chip">${esc(S.f.idsLabel || 'Auswahl')}<button class="icon" data-clearids title="Filter entfernen">×</button></span>` : ''}
    </div>
    <div class="listhead"><span class="muted">${list.length} Buchungen · Summe <b class="num ${sign(sum)}">${eur(sum)}</b></span>
      <span class="spacer" style="flex:1"></span>
      <button class="ghost small" id="csvFiltered" title="Diese Liste als CSV (Excel) herunterladen"${list.length ? '' : ' disabled'}>⬇ CSV</button></div>
    ${list.length ? `<div class="tablewrap"><table class="txt">
      <thead><tr><th class="c-sel"><input type="checkbox" id="selAll" title="Alle sichtbaren auswählen"></th><th>Datum</th>${S.acc === 'alle' ? '<th>Konto</th>' : ''}<th>Empfänger / Auftraggeber</th><th>Verwendungszweck</th><th class="num">Betrag</th><th>Kategorie</th><th></th><th></th></tr></thead>
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

// ---------- Jahresergebnis ----------
// Kennzahlen eines Jahres, optional nur bis Monat maxMonth (für fairen Vergleich mit dem laufenden Jahr)
function yearResult(year, maxMonth = 12) {
  const r = { inc: 0, exp: 0, umb: 0, n: 0 };
  for (const t of scoped()) {
    if (+t.booking_date.slice(0, 4) !== year || +t.booking_date.slice(5, 7) > maxMonth) continue;
    r.n++;
    const c = t.subcategory_id && t.assign_state !== 'vorschlag' ? catOfTx(t) : null;
    const kind = c ? c.kind : (t.amount < 0 ? 'ausgabe' : 'einnahme');
    if (kind === 'umbuchung') r.umb += t.amount;
    else if (kind === 'einnahme') r.inc += t.amount;
    else r.exp -= t.amount;
  }
  r.result = r.inc - r.exp;
  r.rate = r.inc ? r.result / r.inc : null;
  r.change = r.result + r.umb;
  return r;
}
const lastMonthOf = year => Math.max(0, ...scoped().filter(t => +t.booking_date.slice(0, 4) === year).map(t => +t.booking_date.slice(5, 7)));
const pct = v => v === null || !isFinite(v) ? '–' : (v * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' %';
// Kennzahlen-Definition: key, Label, Format, "höher ist besser"
const METRICS = [
  ['inc', 'Einnahmen', eur, true], ['exp', 'Ausgaben', eur, false], ['result', 'Jahresergebnis', eur, true],
  ['rate', 'Sparquote', pct, true], ['umb', 'Umbuchungen (netto)', eur, null], ['change', 'Kontoveränderung', eur, true],
];
function deltaTxt(key, cur, prev, better) {
  if (prev == null || cur == null) return '';
  const d = cur - prev;
  if (!d) return '<span class="muted">±0</span>';
  const txt = key === 'rate' ? `${d > 0 ? '+' : ''}${(d * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Pkt.` : `${d > 0 ? '+' : ''}${eur(d)}`;
  const cls = better === null ? 'muted' : (d > 0) === better ? 'pos' : 'neg';
  return `<span class="${cls}">${txt}</span>`;
}
function resultTiles(year) {
  const lm = lastMonthOf(year) || 12;
  const cur = yearResult(year, lm);
  const prevHas = scoped().some(t => +t.booking_date.slice(0, 4) === year - 1);
  const prev = prevHas ? yearResult(year - 1, lm) : null;
  const span = lm < 12 ? `Jan–${MONTHS[lm - 1]}` : 'ganzes Jahr';
  return `<div class="tiles">${METRICS.map(([k, label, fmt, better]) => `<div class="tile${k === 'result' ? ' main' : ''}">
      <div class="tl">${label}</div><div class="tv ${k === 'result' || k === 'change' ? sign(cur[k]) : ''}">${fmt(cur[k])}</div>
      ${prev ? `<div class="td">${deltaTxt(k, cur[k], prev[k], better)} <span class="muted">vs. ${year - 1}</span></div>` : ''}</div>`).join('')}</div>
    <p class="muted" style="margin:6px 0 0;font-size:12px">${year}: ${span}${prev ? ` · Vergleich mit ${year - 1} im gleichen Zeitraum` : ''} · Ergebnis = Einnahmen − Ausgaben · Kontoveränderung = Ergebnis + Umbuchungen</p>`;
}

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
      rowsHtml += line('cat clickable', `${open ? '▾' : '▸'} ${esc(c.name)} <button class="icon trend" data-trend="cat:${c.id}" title="Verlauf">📈</button>`, cs, `data-exp="${c.id}"`, c.id);
      if (open) subs.forEach(s => { if (agg.has(s.id)) rowsHtml += line('sub', `${esc(s.name)} <button class="icon trend" data-trend="sub:${s.id}" title="Verlauf">📈</button>`, agg.get(s.id), '', 'sub:' + s.id); });
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
      <select id="ySel">${ys.map(v => `<option${v === year ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
    ${resultTiles(year)}
    <p class="muted" style="margin:16px 0 8px">Ausgaben positiv · Umbuchungen mit Vorzeichen · Kategorie anklicken = Unterkategorien · Betrag anklicken = Buchungen · 📈 = Verlauf</p>
    <div class="tablewrap"><table class="ytable">
      <thead><tr><th></th>${MONTHS.map(m => `<th class="num">${m}</th>`).join('')}<th class="num">Jahr</th><th class="num">Ø Monat</th></tr></thead>
      <tbody>${inc.html}${exp.html}${umb.html}
      <tr class="total"><td>Saldo</td>${saldo.map(v => `<td class="num ${sign(v)}">${v ? eur(v) : '<span class="muted">–</span>'}</td>`).join('')}<td class="num ${sign(total(saldo))}">${eur(total(saldo))}</td><td class="num muted">${eur(total(saldo) / monthsWithData)}</td></tr>
      </tbody></table></div></div>`;
}

function viewCompare() {
  const ys = years().slice().reverse();
  if (ys.length < 1) return `<div class="card muted">Noch keine Buchungen – zuerst importieren.</div>`;
  const byYear = Object.fromEntries(ys.map(y => [y, aggregate(y)]));
  const curY = ys[ys.length - 1], lm = lastMonthOf(curY) || 12, partial = lm < 12 && ys.length > 1;
  const cap = S.cmpYtd && partial ? lm : 12;
  const capSum = arr => (arr || []).slice(0, cap).reduce((x, y) => x + y, 0);
  const catSum = (c, y) => S.subs.filter(s => s.category_id === c.id).reduce((a, s) => a + capSum(byYear[y].get(s.id)), 0);
  const res = ys.map(y => yearResult(y, cap));
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
  const sumRows = METRICS.map(([k, label, fmt, better]) => `<tr class="${k === 'result' ? 'cat' : ''}"><td>${label}</td>
      ${res.map(r => `<td class="num ${k === 'result' || k === 'change' ? sign(r[k]) : ''}">${fmt(r[k])}</td>`).join('')}
      ${ys.length > 1 ? `<td class="num" colspan="2">${deltaTxt(k, res[last][k], res[last - 1][k], better)}</td>` : ''}</tr>`).join('');
  return `<div class="card"><div class="filters"><h2 style="margin:0">Jahresvergleich</h2>
      ${partial ? `<label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cmpYtd"${S.cmpYtd ? ' checked' : ''}> alle Jahre nur Jan–${MONTHS[lm - 1]} (wie ${curY})</label>` : ''}</div>
    <h2 style="margin-top:8px">Jahresergebnis</h2>
    <div class="tablewrap"><table><thead><tr><th></th>${ys.map(y => `<th class="num">${y}</th>`).join('')}
      ${ys.length > 1 ? `<th class="num" colspan="2">Δ ${ys[last]} vs ${ys[last - 1]}</th>` : ''}</tr></thead>
      <tbody>${sumRows}</tbody></table></div>
    <h2 style="margin-top:24px">Nach Kategorie</h2>
    <div style="height:320px;margin-bottom:16px"><canvas id="cmpChart"></canvas></div>
    <div class="tablewrap"><table><thead><tr><th>Kategorie</th>${ys.map(y => `<th class="num">${y}</th>`).join('')}
      ${ys.length > 1 ? `<th class="num">Δ ${ys[last]} vs ${ys[last - 1]}</th><th class="num">%</th>` : ''}</tr></thead>
      <tbody>${rows.map(r => `<tr><td>${esc(r.c.name)} <span class="kind">${r.c.kind}</span></td>${r.vals.map(v => `<td class="num">${eur(v)}</td>`).join('')}${delta(r.vals)}</tr>`).join('')}</tbody>
    </table></div>
    <p class="muted">${partial && !S.cmpYtd ? `Hinweis: ${curY} enthält erst Daten bis ${MONTHS[lm - 1]} – für einen fairen Vergleich oben „nur Jan–${MONTHS[lm - 1]}" aktivieren.` : cap < 12 ? `Alle Jahre: nur Jan–${MONTHS[cap - 1]}.` : ''}</p></div>`;
}

function drawCompareChart() {
  const el = $('#cmpChart'); if (!el || !window.Chart) return;
  const ys = years().slice().reverse();
  const exp = S.cats.filter(c => c.kind === 'ausgabe');
  const lm = lastMonthOf(ys[ys.length - 1]) || 12, cap = S.cmpYtd && lm < 12 && ys.length > 1 ? lm : 12;
  const val = (c, y) => -scoped().filter(t => +t.booking_date.slice(0, 4) === y && +t.booking_date.slice(5, 7) <= cap && t.assign_state !== 'vorschlag' && catOfTx(t)?.id === c.id).reduce((a, t) => a + t.amount, 0);
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
  const KIND = { ausgabe: 'Ausgabe', einnahme: 'Einnahme', umbuchung: 'Umbuchung' };
  const tag = x => x.account_id ? `<span class="tag" title="${esc(scopeTxt(x))}">${esc(accById(x.account_id)?.name || '?')}</span>` : '';
  const cards = shown.map(c => `<div class="card catcard">
      <div class="cathead">
        <h2 class="name" title="${esc(c.name)}">${esc(c.name)}</h2>${badge(catCnt(c), c.id)}
        <span class="acts"><button class="icon" data-trend="cat:${c.id}" title="Verlauf">📈</button><button class="icon" data-rencat="${c.id}" title="Umbenennen">✎</button><button class="icon" data-delcat="${c.id}" title="Löschen">×</button></span>
      </div>
      <div class="catmeta"><span class="kind" style="margin:0">${KIND[c.kind] || c.kind}</span>${scopeSel(c)}<span class="move"><button class="icon" data-catmove="${c.id}|-1" title="Nach vorne"${S.cats[0] === c ? ' disabled' : ''}>◀</button><button class="icon" data-catmove="${c.id}|1" title="Nach hinten"${S.cats[S.cats.length - 1] === c ? ' disabled' : ''}>▶</button></span></div>
      ${c.kind === 'ausgabe' ? `<label class="catmeta muted" style="font-size:12px">Budget pro Monat <input class="budget" data-budget="${c.id}" inputmode="decimal" placeholder="kein" value="${c.budget != null ? String(c.budget).replace('.', ',') : ''}"> €</label>` : ''}
      <div class="sublist">${S.subs.filter(s => s.category_id === c.id).map(s => `<div class="subrow${catVisible(s, S.acc) ? '' : ' dim'}">
        <span class="n" title="${esc(s.name)}">${esc(s.name)}${tag(s)}</span>${badge(cnt.get(s.id) || 0, 'sub:' + s.id)}
        <button class="icon" data-trend="sub:${s.id}" title="Verlauf">📈</button><button class="icon" data-rensub="${s.id}" title="Bearbeiten / verschieben">✎</button><button class="icon" data-delsub="${s.id}" title="Löschen">×</button></div>`).join('')}</div>
      <button class="ghost addsub" data-addsub="${c.id}">+ Unterkategorie</button></div>`).join('');
  const rules = [...S.rules.values()].filter(r => r.subcategory_id).sort((a, b) => a.match_key.localeCompare(b.match_key));
  const anchors = `<div class="filters" style="margin-bottom:12px">${[['s-konten', 'Konten'], ['s-kat', 'Kategorien'], ['s-regeln', 'Regeln'], ['s-daten', 'Daten & Backup']].map(([id, l]) => `<button class="ghost" data-jump="${id}">${l}</button>`).join('')}</div>`;
  const accCard = anchors + `<div class="card" id="s-konten"><div class="filters"><h2 style="margin:0">Konten</h2>
      ${S.accounts.map(a => `<span class="chip">${esc(a.name)} <span class="muted">(${S.txs.filter(t => t.account_id === a.id).length})</span><button class="icon" data-renacc="${a.id}">✎</button><button class="icon" data-delacc="${a.id}">×</button></span>`).join('')}
      <button class="ghost" id="addAcc">+ Konto</button></div></div>`;
  return accCard + `<div class="card" id="s-kat"><div class="filters"><h2 style="margin:0">Kategorien</h2>
      <input id="newCat" placeholder="Neue Kategorie"><select id="newKind"><option value="ausgabe">Ausgabe</option><option value="einnahme">Einnahme</option><option value="umbuchung">Umbuchung</option></select>
      <select id="newScope"><option value="">alle Konten</option>${S.accounts.map(a => `<option value="${a.id}"${S.acc === a.id ? ' selected' : ''}>nur ${esc(a.name)}</option>`).join('')}</select>
      <button class="btn" id="addCat">Anlegen</button>
      <span class="spacer" style="flex:1"></span><button class="ghost" id="sortAZ" title="Einnahmen, Ausgaben, Umbuchungen – jeweils alphabetisch">A–Z sortieren</button></div>
      <p class="muted">„Umbuchung" (z. B. aufs Sparkonto) zählt weder als Einnahme noch als Ausgabe.</p></div>
    <div class="catgrid">${cards}</div>
    ${hidden.length ? `<div class="card" style="margin-top:16px"><h2>Für „${esc(accById(S.acc)?.name)}" ausgeblendet (${hidden.length})</h2>
      <p class="muted" style="margin-top:-6px">Diese Kategorien gelten nur für ein anderes Konto. Zum Einblenden auf „alle Konten" oder dieses Konto stellen.</p>
      <div class="filters">${hidden.map(c => `<span class="chip" style="padding-right:6px">${esc(c.name)} ${scopeSel(c)}</span>`).join('')}</div></div>` : ''}
    <div id="s-regeln">${viewUserRules()}</div>
    <div class="card" style="margin-top:16px"><h2>Gelernte Regeln (${rules.length})</h2>
      <p class="muted">Entstehen automatisch, wenn du eine Buchung zuordnest. Löschen = App vergisst diese Zuordnung.</p>
      ${rules.length ? `<div class="tablewrap"><table><thead><tr><th>Erkennung</th><th>Anzeigename</th><th>Kategorie</th><th class="num">Treffer</th><th></th></tr></thead><tbody>
      ${rules.map(r => { const s = subById(r.subcategory_id); return `<tr><td class="num" style="text-align:left">${esc(r.match_key)}</td><td>${esc(r.payee || '')}</td>
        <td>${s ? esc(catById(s.category_id)?.name + ' › ' + s.name) : '<span class="muted">–</span>'}</td><td class="num">${r.hits}</td>
        <td><button class="icon" data-delrule="${r.id}">×</button></td></tr>`; }).join('')}</tbody></table></div>` : ''}
    </div>
    ${viewData()}`;
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
  sortSubs();
  const sub = S.subs.find(s => s.category_id === catId && s.name.toLowerCase() === subName.toLowerCase());
  const txId = ndTxId;
  $('#newDlg').close(); ndTxId = null;
  await setCategory(txId, sub.id);
}

$('#newForm').addEventListener('submit', e => { e.preventDefault(); submitNewDialog().catch(fail); });
$('#ndCancel').onclick = closeNewDialog;
$('#newDlg').addEventListener('cancel', e => { e.preventDefault(); closeNewDialog(); });

// ---------- Reihenfolge der Kategorien ----------
async function saveCatOrder() {
  const changed = S.cats.map((c, i) => [c, i]).filter(([c, i]) => c.sort !== i);
  for (const [c, i] of changed) {
    const { error } = await sb.from('categories').update({ sort: i }).eq('id', c.id);
    if (error) throw error;
    c.sort = i;
  }
}
async function moveCat(id, dir) {
  const i = S.cats.findIndex(c => c.id === id), j = i + dir;
  if (j < 0 || j >= S.cats.length) return;
  [S.cats[i], S.cats[j]] = [S.cats[j], S.cats[i]];
  render(); await saveCatOrder();
}
async function sortCatsAZ() {
  const order = { einnahme: 0, ausgabe: 1, umbuchung: 2 };
  S.cats.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, 'de'));
  render(); await saveCatOrder(); toast('Sortiert: Einnahmen, Ausgaben, Umbuchungen – jeweils A–Z');
}

// ---------- Auswahl-Dialog mit mehreren Knöpfen ----------
// buttons: [{ value, label, primary }]; Rückgabe: gewählter value, oder null bei Abbrechen/Esc
function askChoice(title, text, buttons) {
  return new Promise(resolve => {
    const dlg = $('#choiceDlg');
    $('#chTitle').textContent = title; $('#chText').textContent = text;
    $('#chButtons').innerHTML = [{ value: '', label: 'Abbrechen' }, ...buttons].map(b =>
      `<button type="button" class="${b.primary ? 'btn' : 'ghost'}" data-choice="${b.value}">${esc(b.label)}</button>`).join('');
    const done = v => { dlg.close(); resolve(v || null); };
    $('#chButtons').onclick = e => { const b = e.target.closest('[data-choice]'); if (b) done(b.dataset.choice); };
    dlg.oncancel = e => { e.preventDefault(); done(null); };
    dlg.showModal();
  });
}
// Vor einer Konto-Umstellung: betroffene Buchungen klären. Rückgabe 'reset' | 'keep' | null (abbrechen)
async function askScopeChange(name, newScopeTxt, orphan) {
  if (!orphan.length) return 'keep';
  const per = S.accounts.map(a => [a.name, orphan.filter(x => x.account_id === a.id).length]).filter(([, n]) => n).map(([a, n]) => `${n} ${a}`).join(', ');
  return askChoice(`„${name}" auf ${newScopeTxt} umstellen?`,
    `${orphan.length} Buchung(en) aus anderen Konten sind noch zugeordnet (${per}).\n\nWas soll mit diesen Buchungen passieren?`,
    [{ value: 'keep', label: 'Umstellen, Zuordnung behalten' }, { value: 'reset', label: 'Umstellen, Buchungen auf offen', primary: true }]);
}

// ---------- Unterkategorie bearbeiten / verschieben / zusammenführen ----------
let sdId = null;
function openSubDialog(id) {
  const s = subById(id); sdId = id;
  const n = S.txs.filter(t => t.subcategory_id === id).length;
  $('#sdInfo').textContent = `${n} Buchung(en) zugeordnet`;
  $('#sdName').value = s.name;
  $('#sdScope').innerHTML = `<option value="">alle Konten</option>` + S.accounts.map(a => `<option value="${a.id}"${s.account_id === a.id ? ' selected' : ''}>nur ${esc(a.name)}</option>`).join('');
  $('#sdCat').innerHTML = S.cats.map(c => `<option value="${c.id}"${c.id === s.category_id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  $('#sdMerge').innerHTML = '<option value="">– nicht zusammenführen –</option>' + S.cats.map(c =>
    `<optgroup label="${esc(c.name)}">${S.subs.filter(x => x.category_id === c.id && x.id !== id).map(x => `<option value="${x.id}">${esc(c.name)} › ${esc(x.name)}</option>`).join('')}</optgroup>`).join('');
  syncSubDialog();
  $('#subDlg').showModal(); $('#sdName').focus();
}
function syncSubDialog() {
  const merge = !!$('#sdMerge').value;
  $('#sdName').disabled = merge; $('#sdCat').disabled = merge; $('#sdScope').disabled = merge;
  $('#sdSave').textContent = merge ? 'Zusammenführen' : 'Speichern';
}
async function submitSubDialog() {
  const s = subById(sdId), target = $('#sdMerge').value;
  if (target) {
    const t = subById(target), n = S.txs.filter(x => x.subcategory_id === s.id).length;
    if (!confirm(`„${s.name}" mit „${catById(t.category_id).name} › ${t.name}" zusammenführen?\n${n} Buchung(en) und zugehörige Regeln werden verschoben, „${s.name}" wird gelöscht.`)) return;
    for (const tbl of ['transactions', 'user_rules']) {
      const { error } = await sb.from(tbl).update({ subcategory_id: target }).eq('subcategory_id', s.id);
      if (error && !(tbl === 'user_rules' && S.noUserRules)) throw error;
    }
    // Gelernte Regeln: umhängen
    const r = await sb.from('rules').update({ subcategory_id: target }).eq('subcategory_id', s.id);
    if (r.error) throw r.error;
    const d = await sb.from('subcategories').delete().eq('id', s.id);
    if (d.error) throw d.error;
    $('#subDlg').close(); sdId = null;
    await loadAll(); toast(`Zusammengeführt – ${n} Buchung(en) verschoben`); return render();
  }
  const name = $('#sdName').value.trim(), category_id = $('#sdCat').value;
  if (!name) return $('#sdName').focus();
  if (S.subs.some(x => x.id !== s.id && x.category_id === category_id && x.name.toLowerCase() === name.toLowerCase()))
    return toast(`„${name}" gibt es dort schon – zum Zusammenführen unten auswählen`);
  const account_id = $('#sdScope').value || null;
  const next = { ...s, account_id };
  const orphan = S.txs.filter(x => x.subcategory_id === s.id && !catVisible(next, x.account_id));
  $('#subDlg').close();
  const choice = await askScopeChange(name, scopeTxt(next), orphan);
  if (!choice) { $('#subDlg').showModal(); return; }
  const { error } = await sb.from('subcategories').update({ name, category_id, account_id }).eq('id', s.id);
  if (error) throw /account_id/.test(error.message) ? new Error('Bitte migrations/006_unterkategorie_konto.sql in Supabase ausführen') : error;
  const moved = category_id !== s.category_id;
  Object.assign(s, { name, category_id, account_id });
  sdId = null;
  if (choice === 'reset') await updateTxs(orphan.map(x => x.id), { subcategory_id: null, assign_state: null });
  toast(moved ? `Verschoben nach ${catById(category_id).name}` : 'Gespeichert'); render();
}
$('#subForm').addEventListener('submit', e => { e.preventDefault(); submitSubDialog().catch(fail); });
$('#sdCancel').onclick = () => { $('#subDlg').close(); sdId = null; };
$('#sdMerge').addEventListener('change', syncSubDialog);

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
  const hits = S.txs.filter(t => t.assign_state !== 'manuell' && ruleMatches(r, t) && subAllowed(r.subcategory_id, t.account_id));
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
  $('#edTags').value = (t.tags || []).join(', '); $('#edNote').value = t.note || '';
  $('#editDlg').showModal();
}
async function submitEditDialog() {
  const t = S.txs.find(x => x.id === edId);
  const amount = P.parseAmount($('#edAmount').value);
  if (isNaN(amount)) { $('#edAmount').focus(); return toast('Betrag ungültig'); }
  const patch = { booking_date: $('#edDate').value, amount, purpose: $('#edPurpose').value.trim(), account_id: $('#edAcc').value };
  // Kontowechsel: Fingerabdruck mitziehen, damit ein späterer Import ins neue Konto nicht doppelt
  if (patch.account_id !== t.account_id) patch.hash = patch.account_id + '|' + t.hash.slice(t.hash.indexOf('|') + 1);
  const tags = parseTags($('#edTags').value), note = $('#edNote').value.trim() || null;
  if (note !== (t.note || null) || tags.join('|') !== (t.tags || []).join('|')) Object.assign(patch, { tags, note });
  const payee = $('#edPayee').value, sub = $('#edSub').value || null;
  $('#editDlg').close(); edId = null;
  try { await updateTxs([t.id], patch); } catch (e) { throw mig7(e); }
  if (payee.trim() && payee.trim() !== t.payee) await setPayee(t.id, payee);
  if (sub !== t.subcategory_id) await setCategory(t.id, sub);
  else { toast('Gespeichert'); render(); }
}
$('#editForm').addEventListener('submit', e => { e.preventDefault(); submitEditDialog().catch(fail); });
$('#edCancel').onclick = () => { $('#editDlg').close(); edId = null; };

// ---------- Navigation (Zurück-Taste, Verlauf) ----------
function snapshot() { return { view: S.view, f: { ...S.f }, yearSel: S.yearSel, from: S.from, homeMonth: S.homeMonth }; }
function go(view, opts = {}) {
  try { history.replaceState({ ...snapshot(), scroll: window.scrollY }, '', '#' + S.view); } catch {}
  S.view = view;
  if (opts.f) S.f = { ...F0, ...opts.f };
  if (opts.yearSel) S.yearSel = opts.yearSel;
  S.from = opts.from || null;
  S.sel.clear();
  try { history.pushState(snapshot(), '', '#' + view); } catch {}
  render(); window.scrollTo(0, 0);
}
window.addEventListener('popstate', e => {
  const st = e.state; if (!st || !st.view) return;
  Object.assign(S, { view: st.view, f: { ...F0, ...st.f }, yearSel: st.yearSel, from: st.from || null, homeMonth: st.homeMonth || S.homeMonth });
  S.sel.clear(); render();
  requestAnimationFrame(() => window.scrollTo(0, st.scroll || 0));
});
// Adresse direkt geändert (z. B. Lesezeichen, #tx eingetippt)
window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (h !== S.view && ['home', 'tx', 'year', 'compare', 'fix', 'cats', 'import'].includes(h) && !history.state?.view) {
    S.view = h; S.from = null; S.sel.clear();
    try { history.replaceState(snapshot(), '', '#' + h); } catch {}
    render();
  }
});
const backBar = () => S.from ? `<div class="backbar"><button data-back>← ${esc(S.from)}</button></div>` : '';
const FROM = { home: 'Zurück zur Übersicht', year: () => `Zurück zur Jahresübersicht ${S.yearSel}`, cats: 'Zurück zu Einstellungen', fix: 'Zurück zu Fixkosten', compare: 'Zurück zum Vergleich' };
const fromLabel = () => { const f = FROM[S.view]; return typeof f === 'function' ? f() : f || null; };

// ---------- Tags ----------
const allTags = () => [...new Set(S.txs.flatMap(t => t.tags || []))].sort((a, b) => a.localeCompare(b, 'de'));
const parseTags = v => [...new Set((v || '').split(',').map(x => x.trim().replace(/^#/, '')).filter(Boolean))];

// ---------- Mehrfachauswahl ----------
function renderBulk() {
  const bar = $('#bulkbar');
  if (S.view !== 'tx' || !S.sel.size) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  const sel = S.txs.filter(t => S.sel.has(t.id)), sum = sel.reduce((a, t) => a + t.amount, 0);
  bar.innerHTML = `<b>${sel.length} ausgewählt</b><span class="num">${eur(sum)}</span>
    <select id="bulkSub">${subOptions(null, false, S.acc).replace('<option value="">– offen –</option>', '<option value="">Kategorie wählen…</option><option value="__open">– auf offen setzen –</option>')}</select>
    <button class="btn small" id="bulkAssign">Zuordnen</button>
    <input id="bulkTag" list="tagList" placeholder="Tag" style="width:120px"><button class="ghost" id="bulkTagAdd">+ Tag</button>
    <button class="ghost" id="bulkDel">Löschen</button><button class="ghost" id="bulkClear" title="Auswahl aufheben">✕</button>`;
  bar.classList.remove('hidden');
}
async function bulkAssign() {
  const v = $('#bulkSub').value; if (!v) return toast('Bitte Kategorie wählen');
  const sel = S.txs.filter(t => S.sel.has(t.id));
  if (v === '__open') { await updateTxs(sel.map(t => t.id), { subcategory_id: null, assign_state: null }); toast(`${sel.length} Buchung(en) auf offen gesetzt`); }
  else {
    const ok = sel.filter(t => subAllowed(v, t.account_id)), skip = sel.length - ok.length;
    await updateTxs(ok.map(t => t.id), { subcategory_id: v, assign_state: 'manuell' });
    toast(`${ok.length} Buchung(en) zugeordnet${skip ? ` – ${skip} übersprungen (Kategorie für deren Konto ausgeblendet)` : ''}`);
  }
  S.sel.clear(); render();
}
async function bulkTag() {
  const tags = parseTags($('#bulkTag').value); if (!tags.length) return $('#bulkTag').focus();
  const sel = S.txs.filter(t => S.sel.has(t.id));
  for (let i = 0; i < sel.length; i += 20) {
    await Promise.all(sel.slice(i, i + 20).map(async t => {
      const next = [...new Set([...(t.tags || []), ...tags])];
      const { error } = await sb.from('transactions').update({ tags: next }).eq('id', t.id);
      if (error) throw mig7(error);
      t.tags = next;
    }));
  }
  toast(`Tag ${tags.map(g => '#' + g).join(' ')} bei ${sel.length} Buchung(en) gesetzt`); render();
}
async function bulkDelete() {
  const ids = [...S.sel];
  if (!confirm(`${ids.length} Buchung(en) endgültig löschen?\n\nBeim nächsten Import derselben Datei würden sie wieder auftauchen.`)) return;
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await sb.from('transactions').delete().in('id', ids.slice(i, i + 200));
    if (error) throw error;
  }
  S.txs = S.txs.filter(t => !S.sel.has(t.id)); S.sel.clear(); toast(`${ids.length} gelöscht`); render();
}

// ---------- Übersicht (Startseite) ----------
const ymOf = d => d.slice(0, 7);
const ymAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const ymLabel = ym => `${['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'][+ym.slice(5) - 1]} ${ym.slice(0, 4)}`;
function kindOf(t) {
  const c = t.subcategory_id && t.assign_state !== 'vorschlag' ? catOfTx(t) : null;
  return c ? c.kind : (t.amount < 0 ? 'ausgabe' : 'einnahme');
}
function periodResult(list) {
  const r = { inc: 0, exp: 0, umb: 0 };
  for (const t of list) { const k = kindOf(t); if (k === 'umbuchung') r.umb += t.amount; else if (k === 'einnahme') r.inc += t.amount; else r.exp -= t.amount; }
  r.result = r.inc - r.exp; return r;
}
function barRow({ label, value, budget, max, click, trend, sub }) {
  const ratio = budget ? value / budget : (max ? value / max : 0);
  const cls = budget ? (ratio > 1 ? 'over' : ratio > 0.8 ? 'warn' : '') : '';
  const fill = Math.min(100, Math.max(0, ratio * 100));
  return `<div class="bar"><div class="bl"><span><button class="linkbtn" ${click}>${label}</button>${trend ? ` <button class="icon trend" data-trend="${trend}" title="Verlauf">📈</button>` : ''}</span>
    <span class="bv">${eur(value)}${budget ? ` <span class="muted">von ${eur(budget)}</span>` : ''}</span></div>
    <div class="bt"><div class="bf ${cls}" style="width:${fill}%;${budget ? '' : 'opacity:.55'}"></div></div>${sub ? `<div class="note">${sub}</div>` : ''}</div>`;
}
function viewHome() {
  const all = scoped();
  if (!all.length) return `<div class="card"><h2>Willkommen</h2><p>Noch keine Buchungen. Starte mit dem Import deiner DKB-CSV.</p><button class="btn" data-view="import">Jetzt importieren</button></div>`;
  const latest = all.reduce((m, t) => t.booking_date > m ? t.booking_date : m, '0000');
  if (!S.homeMonth) S.homeMonth = ymOf(latest);
  const ym = S.homeMonth, y = +ym.slice(0, 4), mNum = +ym.slice(5);
  const inMonth = all.filter(t => ymOf(t.booking_date) === ym), prev = all.filter(t => ymOf(t.booking_date) === ymAdd(ym, -1));
  const r = periodResult(inMonth), p = periodResult(prev), hasPrev = prev.length > 0;
  const tile = (label, k, better, main) => `<div class="tile${main ? ' main' : ''}"><div class="tl">${label}</div><div class="tv ${k === 'result' ? sign(r[k]) : ''}">${eur(r[k])}</div>
    ${hasPrev ? `<div class="td">${deltaTxt(k, r[k], p[k], better)} <span class="muted">vs. Vormonat</span></div>` : ''}</div>`;
  const open = all.filter(t => !t.subcategory_id || t.assign_state === 'vorschlag').length;
  // Ausgaben je Kategorie im Monat + Budgets
  const spent = new Map(), ytd = new Map();
  for (const t of all) {
    const c = t.subcategory_id && t.assign_state !== 'vorschlag' ? catOfTx(t) : null;
    if (!c || c.kind !== 'ausgabe') continue;
    if (ymOf(t.booking_date) === ym) spent.set(c.id, (spent.get(c.id) || 0) - t.amount);
    if (+t.booking_date.slice(0, 4) === y && +t.booking_date.slice(5, 7) <= mNum) ytd.set(c.id, (ytd.get(c.id) || 0) - t.amount);
  }
  const unassigned = -inMonth.filter(t => kindOf(t) === 'ausgabe' && !(t.subcategory_id && t.assign_state !== 'vorschlag')).reduce((a, t) => a + t.amount, 0);
  const expCats = S.cats.filter(c => c.kind === 'ausgabe' && (spent.get(c.id) || c.budget > 0))
    .sort((a, b) => (spent.get(b.id) || 0) - (spent.get(a.id) || 0));
  const maxSpent = Math.max(1, ...expCats.map(c => spent.get(c.id) || 0));
  const bars = expCats.map(c => barRow({ label: esc(c.name), value: spent.get(c.id) || 0, budget: c.budget > 0 ? +c.budget : null, max: maxSpent,
    click: `data-hometx="${c.id}"`, trend: 'cat:' + c.id,
    sub: c.budget > 0 ? `${y} bis ${MONTHS[mNum - 1]}: ${eur(ytd.get(c.id) || 0)} von ${eur(c.budget * mNum)}` : '' })).join('');
  const budgetSum = S.cats.filter(c => c.kind === 'ausgabe' && c.budget > 0).reduce((a, c) => a + +c.budget, 0);
  // Fixkosten-Kurzinfo
  const fx = detectRecurring().filter(x => x.active);
  const fxOut = fx.filter(x => x.kind === 'ausgabe'), fxMonth = fxOut.reduce((a, x) => a + x.perMonth, 0);
  // Tags
  const tagStats = allTags().map(g => { const l = all.filter(t => (t.tags || []).includes(g)); return { g, n: l.length, sum: l.reduce((a, t) => a + t.amount, 0) }; });
  const recent = all.slice().sort((a, b) => b.booking_date.localeCompare(a.booking_date)).slice(0, 8);
  return `<div class="filters"><div class="monthnav"><button class="icon" data-hm="-1" title="Vormonat">◀</button><b>${ymLabel(ym)}</b><button class="icon" data-hm="1" title="Nächster Monat"${ym >= ymOf(latest) ? ' disabled' : ''}>▶</button></div>
      <span class="muted">${inMonth.length} Buchungen</span></div>
    ${open ? `<div class="callout"><span><b>${open}</b> Buchung(en) noch nicht zugeordnet.</span><button class="btn small" data-gotx="offen">Jetzt zuordnen</button></div>` : ''}
    <div class="card"><div class="tiles" style="margin-top:0">${tile('Einnahmen', 'inc', true)}${tile('Ausgaben', 'exp', false)}${tile('Ergebnis', 'result', true, true)}${tile('Umbuchungen', 'umb', null)}</div></div>
    <div class="grid2">
      <div class="card"><div class="filters"><h2 style="margin:0">Ausgaben nach Kategorie</h2><span class="spacer" style="flex:1"></span>${budgetSum ? `<span class="muted">Budgets: ${eur(budgetSum)}/Monat</span>` : ''}</div>
        <div class="bars">${bars || '<p class="muted">Keine zugeordneten Ausgaben in diesem Monat.</p>'}
        ${unassigned > 0 ? barRow({ label: '<span class="state offen">nicht zugeordnet</span>', value: unassigned, max: maxSpent, click: `data-gotx="offen"` }) : ''}</div>
        ${budgetSum ? '' : '<p class="muted" style="margin-bottom:0">Tipp: Unter Einstellungen → Kategorien kannst du pro Kategorie ein Monatsbudget setzen.</p>'}</div>
      <div>
        <div class="card"><div class="filters"><h2 style="margin:0">Fixkosten & Abos</h2><span class="spacer" style="flex:1"></span><button class="linkbtn" data-view="fix">alle anzeigen →</button></div>
          ${fxOut.length ? `<p style="margin:0 0 10px"><b class="num">${eur(fxMonth)}</b> pro Monat · <b class="num">${eur(fxMonth * 12)}</b> pro Jahr · ${fxOut.length} Posten</p>
          <div class="bars">${fxOut.slice(0, 5).map(x => barRow({ label: esc(x.payee), value: x.perMonth, max: fxOut[0].perMonth, click: `data-fixtx="${x.id}"`, sub: `${x.interval} · ${eur(x.amount)}` })).join('')}</div>`
          : '<p class="muted" style="margin:0">Noch keine wiederkehrenden Zahlungen erkannt – dafür braucht es ein paar Monate Daten.</p>'}</div>
        ${tagStats.length ? `<div class="card"><h2>Tags</h2><div class="bars">${tagStats.map(x => `<div class="bl" style="display:flex;justify-content:space-between"><button class="linkbtn" data-tagf="${esc(x.g)}">#${esc(x.g)}</button><span class="num">${x.n} · <b class="${sign(x.sum)}">${eur(x.sum)}</b></span></div>`).join('')}</div></div>` : ''}
        <div class="card"><h2>Letzte Buchungen</h2>${recent.map(t => `<div class="bl" style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--line)">
          <button class="linkbtn" data-edit="${t.id}" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${fmtDate(t.booking_date).slice(0, 6)} ${esc(t.payee || t.counterparty_raw || '–')}</button>
          <span class="num ${sign(t.amount)}">${eur(t.amount)}</span></div>`).join('')}</div>
      </div>
    </div>`;
}

// ---------- Fixkosten & Abos ----------
const INTERVALS = [['monatlich', 1, 25, 36, 3], ['vierteljährlich', 3, 80, 100, 2], ['halbjährlich', 6, 170, 200, 2], ['jährlich', 12, 345, 390, 2]];
let fxCache = null;
function detectRecurring() {
  const sig = S.acc + '|' + S.txs.length + '|' + S.txs.reduce((a, t) => a + (t.subcategory_id ? 1 : 0), 0);
  if (fxCache?.sig === sig) return fxCache.list;
  const all = scoped(), latest = all.reduce((m, t) => t.booking_date > m ? t.booking_date : m, '0000');
  const latestMs = Date.parse(latest), day = 864e5;
  // 1) nach Händler gruppieren, 2) innerhalb nach ähnlichem Betrag (±12 %) bündeln
  const groups = new Map();
  for (const t of all) {
    if (kindOf(t) === 'umbuchung' && !t.subcategory_id) continue;
    const k = (keyOf(t) || 'p:' + (t.payee || '').toLowerCase()) + '|' + t.account_id + '|' + (t.amount < 0 ? '-' : '+');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = [];
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    // Häufiger Händler (z. B. Supermarkt): nur fast identische Beträge zählen als Abo/Vertrag
    const freq = list.length / new Set(list.map(t => ymOf(t.booking_date))).size;
    const frequent = freq > 1.5, tol = frequent ? 0 : 0.12, abs0 = frequent ? 0.005 : 0.5;
    const clusters = [];
    for (const t of list.slice().sort((a, b) => a.booking_date.localeCompare(b.booking_date))) {
      const c = clusters.find(c => Math.abs(Math.abs(t.amount) - Math.abs(c.last)) <= Math.abs(c.last) * tol + abs0);
      if (c) { c.items.push(t); c.last = t.amount; } else clusters.push({ items: [t], last: t.amount });
    }
    for (const c of clusters) {
      const it = c.items; if (it.length < 2) continue;
      const months = new Set(it.map(t => ymOf(t.booking_date)));
      if (months.size < it.length * 0.8) continue;           // mehrfach pro Monat → kein Abo
      const gaps = it.slice(1).map((t, i) => (Date.parse(t.booking_date) - Date.parse(it[i].booking_date)) / day).sort((a, b) => a - b);
      const med = gaps[Math.floor(gaps.length / 2)];
      const iv = INTERVALS.find(([, , lo, hi, min]) => med >= lo && med <= hi && it.length >= (frequent ? Math.max(3, min) : min));
      if (!iv) continue;
      const fit = gaps.filter(g => g >= iv[2] * 0.8 && g <= iv[3] * 1.25).length / gaps.length;
      if (fit < 0.6) continue;
      const lastT = it[it.length - 1], amount = Math.abs(lastT.amount);
      const daysSince = (latestMs - Date.parse(lastT.booking_date)) / day;
      const active = daysSince <= iv[1] * 30.5 * 1.5 + 5;
      const next = new Date(Date.parse(lastT.booking_date)); next.setMonth(next.getMonth() + iv[1]);
      out.push({ id: k + '#' + it[0].id, kind: kindOf(lastT), payee: lastT.payee || lastT.counterparty_raw, account_id: lastT.account_id,
        sub: lastT.assign_state !== 'vorschlag' ? lastT.subcategory_id : null, interval: iv[0], months: iv[1], amount,
        perMonth: amount / iv[1], count: it.length, last: lastT.booking_date, next: next.toISOString().slice(0, 10), active, ids: it.map(t => t.id) });
    }
  }
  out.sort((a, b) => b.perMonth - a.perMonth);
  fxCache = { sig, list: out };
  return out;
}
function viewFix() {
  const list = detectRecurring(), show = list.filter(x => x.active || S.showEnded);
  const sec = (kind, title) => {
    const l = show.filter(x => x.kind === kind); if (!l.length) return '';
    const act = l.filter(x => x.active), pm = act.reduce((a, x) => a + x.perMonth, 0);
    return `<div class="card"><div class="filters"><h2 style="margin:0">${title}</h2><span class="spacer" style="flex:1"></span>
        <span><b class="num">${eur(pm)}</b> / Monat · <b class="num">${eur(pm * 12)}</b> / Jahr</span></div>
      <div class="tablewrap"><table><thead><tr><th>Empfänger</th><th>Kategorie</th><th>Intervall</th><th class="num">Betrag</th><th class="num">pro Monat</th><th class="num">pro Jahr</th><th class="num">zuletzt</th><th class="num">nächste</th><th class="num">Anzahl</th></tr></thead>
      <tbody>${l.map(x => { const s = subById(x.sub); return `<tr${x.active ? '' : ' style="opacity:.5"'}>
        <td><button class="linkbtn" data-fixtx="${esc(x.id)}">${esc(x.payee)}</button>${S.acc === 'alle' ? ` <span class="tag">${esc(accById(x.account_id)?.name || '')}</span>` : ''}${x.active ? '' : ' <span class="tag">beendet?</span>'}</td>
        <td class="muted">${s ? esc(catById(s.category_id)?.name + ' › ' + s.name) : '<span class="state offen">offen</span>'}</td>
        <td>${x.interval}</td><td class="num">${eur(x.amount)}</td><td class="num">${eur(x.perMonth)}</td><td class="num">${eur(x.perMonth * 12)}</td>
        <td class="num muted">${fmtDate(x.last)}</td><td class="num muted">${x.active ? fmtDate(x.next) : '–'}</td><td class="num muted">${x.count}×</td></tr>`; }).join('')}</tbody></table></div></div>`;
  };
  const out = list.filter(x => x.active && x.kind === 'ausgabe').reduce((a, x) => a + x.perMonth, 0);
  const inc = list.filter(x => x.active && x.kind === 'einnahme').reduce((a, x) => a + x.perMonth, 0);
  // Ø Monatsausgaben der letzten 12 Monate
  const all = scoped(), latest = all.reduce((m, t) => t.booking_date > m ? t.booking_date : m, '0000');
  const from = latest === '0000' ? '' : ymAdd(ymOf(latest), -11);
  const last12 = all.filter(t => ymOf(t.booking_date) >= from), nM = Math.max(1, new Set(last12.map(t => ymOf(t.booking_date))).size);
  const avgExp = periodResult(last12).exp / nM;
  return `<div class="card"><div class="filters"><h2 style="margin:0">Fixkosten & Abos</h2><span class="spacer" style="flex:1"></span>
      <label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="fxEnded"${S.showEnded ? ' checked' : ''}> auch beendete zeigen</label></div>
    <div class="tiles" style="margin-top:0">
      <div class="tile main"><div class="tl">Fixkosten pro Monat</div><div class="tv">${eur(out)}</div><div class="td muted">${eur(out * 12)} pro Jahr</div></div>
      <div class="tile"><div class="tl">Anteil an Ø Monatsausgaben</div><div class="tv">${pct(avgExp ? out / avgExp : null)}</div><div class="td muted">Ø ${eur(avgExp)} / Monat (12 Mon.)</div></div>
      <div class="tile"><div class="tl">Regelmäßige Einnahmen</div><div class="tv">${eur(inc)}</div><div class="td muted">pro Monat</div></div>
      <div class="tile"><div class="tl">Frei nach Fixkosten</div><div class="tv ${sign(inc - out)}">${eur(inc - out)}</div><div class="td muted">pro Monat</div></div>
    </div>
    <p class="muted" style="margin:10px 0 0;font-size:12px">Automatisch erkannt: gleicher Empfänger, ähnlicher Betrag (±12 %), regelmäßiger Abstand (monatlich, vierteljährlich, halbjährlich, jährlich). „beendet?" = zuletzt deutlich länger als ein Intervall her. Name anklicken = zugehörige Buchungen.</p></div>
    ${sec('ausgabe', 'Regelmäßige Ausgaben')}${sec('einnahme', 'Regelmäßige Einnahmen')}${sec('umbuchung', 'Regelmäßige Umbuchungen')}
    ${show.length ? '' : '<div class="card muted">Noch keine wiederkehrenden Zahlungen erkannt – dafür braucht es einige Monate an Buchungen.</div>'}`;
}

// ---------- Verlauf pro Kategorie ----------
let trChart = null, trKey = null;
function openTrend(key) { trKey = key; $('#trendDlg').showModal(); drawTrend(); }
function drawTrend() {
  const [type, id] = trKey.split(':');
  const c = type === 'cat' ? catById(id) : catById(subById(id)?.category_id), s = type === 'sub' ? subById(id) : null;
  const flip = c?.kind === 'ausgabe' ? -1 : 1;
  $('#trTitle').textContent = s ? `${c.name} › ${s.name}` : c.name;
  const match = t => t.assign_state !== 'vorschlag' && (s ? t.subcategory_id === s.id : catOfTx(t)?.id === c.id);
  const all = scoped(); if (!all.length) return;
  const dates = all.map(t => t.booking_date).sort();
  let first = ymOf(dates[0]); const last = ymOf(dates[dates.length - 1]);
  const range = $('#trRange').value;
  if (range !== 'all') { const f = ymAdd(last, -(+range - 1)); if (f > first) first = f; }
  const months = []; for (let m = first; m <= last; m = ymAdd(m, 1)) months.push(m);
  const sums = new Map(months.map(m => [m, 0]));
  all.forEach(t => { const m = ymOf(t.booking_date); if (sums.has(m) && match(t)) sums.set(m, sums.get(m) + flip * t.amount); });
  const vals = months.map(m => Math.round(sums.get(m) * 100) / 100);
  const avg = vals.map((_, i) => { const w = vals.slice(Math.max(0, i - 2), i + 1); return Math.round(w.reduce((a, b) => a + b, 0) / w.length * 100) / 100; });
  const css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
  if (trChart) trChart.destroy();
  if (window.Chart) trChart = new Chart($('#trChart'), {
    data: { labels: months.map(m => `${MONTHS[+m.slice(5) - 1]} ${m.slice(2, 4)}`), datasets: [
      { type: 'bar', label: 'Monat', data: vals, backgroundColor: col('--accent') + 'aa', borderRadius: 3 },
      { type: 'line', label: 'Ø 3 Monate', data: avg, borderColor: col('--warn'), backgroundColor: col('--warn'), pointRadius: 0, tension: .3 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { labels: { color: col('--ink') } }, tooltip: { callbacks: { label: x => `${x.dataset.label}: ${eur(x.raw)}` } } },
      scales: { x: { ticks: { color: col('--muted'), maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { ticks: { color: col('--muted'), callback: v => eur(v) }, grid: { color: col('--line') } } } } });
  // Jahressummen (immer alle Jahre)
  const byY = new Map();
  all.forEach(t => { if (match(t)) { const y = t.booking_date.slice(0, 4); byY.set(y, (byY.get(y) || 0) + flip * t.amount); } });
  const ys = [...byY.keys()].sort();
  $('#trYears').innerHTML = ys.length ? `<table><thead><tr><th>Jahr</th>${ys.map(y => `<th class="num">${y}</th>`).join('')}</tr></thead><tbody>
    <tr><td>Summe</td>${ys.map(y => `<td class="num">${eur(byY.get(y))}</td>`).join('')}</tr>
    <tr><td class="muted">Ø Monat</td>${ys.map(y => `<td class="num muted">${eur(byY.get(y) / (lastMonthOf(+y) || 12))}</td>`).join('')}</tr></tbody></table>` : '<p class="muted">Keine Buchungen.</p>';
}
$('#trRange').addEventListener('change', drawTrend);
$('#trendDlg').addEventListener('close', () => { if (trChart) { trChart.destroy(); trChart = null; } });

// ---------- Export & Backup ----------
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportCsv(list, name) {
  const q = v => { v = String(v ?? ''); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const head = ['Datum', 'Konto', 'Empfänger', 'Verwendungszweck', 'Betrag', 'Kategorie', 'Unterkategorie', 'Typ', 'Status', 'Tags', 'Notiz', 'Original-Empfänger', 'IBAN'];
  const rows = list.slice().sort((a, b) => a.booking_date.localeCompare(b.booking_date)).map(t => {
    const s = t.assign_state !== 'vorschlag' ? subById(t.subcategory_id) : null, c = s ? catById(s.category_id) : null;
    return [fmtDate(t.booking_date), accById(t.account_id)?.name, t.payee, t.purpose, t.amount.toFixed(2).replace('.', ','), c?.name, s?.name,
      c?.kind || '', t.subcategory_id ? t.assign_state : 'offen', (t.tags || []).join(', '), t.note, t.counterparty_raw, t.iban].map(q).join(';');
  });
  download(name, '﻿' + [head.join(';'), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
  toast(`${list.length} Buchungen exportiert`);
}
function exportBackup() {
  const data = { app: 'Haushaltsbuch', version: 1, exported_at: new Date().toISOString(), accounts: S.accounts, categories: S.cats,
    subcategories: S.subs, transactions: S.txs, rules: [...S.rules.values()], user_rules: S.userRules };
  download(`haushaltsbuch-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1), 'application/json');
  toast('Backup heruntergeladen');
}
const stamp = () => new Date().toISOString().slice(0, 10);
function viewData() {
  return `<div class="card" id="s-daten" style="margin-top:16px"><h2>Daten & Backup</h2>
    <div class="filters"><button class="btn" id="csvAll">⬇ Alle Buchungen als CSV (Excel)</button><button class="ghost" id="backupJson">⬇ Komplett-Backup (JSON)</button></div>
    <p class="muted" style="margin:0">CSV: alle Konten, mit Kategorie, Tags und Notizen – öffnet direkt in Excel. Backup: alles inkl. Kategorien und Regeln, als Sicherung zum Aufheben.
    Hinweis: Supabase pausiert kostenlose Projekte nach etwa einer Woche ohne Nutzung. Die Daten bleiben erhalten, das Projekt muss dann im Supabase-Dashboard wieder gestartet werden.</p></div>`;
}

// ---------- Budget speichern ----------
async function saveBudget(id, val) {
  const c = catById(id), v = val.trim() === '' ? null : num(val);
  if (v !== null && (isNaN(v) || v < 0)) { toast('Budget ungültig'); return render(); }
  const { error } = await sb.from('categories').update({ budget: v }).eq('id', id);
  if (error) { render(); throw mig7(error); }
  c.budget = v; toast(v ? `Budget ${c.name}: ${eur(v)} pro Monat` : `Budget ${c.name} entfernt`);
}

// ---------- App installierbar (PWA) ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- Render & Events ----------
function render() {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === S.view));
  const open = scoped().filter(t => !t.subcategory_id || t.assign_state === 'vorschlag').length;
  const badge = $('#openBadge'); badge.textContent = open; badge.classList.toggle('hidden', !open);
  $('#accSel').innerHTML = `<option value="alle">Alle Konten</option>` + S.accounts.map(a => `<option value="${a.id}"${a.id === S.acc ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  if (S.acc === 'alle') $('#accSel').value = 'alle';
  document.querySelectorAll('[data-view="import"]').forEach(b => b.classList.toggle('active', S.view === 'import'));
  const v = { home: viewHome, import: viewImport, tx: viewTx, year: viewYear, compare: viewCompare, fix: viewFix, cats: viewCats }[S.view] || viewHome;
  $('#view').innerHTML = backBar() + v();
  $('#tagList').innerHTML = allTags().map(g => `<option value="${esc(g)}">`).join('');
  if (S.view === 'compare') drawCompareChart();
  if (S.view === 'import') bindImport();
  renderBulk();
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
      $('#goOpen').onclick = () => go('tx', { f: { cat: 'offen' }, from: 'Zurück zum Import' });
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
    const next = { ...c, account_id };
    const subIds = S.subs.filter(x => x.category_id === c.id).map(x => x.id);
    const orphan = S.txs.filter(x => subIds.includes(x.subcategory_id) && !catVisible(next, x.account_id));
    const choice = await askScopeChange(c.name, scopeTxt(next), orphan);
    if (!choice) return render();
    const { error } = await sb.from('categories').update({ account_id }).eq('id', c.id);
    if (error) { render(); throw /account_id/.test(error.message) ? new Error('Bitte migrations/005_kategorie_konto.sql in Supabase ausführen') : error; }
    c.account_id = account_id;
    if (choice === 'reset') await updateTxs(orphan.map(x => x.id), { subcategory_id: null, assign_state: null });
    toast(`${c.name}: ${scopeTxt(c)}${choice === 'reset' && orphan.length ? ` – ${orphan.length} Buchung(en) offen` : ''}`); return render();
  }
  if (t.id === 'edAcc') { const cur = $('#edSub').value; $('#edSub').innerHTML = subOptions(cur, false, t.value); $('#edSub').value = cur; return; }
  if (t.id === 'ruAcc') { const cur = $('#ruSub').value; $('#ruSub').innerHTML = subOptions(cur, false, t.value || null).replace('<option value="">– offen –</option>', '<option value="">– Kategorie wählen –</option>'); $('#ruSub').value = cur; return; }
  if (t.dataset.payee) return setPayee(t.dataset.payee, t.value);
  if (t.id === 'fYear') { S.f.year = t.value; S.sel.clear(); return render(); }
  if (t.id === 'fMonth') { S.f.month = t.value; S.sel.clear(); return render(); }
  if (t.id === 'fCat') { S.f.cat = t.value; S.f.sub = ''; S.sel.clear(); return render(); }
  if (t.id === 'fSub') { S.f.sub = t.value; return render(); }
  if (t.id === 'fTag') { S.f.tag = t.value; S.sel.clear(); return render(); }
  if (t.dataset.selid) { t.checked ? S.sel.add(t.dataset.selid) : S.sel.delete(t.dataset.selid); return renderBulk(); }
  if (t.id === 'selAll') { document.querySelectorAll('[data-selid]').forEach(cb => { cb.checked = t.checked; t.checked ? S.sel.add(cb.dataset.selid) : S.sel.delete(cb.dataset.selid); }); return renderBulk(); }
  if (t.dataset.budget) return saveBudget(t.dataset.budget, t.value);
  if (t.id === 'fxEnded') { S.showEnded = t.checked; return render(); }
  if (t.id === 'ySel') { S.yearSel = +t.value; return render(); }
  if (t.id === 'cmpYtd') { S.cmpYtd = t.checked; return render(); }
  if (t.id === 'accSel') { S.acc = t.value; S.sel.clear(); try { localStorage.setItem('fin_acc', S.acc); } catch {} return render(); }
  if (t.id === 'impAcc') { S.importAcc = t.value; return; }
}));

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.target.dataset.payee || e.target.dataset.budget)) e.target.blur();
  if (e.key === 'Enter' && e.target.id === 'bulkTag') { e.preventDefault(); bulkTag().catch(fail); }
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
    return go('tx', { f: { year: String(S.yearSel), month: m === '0' ? 'alle' : m, cat: key }, from: fromLabel() });
  }
  const b = e.target.closest('button, tr[data-exp]'); if (!b) return;
  const d = b.dataset;
  if ('back' in d) return history.back();
  if (d.trend) { e.stopPropagation(); return openTrend(d.trend); }
  if (d.view) return go(d.view);
  if (d.jump) return document.getElementById(d.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (d.hm) { S.homeMonth = ymAdd(S.homeMonth, +d.hm); try { history.replaceState(snapshot(), '', '#home'); } catch {} return render(); }
  if (d.gotx) return go('tx', { f: { cat: d.gotx }, from: fromLabel() });
  if (d.hometx) return go('tx', { f: { cat: d.hometx, year: S.homeMonth.slice(0, 4), month: String(+S.homeMonth.slice(5)) }, from: fromLabel() });
  if (d.tagf) return go('tx', { f: { tag: d.tagf }, from: fromLabel() });
  if (d.fixtx) { const x = detectRecurring().find(x => x.id === d.fixtx); return x && go('tx', { f: { ids: x.ids, idsLabel: `Fixkosten: ${x.payee}` }, from: fromLabel() }); }
  if ('clearids' in d) { S.f.ids = null; S.f.idsLabel = ''; return render(); }
  if (b.id === 'csvFiltered') return exportCsv(filteredTxs(), `buchungen-${stamp()}.csv`);
  if (b.id === 'csvAll') return exportCsv(S.txs, `buchungen-alle-${stamp()}.csv`);
  if (b.id === 'backupJson') return exportBackup();
  if (b.id === 'bulkAssign') return bulkAssign();
  if (b.id === 'bulkTagAdd') return bulkTag();
  if (b.id === 'bulkDel') return bulkDelete();
  if (b.id === 'bulkClear') { S.sel.clear(); return render(); }
  if (d.exp) { S.expanded.has(d.exp) ? S.expanded.delete(d.exp) : S.expanded.add(d.exp); return render(); }
  if (d.ok) { const t = S.txs.find(x => x.id === d.ok); return setCategory(t.id, t.subcategory_id); }
  if (d.del) return deleteTx(d.del);
  if (d.edit) return openEditDialog(d.edit);
  if (d.showtx) return go('tx', { f: { cat: d.showtx }, from: fromLabel() });
  if (d.dupimp) return resolveDups([+d.dupimp], true);
  if (d.dupskip) return resolveDups([+d.dupskip], false);
  if (d.dupall) return resolveDups(S.dupReview.map((_, i) => i), d.dupall === 'imp');
  if (b.id === 'addCat') {
    const name = $('#newCat').value.trim(); if (!name) return;
    const { data, error } = await sb.from('categories').insert({ name, kind: $('#newKind').value, sort: S.cats.length, ...($('#newScope').value ? { account_id: $('#newScope').value } : {}) }).select().single();
    if (error) throw error;
    const s = await sb.from('subcategories').insert({ category_id: data.id, name: 'Sonstiges' }).select().single();
    if (s.error) throw s.error;
    S.cats.push(data); S.subs.push(s.data); sortSubs(); return render();
  }
  if (d.addsub) {
    const name = prompt('Name der Unterkategorie'); if (!name?.trim()) return;
    const { data, error } = await sb.from('subcategories').insert({ category_id: d.addsub, name: name.trim() }).select().single();
    if (error) throw error;
    S.subs.push(data); sortSubs(); return render();
  }
  if (d.rensub) return openSubDialog(d.rensub);
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
  if (d.catmove) { const [id, dir] = d.catmove.split('|'); return moveCat(id, +dir); }
  if (b.id === 'sortAZ') return sortCatsAZ();
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
  const h = location.hash.slice(1);
  S.view = ['home', 'tx', 'year', 'compare', 'fix', 'cats', 'import'].includes(h) ? h : S.txs.length ? 'home' : 'import';
  try { history.replaceState(snapshot(), '', '#' + S.view); } catch {}
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
