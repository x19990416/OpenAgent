import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentPlan } from './plan-types.js';
import { getOpenAgentPath } from '@openagent/runtime';

interface PlanIndex {
  activeByThread: Record<string, string | undefined>;
}

export class PlanStore {
  private readonly rootDir: string;
  private readonly indexPath: string;

  constructor(private readonly agentId: string) {
    this.rootDir = getOpenAgentPath('agents', agentId, 'sessions', 'plans');
    this.indexPath = path.join(this.rootDir, 'plans-index.json');
  }

  save(plan: AgentPlan) {
    const nextPlan = { ...plan, revision: plan.revision + 1, updatedAt: new Date().toISOString() };
    mkdirSync(this.getThreadDir(plan.threadId), { recursive: true });
    writeFileSync(this.getPlanPath(plan.threadId, plan.id), `${JSON.stringify(nextPlan, null, 2)}\n`, 'utf8');

    const index = this.readIndex();
    if (['completed', 'failed', 'cancelled'].includes(nextPlan.status)) {
      if (index.activeByThread[nextPlan.threadId] === nextPlan.id) {
        delete index.activeByThread[nextPlan.threadId];
      }
    } else {
      index.activeByThread[nextPlan.threadId] = nextPlan.id;
    }
    this.writeIndex(index);
    return nextPlan;
  }

  getActive(threadId: string) {
    const planId = this.readIndex().activeByThread[threadId];
    return planId ? this.read(threadId, planId) : null;
  }

  read(threadId: string, planId: string) {
    const planPath = this.getPlanPath(threadId, planId);
    if (!existsSync(planPath)) return null;
    try {
      return JSON.parse(readFileSync(planPath, 'utf8')) as AgentPlan;
    } catch {
      return null;
    }
  }

  list(threadId: string) {
    const threadDir = this.getThreadDir(threadId);
    if (!existsSync(threadDir)) return [];
    return readdirSync(threadDir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        const plan = this.read(threadId, name.slice(0, -'.json'.length));
        return plan ? [plan] : [];
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private getThreadDir(threadId: string) {
    return path.join(this.rootDir, threadId);
  }

  private getPlanPath(threadId: string, planId: string) {
    return path.join(this.getThreadDir(threadId), `${planId}.json`);
  }

  private readIndex(): PlanIndex {
    mkdirSync(this.rootDir, { recursive: true });
    if (!existsSync(this.indexPath)) return { activeByThread: {} };
    try {
      return JSON.parse(readFileSync(this.indexPath, 'utf8')) as PlanIndex;
    } catch {
      return { activeByThread: {} };
    }
  }

  private writeIndex(index: PlanIndex) {
    mkdirSync(this.rootDir, { recursive: true });
    writeFileSync(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }
}
