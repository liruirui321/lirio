const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});const page=await browser.newPage();await page.goto(process.env.TEST_URL||'http://127.0.0.1:1432');
 const result=await page.evaluate(async()=>{
  const {grade,sentences}=await import('/src/services/dictation.ts');const {stripExamInstructions,isExamInstruction}=await import('/src/services/examInstructions.ts');const {listeningInsights}=await import('/src/services/listeningInsights.ts');const {analyze}=await import('/src/services/submissions.ts');
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  for(const [a,b] of [['three friends','3 friends'],['21 pounds','twenty-one pounds'],['one hundred and seventy acres','170 acres'],['one thousand eight hundred metres','1800 metres'],['4.95 pounds','four point nine five pounds'],['1,200 tickets','one thousand two hundred tickets']])assert(grade(a,b).correct,'Number equivalence '+a);
  assert(!grade('three friends','4 friends').correct,'Different number accepted');assert(!grade('3rd floor','4th floor').correct,'Different ordinal accepted');
  assert(grade('one and two','1 and 2').correct,'And between distinct numbers was swallowed');
  const name=grade('Sally works at Hinchingbrooke Country Park','noun works at noun');assert(name.placeholders===2&&!name.hasErrors&&!name.correct,'Name placeholders graded incorrectly');
  assert(grade('A noun is a word','a noun is a word').correct,'Literal noun became placeholder');assert(grade('The library opens at nine','noun').hasErrors,'Placeholder swallowed ordinary sentence');
  const base={id:'1',projectId:'p',projectName:'test',sentenceId:'s',start:0,end:10,attempt:1,submittedAt:'2026-10-23T00:00:00Z',recovered:false,assisted:false};
  const records=[{...base,expected:'There are three friends in London',answer:'there are 3 friends in noun'}];assert(analyze(records).wrong===0&&analyze(records).missing===0,'Equivalent/placeholder polluted history');assert(!listeningInsights(records).length,'Equivalent answers got pronunciation diagnoses');
  const errors=[{...base,expected:'We want to eat an apple',answer:'we want eat an apple'},{...base,id:'2',sentenceId:'other',expected:'They went to London',answer:'they went to London'}];
  const dict={want:'W AA N T',to:'T UW',eat:'IY T',an:'AE N',apple:'AE P AH L',we:'W IY'};const insights=listeningInsights(errors,dict);assert(insights.some(i=>i.kind==='弱读线索'&&i.word==='to'&&i.phrase.includes('want')&&i.otherCorrect===1),'Weak form/context evidence missing');assert(listeningInsights([{...base,expected:'We eat an apple',answer:'we eat apple'}],dict).some(i=>i.kind==='词边界／连读线索'),'Linking missing');
  assert(!listeningInsights([{...base,expected:'We want to eat an apple',answer:''}],dict).length,'Blank answer diagnosed');
  assert(!listeningInsights([{...base,expected:'a university',answer:'a universety'}],{a:'AH',university:'Y UW N AH V ER S AH T IY'}).some(i=>i.kind==='词边界／连读线索'),'Guessed vowels from spelling');
  for(const text of ['Listen carefully and answer questions 1 to 5.','Before you hear the rest of the discussion, you have some time to look at questions 21 to 26.','That is the end of Part 2.','Part 1 You will hear a woman calling about a job.'])assert(isExamInstruction(text),'Instruction retained '+text);
  for(const text of ['Now listen to the birds in the park.','We will answer questions after the lecture.','At the end of the road, turn left.'])assert(!isExamInstruction(text),'Content removed '+text);
  const ss=sentences([{text:'Listen carefully and answer questions 1 to 5.',start:0,end:2},{text:'Hello, how can I help you?',start:3,end:6}],8);assert(ss.length===1,'New subtitles retain prompts');
  const old={id:'x',dictation:{index:1,source:'test',sentences:[{id:'prompt',text:'That is the end of Part 1.',answer:'old answer',start:0,end:1},{id:'content',text:'Hello there.',answer:'my answer',start:2,end:3}]},favorites:[{id:'favorite'}]};const cleaned=stripExamInstructions(old);assert(cleaned.dictation.sentences.length===1&&cleaned.dictation.sentences[0].answer==='my answer'&&cleaned.dictation.index===0&&cleaned.dictationBackups[0].sentences[0].answer==='old answer'&&cleaned.favorites===old.favorites,'Progress lost during prompt filtering');
  return {passed:true,checks:['numeric equivalence and unequal-number rejection','multiword noun placeholders, literal noun and no blanket skipping','history recalculation without false errors','weak form, linking and prior correct evidence','blank-answer and spelling-boundary false positives','exam prompt filtering with progress/favorites preservation']};
 });console.log(JSON.stringify(result,null,2));await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
