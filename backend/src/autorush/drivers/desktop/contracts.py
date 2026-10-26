"""Desktop actions accepted by both the API and isolated worker."""
from autorush.domain.models import StepSpec

HOTKEYS = {('ctrl','a'), ('tab',), ('shift','tab'), ('enter',), ('esc',), ('backspace',),
           ('delete',), ('home',), ('end',), ('left',), ('right',), ('up',), ('down',)}


def validate_desktop_step(step: StepSpec) -> None:
    op, p = step.operation, step.parameters
    fields = {'desktop.click': {'x','y','button'}, 'desktop.scroll': {'x','y','clicks'},
              'desktop.write': {'text'}, 'desktop.hotkey': {'keys'}, 'desktop.inspect_pixel': {'x','y'}}
    if step.driver != 'desktop' or op not in fields or set(p)-fields[op]:
        raise ValueError('unsupported desktop operation or parameters')
    if op in {'desktop.click','desktop.scroll','desktop.inspect_pixel'}:
        if any(type(p.get(k)) is not int or not 0 <= p[k] <= 16384 for k in ('x','y')):
            raise ValueError('desktop coordinates must be nonnegative integers')
    if op == 'desktop.click' and (not isinstance(p.get('button','left'),str) or p.get('button','left') not in {'left','middle','right'}):
        raise ValueError('invalid mouse button')
    if op == 'desktop.scroll' and (type(p.get('clicks')) is not int or not 1 <= abs(p['clicks']) <= 20):
        raise ValueError('scroll clicks must be a nonzero integer in -20..20')
    if op == 'desktop.write':
        text=p.get('text')
        if not isinstance(text,str) or not 1 <= len(text) <= 1000 or not text.isascii() or not text.isprintable():
            raise ValueError('desktop.write requires 1-1000 printable ASCII characters')
    if op == 'desktop.hotkey':
        keys=p.get('keys')
        if not isinstance(keys,list) or any(not isinstance(k,str) for k in keys) or tuple(keys) not in HOTKEYS:
            raise ValueError('hotkey is not in the allowlist')
