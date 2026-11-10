import React, { useContext, useEffect } from 'react';

/**
 * Pinning (#419, from the #417 review): a bloc with an OPEN enlarge overlay or source view must never be unmounted — not by the live-frame budget (BlocSlot) and
 * not by the windowed transcript (its row). BlocSlot provides `BlocPinContext`; the overlay/source code of BlocFrame calls `useBlocPin(open)`. Both default to a no-op.
 */
export type Pin = () => () => void;
export const BlocPinContext = React.createContext<Pin | null>(null);
/** Provided by the transcript's MeasuredRow: pins the ROW so the windowed list keeps it rendered. */
export const RowPinContext = React.createContext<Pin | null>(null);

export function useBlocPin(active: boolean): void {
  const pin = useContext(BlocPinContext);
  useEffect(() => (active && pin ? pin() : undefined), [active, pin]);
}
