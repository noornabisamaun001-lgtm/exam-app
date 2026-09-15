/* ingestion.js — question input / ingestion / save

   TWO-STEP PIPELINE (this rewrite's core change):

   The single-call approach asked the model to do two hard things at once
   — (a) figure out where each question/fact starts and ends in messy,
   irregular input, AND (b) build a fully-formed MCQ (options, correct
   answer, explanation) in strict JSON for every one of them — in one
   shot. Under that combined load the model was taking the "few but
   complete" path: fully building a handful of items and treating the
   rest as done, rather than genuinely covering the whole input.

   Splitting those into two separate calls fixes this directly:

   STEP 1 — buildListPrompt(): a LIGHT task. Read the whole input and
   just list every question/fact found — an index, a type hint, and a
   faithful one-line summary (with the original math/tags kept intact).
   No options, no JSON schema pressure beyond a simple list. This is
   exactly the task a person skimming the page and jotting down "here's
   Q1, here's Q2..." would do, and it's the part that needs to be
   exhaustive — so it's kept as cheap and unambiguous as possible.

   STEP 2 — buildElaboratePrompt(): for each small batch (6 at a time)
   of Step 1's list, build the full MCQ, using the ORIGINAL input again
   as the source of truth for exact wording/values. Because the boundary
   question ("where does this item start/end") was already solved in
   Step 1, batching here is safe — there's no risk of cutting a question
   in half, since each item was already identified as a whole unit.

   A short, explicit "only take 3,7" instruction skips this pipeline
   entirely and uses a single direct call — there's no exhaustiveness
   problem to solve when the ask is already narrow.

   Dependencies: core.js, gemini-model.js
*/
let currentIngestChapterId=null, attachedImage=null, ingestBusy=false;
let ingestSeenSigs=new Set();

/* ---------------- text/signature helpers ---------------- */
function cleanIngestText(s=''){ return String(s).replace(/\s+/g,' ').trim(); }
function canonIngest(s=''){
  return cleanIngestText(s).toLowerCase()
    .replace(/[""'']/g,'')
    .replace(/[।,;:!?()[\]{}<>\/\\|+=_*^~$%#@-]/g,'')
    .replace(/\s/g,'');
}
function ingestItemSig(q){
  const opts = (q.options || q.optionExprs || []).map(canonIngest).join('|');
  return canonIngest(q.stem||'') + '||' + opts + '||' + String(q.correctIndex ?? '');
}
function ingestSimilarity(a,b){
  a=canonIngest(a); b=canonIngest(b);
  if(!a||!b) return 0;
  if(a===b) return 1;
  const A=new Set(a.match(/[a-z\u0980-\u09ff0-9]+/g)||[]);
  const B=new Set(b.match(/[a-z\u0980-\u09ff0-9]+/g)||[]);
  let n=0; A.forEach(x=>B.has(x)&&n++);
  return n / Math.max(1, new Set([...A,...B]).size);
}
function ingestNearDuplicate(stem, existingInChapter){
  const s = canonIngest(stem);
  if(!s) return true;
  return existingInChapter.some(q => canonIngest(q.stem)===s || ingestSimilarity(q.stem, stem) >= 0.94);
}
function fourDistinct(a){
  return Array.isArray(a) && a.length===4 && a.every(x=>cleanIngestText(x)) &&
    new Set(a.map(canonIngest)).size===4;
}
function explicitSelection(s=''){
  const text = (s||'').trim();
  // A genuine "only take 3,7" instruction is always a short command. A long
  // pasted document can legitimately CONTAIN words like "marked"/"চিহ্নিত"
  // as part of its own content without that being an instruction right now.
  if(text.length > 200) return false;
  return /শুধু|কেবল|only|just|দাগানো|চিহ্নিত|মার্ক|marked|selected|highlighted|circled/i.test(text) ||
    /(?:নম্বর|no\.?|question)\s*[০-৯0-9]+(?:\s*[,ও&]\s*[০-৯0-9]+)+/i.test(text);
}

/* ---------------- STEP 1: list everything found (light task) ---------------- */
function buildListPrompt(raw=''){
  const selective = explicitSelection(raw);
  return `তুমি একজন অভিজ্ঞ শিক্ষক। ইনপুট (ছবি এবং/অথবা টেক্সট) পড়ে বুঝে নিচ্ছো এতে ঠিক কয়টা আলাদা, সম্পূর্ণ প্রশ্ন/গুরুত্বপূর্ণ তথ্য (fact) আছে।

ইনপুট যেকোনো এলোমেলো ফরম্যাটে থাকতে পারে — নাম্বারিং থাকতে পারে বা নাও থাকতে পারে, নাম্বারিং একাধিকবার ১ থেকে আবার শুরু হতে পারে, একাধিক প্রশ্ন কোনো লাইন-ব্রেক ছাড়াই এক প্যারাগ্রাফে গাঁথা থাকতে পারে। এইটা বোঝাটাই এই ধাপের একমাত্র কাজ — ঠিক যেভাবে একজন মানুষ পাতাটা পড়ে খাতায় টুকে রাখত "এই এক প্রশ্ন, এই আরেকটা..."। এই ধাপে কোনো option/answer/explanation বানানোর দরকার নেই, শুধু চিহ্নিত ও তালিকাভুক্ত করো।

${selective ? 'ইনপুটে স্পষ্ট নির্বাচন-নির্দেশনা আছে (যেমন মার্ক/সার্কেল/"শুধু X,Y") — শুধু সেই নির্দিষ্ট অংশগুলোই তালিকায় দাও।' : 'ইনপুটে কোনো নির্বাচন-নির্দেশনা নেই — যত সম্পূর্ণ প্রশ্ন/তথ্য আছে সবগুলোই তালিকাভুক্ত করো, একটাও বাদ দিও না।'}

প্রতিটা entry-তে:
- idx: ক্রমিক নম্বর (তোমার নিজের গোনা; ইনপুটের নিজের নাম্বারিং অনুসরণ করার দরকার নেই, কারণ সেটা একাধিকবার রিসেট হতে পারে)
- hint: "numeric" (যদি এতে এমন সংখ্যা/মান থাকে যেগুলো বদলে দিলে একই ধরনের নতুন প্রশ্ন বানানো সম্ভব) অথবা "concept" (সংজ্ঞা/জ্যামিতিক ব্যাখ্যা/যুক্তিভিত্তিক — সংখ্যা বদলে variation বানানো অর্থহীন এমন ক্ষেত্রে)
- summary: মূল প্রশ্ন/সমীকরণ হুবহু (math notation সহ), কোনো ট্যাগ থাকলে (যেমন [DU'19-20]) সেটাও রাখবে — এতটা সংক্ষিপ্ত কোরো না যে আসল প্রশ্নটাই হারিয়ে যায়

শুধু বৈধ JSON রিটার্ন করবে, অন্য কোনো টেক্সট না:
{"found":[{"idx":1,"hint":"concept","summary":"..."}]}

ইনপুট:
${raw || '(শুধু ছবি — মনোযোগ দিয়ে দেখো)'}
`;
}

/* ---------------- STEP 2: build full MCQs for one small batch ---------------- */
function buildElaboratePrompt(raw, batch){
  const list = batch.map(b=>`idx ${b.idx} (${b.hint}): ${b.summary}`).join('\n');
  return `তুমি একটি MCQ-নির্মাণ ইঞ্জিন। নিচে মূল ইনপুট (পূর্ণ) দেওয়া আছে, আর একটা তালিকা দেওয়া আছে ঠিক কোন নির্দিষ্ট প্রশ্ন/তথ্যগুলোর জন্য এখন পূর্ণাঙ্গ MCQ বানাতে হবে (idx মিলিয়ে চেনো)। মূল ইনপুট থেকে সেই নির্দিষ্ট অংশের সঠিক মান/সমীকরণ/ভাষা ব্যবহার করবে, অনুমান করবে না।

এখন এই idx গুলোর জন্য পূর্ণাঙ্গ item বানাও:
${list}

প্রতিটার জন্য:
- hint "numeric" হলে: stem-এ {var} আকারে placeholder বসাও (মূল প্রশ্নের নির্দিষ্ট সংখ্যাগুলোকে variable বানিয়ে), প্রতিটা variable-এর যুক্তিসঙ্গত min/max range দাও (যাতে পরে ভিন্ন মান বসিয়ে নতুন version বানানো যায়), এবং সেই variable ব্যবহার করে ৪টা বৈধ, গণনাযোগ্য option expression দাও। correctIndex 0-3 (shuffle-এর পর কোনটা সঠিক)।
- hint "concept" হলে: stem হুবহু মূল প্রশ্ন/তথ্য, ঠিক ৪টা ভিন্ন, plausible option (১টা সঠিক, বাকি ৩টা যুক্তিসঙ্গত ভুল), correctIndex, explanation।
- উভয় ক্ষেত্রে: মূল concept, সমাধান-পদ্ধতি, উত্তরের যুক্তি অপরিবর্তিত রাখবে — নতুন কিছু আবিষ্কার করবে না। বাংলা/ইংরেজি মূল ভাষা বজায় রাখবে। Math সবসময় $...$ এর ভেতরে লিখবে, ভাঙবে না।
- দুইটা item কখনো ডুপ্লিকেট হবে না।

শুধু বৈধ JSON রিটার্ন করবে, অন্য কোনো টেক্সট না:
{"items":[{"idx":1,"type":"concept","stem":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"..."},{"idx":2,"type":"numeric","stem":"...{a}...","variables":[{"name":"a","min":5,"max":25}],"optionExprs":["...","...","...","..."],"correctIndex":0,"explanation":"..."}]}

মূল ইনপুট:
${raw || '(শুধু ছবি)'}
`;
}

/* ---------------- single-call prompt (selective / short-instruction path only) ---------------- */
function buildIngestPrompt(raw='', previous=[]){
  const selective = explicitSelection(raw);
  const prevList = previous.slice(-80);
  const prev = prevList.length
    ? `\nএই stem গুলো ইতিমধ্যে নেওয়া হয়েছে — এগুলো আবার দিও না:\n${prevList.map((x,i)=>`${i+1}. ${x}`).join('\n')}`
    : '';
  return `তুমি একটি নির্ভুল প্রশ্ন-ব্যাংক এক্সট্র্যাকশন ইঞ্জিন। ইনপুটে ছবি এবং/অথবা টেক্সট থাকতে পারে।

সিদ্ধান্তের নিয়ম:
১) ছবিতে মার্ক/সার্কেল/হাইলাইট থাকলে অথবা টেক্সটে নির্দিষ্ট কিছু বেছে দেওয়া থাকলে (যেমন: "শুধু ৩,৭ নাও") — কেবল সেই নির্দিষ্ট অংশগুলোই নাও।
২) এমন কোনো নির্দিষ্ট নির্দেশনা/মার্কিং না থাকলে — ইনপুটে যত বৈধ প্রশ্ন/তথ্য আছে সবগুলোই নাও।
${selective ? '\n→ এই ইনপুটে স্পষ্ট নির্বাচন-নির্দেশনা আছে, তাই নিয়ম ১ প্রযোজ্য।' : '\n→ এই ইনপুটে কোনো নির্বাচন-নির্দেশনা নেই, তাই নিয়ম ২ প্রযোজ্য।'}

প্রতিটি item তৈরির সময়:
- মূল concept, সমাধান পদ্ধতি ও উত্তরের যুক্তি হুবহু বজায় রাখবে।
- বাংলা/ইংরেজি মূল ভাষা অপরিবর্তিত রাখবে। Math সবসময় $...$ এর ভেতরে লিখবে।
- concept item: ঠিক ৪টি ভিন্ন option এবং exactly ১টি সঠিক উত্তর।
- numeric item: stem-এ {var} placeholder, প্রতিটি variable-এর min/max range, এবং ৪টি বৈধ, গণনাযোগ্য option expression।
- দুইটা item কখনো ডুপ্লিকেট হবে না।
- শুধু নিচের ফরম্যাটে বৈধ JSON রিটার্ন করবে, অন্য কোনো টেক্সট না।
${prev}

JSON ফরম্যাট:
{"items":[{"type":"concept","stem":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"..."},{"type":"numeric","stem":"... {a} ...","variables":[{"name":"a","min":5,"max":25}],"optionExprs":["...","...","...","..."],"correctIndex":0,"explanation":"... {a} ..."}]}

ইউজার ইনপুট:
${raw || '(শুধু ছবি — ছবিটা মনোযোগ দিয়ে দেখো)'}
`;
}

/* ---------------- validate + normalize ---------------- */
function normalizeIngestItem(it){
  if(!it || !it.type || !cleanIngestText(it.stem)) return null;
  if(it.type==='numeric'){
    const q = {
      id: uid(), chapterId: currentIngestChapterId, type:'numeric',
      stem: cleanIngestText(it.stem),
      variables: Array.isArray(it.variables) ? it.variables.map(v=>({name:String(v.name||''), min:Number(v.min), max:Number(v.max)})) : [],
      optionExprs: Array.isArray(it.optionExprs) ? it.optionExprs.map(String) : [],
      correctIndex: Number(it.correctIndex),
      explanation: cleanIngestText(it.explanation||'')
    };
    if(q.optionExprs.length!==4 || !Number.isInteger(q.correctIndex) || q.correctIndex<0 || q.correctIndex>3) return null;
    if(!q.variables.length || q.variables.some(v=>!/^[A-Za-z]\w*$/.test(v.name) || !Number.isFinite(v.min) || !Number.isFinite(v.max) || v.min>v.max || v.max-v.min<3)) return null;
    return q;
  }
  if(it.type==='concept' && fourDistinct(it.options)){
    const q = {
      id: uid(), chapterId: currentIngestChapterId, type:'concept',
      stem: cleanIngestText(it.stem),
      options: it.options.map(cleanIngestText),
      correctIndex: Number(it.correctIndex),
      explanation: cleanIngestText(it.explanation||'')
    };
    return (Number.isInteger(q.correctIndex) && q.correctIndex>=0 && q.correctIndex<4) ? q : null;
  }
  return null;
}
async function insertQuestionFromItem(chapterId, item){
  const q = normalizeIngestItem(item);
  if(!q) return false;
  const existing = DB.questions.filter(x=>x.chapterId===chapterId);
  if(ingestNearDuplicate(q.stem, existing) || ingestSeenSigs.has(ingestItemSig(q))) return false;
  DB.questions.push(q);
  ingestSeenSigs.add(ingestItemSig(q));
  return true;
}
async function dedupeChapterQuestions(chapterId){
  const list = DB.questions.filter(q=>q.chapterId===chapterId);
  const keep = [], seen = new Set();
  let removed = 0;
  for(const q of list){
    const sig = ingestItemSig(q);
    if(seen.has(sig) || ingestNearDuplicate(q.stem, keep)){ removed++; continue; }
    seen.add(sig); keep.push(q);
  }
  const ids = new Set(keep.map(q=>q.id));
  DB.questions = DB.questions.filter(q=>q.chapterId!==chapterId || ids.has(q.id));
  await saveQuestions();
  toast(removed ? `ডুপ্লিকেট ${removed}টি মুছে ফেলা হয়েছে` : 'কোনো ডুপ্লিকেট পাওয়া যায়নি');
  const v = document.getElementById('view');
  if(v) v.innerHTML = viewQuestionList(chapterId);
}

/* One direct API call (single-call path) + insertion. Errors are logged,
   never silently swallowed. */
async function ingestOneRound(text, previous){
  let data = null, callError = null;
  try{
    data = await callGeminiAPI({
      text: buildIngestPrompt(text, previous),
      imageBase64: attachedImage?.base64,
      imageMime: attachedImage?.mime
    });
  }catch(e){
    callError = e;
    console.error('[ingestion] direct call failed:', e);
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  let added = 0;
  const newStems = [];
  for(const it of items){
    if(await insertQuestionFromItem(currentIngestChapterId, it)){
      added++;
      newStems.push(cleanIngestText(it.stem).slice(0,180));
    }
  }
  if(added) await saveQuestions();
  return { added, newStems, callError };
}

/* Two-step pipeline (bulk / non-selective path). Returns {total, hadError}. */
async function runTwoStepIngest(raw){
  updateIngestProgress(0, 'তালিকা তৈরি হচ্ছে');
  let found = [];
  let hadError = false;
  try{
    const data = await callGeminiAPI({
      text: buildListPrompt(raw),
      imageBase64: attachedImage?.base64,
      imageMime: attachedImage?.mime
    });
    found = Array.isArray(data?.found) ? data.found.filter(x=>x && cleanIngestText(x.summary)) : [];
  }catch(e){
    console.error('[ingestion] list step failed:', e);
    hadError = true;
  }
  if(!found.length) return { total: 0, hadError };

  let total = 0;
  let doneCount = 0;
  const savedIdx = new Set();

  async function runElaborateBatch(batch){
    let data = null;
    try{
      data = await callGeminiAPI({
        text: buildElaboratePrompt(raw, batch),
        imageBase64: attachedImage?.base64,
        imageMime: attachedImage?.mime
      });
    }catch(e){
      console.error('[ingestion] elaborate batch failed (idx '+batch.map(b=>b.idx).join(',')+'):', e);
      hadError = true;
      return;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    for(const it of items){
      const ok = await insertQuestionFromItem(currentIngestChapterId, it);
      if(ok){ total++; if(it && it.idx!=null) savedIdx.add(it.idx); }
      else if(it && it.idx!=null){ console.warn('[ingestion] idx', it.idx, 'rejected (failed validation or duplicate):', it); }
    }
    doneCount += batch.length;
    updateIngestProgress(total, `${Math.min(doneCount,found.length)}/${found.length} সম্পন্ন`);
  }

  // Main pass: batches of 10, up to 3 running at once — this is what cuts
  // the wall-clock time down instead of waiting on one batch at a time.
  const batchSize = 10;
  const batches = [];
  for(let i=0; i<found.length; i+=batchSize) batches.push(found.slice(i, i+batchSize));
  await runWithConcurrency(batches.map(b => () => runElaborateBatch(b)), 3);

  // Retry pass: anything Step 1 found but didn't end up saved (model
  // skipped it, or it failed validation) gets a focused, solo attempt —
  // no batch competing for the model's attention — up to 2 rounds. This
  // is what stops items from silently vanishing.
  let retryRound = 0;
  let missing = found.filter(f => !savedIdx.has(f.idx));
  while(missing.length && retryRound < 2){
    retryRound++;
    updateIngestProgress(total, `${found.length-missing.length}/${found.length} সম্পন্ন, ${missing.length}টা আবার চেষ্টা হচ্ছে`);
    await runWithConcurrency(missing.map(item => () => runElaborateBatch([item])), 3);
    missing = found.filter(f => !savedIdx.has(f.idx));
  }

  return { total, hadError };
}

/* ---------------- run ingestion ---------------- */
async function runIngest(){
  const el = document.getElementById('ai-raw-text');
  const raw = el ? el.value.trim() : '';
  if(!raw && !attachedImage) return toast('টেক্সট লেখো, অথবা ছবি দাও');
  const key = await sGet('geminiApiKey');
  if(!key){ toast('প্রথমে Gemini API Key সেট করো'); if(typeof openSettingsModal==='function') openSettingsModal(); return; }
  if(ingestBusy) return;
  ingestBusy = true;
  const btn = document.getElementById('ai-parse-btn');
  if(btn) btn.disabled = true;

  let total = 0, hadError = false;
  const selective = explicitSelection(raw);
  try{
    if(selective){
      const { added, callError } = await ingestOneRound(raw, []);
      total = added;
      hadError = !!callError;
    } else {
      const result = await runTwoStepIngest(raw);
      total = result.total;
      hadError = result.hadError;
    }

    if(total){
      if(el){ el.value=''; autoGrowInput(el); }
      clearAttachment();
      toast(`✓ ${total} টি নতুন প্রশ্ন সংরক্ষিত হয়েছে`);
    } else if(hadError){
      toast('AI service-এ সমস্যা হয়েছে — F12 দিয়ে Console-এ বিস্তারিত দেখা যাবে');
    } else {
      toast('নতুন কোনো বৈধ প্রশ্ন পাওয়া যায়নি');
    }
    const v = document.getElementById('view');
    if(v && location.hash.startsWith('#/templates/')) v.innerHTML = viewQuestionList(currentIngestChapterId);
  } finally {
    ingestBusy = false;
    if(btn) btn.disabled = false;
    hideIngestProgress();
  }
}

/* =====================================================================
   INGEST MODAL — text + image input (file picker AND clipboard paste)
===================================================================== */
function openIngestModal(chapterId){
  currentIngestChapterId = chapterId;
  attachedImage = null;
  ingestSeenSigs = new Set();

  openModal(`
    <h3>প্রশ্ন যোগ করো (AI)</h3>
    <p class="hint" style="margin-bottom:12px;">
      ছবি দাও (আপলোড বাটনে অথবা সরাসরি <b>Ctrl+V</b> দিয়ে paste করো), বা টেক্সট লেখো — যেকোনো ফরম্যাটে, নাম্বারিং ছাড়াই বা এলোমেলো হলেও চলবে।
      নির্দিষ্ট কিছু চাইলে লিখে দাও (যেমন: "শুধু ৩, ৭ নাও") — কিছু না লিখলে ইনপুটে যা আছে সবটাই যোগ হবে।
    </p>
    <div class="unified-input">
      <div id="attach-preview-wrap"></div>
      <div class="input-row">
        <input type="file" id="ingest-file-input" accept="image/*" style="display:none;">
        <button type="button" class="input-icon-btn" id="ingest-attach-btn" title="ছবি সংযুক্ত করো">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-3h6l2 3h3v13H4V7z"/><circle cx="12" cy="13" r="3.5"/></svg>
        </button>
        <textarea id="ai-raw-text" rows="1" placeholder="নির্দেশনা বা প্রশ্ন লেখো (ঐচ্ছিক)... ছবি paste করতে এখানে ক্লিক করে Ctrl+V দাও"></textarea>
        <button type="button" class="input-send-btn" id="ai-parse-btn" title="পাঠাও">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        </button>
      </div>
    </div>
    <div id="ingest-progress" class="hint" style="min-height:16px; margin-bottom:6px;"></div>
    <div class="btn-row" style="margin-top:4px;">
      <button class="btn" onclick="closeModal()">বন্ধ করো</button>
    </div>
  `);

  const ta = document.getElementById('ai-raw-text');
  ta.addEventListener('input', ()=>autoGrowInput(ta));
  ta.addEventListener('paste', handleIngestPaste);
  setTimeout(()=>ta.focus(), 50);

  document.getElementById('ingest-attach-btn').addEventListener('click', ()=>{
    document.getElementById('ingest-file-input').click();
  });
  document.getElementById('ingest-file-input').addEventListener('change', handleIngestFileSelect);
  document.getElementById('ai-parse-btn').addEventListener('click', runIngest);
}
function autoGrowInput(el){
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 260) + 'px';
}
function readImageFile(file){
  const reader = new FileReader();
  reader.onload = ()=>{
    const result = reader.result || '';
    const comma = result.indexOf(',');
    if(comma===-1) return;
    attachedImage = { base64: result.slice(comma+1), mime: file.type || 'image/jpeg' };
    renderAttachPreview();
  };
  reader.readAsDataURL(file);
}
function handleIngestFileSelect(e){
  const file = e.target.files && e.target.files[0];
  if(file) readImageFile(file);
  e.target.value = '';
}
function handleIngestPaste(e){
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for(const item of items){
    if(item.type && item.type.indexOf('image/')===0){
      const file = item.getAsFile();
      if(file){ e.preventDefault(); readImageFile(file); toast('ছবি সংযুক্ত হয়েছে'); }
      return;
    }
  }
}
function renderAttachPreview(){
  const wrap = document.getElementById('attach-preview-wrap');
  if(!wrap) return;
  if(!attachedImage){ wrap.innerHTML=''; return; }
  wrap.innerHTML = `<div class="attach-preview">
    <img src="data:${attachedImage.mime};base64,${attachedImage.base64}" alt="সংযুক্ত ছবি">
    <button type="button" onclick="clearAttachment()">✕</button>
  </div>`;
}
function clearAttachment(){
  attachedImage = null;
  const wrap = document.getElementById('attach-preview-wrap');
  if(wrap) wrap.innerHTML = '';
}
function updateIngestProgress(totalSoFar, label){
  const el = document.getElementById('ingest-progress');
  if(!el) return;
  const base = totalSoFar ? `এখন পর্যন্ত ${totalSoFar}টি প্রশ্ন পাওয়া গেছে` : 'পড়া হচ্ছে';
  el.textContent = label ? `${base} (${label})...` : `${base}...`;
}
function hideIngestProgress(){
  const el = document.getElementById('ingest-progress');
  if(el) el.textContent = '';
}

/* =====================================================================
   QUESTION EDIT MODAL
===================================================================== */
function openQuestionEditForm(chapterId, questionId){
  const q = DB.questions.find(x=>x.id===questionId);
  if(!q) return;

  if(q.type==='numeric'){
    openModal(`
      <h3>প্রশ্ন সম্পাদনা (সাংখ্যিক)</h3>
      <div class="field"><label>Stem — চলক থাকলে {a} আকারে লেখো</label><textarea id="edit-stem">${esc(q.stem)}</textarea></div>
      <div class="field">
        <label>Variables — এক লাইনে একটি, ফরম্যাট: name,min,max</label>
        <textarea id="edit-vars">${q.variables.map(v=>`${v.name},${v.min},${v.max}`).join('\n')}</textarea>
        <div class="hint">যেমন: a,5,25</div>
      </div>
      <div class="field">
        <label>Option expressions — ঠিক ৪টি, এক লাইনে একটি</label>
        <textarea id="edit-optexprs">${(q.optionExprs||[]).join('\n')}</textarea>
      </div>
      <div class="field"><label>সঠিক Option নম্বর (0 থেকে 3)</label><input id="edit-correct" type="number" min="0" max="3" value="${q.correctIndex}"></div>
      <div class="field"><label>ব্যাখ্যা</label><textarea id="edit-explain">${esc(q.explanation||'')}</textarea></div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="saveQuestionEdit('${chapterId}','${questionId}')">সংরক্ষণ করুন</button>
        <button class="btn" onclick="closeModal()">বাতিল</button>
      </div>
    `);
  } else {
    openModal(`
      <h3>প্রশ্ন সম্পাদনা</h3>
      <div class="field"><label>প্রশ্ন</label><textarea id="edit-stem">${esc(q.stem)}</textarea></div>
      ${q.options.map((o,i)=>`
        <div class="opt-row">
          <input type="radio" name="edit-correct-radio" value="${i}" ${q.correctIndex===i?'checked':''}>
          <input type="text" class="edit-opt" value="${esc(o)}">
        </div>`).join('')}
      <div class="hint" style="margin:-2px 0 12px;">রেডিও বাটন দিয়ে সঠিক উত্তর বেছে দাও</div>
      <div class="field"><label>ব্যাখ্যা</label><textarea id="edit-explain">${esc(q.explanation||'')}</textarea></div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="saveQuestionEdit('${chapterId}','${questionId}')">সংরক্ষণ করুন</button>
        <button class="btn" onclick="closeModal()">বাতিল</button>
      </div>
    `);
  }
}
async function saveQuestionEdit(chapterId, questionId){
  const q = DB.questions.find(x=>x.id===questionId);
  if(!q) return;
  const stem = document.getElementById('edit-stem').value.trim();
  if(!stem) return toast('প্রশ্ন খালি রাখা যাবে না');

  if(q.type==='numeric'){
    const varsRaw = document.getElementById('edit-vars').value.trim().split('\n').map(l=>l.trim()).filter(Boolean);
    const vars = varsRaw.map(l=>{
      const [name,min,max] = l.split(',').map(s=>(s||'').trim());
      return {name, min:Number(min), max:Number(max)};
    });
    if(!vars.length || vars.some(v=>!/^[A-Za-z]\w*$/.test(v.name)||!Number.isFinite(v.min)||!Number.isFinite(v.max)||v.min>v.max||v.max-v.min<3)){
      return toast('Variables সঠিক নয় — name,min,max ফরম্যাটে দাও, range অন্তত ৩ হতে হবে');
    }
    const exprs = document.getElementById('edit-optexprs').value.trim().split('\n').map(s=>s.trim()).filter(Boolean);
    if(exprs.length!==4) return toast('ঠিক ৪টি option expression দিতে হবে');
    const ci = parseInt(document.getElementById('edit-correct').value,10);
    if(!Number.isInteger(ci)||ci<0||ci>3) return toast('সঠিক Option নম্বর 0 থেকে 3 এর মধ্যে দাও');
    q.stem = cleanIngestText(stem); q.variables = vars; q.optionExprs = exprs; q.correctIndex = ci;
    q.explanation = cleanIngestText(document.getElementById('edit-explain').value);
  } else {
    const opts = [...document.querySelectorAll('.edit-opt')].map(el=>el.value.trim());
    if(!fourDistinct(opts)) return toast('ঠিক ৪টি ভিন্ন option দাও, কোনোটি খালি রাখা যাবে না');
    const radio = document.querySelector('input[name="edit-correct-radio"]:checked');
    if(!radio) return toast('সঠিক উত্তর নির্বাচন করো');
    q.stem = cleanIngestText(stem); q.options = opts.map(cleanIngestText); q.correctIndex = parseInt(radio.value,10);
    q.explanation = cleanIngestText(document.getElementById('edit-explain').value);
  }

  await saveQuestions();
  closeModal();
  const v = document.getElementById('view');
  if(v) v.innerHTML = viewQuestionList(chapterId);
  toast('✓ সংরক্ষিত হয়েছে');
}
