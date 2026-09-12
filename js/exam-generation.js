/* exam-generation.js — Mastery Exam patched generation
   Keeps existing exam UI/result/explanation. Main changes:
   1) 25 actual questions per generation batch.
   2) No literal concept fallback duplicates.
   3) Numeric questions are generated locally from saved formulas.
   4) AI options are strictly validated and shuffled with the correct index.
*/
let examSkippedCount=0;
function resetExamSkipCounter(){examSkippedCount=0}
function egSubst(t,v){return String(t||'').replace(/\{([A-Za-z]\w*)\}/g,(m,k)=>Object.prototype.hasOwnProperty.call(v,k)?String(v[k]):m)}
function egEval(e){try{const v=math.evaluate(e);if(typeof v!=='number'||!Number.isFinite(v))return null;return Math.abs(v-Math.round(v))<1e-9?Math.round(v):Math.round(v*1000)/1000}catch(_){return null}}
function egInt(a,b){a=Math.ceil(Number(a));b=Math.floor(Number(b));return Number.isFinite(a)&&Number.isFinite(b)&&a<=b?a+Math.floor(Math.random()*(b-a+1)):null}
function egScope(it){const s={};for(const v of it.variables||[]){const n=egInt(v.min,v.max);if(n===null)return null;s[v.name]=n}return s}
function egSig(q){return String(q.stem||'').toLowerCase().replace(/\s+/g,'').replace(/[^\u0980-\u09ffa-z0-9]/g,'')+'||'+(q.options||[]).map(x=>String(x).toLowerCase().replace(/\s+/g,'')).join('|')}
function egPush(target,q,used){if(!q)return false;const s=egSig(q);if(!s||used.has(s))return false;used.add(s);target(q);return true}
/* makePushInto — glue function that was missing entirely. beginExam() in
   index.html calls `makePushInto(initialQuestions, usedSig)` and expects back
   a single-argument function it can call as `pushInit(q)`. Without this,
   beginExam() threw ReferenceError the instant "পরীক্ষা শুরু করুন" was clicked
   and the exam could never start. Wraps egPush around a plain array push. */
function makePushInto(arr, usedSig){
  return function(q){ return egPush(item=>arr.push(item), q, usedSig); };
}
function egFour(a){return Array.isArray(a)&&a.length===4&&a.every(x=>String(x).trim())&&new Set(a.map(x=>String(x).trim().toLowerCase())).size===4}
function generateNumericInstant(it,usedSig){
  for(let k=0;k<160;k++){
    const scope=egScope(it);if(!scope)return null;
    const vals=(it.optionExprs||[]).map(e=>egEval(egSubst(e,scope)));
    if(vals.length!==4||vals.some(v=>v===null)||new Set(vals.map(String)).size!==4)continue;
    const shuffled=shuffleOptionsArr(vals.map(String),Number(it.correctIndex));
    const q={chapterId:it.chapterId,sourceId:it.id,type:'numeric',stem:egSubst(it.stem,scope),
      options:shuffled.options,correctIndex:shuffled.correctIndex,explanation:egSubst(it.explanation||'',scope)};
    if(!usedSig||!usedSig.has(egSig(q)))return q;
  }return null;
}
/* Intentionally no literal fallback: replaying the saved stem defeats the app's purpose. */
function fallbackFromConcept(){return null}
function pickUnusedFallback(){return null}
function buildNeedItems(pool,n){
  const p=shuffleArr([...pool]),m=new Map();
  for(let i=0;i<n;i++){let x=p[i%p.length];m.set(x.id,(m.get(x.id)||0)+1)}
  const by=new Map(pool.map(x=>[x.id,x]));
  return {numericNeed:[...m].map(([id,need])=>({...by.get(id),need})).filter(x=>x.type==='numeric'),
    conceptNeed:[...m].map(([id,need])=>({...by.get(id),need})).filter(x=>x.type!=='numeric')}
}
function buildChunks(items,batchSize=25){
  const out=[],cur=[];let count=0;
  for(const it of items){let left=it.need;while(left){const take=Math.min(left,batchSize-count);cur.push({...it,need:take});count+=take;left-=take;if(count===batchSize){out.push(cur.splice(0));count=0}}}
  if(cur.length)out.push(cur.splice(0));return out;
}
function buildExamGenPrompt(items){
  const payload=items.map(it=>({id:it.id,need:it.need,stem:it.stem,options:it.options,correctIndex:it.correctIndex,explanation:it.explanation||''}));
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
async function runConceptBatch(chunk,pushFn,conceptPoolAll,usedSig,depth=0){
  let data=null;try{data=await callGeminiAPI({text:buildExamGenPrompt(chunk)})}catch(_){}
  const gs=Array.isArray(data?.generated)?data.generated:[],by={};
  gs.forEach(g=>{if(g?.sourceId)(by[g.sourceId]??=[]).push(g)});
  for(const it of chunk){
    let accepted=0;
    for(const g of by[it.id]||[]){
      if(accepted>=it.need||!g||!String(g.stem||'').trim()||!egFour(g.options))continue;
      const ci=Number(g.correctIndex);if(!Number.isInteger(ci)||ci<0||ci>3)continue;
      const q={chapterId:it.chapterId,sourceId:it.id,type:'concept',stem:String(g.stem).trim(),
        options:g.options.map(x=>String(x).trim()),correctIndex:ci,explanation:String(g.explanation||it.explanation||'').trim()};
      if(pushFn(q))accepted++;
    }
    if(accepted<it.need&&depth<2)await runConceptBatch([{...it,need:it.need-accepted}],pushFn,conceptPoolAll,usedSig,depth+1);
    else if(accepted<it.need)examSkippedCount+=it.need-accepted;
  }
}
async function runConceptChunks(chunks,pushFn,conceptPoolAll,usedSig){for(const c of chunks)await runConceptBatch(c,pushFn,conceptPoolAll,usedSig,0)}
function appendGeneratedQuestion(q){
  if(!currentExam)return;const idx=currentExam.questions.length;currentExam.questions.push(q);saveExam();
  if(location.hash==='#/exam'){const wrap=document.getElementById('q-wrap');if(wrap){const ind=document.getElementById('loading-more-indicator');const html=renderQuestionBlock(q,idx);if(ind)ind.insertAdjacentHTML('beforebegin',html);else wrap.insertAdjacentHTML('beforeend',html);renumberQuestions()}}
}
function renumberQuestions(){if(!currentExam)return;document.querySelectorAll('#q-wrap .q-num').forEach((e,i)=>e.textContent=`প্রশ্ন ${i+1} / ${currentExam.questions.length}`);const t=document.getElementById('total-count');if(t)t.textContent=currentExam.questions.length}
async function runConceptGenerationInBackground(queue,usedSig,conceptPoolAll){
  if(!queue.length){finishConceptLoading();return}
  const push=q=>egPush(appendGeneratedQuestion,q,usedSig);
  for(const batch of buildChunks(queue,25)){if(!currentExam)return;await runConceptChunks([batch],push,conceptPoolAll,usedSig);await saveExam()}
  finishConceptLoading()
}
function finishConceptLoading(){
  if(currentExam){currentExam.pendingConcept=false;saveExam()}
  document.getElementById('loading-more-indicator')?.remove();
  if(examSkippedCount)toast(`⚠ ${examSkippedCount}টি বৈধ variation তৈরি করা যায়নি; ভুল/duplicate প্রশ্ন দেখানো হয়নি`);
}
