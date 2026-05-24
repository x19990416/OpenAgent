# @openagent/planning

Agent Plan Mode domain package: plan types, persistence, lifecycle service, and step executor.

This package intentionally does not call model providers directly. Desktop or another host injects an optional `PlanLlmProvider` into `PlanService`, keeping planning free of Pi/provider dependencies and avoiding runtime adapter cycles.
