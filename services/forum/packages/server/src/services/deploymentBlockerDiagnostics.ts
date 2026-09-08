import type { DeploymentBlocker } from '@irrigationreal/codex-forum-core';

import type { ForumStore } from '../store';

const DEPLOYMENT_BLOCKER_ITEM_LIMIT = 20;

function withBoundedItems<T>(code: string, count: number, items: T[]): DeploymentBlocker | null {
  if (count === 0) return null;
  return {
    code,
    count,
    items,
    item_limit: DEPLOYMENT_BLOCKER_ITEM_LIMIT,
    truncated: count > items.length,
    omitted_count: Math.max(0, count - items.length),
  };
}

export function actionablePostDispatchBlocker(store: ForumStore): DeploymentBlocker | null {
  const count = store.countGlobalActionablePostDispatches();
  return withBoundedItems(
    'actionable_post_dispatches',
    count,
    store.listGlobalActionablePostDispatchItems(DEPLOYMENT_BLOCKER_ITEM_LIMIT)
  );
}

export function nonIdleRobotStateBlocker(store: ForumStore): DeploymentBlocker | null {
  const count = store.countDeploymentBlockingRobotStates();
  return withBoundedItems(
    'non_idle_robot_states',
    count,
    store.listDeploymentBlockingRobotStateItems(DEPLOYMENT_BLOCKER_ITEM_LIMIT)
  );
}
