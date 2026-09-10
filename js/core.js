/* =====================================================================
   core.js — FOUNDATIONAL LAYER (load this FIRST, before every other file)

   Provides to all other files:
     storage:      sGet, sSet, DB, currentExam, loadDB, save*(), clearExam
     utils:        uid, sleep, esc, fmtDate, fmtSecs, renderMath,
                   shuffleArr, shuffleOptionsArr, normalizeSig,
                   runWithConcurrency
     modal system: openModal, closeModal, onModalClose, openConfirmModal
     misc UI:      toast, showBatchLoading/updateBatchLoading/hideBatchLoading

   Nothing in this file depends on gemini-model.js / ingestion.js /
   exam-generation.js / the inline app script — it is the base everything
   else is built on. If you only need to touch ingestion or exam-question
   generation, you do NOT need to touch this file.
===================================================================== */

/* ---------------- storage ---------------- */
const mem = {};
const LS_PREFIX = 'digniroy:';
async function sGet(key){
  try{
    const raw = localStorage.getItem(LS_PREFIX+key);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return mem[key] !== undefined ? mem[key] : null; }
}
async function sSet(key, val){
  try{ localStorage.setItem(LS_PREFIX+key, JSON.stringify(val)); }
  catch(e){ mem[key] = val; }
}
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

/* ---------------- shared app state ---------------- */
let DB = { profile:null, groups:[], chapters:[], questions:[], history:[] };
let currentExam = null;

async function loadDB(){
  DB.profile = await sGet('profile');
  DB.groups = (await sGet('groups')) || [];
  DB.chapters = (await sGet('chapters')) || [];
  DB.questions = (await sGet('questions')) || [];
  DB.history = (await sGet('history')) || [];
  currentExam = await sGet('exam:current');
}
async function saveGroups(){ await sSet('groups', DB.groups); }
async function saveChapters(){ await sSet('chapters', DB.chapters); }
async function saveQuestions(){ await sSet('questions', DB.questions); }
async function saveHistory(){ await sSet('history', DB.history); }
async function saveExam(){ await sSet('exam:current', currentExam); }
async function clearExam(){ currentExam = null; try{ localStorage.removeItem(LS_PREFIX+'exam:current'); }catch(e){ delete mem['exam:current']; } }

/* ---------------- generic utils ---------------- */
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove('show'), 2900);
}
function renderMath(text){
  if(!text) return '';
  const esc0 = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let out = '', i = 0;
  while(i < text.length){
    if(text[i] === '$'){
      const end = text.indexOf('$', i+1);
      if(end === -1){ out += esc0(text.slice(i)); break; }
      const expr = text.slice(i+1, end);
      try{ out += katex.renderToString(expr, {throwOnError:false}); }
      catch(e){ out += esc0(expr); }
      i = end+1;
    } else {
      let next = text.indexOf('$', i);
      if(next === -1) next = text.length;
      out += esc0(text.slice(i, next));
      i = next;
    }
  }
  return out;
}
function fmtDate(ts){
  const d = new Date(ts);
  return d.toLocaleDateString('bn-BD', {day:'numeric', month:'short'}) + ' · ' + d.toLocaleTimeString('bn-BD',{hour:'2-digit',minute:'2-digit'});
}
function fmtSecs(s){
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s/60), r = s%60;
  return String(m).padStart(2,'0')+':'+String(r).padStart(2,'0');
}
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function shuffleArr(arr){ for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }
function shuffleOptionsArr(options, correctIndex){
  const idxArr = options.map((_,i)=>i);
  shuffleArr(idxArr);
  const shuffled = idxArr.map(i=>options[i]);
  const newCorrectIndex = idxArr.indexOf(correctIndex);
  return { options: shuffled, correctIndex: newCorrectIndex };
}
function normalizeSig(stem){ return (stem||'').toLowerCase().replace(/[^\u0980-\u09FF0-9a-z]/g,'').slice(0,140); }
async function runWithConcurrency(tasks, limit){
  let idx = 0;
  async function worker(){
    while(idx < tasks.length){
      const cur = idx++;
      try{ await tasks[cur](); }catch(e){}
    }
  }
  const workers = Array.from({length: Math.min(limit, tasks.length)}, worker);
  await Promise.all(workers);
}

/* ---------------- modal system (with close-hooks so other modules can
   register "when this modal closes, do X" without core.js knowing
   anything about them) ---------------- */
let modalCloseHandlers = [];
function onModalClose(fn){ modalCloseHandlers.push(fn); }
function openModal(html){
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('show');
}
function closeModal(){
  document.getElementById('modal-overlay').classList.remove('show');
  const handlers = modalCloseHandlers; modalCloseHandlers = [];
  handlers.forEach(fn=>{ try{ fn(); }catch(e){} });
}
document.getElementById('modal-overlay').addEventListener('click', e=>{ if(e.target.id==='modal-overlay') closeModal(); });

function openConfirmModal({title, message, confirmText, cancelText, tone, onConfirm}){
  const toneClass = tone==='danger' ? 'btn-danger' : 'btn-gold';
  openModal(`
    <h3>${esc(title)}</h3>
    <p style="color:var(--ink-soft); font-size:.94rem; line-height:1.65; margin-bottom:22px;">${message}</p>
    <div class="btn-row">
      <button class="btn ${toneClass}" id="confirm-modal-yes">${esc(confirmText)}</button>
      <button class="btn" onclick="closeModal()">${esc(cancelText)}</button>
    </div>
  `);
  document.getElementById('confirm-modal-yes').onclick = ()=>{ closeModal(); onConfirm(); };
}

/* ---------------- blocking batch-loading screen (used only while the
   first exam batch is being prepared) ---------------- */
function showBatchLoading(msg){
  let el = document.getElementById('batch-loading');
  if(!el){
    el = document.createElement('div');
    el.id = 'batch-loading';
    el.innerHTML = `<div class="spinner-lg"></div><div id="batch-loading-text"></div>`;
    document.body.appendChild(el);
  }
  document.getElementById('batch-loading-text').textContent = msg;
  el.style.display = 'flex';
}
function updateBatchLoading(msg){ const t=document.getElementById('batch-loading-text'); if(t) t.textContent = msg; }
function hideBatchLoading(){ const el=document.getElementById('batch-loading'); if(el) el.remove(); }
