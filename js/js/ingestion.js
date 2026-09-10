/* =====================================================================
   ingestion.js — THE "ADDING QUESTIONS" MODULE

   Everything about turning raw text/voice/images into saved question
   patterns lives here. If you only need to change how ingestion works
   (the prompt, the pagination logic, dedup rules, the input box UI, the
   manual add/edit forms), you only need to replace THIS file.

   Depends on (from core.js): sGet, DB, saveQuestions, toast, esc, openModal,
     closeModal, onModalClose, normalizeSig
   Depends on (from gemini-model.js): callGeminiAPI, openSettingsModal
   Exposes to the rest of the app: openIngestModal(chapterId),
     openQuestionEditForm(chapterId, questionId), insertQuestionFromItem
===================================================================== */

let currentIngestChapterId = null;
let quickAddCount = 0;
let attachedImage = null;
let ingestSeenSigs = new Set();
let ingestBusy = false;

// Guard against losing an in-flight round if the user closes/reloads mid-ingestion.
// (Rounds that already completed are saved immediately and are never at risk.)
window.addEventListener('beforeunload', (e)=>{
  if(ingestBusy){ e.preventDefault(); e.returnValue = ''; }
});

function buildIngestPrompt(rawText, hasImage, previousStems, continueFrom){
  const continuationBlock = (previousStems && previousStems.length)
    ? `\n\nতুমি এই সেশনে ইতিমধ্যে নিচের প্রশ্নগুলো বের করে ফেলেছ — এগুলো আর দিও না, পুনরাবৃত্তি করবে না:\n${previousStems.map((s,i)=>(i+1)+'. '+s).join('\n')}\n${continueFrom?`এরপর "${continueFrom}" থেকে ধারাবাহিকভাবে বাকিগুলো বের করা চালিয়ে যাও।`:'বাকি প্রশ্নগুলো বের করা চালিয়ে যাও।'}`
    : '';
  return `তুমি একজন বাংলাদেশের ভর্তি পরীক্ষা প্রস্তুতির অভিজ্ঞ শিক্ষক ও প্রশ্ন-বিশ্লেষক AI। ব্যবহারকারী নিচে টেক্সট এবং/অথবা একটা ছবি দেবে — একটামাত্র প্রশ্ন, শত শত লাইনের তালিকা, ভয়েস থেকে লেখা কাঁচা টেক্সট, বা বইয়ের/নোটের পাতার ছবি হতে পারে।

গুরুত্বপূর্ণ অগ্রাধিকার নিয়ম: ব্যবহারকারীর টেক্সটে যদি কোনো স্পষ্ট নির্দেশনা/কমান্ড থাকে (যেমন "শুধু ১, ৩ ও ৪ নম্বর প্রশ্ন নাও", "এই অংশ থেকে ২০টা বানাও", "শুধু দাগানো প্রশ্নগুলো নাও"), সেটাই তোমার নিজের অনুমানের চেয়ে সবসময় বেশি গুরুত্ব পাবে — ঠিক ততটুকুই করবে, তার বেশি বা কম নয়। কাজ শেষ করার আগে নিজে একবার মিলিয়ে দেখো তুমি ঠিক ব্যবহারকারীর বলা প্রশ্নগুলোই দিয়েছ কিনা। কোনো স্পষ্ট নির্দেশনা না থাকলে, প্রতিটা লাইন/অংশ/ছবির প্রতিটা কোণা মনোযোগ দিয়ে স্ক্যান করে যত প্রকৃত/গুরুত্বপূর্ণ প্রশ্ন পাওয়া যায় সবগুলোর জন্য আইটেম বানাও (কাঁচা নোট হলে নিজে থেকে ভালো মানের MCQ তৈরি করো)। ইনপুটে যদি একই প্রশ্ন একাধিকবার (হুবহু বা প্রায় হুবহু) থাকে, সেটাকে একবারই ধরবে।

মানের জন্য অত্যন্ত গুরুত্বপূর্ণ: একবারে সর্বোচ্চ ১০টি প্রশ্ন বিস্তারিতভাবে বের করো, যাতে প্রতিটির বিশ্লেষণ নিখুঁত হয়। আরও বাকি থাকলে "hasMore": true দাও এবং "continueFrom"-এ পরের ধাপে কোথা থেকে চালিয়ে যেতে হবে তার সংক্ষিপ্ত ইঙ্গিত দাও।

প্রতিটা প্রশ্নের জন্য প্রথমে ঠিক করো:
(ক) "numeric" — সাংখ্যিক/গাণিতিক সমস্যা, সংখ্যা বদলালে কাঠামো ঠিক রেখে নতুন প্রশ্ন হয়।
(খ) "concept" — ধারণাভিত্তিক/তাত্ত্বিক/সাহিত্য/জীববিজ্ঞান/ইতিহাস/গ্রামার ইত্যাদি।

"numeric" হলে:
{"type":"numeric","stem":"বিবৃতি, $...$ দিয়ে গণিত, পরিবর্তনযোগ্য সংখ্যার জায়গায় {a},{b}..","variables":[{"name":"a","min":X,"max":Y}],"optionExprs":["সঠিক উত্তরের সূত্র","ভুল ১","ভুল ২","ভুল ৩"],"correctIndex":0,"explanation":"ধাপে ধাপে সম্পূর্ণ নির্ভুল ব্যাখ্যা"}
সাংখ্যিক প্রশ্নে বাড়তি সতর্কতা: min ও max দুই প্রান্তেই বসিয়ে মনে মনে যাচাই করো — শূন্য দিয়ে ভাগ, ঋণাত্মক বর্গমূল, ভগ্নাংশ ফলাফল (পূর্ণসংখ্যা দরকার হলে), বা অবাস্তব মান যেন কোনো প্রান্তেই না আসে। যেমন {a}-{b} ব্যবহার করলে নিশ্চিত করো b সবসময় a-এর চেয়ে ছোট থাকে — দরকার হলে {a}+{b} আকারে সবসময়-ধনাত্মক সূত্র ব্যবহার করা সহজ। সংখ্যাগুলো ভর্তি পরীক্ষার মতোই হাতে-কলমে সহজে সমাধানযোগ্য রাখবে।

"concept" হলে:
{"type":"concept","stem":"সম্পূর্ণ বিবৃতি","options":["...","...","...","..."],"correctIndex":0,"explanation":"ধাপে ধাপে সম্পূর্ণ নির্ভুল ব্যাখ্যা"}

প্রশ্ন কোনো চিত্র/figure-নির্ভর হলে প্রয়োজনীয় মান/সম্পর্ক লেখাতেই বর্ণনা করে দাও যাতে ছবি ছাড়াও সমাধানযোগ্য থাকে। ব্যাখ্যা সবসময় সর্বোচ্চ নির্ভুল ও ধাপে ধাপে হতে হবে।

ঠিক এই আকারে আউটপুট দাও (অন্য কিছু লিখবে না, মার্কডাউন কোড ব্লকও না):
{ "items":[ ...উপরের যেকোনো একটা স্কিমা অনুযায়ী আইটেম... ], "hasMore":true/false, "continueFrom":"..." }

মূল ভাষা (বাংলা/ইংরেজি) বজায় রাখো। শুধু বৈধ JSON দাও।${continuationBlock}

ব্যবহারকারীর টেক্সট/নির্দেশনা:
${rawText || '(সংযুক্ত ছবি বিশ্লেষণ/স্ক্যান করো)'}`;
}

function openIngestModal(chapterId){
  currentIngestChapterId = chapterId;
  ingestSeenSigs = new Set(DB.questions.filter(q=>q.chapterId===chapterId).map(q=>normalizeSig(q.stem)).filter(Boolean));

  // Whatever path the modal closes through (✕ backdrop click, Escape, or the button below),
  // always refresh the chapter's question list underneath so newly-added items are visible.
  onModalClose(()=>{
    if(location.hash.startsWith('#/templates/')){
      const view = document.getElementById('view');
      if(view) view.innerHTML = viewQuestionList(chapterId);
    }
  });

  openModal(`
    <h3>নতুন প্রশ্ন যোগ করো (AI)</h3>
    <p class="hint" style="margin-bottom:10px;">একটা প্রশ্ন লেখো, একসাথে অনেক প্রশ্ন পেস্ট করো, কাঁচা নোট দাও, ছবি তুলে/পেস্ট করে দাও — সাথে চাইলে নির্দেশনাও লেখো (যেমন "শুধু ১,৩,৪ নম্বর নাও")।</p>
    <div class="unified-input">
      <div id="attach-preview" class="attach-preview" style="display:none;">
        <img id="attach-thumb" src="">
        <span class="hint" style="flex:1;">ছবি সংযুক্ত হয়েছে</span>
        <button type="button" onclick="clearAttachment()">✕</button>
      </div>
      <div class="input-row">
        <button type="button" class="input-icon-btn" id="mic-btn" onclick="toggleVoiceInput()" title="বলে টাইপ করো">🎤</button>
        <textarea id="ai-raw-text" rows="4" placeholder="এখানে লেখো/পেস্ট করো, বা ছবি পেস্ট করো (Ctrl+V)..." oninput="autoGrowInput(this)"></textarea>
        <button type="button" class="input-icon-btn" onclick="document.getElementById('ai-image-input').click()" title="ছবি সংযুক্ত করো">📷</button>
        <button type="button" class="input-send-btn" id="ai-parse-btn" onclick="runIngest()" title="AI দিয়ে যোগ করো (Enter)">⚡</button>
      </div>
    </div>
    <input type="file" id="ai-image-input" accept="image/*" capture="environment" style="display:none;" onchange="previewAttachment(this)">
    <div class="hint" style="text-align:center; margin-top:6px;">এই সেশনে যোগ হয়েছে: <b id="quick-add-count">0</b> টি প্রশ্ন · <span class="kbd-hint">Enter</span> পাঠাতে, <span class="kbd-hint">Shift+Enter</span> নতুন লাইনের জন্য</div>
    <details style="margin-top:16px;">
      <summary class="link-btn" style="cursor:pointer;">নিজে হাতে প্রশ্ন লিখতে চাইলে এখানে ক্লিক করো</summary>
      <div style="margin-top:12px;">
        <div class="field"><label>প্রশ্নের বিবৃতি</label><textarea id="q-stem-manual" placeholder="প্রশ্ন লেখো, গণিতের জন্য $...$ ব্যবহার করো"></textarea></div>
        <div class="field"><label>অপশন — সঠিক উত্তরে বাটন চাপুন</label>
          <div id="q-opt-rows">${[0,1,2,3].map(i=>manualOptRow('',i,i===0)).join('')}</div>
        </div>
        <div class="field"><label>ব্যাখ্যা (ঐচ্ছিক)</label><textarea id="q-expl-manual"></textarea></div>
        <button class="btn btn-primary btn-block" onclick="saveManualQuestion('${chapterId}','')">এটা ম্যানুয়ালি সংরক্ষণ করো</button>
      </div>
    </details>
    <button class="btn btn-block" style="margin-top:14px;" onclick="closeModal()">শেষ, বন্ধ করো</button>
  `);
  quickAddCount = 0; attachedImage = null;
  const ta = document.getElementById('ai-raw-text');
  if(ta){
    ta.addEventListener('paste', handlePasteForImage);
    setTimeout(()=>ta.focus(),50);
  }
}

/* ---- clipboard image paste support ---- */
function handlePasteForImage(e){
  const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
  if(!items) return;
  for(const item of items){
    if(item.type && item.type.startsWith('image/')){
      const file = item.getAsFile();
      if(file){
        e.preventDefault();
        fileToBase64(file).then(b64=>{
          attachedImage = { base64: b64, mime: file.type };
          const thumb = document.getElementById('attach-thumb');
          const preview = document.getElementById('attach-preview');
          if(thumb) thumb.src = 'data:'+file.type+';base64,'+b64;
          if(preview) preview.style.display = 'flex';
          toast('📷 ছবি পেস্ট হয়েছে');
        });
      }
      break;
    }
  }
}

function manualOptRow(val, i, checked){
  return `<div class="opt-row">
    <input type="radio" name="q-correct-opt" value="${i}" ${checked?'checked':''}>
    <input type="text" class="q-opt-manual" value="${esc(val)}" placeholder="অপশন ${i+1}">
  </div>`;
}
async function saveManualQuestion(chapterId, questionId){
  const stem = document.getElementById('q-stem-manual').value.trim();
  if(!stem) return toast('প্রশ্ন লিখুন');
  const opts = [...document.querySelectorAll('.q-opt-manual')].map(x=>x.value.trim());
  if(opts.some(o=>!o)) return toast('সব অপশন পূরণ করুন');
  const checked = document.querySelector('input[name=q-correct-opt]:checked');
  const correctIndex = checked ? parseInt(checked.value) : 0;
  const explanation = document.getElementById('q-expl-manual').value.trim();
  if(questionId){
    const q = DB.questions.find(x=>x.id===questionId);
    Object.assign(q, {stem, options:opts, correctIndex, explanation});
  } else {
    DB.questions.push({id:uid(), chapterId, type:'concept', stem, options:opts, correctIndex, explanation});
  }
  await saveQuestions(); closeModal(); toast('সংরক্ষিত হয়েছে');
  const view = document.getElementById('view');
  if(view) view.innerHTML = viewQuestionList(chapterId);
}
function openQuestionEditForm(chapterId, questionId){
  const q = DB.questions.find(x=>x.id===questionId);
  if(!q) return;
  if(q.type==='numeric') openNumericEditForm(chapterId, q);
  else openConceptEditForm(chapterId, q);
}
function openConceptEditForm(chapterId, q){
  openModal(`
    <h3>প্রশ্ন সম্পাদনা</h3>
    <div class="field"><label>প্রশ্নের বিবৃতি</label><textarea id="q-stem-manual">${esc(q.stem)}</textarea></div>
    <div class="field"><label>অপশন — সঠিক উত্তরে বাটন চাপুন</label><div id="q-opt-rows">${q.options.map((o,i)=>manualOptRow(o,i,i===q.correctIndex)).join('')}</div></div>
    <div class="field"><label>ব্যাখ্যা (ঐচ্ছিক)</label><textarea id="q-expl-manual">${esc(q.explanation||'')}</textarea></div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="saveManualQuestion('${chapterId}','${q.id}')">সংরক্ষণ করুন</button>
      <button class="btn" onclick="closeModal()">বাতিল</button>
    </div>`);
}
function varRow(v){
  return `<div class="field-row" style="margin-bottom:8px;">
    <div class="field" style="flex:.6;"><input class="var-name" value="${esc(v.name)}" placeholder="নাম যেমন a"></div>
    <div class="field"><input class="var-min" type="number" value="${v.min}" placeholder="min"></div>
    <div class="field"><input class="var-max" type="number" value="${v.max}" placeholder="max"></div>
  </div>`;
}
function addVarRow(){ document.getElementById('var-rows').insertAdjacentHTML('beforeend', varRow({name:'',min:1,max:9})); }
function optRow(val, i, checked){
  return `<div class="opt-row"><input type="radio" name="correct-opt" value="${i}" ${checked?'checked':''}><input type="text" class="opt-expr" value="${esc(val)}" placeholder="সূত্র, যেমন {a}+{b}"></div>`;
}
function openNumericEditForm(chapterId, q){
  const vars = q.variables||[]; const opts = q.optionExprs||[]; const correctIndex = q.correctIndex||0;
  openModal(`
    <h3>প্রশ্ন সম্পাদনা (সাংখ্যিক)</h3>
    <div class="field"><label>প্রশ্নের বিবৃতি ({a},{b} ও $...$ ব্যবহার করুন)</label><textarea id="tpl-stem">${esc(q.stem)}</textarea></div>
    <div class="field"><label>ভেরিয়েবলের সীমা</label>
      <div id="var-rows">${vars.map(v=>varRow(v)).join('')}</div>
      <button class="link-btn" type="button" onclick="addVarRow()">+ ভেরিয়েবল যোগ</button>
    </div>
    <div class="field"><label>অপশন (সূত্র আকারে) — সঠিক উত্তরে বাটন চাপুন</label>
      <div id="opt-rows">${opts.map((o,i)=>optRow(o,i,i===correctIndex)).join('')}</div>
    </div>
    <div class="field"><label>ব্যাখ্যা (ঐচ্ছিক)</label><textarea id="tpl-expl">${esc(q.explanation||'')}</textarea></div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="saveNumericEdit('${chapterId}','${q.id}')">সংরক্ষণ করুন</button>
      <button class="btn" onclick="closeModal()">বাতিল</button>
    </div>`);
}
async function saveNumericEdit(chapterId, questionId){
  const stem = document.getElementById('tpl-stem').value.trim();
  if(!stem) return toast('প্রশ্ন লিখুন');
  const names=[...document.querySelectorAll('.var-name')].map(x=>x.value.trim());
  const mins=[...document.querySelectorAll('.var-min')].map(x=>parseFloat(x.value));
  const maxs=[...document.querySelectorAll('.var-max')].map(x=>parseFloat(x.value));
  const variables = names.map((nm,i)=>({name:nm,min:mins[i],max:maxs[i]})).filter(v=>v.name);
  const exprs=[...document.querySelectorAll('.opt-expr')].map(x=>x.value.trim());
  const correctRadio=document.querySelector('input[name=correct-opt]:checked');
  const correctIndex=correctRadio?parseInt(correctRadio.value):0;
  const explanation=document.getElementById('tpl-expl').value.trim();
  if(exprs.some(e=>!e)) return toast('সব অপশন পূরণ করুন');
  const q=DB.questions.find(x=>x.id===questionId);
  Object.assign(q,{stem, variables, optionExprs:exprs, correctIndex, explanation});
  await saveQuestions(); closeModal(); toast('সংরক্ষিত হয়েছে');
  const view = document.getElementById('view');
  if(view) view.innerHTML = viewQuestionList(chapterId);
}
function insertQuestionFromItem(chapterId, item){
  if(!item || !item.type) return false;
  if(item.type==='numeric'){
    if(!item.stem || !Array.isArray(item.optionExprs) || item.optionExprs.length<2) return false;
    DB.questions.push({
      id:uid(), chapterId, type:'numeric', stem:item.stem,
      variables: Array.isArray(item.variables)?item.variables:[],
      optionExprs:item.optionExprs,
      correctIndex: Number.isInteger(item.correctIndex)?item.correctIndex:0,
      explanation:item.explanation||''
    });
    return true;
  }
  if(item.type==='concept'){
    if(!item.stem || !Array.isArray(item.options) || item.options.length<2) return false;
    let ci = Number.isInteger(item.correctIndex)?item.correctIndex:0;
    if(ci<0||ci>=item.options.length) ci=0;
    DB.questions.push({ id:uid(), chapterId, type:'concept', stem:item.stem, options:item.options, correctIndex:ci, explanation:item.explanation||'' });
    return true;
  }
  return false;
}
async function runIngest(){
  const rawTextEl = document.getElementById('ai-raw-text');
  const rawText = rawTextEl ? rawTextEl.value.trim() : '';
  if(!rawText && !attachedImage){ toast('টেক্সট লেখো, বলো, অথবা ছবি দাও'); return; }
  const apiKey = await sGet('geminiApiKey');
  if(!apiKey){ toast('প্রথমে Gemini API Key সেট করো'); openSettingsModal(); return; }

  const btn = document.getElementById('ai-parse-btn');
  btn.disabled = true; const prevLabel = btn.textContent;
  ingestBusy = true;

  let totalAdded = 0, round = 0, continueFrom = '';
  const previousStems = [];
  const MAX_ROUNDS = 15;
  try{
    while(round < MAX_ROUNDS){
      round++;
      btn.textContent = round===1 ? '⏳' : ('⏳'+round);
      const prompt = buildIngestPrompt(rawText, !!attachedImage, previousStems, continueFrom);
      const data = await callGeminiAPI({
        text: prompt,
        imageBase64: attachedImage ? attachedImage.base64 : undefined,
        imageMime: attachedImage ? attachedImage.mime : undefined
      });
      const items = Array.isArray(data.items) ? data.items : [];
      let addedThisRound = 0;
      items.forEach(it=>{
        const sig = normalizeSig(it.stem);
        if(sig && ingestSeenSigs.has(sig)) return; // duplicate — skip silently
        if(insertQuestionFromItem(currentIngestChapterId, it)){
          addedThisRound++;
          if(sig) ingestSeenSigs.add(sig);
          previousStems.push((it.stem||'').slice(0,90));
        }
      });
      if(addedThisRound>0){
        await saveQuestions(); // persisted immediately — closing the modal is never required for this to stick
        totalAdded += addedThisRound;
        quickAddCount += addedThisRound;
        const c1 = document.getElementById('quick-add-count'); if(c1) c1.textContent = quickAddCount;
      }
      continueFrom = data.continueFrom || '';
      // We do NOT trust the model's own "hasMore" flag to stop early — keep going until a round
      // genuinely yields nothing new (real end of content, or model is just repeating itself).
      if(addedThisRound===0) break;
    }
    if(totalAdded===0) toast('AI কোনো নতুন প্রশ্ন শনাক্ত করতে পারেনি, আরেকটু স্পষ্ট করে দাও');
    else {
      rawTextEl.value=''; autoGrowInput(rawTextEl); clearAttachment();
      toast(`✅ মোট ${totalAdded} টি প্রশ্ন যোগ হয়েছে`);
      rawTextEl.focus();
    }
  }catch(e){
    if(e.message==='NO_API_KEY'){ toast('প্রথমে API Key সেট করো'); openSettingsModal(); }
    else if(totalAdded>0) toast(`⚠ আংশিক সম্পন্ন — ${totalAdded} টি প্রশ্ন যোগ হয়েছে (এগুলো সেভ হয়ে গেছে), তারপর সমস্যা: ${e.message}`);
    else toast('সমস্যা হয়েছে: ' + e.message);
  }finally{
    btn.disabled = false; btn.textContent = prevLabel;
    ingestBusy = false;
  }
}

/* ---- unified input helpers ---- */
function autoGrowInput(el){ el.style.height='auto'; el.style.height = Math.min(el.scrollHeight, 260) + 'px'; }
function previewAttachment(input){
  const file = input.files[0]; if(!file) return;
  fileToBase64(file).then(b64=>{
    attachedImage = { base64: b64, mime: file.type };
    document.getElementById('attach-thumb').src = 'data:'+file.type+';base64,'+b64;
    document.getElementById('attach-preview').style.display = 'flex';
  });
}
function clearAttachment(){
  attachedImage = null;
  const input = document.getElementById('ai-image-input'); if(input) input.value = '';
  const preview = document.getElementById('attach-preview'); if(preview) preview.style.display = 'none';
}
function fileToBase64(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
let recognition;
function toggleVoiceInput(){
  const btn = document.getElementById('mic-btn');
  const ta = document.getElementById('ai-raw-text');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR){ toast('এই ব্রাউজারে ভয়েস ইনপুট নেই — Chrome ব্যবহার করো'); return; }
  if(recognition && recognition._active){ recognition.stop(); return; }
  recognition = new SR();
  recognition.lang = 'bn-BD'; recognition.interimResults = false; recognition.maxAlternatives = 1;
  recognition._active = true;
  btn.classList.add('recording'); btn.textContent = '🔴';
  recognition.onresult = (e)=>{ const t = e.results[0][0].transcript; ta.value = (ta.value?ta.value+' ':'')+t; autoGrowInput(ta); };
  recognition.onerror = ()=>{ toast('ভয়েস বোঝা যায়নি, আবার চেষ্টা করো'); };
  recognition.onend = ()=>{ recognition._active = false; btn.classList.remove('recording'); btn.textContent = '🎤'; };
  recognition.start();
}
