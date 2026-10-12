"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { ArrowLeft, BarChart3, BookOpen, Check, ChevronDown, ChevronRight, Download, Lightbulb, Mic, Moon, Play, Plus, Search, Settings, Sun, Trash2, Undo2, Volume2, X } from "lucide-react";

type Level = "easy" | "normal" | "hard" | "expert";
type Word = { id:string; target:string; native:string; level:Level; lesson:number; partOfSpeech:string; synonyms:string[]; exampleTarget:string; exampleNative:string };
type Stat = { seen:number; correct:number; wrong:number; mastery:number; averageMs:number; lastSeen?:string; nextDue:string };
type Course = { id:string; name:string; targetLanguage:string; nativeLanguage:string; topic:string; words:Word[]; lessonTitles:Record<string,string>; progress:{ currentLesson:number; completedLessons:number[]; stats:Record<string,Stat>; lastExtendedLesson?:number } };
type Data = { courses:Course[]; activeCourseId?:string; theme:"light"|"dark"; accent:"purple"|"blue"; interfaceScale?:number };
type Screen = "home"|"words"|"stats"|"settings"|"create"|"delete"|"lesson";
type TaskType = "choice"|"reverseChoice"|"write"|"toNative"|"toTarget"|"match"|"wordBank"|"fillBlank"|"listen"|"heardChoice"|"speak"|"synonymChoice";
type Task = { type:TaskType; word:Word; answer:string; accepted:string[]; options?:string[]; pairs?:Word[]; phrase?:string; cloze?:string; tiles?:string[] };
type SpeechResultEvent = { results?:{ 0?:{ 0?:{ transcript?:string } } } };
type SpeechRecognitionInstance = { lang:string; interimResults:boolean; maxAlternatives:number; onstart?:()=>void; onend?:()=>void; onerror?:()=>void; onresult?:(event:SpeechResultEvent)=>void; start:()=>void };
type SpeechRecognitionConstructor = new()=>SpeechRecognitionInstance;

const STORE = "wordway-web-v1";
const AI_URL = (globalThis as typeof globalThis & { WORDWAY_API_URL?:string }).WORDWAY_API_URL || "/api/ai";
const empty:Data = { courses:[], theme:"light", accent:"blue", interfaceScale:100 };
const SCALE_POINTS=[80,90,100,120,140] as const;
const shuffle = <T,>(a:T[]) => [...a].sort(() => Math.random() - .5);
const normalize = (s:string) => s.toLocaleLowerCase().replace(/[.,!?;:()\[\]{}"']/g, "").replace(/\s+/g," ").trim();
const matches = (answer:string, values:string[]) => values.some(v => v.split(/[,;/|]/).map(normalize).includes(normalize(answer)));
const maxLesson = (c:Course) => Math.max(1, ...c.words.map(w => w.lesson));
const unique = (values:string[]) => Array.from(new Set(values.map(value=>value.trim()).filter(Boolean)));
const targetForm = (word:Word) => word.target.split(/[;|]/)[0].replace(/\([^)]*\)/g,"").trim() || word.target;
const targetAnswers = (word:Word) => unique([word.target,targetForm(word),...word.synonyms]);
const nativeAnswers = (word:Word) => unique([word.native]);
const phraseTokens = (phrase:string) => phrase.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|[^\s]/gu) || [phrase];

function clozeFor(word:Word) {
  const sentence=word.exampleTarget.trim(),main=targetForm(word);
  if(sentence){
    const candidates=unique([main,...main.split(/\s+/).reverse()]).sort((a,b)=>b.length-a.length);
    for(const candidate of candidates){const at=sentence.toLocaleLowerCase().indexOf(candidate.toLocaleLowerCase());if(at>=0)return {text:`${sentence.slice(0,at)}_____ ${sentence.slice(at+candidate.length)}`.replace(/\s{2,}/g," ").replace(/\s+([.,!?])/g,"$1"),answer:sentence.slice(at,at+candidate.length)}}
  }
  return {text:`${word.native}: _____`,answer:main};
}

function choices(answer:string,distractors:string[],count=4){return shuffle(unique([answer,...distractors]).slice(0,count))}

async function ai(body:unknown) {
  const response = await fetch(AI_URL, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "AI request failed") as Error & { retryAfter?:number; status?:number };
    error.retryAfter = Number(result.retryAfter) || undefined;
    error.status = response.status;
    throw error;
  }
  return result;
}

const wait = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));
async function aiWithRetry(body:unknown, onWait?:(seconds:number)=>void) {
  for (let attempt=0;attempt<4;attempt++) {
    try { return await ai(body); }
    catch (reason) {
      const error=reason as Error & { retryAfter?:number; status?:number };
      if(error.status!==429 || attempt===3) throw error;
      const seconds=Math.max(4,Math.min(90,error.retryAfter || 12*(attempt+1)));
      onWait?.(seconds);
      await wait(seconds*1000);
    }
  }
}

function lessonSession(course:Course, lesson:number) {
  const own = course.words.filter(w => w.lesson === lesson);
  const unseen = own.filter(w => !course.progress.stats[w.id]?.seen);
  const due = course.words.filter(w => {
    const s = course.progress.stats[w.id];
    return w.lesson <= lesson && s?.seen && (s.mastery < .7 || s.wrong > s.correct || new Date(s.nextDue) <= new Date());
  });
  const difficult = course.words.filter(w => { const s=course.progress.stats[w.id]; return w.lesson<=lesson && s?.wrong>0 && s.mastery<.75 });
  const taskCount = due.length>=5 || difficult.length>=2 ? 20 : 12;
  const intro = shuffle(unseen).slice(0, Math.min(5, Math.max(2, unseen.length)));
  const candidates = shuffle([...intro,...intro,...due,...difficult,...own]);
  const fallback = own.length ? own : course.words.filter(w=>w.lesson<=lesson);
  const training:Word[] = [];
  for(let i=0;training.length<taskCount&&fallback.length;i++) training.push(candidates.length?candidates[i%candidates.length]:fallback[i%fallback.length]);
  const pool = course.words.filter(w => w.lesson <= lesson);
  const kinds:TaskType[] = ["choice","reverseChoice","write","toNative","toTarget","match","wordBank","fillBlank","listen","heardChoice","speak","synonymChoice"];
  const tasks = training.map((word,i):Task => {
    const type = kinds[i % kinds.length];
    const others=shuffle(pool.filter(item=>item.id!==word.id));
    if(type==="choice")return {type,word,answer:word.native,accepted:nativeAnswers(word),options:choices(word.native,others.map(item=>item.native))};
    if(type==="reverseChoice"||type==="heardChoice")return {type,word,answer:targetForm(word),accepted:targetAnswers(word),options:choices(targetForm(word),others.map(targetForm))};
    if(type==="match")return {type,word,answer:"",accepted:[],pairs:shuffle([word,...others.slice(0,3)])};
    if(type==="wordBank"){
      const phrase=word.exampleTarget.trim()||targetForm(word),translation=word.exampleNative.trim()||word.native;
      const extra=others.flatMap(item=>phraseTokens(targetForm(item))).filter(token=>/[\p{L}\p{N}]/u.test(token)).slice(0,2);
      return {type,word,answer:phrase,accepted:[phrase],phrase:translation,tiles:shuffle([...phraseTokens(phrase),...extra])};
    }
    if(type==="fillBlank"){
      const cloze=clozeFor(word);
      return {type,word,answer:cloze.answer,accepted:unique([cloze.answer,...targetAnswers(word)]),cloze:cloze.text,options:choices(cloze.answer,others.map(targetForm))};
    }
    if(type==="synonymChoice"){
      const synonym=word.synonyms[0];
      if(synonym)return {type,word,answer:synonym,accepted:word.synonyms,options:choices(synonym,others.flatMap(item=>item.synonyms.length?item.synonyms:[targetForm(item)]))};
      return {type:"reverseChoice",word,answer:targetForm(word),accepted:targetAnswers(word),options:choices(targetForm(word),others.map(targetForm))};
    }
    if(type==="toNative")return {type,word,answer:word.native,accepted:nativeAnswers(word)};
    return {type,word,answer:targetForm(word),accepted:targetAnswers(word)};
  });
  return { intro, tasks };
}

export default function App() {
  const [data,setData] = useState<Data>(empty);
  const [ready,setReady] = useState(false);
  const [screen,setScreen] = useState<Screen>("home");
  const [menu,setMenu] = useState(false);
  const [lesson,setLesson] = useState(1);
  const [extending,setExtending] = useState(false);
  const scaleLayerRef = useRef<HTMLDivElement>(null);
  const visualScaleRef = useRef(100);
  const active = data.courses.find(c=>c.id===data.activeCourseId) ?? data.courses[0];
  useEffect(()=>{ try { const raw=localStorage.getItem(STORE); if(raw){const loaded={...empty,...JSON.parse(raw)} as Data;visualScaleRef.current=loaded.interfaceScale??100;setData(loaded)} } finally { setReady(true); } },[]);
  useEffect(()=>{ if(ready) localStorage.setItem(STORE,JSON.stringify(data)); },[data,ready]);
  useEffect(()=>{requestAnimationFrame(()=>{window.scrollTo({top:0,left:0,behavior:"auto"});document.documentElement.scrollTop=0;document.body.scrollTop=0})},[screen]);
  useEffect(()=>{const layer=scaleLayerRef.current;if(!layer)return;const target=data.interfaceScale??100,from=visualScaleRef.current,headerHeight=screen==="home"||screen==="words"||screen==="stats"?74:0;const apply=(value:number)=>{const factor=value/100;layer.style.zoom=String(factor);layer.style.width="100%";layer.style.minHeight=headerHeight?`calc(${100/factor}vh - ${headerHeight/factor}px)`:`${100/factor}vh`;visualScaleRef.current=value};if(Math.abs(target-from)<.1){apply(target);return}let frame=0,start=0;const tick=(now:number)=>{if(!start)start=now;const progress=Math.min(1,(now-start)/460),eased=progress*progress*(3-2*progress);apply(from+(target-from)*eased);if(progress<1)frame=requestAnimationFrame(tick)};frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame)},[data.interfaceScale,ready,screen]);
  const saveCourse=(course:Course)=>setData(d=>({...d,activeCourseId:course.id,courses:d.courses.map(c=>c.id===course.id?course:c)}));
  if(!ready) return <main className="loading"><span className="spinner"/></main>;
  const extendCourse=async(course:Course,startingLesson:number)=>{
    const total=maxLesson(course);
    if(extending||startingLesson<total-1||course.progress.lastExtendedLesson===startingLesson)return;
    setExtending(true);
    const marked={...course,progress:{...course.progress,lastExtendedLesson:startingLesson}};
    saveCourse(marked);
    try{
      const result=await aiWithRetry({action:"generate",targetLanguage:course.targetLanguage,nativeLanguage:course.nativeLanguage,topic:course.topic,offset:course.words.length,existing:course.words.map(w=>w.target)});
      const expanded={...marked,words:[...course.words,...result.words]};
      setData(d=>({...d,courses:d.courses.map(c=>c.id===course.id?{...c,words:expanded.words}:c)}));
      const titled=await aiWithRetry({action:"titles",targetLanguage:course.targetLanguage,nativeLanguage:course.nativeLanguage,topic:course.topic,words:expanded.words});
      setData(d=>({...d,courses:d.courses.map(c=>c.id===course.id?{...c,lessonTitles:{...c.lessonTitles,...(titled.titles||{})}}:c)}));
    }catch{ /* The next lesson start can retry after the provider limit resets. */ }
    finally{setExtending(false)}
  };
  const openLesson=(n:number)=>{setMenu(false);if(active)void extendCourse(active,n);setLesson(n);setScreen("lesson")};
  const scaleFactor=(data.interfaceScale??100)/100;
  const showNavigation=screen==="home"||screen==="words"||screen==="stats";
  const scaledMinHeight=showNavigation?`calc(${100/scaleFactor}vh - ${74/scaleFactor}px)`:`${100/scaleFactor}vh`;
  return <main className={`app ${data.theme} ${data.accent} ${showNavigation?"has-navigation":""}`}>
    {showNavigation&&<header className="topbar">
      <div className="top-spacer">{screen!=="home"&&<button className="icon-btn large" aria-label="Back" onClick={()=>setScreen("home")}><ArrowLeft/></button>}</div>
      <button className="course-trigger" onClick={()=>setMenu(!menu)}><span>{active?.name.replace(" · "," / ") || "Choose a course"}</span><ChevronDown size={19}/></button>
      <button className="icon-btn large" aria-label="Settings" onClick={()=>setScreen("settings")}><Settings/></button>
    </header>}
    {showNavigation&&menu&&<CourseMenu data={data} onClose={()=>setMenu(false)} onSelect={id=>{setData(d=>({...d,activeCourseId:id}));setMenu(false);setScreen("home")}} onCreate={()=>{setMenu(false);setScreen("create")}} onDelete={()=>{setMenu(false);setScreen("delete")}}/>}
    <div ref={scaleLayerRef} className="app-scale" style={{zoom:scaleFactor,width:"100%",minHeight:scaledMinHeight} as CSSProperties}>
    {screen === "create" ? <CreateCourse canBack onBack={()=>setScreen("home")} onCreated={c=>{setData(d=>({...d,courses:[...d.courses,c],activeCourseId:c.id}));setScreen("home")}}/> :
     screen === "delete" && active ? <DeleteCourse course={active} onBack={()=>setScreen("home")} onDelete={()=>{setData(d=>{const courses=d.courses.filter(c=>c.id!==active.id);return {...d,courses,activeCourseId:courses[0]?.id}});setScreen("home")}}/> :
     screen === "lesson" && active ? <Lesson course={active} number={lesson} onSave={saveCourse} onClose={()=>setScreen("home")}/> :
     screen === "settings" ? <SettingsPage data={data} course={active} onChange={setData} onBack={()=>setScreen("home")} onWords={()=>setScreen("words")} onStats={()=>setScreen("stats")}/> : <>
      {screen === "home" && (active?<Home course={active} onLesson={openLesson} extending={extending}/>:<EmptyState onCreate={()=>setScreen("create")}/>)} 
      {screen === "words" && active && <Words course={active}/>} 
      {screen === "stats" && active && <Stats course={active}/>} 
    </>}
    </div>
  </main>;
}

function EmptyState({onCreate}:{onCreate:()=>void}){
  return <section className="page empty-state"><div className="heading"><h1>Welcome</h1><p>The app builds lessons around the words you actually need.</p></div><div className="empty-steps"><article><h2>1. Create a course</h2><p>Choose the language you want to learn, your native language, and any topic.</p></article><article><h2>2. Generate words</h2><p>Groq prepares the first block of 20 words and keeps saved results if a usage limit is reached.</p></article><article><h2>3. Start learning</h2><p>Lessons combine new words, mistakes, and older words that are due for review.</p></article></div><button className="primary" onClick={onCreate}><Plus size={18}/>Create your first course</button></section>
}

function Home({course,onLesson,extending}:{course:Course,onLesson:(n:number)=>void;extending:boolean}) {
  const total=maxLesson(course), current=Math.min(course.progress.currentLesson,total);
  const stats=Object.values(course.progress.stats), seen=stats.filter(s=>s.seen).length, mastered=stats.filter(s=>s.mastery>=.86&&s.correct>=3).length;
  const answers=stats.reduce((a,s)=>a+s.seen,0), correct=stats.reduce((a,s)=>a+s.correct,0);
  const currentWords=course.words.filter(w=>w.lesson===current),lessonSeen=currentWords.filter(w=>(course.progress.stats[w.id]?.seen||0)>0).length,lessonProgress=Math.round(lessonSeen/Math.max(1,currentWords.length)*100);
  const weak=course.words.filter(w=>{const s=course.progress.stats[w.id];return s?.seen&&s.mastery<.6}).sort((a,b)=>(course.progress.stats[a.id]?.mastery||0)-(course.progress.stats[b.id]?.mastery||0)).slice(0,4);
  const levelNames:Record<Level,string>={easy:"easy",normal:"normal",hard:"hard",expert:"expert"};
  const pathRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{const path=pathRef.current,node=path?.querySelector<HTMLElement>(".current");if(!path||!node)return;const left=node.offsetLeft-(path.clientWidth-node.offsetWidth)/2;path.scrollTo({left:Math.max(0,left),behavior:"smooth"})},[current]);
  return <section className="page home-page">
    <div className="heading"><h1>Your path</h1><p>{course.targetLanguage} <span>→</span> {course.nativeLanguage} <b>·</b> {course.topic}</p></div>
    <section className="next-lesson"><div><span className="kicker">NEXT LESSON · {current} OF {total}</span><h2>{course.lessonTitles[current] || `Lesson ${current}`}</h2><p>Learn new words, practise them, and revisit difficult ones.</p><button className="primary" onClick={()=>onLesson(current)}><Play size={18} fill="currentColor"/>Start lesson</button></div><div className="ring" style={{"--lesson-progress":`${lessonProgress}%`} as CSSProperties}><strong>{lessonProgress}%</strong><span>lesson</span></div></section>
    <div className="metrics"><Metric tone="blue" label="Words seen" value={`${seen}/${course.words.length}`}/><Metric tone="green" label="Mastered" value={String(mastered)}/><Metric tone="orange" label="Accuracy" value={`${answers?Math.round(correct/answers*100):0}%`}/></div>
    {weak.length>0&&<><div className="section-title repeat-title"><h2>Words to review</h2></div><div className="repeat-strip">{weak.map(w=><span key={w.id}><b>{w.target}</b> → {w.native}</span>)}</div></>}
    <div className="section-title"><h2>Learning road</h2>{extending&&<span>Adding 20 new words...</span>}</div>
    <div className="road-wrap" ref={pathRef}>{Array.from({length:total},(_,i)=>i+1).map((n,i)=>{const lessonWords=course.words.filter(w=>w.lesson===n),lessonStats=lessonWords.map(w=>course.progress.stats[w.id]),masteredCount=lessonStats.filter(s=>s?.mastery>=.86&&s.correct>=3).length,done=masteredCount>=Math.max(1,Math.floor(lessonWords.length*.75))||course.progress.completedLessons.includes(n),state=done?"done":n===current?"current":n<current?"next":"future",level=lessonWords[0]?.level||"easy";return <div className={`road-step offset-${i%6}`} key={n}><button className={`lesson-node ${state}`} onClick={()=>onLesson(n)}>{done?<Check/>:n}</button><strong>Lesson {n}</strong><b>{course.lessonTitles[n]||"New words"}</b><span>{levelNames[level]} {masteredCount}/{lessonWords.length}{state==="current"?"  now":state==="done"?"  repeat":""}</span></div>})}</div>
  </section>;
}
function Metric({label,value,tone="accent"}:{label:string,value:string,tone?:string}){return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>}

function CreateCourse({canBack,onBack,onCreated}:{canBack:boolean,onBack:()=>void,onCreated:(c:Course)=>void}){
  const [target,setTarget]=useState(""),[native,setNative]=useState(""),[topic,setTopic]=useState(""),[busy,setBusy]=useState(false),[status,setStatus]=useState(""),[error,setError]=useState("");
  const create=async()=>{if(!target.trim()||!native.trim()||!topic.trim()){setError("Complete all three fields.");return} setBusy(true);setError("");
    try{setStatus("Creating the first 20 words...");const r=await aiWithRetry({action:"generate",targetLanguage:target,nativeLanguage:native,topic,offset:0,existing:[]},seconds=>setStatus(`Groq is busy. Continuing automatically in ${seconds} seconds...`));const words:Word[]=r.words;setStatus("Naming four lessons...");const t=await aiWithRetry({action:"titles",targetLanguage:target,nativeLanguage:native,topic,words},seconds=>setStatus(`Waiting ${seconds} seconds before naming lessons...`));const course:Course={id:crypto.randomUUID(),name:`${target} / ${topic}`,targetLanguage:target,nativeLanguage:native,topic,words,lessonTitles:t.titles||{},progress:{currentLesson:1,completedLessons:[],stats:{}}};onCreated(course)}catch(e){const error=e as Error & {status?:number};setError(error.status===429?"Groq's usage limit is exhausted. Try creating the course again after the limit resets.":error.message||"Could not create course") }finally{setBusy(false)}};
  return <section className="full-page editor-page"><div className="editor-shell"><header className="editor-head">{canBack&&<button className="settings-back" aria-label="Back" onClick={onBack}><ArrowLeft/></button>}<h1>New course</h1></header><section className="editor-card"><h2>Set up a new course</h2><p>Choose the language, translation language, and topic.</p><label>Language to learn<input value={target} onChange={e=>setTarget(e.target.value)} placeholder="For example, German"/></label><label>Your native language<input value={native} onChange={e=>setNative(e.target.value)} placeholder="For example, English"/></label><label>Word topic<input value={topic} onChange={e=>setTopic(e.target.value)} placeholder="Engineering, school, travel..."/></label>{error&&<div className="error">{error}</div>}{busy?<div className="status"><span className="spinner"/>{status}</div>:<div className="editor-actions"><button className="primary" onClick={create}>Create course</button>{canBack&&<button className="secondary" onClick={onBack}>Cancel</button>}</div>}</section></div></section>
}

function DeleteCourse({course,onBack,onDelete}:{course:Course;onBack:()=>void;onDelete:()=>void}){
  const [confirmation,setConfirmation]=useState(""),[error,setError]=useState("");
  const remove=()=>{if(confirmation.trim()!=="DELETE"){setError("Type DELETE to confirm this action.");return}onDelete()};
  return <section className="full-page editor-page"><div className="editor-shell"><header className="editor-head"><button className="settings-back" aria-label="Back" onClick={onBack}><ArrowLeft/></button><h1>Delete course</h1></header><section className="editor-card"><h2>Delete this course?</h2><h3>{course.name.replace(" · "," / ")}</h3><p>Its words, lessons, and all learning progress will be removed. This cannot be undone.</p><label>Type DELETE to confirm<input value={confirmation} onChange={e=>{setConfirmation(e.target.value);setError("")}} onKeyDown={e=>{if(e.key==="Enter")remove()}}/></label>{error&&<div className="error">{error}</div>}<div className="editor-actions"><button className="danger" onClick={remove}><Trash2 size={18}/>Delete course</button><button className="secondary" onClick={onBack}>Cancel</button></div></section></div></section>
}

function CourseMenu({data,onClose,onSelect,onCreate,onDelete}:{data:Data,onClose:()=>void,onSelect:(id:string)=>void;onCreate:()=>void;onDelete:(c:Course)=>void}){const active=data.courses.find(c=>c.id===data.activeCourseId)||data.courses[0];return <div className="course-popover-layer" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section className="course-menu">{data.courses.map(c=><button className={`course-menu-item ${c.id===data.activeCourseId?"selected-course":""}`} key={c.id} onClick={()=>onSelect(c.id)}>{c.id===data.activeCourseId?<Check/>:<span className="menu-spacer"/>}<span>{c.name.replace(" · "," / ")}</span></button>)}<div className="menu-divider"/><button className="course-menu-item" onClick={onCreate}><Plus/><span>New course</span></button>{active&&<button className="course-menu-item danger-item" onClick={()=>onDelete(active)}><Trash2/><span>Delete current course</span></button>}<div className="menu-divider"/><button className="course-menu-item close-item" onClick={onClose}><X/><span>Close</span></button></section></div>}

function Words({course}:{course:Course}){
  const [query,setQuery]=useState(""),[level,setLevel]=useState<Level|"all">("all"),[selected,setSelected]=useState(course.words[0]?.id||"");
  const words=course.words.filter(w=>(level==="all"||w.level===level)&&`${w.target} ${w.native} ${w.synonyms.join(" ")}`.toLowerCase().includes(query.toLowerCase())),detail=course.words.find(w=>w.id===selected);
  return <section className="page words-page"><div className="heading"><h1>AI words</h1><p>Every word selected for this course.</p></div><div className="word-filters"><label>Search<div className="search"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Word, translation, or synonym"/></div></label><label>Level<select value={level} onChange={e=>setLevel(e.target.value as Level|"all")}><option value="all">all</option><option value="easy">easy</option><option value="normal">normal</option><option value="hard">hard</option><option value="expert">expert</option></select></label></div><div className="word-table-wrap"><table className="word-table"><thead><tr><th>ID</th><th>Lesson</th><th>Level</th><th>Mastery</th><th>Word</th><th>Translation</th><th>Synonyms</th></tr></thead><tbody>{words.map(w=>{const s=course.progress.stats[w.id];return <tr className={selected===w.id?"selected-row":""} key={w.id} onClick={()=>setSelected(w.id)}><td>{w.id.slice(0,7)}</td><td>{w.lesson}</td><td>{w.level}</td><td>{Math.round((s?.mastery||0)*100)}%</td><td><b>{w.target}</b></td><td>{w.native}</td><td>{w.synonyms.slice(0,4).join(", ")}</td></tr>})}</tbody></table></div>{detail&&<div className="word-detail"><b>{detail.target} → {detail.native}</b>{detail.exampleTarget&&<span>{detail.exampleTarget}{detail.exampleNative&&` — ${detail.exampleNative}`}</span>}</div>}</section>
}

function Stats({course}:{course:Course}){const all=Object.values(course.progress.stats),seen=all.filter(s=>s.seen>0).length,mastered=all.filter(s=>s.mastery>=.86&&s.correct>=3).length,answers=all.reduce((n,s)=>n+s.seen,0),correct=all.reduce((n,s)=>n+s.correct,0),accuracy=answers?correct/answers*100:0,current=course.progress.currentLesson,total=maxLesson(course),rows=[{label:"Words studied",value:seen,total:course.words.length},{label:"Words mastered",value:mastered,total:course.words.length},{label:"Current lesson",value:Math.min(current,total),total}];return <section className="page stats-page"><div className="heading"><h1>Statistics</h1><p>{course.name.replace(" · "," / ")}</p></div><section className="stats-progress">{rows.map(row=><div className="stats-row" key={row.label}><strong>{row.label}: {row.value}/{row.total}</strong><div><span style={{width:`${Math.min(100,row.value/Math.max(1,row.total)*100)}%`}}/></div></div>)}<h2>Answer accuracy: {accuracy.toFixed(1)}%</h2></section></section>}

function SettingsPage({data,course,onChange,onBack,onWords,onStats}:{data:Data,course?:Course,onChange:(d:Data)=>void,onBack:()=>void,onWords:()=>void;onStats:()=>void}){
  const exportCsv=async()=>{if(!course)return;const q=(v:unknown)=>`"${String(v??"").replace(/"/g,'""')}"`;const rows=[["word","translation","level","lesson","synonyms"],...course.words.map(w=>[w.target,w.native,w.level,w.lesson,w.synonyms.join("; ")])];const blob=new Blob(["\ufeff"+rows.map(r=>r.map(q).join(",")).join("\n")],{type:"text/csv"});const picker=(window as typeof window&{showSaveFilePicker?:(options:unknown)=>Promise<{createWritable:()=>Promise<{write:(value:Blob)=>Promise<void>;close:()=>Promise<void>}>}>}).showSaveFilePicker;if(picker){try{const handle=await picker.call(window,{suggestedName:`${course.name}-words.csv`,types:[{description:"CSV files",accept:{"text/csv":[".csv"]}}]});const writable=await handle.createWritable();await writable.write(blob);await writable.close();return}catch(error){if((error as Error).name==="AbortError")return}}const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`${course.name}-words.csv`;a.click();URL.revokeObjectURL(a.href)};
  const points=SCALE_POINTS,scale=data.interfaceScale??100,scaleIndex=Math.max(0,points.indexOf(scale as typeof points[number]));
  const [scalePosition,setScalePosition]=useState(scaleIndex),[dragging,setDragging]=useState(false);
  const dragStart=useRef(scaleIndex),positionRef=useRef(scaleIndex),draggingRef=useRef(false),dataRef=useRef(data),changeRef=useRef(onChange);
  useEffect(()=>{dataRef.current=data;changeRef.current=onChange},[data,onChange]);
  useEffect(()=>{if(!draggingRef.current){positionRef.current=scaleIndex;setScalePosition(scaleIndex)}},[scaleIndex]);
  useEffect(()=>{const control=document.querySelector<HTMLElement>(".scale-control"),track=control?.querySelector<HTMLElement>(".scale-dots");if(!control||!track)return;let pointerId:number|null=null,last=positionRef.current,direction=0;const read=(clientX:number)=>{const rect=track.getBoundingClientRect();return Math.max(0,Math.min(4,(clientX-rect.left)/Math.max(1,rect.width)*4))};const update=(position:number)=>{positionRef.current=position;setScalePosition(position)};const down=(event:PointerEvent)=>{if(event.button!==0)return;event.preventDefault();pointerId=event.pointerId;control.setPointerCapture(pointerId);draggingRef.current=true;setDragging(true);const position=read(event.clientX),delta=position-positionRef.current;direction=Math.abs(delta)>.005?Math.sign(delta):0;last=position;dragStart.current=positionRef.current;update(position)};const move=(event:PointerEvent)=>{if(!draggingRef.current||event.pointerId!==pointerId)return;event.preventDefault();const position=read(event.clientX),delta=position-last;if(Math.abs(delta)>.005)direction=Math.sign(delta);last=position;update(position)};const finish=(event:PointerEvent)=>{if(!draggingRef.current||event.pointerId!==pointerId)return;event.preventDefault();const position=read(event.clientX),delta=position-last;if(Math.abs(delta)>.005)direction=Math.sign(delta);if(!direction)direction=Math.sign(position-dragStart.current);let target=direction>0?Math.ceil(position):direction<0?Math.floor(position):Math.round(position);target=Math.max(0,Math.min(4,target));draggingRef.current=false;pointerId=null;positionRef.current=target;setDragging(false);setScalePosition(target);const nextScale=points[target],current=dataRef.current;if(nextScale!==(current.interfaceScale??100))changeRef.current({...current,interfaceScale:nextScale})};control.addEventListener("pointerdown",down);control.addEventListener("pointermove",move);control.addEventListener("pointerup",finish);control.addEventListener("pointercancel",finish);return()=>{control.removeEventListener("pointerdown",down);control.removeEventListener("pointermove",move);control.removeEventListener("pointerup",finish);control.removeEventListener("pointercancel",finish)}},[points]);
  const displayedScale=(()=>{const lower=Math.floor(scalePosition),upper=Math.min(points.length-1,Math.ceil(scalePosition)),part=scalePosition-lower;return Math.round(points[lower]+(points[upper]-points[lower])*part)})();
  const commitScale=()=>{const position=positionRef.current,direction=Math.sign(position-dragStart.current);let target=direction>0?Math.ceil(position):direction<0?Math.floor(position):Math.round(position);target=Math.max(0,Math.min(points.length-1,target));positionRef.current=target;setDragging(false);setScalePosition(target);if(points[target]!==scale)onChange({...data,interfaceScale:points[target]})};
  return <section className="full-page settings-page"><div className="settings-shell"><div className="settings-head"><button className="settings-back" aria-label="Back" onClick={onBack}><ArrowLeft/></button><h1>Settings</h1></div><div className="settings-stack"><div><p className="settings-caption">COURSE</p><section className="setting-block"><button className="setting-row" onClick={onWords}><BookOpen/><span><strong>All words</strong></span><ChevronRight/></button><button className="setting-row" onClick={onStats}><BarChart3/><span><strong>Statistics</strong></span><ChevronRight/></button><button className="setting-row" onClick={exportCsv}><Download/><span><strong>Export words to CSV</strong></span><ChevronRight/></button></section></div><div><p className="settings-caption">APPEARANCE</p><section className="setting-block appearance-block"><button className="setting-row theme-toggle" onClick={()=>onChange({...data,theme:data.theme==="dark"?"light":"dark"})}>{data.theme==="dark"?<Sun/>:<Moon/>}<span><strong>Enable {data.theme==="dark"?"light":"dark"} theme</strong></span><ChevronRight/></button><div className="accent-drawer open"><div className="accent-previews"><button className={data.accent==="purple"?"chosen":""} onClick={()=>onChange({...data,accent:"purple"})}><span className="theme-preview purple-preview"><i/><i/><i/></span><b>Purple</b></button><button className={data.accent==="blue"?"chosen":""} onClick={()=>onChange({...data,accent:"blue"})}><span className="theme-preview blue-preview"><i/><i/><i/></span><b>Blue</b></button></div></div></section></div><section className="setting-block scale-block"><div className="scale-title"><strong>Interface size</strong><b>{displayedScale}%</b></div><div className={`scale-control ${dragging?"dragging":""}`} style={{"--scale-fill":scalePosition*25} as CSSProperties}><input aria-label="Interface size" type="range" min="0" max="4" step="0.01" value={scalePosition} onPointerDown={()=>{dragStart.current=scalePosition;setDragging(true)}} onChange={e=>setScalePosition(Number(e.target.value))} onPointerUp={commitScale} onPointerCancel={commitScale} onKeyDown={()=>{dragStart.current=scalePosition}} onKeyUp={commitScale}/><div className="scale-dots">{points.map((_point,i)=><i className={i<=scalePosition?"filled":""} key={i}/>)}</div></div></section></div></div></section>}

function LessonHead({title,subtitle,stage,onClose}:{title:string;subtitle:string;stage:1|2|3;onClose:()=>void}){return <><header className="lesson-stage-head"><button className="icon-btn large" aria-label="Back" onClick={onClose}><ArrowLeft/></button><div className="lesson-stages">{[[1,"New words"],[2,"Training"],[3,"Review"]].map(([number,label])=><span className={number===stage?"active":""} key={number}>{number} <b>{label}</b></span>)}</div></header><div className="lesson-title"><h1>{title}</h1><p>{subtitle}</p></div></>}

const languageProfiles=[
  {names:["german","deutsch","немец","німець"],code:"de",keys:["ä","ö","ü","ß"]},
  {names:["spanish","español","испан","іспан"],code:"es",keys:["á","é","í","ó","ú","ü","ñ","¿","¡"]},
  {names:["french","français","француз","франц"],code:"fr",keys:["à","â","æ","ç","é","è","ê","ë","î","ï","ô","œ","ù","û","ü","ÿ"]},
  {names:["ukrainian","україн","украин"],code:"uk",keys:["й","ц","у","к","е","н","г","ш","щ","з","х","ї","ф","і","в","а","п","р","о","л","д","ж","є","я","ч","с","м","и","т","ь","б","ю","ґ"]},
  {names:["russian","русск","росій"],code:"ru",keys:["ё","й","ц","у","к","е","н","г","ш","щ","з","х","ъ","ф","ы","в","а","п","р","о","л","д","ж","э","я","ч","с","м","и","т","ь","б","ю"]},
  {names:["polish","polski","польск","польсь"],code:"pl",keys:["ą","ć","ę","ł","ń","ó","ś","ź","ż"]},
  {names:["portuguese","português","португал"],code:"pt",keys:["á","â","ã","à","ç","é","ê","í","ó","ô","õ","ú"]},
  {names:["turkish","türk","турец","турець"],code:"tr",keys:["ç","ğ","ı","İ","ö","ş","ü"]},
  {names:["czech","češt","чеш"],code:"cs",keys:["á","č","ď","é","ě","í","ň","ó","ř","š","ť","ú","ů","ý","ž"]},
  {names:["romanian","român","румын","румун"],code:"ro",keys:["ă","â","î","ș","ț"]},
  {names:["swedish","svenska","швед"],code:"sv",keys:["å","ä","ö"]},
  {names:["norwegian","norsk","норвеж"],code:"no",keys:["æ","ø","å"]},
  {names:["danish","dansk","датск","дансь"],code:"da",keys:["æ","ø","å"]},
  {names:["italian","italiano","итальян","італій"],code:"it",keys:["à","è","é","ì","ò","ù"]},
  {names:["english","англий","англій"],code:"en",keys:[]}
];

function languageProfile(language:string){const name=language.toLocaleLowerCase();return languageProfiles.find(profile=>profile.names.some(alias=>name.includes(alias)))||{code:"und",keys:[]}}
function speakText(text:string,language:string){if(typeof window==="undefined"||!("speechSynthesis" in window))return;const speech=new SpeechSynthesisUtterance(text),code=languageProfile(language).code;speech.lang=code;const voice=window.speechSynthesis.getVoices().find(item=>item.lang.toLocaleLowerCase().startsWith(code));if(voice)speech.voice=voice;window.speechSynthesis.cancel();window.speechSynthesis.speak(speech)}
const choiceTask=(type:TaskType)=>["choice","reverseChoice","fillBlank","heardChoice","synonymChoice"].includes(type);

function MeaningWord({word,side,targetLanguage}:{word:Word;side:"target"|"native";targetLanguage:string}){
  const [open,setOpen]=useState(false),container=useRef<HTMLSpanElement>(null),label=side==="target"?word.target:word.native;
  useEffect(()=>{const close=(event:PointerEvent)=>{if(!container.current?.contains(event.target as Node))setOpen(false)};document.addEventListener("pointerdown",close);return()=>document.removeEventListener("pointerdown",close)},[]);
  return <span className="meaning-word" ref={container}><button type="button" className="meaning-trigger" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><span>{label}</span><Lightbulb/></button>{open&&<span className="meaning-popover" role="dialog"><span className="meaning-head"><b>{word.target}</b><button type="button" aria-label="Play pronunciation" onClick={()=>speakText(targetForm(word),targetLanguage)}><Volume2/></button></span><strong>{word.native}</strong>{word.partOfSpeech&&<small>{word.partOfSpeech}</small>}{word.synonyms.length>0&&<span><b>Synonyms:</b> {word.synonyms.join(", ")}</span>}{word.exampleTarget&&<span className="meaning-example">{word.exampleTarget}<small>{word.exampleNative}</small></span>}</span>}</span>
}

function AnswerInput({value,onChange,onSubmit,language,disabled,placeholder="Type your answer"}:{value:string;onChange:(value:string)=>void;onSubmit:()=>void;language:string;disabled:boolean;placeholder?:string}){
  const input=useRef<HTMLInputElement>(null),profile=languageProfile(language);
  useEffect(()=>{const timer=window.setTimeout(()=>input.current?.focus({preventScroll:true}),45);return()=>window.clearTimeout(timer)},[]);
  const insert=(key:string)=>{const element=input.current,start=element?.selectionStart??value.length,end=element?.selectionEnd??value.length,next=value.slice(0,start)+key+value.slice(end);onChange(next);requestAnimationFrame(()=>{element?.focus();element?.setSelectionRange(start+key.length,start+key.length)})};
  return <div className="answer-area"><input ref={input} autoFocus className="answer" lang={profile.code} inputMode="text" enterKeyHint="done" autoCapitalize="none" spellCheck={false} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)} onKeyDown={event=>{if(event.key==="Enter")onSubmit()}} placeholder={placeholder} autoComplete="off"/><div className="keyboard-language"><span>{language}</span><small>keyboard</small></div>{profile.keys.length>0&&<div className={`language-keys ${profile.keys.length>18?"full-alphabet":""}`} aria-label={`${language} letters`}>{profile.keys.map((key,index)=><button type="button" disabled={disabled} onMouseDown={event=>event.preventDefault()} onClick={()=>insert(key)} key={`${key}-${index}`}>{key}</button>)}</div>}</div>
}

function Lesson({course,number,onSave,onClose}:{course:Course,number:number,onSave:(course:Course)=>void,onClose:()=>void}){
  const [session]=useState(()=>lessonSession(course,number));
  const [phase,setPhase]=useState<"intro"|"tasks"|"done">(session.intro.length?"intro":"tasks"),[index,setIndex]=useState(0),[answer,setAnswer]=useState(""),[feedback,setFeedback]=useState<{ok:boolean;text:string}|null>(null),[busy,setBusy]=useState(false),[paired,setPaired]=useState<Record<string,string>>({});
  const started=useRef(0),intro=session.intro[index],task=session.tasks[index];
  useEffect(()=>{started.current=Date.now()},[]);
  const update=(ok:boolean)=>{if(!task)return;const next=structuredClone(course);const previous=next.progress.stats[task.word.id]||{seen:0,correct:0,wrong:0,mastery:0,averageMs:0,nextDue:new Date().toISOString()};const ms=Date.now()-started.current;previous.seen++;previous.correct+=ok?1:0;previous.wrong+=ok?0:1;previous.averageMs=previous.averageMs?Math.round(previous.averageMs*.75+ms*.25):ms;previous.mastery=Math.max(0,Math.min(1,previous.mastery+(ok?(ms<8000?.2:.16):-.23)));previous.lastSeen=new Date().toISOString();previous.nextDue=new Date(Date.now()+(ok?(previous.mastery>.65?3:1)*86400000:4*3600000)).toISOString();next.progress.stats[task.word.id]=previous;onSave(next)};
  const submit=async(value=answer)=>{
    if(!task||feedback||busy)return;
    if(task.type!=="match"&&!value.trim())return;
    setBusy(true);
    let ok=task.type==="match"?!!task.pairs?.every(word=>paired[word.id]===word.native):matches(value,task.accepted),corrected=task.answer;
    const typed=["write","toNative","toTarget","wordBank","listen","speak"].includes(task.type);
    if(!ok&&typed){try{const result=await ai({action:"judge",targetLanguage:course.targetLanguage,nativeLanguage:course.nativeLanguage,word:task.word,answer:value,expected:task.accepted});ok=!!result.correct;corrected=result.corrected||corrected}catch{}}
    update(ok);setFeedback({ok,text:ok?"Correct":`Correct answer: ${corrected}`});setBusy(false);
  };
  const next=()=>{setAnswer("");setFeedback(null);setPaired({});started.current=Date.now();if(index+1<session.tasks.length)setIndex(index+1);else{const nextCourse=structuredClone(course);nextCourse.progress.completedLessons=Array.from(new Set([...nextCourse.progress.completedLessons,number]));nextCourse.progress.currentLesson=Math.max(nextCourse.progress.currentLesson,number+1);onSave(nextCourse);setPhase("done")}};
  const lessonTitle=course.lessonTitles[number]||`Lesson ${number}`;
  if(phase==="done")return <section className="full-page lesson-page"><div className="lesson-shell"><LessonHead title="Lesson complete" subtitle={`Correct answers are saved. ${session.tasks.length} tasks completed.`} stage={3} onClose={onClose}/><div className="lesson-result-card good"><Check/><div><h2>Great work</h2><p>Difficult words will return automatically when you need them.</p></div></div><button className="primary" onClick={onClose}>Back to path</button></div></section>;
  if(phase==="intro"&&intro)return <section className="full-page lesson-page"><div className="lesson-shell"><LessonHead title={`New word ${index+1}/${session.intro.length}`} subtitle={`${lessonTitle}: learn it first, then practise it.`} stage={1} onClose={onClose}/><article className="lesson-word-card"><span/><div className="intro-word-line"><MeaningWord word={intro} side="target" targetLanguage={course.targetLanguage}/><button className="sound-button" aria-label="Play pronunciation" onClick={()=>speakText(targetForm(intro),course.targetLanguage)}><Volume2/></button></div><h2>{intro.native}</h2>{intro.partOfSpeech&&<p className="part">{intro.partOfSpeech}</p>}<p><b>Synonyms:</b> {intro.synonyms.join(", ")||"none"}</p>{intro.exampleTarget&&<blockquote>{intro.exampleTarget}<small>{intro.exampleNative}</small></blockquote>}</article><button className="primary" onClick={()=>{if(index+1<session.intro.length)setIndex(index+1);else{setIndex(0);setPhase("tasks")}}}>{index+1>=session.intro.length?"Start practice":"Next word"}<ChevronRight/></button></div></section>;
  if(!task)return <section className="full-page complete"><h1>No words here yet</h1><button className="primary" onClick={onClose}>Back</button></section>;
  const training=session.intro.some(word=>word.id===task.word.id),stage=training?2:3,mastery=Math.round((course.progress.stats[task.word.id]?.mastery||0)*100),canCheck=task.type==="match"?Object.keys(paired).length===(task.pairs?.length||0):!!answer.trim();
  return <section className="full-page lesson-page"><div className="lesson-shell"><LessonHead title={`${training?"Practice new words":"Review"}: ${index+1}/${session.tasks.length}`} subtitle={`${course.lessonTitles[task.word.lesson]||`Lesson ${task.word.lesson}`} | level: ${task.word.level} | mastery: ${mastery}%`} stage={stage} onClose={onClose}/><div className={`task task-${task.type}`} data-task-type={task.type}><TaskView key={`${index}-${task.type}`} task={task} answer={answer} setAnswer={setAnswer} paired={paired} setPaired={setPaired} submit={submit} disabled={!!feedback} targetLanguage={course.targetLanguage} nativeLanguage={course.nativeLanguage}/>{busy&&<span className="spinner task-spinner"/>}{feedback&&<div className={`feedback ${feedback.ok?"good":"bad"}`}>{feedback.ok?<Check/>:<X/>}<strong>{feedback.text}</strong></div>}</div>{feedback?<button className="primary" onClick={next}>Next<ChevronRight/></button>:!choiceTask(task.type)&&<button className="primary" disabled={busy||!canCheck} onClick={()=>submit()}>Check answer</button>}</div></section>
}

function TaskView({task,answer,setAnswer,paired,setPaired,submit,disabled,targetLanguage,nativeLanguage}:{task:Task;answer:string;setAnswer:(value:string)=>void;paired:Record<string,string>;setPaired:(value:Record<string,string>)=>void;submit:(value?:string)=>void;disabled:boolean;targetLanguage:string;nativeLanguage:string}){
  const [picked,setPicked]=useState<number[]>([]),[listening,setListening]=useState(false),[speechError,setSpeechError]=useState("");
  useEffect(()=>{if(task.type!=="listen"&&task.type!=="heardChoice")return;const timer=window.setTimeout(()=>speakText(targetForm(task.word),targetLanguage),180);return()=>window.clearTimeout(timer)},[task,targetLanguage]);
  const chooseTile=(tileIndex:number)=>{if(disabled||picked.includes(tileIndex))return;const next=[...picked,tileIndex];setPicked(next);setAnswer(next.map(index=>task.tiles?.[index]||"").join(" "))};
  const removeTile=(position:number)=>{if(disabled)return;const next=picked.filter((_value,index)=>index!==position);setPicked(next);setAnswer(next.map(index=>task.tiles?.[index]||"").join(" "))};
  const startSpeaking=()=>{
    const speechWindow=window as typeof window&{SpeechRecognition?:SpeechRecognitionConstructor;webkitSpeechRecognition?:SpeechRecognitionConstructor},Recognition=speechWindow.SpeechRecognition||speechWindow.webkitSpeechRecognition;
    if(!Recognition){setSpeechError("Speech recognition is not available in this browser. Type what you said below.");return}
    const recognition=new Recognition();recognition.lang=languageProfile(targetLanguage).code;recognition.interimResults=false;recognition.maxAlternatives=1;recognition.onstart=()=>{setSpeechError("");setListening(true)};recognition.onend=()=>setListening(false);recognition.onerror=()=>{setListening(false);setSpeechError("I could not hear that. Try again or type the word.")};recognition.onresult=(event:SpeechResultEvent)=>setAnswer(event.results?.[0]?.[0]?.transcript||"");recognition.start();
  };
  if(task.type==="choice"||task.type==="reverseChoice")return <><p className="prompt">{task.type==="choice"?"Choose the correct translation":"Choose the word in the language you are learning"}</p><h1><MeaningWord word={task.word} side={task.type==="choice"?"target":"native"} targetLanguage={targetLanguage}/></h1><div className="options">{task.options?.map(option=><button disabled={disabled} key={option} onClick={()=>submit(option)}><span>{option}</span><ChevronRight/></button>)}</div></>;
  if(task.type==="match")return <><p className="prompt">Match each word with its translation</p><div className="matches">{task.pairs?.map(word=><div key={word.id}><MeaningWord word={word} side="target" targetLanguage={targetLanguage}/><div>{task.pairs?.map(option=><button disabled={disabled} className={paired[word.id]===option.native?"selected":""} onClick={()=>setPaired({...paired,[word.id]:option.native})} key={option.id}>{option.native}</button>)}</div></div>)}</div></>;
  if(task.type==="wordBank")return <><p className="prompt">Build the translation</p><h1><MeaningWord word={task.word} side="native" targetLanguage={targetLanguage}/></h1>{task.phrase&&<p className="sentence-prompt">{task.phrase}</p>}<div className="word-bank-answer">{picked.length?picked.map((tileIndex,position)=><button type="button" disabled={disabled} onClick={()=>removeTile(position)} key={`${tileIndex}-${position}`}>{task.tiles?.[tileIndex]}</button>):<span>Choose words below</span>}</div><div className="word-bank">{task.tiles?.map((tile,tileIndex)=><button type="button" disabled={disabled||picked.includes(tileIndex)} onClick={()=>chooseTile(tileIndex)} key={`${tile}-${tileIndex}`}>{tile}</button>)}</div>{picked.length>0&&<button type="button" className="undo-answer" onClick={()=>removeTile(picked.length-1)}><Undo2/>Undo last</button>}</>;
  if(task.type==="fillBlank")return <><p className="prompt">Choose the missing word</p><div className="cloze-sentence">{task.cloze}</div><button className="hint-link" type="button" onClick={()=>speakText(task.word.exampleTarget||targetForm(task.word),targetLanguage)}><Volume2/>Hear the sentence</button><div className="options compact">{task.options?.map(option=><button disabled={disabled} key={option} onClick={()=>submit(option)}><span>{option}</span><ChevronRight/></button>)}</div></>;
  if(task.type==="heardChoice")return <><p className="prompt">Which word do you hear?</p><button className="listen-button" type="button" onClick={()=>speakText(targetForm(task.word),targetLanguage)}><Volume2/><span>Play again</span></button><div className="options compact">{task.options?.map(option=><button disabled={disabled} key={option} onClick={()=>submit(option)}><span>{option}</span><ChevronRight/></button>)}</div></>;
  if(task.type==="synonymChoice")return <><p className="prompt">Choose a synonym</p><h1><MeaningWord word={task.word} side="target" targetLanguage={targetLanguage}/></h1><div className="options compact">{task.options?.map(option=><button disabled={disabled} key={option} onClick={()=>submit(option)}><span>{option}</span><ChevronRight/></button>)}</div></>;
  if(task.type==="listen")return <><p className="prompt">Listen and type what you hear</p><button className="listen-button" type="button" onClick={()=>speakText(targetForm(task.word),targetLanguage)}><Volume2/><span>Play word</span></button><AnswerInput value={answer} onChange={setAnswer} onSubmit={()=>submit()} language={targetLanguage} disabled={disabled}/></>;
  if(task.type==="speak")return <><p className="prompt">Say this word</p><h1><MeaningWord word={task.word} side="target" targetLanguage={targetLanguage}/></h1><div className="speak-controls"><button className={`mic-button ${listening?"listening":""}`} type="button" disabled={disabled||listening} onClick={startSpeaking}><Mic/><span>{listening?"Listening...":"Tap to speak"}</span></button><button className="sound-button" type="button" aria-label="Hear pronunciation" onClick={()=>speakText(targetForm(task.word),targetLanguage)}><Volume2/></button></div>{speechError&&<p className="speech-error">{speechError}</p>}<AnswerInput value={answer} onChange={setAnswer} onSubmit={()=>submit()} language={targetLanguage} disabled={disabled} placeholder="What did you say?"/></>;
  const toNative=task.type==="toNative",prompt=toNative?"Translate into your language":task.type==="write"?"Write the word":"Translate into the language you are learning",language=toNative?nativeLanguage:targetLanguage;
  return <><p className="prompt">{prompt}</p><h1><MeaningWord word={task.word} side={toNative?"target":"native"} targetLanguage={targetLanguage}/></h1><AnswerInput value={answer} onChange={setAnswer} onSubmit={()=>submit()} language={language} disabled={disabled}/></>;
}
