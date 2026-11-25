import {invoke} from '@tauri-apps/api/core';
import {AudioEngine} from './audioEngine';
import {projectService} from './projectService';
import {useProjectStore} from '../stores/projectStore';
import {words} from './dictation';
import type {Submission} from './submissions';
import type {Project} from '../types/project';

export class ReviewAudio {
 private engine=new AudioEngine();private request=0;private loaded:{id:string;project:Project;track:string}|null=null;
 stop(){this.request++;this.engine.pause();}
 dispose(){this.stop();this.engine.dispose();}
 async play(record:Submission,phrase:string|null,rate=1,onEnded?:()=>void){
  this.stop();const request=this.request;
  if(this.loaded?.id!==record.projectId){
   const current=useProjectStore.getState();let project:Project;let buffer:ArrayBuffer;
   const local=current.project;
   if(local&&(local.id===record.projectId||local.libraryId===record.projectId)){
    project=local;const track=project.tracks.find(t=>t.type==='original');if(!track)throw Error('材料缺少原音频');
    const url=current.blobUrls.get(track.id);if(!url)throw Error('当前音频尚未加载');buffer=await (await fetch(url)).arrayBuffer();
   }else{
    const parsed=projectService.parse(await invoke<string>('library_open',{id:record.projectId}));
    try{project=parsed.project;const track=project.tracks.find(t=>t.type==='original');if(!track)throw Error('材料缺少原音频');buffer=await parsed.recordingBlobs.get(track.id)!.arrayBuffer();}
    finally{parsed.blobUrls.forEach(url=>URL.revokeObjectURL(url));}
   }
   if(request!==this.request)return '已取消';
   const track=project.tracks.find(t=>t.type==='original')!;await this.engine.loadAudio(track.id,buffer);
   if(request!==this.request)return '已取消';
   this.engine.retainBuffers([track.id]);this.loaded={id:record.projectId,project,track:track.id};
  }
  const {project,track}=this.loaded;let start=record.start,end=record.end;let note='原句';
  if(phrase){
   const ws=(project.dictation?.words||[]).filter(w=>w.start>=record.start-.3&&w.end<=record.end+.3);
   const target=words(phrase);const seq=ws.flatMap(w=>words(w.text).map(text=>({...w,text})));
   const at=seq.findIndex((_,i)=>target.every((word,j)=>seq[i+j]?.text===word));
   if(at>=0&&target.length){start=Math.max(record.start,seq[at].start-.15);end=Math.min(record.end,seq[at+target.length-1].end+.2);note='语块';}
   else note='未匹配词级时间，改播原句';
  }
  if(request!==this.request)return '已取消';
  if(start<0||end<=start||end>project.duration+.1)throw Error('旧记录时间与当前音频不匹配，请打开原项目核对');
  await this.engine.playRange(track,start,end,rate,()=>{if(request===this.request)onEnded?.();});return note;
 }
}
