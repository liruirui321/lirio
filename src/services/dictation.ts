import {isExamInstruction,trimInstructionTail} from './examInstructions';
import type { Sentence } from '../types/project';
export interface Edit { kind: 'correct'|'missing'|'extra'|'wrong'|'placeholder'; expected?: string; actual?: string; expectedIndex?:number; expectedEnd?:number }
export function words(text:string):string[] { return text.normalize('NFKC').replace(/[’‘]/g,"'").toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)||[]; }
const small:Record<string,number>=Object.fromEntries('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ').map((w,i)=>[w,i]));
const tens:Record<string,number>={twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
interface Token {text:string;key:string}
function tokens(text:string):Token[]{
 const raw=text.normalize('NFKC').replace(/[’‘]/g,"'").match(/\d+(?:,\d{3})*(?:\.\d+)?(?![\p{L}\p{N}])|[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)||[];
 const result:Token[]=[];
 for(let i=0;i<raw.length;){
  const w=raw[i].toLowerCase();
  if(/^\d+(?:,\d{3})*(?:\.\d+)?$/.test(w)){result.push({text:raw[i],key:String(Number(w.replace(/,/g,'')))});i++;continue;}
  if(w in small||w in tens){
   const group=(at:number):{value:number;end:number}|null=>{
    const word=raw[at]?.toLowerCase();if(!(word in small||word in tens))return null;
    let end=at+1,value=small[word]??tens[word];
    if(word in tens&&small[raw[end]?.toLowerCase()]>0&&small[raw[end]?.toLowerCase()]<10)value+=small[raw[end++].toLowerCase()];
    if(value>0&&value<10&&raw[end]?.toLowerCase()==='hundred'){
     value*=100;end++;let after=end;if(raw[after]?.toLowerCase()==='and')after++;
     const n=raw[after]?.toLowerCase();if(n in small||n in tens){value+=small[n]??tens[n];end=after+1;if(n in tens&&small[raw[end]?.toLowerCase()]>0&&small[raw[end]?.toLowerCase()]<10)value+=small[raw[end++].toLowerCase()];}
    }
    return {value,end};
   };
   let {value,end}=group(i)!;
   if(raw[end]?.toLowerCase()==='thousand'){
    value*=1000;end++;let at=end;if(raw[at]?.toLowerCase()==='and')at++;
    const remainder=group(at);if(remainder){value+=remainder.value;end=remainder.end;}
   }
   let key=String(value);
   if(raw[end]?.toLowerCase()==='point'&&small[raw[end+1]?.toLowerCase()]>=0&&small[raw[end+1]?.toLowerCase()]<10){
    end++;let fraction='';while(small[raw[end]?.toLowerCase()]>=0&&small[raw[end]?.toLowerCase()]<10)fraction+=small[raw[end++].toLowerCase()];key=String(Number(key+'.'+fraction));
   }
   result.push({text:raw.slice(i,end).join(' '),key});i=end;continue;
  }
  result.push({text:raw[i],key:w});i++;
 }
 return result;
}
const initialWords=new Set('The A An I We You He She It They This That These Those My Our Your His Her Their And But So Well Yes No Oh Now Please First Next Finally There Here What How When Where Why'.split(' '));
function placeholderSpan(a:Token[],start:number,end:number){
 if(end-start===1)return a[start].key!=='noun';
 // A multiword placeholder may cover a title-cased name, not an arbitrary missing clause.
 return end-start<=6&&a.slice(start,end).every((t,i)=>/^[A-Z][A-Za-z'-]*$/.test(t.text)&&!initialWords.has(t.text)||(i>0&&i<end-start-1&&['of','the','and'].includes(t.key)));
}
export function grade(expected:string,actual:string) {
 const a=tokens(expected),b=tokens(actual),d=Array.from({length:a.length+1},()=>Array(b.length+1).fill(Infinity));
 const back=Array.from({length:a.length+1},()=>Array<{i:number;j:number;edit:Edit}|undefined>(b.length+1));d[0][0]=0;
 const put=(i:number,j:number,cost:number,pi:number,pj:number,edit:Edit)=>{if(cost<d[i][j]){d[i][j]=cost;back[i][j]={i:pi,j:pj,edit};}};
 for(let i=0;i<=a.length;i++)for(let j=0;j<=b.length;j++){
  if(i&&j)put(i,j,d[i-1][j-1]+Number(a[i-1].key!==b[j-1].key),i-1,j-1,{kind:a[i-1].key===b[j-1].key?'correct':'wrong',expected:a[i-1].text.toLowerCase(),actual:b[j-1].text.toLowerCase(),expectedIndex:i-1,expectedEnd:i});
  if(i)put(i,j,d[i-1][j]+1,i-1,j,{kind:'missing',expected:a[i-1].text.toLowerCase(),expectedIndex:i-1,expectedEnd:i});
  if(j)put(i,j,d[i][j-1]+1,i,j-1,{kind:'extra',actual:b[j-1].text.toLowerCase(),expectedIndex:i,expectedEnd:i});
  if(j&&b[j-1].key==='noun')for(let k=1;k<=Math.min(i,6);k++)if(placeholderSpan(a,i-k,i))put(i,j,d[i-k][j-1]+k*.01,i-k,j-1,{kind:'placeholder',expected:a.slice(i-k,i).map(t=>t.text).join(' '),actual:'noun',expectedIndex:i-k,expectedEnd:i});
 }
 const edits:Edit[]=[];let i=a.length,j=b.length;while(i||j){const step=back[i][j]!;edits.push(step.edit);i=step.i;j=step.j;}edits.reverse();
 const placeholders=edits.filter(e=>e.kind==='placeholder');const skipped=placeholders.reduce((n,e)=>n+e.expectedEnd!-e.expectedIndex!,0);
 const errors=edits.filter(e=>['wrong','missing','extra'].includes(e.kind)).length,evaluated=a.length-skipped;
 return {edits,referenceTokens:a.map(t=>t.text),placeholders:placeholders.length,evaluated,hasErrors:errors>0,score:evaluated?Math.max(0,Math.round((1-errors/evaluated)*100)):0,correct:errors===0&&placeholders.length===0};
}
export function sentences(raw:Array<{start:number;end:number;text:string}>,duration:number,aligned:Array<{start:number;end:number;text:string}>=[]):Sentence[]{
  const out:Sentence[]=[];
  for(const original of raw){const r=trimInstructionTail(original,aligned);const text=r.text.trim();if(!text||isExamInstruction(text)||/^\[.*\]$/.test(text)||!Number.isFinite(r.start)||!Number.isFinite(r.end))continue;
    const start=Math.max(0,r.start),end=Math.min(duration,r.end);if(end<=start)continue;
    out.push({id:crypto.randomUUID(),start,end,text,answer:'',submitted:false,revealed:false,attempts:0});
  }return out;
}
export function srt(items:Sentence[]):string { const stamp=(t:number)=>{const ms=Math.round(t*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(String(Math.floor(ms/60000)%60)).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};return items.map((s,i)=>`${i+1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.text}\n`).join('\n'); }
export function parseSrt(text:string,duration:number):Sentence[] {const rows:Array<{start:number;end:number;text:string}>=[];const time=(s:string)=>{const p=s.replace(',','.').split(':').map(Number);return p[0]*3600+p[1]*60+p[2];};for(const block of text.replace(/\r/g,'').trim().split(/\n\s*\n/)){const lines=block.split('\n'),idx=lines.findIndex(l=>l.includes('-->'));if(idx<0)continue;const m=lines[idx].match(/(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)/);if(m)rows.push({start:time(m[1]),end:time(m[2]),text:lines.slice(idx+1).join(' ').replace(/<[^>]*>/g,'')});}return sentences(rows,duration);}

type WordTiming = { start: number; end: number; text: string };
const CLAUSE_BREAK_RE = /[,;:—\-，；：]["'”’)\]]*$/;
const CONJUNCTION_WORDS = new Set([
  'and','but','because','so','which','that','while','although','though','however','whereas','when','where','if','since','until','unless','before','after',
]);

function buildSentenceWordTimings(
  s: { start: number; end: number; text: string },
  alignedWords?: WordTiming[],
  trimRange?: (start: number, end: number) => { start: number; end: number },
): WordTiming[] {
  const rawTokens = s.text.trim().split(/\s+/).filter(Boolean);
  if (!rawTokens.length) return [];
  if (alignedWords?.length) {
    const slice = alignedWords.filter((w) => w.end > s.start - 0.12 && w.start < s.end + 0.12);
    if (slice.length >= Math.max(2, Math.floor(rawTokens.length * 0.75))) {
      return slice;
    }
  }
  const span = trimRange ? trimRange(s.start, s.end) : { start: s.start, end: s.end };
  const spanStart = span.end > span.start ? span.start : s.start;
  const spanEnd = span.end > span.start ? span.end : s.end;
  const totalWeight = rawTokens.reduce((sum, tok) => sum + tok.length + 1.5, 0) || 1;
  const dur = Math.max(0.1, spanEnd - spanStart);
  let cur = spanStart;
  return rawTokens.map((tok, i) => {
    const portion = ((tok.length + 1.5) / totalWeight) * dur;
    const end = i === rawTokens.length - 1 ? spanEnd : cur + portion;
    const item = { start: cur, end, text: tok };
    cur = end;
    return item;
  });
}

function joinWordTimings(ws: WordTiming[]): { start: number; end: number; text: string } {
  return {
    start: ws[0].start,
    end: ws[ws.length - 1].end,
    text: ws
      .map((w) => w.text.trim())
      .join(' ')
      .replace(/ ,/g, ',')
      .replace(/ \./g, '.')
      .replace(/ \?/g, '?')
      .replace(/ !/g, '!'),
  };
}

function splitWordTimings(ws: WordTiming[]): Array<{ start: number; end: number; text: string }> {
  const len = ws.length;
  const dur = len ? ws[len - 1].end - ws[0].start : 0;
  if (len <= 18 && !(dur > 8.5 && len >= 12)) {
    return len ? [joinWordTimings(ws)] : [];
  }
  const minSide = 5;
  if (len < minSide * 2) return [joinWordTimings(ws)];

  let bestK = -1;
  let bestScore = -Infinity;
  let anySignal = false;
  for (let k = minSide; k <= len - minSide; k++) {
    let score = 0;
    let hasSignal = false;
    if (CLAUSE_BREAK_RE.test(ws[k - 1].text.trim())) {
      score += 100;
      hasSignal = true;
    }
    const gap = Math.max(0, ws[k].start - ws[k - 1].end);
    if (gap >= 0.22) {
      score += 70 + 100 * Math.min(1, gap);
      hasSignal = true;
    }
    const tokClean = ws[k].text.toLowerCase().replace(/^[^a-z']+|[^a-z']+$/g, '');
    if (CONJUNCTION_WORDS.has(tokClean)) {
      score += 45;
      hasSignal = true;
    }
    score -= 30 * Math.abs(k / len - 0.5);
    if (hasSignal) anySignal = true;
    if (score > bestScore) {
      bestScore = score;
      bestK = k;
    }
  }
  if (bestK > 0 && (anySignal || len > 24)) {
    return [...splitWordTimings(ws.slice(0, bestK)), ...splitWordTimings(ws.slice(bestK))];
  }
  return [joinWordTimings(ws)];
}

export function resegmentSentences(
  items: Sentence[],
  alignedWords: WordTiming[] | undefined,
  duration: number,
  trimRange?: (start: number, end: number) => { start: number; end: number },
): Sentence[] {
  const oldByNorm = new Map<string, Sentence>();
  for (const s of items) {
    oldByNorm.set(s.text.trim().toLowerCase().replace(/\s+/g, ' '), s);
  }

  // Pass 1: Split overlong sentences at natural sense groups
  const splitOut: Array<{ start: number; end: number; text: string }> = [];
  for (const s of items) {
    const clean = s.text.trim();
    if (!clean) continue;
    const wc = clean.split(/\s+/).length;
    const dur = s.end - s.start;
    if (wc <= 18 && !(dur > 8.5 && wc >= 12)) {
      splitOut.push({ start: s.start, end: s.end, text: clean });
    } else {
      const ws = buildSentenceWordTimings(s, alignedWords, trimRange);
      if (ws.length) splitOut.push(...splitWordTimings(ws));
    }
  }

  // Pass 2: Merge tiny spoken fillers/fragments (<=3 words and <1.3s) into closer neighbor
  const merged: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < splitOut.length; i++) {
    const cur = splitOut[i];
    const wc = cur.text.split(/\s+/).filter(Boolean).length;
    const dur = cur.end - cur.start;
    if (wc <= 3 && dur < 1.3) {
      const prev = merged[merged.length - 1];
      const next = splitOut[i + 1];
      const prevGap = prev ? Math.max(0, cur.start - prev.end) : Infinity;
      const nextGap = next ? Math.max(0, next.start - cur.end) : Infinity;
      const prevOk =
        Boolean(prev) &&
        prevGap < 0.85 &&
        prev!.text.split(/\s+/).filter(Boolean).length + wc <= 16 &&
        cur.end - prev!.start <= 8.5;
      const nextOk =
        Boolean(next) &&
        nextGap < 0.85 &&
        wc + next!.text.split(/\s+/).filter(Boolean).length <= 16 &&
        next!.end - cur.start <= 8.5;

      if (prevOk && (!nextOk || prevGap <= nextGap)) {
        prev!.end = cur.end;
        prev!.text = `${prev!.text} ${cur.text}`.trim();
        continue;
      }
      if (nextOk) {
        merged.push({
          start: cur.start,
          end: next!.end,
          text: `${cur.text} ${next!.text}`.trim(),
        });
        i++;
        continue;
      }
    }
    merged.push({ ...cur });
  }

  return merged
    .map((seg) => {
      const start = Math.max(0, seg.start);
      const end = Math.min(duration || seg.end, seg.end);
      const old = oldByNorm.get(seg.text.trim().toLowerCase().replace(/\s+/g, ' '));
      return {
        id: crypto.randomUUID(),
        start,
        end: Math.max(start + 0.05, end),
        text: seg.text,
        answer: old?.answer || '',
        submittedAnswer: old?.submittedAnswer,
        submitted: old?.submitted || false,
        revealed: old?.revealed || false,
        assisted: old?.assisted,
        attempts: old?.attempts || 0,
      };
    })
    .filter((s) => s.end > s.start && s.text.length > 0);
}

export function mergeTwoSentences(a: Sentence, b: Sentence): Sentence {
  const answers = [a.answer.trim(), b.answer.trim()].filter(Boolean).join(' ');
  return {
    id: crypto.randomUUID(),
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    text: `${a.text.trim()} ${b.text.trim()}`.trim(),
    answer: answers,
    submitted: false,
    revealed: false,
    attempts: Math.max(a.attempts, b.attempts),
  };
}

export function splitSentenceAt(
  s: Sentence,
  cursorTime: number,
  alignedWords?: WordTiming[],
  trimRange?: (start: number, end: number) => { start: number; end: number },
): [Sentence, Sentence] | null {
  const ws = buildSentenceWordTimings(s, alignedWords, trimRange);
  if (ws.length < 2) return null;

  let splitIdx = -1;
  if (cursorTime > s.start + 0.25 && cursorTime < s.end - 0.25) {
    let bestDist = Infinity;
    for (let k = 1; k < ws.length; k++) {
      const mid = (ws[k - 1].end + ws[k].start) / 2;
      const dist = Math.abs(mid - cursorTime);
      if (dist < bestDist) {
        bestDist = dist;
        splitIdx = k;
      }
    }
  } else {
    let bestScore = -Infinity;
    for (let k = 1; k < ws.length; k++) {
      let score = 0;
      if (CLAUSE_BREAK_RE.test(ws[k - 1].text.trim())) score += 80;
      const gap = Math.max(0, ws[k].start - ws[k - 1].end);
      if (gap >= 0.18) score += 50 + gap * 60;
      const tokClean = ws[k].text.toLowerCase().replace(/^[^a-z']+|[^a-z']+$/g, '');
      if (CONJUNCTION_WORDS.has(tokClean)) score += 35;
      score -= 25 * Math.abs(k / ws.length - 0.5);
      if (score > bestScore) {
        bestScore = score;
        splitIdx = k;
      }
    }
  }

  if (splitIdx <= 0 || splitIdx >= ws.length) return null;
  const left = joinWordTimings(ws.slice(0, splitIdx));
  const right = joinWordTimings(ws.slice(splitIdx));
  return [
    {
      id: crypto.randomUUID(),
      start: Math.max(s.start, left.start),
      end: Math.min(s.end, Math.max(left.start + 0.05, left.end)),
      text: left.text,
      answer: '',
      submitted: false,
      revealed: false,
      attempts: 0,
    },
    {
      id: crypto.randomUUID(),
      start: Math.max(s.start, right.start),
      end: Math.max(right.start + 0.05, s.end),
      text: right.text,
      answer: '',
      submitted: false,
      revealed: false,
      attempts: 0,
    },
  ];
}
