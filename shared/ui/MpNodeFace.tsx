// Moshpit's node face, extracted from GraphCanvas. State and commands stay in the consumer adapter.
import type { CSSProperties, ReactNode } from 'react';
import { CATS, DOMAIN_SHORT, edgeStyle, type EdgeType } from './nodeStyle';
import { MpParameterField } from './MpParameterField';
import type { NodePresentation, PortDescriptor } from '../graph/registry';
import './node.css';
export type PortDirection = 'in' | 'out';
export function MpPortFace({ port, direction }: { port: PortDescriptor; direction: PortDirection }) {
  const style = edgeStyle(port.type as EdgeType, port.subtype);
  return <span className={'mp-port-face ' + (style?.domain ?? 'unknown') + (port.type === 'Field' ? ' ring' : '')}
    data-port-available={port.available !== false} data-port-key={port.key} data-port-direction={direction} data-port-type={port.type}
    title={`${port.label} · ${style?.label ?? port.type}${port.help ? ' — ' + port.help : ''}`}
    style={{ '--pc': style?.stroke ?? 'var(--txt-3)' } as CSSProperties} aria-hidden="true" />;
}
interface CommonProps {
  model: NodePresentation; selected?: boolean; viewed?: boolean; frozen?: boolean; bypassed?: boolean;
  bpm?: number; seconds?: boolean; onSelect?: () => void;
  /** Consumer mounts its graph-library Handle around the canonical socket face. Inspect consumers MUST disable connections. */
  renderPort?: (port: PortDescriptor, direction: PortDirection, face: ReactNode) => ReactNode;
}
type EditProps = CommonProps & { mode: 'edit'; headerActions?: ReactNode; viewerAction?: ReactNode;
  attachment?: ReactNode; renderParameter?: (parameterKey: string) => ReactNode; containerHint?: ReactNode };
type InspectProps = CommonProps & { mode: 'inspect'; headerActions?: never; viewerAction?: never;
  attachment?: never; renderParameter?: never; containerHint?: never };
export type MpNodeFaceProps = EditProps | InspectProps;
export function MpNodeFace(props: MpNodeFaceProps) {
  const { model: m, selected, viewed, frozen, onSelect } = props;
  const def = m.definition, container = m.kind === 'group.container';
  const C = CATS[def?.category as keyof typeof CATS] ?? CATS.Effect;
  const unsupported = m.status !== 'supported';
  const bypassed = props.bypassed ?? m.bypassed;
  const editing = props.mode === 'edit' && !m.readOnly;
  const socket = (p: PortDescriptor, dir: PortDirection) => {
    const face = <MpPortFace port={p} direction={dir} />;
    return props.renderPort ? props.renderPort(p, dir, face) : <span className={'mp-port-anchor ' + dir}>{face}</span>;
  };
  const ports = <div className="gports">
    {m.outputs.map(p => <div key={'o'+p.key} className="prow out"><span className="plabel">{p.label}</span>{socket(p,'out')}</div>)}
    {m.inputs.map(p => <div key={'i'+p.key} className="prow in">{socket(p,'in')}<span className="plabel">{p.label}{p.cardinality === 'optional-one' && <em> opt</em>}</span></div>)}
  </div>;
  const isReroute = !unsupported && (m.kind === 'route.reroute' || m.kind === 'route.reroute-stream');
  if (isReroute) return <div className={'mp-node-face gnode rf reroute'+(selected?' sel':'')} data-node-id={m.id} data-mode={props.mode} title={`${m.label}: ${def?.blurb ?? ''}`} onClick={onSelect}>
    <div className="prow">{m.inputs[0] && socket(m.inputs[0],'in')}<span className="plabel" aria-hidden>{m.kind === 'route.reroute' ? '·' : '▪'}</span>{m.outputs[0] && socket(m.outputs[0],'out')}</div>
    {editing && props.attachment}
  </div>;
  const shown = container ? m.parameters.slice(0,4) : (m.parameters.some(p=>p.spec.onNode) ? m.parameters.filter(p=>p.spec.onNode) : m.parameters).slice(0,3);
  return <div className={'mp-node-face gnode rf'+(selected?' sel':'')+(viewed?' viewed':'')+(frozen?' frozen':'')+(bypassed?' bypassed':'')+(unsupported?' legacy':'')+(container?' container':def?.category === 'Source'?' gen':'')}
    data-node-id={m.id} data-node-kind={m.kind} data-mode={props.mode} data-definition-status={m.status}
    style={container ? undefined : { borderLeftColor:C.accent }} title={def ? `${m.label} — ${def.blurb}` : `Unsupported node: ${m.kind}; saved data retained`} onClick={onSelect}>
    {def?.impl.preview === 'PROXY' && <span className="badge-baked" title="Definition declares a proxy preview; this is not execution evidence">≈ proxy</span>}
    {frozen && <span className="frzflag">cached</span>}{bypassed && <span className="bypflag">bypassed</span>}
    <div className="gt" style={container ? undefined : {background:`linear-gradient(90deg, color-mix(in srgb, ${C.accent} 16%, transparent), transparent)`,borderBottomColor:`color-mix(in srgb, ${C.accent} 35%, transparent)`}}>
      <span className={'cbadge'+(container?' ctr':'')} style={container?undefined:{color:C.accent,borderColor:C.accent}}>{container?'▸':C.icon}</span>
      <span className="gname">{m.label}</span><span className="cattag" style={{color:C.accent}}>{container?`${m.containerSummary?.count ?? 0} nodes`:def?.category ?? '?'}</span>
      {editing && props.headerActions}
    </div>
    {(m.inputs.length>0 || m.outputs.length>0) && ports}
    <div className="gb">
      {shown.map(p => editing && p.supported && p.base.available && props.renderParameter ? <span className="mp-param-slot" key={p.spec.key}>{props.renderParameter(p.spec.key)}</span> :
        <MpParameterField key={p.spec.key} mode="inspect" spec={p.spec} value={p.base.available ? p.base.value : p.storedValue}
          fieldKey={`${m.id}|${p.spec.key}`} variant="mini" bpm={props.bpm ?? NaN} seconds={props.seconds ?? false}
          unavailable={!p.base.available ? p.base.reason : undefined} mod={p.driver ? 'bound · base' : undefined} />)}
      {container && <div className="pf ctrpath">{[...new Set([...m.inputs,...m.outputs].map(p=>DOMAIN_SHORT[p.type as EdgeType] ?? p.type))].join(' → ') || 'no ports'}</div>}
      {Object.keys(m.unknownParams).length > 0 && <details className="mp-node-raw" onClick={e => e.stopPropagation()}><summary>Saved values ({Object.keys(m.unknownParams).length})</summary><pre>{JSON.stringify(m.unknownParams,null,2)}</pre></details>}
      {m.diagnostics.map((d,i)=><div key={i} className="pf mp-node-diagnostic">{d}</div>)}
      {container && <div className="pf ctrinner">{m.containerSummary?.labels.join(' · ') || 'empty'}</div>}
      {editing && props.containerHint}
    </div>
    {editing && props.viewerAction}{editing && props.attachment}
  </div>;
}
