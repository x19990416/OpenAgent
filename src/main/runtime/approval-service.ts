export class ApprovalService {
  requiresApproval(actionType: string) {
    return ['shell', 'git.push', 'git.reset', 'external-path-write', 'destructive'].includes(actionType);
  }
}
