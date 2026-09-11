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
- raw textbook line/note হলে শুধু ওই selected line/fact থেকে প্রয়োজনীয় MCQ বানাও। একটি ছোট অংশকে কেন্দ্র করে 20/40টি নতুন topic question বানাবে না।
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
  const btn=document.getElementById('ai-parse-btn');if(btn){btn.disabled=true;btn.textContent='প্রশ্ন যাচাই হচ্ছে…'}
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
  }finally{ingestBusy=false;if(btn){btn.disabled=false;btn.textContent='AI দিয়ে যোগ করুন'}}
}

