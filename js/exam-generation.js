/* =====================================================================
   exam-generation.js — THE "GENERATING EXAM QUESTIONS" MODULE

   Given a pool of saved question patterns, this file is entirely
   responsible for turning them into the actual questions shown in an
   exam. If you only need to change how questions are generated at exam
   time (numeric math logic, AI concept-variation prompt, batching,
   duplicate-avoidance/fallback strategy), you only need to replace THIS
   file.

   Depends on (from core.js): shuffleArr, shuffleOptionsArr, normalizeSig,
     runWithConcurrency, toast
   Depends on (from gemini-model.js): callGeminiAPI
   Depends on the global `math` object (mathjs library, loaded in <head>)

   Exposes to the rest of the app (used by beginExam() in index.html):
     buildNeedItems(pool, n), buildChunks(items), makePushInto(target, usedSig),
     generateNumericInstant(item), runConceptChunks(chunks, pushFn, conceptPoolAll, usedSig),
     runConceptGenerationInBackground(queue, usedSig, conceptPoolAll),
     resetExamSkipCounter(), fallbackFromConcept(item)
   Also defines (used by the exam-runner UI in index.html):
     appendGeneratedQuestion(q), renumberQuestions(), finishConceptLoading()
===================================================================== */

// Counts how many exam slots had to be silently dropped because neither AI
// nor the saved dataset had anything left that was still unique. Reset at
// the start of every beginExam() call; reported once background generation
// finishes (see finishConceptLoading below).
let examSkippedCount = 0;
function resetExamSkipCounter(){ examSkippedCount = 0; }

/* ---------------- NUMERIC ENGINE (instant, offline, never saved) ---------------- */
function subst(text, values){ return text.replace(/\{(\w+)\}/g, (m,k)=> values[k]!==undefined ? values[k] : m); }
function safeEval(expr){
  try{
    const v = math.evaluate(expr);
    if(typeof v !== 'number' || !isFinite(v) || Number.isNaN(v)) return null;
    return Math.round(v*1000)/1000;
  }catch(e){ return null; }
}
function generateNumericInstant(it){
  const tryOnce = (scope)=>{
    const values = it.optionExprs.map(e=>safeEval(subst(e,scope)));
    if(values.some(v=>v===null)) return null;
    const uniqueVals = new Set(values.map(v=>v.toString()));
    if(uniqueVals.size !== values.length) return null;
    const stemText = subst(it.stem, scope);
    const {options, correctIndex} = shuffleOptionsArr(values.map(v=>String(v)), it.correctIndex);
    return { chapterId: it.chapterId, stem: stemText, options, correctIndex, explanation: it.explanation||'' };
  };
  for(let attempt=0; attempt<40; attempt++){
    const scope = {};
    (it.variables||[]).forEach(v=>{ const lo=Math.ceil(v.min), hi=Math.floor(v.max); scope[v.name] = lo + Math.floor(Math.random()*Math.max(1,(hi-lo+1))); });
    const r = tryOnce(scope);
    if(r) return r;
  }
  const scope = {};
  (it.variables||[]).forEach(v=>{ scope[v.name] = Math.round((v.min+v.max)/2); });
  return tryOnce(scope) || { chapterId: it.chapterId, stem: subst(it.stem,scope), options: it.optionExprs.map(e=>{const v=safeEval(subst(e,scope)); return v===null?'—':String(v);}), correctIndex: it.correctIndex, explanation: it.explanation||'' };
}

/* ---------------- CONCEPT: fallback helpers (no AI available / AI failed) ---------------- */
function fallbackFromConcept(it){
  const {options, correctIndex} = shuffleOptionsArr(it.options, it.correctIndex);
  return { chapterId: it.chapterId, stem: it.stem, options, correctIndex, explanation: it.explanation||'' };
}
// When even this source's own question is already used elsewhere in the exam, pull ANY other
// still-unused concept pattern from the whole chapter pool instead of forcing a literal repeat.
function pickUnusedFallback(conceptPoolAll, usedSig){
  for(const it of (conceptPoolAll||[])){
    const sig = normalizeSig(it.stem);
    if(!sig || !usedSig.has(sig)) return fallbackFromConcept(it);
  }
  return null; // truly nothing unique left anywhere in the data
}

/* ---------------- CONCEPT: live AI variation ---------------- */
function buildExamGenPrompt(items){
  const payload = items.map(it=>({ id: it.id, need: it.need, stem: it.stem, options: it.options, correctIndex: it.correctIndex, explanation: it.explanation||'' }));
  return `তুমি একজন বাংলাদেশের ভর্তি পরীক্ষা প্রস্তুতি বিশেষজ্ঞ AI। নিচে কিছু মূল ধারণাভিত্তিক MCQ দেওয়া হলো — প্রতিটির সাথে "need" সংখ্যা আছে, ঠিক ততগুলো সম্পূর্ণ নতুন, সতেজ ভ্যারিয়েশন বানাতে হবে।

নিয়মাবলী:
- প্রসঙ্গ/উদাহরণ/শব্দচয়ন বদলে দাও, মূল ধারণা অক্ষুণ্ণ রেখে।
- একই "id"-এর একাধিক ভ্যারিয়েশন চাইলে সেগুলো একে অপরের থেকেও সম্পূর্ণ ভিন্ন হতে হবে। পুরো তালিকার কোনো দুটি আইটেমই একে অপরের সাথে হুবহু বা প্রায় হুবহু মিলবে না।
- মূল প্রশ্ন কোনো চিত্র/figure-নির্ভর হলে প্রয়োজনীয় মান লেখাতেই বর্ণনা করে দাও।
- গাণিতিক রাশি লিখতে $...$ ব্যবহার করো।
- প্রতিটি ব্যাখ্যা সম্পূর্ণ নির্ভুল, বিস্তারিত ও ধাপে ধাপে হতে হবে (কমপক্ষে ২-৩ বাক্য)।
- ৪টি করে অপশন, ঠিক একটি সঠিক। মূল ভাষা (বাংলা/ইংরেজি) বজায় রাখো।

ঠিক এই আকারে আউটপুট দাও (অন্য কিছু লিখবে না, মার্কডাউন কোড ব্লকও না):
{ "generated": [ {"sourceId":"...", "stem":"...", "options":["...","...","...","..."], "correctIndex":0, "explanation":"..."} ] }

সোর্স প্রশ্নসমূহ:
${JSON.stringify(payload)}`;
}

/* ---------------- need-planning + batching (shared by numeric and concept) ---------------- */
function buildNeedItems(pool, n){
  const poolShuffled = shuffleArr([...pool]);
  const needMap = new Map();
  let total=0, i=0, guard=0;
  while(total<n && guard<n*6){
    const item = poolShuffled[i % poolShuffled.length];
    needMap.set(item.id, (needMap.get(item.id)||0)+1);
    total++; i++; guard++;
  }
  const byId = new Map(pool.map(p=>[p.id,p]));
  const needItems = [...needMap.entries()].map(([id,need])=>({...byId.get(id), need}));
  return { numericNeed: needItems.filter(it=>it.type==='numeric'), conceptNeed: needItems.filter(it=>it.type!=='numeric') };
}
function buildChunks(items){
  const chunks = []; let cur=[], curNeed=0;
  for(const it of items){
    if(curNeed + it.need > 15 && cur.length){ chunks.push(cur); cur=[]; curNeed=0; }
    cur.push(it); curNeed += it.need;
  }
  if(cur.length) chunks.push(cur);
  return chunks;
}
function makePushInto(targetArrayOrFn, usedSig){
  return function pushQ(q, allowDup){
    const s = normalizeSig(q.stem);
    if(s && usedSig.has(s) && !allowDup) return false;
    if(s) usedSig.add(s);
    if(typeof targetArrayOrFn === 'function') targetArrayOrFn(q);
    else targetArrayOrFn.push(q);
    return true;
  };
}

/* Runs one or more AI batches for concept-type need-items. For any slot the AI didn't (fully)
   cover — a failed call, quota exhaustion, or simply fewer results than asked — falls back to
   the SYSTEM's own saved data instead of erroring out: first the source's own question, then
   (if that's already used) any other unused pattern from the chapter, and only as an absolute
   last resort drops the slot (never a forced literal duplicate). */
async function runConceptChunks(chunks, pushFn, conceptPoolAll, usedSig){
  const tasks = chunks.map(chunk => async ()=>{
    let gen = null;
    try{ const data = await callGeminiAPI({text: buildExamGenPrompt(chunk)}); gen = Array.isArray(data.generated)?data.generated:[]; }
    catch(e){ gen = null; }
    const bySource = {};
    if(Array.isArray(gen)) gen.forEach(g=>{ if(g && g.sourceId){ (bySource[g.sourceId]=bySource[g.sourceId]||[]).push(g); } });
    chunk.forEach(it=>{
      const arr = bySource[it.id] || []; let used = 0;
      for(const g of arr){
        if(used>=it.need) break;
        if(!g || !g.stem || !Array.isArray(g.options) || g.options.length<2) continue;
        let ci = Number.isInteger(g.correctIndex)?g.correctIndex:0; if(ci<0||ci>=g.options.length) ci=0;
        const q = { chapterId: it.chapterId, stem:g.stem, options:g.options, correctIndex:ci, explanation:g.explanation||it.explanation||'' };
        if(pushFn(q)) used++;
      }
      let remaining = it.need - used;
      while(remaining > 0){
        const own = fallbackFromConcept(it);
        if(pushFn(own)){ remaining--; continue; }
        const alt = pickUnusedFallback(conceptPoolAll, usedSig);
        if(alt && pushFn(alt)){ remaining--; continue; }
        examSkippedCount++; remaining--; // nothing unique left anywhere — skip this slot
      }
    });
  });
  await runWithConcurrency(tasks, 3);
}

/* ---------------- background continuation (after the exam has already started) ---------------- */
function appendGeneratedQuestion(q){
  if(!currentExam) return;
  const idx = currentExam.questions.length;
  currentExam.questions.push(q);
  saveExam();
  if(location.hash === '#/exam'){
    const wrap = document.getElementById('q-wrap');
    if(wrap){
      const indicator = document.getElementById('loading-more-indicator');
      const html = renderQuestionBlock(q, idx);
      if(indicator){ indicator.insertAdjacentHTML('beforebegin', html); }
      else { wrap.insertAdjacentHTML('beforeend', html); }
      renumberQuestions();
    }
  }
}
function renumberQuestions(){
  if(!currentExam) return;
  const total = currentExam.questions.length;
  document.querySelectorAll('#q-wrap .q-num').forEach((el,i)=>{ el.textContent = `প্রশ্ন ${i+1} / ${total}`; });
  const tc = document.getElementById('total-count'); if(tc) tc.textContent = total;
}
async function runConceptGenerationInBackground(conceptQueue, usedSig, conceptPoolAll){
  if(!conceptQueue.length){ finishConceptLoading(); return; }
  const apiKey = await sGet('geminiApiKey');
  const pushBg = makePushInto(appendGeneratedQuestion, usedSig);
  if(!apiKey){
    conceptQueue.forEach(it=>{
      let remaining = it.need;
      while(remaining>0){
        const own = fallbackFromConcept(it);
        if(pushBg(own)){ remaining--; continue; }
        const alt = pickUnusedFallback(conceptPoolAll, usedSig);
        if(alt && pushBg(alt)){ remaining--; continue; }
        examSkippedCount++; remaining--;
      }
    });
    finishConceptLoading(); return;
  }
  await runConceptChunks(buildChunks(conceptQueue), pushBg, conceptPoolAll, usedSig);
  finishConceptLoading();
}
function finishConceptLoading(){
  if(currentExam){ currentExam.pendingConcept = false; saveExam(); }
  const el = document.getElementById('loading-more-indicator');
  if(el) el.remove();
  if(examSkippedCount>0){
    toast(`⚠ ${examSkippedCount}টি প্রশ্ন ইউনিক রাখা সম্ভব হয়নি বলে বাদ দেওয়া হয়েছে — মোট প্রশ্ন একটু কম`);
  }
}
