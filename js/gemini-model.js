/* =====================================================================
   gemini-model.js — THE PIECE MOST LIKELY TO NEED FUTURE CHANGES

   This is the ONLY file that talks to the Gemini API network endpoint.
   No model version numbers are hardcoded anywhere below. "auto" mode asks
   Google's own ListModels endpoint which models the user's key can use
   RIGHT NOW, scores them generically, and picks the best one. If that
   model turns out to be retired/overloaded, it silently re-discovers or
   walks to a Google-maintained "evergreen" alias — never a hardcoded
   version string. Pro-class models are actively avoided since free-tier
   keys typically have ZERO quota for them (this was the cause of the
   "quota exceeded ... gemini-3.1-pro" errors).

   Depends on (from core.js): sGet, sSet, sleep, openModal, closeModal, esc, toast
   Exposes to everyone else: callGeminiAPI({text, imageBase64, imageMime})
     -> resolves to the parsed JSON object the model returned.
     Throws Error('NO_API_KEY') if no key is set.
     Throws an auth-style Error only when the key itself is invalid/restricted
     (nothing else can be silently retried past that).
   Also exposes: openSettingsModal, saveSettings, redetectModel, discoverBestModel
===================================================================== */

// The ONLY two model names ever referenced by name in this app. These are
// NOT version-locked — Google itself keeps these pointed at whatever its
// current best models are. "pro-latest" is deliberately excluded: Pro-class
// models generally have no free-tier quota, so including it just produces
// confusing "quota exceeded" failures for users on a free key.
const EVERGREEN_ALIASES = ['gemini-flash-latest'];

function scoreModelName(name){
  let s = 0;
  if(/flash/i.test(name)) s += 50;
  if(/latest/i.test(name)) s += 10;
  if(/lite/i.test(name)) s -= 5;
  if(/\bpro\b/i.test(name)) s -= 200; // avoid Pro-class: usually no free-tier quota
  const verMatch = name.match(/(\d+)\.(\d+)/);
  if(verMatch) s += (parseFloat(verMatch[1]+'.'+verMatch[2]) * 10);
  if(/vision|embedding|aqa|gemma|image|tts|native-audio|nano-banana/i.test(name)) s -= 1000;
  return s;
}
function isAuthError(e){
  if(!e) return false;
  if(e.status===401 || e.status===403) return true;
  const msg = (e.message||'').toLowerCase();
  return /api key not valid|permission denied|invalid authentication|oauth|api_key_invalid/.test(msg);
}
function isTransientError(e){
  if(!e) return false;
  if([429,500,502,503,504].includes(e.status)) return true;
  const msg = (e.message||'').toLowerCase();
  return /overloaded|unavailable|resource_exhausted|rate limit|quota|timeout|deadline|internal error|try again|server error/.test(msg);
}
function isModelMissingError(e){
  if(!e) return false;
  if(e.status===404) return true;
  const msg = (e.message||'').toLowerCase();
  return /not found|deprecated|retired|discontinued|decommissioned|no longer (available|supported)|is not supported/.test(msg);
}
async function discoverBestModel(apiKey){
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
  if(!res.ok) throw new Error('মডেল তালিকা আনা যায়নি');
  const data = await res.json();
  const models = (data.models||[])
    .filter(m => (m.supportedGenerationMethods||[]).includes('generateContent'))
    .map(m => (m.name||'').replace('models/',''))
    .filter(n => /gemini/i.test(n));
  if(models.length===0) throw new Error('কোনো ব্যবহারযোগ্য Gemini মডেল পাওয়া যায়নি');
  models.sort((a,b)=>scoreModelName(b)-scoreModelName(a));
  return models[0];
}
async function getActiveModel(apiKey, forceRefresh){
  const cache = await sGet('modelCache');
  const now = Date.now();
  if(!forceRefresh && cache && cache.model && (now - cache.at) < 24*3600*1000) return cache.model;
  try{
    const best = await discoverBestModel(apiKey);
    await sSet('modelCache', {model:best, at:now});
    return best;
  }catch(e){
    return (cache && cache.model) || EVERGREEN_ALIASES[0];
  }
}
function extractJsonBlock(text){
  const start = text.indexOf('{');
  if(start===-1) return null;
  let depth=0;
  for(let i=start;i<text.length;i++){
    if(text[i]==='{') depth++;
    else if(text[i]==='}'){ depth--; if(depth===0) return text.slice(start,i+1); }
  }
  return null;
}
function safeJsonParse(raw){
  const cleaned = raw.replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
  try{ return JSON.parse(cleaned); }catch(e){}
  const block = extractJsonBlock(cleaned);
  if(block){ try{ return JSON.parse(block); }catch(e){} }
  return null;
}

async function callGeminiAPI({text, imageBase64, imageMime}){
  const apiKey = await sGet('geminiApiKey');
  if(!apiKey) throw new Error('NO_API_KEY');

  const parts = [{ text }];
  if(imageBase64){ parts.push({ inline_data: { mime_type: imageMime || 'image/jpeg', data: imageBase64 } }); }
  const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.6 } };

  async function attempt(model){
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await res.json().catch(()=>({}));
    if(!res.ok){
      const err = new Error(data?.error?.message || ('HTTP '+res.status));
      err.status = res.status;
      throw err;
    }
    // Newer "thinking" models may emit reasoning parts alongside the real answer — drop those.
    const rawParts = data?.candidates?.[0]?.content?.parts || [];
    const outText = rawParts.filter(p=>!p.thought).map(p=>p.text||'').join('');
    if(!outText) throw new Error('EMPTY_RESPONSE');
    const parsed = safeJsonParse(outText);
    if(!parsed) throw new Error('PARSE_FAILED');
    return parsed;
  }

  const userModel = ((await sGet('geminiModel'))||'').trim();
  const manualOverride = userModel && userModel.toLowerCase() !== 'auto';
  const firstGuess = manualOverride ? userModel : await getActiveModel(apiKey, false);

  const tried = new Set();
  const queue = [firstGuess];
  let lastErr = null;
  let didRediscover = false;

  while(queue.length){
    const m = queue.shift();
    if(tried.has(m)) continue;
    tried.add(m);
    let success = null, err = null;
    for(let retry=0; retry<2; retry++){
      try{ success = await attempt(m); break; }
      catch(e){
        err = e;
        if(isAuthError(e)) throw e; // a bad/restricted key can't be fixed by switching models
        if(isTransientError(e) && retry===0){ await sleep(300+Math.random()*300); continue; }
        break;
      }
    }
    if(success){ await sSet('modelCache', {model:m, at:Date.now()}); return success; }
    lastErr = err;
    if(!didRediscover && isModelMissingError(err) && !manualOverride){
      didRediscover = true;
      try{ const fresh = await getActiveModel(apiKey, true); if(!tried.has(fresh)) queue.push(fresh); }catch(e){}
    }
    EVERGREEN_ALIASES.forEach(a=>{ if(!tried.has(a) && !queue.includes(a)) queue.push(a); });
  }
  throw lastErr || new Error('এই মুহূর্তে কোনো Gemini মডেল সাড়া দিচ্ছে না, একটু পর আবার চেষ্টা করো');
}

/* ---------------- settings UI ---------------- */
document.getElementById('settings-btn').addEventListener('click', openSettingsModal);
async function openSettingsModal(){
  const key = (await sGet('geminiApiKey')) || '';
  const model = (await sGet('geminiModel')) || 'auto';
  const cache = await sGet('modelCache');
  openModal(`
    <h3>Gemini API সেটিংস</h3>
    <p class="hint" style="margin-bottom:14px;">প্রশ্ন থেকে AI দিয়ে প্রশ্ন তৈরি করতে তোমার নিজের Gemini API Key দরকার। এটি শুধু তোমার ব্রাউজারে সংরক্ষিত থাকে। Key নিতে <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Google AI Studio</a> ভিজিট করো।</p>
    <div class="field"><label>API Key</label><input id="set-api-key" type="password" value="${esc(key)}" placeholder="AIza..."></div>
    <div class="field"><label>মডেল</label>
      <input id="set-model" type="text" value="${esc(model)}" placeholder="auto">
      <div class="hint">"auto" রাখলে অ্যাপ প্রতিবার key দিয়ে জিজ্ঞেস করে দেখে নেয় এই মুহূর্তে কোন Gemini মডেল সচল আছে এবং ফ্রি-টিয়ারে ব্যবহারযোগ্য (Pro-ক্লাস মডেল এড়িয়ে চলে), এবং সেটাই ব্যবহার করে — কোনো নির্দিষ্ট মডেলের নাম কোডে বসানো নেই।</div>
      <div class="hint" style="margin-top:8px;">শেষ ব্যবহৃত মডেল: <b>${cache && cache.model ? esc(cache.model) : 'এখনো সনাক্ত হয়নি'}</b> · <button type="button" class="link-btn" onclick="redetectModel()">পুনরায় সনাক্ত করো</button></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="saveSettings()">সংরক্ষণ করুন</button>
      <button class="btn" onclick="closeModal()">বাতিল</button>
    </div>`);
  setTimeout(()=>document.getElementById('set-api-key').focus(),50);
}
async function saveSettings(){
  const key = document.getElementById('set-api-key').value.trim();
  const model = document.getElementById('set-model').value.trim() || 'auto';
  await sSet('geminiApiKey', key);
  await sSet('geminiModel', model);
  await sSet('modelCache', null);
  closeModal();
  toast(key ? '✅ API সেটিংস সংরক্ষিত হয়েছে' : 'API key খালি রাখা হয়েছে');
}
async function redetectModel(){
  const apiKey = (document.getElementById('set-api-key')?.value.trim()) || (await sGet('geminiApiKey'));
  if(!apiKey){ toast('প্রথমে API Key দিন'); return; }
  toast('সক্রিয় মডেল সনাক্ত করা হচ্ছে...');
  try{
    const best = await discoverBestModel(apiKey);
    await sSet('modelCache', {model:best, at:Date.now()});
    toast('✅ সক্রিয় মডেল: '+best);
    closeModal(); openSettingsModal();
  }catch(e){ toast('সনাক্ত করা যায়নি: '+e.message); }
}
