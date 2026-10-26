"""Conservative local guard for explicitly non-mutating inspection instructions.

This recognizes a narrow set of clear English/Chinese instructions. It is not
a general natural-language authorization classifier.
"""
import re


def navigation_path(step):
    """Only an entire standalone Open instruction; composite intents are untouched."""
    if step.driver!='web':return None
    match=re.fullmatch(r'Open(?:\s+the\s+local\s+path)?\s+(?:"(?P<quoted>/[^"\r\n]*)"|`(?P<code>/[^`\r\n]*)`|(?P<plain>/[^\s]*?))[.。]?',step.intent.strip(),re.IGNORECASE)
    if match:return next(value for value in match.groupdict().values() if value is not None)
    return None


def action_scope_violation(step,decision):
    path=navigation_path(step)
    if path is not None and (decision.operation!='web.open' or decision.parameters.get('path')!=path):
        return 'standalone navigation intent only permits opening its literal path'
    readonly=read_only_operations(step)
    if readonly is not None and decision.operation not in readonly:
        return 'explicit read-only inspection intent forbids application mutation'
    return None


def read_only_operations(step):
    if step.driver not in {'web', 'desktop'}:
        return None
    intent = step.intent.strip().casefold()
    inspection = bool(re.match(r'^(inspect|check|observe)\b', intent)) or intent.startswith(('检查', '查看', '观察'))
    unchanged = bool(re.search(r'\bunchanged\b|\bwithout\s+changing\b', intent)) or any(
        phrase in intent for phrase in ('不修改', '不更改', '不做任何修改', '不做任何更改', '保持不变'))
    if not inspection or not unchanged:
        return None
    return {'web': {'web.inspect', 'web.wait'}, 'desktop': {'desktop.inspect_pixel'}}[step.driver]
