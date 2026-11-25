import patterns from '../data/exam-instructions.json';
import type {Project} from '../types/project';
const rules=patterns.map(p=>new RegExp(p,'i'));
export function isExamInstruction(text:string){const normalized=text.toLowerCase().replace(/[.,!?:;'“”‘’]/g,'').replace(/\s+/g,' ').trim();return rules.some(r=>r.test(normalized));}
export function trimInstructionTail<T extends {text:string;start:number;end:number}>(sentence:T,aligned:Array<{text:string;start:number;end:number}>=[]):T{
 const match=/\b(?:(?:(?:that|this) )?is the end of (?:(?:part|section) (?:[1-4]|one|two|three|four)|the listening test)|(?:before )?you hear the rest of the (?:conversation|discussion|presentation|talk|lecture|programme|podcast).+questions? [\w -]+)\.?$/i.exec(sentence.text);
 if(!match||match.index<5)return sentence;
 const normalize=(s:string)=>s.toLowerCase().replace(/[^a-z0-9']/g,'');const wanted=match[0].split(/\s+/).slice(0,3).map(normalize);
 const ws=aligned.filter(w=>w.start>=sentence.start-.1&&w.end<=sentence.end+.2);let at=-1;
 for(let i=0;i<ws.length-2;i++)if(wanted.every((w,j)=>normalize(ws[i+j].text)===w))at=i;
 if(at<0||ws[at].start<=sentence.start)return sentence;
 return {...sentence,text:sentence.text.slice(0,match.index).trim().replace(/[.,]+$/,'')+'…',end:ws[at].start};
}
export function stripExamInstructions(project:Project){
 const d=project.dictation;if(!d)return project;
 const kept=d.sentences.filter(s=>!isExamInstruction(s.text)).map(s=>trimInstructionTail(s,d.words));
 if(kept.length===d.sentences.length&&kept.every((s,i)=>s===d.sentences[i]))return project;
 const selected=d.sentences[d.index];const index=Math.max(0,kept.findIndex(s=>s.id===selected?.id));
 return {...project,dictationBackups:[...(project.dictationBackups||[]),d],dictation:{...d,sentences:kept,index}};
}
