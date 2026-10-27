import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MpNodeFace, MpPortFace } from '../../shared/ui/MpNodeFace';
import { MpParameterField, inspectValue } from '../../shared/ui/MpParameterField';
import { resolveNodePresentation, type RegistrySnapshot, type NodeLike } from '../../shared/graph/registry';
import snapshot from '../../shared/graph/registry.json';
import fs from 'node:fs';
import path from 'node:path';
const registry = snapshot as RegistrySnapshot;
const hue: NodeLike = {id:'original-hue',kind:'fx.hue-rotate',defVersion:1,label:'Same label',params:{degrees:90},bindings:{}};
const spec = {label:'Amount',type:'float',default:0,initial:50,min:0,max:100,unit:'%'};
const inspect = (value: unknown, more = {}) => renderToStaticMarkup(h(MpParameterField,{mode:'inspect',spec,value,fieldKey:'original|amount',variant:'full',bpm:120,seconds:false,...more} as any));
describe('canonical shared node inspection',()=>{
  it('renders definition ports without consulting wires, preserving node and port keys',()=>{
    const model=resolveNodePresentation(registry,hue),before=JSON.stringify(hue);
    const html=renderToStaticMarkup(h(MpNodeFace,{mode:'inspect',model,selected:true}));
    expect(html).toContain('data-node-id="original-hue"');
    for(const port of [...model.inputs,...model.outputs])expect(html).toContain(`data-port-key="${port.key}"`);
    expect(html).toContain('90°');expect(JSON.stringify(hue)).toBe(before);
  });
  it('ignores smuggled editing slots and callbacks in inspect mode',()=>{
    const fail=()=>{throw Error('inspect executed an editor callback')};
    const html=renderToStaticMarkup(h(MpNodeFace,{mode:'inspect',model:resolveNodePresentation(registry,hue),renderParameter:fail,headerActions:h('button',null,'EDIT'),viewerAction:h('button',null,'RENDER')} as any));
    expect(html).not.toContain('<button');expect(html).not.toContain('role="slider"');
    expect(inspect(20,{onChange:fail,onGestureStart:fail,renderEnum:fail})).not.toContain('<input');
  });
  it('keeps raw false, zero, empty, null, missing, and out-of-range values distinguishable',()=>{
    expect(inspectValue(spec,false,120,false)).toBe('false');
    expect(inspectValue(spec,0,120,false)).toBe('0%');
    expect(inspectValue(spec,'',120,false)).toBe('""');
    expect(inspectValue(spec,null,120,false)).toBe('null');
    expect(inspectValue(spec,undefined,120,false)).toBe('missing');
    expect(inspect(140,{unavailable:'Invalid stored value'})).toContain('140');
    expect(inspect(140,{unavailable:'Invalid stored value'})).toContain('Invalid stored value');
  });
  it('cannot turn unknown types or unknown definitions into working controls',()=>{
    expect(inspect({opaque:42},{spec:{...spec,type:'pulse'}})).toContain('Unsupported type: pulse');
    const raw={...hue,kind:'future.unknown',params:{opaque:{x:7}}};
    const html=renderToStaticMarkup(h(MpNodeFace,{mode:'inspect',model:resolveNodePresentation(registry,raw)}));
    expect(html).toContain('Unsupported unknown definition');expect(raw.params.opaque.x).toBe(7);
  });
  it('preserves invalid fractional integers and numeric boolean/enum values exactly',()=>{
    expect(inspectValue({...spec,type:'int'},1.5,120,false)).toBe('1.5');
    expect(inspectValue({...spec,type:'bool'},1,120,false)).toBe('1');
    expect(inspectValue({...spec,type:'enum'},1.5,120,false)).toBe('1.5');
    expect(inspect(140.123456,{unavailable:'Invalid stored value'})).toContain('140.123456');
  });
  it('uses inert raw fallback for an invalid parameter even in edit mode',()=>{
    const model=resolveNodePresentation(registry,{...hue,params:{degrees:900}});
    const html=renderToStaticMarkup(h(MpNodeFace,{mode:'edit',model,renderParameter:()=>{throw Error('invalid control')}}));
    expect(html).toContain('900');expect(html).toContain('Invalid stored value');
  });
  it('shows unavailable tempo without silently choosing 120 BPM',()=>{
    expect(inspectValue({...spec,type:'beats'},4,NaN,true)).toBe('4 beats · BPM unavailable');
  });
  it('uses canonical socket shape independent from graph-library handles',()=>{
    for(const [type,shape] of [['VideoFrame','pix'],['EncodedVideoStream','enc'],['Scalar','ctl']]){
      const html=renderToStaticMarkup(h(MpPortFace,{port:{key:'saved',label:'Same label',type},direction:'in'}));
      expect(html).toContain(`mp-port-face ${shape}`);expect(html).toContain('data-port-key="saved"');
    }
  });
  it('has no app/engine/CT/filesystem runtime imports in shared presentation',()=>{
    const root=path.resolve(import.meta.dirname,'../../shared');
    for(const file of ['ui/MpNodeFace.tsx','ui/MpParameterField.tsx','ui/nodeStyle.ts','ui/musicalTime.ts','graph/registry.ts']){
      const text=fs.readFileSync(path.join(root,file),'utf8');
      expect(text.match(/(?:from|import)\s*['"][^'"]+['"]/g)?.join(' ')??'').not.toMatch(/@moshpit|node:|app\/|engine\/|state\//);
    }
  });
});
