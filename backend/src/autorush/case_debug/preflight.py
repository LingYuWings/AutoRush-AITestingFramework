from urllib.parse import urlsplit
from fastapi import HTTPException
from autorush.agent.executions import validate_agent_configuration
from autorush.api.automation import check_desktop_target
from autorush.api_testing.engine import validate_url
from autorush.api_testing.nodes import needs_base_url, request_snapshot
from autorush.api_testing.variables import substitute, variable_values
from autorush.drivers.android.portal import validate_android_step
from autorush.drivers.desktop.contracts import validate_desktop_step
from autorush.drivers.web.validation import validate_web_step
from autorush.drivers.api.http import legacy_request


# Validate the selected drivers, targets and model before a debug run starts.
def check_debug(settings, store, plan, case, device_hub, api_store):
    steps = case.steps + case.postconditions
    if len(steps) > 120: raise ValueError('debug case exceeds 120 steps')
    kinds = {step.driver for step in steps}
    if 'web' in kinds:
        url = plan.web_base_url or ''
        parsed = urlsplit(url)
        if parsed.path not in {'', '/'}: raise ValueError('Web base URL must be an origin')
        validate_url(url, set(settings.allowed_web_hosts))
    if plan.api_base_url: validate_url(plan.api_base_url, set(settings.allowed_api_hosts))
    if 'desktop' in kinds: check_desktop_target(settings, plan)
    if 'android' in kinds:
        if not plan.android_device_id or not plan.android_package: raise ValueError('Android device and package are required')
        if str(plan.android_device_id) not in device_hub.list_devices(): raise ValueError('Android device is offline')
    if case.execution_mode == 'agent': validate_agent_configuration(settings, store, plan, [case])
    else:
        validators = {'web': validate_web_step, 'desktop': validate_desktop_step, 'android': validate_android_step}
        for step in steps:
            if step.driver in validators: validators[step.driver](step)
            elif step.operation != 'api.request': raise ValueError('unsupported API operation')
    for step in steps:
        if step.driver != 'api': continue
        if needs_base_url(step, api_store) and not plan.api_base_url: raise ValueError('relative API nodes require an API base URL')
        spec, inherited = request_snapshot(step, api_store)
        if spec is None: spec = legacy_request(step, plan.api_base_url)
        if spec:
            values = variable_values(inherited)[0]
            if plan.api_environment_snapshot_id:
                values.update(variable_values(api_store.get('environment_snapshots', plan.api_environment_snapshot_id)['variables'])[0])
            values.update(variable_values([item.model_dump() for item in spec.variables])[0])
            # Requests using a preceding extraction are rechecked by the engine at execution.
            try: url = substitute(spec.url, values)
            except ValueError: continue
            if isinstance(url, str) and not url.startswith('/') and '{{' not in url:
                validate_url(url, set(settings.allowed_api_hosts))
