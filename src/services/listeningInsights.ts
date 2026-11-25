import { grade, words } from './dictation';
import type { Submission } from './submissions';
export type Pronunciations=Record<string,string>;
export interface ListeningInsight {record:Submission;word:string;actual:string;phrase:string;from:number;to:number;kind:string;reason:string;practice:string;otherCorrect:number}
const weak:Record<string,string>={a:'/ə/',an:'/ən/',the:'/ðə/（常见于辅音前）',to:'/tə/',of:'/əv/ 或 /ə/',and:'/ən/ 或 /n/',for:'/fə/（非重读）',can:'/kən/',have:'/həv/ 或 /əv/',has:'/həz/ 或 /əz/',had:'/həd/',was:'/wəz/',were:'/wə/',are:'/ə/（非重读、非卷舌口音）',at:'/ət/',as:'/əz/',from:'/frəm/',them:'/ðəm/ 或 /əm/',him:'/ɪm/（某些非重读语境）',her:'/ə/（某些非重读语境）'};
const vowel=(p:string)=>/^(AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)$/.test(p);
const phones=(w:string,dict:Pronunciations)=>(dict[w.toLowerCase()]||'').split(' ').filter(Boolean);
const distance=(a:string[],b:string[])=>{let row=b.map((_,i)=>i+1);row.unshift(0);for(let i=0;i<a.length;i++){const next=[i+1];for(let j=0;j<b.length;j++)next.push(Math.min(next[j]+1,row[j+1]+1,row[j]+Number(a[i]!==b[j])));row=next;}return row[b.length];};
export function listeningInsights(records:Submission[],dict:Pronunciations={}):ListeningInsight[]{
 const graded=records.map(record=>({record,result:grade(record.expected,record.answer)}));const out:ListeningInsight[]=[];
 for(const {record,result} of graded){
  if(!record.answer.trim()||words(record.answer).length<words(record.expected).length*.35)continue;
  const ts=result.referenceTokens;
  for(const e of result.edits){
   if(!e.expected||!['missing','wrong'].includes(e.kind))continue;
   const i=e.expectedIndex!,w=e.expected.toLowerCase();if(words(w).length!==1||/^\d/.test(w))continue;
   const from=Math.max(0,i-2),to=Math.min(ts.length,i+3),phrase=ts.slice(from,to).join(' ');
   const candidates:Array<{kind:string;reason:string;practice:string}>=[];
   if(weak[w])candidates.push({kind:'弱读线索',reason:`“${w}”在不受重读时可能读成 ${weak[w]}。在“${phrase}”中，短促的元音可能被前后词遮住；漏写或替换并不说明你不认识这个词。`,practice:'先听整段意思，再连着听左右相邻词；跟读时保留弱读音，不要把每个词都读成重音。'});
   for(const left of [i-1,i]){
    if(left<0||left+1>=ts.length)continue;
    const a=phones(ts[left],dict),b=phones(ts[left+1],dict);if(!a.length||!b.length)continue;
    const last=a[a.length-1],first=b[0],pair=ts[left]+'‿'+ts[left+1];
    if(!vowel(last)&&vowel(first))candidates.push({kind:'词边界／连读线索',reason:`“${pair}”的词典读音具备辅音结尾接元音开头的条件。连起来时，前词的尾音可能被你分到后词；需要在原录音中核对。`,practice:`把“${pair}”当一个语块重听，再按两个词写出；最后回到原速整句，确认边界。`});
    if((last==='T'||last==='D')&&a.length>1&&!vowel(a[a.length-2])&&!vowel(first))candidates.push({kind:'辅音群／省音线索',reason:`“${pair}”连接处有辅音群，词尾 /${last.toLowerCase()}/ 在部分自然语流中可能弱化或省略；这里只是发音环境线索。`,practice:'先听词干，再听接到下一个词时是否有词尾线索；结合时态或语法核对，不强求听到清晰爆破。'});
    if((last==='T'||last==='D')&&first==='Y')candidates.push({kind:'同化线索',reason:`“${pair}”连接处的 /${last.toLowerCase()}/ 与 /j/ 有合并发音的可能，例如 /tʃ/ 或 /dʒ/；需结合说话人的实际读法判断。`,practice:'对照两个词的清晰读法，再听它们连在一起的声音，模仿整个短语，而非只重复错词。'});
   }
   const a=phones(w,dict),b=phones(e.actual||'',dict);
   if(e.kind==='wrong'&&a.length&&b.length&&distance(a,b)<=1)candidates.push({kind:distance(a,b)===0?'同音／拼写辨义':'近音混淆线索',reason:distance(a,b)===0?`“${w}”和“${e.actual}”在该词典中同音。更值得检查语境、词义与拼写，不能把这一处直接归因为没有听清。`:`“${w}”与“${e.actual}”的词典音素相差很少。先对比词中有区别的音，再听它在整句中的实现；相邻词也可能影响辨认。`,practice:'先对照两种写法和意思，再听完整短语，找出真正区分两词的声音或语法线索。'});
   if(!candidates.length)candidates.push({kind:'原因待核对',reason:'当前文本和读音线索不足以区分听辨、词义、拼写或字幕问题。这一处不会被直接归为“不认识单词”。',practice:'先不看参考重听短语；如果单独能认出、放回原句却听错，重点练语流；如果听对但写错，再练拼写。'});
   const otherCorrect=new Set(graded.filter(g=>g.record.assisted===false&&(g.record.projectId!==record.projectId||g.record.sentenceId!==record.sentenceId)&&g.result.edits.some(x=>x.kind==='correct'&&x.expected===w)).map(g=>g.record.projectId+':'+g.record.sentenceId)).size;
   for(const c of candidates.slice(0,3))out.push({record,word:w,actual:e.kind==='missing'?'（漏写）':e.actual||'',phrase,from,to,...c,otherCorrect});
  }
 }
 return out;
}
