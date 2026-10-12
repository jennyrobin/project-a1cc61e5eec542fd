const URL="https://api.groq.com/openai/v1/chat/completions";
const MODELS=["qwen/qwen3.8-27b","openai/gpt-oss-20b"];
const WEB_ORIGINS=new Set([
  "https://wordway-learning.web.app",
  "https://wordway-learning.firebaseapp.com",
  "https://wordway-learning-2026.web.app",
  "https://wordway-learning-2026.firebaseapp.com",
]);

function cors(request:Request){
  const origin=request.headers.get("origin")||"";
  return WEB_ORIGINS.has(origin)?{"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Vary":"Origin"}:{};
}

export async function OPTIONS(request:Request){return new Response(null,{status:204,headers:cors(request)})}

function extract(text:string){
  const clean=text.replace(/<think>[\s\S]*?<\/think>/gi,"").replace(/```(?:json)?/gi,"").replace(/```/g,"").trim();
  for(let start=0;start<clean.length;start++){
    if(clean[start]!=="{")continue;
    let depth=0,quoted=false,escaped=false;
    for(let end=start;end<clean.length;end++){
      const ch=clean[end];
      if(escaped){escaped=false;continue}
      if(ch==="\\"&&quoted){escaped=true;continue}
      if(ch==='"'){quoted=!quoted;continue}
      if(quoted)continue;
      if(ch==="{")depth++;
      if(ch==="}")depth--;
      if(depth===0){try{return JSON.parse(clean.slice(start,end+1))}catch{break}}
    }
  }
  throw new Error("Invalid AI response");
}

class AiError extends Error{
  status:number;
  retryAfter:number;
  constructor(message:string,status:number,retryAfter=0){super(message);this.status=status;this.retryAfter=retryAfter}
}

async function chat(system:string,user:string){
  const key=process.env.GROQ_API_KEY;
  if(!key)throw new AiError("The site AI key is not configured",500);
  let last:AiError|undefined;
  for(const model of MODELS){
    for(let attempt=0;attempt<2;attempt++){
      const payload:Record<string,unknown>={model,messages:[{role:"system",content:system},{role:"user",content:user}],temperature:attempt?0.1:0.25,max_completion_tokens:6500};
      if(model==="openai/gpt-oss-20b")payload.response_format={type:"json_object"};
      const response=await fetch(URL,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`},body:JSON.stringify(payload)});
      if(response.ok){
        try{const data=await response.json() as {choices?:Array<{message?:{content?:string}}>};return extract(data.choices?.[0]?.message?.content||"")}
        catch{last=new AiError("The AI response was interrupted. Retrying automatically.",502);continue}
      }
      const retryAfter=Math.ceil(Number(response.headers.get("retry-after"))||0);
      let message=`Groq request failed (${response.status})`;
      try{const detail=await response.json() as {error?:{message?:string}};message=detail.error?.message||message}catch{}
      last=new AiError(message,response.status,retryAfter);
      if(response.status===401||response.status===403)throw last;
      if(response.status===429)break;
    }
  }
  throw last||new AiError("Groq request failed",500);
}

const stringList=(value:unknown,limit=6)=>Array.isArray(value)?value.map(String).map(item=>item.trim()).filter(Boolean).slice(0,limit):[];
const cefr=(value:unknown,index:number)=>{
  const level=String(value||"").toUpperCase();
  if(["A1","A2","B1","B2","C1","C2"].includes(level))return level;
  return ["A1","A2","B1","B2"][Math.min(3,Math.floor(index/5))];
};
const wordKey=(value:unknown)=>String(value||"").toLocaleLowerCase().split(/[;|]/)[0].replace(/\([^)]*\)/g,"").replace(/[^\p{L}\p{N}]+/gu," ").trim();

type RawWord=Record<string,unknown>;

function cleanWords(raw:unknown[],existing:string[],offset:number){
  const used=new Set(existing.map(wordKey));
  const result:RawWord[]=[];
  for(const item of raw){
    if(!item||typeof item!=="object")continue;
    const source=item as RawWord,target=String(source.target||"").trim(),native=String(source.native||"").trim(),key=wordKey(target);
    if(!target||!native||!key||used.has(key))continue;
    used.add(key);
    const index=offset+result.length;
    result.push({
      target,native,
      article:String(source.article||"").trim(),
      gender:String(source.gender||"").trim(),
      plural:String(source.plural||"").trim(),
      partOfSpeech:String(source.partOfSpeech||"").trim(),
      forms:stringList(source.forms),
      meanings:stringList(Array.isArray(source.meanings)?source.meanings:[native]),
      synonyms:stringList(source.synonyms,4),
      pronunciation:String(source.pronunciation||"").trim(),
      exampleTarget:String(source.exampleTarget||"").trim(),
      exampleNative:String(source.exampleNative||"").trim(),
      cefr:cefr(source.cefr,index),
    });
    if(result.length===20)break;
  }
  return result;
}

async function generateWords(body:Record<string,unknown>){
  const offset=Number(body.offset)||0,existing=Array.isArray(body.existing)?body.existing.map(String).slice(-300):[];
  let collected:RawWord[]=[];
  for(let attempt=0;attempt<2&&collected.length<20;attempt++){
    const remaining=20-collected.length,excluded=[...existing,...collected.map(word=>String(word.target||""))];
    const data=await chat(
      "You create accurate language courses. Return one JSON object only, with no markdown or reasoning. Use real, current words. Keep examples short and natural. Never invent translations.",
      `Create exactly ${remaining} unique vocabulary entries for learning ${body.targetLanguage}, translated into ${body.nativeLanguage}. Topic: ${body.topic}. Continue from course position ${offset+collected.length+1} and increase difficulty gradually. Include a useful spread of CEFR levels. Do not repeat: ${excluded.join(", ")}. Every noun must have its natural article, gender, and plural when the language uses them. Every verb must include useful principal forms. Return {"words":[{"target":"natural dictionary form, including article where appropriate","native":"context-appropriate translation","article":"","gender":"","plural":"","partOfSpeech":"","forms":[""],"meanings":[""],"synonyms":[""],"pronunciation":"simple pronunciation hint","exampleTarget":"short natural example","exampleNative":"translation","cefr":"A1"}]}. Synonyms must be in ${body.targetLanguage}.`
    ) as {words?:unknown[]};
    collected=cleanWords([...collected,...(Array.isArray(data.words)?data.words:[])],existing,offset);
  }
  if(collected.length<20)throw new AiError(`The AI returned ${collected.length} usable words instead of 20. Retrying this block will keep your saved course.`,502);

  let checks:RawWord[]=[];
  try{
    const validation=await chat(
      "You are a strict bilingual vocabulary editor. Check every supplied entry for real spelling, correct language, article, grammar, translation, topic relevance, and duplicates. Return JSON only. Do not omit an index.",
      `Learning language: ${body.targetLanguage}. Translation language: ${body.nativeLanguage}. Topic: ${body.topic}. Check these entries: ${JSON.stringify(collected)}. Return {"checks":[{"index":0,"valid":true,"target":"corrected target","native":"corrected translation","article":"","gender":"","plural":"","partOfSpeech":"","forms":[""],"meanings":[""],"synonyms":[""],"pronunciation":"","exampleTarget":"","exampleNative":"","cefr":"A1"}]}. Correct small problems directly. Set valid false only if the entry cannot be repaired.`
    ) as {checks?:RawWord[]};
    checks=Array.isArray(validation.checks)?validation.checks:[];
  }catch{/* Local structural validation still protects the saved block if the provider is temporarily busy. */}

  const corrected=collected.map((word,index)=>{
    const check=checks.find(item=>Number(item.index)===index),merged=check?.valid===false?word:{...word,...check};
    return {...merged,verified:check?.valid!==false&&!!check};
  }).sort((a,b)=>["A1","A2","B1","B2","C1","C2"].indexOf(String(a.cefr))-["A1","A2","B1","B2","C1","C2"].indexOf(String(b.cefr)));
  const levels=["easy","normal","hard","expert"];
  return corrected.map((word,index)=>{
    const position=offset+index,cefrLevel=cefr(word.cefr,position),rank=["A1","A2","B1","B2","C1","C2"].indexOf(cefrLevel);
    return {...word,id:`w${String(position+1).padStart(3,"0")}`,cefr:cefrLevel,level:levels[Math.min(3,Math.floor(rank/1.5))],lesson:Math.floor(position/5)+1};
  });
}

export async function POST(request:Request){
  const json=(body:unknown,status=200)=>Response.json(body,{status,headers:cors(request)});
  try{
    const body=await request.json() as Record<string,unknown>;
    if(body.action==="generate")return json({words:await generateWords(body)});
    if(body.action==="titles"){
      const words=Array.isArray(body.words)?body.words as RawWord[]:[],lines=words.map(word=>`${word.lesson}: ${word.target}`).join("\n");
      const data=await chat("Name language lessons. Return strict JSON only.",`Name each lesson in 2-5 words in ${body.nativeLanguage}. Topic: ${body.topic}. Words:\n${lines}\nReturn {"titles":{"1":"..."}}.`) as {titles?:Record<string,string>};
      return json({titles:data.titles||{}});
    }
    if(body.action==="judge"){
      const data=await chat("You are a strict vocabulary answer checker. Accept an obvious one-letter typo or a valid synonym. Return one corrected word or phrase only, without explanation, in JSON.",`Learning language: ${body.targetLanguage}. Native language: ${body.nativeLanguage}. Word data: ${JSON.stringify(body.word)}. User answer: ${String(body.answer||"")}. Expected: ${JSON.stringify(body.expected)}. Return exactly {"correct":true,"corrected":"one correct answer"}.`) as {correct?:boolean;corrected?:string};
      const expected=Array.isArray(body.expected)?body.expected:[];
      return json({correct:!!data.correct,corrected:String(data.corrected||expected[0]||"")});
    }
    return json({error:"Unknown action"},400);
  }catch(reason){
    const error=reason as AiError;
    return json({error:error.message||"AI error",retryAfter:error.retryAfter||undefined},error.status||500);
  }
}
