/**
 * Window-focus refocus rule (mirrored in renderer focus listener).
 * The composer grabs focus on popup show, EXCEPT while the user is
 * deciding on an approval card — stealing focus there strands keyboard
 * users on the composer and silently disarms Deny-by-default.
 */
export function shouldRefocusComposer(tag: string | null, inApprovalCard: boolean): boolean {
  if (inApprovalCard) return false;
  if (!tag) return true;
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT';
}
