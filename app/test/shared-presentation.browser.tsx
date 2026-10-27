import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MpNodeFace } from '../../shared/ui/MpNodeFace';
import { MpParameterField } from '../../shared/ui/MpParameterField';
import { MOSHPIT_REGISTRY, resolveNodePresentation } from '../../shared/graph';
import { ParamControl } from '../src/params/Param';
import { addBlock, addSource, appendEffect, emptyDoc, getDoc, projectStore, setParam, undo, redo, useProject, endGesture } from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';
import '../../shared/ui/tokens.css';
const raw={id:'original',kind:'fx.chroma-trail',defVersion:1,params:{amount:35,spread:50},bindings:{spread:{lfo:'unavailable'}}};
const before=JSON.stringify(raw);
let block:string, node:string;
let callbacks=0,selected=0;
function reset(){
  endGesture();projectStore.set({doc:emptyDoc(),past:[],future:[]});
  addSource(demoProject().resources.sources[0]);block=addBlock(getDoc().resources.sources[0].id,0,24,'picture');
  appendEffect(block,'fx.chroma-trail');node=getDoc().timeline.blocks[0].graph.nodes.find(n=>n.kind==='fx.chroma-trail')!.id;
  projectStore.set(s=>({...s,past:[],future:[]}));
}
reset();
const spec={label:'Spread',type:'float',min:0,max:100,step:.5,default:0,initial:50,unit:'%'};
function App(){
  const value=useProject(d=>d.timeline.blocks[0].graph.nodes.find(n=>n.id===node)!.params.spread);
  const [field,setField]=useState('a');
  return <><h1>Canonical shared presentation · browser verification</h1>
    <section id="inspect"><MpNodeFace mode="inspect" model={resolveNodePresentation(MOSHPIT_REGISTRY,raw)} onSelect={()=>selected++}/>
      <MpNodeFace mode="inspect" model={resolveNodePresentation(MOSHPIT_REGISTRY,{...raw,id:'unknown',kind:'future.kind',params:{opaque:{foo:'retained'}}})}/>
      <MpParameterField mode="inspect" spec={spec} value={150} unavailable="Invalid stored value" fieldKey="raw" variant="full" bpm={NaN} seconds={false}/>
    </section>
    <section id="edit"><h2>Actual Moshpit adapter + history (mock engine)</h2><ParamControl spec={spec} value={value} fieldKey={field} variant="full" onChange={v=>{callbacks++;setParam(block,node,'spread',v)}}/>
    <button id="switch" onPointerDown={()=>setField(field==='a'?'b':'a')}>Change selected field</button></section></>;
}
Object.assign(window,{qa:{reset,undo,redo,state:()=>({value:getDoc().timeline.blocks[0].graph.nodes.find(n=>n.id===node)!.params.spread,past:projectStore.get().past.length,future:projectStore.get().future.length,callbacks,selected,raw:JSON.stringify(raw),before,cursor:document.body.style.cursor})}});
createRoot(document.getElementById('root')!).render(<App/>);
