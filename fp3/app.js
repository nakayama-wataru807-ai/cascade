/* FP3級 ドリル（学科・実技）
 *
 * このファイルにもリポジトリの docs/ にも、試験問題そのものは含まれない。
 * 問題データ（bundle.json）は端末ごとに手元から読み込み、IndexedDB に置く。
 * 試験問題の著作権（不許複製）を守るための構成。一級建築士ドリルのフォーク。
 */
'use strict';

const EXAM_DATE_FALLBACK = '2026-09-27';   // bundle の plan.exam_date が優先される
const DB_NAME = 'fp3-drill', DB_VER = 1;

/* 分野テーマカラーの対応。CSS 側に .s-<key> が定義してあり、
 * その配下では var(--s) / var(--s-w) で分野色が引ける。 */
const SUBJECTS = ['ライフ', 'リスク', '金融', 'タックス', '不動産', '相続'];
const SUBJECT_KEY = {ライフ:'life', リスク:'risk', 金融:'kinyu',
                     タックス:'tax', 不動産:'fudo', 相続:'sozoku'};
const subjClass = s => 's-' + (SUBJECT_KEY[s] || 'kinyu');

/* 回の表示名。'2026C' → '2026年5月公表'、'202401' → '2024年1月' */
function sitLabel(s){
  return s.endsWith('C') ? `${s.slice(0,4)}年5月公表` : `${+s.slice(0,4)}年${+s.slice(4)}月`;
}

/* ---------------- IndexedDB ---------------- */
let db;
function openDB(){
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if(!d.objectStoreNames.contains('kv'))   d.createObjectStore('kv',   {keyPath:'k'});
      if(!d.objectStoreNames.contains('prog')) d.createObjectStore('prog', {keyPath:'id'});
      if(!d.objectStoreNames.contains('day'))  d.createObjectStore('day',  {keyPath:'d'});
    };
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
}
const tx = (store, mode) => db.transaction(store, mode).objectStore(store);
const idbGet = (s, k) => new Promise((res, rej) => {
  const r = tx(s,'readonly').get(k); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
});
const idbAll = (s) => new Promise((res, rej) => {
  const r = tx(s,'readonly').getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error);
});
const idbPut = (s, v) => new Promise((res, rej) => {
  const r = tx(s,'readwrite').put(v); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error);
});

/* ---------------- 状態 ---------------- */
let BUNDLE = null;          // {questions, unit_stats, target, cutoff, plan, ...}
let FIGS = {};              // 図版（別ファイル・実技用）。名前 -> data URI
let QMAP = new Map();       // id -> question
let PROG = new Map();       // id -> progress
let SESSION = null;         // 進行中のセッション

const todayStr = () => new Date().toLocaleDateString('sv-SE');   // YYYY-MM-DD
const daysBetween = (a,b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const addDays = (s,n) => { const d=new Date(s); d.setDate(d.getDate()+n); return d.toLocaleDateString('sv-SE'); };
const $ = s => document.querySelector(s);
const el = (t,c,txt) => { const e=document.createElement(t); if(c)e.className=c; if(txt!=null)e.textContent=txt; return e; };
const mmss = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
const examDate = () => (BUNDLE && BUNDLE.plan && BUNDLE.plan.exam_date) || EXAM_DATE_FALLBACK;

/* ---------------- 間隔反復（SM-2） ---------------- */
function newProg(id){
  return {id, ease:2.5, interval:0, reps:0, lapses:0, due:todayStr(), attempts:[]};
}
function applySM2(p, quality){
  if(quality >= 3){
    if(p.reps === 0)       p.interval = 1;
    else if(p.reps === 1)  p.interval = 6;
    else                   p.interval = Math.round(p.interval * p.ease);
    p.reps += 1;
  }else{
    p.reps = 0;
    p.interval = 1;
    p.lapses += 1;
  }
  p.ease = Math.max(1.3, p.ease + (0.1 - (5-quality) * (0.08 + (5-quality) * 0.02)));
  // 試験日という締切があるので、間隔は「本番までの残り日数の半分」で頭打ちにする。
  const left = daysBetween(todayStr(), examDate());
  if(left > 0) p.interval = Math.max(1, Math.min(p.interval, Math.max(1, Math.floor(left / 2))));
  p.due = addDays(todayStr(), p.interval);
  return p;
}

/* 誤答理由 → SM-2 の quality。
 * 「勘で当たった」は正解でも quality 2 とし、復習対象に落とす。 */
const REASONS_OK = [
  {k:'sure',   label:'確信あり',      q:5},
  {k:'unsure', label:'迷った',        q:3},
  {k:'guess',  label:'勘で当たった',  q:2, warn:true},
];
const REASONS_NG = [
  {k:'knowledge', label:'知識不足', q:0},
  {k:'misread',   label:'読み違い', q:1},
  {k:'calc',      label:'計算ミス', q:1},
  {k:'timeout',   label:'時間切れ', q:1},
];
const REASON_LABEL = Object.fromEntries(
  [...REASONS_OK, ...REASONS_NG].map(r => [r.k, r.label])
    .concat([['unrecorded', '理由未記録']]));

/* ---------------- 起動 ---------------- */
async function boot(){
  await openDB();
  const rec = await idbGet('kv', 'bundle');
  const fig = await idbGet('kv', 'figures');
  if(fig && fig.v) FIGS = fig.v;
  const rows = await idbAll('prog');
  rows.forEach(p => PROG.set(p.id, p));
  if(rec && rec.v){ setBundle(rec.v); }
  else { $('#importCard').hidden = false; $('#todayCard').hidden = true; }
  updateImportState();
  await ghLoad();
  $('#hdDays').textContent = Math.max(0, daysBetween(todayStr(), examDate()));
  wire();
  render();
}
function setBundle(b){
  BUNDLE = b;
  QMAP = new Map(b.questions.map(q => [q.id, q]));
  $('#importCard').hidden = true;
  $('#todayCard').hidden = false;
  $('#hdDays').textContent = Math.max(0, daysBetween(todayStr(), examDate()));
  fillFilters();
}

/* ---------------- 取り込み ---------------- */
function wire(){
  document.querySelectorAll('nav button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x===b));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'v-'+b.dataset.v));
      render();
    };
  });
  $('#importBtn').onclick  = () => $('#fileIn').click();
  $('#reimportBtn').onclick = () => $('#fileIn').click();
  $('#fileIn').onchange = onImport;
  $('#startBtn').onclick = startSession;
  $('#backBtn').onclick  = () => { $('#resultCard').hidden = true; $('#quizSetup').hidden = false; };
  $('#nextBtn').onclick  = () => nextQuestion();
  $('#againBtn').onclick = () => { SESSION.queue.push(SESSION.current); nextQuestion(); };
  $('#suspendBtn').onclick = suspendSession;
  $('#exportBtn').onclick = exportProgress;
  $('#syncBtn').onclick   = () => syncNow(false);
  $('#syCfgBtn').onclick  = () => { const c = $('#syCfg'); c.hidden = !c.hidden; };
  $('#sySave').onclick    = async () => {
    GH.repo = $('#syRepo').value.trim() || GH_DEFAULT.repo;
    GH.path = $('#syPath').value.trim() || GH_DEFAULT.path;
    GH.auto = $('#syAuto').checked;
    const t = $('#syToken').value.trim();
    if(t && !/^•+$/.test(t)) GH.token = t;      // 伏字のままなら既存を保持
    await ghSave();
    $('#syMsg').textContent = '保存しました。「今すぐ同期」で疎通を確認してください。';
  };
  $('#syClear').onclick   = async () => {
    GH = {...GH_DEFAULT, token:''};
    await ghSave();
    $('#syMsg').textContent = 'この端末の同期設定を消しました。';
  };
  $('#goDue').onclick = () => jumpQuiz('due');
  $('#goNew').onclick = () => jumpQuiz('new');
  ['#selMode','#selExam','#selSubject','#selSitting','#selUnit'].forEach(s => $(s).onchange = updatePool);
  $('#selSubject').addEventListener('change', fillUnitFilter);
  $('#uSubject').onchange = renderUnits;
  $('#uExam').onchange = renderUnits;
}
function jumpQuiz(mode){
  document.querySelector('nav button[data-v="quiz"]').click();
  $('#selMode').value = mode;
  updatePool();
}
/* bundle.json（問題）と figures.json（図版・実技用）のどちらを渡されても受け取る。 */
async function onImport(e){
  const f = e.target.files[0];
  if(!f) return;
  const msg = $('#importMsg'); msg.textContent = '読み込み中…';
  try{
    const b = JSON.parse(await f.text());
    if(b.questions){
      await idbPut('kv', {k:'bundle', v:b});
      setBundle(b);
      msg.textContent = `問題 ${b.questions.length} 問を取り込みました。`;
    }else if(b.figures){
      FIGS = b.figures;
      await idbPut('kv', {k:'figures', v:FIGS});
      msg.textContent = `図版 ${Object.keys(FIGS).length} 枚を取り込みました。`;
    }else{
      throw new Error('questions も figures も入っていません');
    }
    updateImportState();
    $('#dataMsg').textContent = msg.textContent;
    render();
  }catch(err){
    msg.textContent = '失敗: ' + err.message;
  }
  e.target.value = '';
}
function updateImportState(){
  const nq = BUNDLE ? BUNDLE.questions.length : 0;
  const nf = Object.keys(FIGS).length;
  $('#importState').textContent =
    `問題 ${nq ? nq + '問' : '未取込'} ／ 図版 ${nf ? nf + '枚' : '未取込'}`;
  // 実技の図版が未取込でも学科は解けるので、問題さえ入れば取り込み口は畳む
  $('#importCard').hidden = !!BUNDLE;
}

function fillFilters(){
  for(const sel of ['#selSubject','#uSubject']){
    const s = $(sel);
    s.innerHTML = '<option value="">全分野</option>';
    SUBJECTS.forEach(x => s.append(new Option(x, x)));
  }
  const y = $('#selSitting');
  y.innerHTML = '<option value="">全回</option>';
  [...BUNDLE.sittings].reverse().forEach(v => y.append(new Option(sitLabel(v), v)));
  const hasJitsugi = BUNDLE.questions.some(q => q.exam === '実技');
  $('#selExam').hidden = !hasJitsugi;
  $('#uExam').parentElement.hidden = !hasJitsugi;
  fillUnitFilter();
  updatePool();
}
function fillUnitFilter(){
  const sub = $('#selSubject').value;
  const u = $('#selUnit');
  u.innerHTML = '<option value="">全単元</option>';
  const set = new Set();
  BUNDLE.questions.forEach(q => { if(q.unit && (!sub || q.subject === sub)) set.add(q.unit); });
  [...set].sort().forEach(x => u.append(new Option(x, x)));
}

/* ---------------- 出題プール ---------------- */
function prog(id){ return PROG.get(id) || newProg(id); }
function lastAttempt(id){
  const p = PROG.get(id);
  return p && p.attempts.length ? p.attempts[p.attempts.length-1] : null;
}
function buildPool(){
  const mode = $('#selMode').value, sub = $('#selSubject').value;
  const sit = $('#selSitting').value, unit = $('#selUnit').value;
  const exam = $('#selExam').value;
  const t = todayStr();
  if(mode === 'mock'){
    if(!sit || !exam) return [];
    return BUNDLE.questions
      .filter(q => q.sitting === sit && q.exam === exam && q.law_status !== 'excluded')
      .sort((a,b) => a.no - b.no);   // 原順・全問（模試は分野/単元/期日で絞らない）
  }
  return BUNDLE.questions.filter(q => {
    if(q.law_status === 'excluded') return false;   // 法改正で成立しない問題は常に除外
    if(exam && q.exam !== exam) return false;
    if(sub && q.subject !== sub) return false;
    if(sit && q.sitting !== sit) return false;
    if(unit && q.unit !== unit) return false;
    const p = PROG.get(q.id), la = lastAttempt(q.id);
    if(mode === 'due')   return p && p.attempts.length && p.due <= t;
    if(mode === 'new')   return !p || !p.attempts.length;
    if(mode === 'wrong') return la && !la.ok;
    if(mode === 'guess') return la && la.ok && la.reason === 'guess';
    return true;
  });
}
function updatePool(){
  if(!BUNDLE) return;
  const mock = $('#selMode').value === 'mock';
  $('#selCount').closest('.row').style.display = mock ? 'none' : '';
  $('#mockNote').hidden = !mock;
  const pool = buildPool();
  if(mock && pool.length){
    const exam = $('#selExam').value;
    $('#poolMsg').textContent = `${exam} ${pool.length}問（制限時間 ${exam === '学科' ? 90 : 60}分）で模試を開始します`;
  }else{
    $('#poolMsg').textContent = `該当 ${pool.length} 問`;
  }
  $('#startBtn').disabled = pool.length === 0;
}

/* ---------------- セッション ---------------- */
function shuffle(a){
  for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function startSession(){
  const mode = $('#selMode').value;
  const mock = mode === 'mock';
  const pool = buildPool();
  if(!pool.length) return;
  const n = +$('#selCount').value;
  let list = mock ? pool.slice()
    : mode === 'due' ? pool.sort((a,b) => prog(a.id).due.localeCompare(prog(b.id).due))
    : shuffle(pool.slice());
  SESSION = {queue:mock ? list : list.slice(0, n), done:[], total:mock ? list.length : Math.min(n,list.length),
             current:null, t0:Date.now(), qt0:0, picked:null,
             answered:false, recorded:false, suspended:false, timer:null,
             mock, mockDeadline: mock ? Date.now() + (pool[0].exam === '学科' ? 90 : 60) * 60000 : null};
  $('#quizSetup').hidden = true; $('#resultCard').hidden = true; $('#quizArea').hidden = false;
  $('#mockBar').hidden = !mock;
  nextQuestion();
}
function nextQuestion(){
  clearInterval(SESSION.timer);
  if(!SESSION.queue.length){ return finishSession(); }
  SESSION.current = SESSION.queue.shift();
  SESSION.picked = null; SESSION.answered = false;
  SESSION.recorded = false; SESSION.qt0 = Date.now();
  showQuestion(SESSION.current);
  SESSION.timer = setInterval(() => {
    $('#qTimer').textContent = mmss((Date.now() - SESSION.qt0)/1000);
    if(SESSION.mock){
      const left = (SESSION.mockDeadline - Date.now()) / 1000;
      const mt = $('#mockTimer');
      mt.textContent = (left < 0 ? '-' : '') + mmss(Math.abs(left));
      mt.classList.toggle('over', left < 0);
    }
  }, 500);
}
function showQuestion(q){
  const card = $('#quizCard');
  card.className = 'card subj ' + subjClass(q.subject);
  $('#qSubject').textContent = q.subject;
  $('#qYear').textContent = `${sitLabel(q.sitting)} ${q.exam === '実技' ? '実技' : ''}問${q.no}`;
  $('#qUnit').textContent = q.unit || '未分類';
  $('#qProg').textContent = `${SESSION.done.length+1} / ${SESSION.total}`;
  $('#qTimer').textContent = '0:00';
  $('#qStem').textContent = q.stem;

  const figs = $('#qFigs'); figs.innerHTML = '';
  let shown = 0;
  (q.figures || []).forEach(name => {
    const src = FIGS[name];
    if(!src) return;
    const w = el('div','figwrap'); const im = el('img'); im.src = src; im.loading='lazy';
    im.alt = '問題の資料画像'; w.append(im); figs.append(w); shown++;
  });
  if(!shown && (q.figures || []).length){
    figs.append(el('p','note','※資料画像が未取込です。ホームの初回セットアップから figures.json を読み込むと表示されます。'));
  }

  const box = $('#qChoices'); box.innerHTML = '';
  if(q.qtype === 'tf'){
    // ○×は本番CBTと同じく大きな2ボタン
    const row = el('div','tfrow');
    ['○','×'].forEach((c,i) => {
      const b = el('button','choice tf');
      b.append(el('span','', c));
      b.onclick = () => answer(i+1, b);
      row.append(b);
    });
    box.append(row);
  }else if(q.choices.length){
    q.choices.forEach((c,i) => {
      const b = el('button','choice');
      b.append(el('span','n', String(i+1)));
      b.append(el('span','', c));
      b.onclick = () => answer(i+1, b);
      box.append(b);
    });
  }else{
    // 表組みが複雑で本文を取り込めなかった問題は、資料画像を見て1〜3を選ぶ
    figs.hidden = false;
    if(!shown){
      figs.append(el('p','note','※この問題は本文を取り込めていません。上の資料画像を参照してください。'));
    }
    [1,2,3].forEach(i => {
      const b = el('button','choice');
      b.append(el('span','n', String(i)));
      b.append(el('span','', `肢 ${i}`));
      b.onclick = () => answer(i, b);
      box.append(b);
    });
  }
  $('#afterBox').hidden = true;
  window.scrollTo({top:0, behavior:'instant'});
}
function answer(pick, btn){
  if(SESSION.answered) return;
  SESSION.answered = true; SESSION.picked = pick;
  clearInterval(SESSION.timer);
  const q = SESSION.current, ok = pick === q.answer;
  SESSION.sec = (Date.now() - SESSION.qt0)/1000;

  document.querySelectorAll('#qChoices .choice').forEach((b,i) => {
    b.disabled = true;
    if(i+1 === q.answer) b.classList.add('ok');
    else if(i+1 === pick) b.classList.add('ng');
    // 肢別の解説があれば、採点後にそれぞれの肢の下に出す（○×では全体解説に回す）
    if(q.qtype !== 'tf'){
      const note = (q.choice_notes || [])[i];
      if(note){
        const body = b.children[1];
        if(body) body.append(el('span','choice-note', note));
      }
    }
  });

  const ansLabel = q.qtype === 'tf' ? (q.answer === 1 ? '○' : '×') : `肢${q.answer}`;
  const v = $('#verdict');
  v.className = 'verdict ' + (ok ? 'ok' : 'ng');
  v.innerHTML = '';
  v.append(document.createTextNode(ok ? `正解（${ansLabel}）` : `不正解 — 正答は ${ansLabel}`));
  const s = el('small','', `${mmss(SESSION.sec)} で解答` +
    (q.explain ? '' : ' ／ 解説は未作成'));
  v.append(s);

  // 模試モード: 解説・理由タグは出さず、既定の理由で即記録して次へ進めるだけにする
  // （本番で誤答理由を都度考えることはないため。分野別の内訳は結果画面で見せる）
  if(SESSION.mock){
    $('#lawNoteBox').hidden = true;
    $('#explainBox').hidden = true;
    $('#reasonSection').hidden = true;
    $('#afterBox').hidden = false;
    $('#againBtn').hidden = true;
    record(ok ? 5 : 0, ok ? 'sure' : 'knowledge');
    $('#nextBtn').scrollIntoView({behavior:'smooth', block:'nearest'});
    return;
  }
  $('#reasonSection').hidden = false;
  $('#againBtn').hidden = false;

  // 法改正の注記（ペーパー時代の問題）
  const ln = $('#lawNoteBox');
  if(q.law_note){
    ln.hidden = false;
    ln.textContent = '⚠ ' + q.law_note;
  }else{
    ln.hidden = true;
  }

  // 問題全体の解説
  const ex = $('#explainBox');
  if(q.explain || (q.qtype === 'tf' && (q.choice_notes||[]).some(Boolean))){
    ex.hidden = false;
    ex.innerHTML = '';
    ex.append(el('div','explain-title','解説'));
    if(q.explain) ex.append(el('div','', q.explain));
    if(q.explain_src) ex.append(el('div','note explain-src', q.explain_src));
  }else{
    ex.hidden = true;
  }

  const rb = $('#reasonBox'); rb.innerHTML = '';
  (ok ? REASONS_OK : REASONS_NG).forEach(r => {
    const b = el('button', r.warn ? 'warn' : '', r.label);
    b.onclick = () => {
      rb.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      record(r.q, r.k);
    };
    rb.append(b);
  });
  $('#afterBox').hidden = false;
  $('#nextBtn').scrollIntoView({behavior:'smooth', block:'nearest'});
}
async function record(quality, reasonKey){
  const q = SESSION.current;
  const p = PROG.get(q.id) || newProg(q.id);
  p.attempts.push({t:new Date().toISOString(), pick:SESSION.picked,
                   ok:SESSION.picked === q.answer, reason:reasonKey,
                   sec:Math.round(SESSION.sec)});
  applySM2(p, quality);
  PROG.set(q.id, p);
  await idbPut('prog', p);

  const t = todayStr();
  const d = (await idbGet('day', t)) || {d:t, count:0, sec:0};
  d.count += 1; d.sec += Math.round(SESSION.sec);
  await idbPut('day', d);

  if(!SESSION.done.includes(q.id)) SESSION.done.push(q.id);
  SESSION.recorded = true;
}

/* 中断。ここまでの解答は記録し、まだ解いていない問題は出題プールへ返す。 */
async function suspendSession(){
  if(!SESSION) return;
  clearInterval(SESSION.timer);
  if(SESSION.answered && !SESSION.recorded){
    await record(SESSION.picked === SESSION.current.answer ? 3 : 1, 'unrecorded');
  }
  SESSION.suspended = true;
  finishSession();
}
function finishSession(){
  clearInterval(SESSION.timer);
  const ids = SESSION.done;
  if(SESSION.suspended && !ids.length){
    $('#quizArea').hidden = true; $('#quizSetup').hidden = false;
    SESSION = null; render(); return;
  }
  $('#quizArea').hidden = true; $('#resultCard').hidden = false;
  $('#rsTitle').textContent = SESSION.suspended ? '中断しました' : 'セッション結果';
  const note = $('#rsNote');
  if(SESSION.suspended){
    const remain = SESSION.queue.length + (SESSION.answered ? 0 : 1);
    note.textContent = `ここまでの ${ids.length} 問は記録済みです。`
      + (remain > 0
         ? `未解答の ${remain} 問は出題プールに戻したので、次回また出題されます。`
         : '');
    note.hidden = false;
  }else{
    note.hidden = true;
  }
  const att = ids.map(id => lastAttempt(id)).filter(Boolean);
  const okN = att.filter(a => a.ok).length;
  const sec = att.reduce((s,a) => s + a.sec, 0);
  $('#rsScore').textContent = `${okN} / ${att.length}`;
  $('#rsAcc').textContent = att.length ? Math.round(okN/att.length*100)+'%' : '–';
  $('#rsTime').textContent = mmss(sec);
  $('#rsAvg').textContent = att.length ? mmss(sec/att.length) : '–';

  const br = $('#rsBreak'); br.innerHTML = '';
  const rsMock = $('#rsMock');
  if(SESSION.mock && !SESSION.suspended){
    rsMock.hidden = false;
    const exam = (QMAP.get(ids[0]) || {}).exam || '学科';
    const total = BUNDLE.exam_total[exam], cut = BUNDLE.cutoff[exam], tgt = BUNDLE.target[exam];
    $('#rsMockPass').innerHTML = '';
    scoreRow($('#rsMockPass'), exam, att.length ? okN/att.length : 0, att.length, total, cut, tgt);
    const bySubj = {};
    ids.forEach(id => {
      const q = QMAP.get(id), a = lastAttempt(id);
      if(!q || !a) return;
      const o = bySubj[q.subject] || (bySubj[q.subject] = {ok:0, n:0});
      o.n++; if(a.ok) o.ok++;
    });
    const sd = $('#rsMockSubj'); sd.innerHTML = '';
    sd.append(el('p','note','分野別内訳'));
    SUBJECTS.filter(s => bySubj[s]).forEach(s => {
      const o = bySubj[s];
      const row = el('div','score-row ' + subjClass(s));
      row.append(el('div','nm', s));
      const bar = el('div','bar'); const fill = el('span');
      fill.style.width = (o.ok/o.n*100)+'%'; bar.append(fill); row.append(bar);
      row.append(el('div','fig', `${o.ok}/${o.n}`));
      sd.append(row);
    });
  }else{
    rsMock.hidden = true;
  }
  const cnt = {};
  att.forEach(a => { cnt[a.reason] = (cnt[a.reason]||0)+1; });
  Object.entries(cnt).sort((a,b) => b[1]-a[1]).forEach(([k,n]) => {
    const cls = (k === 'guess' || k === 'unrecorded') ? 'warn'
              : (REASONS_OK.some(r => r.k === k) ? 'ok' : 'ng');
    br.append(el('span', 'chip '+cls, `${REASON_LABEL[k]||k} ${n}`));
  });
  render();
  if(GH.auto && GH.token && GH.repo && ids.length && Date.now() >= syncCooldownUntil) syncNow(true);
}

/* ---------------- 描画 ---------------- */
function render(){
  if(!BUNDLE) return;
  renderHome(); renderPlanPhase(); renderUnits(); renderLog(); updatePool();
}
/* 直近の解答での実力推定。勘の正解は実力に数えない。 */
function accuracyBy(fnKey){
  const acc = {};
  for(const [id,p] of PROG){
    const q = QMAP.get(id); if(!q || !p.attempts.length) continue;
    const key = fnKey(q); if(key == null) continue;
    const a = p.attempts[p.attempts.length-1];
    const o = acc[key] || (acc[key] = {ok:0, n:0});
    o.n += 1;
    if(a.ok && a.reason !== 'guess') o.ok += 1;
  }
  return acc;
}
function scoreRow(box, name, rate, n, max, cut, tgt, cls){
  const row = el('div','score-row' + (cls ? ' ' + cls : ''));
  const nm = el('div','nm', name);
  if(cls) nm.style.color = 'var(--s)';
  row.append(nm);
  const bar = el('div','bar');
  if(n){
    const fill = el('span'); fill.style.width = (rate*100).toFixed(1)+'%';
    if(!cls){
      const pt = rate * max;
      fill.style.background = pt >= tgt ? 'var(--ok)' : (pt >= cut ? 'var(--warn)' : 'var(--ng)');
    }
    bar.append(fill);
  }else{
    bar.style.opacity = '.45';
  }
  if(cut != null){ const c = el('div','cut'); c.style.left = (cut/max*100)+'%'; bar.append(c); }
  if(tgt != null){ const g = el('div','tgt'); g.style.left = (tgt/max*100)+'%'; bar.append(g); }
  row.append(bar);
  const fig = el('div','fig');
  if(n){
    const pt = rate * max;
    const b = el('b', pt >= tgt ? 'v-ok' : (pt >= cut ? 'v-warn' : 'v-ng'), pt.toFixed(1));
    fig.append(b);
    fig.append(document.createTextNode(`/${max}` + (tgt != null ? `　目標${tgt}` : '')));
  }else{
    fig.append(el('span','v-none','未計測'));
    if(tgt != null) fig.append(document.createTextNode(`　目標${tgt}`));
  }
  row.append(fig);
  box.append(row);
}
async function renderHome(){
  const t = todayStr();
  let due=0, neu=0, seen=0, att=0, ok=0, sec=0;
  for(const q of BUNDLE.questions){
    const p = PROG.get(q.id);
    if(!p || !p.attempts.length){ neu++; continue; }
    seen++; att += p.attempts.length;
    p.attempts.forEach(a => { if(a.ok) ok++; sec += a.sec; });
    if(p.due <= t) due++;
  }
  $('#stDue').textContent = due; $('#stNew').textContent = neu;
  $('#stSeen').textContent = seen; $('#stAtt').textContent = att;
  $('#stAcc').textContent = att ? Math.round(ok/att*100)+'%' : '–';
  $('#stHour').textContent = (sec/3600).toFixed(1)+'h';

  const days = (await idbAll('day')).sort((a,b) => a.d.localeCompare(b.d));
  const today = days.find(d => d.d === t);
  $('#stToday').textContent = today ? today.count : 0;
  let streak = 0;
  let i = days.some(x => x.d === t && x.count > 0) ? 0 : 1;
  for(; i < 400; i++){
    if(days.some(x => x.d === addDays(t, -i) && x.count > 0)) streak++;
    else break;
  }
  $('#stStreak').textContent = streak;

  /* 分野別バー（学科・各10問満点・目安7問）＋ 学科合計 ＋ 実技合計 */
  const box = $('#scoreBars');
  box.innerHTML = '';
  const bySubj = accuracyBy(q => q.exam === '学科' ? q.subject : null);
  const guide = BUNDLE.subject_guide || {};
  let est = 0, maxMeasured = 0;
  for(const s of SUBJECTS){
    const max = BUNDLE.subject_max[s] || 10, g = guide[s] || 7;
    const a = bySubj[s] || {ok:0, n:0};
    const rate = a.n ? a.ok/a.n : 0;
    if(a.n){ est += rate * max; maxMeasured += max; }
    scoreRow(box, s, rate, a.n, max, null, g, subjClass(s));
  }
  const gakkaTotal = BUNDLE.exam_total['学科'], gakkaCut = BUNDLE.cutoff['学科'], gakkaTgt = BUNDLE.target['学科'];
  const gRate = maxMeasured ? est / maxMeasured : 0;
  scoreRow(box, '学科', gRate, maxMeasured, gakkaTotal, gakkaCut, gakkaTgt);

  const hasJitsugi = BUNDLE.questions.some(q => q.exam === '実技');
  if(hasJitsugi){
    const byExam = accuracyBy(q => q.exam);
    const a = byExam['実技'] || {ok:0, n:0};
    const rate = a.n ? a.ok/a.n : 0;
    scoreRow(box, '実技', rate, a.n, BUNDLE.exam_total['実技'], BUNDLE.cutoff['実技'], BUNDLE.target['実技']);
  }
  const cov = el('p','note');
  cov.style.margin = '6px 0 0';
  cov.textContent = maxMeasured
    ? `※ 学科は演習済みの分野（${maxMeasured}問分）の正答率を${gakkaTotal}問に引き伸ばした推定。合格ラインは${gakkaCut}/${gakkaTotal}。`
    : '※ まだ演習の記録がありません。';
  box.append(cov);
}

/* ---------------- 学習フェーズ ----------------
 * bundle 内の plan（3フェーズ・試験日から生成）を表示し、
 * 「今日の目安」を残り新規問題数から割り出す。外部ファイルは読まない。 */
function renderPlanPhase(){
  const plan = BUNDLE.plan;
  if(!plan || !plan.phases){ $('#planCard').hidden = true; return; }
  $('#planCard').hidden = false;
  const t = todayStr();
  const cur = plan.phases.find(p => t <= p.until) || plan.phases[plan.phases.length-1];
  $('#planPhase').textContent = `${cur.name}（〜${cur.until.slice(5).replace('-','/')}）`;
  $('#planText').textContent = cur.note;

  let due = 0, neu = 0;
  for(const q of BUNDLE.questions){
    if(q.law_status === 'excluded') continue;
    const p = PROG.get(q.id);
    if(!p || !p.attempts.length){ neu++; continue; }
    if(p.due <= t) due++;
  }
  let sug;
  const idx = plan.phases.indexOf(cur);
  if(idx === 0){
    const left = Math.max(1, daysBetween(t, cur.until));
    sug = `復習 ${due} 問 ＋ 新規 ${Math.min(neu, Math.ceil(neu / left))} 問`;
  }else if(idx === 1){
    sug = `復習 ${due} 問を最優先 ＋ 単元タブのROI上位から10問`;
  }else{
    sug = `復習 ${due} 問 ＋ 模試1回分（間違い・勘プールを優先）`;
  }
  $('#planMeta').textContent = `今日の目安: ${sug}`;
}

function renderUnits(){
  if(!BUNDLE) return;
  const sub = $('#uSubject').value;
  const exam = $('#uExam').value || '学科';
  const stats = (BUNDLE.unit_stats.units || {})[exam] || {};
  const rows = [];
  for(const [name, s] of Object.entries(stats)){
    if(name === '（未分類）') continue;
    if(sub && s.subject !== sub) continue;
    let n=0, ok=0;
    for(const q of BUNDLE.questions){
      if(q.unit !== name || q.exam !== exam) continue;
      const p = PROG.get(q.id); if(!p || !p.attempts.length) continue;
      const a = p.attempts[p.attempts.length-1];
      n++; if(a.ok && a.reason !== 'guess') ok++;
    }
    const rate = n ? ok/n : 0;
    rows.push({name, subject:s.subject, avg:s.avg_per_sitting, total:s.total,
               n, rate, gain: s.avg_per_sitting * (1 - rate)});
  }
  rows.sort((a,b) => b.gain - a.gain);
  const t = $('#unitTable');
  t.innerHTML = '<thead><tr><th>単元</th><th class="n">回平均</th>' +
                '<th class="n">演習</th><th>正答率</th><th class="n">伸びしろ</th></tr></thead>';
  const tb = el('tbody');
  rows.forEach(r => {
    const tr = el('tr', subjClass(r.subject));
    const name = el('td');
    if(sub){
      name.append(el('span','sname', r.name));
    }else{
      name.append(el('span','sname', r.subject));
      name.append(document.createTextNode(' / ' + r.name));
    }
    tr.append(name);
    tr.append(el('td','n', r.avg.toFixed(1)));
    tr.append(el('td','n', r.n ? String(r.n) : '–'));
    const td = el('td');
    const m = el('div','mini'); const sp = el('span');
    sp.style.width = (r.rate*100)+'%';
    sp.style.background = (r.n && r.rate < 0.6) ? 'var(--ng)' : 'var(--s)';
    m.append(sp); td.append(m);
    if(r.n){
      const pc = el('div','note ' + (r.rate >= 0.8 ? 'v-ok' : (r.rate >= 0.6 ? 'v-warn' : 'v-ng')),
                    Math.round(r.rate*100)+'%');
      pc.style.fontWeight = '700';
      td.append(pc);
    }else{
      td.append(el('div','note v-none','未着手'));
    }
    tr.append(td);
    tr.append(el('td','n', r.gain.toFixed(2)));
    tb.append(tr);
  });
  t.append(tb);
}
function renderLog(){
  if(!BUNDLE) return;
  const cnt = {};
  const all = [];
  for(const [id,p] of PROG){
    p.attempts.forEach(a => { cnt[a.reason] = (cnt[a.reason]||0)+1; all.push({id, ...a}); });
  }
  const rs = $('#reasonStats'); rs.innerHTML = '';
  const total = Object.values(cnt).reduce((a,b)=>a+b, 0);
  if(!total){ rs.append(el('p','empty','まだ記録がありません。')); }
  else{
    const ROWS = [...REASONS_NG, ...REASONS_OK,
                  {k:'unrecorded', label:'理由未記録（中断）'}];
    ROWS.forEach(r => {
      const n = cnt[r.k] || 0; if(!n) return;
      const row = el('div','score-row');
      row.style.gridTemplateColumns = '128px 1fr 78px';
      const lab = el('div','nm', r.label);
      lab.style.cssText = 'font-size:12.5px;white-space:nowrap';
      row.append(lab);
      const bar = el('div','bar'); const sp = el('span');
      sp.style.width = (n/total*100)+'%';
      sp.style.background = (r.k === 'guess' || r.k === 'unrecorded') ? 'var(--warn)'
                          : (REASONS_OK.some(x=>x.k===r.k) ? 'var(--ok)' : 'var(--ng)');
      bar.append(sp); row.append(bar);
      const fig = el('div','fig'); fig.innerHTML = `<b>${n}</b>　${Math.round(n/total*100)}%`;
      row.append(fig);
      rs.append(row);
    });
  }

  // 直近の解答
  all.sort((a,b) => b.t.localeCompare(a.t));
  const ht = $('#histTable');
  ht.innerHTML = '<thead><tr><th>日時</th><th>問題</th><th>結果</th><th class="n">秒</th></tr></thead>';
  const htb = el('tbody');
  all.slice(0, 40).forEach(a => {
    const q = QMAP.get(a.id); if(!q) return;
    const tr = el('tr', subjClass(q.subject));
    tr.append(el('td','', a.t.slice(5,16).replace('T',' ')));
    const qt = el('td');
    qt.append(document.createTextNode(sitLabel(q.sitting) + ' '));
    qt.append(el('span','sname', q.subject));
    qt.append(document.createTextNode(` ${q.exam === '実技' ? '実技' : ''}問${q.no}`));
    tr.append(qt);
    const td = el('td');
    const cls = a.ok ? (a.reason==='guess' ? 'warn' : 'ok') : 'ng';
    td.append(el('span','chip '+cls, (a.ok?'○':'×') + ' ' + (REASON_LABEL[a.reason]||'')));
    tr.append(td);
    tr.append(el('td','n', String(a.sec)));
    htb.append(tr);
  });
  ht.append(htb);
}

/* ---------------- GitHub 同期 ----------------
 * スマホの IndexedDB にある解答記録を private リポジトリへ上げ、
 * PC 側の /fp3 weak・status から読めるようにする。
 * 設定しない限り、このアプリは外部へ一切送信しない。 */
const GH_DEFAULT = {repo:'nakayama-wataru807-ai/personal_sync',
                    path:'fp3/app_progress.json', token:'', auto:true,
                    last:null, lastCount:0};
let GH = {...GH_DEFAULT};

function b64enc(str){
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for(let i = 0; i < bytes.length; i += CH)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
function b64dec(s){
  const bin = atob(String(s).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

async function ghLoad(){
  const rec = await idbGet('kv', 'gh');
  GH = {...GH_DEFAULT, ...(rec ? rec.v : {})};
  renderSync();
}
async function ghSave(){
  await idbPut('kv', {k:'gh', v:GH});
  renderSync();
}
async function ghApi(method, url, body){
  const r = await fetch(url, {
    method,
    headers: {'Authorization': 'Bearer ' + GH.token,
              'Accept': 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28'},
    body: body ? JSON.stringify(body) : undefined,
  });
  if(r.status === 404) return null;
  if(!r.ok) throw new Error(`GitHub ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

function mergeProgress(remote, local){
  const byId = new Map(remote.map(p => [p.id, p]));
  for(const p of local){
    const r = byId.get(p.id);
    if(!r){ byId.set(p.id, p); continue; }
    const seen = new Set(r.attempts.map(a => a.t));
    const attempts = r.attempts
      .concat(p.attempts.filter(a => !seen.has(a.t)))
      .sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const lastOf = x => (x.attempts.length ? x.attempts[x.attempts.length-1].t : '');
    const base = lastOf(p) > lastOf(r) ? p : r;
    byId.set(p.id, {...base, attempts});
  }
  return [...byId.values()];
}
function daysFromProgress(progress){
  const m = {};
  for(const p of progress) for(const a of p.attempts){
    const d = String(a.t).slice(0, 10);
    const r = m[d] || (m[d] = {d, count:0, sec:0});
    r.count += 1; r.sec += a.sec || 0;
  }
  return Object.values(m).sort((a,b) => a.d.localeCompare(b.d));
}

let syncInFlight = false;
let syncCooldownUntil = 0;   // 失敗が続くとき自動同期を止める時刻

async function syncNow(silent){
  const msg = $('#syMsg');
  if(!GH.token || !GH.repo){
    if(!silent) msg.textContent = '設定が未入力です。リポジトリとトークンを保存してください。';
    return false;
  }
  if(syncInFlight) return false;   // 多重実行を防ぐ（低速回線での 409 スパム対策）
  syncInFlight = true;
  const url = `https://api.github.com/repos/${GH.repo}/contents/${GH.path}`;
  try{
    if(!silent) msg.textContent = '同期中…';
    const cur = await ghApi('GET', url);
    let remote = [];
    if(cur && cur.content){
      try{ remote = (JSON.parse(b64dec(cur.content)).progress) || []; }
      catch(e){ remote = []; }
    }
    const merged = mergeProgress(remote, [...PROG.values()]);
    const days = daysFromProgress(merged);
    const payload = {
      synced: new Date().toISOString(),
      exam_date: examDate(),
      device: navigator.userAgent.slice(0, 80),
      progress: merged,
      days,
    };
    await ghApi('PUT', url, {
      message: `FP3 学習記録を同期: ${merged.length}問 (${todayStr()})`,
      content: b64enc(JSON.stringify(payload, null, 1)),
      sha: cur ? cur.sha : undefined,
    });

    for(const p of merged){ PROG.set(p.id, p); await idbPut('prog', p); }
    for(const d of days) await idbPut('day', d);

    GH.last = new Date().toISOString();
    GH.lastCount = merged.length;
    await ghSave();
    syncCooldownUntil = 0;
    if(!silent) msg.textContent = `同期しました（${merged.length}問）。`;
    render();
    return true;
  }catch(err){
    // 失敗が続くとき（PAT 失効・オフライン等）は 10 分間 自動同期を止める。
    // 手動の「今すぐ同期」は syncNow(false) なのでクールダウンに関係なく走る。
    syncCooldownUntil = Date.now() + 10 * 60 * 1000;
    msg.textContent = '同期に失敗: ' + err.message;
    return false;
  }finally{
    syncInFlight = false;
  }
}

function renderSync(){
  const set = !!(GH.token && GH.repo);
  $('#syState').textContent = set ? (GH.auto ? '自動' : '手動') : '未設定';
  $('#syLast').textContent = GH.last ? GH.last.slice(5,16).replace('T',' ') : '–';
  $('#syCount').textContent = GH.lastCount || '–';
  $('#syRepo').value = GH.repo;
  $('#syPath').value = GH.path;
  $('#syToken').value = GH.token ? '••••••••' : '';
  $('#syAuto').checked = !!GH.auto;
}

/* ---------------- 書き出し ---------------- */
async function exportProgress(){
  const days = await idbAll('day');
  const out = {exported:new Date().toISOString(), exam_date:examDate(),
               progress:[...PROG.values()], days};
  const blob = new Blob([JSON.stringify(out, null, 1)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fp3_progress_${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $('#dataMsg').textContent =
    `${out.progress.length}問分の進捗を書き出しました。FP3/data/ に置くと分析スクリプトが読めます。`;
}

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
boot();
