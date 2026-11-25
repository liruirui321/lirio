import {useEffect,useMemo,useRef,useState} from 'react';
import {listeningInsights,type Pronunciations,type ListeningInsight} from '../../services/listeningInsights';
import type {Submission} from '../../services/submissions';
import {ReviewAudio} from '../../services/reviewAudio';
import pronunciationUrl from '../../data/pronunciations.json?url';
import license from '../../data/CMUDICT-LICENSE.txt?raw';

export function ListeningPatterns({records,word}:{records:Submission[];word:string}){
 const [dict,setDict]=useState<Pronunciations>({}),[dictionaryError,setDictionaryError]=useState('');
 const [kind,setKind]=useState('全部'),[limit,setLimit]=useState(12),[status,setStatus]=useState(''),[error,setError]=useState(''),[rate,setRate]=useState(1);
 const player=useRef(new ReviewAudio());
 useEffect(()=>{let active=true;fetch(pronunciationUrl).then(r=>{if(!r.ok)throw Error('读音词典未能加载');return r.json();}).then(d=>{if(active)setDict(d);}).catch(e=>{if(active)setDictionaryError(String(e));});return()=>{active=false;player.current.dispose();};},[]);
 useEffect(()=>{player.current.stop();setStatus('');setLimit(12);},[records,word]);
 const insights=useMemo(()=>listeningInsights(records,dict),[records,dict]);
 const categories=[...new Set(insights.map(i=>i.kind))];
 const matching=insights.filter(i=>(!word||i.word===word)&&(kind==='全部'||i.kind===kind));
 const play=async(i:ListeningInsight,phrase:boolean)=>{setError('');setStatus('正在读取原音频…');try{setStatus(await player.current.play(i.record,phrase?i.phrase:null,rate));}catch(e){setError('无法重听：'+String(e)+'。请连接材料所在 SSD；未入库的旧项目需先打开。');setStatus('');}};
 return <div className="analysis-panel listening-patterns"><h2>语流听辨 · 连读与弱读</h2>
 <p className="analysis-note">结合前后词、词典读音和历史提交寻找可能原因；尚未对原录音做声学诊断。连读不等于词汇不熟，线索需通过重听确认。空白或大面积漏写的提交不推断发音原因。</p>
 {dictionaryError&&<p role="status">{dictionaryError}，暂显示弱读与待核对线索。</p>}
 <div className="listening-tools"><select aria-label="语流分析类型" value={kind} onChange={e=>{setKind(e.target.value);setLimit(12);}}><option>全部</option>{categories.map(k=><option key={k}>{k}</option>)}</select><select aria-label="分析重听速度" value={rate} onChange={e=>{player.current.stop();setRate(Number(e.target.value));}}><option value="1">原速</option><option value="0.85">0.85×（会变调）</option></select><button onClick={()=>{player.current.stop();setStatus('已停止');}}>停止重听</button><span role="status">{status}</span></div>
 {error&&<p role="alert">{error}</p>}
 <div className="listening-tags">{categories.map(k=><span key={k}>{k} · {new Set(insights.filter(i=>i.kind===k).map(i=>i.record.id)).size} 次提交</span>)}</div>
 {!matching.length&&<p>当前范围没有可分析的错词线索。数字等价答案和 noun 占位不会作为听辨错误。</p>}
 {matching.slice(0,limit).map((i,n)=><article className="listening-insight" key={i.record.id+':'+i.from+':'+i.kind+':'+n}>
 <div><strong>{i.kind}</strong><small>可能原因 · 待重听核对</small></div>
 <p className="listening-phrase">{i.phrase}</p><p>参考词：<b>{i.word}</b>　你的写法：<b>{i.actual}</b></p>
 <p>{i.reason}</p>{i.otherCorrect>0&&<p className="listening-evidence">你在其他 {i.otherCorrect} 个句子的无提示提交中写对过这个词。这支持优先检查当前语境的声音连接，而非直接判定词汇不熟。</p>}
 <p><b>怎么练：</b>{i.practice}</p><p className="analysis-note">{i.record.projectName} · 第 {i.record.attempt} 次提交{i.record.assisted?' · 使用过提示／答案':''}</p>
 <div className="listening-tools"><button onClick={()=>void play(i,true)}>重听前后语块</button><button onClick={()=>void play(i,false)}>重听完整原句</button></div>
 </article>)}
 {matching.length>limit&&<button onClick={()=>setLimit(limit+12)}>再显示 12 条语流线索</button>}
 <details className="analysis-note"><summary>分析依据与适用范围</summary><p>弱读、连读、辅音群和同化只表示可能的发音环境，不证明说话人采用了这种读法。读音来自 CMU Dictionary，偏北美英语；英式读音、地方口音、专名和词典多读音可能不同。未找到读音的词不会按字母形状强行推断连读。</p><p>发音规则参考 British Council TeachingEnglish 的 Connected speech 与 Weak forms；原始提交始终保留，统计会按当前批改规则重算。</p><pre>{license}</pre></details>
 </div>;
}
