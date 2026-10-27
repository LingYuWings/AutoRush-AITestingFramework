"""Serial case runner with explicit driver registration and cleanup semantics."""

from __future__ import annotations

from collections.abc import Mapping
import asyncio
from uuid import UUID

from autorush.assertions.evaluate import evaluate_assertion
from autorush.domain.models import CaseRecord, CaseResult, ResultStatus, StepResult, StepSpec
from autorush.drivers.base import Driver, DriverBlockedError
from autorush.api_testing.variables import ApiBlocked


class Runner:
    def __init__(self, drivers: Mapping[str, Driver]) -> None:
        self._drivers = drivers

    async def run_case(self, case: CaseRecord, *, on_progress=None) -> CaseResult:
        self.begin_case()
        results: list[StepResult] = []
        async def progress(current=None):
            if on_progress is not None:await on_progress(results,current)
        failed = False
        for step in sorted(case.steps, key=lambda item: item.order):
            if failed:
                results.append(StepResult(order=step.order, intent=step.intent, status=ResultStatus.SKIPPED))
                await progress()
                continue
            await progress(step)
            result = await self._run_step(step)
            results.append(result)
            await progress()
            failed = result.status != ResultStatus.PASSED
        for step in sorted(case.postconditions, key=lambda item: item.order):
            if step.always_run or not failed:
                await progress(step)
                results.append(await self._run_step(step))
            else:
                results.append(StepResult(order=step.order, intent=step.intent, status=ResultStatus.SKIPPED))
            await progress()
        main_results = results[: len(case.steps)]
        case_status = next(
            (result.status for result in main_results if result.status in {ResultStatus.ERROR, ResultStatus.BLOCKED}),
            ResultStatus.FAILED if any(result.status == ResultStatus.FAILED for result in main_results) else ResultStatus.PASSED,
        )
        if case_status == ResultStatus.PASSED and any(result.status != ResultStatus.PASSED for result in results):
            case_status = ResultStatus.ERROR
        return CaseResult(case_id=case.id, title=case.title, status=case_status, steps=results)

    async def _run_step(self, step: StepSpec, *, capture_evidence:bool=True) -> StepResult:
        driver = self._drivers.get(step.driver)
        if driver is None:
            return StepResult(order=step.order, intent=step.intent, status=ResultStatus.BLOCKED, detail=f"{step.driver} driver is not registered")
        if not step.operation:
            return StepResult(order=step.order, intent=step.intent, status=ResultStatus.BLOCKED, detail="step has no compiled operation")
        try:
            if step.driver != 'api':
                from autorush.api_testing.nodes import resolve_ui_step
                step = resolve_ui_step(step, self._drivers)
            action = await driver.execute(step)
            checks = [*action.checks, *[evaluate_assertion(assertion, action.output) for assertion in step.assertions]]
            status = action.status or (ResultStatus.PASSED if all(ok for ok, _ in checks) else ResultStatus.FAILED)
            result = StepResult(order=step.order, intent=step.intent, status=status, detail=action.summary, assertions=[text for _, text in checks], evidence=action.evidence)
        except (DriverBlockedError, ApiBlocked) as exc:
            result = StepResult(order=step.order, intent=step.intent, status=ResultStatus.BLOCKED, detail=str(exc))
        except Exception as exc:
            result = StepResult(order=step.order, intent=step.intent, status=ResultStatus.ERROR, detail=f"{type(exc).__name__}: {exc}")
        capture = getattr(driver, "capture_evidence", None)
        if capture_evidence and callable(capture):
            try:
                result.evidence.update(await capture())
            except Exception as exc:
                result.evidence["screenshot_error"] = f"{type(exc).__name__}: {exc}"
                if result.status == ResultStatus.PASSED:
                    result.status = ResultStatus.ERROR
                    result.detail += "; screenshot evidence could not be captured"
        sanitizer = getattr(self._drivers.get('api'), 'sanitize_result', None)
        return sanitizer(result) if sanitizer else result

    def begin_case(self):
        for driver in self._drivers.values():
            reset = getattr(driver, 'begin_case', None)
            if callable(reset): reset()

    async def execute_step(self,step:StepSpec,*,capture_evidence:bool=True) -> StepResult:
        return await self._run_step(step,capture_evidence=capture_evidence)

    async def close(self) -> None:
        results=await asyncio.gather(*(driver.close() for driver in self._drivers.values()),return_exceptions=True)
        errors=[result for result in results if isinstance(result,BaseException)]
        if errors: raise BaseExceptionGroup('driver cleanup failed',errors)
