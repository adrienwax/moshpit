// App adapter: shared fields never import project history, settings, or radial-menu state.
import { MpParameterField, MpNumberField, type ParamSpec, type NumberFieldProps } from '../../../shared/ui/MpParameterField';
import { toggleSeconds, useUi } from '../state/ui';
import { beginGesture, endGesture, useProject } from '../state/project';
import { RadialPick } from '../radial/RadialPick';
import './scrub-fields.css';
export { fmtValue, parseTyped, type ParamSpec } from '../../../shared/ui/MpParameterField';
interface Props {
  spec: ParamSpec; value: unknown; onChange: (v: number | boolean | string) => void;
  fieldKey: string; variant: 'mini' | 'full'; mod?: string; disabled?: boolean; resetValue?: unknown;
}
export function NumberField(props: Omit<NumberFieldProps, 'onGestureStart' | 'onGestureEnd'>) {
  return <MpNumberField {...props} onGestureStart={beginGesture} onGestureEnd={endGesture} />;
}
export function ParamControl(props: Props) {
  const bpm = useProject(d => d.settings.bpm);
  const musicalDefault = useProject(d => d.settings.timeDisplay === 'musical');
  const flipped = useUi(s => !!s.seconds[props.fieldKey]);
  return <MpParameterField {...props} mode="edit" bpm={bpm} seconds={musicalDefault === flipped}
    onToggleUnits={() => toggleSeconds(props.fieldKey)} onGestureStart={beginGesture} onGestureEnd={endGesture}
    renderEnum={({spec,value,options,onChange}) => <RadialPick title={spec.label} className="enumbtn nodrag" value={value} hint={spec.help}
      options={options.map(o => ({label:o,value:o,color:'var(--fn-interactive)'}))} onChange={onChange} label={value} />} />;
}
