"""First-party Hermes observability integrations."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def observe_lifecycle(hook_name: str, **kwargs: Any) -> None:
    """Dispatch a Hermes lifecycle event to built-in observability features."""
    from . import benaiah_outcome_relay, relay_shared_metrics

    _safe_observe(relay_shared_metrics.observe_lifecycle, hook_name, kwargs)
    _safe_observe(benaiah_outcome_relay.observe_lifecycle, hook_name, kwargs)


def handles_hook(hook_name: str) -> bool:
    """Return whether any built-in observability feature handles a hook."""
    from . import benaiah_outcome_relay, relay_shared_metrics

    return relay_shared_metrics.handles_hook(hook_name) or benaiah_outcome_relay.handles_hook(hook_name)


def start_task_run(**kwargs: Any) -> None:
    """Open task roots in each enabled first-party observability sink."""
    from . import benaiah_outcome_relay, relay_shared_metrics

    _safe_call(relay_shared_metrics.start_task_run, "task_start", kwargs)
    _safe_call(benaiah_outcome_relay.start_task_run, "task_start", kwargs)


def finish_task_run(**kwargs: Any) -> None:
    """Close task roots in each enabled first-party observability sink."""
    from . import benaiah_outcome_relay, relay_shared_metrics

    _safe_call(relay_shared_metrics.finish_task_run, "task_finish", kwargs)
    _safe_call(benaiah_outcome_relay.finish_task_run, "task_finish", kwargs)


def _safe_observe(callback: Any, hook_name: str, kwargs: dict[str, Any]) -> None:
    try:
        callback(hook_name, **kwargs)
    except Exception:
        logger.warning(
            "Built-in observability hook failed: %s", hook_name, exc_info=True
        )


def _safe_call(callback: Any, operation: str, kwargs: dict[str, Any]) -> None:
    try:
        callback(**kwargs)
    except Exception:
        logger.warning(
            "Built-in observability operation failed: %s", operation, exc_info=True
        )
