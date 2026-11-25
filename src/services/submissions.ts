import { invoke } from '@tauri-apps/api/core';
import { grade, words } from './dictation';
import type { Project, Sentence } from '../types/project';
export interface Submission {id:string;projectId:string;projectName:string;sentenceId:string;start:number;end:number;expected:string;answer:string;attempt:number;submittedAt:string|null;recovered:boolean;assisted:boolean|null}
export const snapshot=(p:Project)=>({id:p.libraryId||p.id,name:p.name,dictation:p.dictation,dictationBackups:p.dictationBackups});
export const history=(p?:Project|null)=>invoke<{records:Submission[];warnings:string[]}>('submission_list',{project:p?snapshot(p):null});
export async function record(p:Project,s:Sentence,assisted:boolean){
 const submission:Submission={id:crypto.randomUUID(),projectId:p.libraryId||p.id,projectName:p.name,sentenceId:s.id,start:s.start,end:s.end,expected:s.text,answer:s.answer,attempt:s.attempts+1,submittedAt:new Date().toISOString(),recovered:false,assisted};
 await invoke('submission_record',{record:submission});return submission;
}
export const FUNCTION_WORDS = new Set(
  words(
    'a an the to of in on at for and or but is are was were be been have has had do does did can could would should may might must will shall it its that this these those as by from with not my your his her our their you we i they them him me us',
  ),
);

export function analyze(records:Submission[]){
 const counts=new Map<string,{word:string;seen:number;missing:number;wrong:number;correct:number;confusions:Record<string,number>}>();
 const timeline=records.map(r=>({...r,result:grade(r.expected,r.answer)}));
 const latestErrorRecord = new Map<string, Submission>();
 for(const r of timeline){
  for(const e of r.result.edits){
   if(!e.expected||e.kind==='placeholder')continue;
   let v=counts.get(e.expected);
   if(!v){v={word:e.expected,seen:0,missing:0,wrong:0,correct:0,confusions:{}};counts.set(e.expected,v);}
   v.seen++;
   if(e.kind==='missing')v.missing++;
   if(e.kind==='wrong'){v.wrong++;v.confusions[e.actual||'']=(v.confusions[e.actual||'']||0)+1;}
   if(e.kind==='correct')v.correct++;
   if(e.kind==='missing'||e.kind==='wrong'){
    const prev=latestErrorRecord.get(e.expected);
    if(!prev||(r.submittedAt||'')>=(prev.submittedAt||''))latestErrorRecord.set(e.expected,r);
   }
  }
 }
 const ranked=[...counts.values()].sort((a,b)=>(b.missing+b.wrong)-(a.missing+a.wrong)||b.seen-a.seen||a.word.localeCompare(b.word));
 const dated=timeline.filter(r=>r.submittedAt&&!r.recovered).sort((a,b)=>a.submittedAt!.localeCompare(b.submittedAt!));
 const groups=new Map<string,typeof dated>();for(const r of dated){const key=JSON.stringify([r.projectId,r.sentenceId,r.expected]);groups.set(key,[...(groups.get(key)||[]),r]);}
 const retries=[...groups.values()].filter(g=>g.length>1);const improved=retries.filter(g=>!g[g.length-1].result.placeholders&&!g[0].result.placeholders&&g[g.length-1].result.score>g[0].result.score).length;
 const missedFunctionWords=ranked.filter(w=>FUNCTION_WORDS.has(w.word)&&w.missing>0);
 const contentMistakes=ranked
  .filter(w=>!FUNCTION_WORDS.has(w.word)&&w.word.length>=2&&(w.missing+w.wrong)>0)
  .sort((a,b)=>(b.missing+b.wrong)-(a.missing+a.wrong)||b.seen-a.seen||a.word.localeCompare(b.word))
  .map(w=>({...w,totalErrors:w.missing+w.wrong,latestRecord:latestErrorRecord.get(w.word)||null}));
 const evaluated=timeline.filter(r=>r.result.evaluated>0);
 const avgScore=evaluated.length?Math.round(evaluated.reduce((s,r)=>s+r.result.score,0)/evaluated.length):0;
 const datedEval=dated.filter(r=>r.result.evaluated>0);
 let recentTrend:number|null=null;
 if(datedEval.length>=6){
  const recent=datedEval.slice(-5);
  const prevSlice=datedEval.slice(-10,-5);
  if(prevSlice.length>0){
   const rAvg=recent.reduce((s,r)=>s+r.result.score,0)/recent.length;
   const pAvg=prevSlice.reduce((s,r)=>s+r.result.score,0)/prevSlice.length;
   recentTrend=Math.round(rAvg-pAvg);
  }
 }
 const errorTimeline=[...timeline].reverse().filter(r=>r.result.hasErrors);
 return {
  ranked,
  timeline,
  dated,
  retries:retries.length,
  improved,
  missedFunctionWords,
  contentMistakes,
  avgScore,
  recentTrend,
  errorTimeline,
  missing:ranked.reduce((n,w)=>n+w.missing,0),
  wrong:ranked.reduce((n,w)=>n+w.wrong,0),
 };
}
