import { useStore } from '../../store';

/** FI-2 (ledger #423): is the Bloc HTML rendering on? The Settings switch (#418), read from the host's echo — a flip re-renders every bloc at once. */
export function useBlocHtmlEnabled(): boolean {
  return useStore((s) => s.blocHtmlEnabled);
}
