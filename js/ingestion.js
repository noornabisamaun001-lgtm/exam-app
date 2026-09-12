/* ingestion.js — Mastery Exam patched ingestion/save logic
   Keep your existing UI/modal/edit HTML. Replace the old ingestion logic with this.
   Dependencies: core.js, gemini-model.js
*/
let currentIngestChapterId=null, quickAddCount=0, attachedImage=null, ingestBusy=false;
let ingestSeenSigs=new Set();

function cleanIngestText(s=''){return String(s).replace(/\s+/g,' ').trim()}
function canonIngest(s=''){return cleanIngestText(s).toLowerCase().replace(/[“”"‘’'`]/g,'').replace(/[।,;:!?()[\]{}<>\/\\|+=_*^~$%#@-]/g,'').replace(/\s/g,'')}
function ingestItemSig(q){
  const opts=(q.options||q.optionExprs||[]).map(canonIngest).join('|');
  return canonIngest(q.stem||'')+'||'+opts+'||'+String(q.correctIndex??'');
}
function ingestSimilarity(a,b){
  a=canonIngest(a);b=canonIngest(b);if(!a||!b)return 0;if(a===b)return 1;
  const A=new Set(a.match(/[a-z\u0980-\u09ff0-9]+/g)||[]),B=new Set(b.match(/[a-z\u0980-\u09ff0-9]+/g)||[]);
  let n=0;A.forEach(x=>B.has(x)&&n++);return n/Math.max(1,new Set([...A,...B]).size);
}
function ingestNearDuplicate(stem,list){
  const s=canonIngest(stem);if(!s)return true;
  return list.some(q=>canonIngest(q.stem)===s||ingestSimilarity(q.stem,stem)>=.94);
}
function fourDistinct(a){return Array.isArray(a)&&a.length===4&&a.every(x=>cleanIngestText(x))&&new Set(a.map(canonIngest)).size===4}
function explicitSelection(s=''){
  return /শুধু|কেবল|only|just|দাগানো|চিহ্নিত|মার্ক|marked|selected|highlighted/i.test(s) ||
    /(?:নম্বর|no\.?|question)\s*[০-৯0-9]+(?:\s*[,ও&]\s*[০-৯0-9]+)+/i.test(s);
}
function buildIngestPrompt(raw='',hasImage=false,previous=[]){
  const prev=previous.length?`\nইতিমধ্যে নেওয়া stem — এগুলো পুনরায় দেবে না:\n${previous.map((x,i)=>`${i+1}. ${x}`).join('\n')}`:'';
  return `তুমি বাংলাদেশের ভর্তি পরীক্ষার জন্য একটি STRICT question-bank extraction AI।

ইনপুট TEXT এবং/অথবা IMAGE থেকে শুধু ব্যবহারকারী যে প্রশ্ন/তথ্য নির্বাচন করেছে সেগুলোকে MCQ pattern-এ সংরক্ষণযোগ্য item বানাও।

কঠোর নিয়ম:
- "শুধু/কেবল/marked/selected/দাগানো/চিহ্নিত/নির্দিষ্ট নম্বর" থাকলে তার বাইরে একটিও item বানাবে না।
- ছবিতে দাগানো/circled/highlighted প্রশ্ন থাকলে শুধু সেগুলো নাও; একই পাতার অন্য প্রশ্ন নিও না।
- raw textbook line/note হলে শুধু ওই selected line/fact থেকে প্রয়োজনীয় MCQ বানাও। একটি ছোট অংশকে কেন্দ্র করে 20/40টি নতুন topic question বানাবে না।
- নতুন chapter, নতুন fact, অনুমান বা শেখানোর জন্য extra question যোগ করবে না।
- মূল concept, required knowledge, solving method ও answer logic অপরিবর্তিত রাখবে।
- বাংলা/ইংরেজি মূল ভাষা বজায় রাখবে।
- Math equation $...$ এর মধ্যে রাখবে; formula/text ভাঙবে না।
- Figure দরকার হলে শুধু ছবিতে থাকা নির্দিষ্ট relation/value ব্যবহার করবে; কল্পিত data নয়।
- concept item-এ ঠিক 4টি distinct option এবং exactly one correct।
- numeric item-এ 4টি distinct option, valid variable ranges এবং সব expression valid হতে হবে।
- fixed factual answer-কে fake variation বানাবে না।
- শুধু বৈধ JSON output দাও।

${explicitSelection(raw)?'এটি EXPLICIT selection: অতিরিক্ত item সম্পূর্ণ নিষিদ্ধ।':'Bulk input: source-এ যত প্রকৃত selected question/fact আছে ততটাই নাও; topic expansion কোরো না।'}
${prev}

JSON:
{"items":[{"type":"concept","stem":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"..."},{"type":"numeric","stem":"... {a} ...","variables":[{"name":"a","min":5,"max":25}],"optionExprs":["...","...","...","..."],"correctIndex":0,"explanation":"... {a} ..."}],"hasMore":false,"continueFrom":""}

USER INPUT:
${raw||'(IMAGE ONLY — inspect the image carefully)'}
`;
}
function normalizeIngestItem(it){
  if(!it||!it.type||!cleanIngestText(it.stem))return null;
  if(it.type==='numeric'){
    const q={id:uid(),chapterId:currentIngestChapterId,type:'numeric',stem:cleanIngestText(it.stem),
      variables:Array.isArray(it.variables)?it.variables.map(v=>({name:String(v.name||''),min:Number(v.min),max:Number(v.max)})):[],
      optionExprs:Array.isArray(it.optionExprs)?it.optionExprs.map(String):[],
      correctIndex:Number(it.correctIndex),explanation:cleanIngestText(it.explanation||'')};
    if(q.optionExprs.length!==4||!Number.isInteger(q.correctIndex)||q.correctIndex<0||q.correctIndex>3)return null;
    if(!q.variables.length||q.variables.some(v=>!/^[A-Za-z]\w*$/.test(v.name)||!Number.isFinite(v.min)||!Number.isFinite(v.max)||v.min>v.max||v.max-v.min<3))return null;
    return q;
  }
  if(it.type==='concept'&&fourDistinct(it.options)){
    const q={id:uid(),chapterId:currentIngestChapterId,type:'concept',stem:cleanIngestText(it.stem),
      options:it.options.map(cleanIngestText),correctIndex:Number(it.correctIndex),explanation:cleanIngestText(it.explanation||'')};
    return Number.isInteger(q.correctIndex)&&q.correctIndex>=0&&q.correctIndex<4?q:null;
  }
  return null;
}
async function insertQuestionFromItem(chapterId,item){
  const q=normalizeIngestItem({...item,chapterId});if(!q)return false;
  const existing=DB.questions.filter(x=>x.chapterId===chapterId);
  if(ingestNearDuplicate(q.stem,existing)||ingestSeenSigs.has(ingestItemSig(q)))return false;
  DB.questions.push(q);ingestSeenSigs.add(ingestItemSig(q));return true;
}
async function dedupeChapterQuestions(chapterId){
  const list=DB.questions.filter(q=>q.chapterId===chapterId),keep=[],seen=new Set();let removed=0;
  for(const q of list){const sig=ingestItemSig(q);if(seen.has(sig)||ingestNearDuplicate(q.stem,keep)){removed++;continue}seen.add(sig);keep.push(q)}
  const ids=new Set(keep.map(q=>q.id));DB.questions=DB.questions.filter(q=>q.chapterId!==chapterId||ids.has(q.id));
  await saveQuestions();toast(removed?`ডুপ্লিকেট ${removed}টি মুছে ফেলা হয়েছে`:'কোনো ডুপ্লিকেট পাওয়া যায়নি');
  const v=document.getElementById('view');if(v)v.innerHTML=viewQuestionList(chapterId);
}
async function runIngest(){
  const el=document.getElementById('ai-raw-text'),raw=el?el.value.trim():'';
  if(!raw&&!attachedImage)return toast('টেক্সট লেখো, অথবা ছবি দাও');
  const key=await sGet('geminiApiKey');if(!key){toast('প্রথমে Gemini API Key সেট করো');if(typeof openSettingsModal==='function')openSettingsModal();return}
  if(ingestBusy)return;ingestBusy=true;
  const btn=document.getElementById('ai-parse-btn');if(btn){btn.disabled=true}
  let total=0,round=0,previous=[];const explicit=explicitSelection(raw);
  try{
    while(round++<20){
      let data=null;
      try{data=await callGeminiAPI({text:buildIngestPrompt(raw,!!attachedImage,previous),
        imageBase64:attachedImage?.base64,imageMime:attachedImage?.mime})}catch(e){}
      const items=Array.isArray(data?.items)?data.items.slice(0,10):[];let added=0;
      for(const it of items){if(await insertQuestionFromItem(currentIngestChapterId,it)){added++;total++;previous.push(cleanIngestText(it.stem).slice(0,180))}}
      if(added)await saveQuestions();
      if(explicit||!added||data?.hasMore===false)break;
    }
    if(total){if(el){el.value='';if(typeof autoGrowInput==='function')autoGrowInput(el)}if(typeof clearAttachment==='function')clearAttachment();toast(`✓ ${total} টি নতুন প্রশ্ন সংরক্ষিত হয়েছে`)}
    else toast('নতুন কোনো বৈধ প্রশ্ন পাওয়া যায়নি');
    const v=document.getElementById('view');if(v&&location.hash.startsWith('#/templates/'))v.innerHTML=viewQuestionList(currentIngestChapterId);
  }finally{ingestBusy=false;if(btn){btn.disabled=false}}
}

/* =====================================================================
   INGEST MODAL — was referenced everywhere (viewData, viewQuestionList)
   but never actually built. Uses the .unified-input / #ai-raw-text /
   .attach-preview / .input-icon-btn / .input-send-btn CSS that already
   existed in index.html for exactly this purpose.
===================================================================== */
function openIngestModal(chapterId){
  currentIngestChapterId = chapterId;
  attachedImage = null;
  ingestSeenSigs = new Set(); // scoped fresh per ingest session so an earlier
                              // chapter's sigs never falsely block this one

  openModal(`
    <h3>প্রশ্ন যোগ করো (AI)</h3>
    <p class="hint" style="margin-bottom:12px;">
      প্রশ্নের পাতার ছবি দাও (দাগানো/circled প্রশ্ন থাকলে লিখে দাও কোনগুলো নেবে —
      যেমন: "শুধু ৩, ৭ ও ৯ নম্বর নাও"), অথবা সরাসরি টেক্সট লিখে পাঠাও।
    </p>
    <div class="unified-input">
      <div id="attach-preview-wrap"></div>
      <div class="input-row">
        <input type="file" id="ingest-file-input" accept="image/*" style="display:none;">
        <button type="button" class="input-icon-btn" id="ingest-attach-btn" title="ছবি সংযুক্ত করো">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-3h6l2 3h3v13H4V7z"/><circle cx="12" cy="13" r="3.5"/></svg>
        </button>
        <textarea id="ai-raw-text" rows="1" placeholder="যেমন: শুধু ৩, ৭ ও ৯ নম্বর প্রশ্ন নাও..."></textarea>
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
    const result = reader.result || ''; // data:<mime>;base64,<data>
    const comma = result.indexOf(',');
    if(comma===-1) return;
    attachedImage = { base64: result.slice(comma+1), mime: file.type || 'image/jpeg' };
    renderAttachPreview();
  };
  reader.readAsDataURL(file);
  e.target.value = ''; // allow re-selecting the same file later
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
   QUESTION EDIT MODAL — also referenced from viewQuestionList but never
   defined. Handles both saved question types (concept / numeric).
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
      return toast('Variables সঠিক নয় — name,min,max ফরম্যাটে দাও এবং range অন্তত ৩ হতে হবে');
    }
    const exprs = document.getElementById('edit-optexprs').value.trim().split('\n').map(s=>s.trim()).filter(Boolean);
    if(exprs.length!==4) return toast('ঠিক ৪টি option expression দিতে হবে');
    const ci = parseInt(document.getElementById('edit-correct').value,10);
    if(!Number.isInteger(ci)||ci<0||ci>3) return toast('সঠিক Option নম্বর 0 থেকে 3 এর মধ্যে দাও');
    q.stem = cleanIngestText(stem);
    q.variables = vars;
    q.optionExprs = exprs;
    q.correctIndex = ci;
    q.explanation = cleanIngestText(document.getElementById('edit-explain').value);
  } else {
    const opts = [...document.querySelectorAll('.edit-opt')].map(el=>el.value.trim());
    if(!fourDistinct(opts)) return toast('ঠিক ৪টি ভিন্ন option দাও, কোনোটি খালি রাখা যাবে না');
    const radio = document.querySelector('input[name="edit-correct-radio"]:checked');
    if(!radio) return toast('সঠিক উত্তর নির্বাচন করো');
    q.stem = cleanIngestText(stem);
    q.options = opts.map(cleanIngestText);
    q.correctIndex = parseInt(radio.value,10);
    q.explanation = cleanIngestText(document.getElementById('edit-explain').value);
  }

  await saveQuestions();
  closeModal();
  const v = document.getElementById('view');
  if(v) v.innerHTML = viewQuestionList(chapterId);
  toast('✓ সংরক্ষিত হয়েছে');
}
