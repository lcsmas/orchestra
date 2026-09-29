// The ONE composer of the bus verb slice (BusVerbCtx['bus']) — used by src/cli/index.ts and the
// e2e-bus-wake rig, so a new verb dependency is a tsc error here instead of silent rig rot (#223).
import type { BusVerbCtx } from './bus-verbs.ts';

export function composeBusVerbSlice(
  bus: typeof import('../main/bus.ts'),
  busRuns: typeof import('../main/bus-runs.ts'),
  receipts: typeof import('../main/bus-receipts.ts'),
): BusVerbCtx['bus'] {
  return {
    send: bus.send,
    check: bus.check,
    ack: bus.ack,
    openGate: bus.openGate,
    resolveGate: bus.resolveGate,
    getGate: bus.getGate,
    sendGateResolutionRewake: bus.sendGateResolutionRewake,
    openGatesForRecipient: bus.openGatesForRecipient,
    openGatesForRecipientInRuns: bus.openGatesForRecipientInRuns,
    getRelatedRunIds: busRuns.getRelatedRunIds,
    getRun: busRuns.getRun,
    fencedWrite: bus.fencedWrite,
    mintCapability: bus.mintCapability,
    verifyCapability: bus.verifyCapability,
    rotateCapabilityForRecipient: bus.rotateCapabilityForRecipient,
    withReceipt: receipts.withReceipt,
    busSwitch: busRuns.busSwitch,
  };
}
