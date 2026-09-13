/* ingestion.js — question input / ingestion / save
   Core rule (per product owner): the AI should behave exactly like a
   competent human reading the same input:
     - if the user pointed at specific questions (marked/circled/"only 3,7"),
       take ONLY those.
     - if the user gave NO such restriction, take EVERY valid question/fact
       found in the input — that's the default, not an edge case.
   Everything else (dedup, validation, math/Bengali integrity) exists only
   to keep the saved data sheet clean, since duplicate/broken saved
   questions are what cause duplicate/broken exam questions later.
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
/* A question only counts as a duplicate against questions ALREADY SAVED
   in the SAME chapter — that's the actual "data sheet" the exam draws
   from, so this is what prevents one pattern from silently existing
   twice and doubling up inside generated exams. */
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
  return /শুধু|কেবল|only|just|দাগানো|চিহ্নিত|মার্ক|marked|selected|highlighted|circled/i.test(s) ||
    /(?:নম্বর|no\.?|question)\s*[০-৯0-9]+(?:\s*[,ও&]\s*[০-৯0-9]+)+/i.test(s);
}

/* ---------------- prompt ---------------- */
function buildIngestPrompt(raw='', previous=[]){
  const selective = explicitSelection(raw);
  const prev = previous.length
    ? `\nএই stem গুলো ইতিমধ্যে নেওয়া হয়েছে — এগুলো আবার দিও না:\n${previous.map((x,i)=>`${i+1}. ${x}`).join('\n')}`
    : '';
  return `তুমি একটি নির্ভুল প্রশ্ন-ব্যাংক এক্সট্র্যাকশন ইঞ্জিন। ইনপুটে ছবি এবং/অথবা টেক্সট থাকতে পারে।

সিদ্ধান্তের নিয়ম:
১) ছবিতে মার্ক/সার্কেল/হাইলাইট থাকলে অথবা টেক্সটে নির্দিষ্ট কিছু বেছে দেওয়া থাকলে (যেমন: "শুধু ৩,৭ নাও", "শুধু দাগানোগুলো") — তাহলে কেবল সেই নির্দিষ্ট অংশগুলোই নাও, বাকি সব বাদ দাও।
২) এমন কোনো নির্দিষ্ট নির্দেশনা/মার্কিং না থাকলে — ইনপুটে যত বৈধ প্রশ্ন/তথ্য আছে সবগুলো থেকেই item বানাও। এটাই স্বাভাবিক আচরণ, কিছু বাদ দেওয়ার দরকার নেই।
${selective ? '\n→ এই ইনপুটে স্পষ্ট নির্বাচন-নির্দেশনা আছে, তাই নিয়ম ১ প্রযোজ্য।' : '\n→ এই ইনপুটে কোনো নির্বাচন-নির্দেশনা নেই, তাই নিয়ম ২ প্রযোজ্য — সব নাও।'}

প্রতিটি item তৈরির সময়:
- মূল concept, সমাধান পদ্ধতি ও উত্তরের যুক্তি হুবহু বজায় রাখবে। raw textbook lines হলে শুধু সেই নির্দিষ্ট তথ্য থেকেই MCQ বানাবে — বাইরের জ্ঞান/নতুন topic আনবে না।
- বাংলা/ইংরেজি মূল ভাষা অপরিবর্তিত রাখবে। Math সবসময় $...$ এর ভেতরে লিখবে, ভাঙবে না।
- concept item: ঠিক ৪টি ভিন্ন option এবং exactly ১টি সঠিক উত্তর।
- numeric item: stem-এ {var} placeholder, প্রতিটি variable-এর min/max range, এবং ৪টি বৈধ, গণনাযোগ্য option expression।
- figure/diagram থাকলে ছবিতে থাকা প্রকৃত value/relation-ই ব্যবহার করবে, কল্পিত কিছু না।
- একই ইনপুটের মধ্যে দুইটা item কখনো একে অপরের ডুপ্লিকেট হবে না।
- শুধু নিচের ফরম্যাটে বৈধ JSON রিটার্ন করবে, অন্য কোনো টেক্সট/মার্কডাউন না।
${prev}

JSON ফরম্যাট:
{"items":[{"type":"concept","stem":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"..."},{"type":"numeric","stem":"... {a} ...","variables":[{"name":"a","min":5,"max":25}],"optionExprs":["...","...","...","..."],"correctIndex":0,"explanation":"... {a} ..."}],"hasMore":false}

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

  let total=0, round=0, previous=[];
  const selective = explicitSelection(raw);
  try{
    // A selective request ("শুধু ৩,৭") needs exactly one pass — looping
    // again would risk the model reinterpreting and adding extras.
    // A bulk/whole-input request may need a few passes for a page packed
    // with many questions, bounded so it can never run away.
    const maxRounds = selective ? 1 : 8;
    while(round++ < maxRounds){
      let data = null;
      try{
        data = await callGeminiAPI({
          text: buildIngestPrompt(raw, previous),
          imageBase64: attachedImage?.base64,
          imageMime: attachedImage?.mime
        });
      }catch(e){}
      const items = Array.isArray(data?.items) ? data.items : [];
      let added = 0;
      for(const it of items){
        if(await insertQuestionFromItem(currentIngestChapterId, it)){
          added++; total++;
          previous.push(cleanIngestText(it.stem).slice(0,180));
        }
      }
      if(added) await saveQuestions();
      if(!added || data?.hasMore===false) break;
    }
    if(total){
      if(el){ el.value=''; autoGrowInput(el); }
      clearAttachment();
      toast(`✓ ${total} টি নতুন প্রশ্ন সংরক্ষিত হয়েছে`);
    } else {
      toast('নতুন কোনো বৈধ প্রশ্ন পাওয়া যায়নি');
    }
    const v = document.getElementById('view');
    if(v && location.hash.startsWith('#/templates/')) v.innerHTML = viewQuestionList(currentIngestChapterId);
  } finally {
    ingestBusy = false;
    if(btn) btn.disabled = false;
  }
}

/* =====================================================================
   INGEST MODAL — text + image input, uses the app's existing
   .unified-input / #ai-raw-text / .attach-preview / .input-icon-btn /
   .input-send-btn styling.
===================================================================== */
function openIngestModal(chapterId){
  currentIngestChapterId = chapterId;
  attachedImage = null;
  ingestSeenSigs = new Set(); // fresh per session — one chapter's sigs must never block another's

  openModal(`
    <h3>প্রশ্ন যোগ করো (AI)</h3>
    <p class="hint" style="margin-bottom:12px;">
      ছবি দাও অথবা টেক্সট লেখো। নির্দিষ্ট কিছু চাইলে লিখে দাও (যেমন: "শুধু ৩, ৭ নাও") —
      কিছু না লিখলে ইনপুটে যা আছে সবটাই যোগ হবে।
    </p>
    <div class="unified-input">
      <div id="attach-preview-wrap"></div>
      <div class="input-row">
        <input type="file" id="ingest-file-input" accept="image/*" style="display:none;">
        <button type="button" class="input-icon-btn" id="ingest-attach-btn" title="ছবি সংযুক্ত করো">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-3h6l2 3h3v13H4V7z"/><circle cx="12" cy="13" r="3.5"/></svg>
        </button>
        <textarea id="ai-raw-text" rows="1" placeholder="নির্দেশনা বা প্রশ্ন লেখো (ঐচ্ছিক)..."></textarea>
        <button type="button" class="input-send-btn" id="ai-parse-btn" title="পাঠাও">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        </button>
      </div>
    </div>
    <div class="btn-row" style="margin-top:10px;">
      <button class="btn" onclick="closeModal()">বন্ধ করো</button>
    </div>
  `);

  const ta = document.getElementById('ai-raw-text');
  ta.addEventListener('input', ()=>autoGrowInput(ta));
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
function handleIngestFileSelect(e){
  const file = e.target.files && e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    const result = reader.result || '';
    const comma = result.indexOf(',');
    if(comma===-1) return;
    attachedImage = { base64: result.slice(comma+1), mime: file.type || 'image/jpeg' };
    renderAttachPreview();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
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
