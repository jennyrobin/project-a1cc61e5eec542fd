"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BarChart3, BookOpen, Check, ChevronDown, ChevronRight, Download, Moon, Play, Plus, Search, Settings, Sun, Trash2, X } from "lucide-react";

type Level = "easy" | "normal" | "hard" | "expert";
type Word = { id:string; target:string; native:string; level:Level; lesson:number; partOfSpeech:string; synonyms:string[]; exampleTarget:string; exampleNative:string };
type Stat = { seen:number; correct:number; wrong:number; mastery:number; averageMs:number; lastSeen?:string; nextDue:string };
type Course = { id:string; name:string; targetLanguage:string; nativeLanguage:string; topic:string; words:Word[]; lessonTitles:Record<string,string>; progress:{ currentLesson:number; completedLessons:number[]; stats:Record<string,Stat>; lastExtendedLesson?:number } };
type Data = { courses:Course[]; activeCourseId?:string; theme:"light"|"dark"; accent:"purple"|"blue" };
type Screen = "home"|"words"|"stats"|"settings"|"create"|"lesson";
type Task = { type:"choice"|"write"|"toNative"|"toTarget"|"match"; word:Word; options?:string[]; pairs?:Word[] };

const STORE = "wordway-web-v1";
const AI_URL = (globalThis as typeof globalThis & { WORDWAY_API_URL?:string }).WORDWAY_API_URL || "/api/ai";
const empty:Data = { courses:[], theme:"dark", accent:"purple" };
const shuffle = <T,>(a:T[]) => [...a].sort(() => Math.random() - .5);
const normalize = (s:string) => s.trim().toLocaleLowerCase().replace(/[.,!?;:()\[\]{}"']/g, "").replace(/\s+/g," ");
const matches = (answer:string, values:string[]) => values.some(v => v.split(/[,;/|]/).map(normalize).includes(normalize(answer)));
const maxLesson = (c:Course) => Math.max(1, ...c.words.map(w => w.lesson));

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
  const intro = shuffle(unseen).slice(0, Math.min(5, Math.max(2, unseen.length)));
  const training = shuffle([...intro, ...due, ...own]).filter((w,i,a) => a.findIndex(x => x.id === w.id) === i).slice(0,10);
  const pool = course.words.filter(w => w.lesson <= lesson);
  const kinds:Task["type"][] = ["choice","write","toNative","toTarget","match"];
  const tasks = training.map((word,i):Task => {
    const type = kinds[i % kinds.length];
    if (type === "choice") return { type, word, options:shuffle([word.native, ...shuffle(pool.filter(x=>x.id!==word.id)).slice(0,3).map(x=>x.native)]) };
    if (type === "match") return { type, word, pairs:shuffle([word,...shuffle(pool.filter(x=>x.id!==word.id)).slice(0,2)]) };
    return { type, word };
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
  const active = data.courses.find(c=>c.id===data.activeCourseId) ?? data.courses[0];
  useEffect(()=>{ try { const raw=localStorage.getItem(STORE); if(raw) setData({...empty,...JSON.parse(raw)}); } finally { setReady(true); } },[]);
  useEffect(()=>{ if(ready) localStorage.setItem(STORE,JSON.stringify(data)); },[data,ready]);
  useEffect(()=>{ if(ready && !active) setScreen("create"); },[ready,active]);
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
  const openLesson=(n:number)=>{if(active)void extendCourse(active,n);setLesson(n);setScreen("lesson")};
  return <main className={`app ${data.theme} ${data.accent}`}>
    {screen === "create" ? <CreateCourse canBack={!!active} onBack={()=>setScreen("home")} onCreated={c=>{setData(d=>({...d,courses:[...d.courses,c],activeCourseId:c.id}));setScreen("home")}}/> :
     screen === "lesson" && active ? <Lesson course={active} number={lesson} onSave={saveCourse} onClose={()=>setScreen("home")}/> : <>
      <header className="topbar">
        <div className="top-spacer">{screen!=="home"&&<button className="icon-btn large" aria-label="Back" onClick={()=>setScreen("home")}><ArrowLeft/></button>}</div>
        <button className="course-trigger" onClick={()=>setMenu(!menu)}>{active?.name || "Choose a course"}<ChevronDown size={19}/></button>
        <button className="icon-btn large" aria-label="Settings" onClick={()=>setScreen("settings")}><Settings/></button>
      </header>
      {screen === "home" && active && <Home course={active} onLesson={openLesson} extending={extending}/>} 
      {screen === "words" && active && <Words course={active}/>} 
      {screen === "stats" && active && <Stats course={active}/>} 
      {screen === "settings" && <SettingsPage data={data} course={active} onChange={setData} onBack={()=>setScreen("home")} onWords={()=>setScreen("words")} onStats={()=>setScreen("stats")}/>} 
    </>}
    {menu && <CourseMenu data={data} onClose={()=>setMenu(false)} onSelect={id=>{setData(d=>({...d,activeCourseId:id}));setMenu(false);setScreen("home")}} onCreate={()=>{setMenu(false);setScreen("create")}} onDelete={course=>{if(confirm(`Delete “${course.name}” and all its progress?`)){setData(d=>{const courses=d.courses.filter(c=>c.id!==course.id);return {...d,courses,activeCourseId:courses[0]?.id}});setMenu(false)}}}/>} 
  </main>;
}

function Home({course,onLesson,extending}:{course:Course,onLesson:(n:number)=>void;extending:boolean}) {
  const total=maxLesson(course), current=Math.min(course.progress.currentLesson,total);
  const stats=Object.values(course.progress.stats), seen=stats.filter(s=>s.seen).length, mastered=stats.filter(s=>s.mastery>=.86&&s.correct>=3).length;
  const answers=stats.reduce((a,s)=>a+s.seen,0), correct=stats.reduce((a,s)=>a+s.correct,0);
  const pathRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{ pathRef.current?.querySelector(".current")?.scrollIntoView({behavior:"smooth",inline:"center",block:"nearest"}); },[current]);
  return <section className="page home-page">
    <div className="heading"><h1>Your path</h1><p>{course.targetLanguage} <span>→</span> {course.nativeLanguage} <b>·</b> {course.topic}</p></div>
    <section className="next-lesson"><div><span className="kicker">NEXT LESSON · {current} OF {total}</span><h2>{course.lessonTitles[current] || `Lesson ${current}`}</h2><p>Learn new words, practise them, and revisit difficult ones.</p><button className="primary" onClick={()=>onLesson(current)}><Play size={18} fill="currentColor"/>Start lesson</button></div><div className="ring"><strong>{Math.round(seen/course.words.length*100)||0}%</strong><span>explored</span></div></section>
    <div className="metrics"><Metric tone="blue" label="Words seen" value={`${seen}/${course.words.length}`}/><Metric tone="green" label="Mastered" value={String(mastered)}/><Metric tone="orange" label="Accuracy" value={`${answers?Math.round(correct/answers*100):0}%`}/></div>
    <div className="section-title"><div><span className="kicker">YOUR JOURNEY</span><h2>Lessons</h2></div><span>{extending?"Adding 20 new words...":"Drag or scroll to explore"}</span></div>
    <div className="road-wrap" ref={pathRef}>{Array.from({length:total},(_,i)=>i+1).map((n,i)=>{const done=course.progress.completedLessons.includes(n), locked=n>course.progress.currentLesson;return <div className={`road-step ${i%2?"low":"high"}`} key={n}><button disabled={locked} className={`lesson-node ${done?"done":""} ${n===current?"current":""}`} onClick={()=>onLesson(n)}>{done?<Check/>:n}</button><strong>Lesson {n}</strong><span>{course.lessonTitles[n]||"New words"}</span></div>})}</div>
  </section>;
}
function Metric({label,value,tone="accent"}:{label:string,value:string,tone?:string}){return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>}

function CreateCourse({canBack,onBack,onCreated}:{canBack:boolean,onBack:()=>void,onCreated:(c:Course)=>void}){
  const [target,setTarget]=useState(""),[native,setNative]=useState(""),[topic,setTopic]=useState(""),[busy,setBusy]=useState(false),[status,setStatus]=useState(""),[error,setError]=useState("");
  const create=async()=>{if(!target.trim()||!native.trim()||!topic.trim()){setError("Complete all three fields.");return} setBusy(true);setError("");
    try{setStatus("Creating 20 words...");const r=await aiWithRetry({action:"generate",targetLanguage:target,nativeLanguage:native,topic,offset:0,existing:[]},seconds=>setStatus(`Groq is busy. Continuing automatically in ${seconds} seconds...`));const words:Word[]=r.words;setStatus("Naming 4 lessons...");const t=await aiWithRetry({action:"titles",targetLanguage:target,nativeLanguage:native,topic,words},seconds=>setStatus(`Waiting ${seconds} seconds before naming lessons...`));const course:Course={id:crypto.randomUUID(),name:`${target} · ${topic}`,targetLanguage:target,nativeLanguage:native,topic,words,lessonTitles:t.titles||{},progress:{currentLesson:1,completedLessons:[],stats:{}}};onCreated(course)}catch(e){const error=e as Error & {status?:number};setError(error.status===429?"Groq's usage limit is exhausted. Try creating the course again after the limit resets.":error.message||"Could not create course") }finally{setBusy(false)}};
  return <section className="full-page create-page">{canBack&&<button className="back icon-btn large" onClick={onBack}><ArrowLeft/></button>}<div className="form-panel"><span className="brand-mark">W</span><p className="kicker">A NEW JOURNEY</p><h1>Create a course</h1><p>Choose what you want to learn. AI will prepare the first 20 words and add more as you progress.</p><label>Language to learn<input value={target} onChange={e=>setTarget(e.target.value)} placeholder="For example, German"/></label><label>Your native language<input value={native} onChange={e=>setNative(e.target.value)} placeholder="For example, English"/></label><label>Topic<input value={topic} onChange={e=>setTopic(e.target.value)} placeholder="Engineering, school, travel..."/></label>{error&&<div className="error">{error}</div>}{busy?<div className="status"><span className="spinner"/>{status}</div>:<button className="primary wide" onClick={create}>Create course<ChevronRight/></button>}</div></section>
}

function CourseMenu({data,onClose,onSelect,onCreate,onDelete}:{data:Data,onClose:()=>void,onSelect:(id:string)=>void,onCreate:()=>void,onDelete:(c:Course)=>void}){return <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section className="course-menu"><div className="modal-head"><div><span className="kicker">SWITCH SPACE</span><h2>Your courses</h2></div><button className="icon-btn" onClick={onClose}><X/></button></div><div className="course-list">{data.courses.map(c=><div className="course-row" key={c.id}><button onClick={()=>onSelect(c.id)}><span className="course-letter">{c.targetLanguage[0]?.toUpperCase()}</span><span><strong>{c.name}</strong><small>{c.words.length} words · {c.targetLanguage}</small></span>{c.id===data.activeCourseId&&<Check className="selected"/>}</button><button className="trash" aria-label="Delete course" onClick={()=>onDelete(c)}><Trash2/></button></div>)}</div><button className="secondary wide" onClick={onCreate}><Plus/>New course</button></section></div>}

function Words({course}:{course:Course}){const [query,setQuery]=useState("");const words=course.words.filter(w=>`${w.target} ${w.native}`.toLowerCase().includes(query.toLowerCase()));return <section className="page words-page"><div className="heading"><p>COURSE LIBRARY</p><h1>All words</h1></div><div className="search"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search words or translations"/></div><div className="word-grid">{words.map(w=>{const s=course.progress.stats[w.id];return <article className="word-card" key={w.id}><div><span className={`level ${w.level}`}>{w.level}</span><small>Lesson {w.lesson}</small></div><h3>{w.target}</h3><h4>{w.native}</h4>{w.synonyms.length>0&&<p><b>Synonyms:</b> {w.synonyms.join(", ")}</p>}<p>{w.exampleTarget}</p><div className="mastery"><span style={{width:`${(s?.mastery||0)*100}%`}}/></div></article>})}</div></section>}

function Stats({course}:{course:Course}){const all=Object.values(course.progress.stats),seen=all.filter(s=>s.seen>0).length,mastered=all.filter(s=>s.mastery>=.86&&s.correct>=3).length,answers=all.reduce((n,s)=>n+s.seen,0),correct=all.reduce((n,s)=>n+s.correct,0),weak=course.words.filter(w=>{const s=course.progress.stats[w.id];return s?.seen&&(s.mastery<.55||s.wrong>s.correct)}).slice(0,8);return <section className="page stats-page"><div className="heading"><h1>Statistics</h1><p>{course.name}</p></div><div className="metrics stats-metrics"><Metric tone="blue" label="Words seen" value={`${seen}/${course.words.length}`}/><Metric tone="green" label="Mastered" value={String(mastered)}/><Metric tone="orange" label="Accuracy" value={`${answers?Math.round(correct/answers*100):0}%`}/></div><section className="desktop-panel"><span className="kicker">NEEDS PRACTICE</span><h2>Difficult words</h2>{weak.length?weak.map(w=><div className="weak-row" key={w.id}><span><strong>{w.target}</strong><small>{w.native}</small></span><b>{Math.round((course.progress.stats[w.id]?.mastery||0)*100)}%</b></div>):<p className="empty-copy">Difficult words will appear here after a few lessons.</p>}</section></section>}

function SettingsPage({data,course,onChange,onBack,onWords,onStats}:{data:Data,course?:Course,onChange:(d:Data)=>void,onBack:()=>void,onWords:()=>void;onStats:()=>void}){
  const exportCsv=()=>{if(!course)return;const q=(v:unknown)=>`"${String(v??"").replace(/"/g,'""')}"`;const rows=[["word","translation","level","lesson","synonyms"],...course.words.map(w=>[w.target,w.native,w.level,w.lesson,w.synonyms.join("; ")])];const blob=new Blob(["\ufeff"+rows.map(r=>r.map(q).join(",")).join("\n")],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`${course.name}-words.csv`;a.click();URL.revokeObjectURL(a.href)};
  return <section className="full-page settings-page"><div className="settings-shell"><div className="settings-head"><button className="icon-btn large" onClick={onBack}><ArrowLeft/></button><div><span className="kicker">PERSONALISE</span><h1>Settings</h1></div></div><div className="settings-stack"><section className="setting-block"><h2>Course</h2><button className="setting-row" onClick={onWords}><BookOpen/><span><strong>All words</strong><small>Browse the complete course vocabulary</small></span><ChevronRight/></button><button className="setting-row" onClick={onStats}><BarChart3/><span><strong>Statistics</strong><small>See progress and difficult words</small></span><ChevronRight/></button><button className="setting-row" onClick={exportCsv}><Download/><span><strong>Export CSV</strong><small>Save {course?.words.length||0} words to your device</small></span><ChevronRight/></button></section><section className="setting-block"><h2>Appearance</h2><div className="theme-options"><button className={data.theme==="light"?"chosen":""} onClick={()=>onChange({...data,theme:"light"})}><Sun/>Light</button><button className={data.theme==="dark"?"chosen":""} onClick={()=>onChange({...data,theme:"dark"})}><Moon/>Dark</button></div>{data.theme==="dark"&&<div className="accent-options"><button className={data.accent==="purple"?"chosen":""} onClick={()=>onChange({...data,accent:"purple"})}><i className="swatch purple-swatch"/>Purple</button><button className={data.accent==="blue"?"chosen":""} onClick={()=>onChange({...data,accent:"blue"})}><i className="swatch blue-swatch"/>Blue</button></div>}</section></div></div></section>}

function Lesson({course,number,onSave,onClose}:{course:Course,number:number,onSave:(c:Course)=>void,onClose:()=>void}){
  const session=useMemo(()=>lessonSession(course,number),[course.id,number]);const [phase,setPhase]=useState<"intro"|"tasks"|"done">(session.intro.length?"intro":"tasks"),[index,setIndex]=useState(0),[answer,setAnswer]=useState(""),[feedback,setFeedback]=useState<{ok:boolean;text:string}|null>(null),[busy,setBusy]=useState(false),[paired,setPaired]=useState<Record<string,string>>({});const started=useRef(Date.now());const intro=session.intro[index],task=session.tasks[index];
  const update=(ok:boolean)=>{if(!task)return;const next=structuredClone(course);const prev=next.progress.stats[task.word.id]||{seen:0,correct:0,wrong:0,mastery:0,averageMs:0,nextDue:new Date().toISOString()};const ms=Date.now()-started.current;prev.seen++;prev.correct+=ok?1:0;prev.wrong+=ok?0:1;prev.averageMs=prev.averageMs?Math.round(prev.averageMs*.75+ms*.25):ms;prev.mastery=Math.max(0,Math.min(1,prev.mastery+(ok?(ms<8000?.2:.16):-.23)));prev.lastSeen=new Date().toISOString();prev.nextDue=new Date(Date.now()+(ok?(prev.mastery>.65?3:1)*86400000:4*3600000)).toISOString();next.progress.stats[task.word.id]=prev;onSave(next)};
  const submit=async(value=answer)=>{if(!task||feedback||busy)return;setBusy(true);let expected=[task.word.native],ok=false,corrected=task.word.native;if(task.type==="choice"||task.type==="toNative")ok=matches(value,expected);else if(task.type==="match")ok=!!task.pairs?.every(w=>paired[w.id]===w.native);else{expected=[task.word.target];corrected=task.word.target;ok=matches(value,[task.word.target,...task.word.synonyms]);if(!ok){try{const r=await ai({action:"judge",targetLanguage:course.targetLanguage,nativeLanguage:course.nativeLanguage,word:task.word,answer:value,expected});ok=!!r.correct;corrected=r.corrected||corrected}catch{}}}update(ok);setFeedback({ok,text:ok?"Correct":`Correct answer: ${corrected}`});setBusy(false)};
  const next=()=>{setAnswer("");setFeedback(null);setPaired({});started.current=Date.now();if(index+1<session.tasks.length)setIndex(index+1);else{const next=structuredClone(course);next.progress.completedLessons=Array.from(new Set([...next.progress.completedLessons,number]));next.progress.currentLesson=Math.max(next.progress.currentLesson,number+1);onSave(next);setPhase("done")}};
  if(phase==="done")return <section className="full-page lesson-page complete"><div className="done-mark"><Check/></div><h1>Lesson complete</h1><p>Your progress is saved. Difficult words will return when you need them.</p><button className="primary" onClick={onClose}>Back to path</button></section>;
  if(phase==="intro"&&intro)return <section className="full-page lesson-page"><LessonHead title={`New word ${index+1} of ${session.intro.length}`} progress={(index+1)/session.intro.length*.35} onClose={onClose}/><div className="intro-word"><span className="level easy">NEW WORD</span><h1>{intro.target}</h1><h2>{intro.native}</h2>{intro.partOfSpeech&&<p className="part">{intro.partOfSpeech}</p>}{intro.synonyms.length>0&&<p><b>Synonyms:</b> {intro.synonyms.join(", ")}</p>}<blockquote>{intro.exampleTarget}<small>{intro.exampleNative}</small></blockquote></div><button className="primary lesson-action" onClick={()=>{if(index+1<session.intro.length)setIndex(index+1);else{setIndex(0);setPhase("tasks")}}}>Continue<ChevronRight/></button></section>;
  if(!task)return <section className="full-page complete"><h1>No words here yet</h1><button className="primary" onClick={onClose}>Back</button></section>;
  return <section className="full-page lesson-page"><LessonHead title={`Practice ${index+1} of ${session.tasks.length}`} progress={.35+(index+1)/session.tasks.length*.65} onClose={onClose}/><div className="task"><TaskView task={task} answer={answer} setAnswer={setAnswer} paired={paired} setPaired={setPaired} submit={submit} disabled={!!feedback}/>{busy&&<span className="spinner"/>}{feedback&&<div className={`feedback ${feedback.ok?"good":"bad"}`}>{feedback.ok?<Check/>:<X/>}<strong>{feedback.text}</strong></div>}</div>{feedback?<button className="primary lesson-action" onClick={next}>Continue<ChevronRight/></button>:task.type!=="choice"&&<button className="primary lesson-action" disabled={busy} onClick={()=>submit()}>Check answer</button>}</section>
}
function LessonHead({title,progress,onClose}:{title:string,progress:number,onClose:()=>void}){return <><header className="lesson-head"><button className="icon-btn large" onClick={onClose}><X/></button><strong>{title}</strong><span/></header><div className="progress"><span style={{width:`${progress*100}%`}}/></div></>}
function TaskView({task,answer,setAnswer,paired,setPaired,submit,disabled}:{task:Task;answer:string;setAnswer:(s:string)=>void;paired:Record<string,string>;setPaired:(v:Record<string,string>)=>void;submit:(s?:string)=>void;disabled:boolean}){
 if(task.type==="choice")return <><p className="prompt">Choose the correct translation</p><h1>{task.word.target}</h1><div className="options">{task.options?.map(o=><button disabled={disabled} key={o} onClick={()=>submit(o)}>{o}<ChevronRight/></button>)}</div></>;
 if(task.type==="match")return <><p className="prompt">Match each word with its translation</p><div className="matches">{task.pairs?.map(w=><div key={w.id}><strong>{w.target}</strong><div>{task.pairs?.map(x=><button disabled={disabled} className={paired[w.id]===x.native?"selected":""} onClick={()=>setPaired({...paired,[w.id]:x.native})} key={x.id}>{x.native}</button>)}</div></div>)}</div></>;
 const prompt=task.type==="toNative"?`Translate “${task.word.target}”`:task.type==="write"?`Write the word for “${task.word.native}”`:`Translate “${task.word.native}” into the language you are learning`;
 return <><p className="prompt">{prompt}</p><input autoFocus className="answer" value={answer} disabled={disabled} onChange={e=>setAnswer(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")submit()}} placeholder="Type your answer" autoComplete="off"/></>;
}
