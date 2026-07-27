/* 一級建築士 学科ドリル
 *
 * このファイルにもリポジトリの docs/ にも、試験問題そのものは含まれない。
 * 問題データ（bundle.json）は端末ごとに手元から読み込み、IndexedDB に置く。
 * JAEIC の規約（個人利用の目的以外の転載・複製を禁止）を守るための構成。
 */
'use strict';

const EXAM_DATE = '2027-07-25';   // 令和9年 学科試験（7月第4日曜の見込み）
const DB_NAME = 'kenchiku-drill', DB_VER = 1;

/* 科目テーマカラーの対応。CSS 側に .s-<key> が定義してあり、
 * その配下では var(--s) / var(--s-w) で科目色が引ける。 */
const SUBJECTS = ['計画', '環境', '法規', '構造', '施工'];
const SUBJECT_KEY = {計画:'keikaku', 環境:'kankyo', 法規:'hoki', 構造:'kozo', 施工:'seko'};
const subjClass = s => 's-' + (SUBJECT_KEY[s] || 'kozo');

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
let BUNDLE = null;          // {questions, unit_stats, target, cutoff, ...}
let FIGS = {};              // 図版（別ファイル・任意）。名前 -> data URI
let QMAP = new Map();       // id -> question
let PROG = new Map();       // id -> progress
let SESSION = null;         // 進行中のセッション

const todayStr = () => new Date().toLocaleDateString('sv-SE');   // YYYY-MM-DD
const daysBetween = (a,b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const addDays = (s,n) => { const d=new Date(s); d.setDate(d.getDate()+n); return d.toLocaleDateString('sv-SE'); };
const $ = s => document.querySelector(s);
const el = (t,c,txt) => { const e=document.createElement(t); if(c)e.className=c; if(txt!=null)e.textContent=txt; return e; };
const mmss = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;

/* ---------------- 間隔反復（SM-2） ---------------- */
/* 既存アプリ（合格ロケット・スタディング・速学）はいずれも「周回」型で、
 * 忘却タイミングに合わせた出題最適化を持たない。ここが自作する意味。 */
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
  // これを入れないと素の SM-2 では間隔が本番を追い越し、二度と復習されない問題が出る。
  const left = daysBetween(todayStr(), EXAM_DATE);
  if(left > 0) p.interval = Math.max(1, Math.min(p.interval, Math.floor(left / 2)));
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
  {k:'knowledge', label:'知識不足',           q:0},
  {k:'misread',   label:'読み違い',           q:1},
  {k:'calc',      label:'計算ミス',           q:1},
  {k:'lookup',    label:'法令集で引けなかった', q:1},
  {k:'timeout',   label:'時間切れ',           q:1},
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
  $('#hdDays').textContent = Math.max(0, daysBetween(todayStr(), EXAM_DATE));
  wire();
  render();
}
function setBundle(b){
  BUNDLE = b;
  QMAP = new Map(b.questions.map(q => [q.id, q]));
  $('#importCard').hidden = true;
  $('#todayCard').hidden = false;
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
  ['#selMode','#selSubject','#selYear','#selUnit'].forEach(s => $(s).onchange = updatePool);
  $('#selSubject').addEventListener('change', fillUnitFilter);
  $('#uSubject').onchange = renderUnits;
}
function jumpQuiz(mode){
  document.querySelector('nav button[data-v="quiz"]').click();
  $('#selMode').value = mode;
  updatePool();
}
/* bundle.json（問題）と figures.json（図版）のどちらを渡されても受け取る。
 * 図版は 7〜8MB あるので分けてある。図版なしでも 875問中 794問はそのまま解ける。 */
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
  // 問題だけ入っていて図版が無い間は、取り込み口を出したままにする
  $('#importCard').hidden = !!(BUNDLE && nf);
}

function fillFilters(){
  for(const sel of ['#selSubject','#uSubject']){
    const s = $(sel);
    s.innerHTML = '<option value="">全科目</option>';
    SUBJECTS.forEach(x => s.append(new Option(x, x)));
  }
  const y = $('#selYear');
  y.innerHTML = '<option value="">全年度</option>';
  [...BUNDLE.years].reverse().forEach(v => {
    const q = BUNDLE.questions.find(q => q.year === v);
    y.append(new Option(q ? `${q.wareki}（${v}）` : v, v));
  });
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
  const yr = $('#selYear').value, unit = $('#selUnit').value;
  const t = todayStr();
  return BUNDLE.questions.filter(q => {
    if(sub && q.subject !== sub) return false;
    if(yr && String(q.year) !== yr) return false;
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
  const pool = buildPool();
  $('#poolMsg').textContent = `該当 ${pool.length} 問`;
  $('#startBtn').disabled = pool.length === 0;
}

/* ---------------- セッション ---------------- */
function shuffle(a){
  for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function startSession(){
  const n = +$('#selCount').value;
  const pool = buildPool();
  if(!pool.length) return;
  // 復習は期日の古い順、それ以外はシャッフル
  const mode = $('#selMode').value;
  let list = mode === 'due'
    ? pool.sort((a,b) => prog(a.id).due.localeCompare(prog(b.id).due))
    : shuffle(pool.slice());
  SESSION = {queue:list.slice(0, n), done:[], total:Math.min(n,list.length),
             current:null, t0:Date.now(), qt0:0, picked:null,
             answered:false, recorded:false, suspended:false, timer:null};
  $('#quizSetup').hidden = true; $('#resultCard').hidden = true; $('#quizArea').hidden = false;
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
  }, 500);
}
function showQuestion(q){
  // 科目色をカードに乗せる（タグ・左帯が var(--s) を拾う）
  const card = $('#quizCard');
  card.className = 'card subj ' + subjClass(q.subject);
  $('#qSubject').textContent = q.subject;
  $('#qYear').textContent = `${q.wareki} No.${q.no}`;
  $('#qUnit').textContent = q.unit || '未分類';
  $('#qProg').textContent = `${SESSION.done.length+1} / ${SESSION.total}`;
  $('#qTimer').textContent = '0:00';
  $('#qStem').textContent = q.stem;

  const figs = $('#qFigs'); figs.innerHTML = '';
  let shown = 0;
  (q.figure || []).forEach(name => {
    const src = FIGS[name];
    if(!src) return;
    const w = el('div','figwrap'); const im = el('img'); im.src = src; im.loading='lazy';
    im.alt = '問題のページ画像'; w.append(im); figs.append(w); shown++;
  });
  if(!shown && (q.figure || []).length){
    figs.append(el('p','note','※図版が未取込です。ホームの初回セットアップから figures.json を読み込むと表示されます。'));
  }else if(!shown && !q.choices.length){
    figs.append(el('p','note','※この問題は本文を取り込めていません。問題集の該当ページを参照してください。'));
  }

  const box = $('#qChoices'); box.innerHTML = '';
  if(q.choices.length){
    q.choices.forEach((c,i) => {
      const b = el('button','choice');
      b.append(el('span','n', String(i+1)));
      b.append(el('span','', c));
      b.onclick = () => answer(i+1, b);
      box.append(b);
    });
  }else{
    // 図版のみの問題はページ画像を見て 1〜4 を選ぶ
    [1,2,3,4].forEach(i => {
      const b = el('button','choice');
      b.append(el('span','n', String(i)));
      b.append(el('span','', `肢 ${i}`));
      b.onclick = () => answer(i, b);
      box.append(b);
    });
  }
  $('#afterBox').hidden = true;
  $('#lawBox').hidden = q.subject !== '法規';
  $('#lawInput').value = '';
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
  });

  const v = $('#verdict');
  v.className = 'verdict ' + (ok ? 'ok' : 'ng');
  v.innerHTML = '';
  v.append(document.createTextNode(ok ? `正解（肢${q.answer}）` : `不正解 — 正答は肢${q.answer}`));
  const s = el('small','', `${mmss(SESSION.sec)} で解答` +
    (q.explain ? '' : ' ／ 解説は未作成（/kenchikushi explain で生成できます）'));
  v.append(s);

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
                   sec:Math.round(SESSION.sec), law:$('#lawInput').value.trim() || null});
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

/* 中断。ここまでの解答は記録し、まだ解いていない問題は出題プールへ返す。
 * 採点済みなのに理由を選ぶ前に中断した場合は「理由未記録」として残す
 * （正解=quality3・不正解=quality1。何も残さないより復習予定が正しくなる）。 */
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
  // 1問も解かずに中断したときは、結果を出さずに設定画面へ戻す
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
  const cnt = {};
  att.forEach(a => { cnt[a.reason] = (cnt[a.reason]||0)+1; });
  Object.entries(cnt).sort((a,b) => b[1]-a[1]).forEach(([k,n]) => {
    const cls = (k === 'guess' || k === 'unrecorded') ? 'warn'
              : (REASONS_OK.some(r => r.k === k) ? 'ok' : 'ng');
    br.append(el('span', 'chip '+cls, `${REASON_LABEL[k]||k} ${n}`));
  });
  render();
  // 自動同期。失敗しても演習の記録は端末に残っているので黙って見送る
  if(GH.auto && GH.token && GH.repo && ids.length) syncNow(true);
}

/* ---------------- 描画 ---------------- */
function render(){
  if(!BUNDLE) return;
  renderHome(); renderUnits(); renderLog(); updatePool();
}
function subjectAccuracy(){
  const acc = {};
  for(const s of SUBJECTS) acc[s] = {ok:0, n:0};
  for(const [id,p] of PROG){
    const q = QMAP.get(id); if(!q || !p.attempts.length) continue;
    const a = p.attempts[p.attempts.length-1];
    acc[q.subject].n += 1;
    if(a.ok && a.reason !== 'guess') acc[q.subject].ok += 1;   // 勘の正解は実力に数えない
  }
  return acc;
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
  // 連続日数。今日まだ解いていない場合は昨日から数える（当日中に途切れ表示にしない）
  let streak = 0;
  let i = days.some(x => x.d === t && x.count > 0) ? 0 : 1;
  for(; i < 400; i++){
    if(days.some(x => x.d === addDays(t, -i) && x.count > 0)) streak++;
    else break;
  }
  $('#stStreak').textContent = streak;

  const acc = subjectAccuracy(), box = $('#scoreBars');
  box.innerHTML = '';
  // 未着手の科目は「0点」ではなく「未計測」。0.0/30 と出すと実力を過小に見せてしまう
  let est = 0, maxMeasured = 0;
  for(const s of ['法規','構造','施工','環境','計画']){
    const max = BUNDLE.subject_max[s], tgt = BUNDLE.target[s], cut = BUNDLE.cutoff[s];
    const n = acc[s].n;
    const rate = n ? acc[s].ok/n : 0;
    const pt = rate * max;
    if(n){ est += pt; maxMeasured += max; }
    const row = el('div','score-row ' + subjClass(s));
    const nm = el('div','nm', s);
    nm.style.color = 'var(--s)';
    row.append(nm);
    const bar = el('div','bar');
    if(n){
      const fill = el('span'); fill.style.width = (rate*100).toFixed(1)+'%';
      bar.append(fill);
    }else{
      bar.style.opacity = '.45';
    }
    const c = el('div','cut'); c.style.left = (cut/max*100)+'%'; bar.append(c);
    const g = el('div','tgt'); g.style.left = (tgt/max*100)+'%'; bar.append(g);
    row.append(bar);
    const fig = el('div','fig');
    if(n){
      const mark = pt >= tgt ? '✅' : (pt >= cut ? '⚠️' : '🔴');
      fig.innerHTML = `${mark}<b>${pt.toFixed(1)}</b>/${max}　目標${tgt}`;
    }else{
      fig.innerHTML = `未計測　目標${tgt}`;
    }
    row.append(fig);
    box.append(row);
  }
  // 合計は「計測済みの科目だけ」で出す。全科目に手を付けるまでは推定にならない
  const sum = el('div','score-row');
  sum.append(el('div','nm','合計'));
  const b2 = el('div','bar');
  if(maxMeasured){
    const f2 = el('span');
    const scaled = est / maxMeasured * 125;      // 計測済み範囲の正答率を125点に引き伸ばす
    f2.style.width = (scaled/125*100).toFixed(1)+'%';
    f2.style.background = scaled >= 95 ? 'var(--ok)' : (scaled >= 88 ? 'var(--warn)' : 'var(--ng)');
    b2.append(f2);
  }else{
    b2.style.opacity = '.45';
  }
  const c2 = el('div','cut'); c2.style.left = (88/125*100)+'%'; b2.append(c2);
  const g2 = el('div','tgt'); g2.style.left = (95/125*100)+'%'; b2.append(g2);
  sum.append(b2);
  const fg = el('div','fig');
  fg.innerHTML = maxMeasured
    ? `<b>${(est/maxMeasured*125).toFixed(0)}</b>/125　目標95`
    : '未計測　目標95';
  sum.append(fg);
  box.append(sum);
  const cov = el('p','note');
  cov.style.margin = '6px 0 0';
  cov.textContent = maxMeasured
    ? `※ 合計は演習済みの範囲（${maxMeasured}点分）の正答率を125点に引き伸ばした推定です。`
      + (maxMeasured < 125 ? '未着手の科目は含みません。' : '')
    : '※ まだ演習の記録がありません。';
  box.append(cov);
}
function renderUnits(){
  if(!BUNDLE) return;
  const sub = $('#uSubject').value;
  const stats = BUNDLE.unit_stats.units;
  const rows = [];
  for(const [name, s] of Object.entries(stats)){
    if(name === '（未分類）') continue;
    if(sub && s.subject !== sub) continue;
    let n=0, ok=0;
    for(const q of BUNDLE.questions){
      if(q.unit !== name) continue;
      const p = PROG.get(q.id); if(!p || !p.attempts.length) continue;
      const a = p.attempts[p.attempts.length-1];
      n++; if(a.ok && a.reason !== 'guess') ok++;
    }
    const rate = n ? ok/n : 0;
    // 未着手は「伸びしろ最大」とみなす（rate=0 相当）
    rows.push({name, subject:s.subject, avg:s.avg_per_year, total:s.total,
               n, rate, gain: s.avg_per_year * (1 - rate)});
  }
  rows.sort((a,b) => b.gain - a.gain);
  const t = $('#unitTable');
  t.innerHTML = '<thead><tr><th>単元</th><th class="n">年平均</th>' +
                '<th class="n">演習</th><th>正答率</th><th class="n">伸びしろ</th></tr></thead>';
  const tb = el('tbody');
  rows.forEach(r => {
    const tr = el('tr', subjClass(r.subject));
    const name = el('td');
    name.append(el('span','dot'));
    name.append(document.createTextNode((sub ? '' : r.subject + ' / ') + r.name));
    tr.append(name);
    tr.append(el('td','n', r.avg.toFixed(1)));
    tr.append(el('td','n', r.n ? String(r.n) : '–'));
    const td = el('td');
    const m = el('div','mini'); const sp = el('span');
    sp.style.width = (r.rate*100)+'%';
    sp.style.background = (r.n && r.rate < 0.6) ? 'var(--ng)' : 'var(--s)';
    m.append(sp); td.append(m);
    td.append(el('div','note', r.n ? Math.round(r.rate*100)+'%' : '未着手'));
    tr.append(td);
    tr.append(el('td','n', r.gain.toFixed(2)));
    tb.append(tr);
  });
  t.append(tb);
}
function renderLog(){
  if(!BUNDLE) return;
  // 誤答理由の集計
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

  // 法規の条文別 所要時間
  const law = {};
  all.forEach(a => {
    if(!a.law) return;
    (law[a.law] = law[a.law] || []).push(a.sec);
  });
  const lt = $('#lawTable');
  lt.innerHTML = '<thead><tr><th>条文</th><th class="n">回数</th><th class="n">平均秒</th><th class="n">最長</th></tr></thead>';
  const ltb = el('tbody');
  const lawRows = Object.entries(law)
    .map(([k,v]) => ({k, n:v.length, avg:v.reduce((a,b)=>a+b,0)/v.length, max:Math.max(...v)}))
    .sort((a,b) => b.avg - a.avg).slice(0, 20);
  if(!lawRows.length){
    const tr = el('tr'); const td = el('td','','まだ記録がありません');
    td.colSpan = 4; td.className = 'note'; tr.append(td); ltb.append(tr);
  }
  lawRows.forEach(r => {
    const tr = el('tr');
    tr.append(el('td','', r.k));
    tr.append(el('td','n', String(r.n)));
    const td = el('td','n', Math.round(r.avg)+'s');
    if(r.avg > 53) td.style.color = 'var(--ng)';    // 1肢52.5秒が本番の制約
    tr.append(td);
    tr.append(el('td','n', Math.round(r.max)+'s'));
    ltb.append(tr);
  });
  lt.append(ltb);

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
    qt.append(el('span','dot'));
    qt.append(document.createTextNode(`${q.wareki} ${q.subject} No.${q.no}`));
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
 * PC 側の /kenchikushi weak・status から読めるようにする。
 * 設定しない限り、このアプリは外部へ一切送信しない。
 */
/* 同期先は専用の private リポジトリにする。試験データを持つ 1st-ClassArchitect と
 * 分けておけば、端末に置くトークンが問題データに触れられない。 */
const GH_DEFAULT = {repo:'nakayama-wataru807-ai/personal_sync',
                    path:'kenchiku/app_progress.json', token:'', auto:true,
                    last:null, lastCount:0};
let GH = {...GH_DEFAULT};

function b64enc(str){
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;                       // 一度に spread すると大きい入力で落ちる
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

/* 端末をまたいでも失われないよう、リモートとローカルを問題IDで突き合わせる。
 * 解答履歴は時刻で重複を除いて統合し、SRS 状態は最後に解いた側を採る。 */
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
/* 日別集計は解答履歴から作り直す。別々に持つと端末間でずれるため。 */
function daysFromProgress(progress){
  const m = {};
  for(const p of progress) for(const a of p.attempts){
    const d = String(a.t).slice(0, 10);
    const r = m[d] || (m[d] = {d, count:0, sec:0});
    r.count += 1; r.sec += a.sec || 0;
  }
  return Object.values(m).sort((a,b) => a.d.localeCompare(b.d));
}

async function syncNow(silent){
  const msg = $('#syMsg');
  if(!GH.token || !GH.repo){
    if(!silent) msg.textContent = '設定が未入力です。リポジトリとトークンを保存してください。';
    return false;
  }
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
      exam_date: EXAM_DATE,
      device: navigator.userAgent.slice(0, 80),
      progress: merged,
      days,
    };
    await ghApi('PUT', url, {
      message: `学習記録を同期: ${merged.length}問 (${todayStr()})`,
      content: b64enc(JSON.stringify(payload, null, 1)),
      sha: cur ? cur.sha : undefined,
    });

    // 統合結果を手元にも反映（他端末で解いた分がこちらにも入る）
    for(const p of merged){ PROG.set(p.id, p); await idbPut('prog', p); }
    for(const d of days) await idbPut('day', d);

    GH.last = new Date().toISOString();
    GH.lastCount = merged.length;
    await ghSave();
    if(!silent) msg.textContent = `同期しました（${merged.length}問）。`;
    render();
    return true;
  }catch(err){
    msg.textContent = '同期に失敗: ' + err.message;
    return false;
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
  const out = {exported:new Date().toISOString(), exam_date:EXAM_DATE,
               progress:[...PROG.values()], days};
  const blob = new Blob([JSON.stringify(out, null, 1)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kenchiku_progress_${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $('#dataMsg').textContent =
    `${out.progress.length}問分の進捗を書き出しました。1st-ClassArchitect/data/ に置くと分析スクリプトが読めます。`;
}

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
boot();
