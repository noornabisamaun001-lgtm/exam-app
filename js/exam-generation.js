/* exam-generation.js — exam question generation from saved core questions

   NEW THIS ROUND: previously, once a source pattern ran out of unique
   variations (retries exhausted), that slot was just SKIPPED — the
   requested total (e.g. 100) permanently fell short (e.g. 33), and
   whichever single pattern kept succeeding ended up dominating the tail
   of the exam, which looked like "everything after Q17 is basically the
   same question".

   Fix: a source that truly runs out gets marked EXHAUSTED (so we stop
   wasting calls on it), and a REFILL PASS then redistributes the
   shortfall across the OTHER, still-viable patterns in the pool — up to
   several extra rounds — instead of just accepting the shortfall. Only
   when the entire pool is exhausted does the exam actually fall short,
   and that's reported honestly via examSkippedCount.

   ALSO FIXED THIS ROUND: buildNeedItems previously reshuffled a fresh
   "round" order every pass, which only guaranteed no-same-source-twice
   WITHIN a round — nothing stopped the same source from landing last in
   round R and first in round R+1, producing exactly the back-to-back
   clustering seen in real exams (e.g. four "|z-a|/|z-b|=c" locus
   questions in a row). Replaced with a greedy "most-remaining-first,
   never repeat the immediately-previous source" scheduler, which
   guarantees no two adjacent slots share a source whenever that's
   mathematically possible for the given pool/need sizes.

   Also carried over from before: per-source generation history sent to
   the AI so it stops producing trivial sign-flip/reciprocal "variations"
   of the same question.
*/
let examSkippedCount=0;
let sourceVariationHistory=new Map(); // sourceId -> stems already generated this exam
let exhaustedSources=new Set();       // sourceIds that produced 0 more valid variations after full retry
function resetExamSkipCounter(){
  examSkippedCount=0;
  sourceVariationHistory=new Map();
  exhaustedSources=new Set();
}

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
function fallbackFromConcept(){ return null; }
function pickUnusedFallback(){ return null; }

/* ---------------- need calculation — no-adjacent-repeat scheduling ----------------
   Distributes `n` slots across `pool` sources as evenly as possible (extras
   randomized across sources so it isn't always the same ones getting the
   +1), then walks a greedy scheduler: at every step, place a slot from
   whichever source(s) currently have the most remaining, picking randomly
   among ties, but never repeating the source that was placed immediately
   before. This guarantees no two ADJACENT slots share a source whenever
   that's mathematically possible (i.e. unless one source's need is more
   than half of n, in which case some adjacency is unavoidable and the
   scheduler falls back to the least-bad option). */
function buildNeedItems(pool, n){
  if(!pool.length) return { numericNeed:[], conceptNeed:[] };

  const base = Math.floor(n / pool.length);
  const remainder = n % pool.length;
  const extraSet = new Set(shuffleArr(pool.map((_,i)=>i)).slice(0, remainder));
  const remaining = pool
    .map((_,i)=>({ i, c: base + (extraSet.has(i) ? 1 : 0) }))
    .filter(x=>x.c>0);

  const slots = [];
  let lastIdx = -1;
  while(slots.length < n && remaining.length){
    remaining.sort((a,b)=> b.c - a.c);
    const topCount = remaining[0].c;
    const tier = remaining.filter(x=>x.c===topCount);
    let pick = tier.length>1 ? tier[Math.floor(Math.random()*tier.length)] : tier[0];
    if(pick.i===lastIdx){
      const alt = tier.find(x=>x.i!==lastIdx) || remaining.find(x=>x.i!==lastIdx);
      if(alt) pick = alt; // else: unavoidable repeat, pool too small for a gap here
    }
    slots.push(pool[pick.i]);
    pick.c--;
    lastIdx = pick.i;
    if(pick.c===0) remaining.splice(remaining.indexOf(pick),1);
  }

  return {
    numericNeed: slots.filter(x=>x.type==='numeric').map(x=>({...x, need:1})),
    conceptNeed: slots.filter(x=>x.type!=='numeric').map(x=>({...x, need:1}))
  };
}

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
  const payload = items.map(it=>({
    id: it.id, need: it.need, stem: it.stem, options: it.options,
    correctIndex: it.correctIndex, explanation: it.explanation||'',
    avoid: it.avoid||[]
  }));
  return `তুমি বাংলাদেশের ভর্তি পরীক্ষার জন্য STRICT MCQ VARIATION ENGINE।

প্রতিটি source-এর মূল concept, required knowledge, solving method, difficulty ও answer logic অপরিবর্তিত রাখবে।

VARIATION আসলেই ভিন্ন হতে হবে — এটা কঠোরভাবে মানবে:
- শুধু sign flip করা, fraction উল্টানো, বা numerator/denominator অদল-বদল করা — এগুলো বৈধ variation না।
- প্রতিটি variation-এ প্রকৃতপক্ষে ভিন্ন সংখ্যা/coefficient/জটিল সংখ্যা ব্যবহার করবে যা দিয়ে গণনা করলে ভিন্ন intermediate step লাগে, কিন্তু concept ও method একই থাকে।
- প্রতিটি item-এর "avoid" তালিকায় যা আছে তার কাছাকাছি গঠনের কিছু বানাবে না।
- একই source-এর দুই variation একে অপরের duplicate বা near-duplicate হতে পারবে না।

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

/* runConceptBatch: asks the AI efficiently (aggregated per source id
   within this chunk), distributes results by walking the interleaved
   chunk order, and — only at the deepest retry — marks a source
   EXHAUSTED and reports back how many items it truly couldn't fill, so
   the caller can redistribute that shortfall elsewhere. */
async function runConceptBatch(chunk, pushFn, conceptPoolAll, usedSig, depth=0){
  const byId = new Map();
  for(const it of chunk){
    const existing = byId.get(it.id);
    if(existing) existing.need += it.need;
    else byId.set(it.id, {...it});
  }
  const payloadItems = [...byId.values()].map(it=>({
    ...it, avoid: (sourceVariationHistory.get(it.id)||[]).slice(-15)
  }));

  let data=null;
  try{ data = await callGeminiAPI({ text: buildExamGenPrompt(payloadItems) }); }catch(_){}
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
      if(pushFn(q)){
        placed = true;
        const hist = sourceVariationHistory.get(it.id) || [];
        hist.push(q.stem);
        sourceVariationHistory.set(it.id, hist);
      }
    }
    if(!placed) retryList.push(it);
  }

  if(!retryList.length) return 0;
  if(depth<3){
    return await runConceptBatch(retryList, pushFn, conceptPoolAll, usedSig, depth+1);
  }
  // exhausted at max depth — this source genuinely can't give more right now
  retryList.forEach(it=>exhaustedSources.add(it.id));
  examSkippedCount += retryList.length;
  return retryList.length;
}
async function runConceptChunks(chunks, pushFn, conceptPoolAll, usedSig){
  for(const c of chunks) await runConceptBatch(c, pushFn, conceptPoolAll, usedSig, 0);
}

/* After the normally-assigned queue is processed, if some slots came up
   short, try to fill that same number of questions from OTHER, still-
   viable patterns in the pool instead of just accepting the shortfall.
   Bounded to a few extra passes so a fully-exhausted pool can't loop
   forever. */
async function refillShortfall(pushFn, conceptPoolAll, usedSig){
  if(!currentExam || examSkippedCount<=0) return;
  let attemptsLeft = 4;
  while(examSkippedCount>0 && attemptsLeft>0 && currentExam){
    attemptsLeft--;
    const candidates = conceptPoolAll.filter(x=>!exhaustedSources.has(x.id));
    if(!candidates.length) break; // truly nothing left in the whole pool
    const need = examSkippedCount;
    examSkippedCount = 0; // this pass re-reports whatever still can't be filled
    const { conceptNeed } = buildNeedItems(candidates, need);
    if(!conceptNeed.length) break;
    for(const batch of buildChunks(conceptNeed, 25)){
      if(!currentExam) return;
      await runConceptChunks([batch], pushFn, conceptPoolAll, usedSig);
      await saveExam();
    }
  }
}

/* ---------------- background generation ---------------- */
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
  for(const batch of buildChunks(queue, 25)){
    if(!currentExam) return;
    await runConceptChunks([batch], push, conceptPoolAll, usedSig);
    await saveExam();
  }
  await refillShortfall(push, conceptPoolAll, usedSig);
  finishConceptLoading();
}
function finishConceptLoading(){
  if(currentExam){ currentExam.pendingConcept=false; saveExam(); }
  document.getElementById('loading-more-indicator')?.remove();
  if(examSkippedCount) toast(`⚠ ${examSkippedCount}টি প্রশ্নের জন্য পুরো ব্যাংক থেকেও নতুন valid variation পাওয়া যায়নি`);
}
