/**
 * Approval-card keyboard rule (mirrored in renderer `buildApprovalCard`).
 * Enter must activate the focused control: a focused button fires natively
 * (Deny/Allow/Always), any other target means Allow once. Escape means Deny
 * and is handled separately. Getting this wrong inverts user intent on
 * destructive actions, so the rule lives here with tests.
 */
export type ApprovalEnterAction = 'native' | 'allow';

/** tagName is 'BUTTON' (or similar) when focus is on a button; allowBtn marks Allow-once. */
export function approvalEnterAction(targetTag: string | null, isAllowButton: boolean): ApprovalEnterAction {
  if (targetTag === 'BUTTON' && !isAllowButton) return 'native';
  return 'allow';
}
