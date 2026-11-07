"""Shared semantic mapping; never infer a missing action or expectation."""
import hashlib
import json
import math
import re
from urllib.parse import urlsplit

from pydantic import ValidationError

from autorush.api_testing.models import ApiRequest
from autorush.domain.models import CaseCreate
from .models import ImportCandidate, ImportDiagnostic, ImportOptions, ImportSource

CASE_PREFIX = re.compile(r'^(?:用例|Case)\s*[:：]\s*(.*)$', re.IGNORECASE)
PLATFORMS = {'web': 'web', 'android': 'android', 'desktop': 'desktop', 'gui': 'desktop', 'api': 'api'}


# Create a source-linked issue for the import preview.
def diagnostic(code, message, *, field=None, source=None, warning=False):
    return ImportDiagnostic(code=code, message=message, field=field, source=source,
                            severity='warning' if warning else 'error')


# Parse API request blocks without accepting duplicate keys or nonfinite values.
def strict_json(text):
    # Reject ambiguous duplicate JSON object keys.
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result

    # Reject nonstandard numeric constants in imported JSON.
    def reject_constant(value):
        raise ValueError('non-finite JSON number')

    # Reject numbers that overflow to infinity during decoding.
    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('non-finite JSON number')
        return number

    return json.loads(text, object_pairs_hook=pairs, parse_constant=reject_constant, parse_float=finite_float)


# Resolve an explicit or default platform and record any invalid input.
def platform(value, default, issues, source, field='platform'):
    if value is None:
        if default is None:
            issues.append(diagnostic('platform_required', '请选择执行端。', field=field, source=source))
        return default
    normalized = PLATFORMS.get(value.strip().casefold())
    if normalized is None:
        issues.append(diagnostic('invalid_platform', '执行端必须为 web、android、desktop 或 api。', field=field, source=source))
    return normalized


# Validate a source API request block before mapping it to a step.
def api_block(text, issues, source):
    try:
        value = strict_json(text)
        if not isinstance(value, dict) or set(value) != {'order', 'request'}:
            raise ValueError('API block requires order and request only')
        if type(value['order']) is not int or value['order'] < 1:
            raise ValueError('invalid step order')
        if not isinstance(value['request'], dict) or not {'name', 'method', 'url'}.issubset(value['request']):
            raise ValueError('explicit request fields required')
        request = ApiRequest.model_validate(value['request'])
        if request.collection_id or request.folder_id:
            raise ValueError('external references are not portable')
        parsed = urlsplit(request.url)
        if not request.url or (not request.url.startswith('/') and
                               (parsed.scheme not in {'http', 'https'} or not parsed.netloc)):
            raise ValueError('invalid request URL')
        if request.url.startswith('//') or parsed.username or parsed.password:
            raise ValueError('invalid request authority')
        return value['order'], request.model_dump(mode='json')
    except (ValueError, TypeError, ValidationError, RecursionError):
        issues.append(diagnostic('invalid_api_request', 'API 块须包含有效的 order 和 request，不允许引用外部集合或快照。', source=source))
        return None


# Convert source data into a case draft with diagnostics for review.
def build_candidate(*, title, platform_value, description, rows, post_rows, api_requests,
                    post_api_requests, source: ImportSource, identity, options: ImportOptions, issues):
    chosen = platform(platform_value, options.default_platform, issues, source)

    # Build ordered steps and associate API request blocks by source step number.
    def steps(values, requests, label):
        result = []
        seen = set()
        for index, row in enumerate(values, 1):
            row_source = row.get('source', source)
            field = f'{label}.{index - 1}'
            raw_order = row.get('order', '')
            try:
                order = int(raw_order)
                if isinstance(raw_order, bool) or str(order) != str(raw_order).strip() or order != index:
                    raise ValueError('non-sequential step')
            except (ValueError, TypeError):
                order = index
                issues.append(diagnostic('step_order', '步骤序号须从 1 开始连续排列，不能重复。', field=field, source=row_source))
            driver = platform(row.get('platform') or None, chosen, issues, row_source, f'{field}.driver')
            intent = row.get('intent', '').strip()
            expected = row.get('expected', '').strip()
            if not intent:
                issues.append(diagnostic('intent_required', '请补齐操作。', field=f'{field}.intent', source=row_source))
            always_raw = row.get('always_run', '').strip().casefold()
            if always_raw not in {'', '是', '否', 'true', 'false'}:
                issues.append(diagnostic('invalid_always_run', '始终执行只能为是、否、true 或 false。', field=field, source=row_source))
            always = always_raw in {'是', 'true'}
            if always and label != 'postconditions':
                issues.append(diagnostic('invalid_always_run', '始终执行仅可用于后置步骤。', field=field, source=row_source))
            step = dict(order=order, intent=intent, driver=driver, expected_result=expected or None,
                        operation=None, parameters={}, assertions=[], always_run=always)
            if driver == 'api':
                request = requests.get(order)
                if request is None:
                    issues.append(diagnostic('api_request_required', 'API 步骤需要对应的 autorush-api 请求块。', field=field, source=row_source))
                else:
                    seen.add(order)
                    step.update(operation='api.request', parameters={'request': request})
                    if not request['assertions']:
                        issues.append(diagnostic('api_no_assertions', 'API 请求没有结构化断言，文字预期不会自动转成断言。', field=field, source=row_source, warning=True))
            elif not expected:
                issues.append(diagnostic('expected_required', '请补齐预期结果。', field=f'{field}.expected_result', source=row_source))
            result.append(step)
        if set(requests) - seen:
            issues.append(diagnostic('unmatched_api_request', 'API 请求块未匹配到本节的 API 步骤。', field=label, source=source))
        return result

    draft = dict(title=title.strip(), description=description.strip(), platform=chosen,
                 execution_mode='structured' if chosen == 'api' else 'agent',
                 steps=steps(rows, api_requests, 'steps'),
                 postconditions=steps(post_rows, post_api_requests, 'postconditions'))
    try:
        CaseCreate.model_validate(draft)
    except ValidationError as error:
        # Do not copy Pydantic input values (possibly credentials) into diagnostics.
        for item in error.errors(include_input=False, include_context=False, include_url=False):
            issues.append(diagnostic('case_validation', '候选内容未通过现有用例校验，请检查字段和执行端。',
                                     field='.'.join(str(part) for part in item['loc']) or 'case', source=source))
    return ImportCandidate(candidate_id=hashlib.sha256(identity.encode()).hexdigest()[:32],
                           source=source, draft=draft, diagnostics=issues)
