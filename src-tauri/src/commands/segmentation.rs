use serde::{Deserialize,Serialize};
use std::{fs,path::Path,process::{Command,Stdio},sync::atomic::{AtomicBool,Ordering},time::{Duration,Instant}};
#[derive(Clone,Debug,Serialize,Deserialize)]
pub struct Segment{pub start:f64,pub end:f64,pub text:String}
#[derive(Serialize,Deserialize)]
pub struct Segmentation{pub segments:Vec<Segment>,pub words:Vec<Segment>,pub source:String}
fn terminal(text:&str)->bool{
 let t=text.trim_end_matches(['"','\'','”','’',')',']']);
 if t.ends_with(['!','?','。','！','？']){return true;}
 if !t.ends_with('.') {return false;}
 let word=t.split_whitespace().last().unwrap_or("").to_lowercase();
 if ["mr.","mrs.","ms.","dr.","prof.","st.","vs.","e.g.","i.e.","etc."].contains(&word.as_str()){return false;}
 if word.len()==2&&word.chars().next().is_some_and(|c|c.is_alphabetic()){return false;}
 true
}
fn sentence(words:&[Segment])->Segment{Segment{start:words[0].start,end:words.last().unwrap().end,text:words.iter().map(|s|s.text.trim()).collect::<Vec<_>>().join(" ").replace(" ,",",").replace(" .",".").replace(" ?","?").replace(" !","!")}}
pub fn punctuation(words:&[Segment])->Vec<Segment>{
 let mut out=Vec::new();let mut first=0;
 for (i,w) in words.iter().enumerate(){
  let gap=words.get(i+1).is_some_and(|next|next.start-w.end>0.95);
  if terminal(&w.text)||gap||i+1==words.len(){out.push(sentence(&words[first..=i]));first=i+1;}
 }out
}
// The model returns only boundary IDs: it cannot rewrite or remove transcript words.
fn aligned_boundaries(candidates:&[Segment],output:&str)->Option<Vec<Segment>>{
 let a=output.find('[')?;let b=output[a..].find(']')?+a;
 let ids:Vec<usize>=serde_json::from_str(&output[a..=b]).ok()?;
 if ids.is_empty()||ids.iter().any(|&n|n==0||n>candidates.len())||ids.windows(2).any(|w|w[0]>=w[1]){return None;}
 let mut out=Vec::new();let mut start=0;
 for (i,_c) in candidates.iter().enumerate(){
  if ids.contains(&(i+1))||i+1==candidates.len(){out.push(sentence(&candidates[start..=i]));start=i+1;}
 }Some(out)
}

fn clean_lower_token(s:&str)->String{
 s.trim_matches(|c:char| !c.is_alphanumeric() && c!='\'').to_lowercase()
}

fn is_clause_break(text:&str)->bool{
 let t=text.trim_end_matches(['"','\'','”','’',')',']']);
 t.ends_with([',',';',':','—','-','，','；','：'])
}

fn is_conjunction(text:&str)->bool{
 matches!(
  clean_lower_token(text).as_str(),
  "and"|"but"|"because"|"so"|"which"|"that"|"while"|"although"|"though"|"however"|"whereas"|"when"|"where"|"if"|"since"|"until"|"unless"|"before"|"after"
 )
}

fn split_word_slice(words:&[Segment])->Vec<Segment>{
 let len=words.len();
 let dur=words.last().map_or(0.0,|w|w.end)-words.first().map_or(0.0,|w|w.start);
 if len<=18 && !(dur>8.5 && len>=12){
  return if len>0{vec![sentence(words)]}else{vec![]};
 }
 let min_side=5usize;
 if len<min_side*2{
  return vec![sentence(words)];
 }
 let mut best_k:Option<(usize,f64)>=None;
 let mut any_signal=false;
 for k in min_side..=(len-min_side){
  let mut score:f64=0.0;
  let mut has_signal=false;
  if is_clause_break(&words[k-1].text){
   score+=100.0;
   has_signal=true;
  }
  let gap=(words[k].start-words[k-1].end).max(0.0);
  if gap>=0.22{
   score+=70.0+100.0*gap.min(1.0);
   has_signal=true;
  }
  if is_conjunction(&words[k].text){
   score+=45.0;
   has_signal=true;
  }
  score-=30.0*((k as f64/len as f64)-0.5).abs();
  if has_signal{any_signal=true;}
  if best_k.is_none_or(|(_,best)|score>best){
   best_k=Some((k,score));
  }
 }
 if let Some((k,_))=best_k{
  if any_signal || len>24{
   let mut out=split_word_slice(&words[..k]);
   out.extend(split_word_slice(&words[k..]));
   return out;
  }
 }
 vec![sentence(words)]
}

fn word_count(text:&str)->usize{
 text.split_whitespace().count()
}

pub fn refine_segments(raw_segments:Vec<Segment>,all_words:&[Segment])->Vec<Segment>{
 // Pass 1: Split overlong sentences into natural sense groups using word timestamps.
 let mut split_out:Vec<Segment>=Vec::new();
 let mut cursor=0usize;
 for seg in raw_segments{
  if all_words.is_empty(){
   split_out.push(seg);
   continue;
  }
  while cursor<all_words.len() && all_words[cursor].end<=seg.start+0.02 && all_words[cursor].start<seg.start-0.05{
   cursor+=1;
  }
  let slice_start=cursor;
  let mut slice_end=cursor;
  while slice_end<all_words.len() && all_words[slice_end].start<=seg.end-0.02{
   slice_end+=1;
  }
  cursor=slice_end;
  if slice_end>slice_start{
   split_out.extend(split_word_slice(&all_words[slice_start..slice_end]));
  }else{
   split_out.push(seg);
  }
 }

 // Pass 2: Merge tiny spoken fillers/fragments (<=3 words and <1.3s) into closer close neighbor.
 let mut merged:Vec<Segment>=Vec::with_capacity(split_out.len());
 let mut i=0usize;
 while i<split_out.len(){
  let cur=&split_out[i];
  let wc=word_count(&cur.text);
  let dur=cur.end-cur.start;
  if wc<=3 && dur<1.3{
   let prev_ok=merged.last().map(|p|{
    let gap=(cur.start-p.end).max(0.0);
    let comb_wc=word_count(&p.text)+wc;
    let comb_dur=cur.end-p.start;
    (gap, gap<0.85 && comb_wc<=16 && comb_dur<=8.5)
   });
   let next_ok=split_out.get(i+1).map(|n|{
    let gap=(n.start-cur.end).max(0.0);
    let comb_wc=wc+word_count(&n.text);
    let comb_dur=n.end-cur.start;
    (gap, gap<0.85 && comb_wc<=16 && comb_dur<=8.5)
   });
   match (prev_ok,next_ok){
    (Some((pg,true)),Some((ng,true)))=>{
     if pg<=ng{
      let prev=merged.last_mut().unwrap();
      prev.end=cur.end;
      prev.text=format!("{} {}",prev.text.trim(),cur.text.trim());
      i+=1;
      continue;
     }else{
      let next=&split_out[i+1];
      merged.push(Segment{start:cur.start,end:next.end,text:format!("{} {}",cur.text.trim(),next.text.trim())});
      i+=2;
      continue;
     }
    }
    (Some((_,true)),_)=>{
     let prev=merged.last_mut().unwrap();
     prev.end=cur.end;
     prev.text=format!("{} {}",prev.text.trim(),cur.text.trim());
     i+=1;
     continue;
    }
    (_,Some((_,true)))=>{
     let next=&split_out[i+1];
     merged.push(Segment{start:cur.start,end:next.end,text:format!("{} {}",cur.text.trim(),next.text.trim())});
     i+=2;
     continue;
    }
    _=>{}
   }
  }
  merged.push(cur.clone());
  i+=1;
 }
 merged
}
pub fn segment_words<F:Fn(String)>(words:Vec<Segment>,resources:&Path,work:&Path,cancel:&AtomicBool,progress:F)->Result<Segmentation,String>{
 if words.is_empty(){return Err("没有可分句的文字".into());}
 let cli=resources.join("llama-completion");let model=resources.join("qwen.gguf");
 let mut out=Vec::new();let mut accepted=0;let mut total=0;let mut start=0;
 while start<words.len(){
  if cancel.load(Ordering::SeqCst){return Err("识别已取消。".into());}
  let mut end=(start+180).min(words.len());while end<words.len()&&!terminal(&words[end-1].text){end+=1;}
  let slice=&words[start..end];total+=1;progress(format!("正在进行 LLM 单句拆分：第 {total} 组…"));
  let generated=(||->Result<Vec<Segment>,String>{
   if !cli.is_file()||!model.is_file(){return Err("LLM 组件缺失".into());}
   let candidates=punctuation(slice);
   let numbered=candidates.iter().enumerate().map(|(i,s)|format!("{}: {}",i+1,s.text)).collect::<Vec<_>>().join("\n");
   let prompt=format!("<|im_start|>system\nYou detect complete sentence boundaries. Given numbered transcript lines, return a JSON array of line numbers where a full sentence ends. Merge unfinished phrases with the following line. Always include the final line number. Do not output text or explanations.\nExample: 1: We went\n2: home.\n3: It was late.\nAnswer: [2,3]<|im_end|>\n<|im_start|>user\n{numbered}<|im_end|>\n<|im_start|>assistant\n");
   let input=work.join("sentence-prompt.txt");let output=work.join("sentence-result.txt");fs::write(&input,prompt).map_err(|e|e.to_string())?;
   let file=fs::File::create(&output).map_err(|e|e.to_string())?;
   let mut child=Command::new(&cli).arg("-m").arg(&model).arg("-f").arg(&input).args(["-n","256","-c","4096","--temp","0","--no-conversation","--no-display-prompt","--no-perf","--simple-io"])
    .stdout(Stdio::from(file)).stderr(Stdio::null()).spawn().map_err(|e|e.to_string())?;
   let began=Instant::now();let status=loop{if cancel.load(Ordering::SeqCst)||began.elapsed()>Duration::from_secs(150){let _=child.kill();let _=child.wait();return Err("分句取消或超时".into());}match child.try_wait().map_err(|e|e.to_string())?{Some(s)=>break s,None=>std::thread::sleep(Duration::from_millis(80))}};
   if !status.success(){return Err("模型执行失败".into());}
   let text=fs::read_to_string(output).map_err(|e|e.to_string())?;
   aligned_boundaries(&candidates,&text).ok_or("模型边界无效，使用标点边界保护原音对齐".into())
  })();
  if cancel.load(Ordering::SeqCst){return Err("识别已取消。".into());}
  match generated{Ok(sentences)=>{accepted+=1;out.extend(sentences);},Err(_)=>out.extend(punctuation(slice))}
  start=end;
 }
 let mut out=refine_segments(out,&words);
 // Add a small listening margin, bounded by neighboring sentences to avoid overlap.
 for i in 0..out.len(){let prev=if i>0{out[i-1].end}else{0.0};out[i].start=(out[i].start-0.08).max(prev);let next=out.get(i+1).map_or(out[i].end+0.12,|s|s.start);out[i].end=(out[i].end+0.12).min(next).max(out[i].start+0.01);}
 Ok(Segmentation{segments:out,words,source:if accepted==total{format!("Whisper 词级对齐 · Qwen LLM 单句拆分（{total} 组已校验）")}else{format!("Whisper 词级对齐 · Qwen LLM {accepted}/{total} 组通过；{} 组按标点回退",total-accepted)}})
}
#[cfg(test)]mod tests{use super::*;fn sample()->Vec<Segment>{["Dr.","Brown","is","here.","He","can","help."].iter().enumerate().map(|(i,t)|Segment{start:i as f64,end:i as f64+0.5,text:t.to_string()}).collect()}
 #[test]fn abbreviation_and_sentence_boundary(){let s=punctuation(&sample());assert_eq!(s.len(),2);assert_eq!(s[0].text,"Dr. Brown is here.");assert_eq!(s[1].start,4.0);}
 #[test]fn reject_invalid_boundaries(){let c=punctuation(&sample());assert!(aligned_boundaries(&c,"[1,9]").is_none());assert!(aligned_boundaries(&c,"[2,1]").is_none());}
 #[test]fn align_complete_sentences(){let c=punctuation(&sample());let s=aligned_boundaries(&c,"[1,2]").unwrap();assert_eq!(s.len(),2);assert_eq!(s[0].end,3.5);assert_eq!(s[1].text,"He can help.");}
 #[test]fn split_long_sentence_into_sense_groups(){
  let tokens=["The","university","library","closes","early","today,","and","most","students","have","to","finish","their","group","assignments","before","dinner","time","tonight."];
  let mut t=0.0;
  let ws:Vec<Segment>=tokens.iter().map(|tok|{let s=Segment{start:t,end:t+0.35,text:tok.to_string()};t+=if tok.ends_with(','){0.65}else{0.4};s}).collect();
  let raw=punctuation(&ws);
  assert_eq!(raw.len(),1);
  let refined=refine_segments(raw,&ws);
  assert_eq!(refined.len(),2);
  assert_eq!(refined[0].text,"The university library closes early today,");
  assert!(refined[1].text.starts_with("and most students"));
 }
 #[test]fn merge_tiny_fragment_with_neighbor(){
  let raw=vec![
   Segment{start:0.0,end:0.4,text:"Right.".into()},
   Segment{start:0.65,end:2.4,text:"Let's check the booking details together.".into()},
  ];
  let refined=refine_segments(raw,&[]);
  assert_eq!(refined.len(),1);
  assert_eq!(refined[0].text,"Right. Let's check the booking details together.");
 }
}
