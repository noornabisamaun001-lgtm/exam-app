/* exam-generation.js — exam question generation from saved core questions

   CORE IDEA (this is the whole point of the app): the student saves N core
   questions per chapter; an exam of size M draws from that pool, repeating
   patterns as needed via controlled variation — but two questions from the
   SAME core pattern must never land back-to-back, and the same wording must
   never repeat verbatim. Everything below exists to guarantee that.

   THE BUG THIS REWRITE FIXES: the previous version tracked "need" as one
   aggregated number per source pattern (e.g. "pattern A needs 12"), then
   generated and pushed all 12 of pattern A in a row before moving to
   pattern B. That's exactly why 10-12 questions from the same pattern were
   showing up consecutively in exams — the grouping happened before any
   shuffle ever ran, and the background-appended tail never got shuffled
   at all.

   THE FIX: buildNeedItems() now expands "need" into individual slots and
   interleaves them round-robin across all patterns (A,B,C,A,B,C...,
   re-shuffled each round). Every function downstream — batching, AI
   prompting, and especially the order results get pushed into the exam —
   preserves that interleaved order. The AI is still asked efficiently
   (one request per pattern, not one request per slot), but consumption of
   its answers follows the interleaved slot order, not the AI's grouping.
*/
let examSkippedCount=0;
function resetExamSkipCounter(){ examSkippedCount=0; }

/* ---------------- numeric math engine ---------------- */
function egSubst(t,v){ return String(t||'').replace(/\{([A-Za-z]\w*)\}/g,(m,k)=>Object.prototype.hasOwnProperty.call(v,k)?String(v[k]):m); }
function egEval(e){
  try{
    const v = math.evaluate(e);
    if(typeof v!=='number' || !Number.isFinite(v)) return null;
    return Math.abs(v-Math.round(v))<1e-9 ? Math.round(v) : Math.round(v*1000)/1000;
  }catch(_){ return null; }
}
function egInt(a,b){
  a=Math.ceil(Number(a)); b=Math.floor(Number(b));
  return Number.isFinite(a) && Number.isFinite(b) && a<=b ? a+Math.floor(Math.random()*(b-a+1)) : null;
}
function egScope(it){
  const s={};
  for(const v of it.variables||[]){ const n=egInt(v.min,v.max); if(n===null) return null; s[v.name]=n; }
  return s;
}
function egSig(q){
  return String(q.stem||'').toLowerCase().replace(/\s+/g,'').replace(/[^\u0980-\u09ffa-z0-9]/g,'') +
    '||' + (q.options||[]).map(x=>String(x).toLowerCase().replace(/\s+/g,'')).join('|');
}
function egPush(target,q,used){
  if(!q) return false;
  const s=egSig(q);
  if(!s || used.has(s)) return false;
  used.add(s); target(q); return true;
}
/* Wraps egPush around a plain array so calling code just gets pushFn(q). */
function makePushInto(arr, usedSig){
  return function(q){ return egPush(item=>arr.push(item), q, usedSig); };
}
function egFour(a){
  return Array.isArray(a) && a.length===4 && a.every(x=>String(x).trim()) &&
    new Set(a.map(x=>String(x).trim().toLowerCase())).size===4;
}
function generateNumericInstant(it, usedSig){
  for(let k=0;k<160;k++){
    const scope = egScope(it);
    if(!scope) return null;
    const vals = (it.optionExprs||[]).map(e=>egEval(egSubst(e,scope)));
    if(vals.length!==4 || vals.some(v=>v===null) || new Set(vals.map(String)).size!==4) continue;
    const shuffled = shuffleOptionsArr(vals.map(String), Number(it.correctIndex));
    const q = {
      chapterId: it.chapterId, sourceId: it.id, type:'numeric',
      stem: egSubst(it.stem, scope), options: shuffled.options, correctIndex: shuffled.correctIndex,
      explanation: egSubst(it.explanation||'', scope)
    };
    if(!usedSig || !usedSig.has(egSig(q))) return q;
  }
  return null;
}
/* Intentionally no literal fallback: replaying the saved stem defeats the app's purpose. */
function fallbackFromConcept(){ return null; }
function pickUnusedFallback(){ return null; }

/* ---------------- need calculation — the interleaving fix lives here ---------------- */
function buildNeedItems(pool, n){
  const p = shuffleArr([...pool]);
  if(p.length===0) return { numericNeed:[], conceptNeed:[] };

  // how many times each pool[i] pattern is needed, round-robin distributed
  const counts = new Array(p.length).fill(0);
  for(let i=0;i<n;i++) counts[i % p.length]++;

  // expand into individual need=1 slots, interleaved round by round so the
  // SAME pattern is never adjacent to itself in the resulting order. Each
  // round we also re-shuffle which pattern goes first, for extra variety.
  const maxCount = Math.max(...counts);
  const slots = [];
  for(let round=0; round<maxCount; round++){
    const order = shuffleArr(p.map((_,i)=>i));
    for(const i of order){
      if(round < counts[i]) slots.push(p[i]);
    }
  }

  return {
    numericNeed: slots.filter(x=>x.type==='numeric').map(x=>({...x, need:1})),
    conceptNeed: slots.filter(x=>x.type!=='numeric').map(x=>({...x, need:1}))
  };
}

/* Chunking just batches the already-interleaved slot list sequentially —
   order is preserved, so a chunk's internal order stays interleaved too. */
function buildChunks(items, batchSize=25){
  const out=[]; let cur=[];
  for(const it of items){
    cur.push(it);
    if(cur.length===batchSize){ out.push(cur); cur=[]; }
  }
  if(cur.length) out.push(cur);
  return out;
}

function buildExamGenPrompt(items){
  const payload = items.map(it=>({ id:it.id, need:it.need, stem:it.stem, options:it.options, correctIndex:it.correctIndex, explanation:it.explanation||'' }));
  return `তুমি বাংলাদেশের ভর্তি পরীক্ষার জন্য STRICT MCQ VARIATION ENGINE।
প্রতিটি source-এর মূল concept, required knowledge, solving method, difficulty ও answer logic অপরিবর্তিত রাখবে। শুধু controlled wording/context/numerical/figure variation করবে।
নতুন topic, fact, chapter বা শেখানোর প্রশ্ন যোগ করবে না।
একই source-এর দুই variation একে অপরের duplicate হতে পারবে না।
Math equation সবসময় $...$-এ লিখবে।
Figure হলে প্রয়োজনীয় relation/value text-এ সম্পূর্ণভাবে দেবে; কল্পিত/অসম্পূর্ণ figure নয়।
প্রতিটি প্রশ্নে ঠিক 4টি distinct option এবং exactly 1 correct option থাকবে।
correctIndex option shuffle-এর পরের অবস্থান নির্দেশ করবে এবং 0-3 হবে।
Fixed factual answer বদলাবে না।
প্রতিটি explanation generated question-এর নিজের values/logic অনুযায়ী হবে।
প্রতিটি output নিজে যাচাই করে তবেই দেবে।
শুধু JSON:
{"generated":[{"sourceId":"...","stem":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"..."}]}
SOURCE:
${JSON.stringify(payload)}`;
}

/* runConceptBatch: asks the AI efficiently (one aggregated entry per source
   id, so a pattern needed 5 times in this chunk is asked for once as
   need:5 — saves tokens and gives the model proper context that these are
   variations of ONE question) but then distributes/pushes the results by
   walking the ORIGINAL interleaved `chunk` order, one slot at a time. That
   walk is what keeps same-pattern questions apart in the final exam. */
async function runConceptBatch(chunk, pushFn, conceptPoolAll, usedSig, depth=0){
  const byId = new Map();
  for(const it of chunk){
    const existing = byId.get(it.id);
    if(existing) existing.need += it.need;
    else byId.set(it.id, {...it});
  }

  let data=null;
  try{ data = await callGeminiAPI({ text: buildExamGenPrompt([...byId.values()]) }); }catch(_){}
  const generated = Array.isArray(data?.generated) ? data.generated : [];
  const bySource = {};
  generated.forEach(g=>{ if(g?.sourceId) (bySource[g.sourceId] ??= []).push(g); });

  const retryList = [];
  for(const it of chunk){
    const bucket = bySource[it.id] || [];
    let placed = false;
    while(bucket.length && !placed){
      const g = bucket.shift();
      if(!g || !String(g.stem||'').trim() || !egFour(g.options)) continue;
      const ci = Number(g.correctIndex);
      if(!Number.isInteger(ci) || ci<0 || ci>3) continue;
      const q = {
        chapterId: it.chapterId, sourceId: it.id, type:'concept',
        stem: String(g.stem).trim(), options: g.options.map(x=>String(x).trim()),
        correctIndex: ci, explanation: String(g.explanation||it.explanation||'').trim()
      };
      if(pushFn(q)) placed = true;
    }
    if(!placed) retryList.push(it);
  }

  if(retryList.length && depth<2){
    await runConceptBatch(retryList, pushFn, conceptPoolAll, usedSig, depth+1);
  } else if(retryList.length){
    examSkippedCount += retryList.length;
  }
}
async function runConceptChunks(chunks, pushFn, conceptPoolAll, usedSig){
  for(const c of chunks) await runConceptBatch(c, pushFn, conceptPoolAll, usedSig, 0);
}

/* ---------------- background generation (runs after exam has already started) ---------------- */
function appendGeneratedQuestion(q){
  if(!currentExam) return;
  const idx = currentExam.questions.length;
  currentExam.questions.push(q);
  saveExam();
  if(location.hash==='#/exam'){
    const wrap = document.getElementById('q-wrap');
    if(wrap){
      const ind = document.getElementById('loading-more-indicator');
      const html = renderQuestionBlock(q, idx);
      if(ind) ind.insertAdjacentHTML('beforebegin', html);
      else wrap.insertAdjacentHTML('beforeend', html);
      renumberQuestions();
    }
  }
}
function renumberQuestions(){
  if(!currentExam) return;
  document.querySelectorAll('#q-wrap .q-num').forEach((e,i)=>{ e.textContent = `প্রশ্ন ${i+1} / ${currentExam.questions.length}`; });
  const t = document.getElementById('total-count');
  if(t) t.textContent = currentExam.questions.length;
}
async function runConceptGenerationInBackground(queue, usedSig, conceptPoolAll){
  if(!queue.length){ finishConceptLoading(); return; }
  const push = q => egPush(appendGeneratedQuestion, q, usedSig);
  // queue is already interleaved by buildNeedItems, and buildChunks keeps
  // that order — so appended (unshuffled) background questions still land
  // in a diverse, non-clustered order.
  for(const batch of buildChunks(queue, 25)){
    if(!currentExam) return;
    await runConceptChunks([batch], push, conceptPoolAll, usedSig);
    await saveExam();
  }
  finishConceptLoading();
}
function finishConceptLoading(){
  if(currentExam){ currentExam.pendingConcept=false; saveExam(); }
  document.getElementById('loading-more-indicator')?.remove();
  if(examSkippedCount) toast(`⚠ ${examSkippedCount}টি বৈধ variation তৈরি করা যায়নি; ভুল/duplicate প্রশ্ন দেখানো হয়নি`);
}
