/** The confirmation a Bloc HTML's refused navigation raises (#416): `url` is the COMPLETE target; the renderer answers by `id`, never by URL. */
export interface BlocNavigationRequest {
  id: string;
  url: string;
}

/** « Open link » answers only for the request it was armed for: a retract+replace in the arming window must not let a click confirm a URL the human never read. */
export function openArmed(armedFor: string | null, shownId: string | null): boolean {
  return shownId !== null && armedFor === shownId;
}
