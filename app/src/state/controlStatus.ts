import { CONTROL_HOST_LABELS, observeControlHostStatus, type ControlHostStatus, type ControlStatusBridge } from '../../control-status';
import { createStore, useStore } from './store';
const controlStatus = createStore<ControlHostStatus>('unknown');
export function installControlHostStatus(bridge: ControlStatusBridge | undefined) {
  return observeControlHostStatus(bridge, status => controlStatus.set(status));
}
export function useControlHostLabel() {
  return useStore(controlStatus, status => CONTROL_HOST_LABELS[status]);
}
