"""Read only the authorized package's complete accessibility snapshot."""
from collections import Counter
from autorush.agent.observers import AgentObserver,fingerprint


class AndroidObserver(AgentObserver):
    kind='android'


def on_screen(nodes):
    """Drop nodes laid out wholly outside the root window, such as scrolled-away list rows."""
    root=nodes[0].get('bounds') if nodes else None
    if not (isinstance(root,list) and len(root)==4 and all(type(v) is int for v in root)): return nodes
    def inside(node):
        b=node.get('bounds')
        if not (isinstance(b,list) and len(b)==4 and all(type(v) is int for v in b)): return True
        return min(b[2],root[2])>max(b[0],root[0]) and min(b[3],root[3])>max(b[1],root[1])
    return [n for n in nodes if inside(n)]


async def collect_android_state(driver):
    snapshot=await driver._snapshot(allow_startup=True)
    if snapshot.get('startup'):
        target={'device_id':str(driver._device_id),'package':driver._package}
        return {'target':target,'startup':True,'text':'Target app is not in foreground. Launch the configured target app.',
                'elements':[],'fingerprint':fingerprint([target,'startup'])}
    nodes=[n for n in snapshot['nodes'] if isinstance(n,dict) and n.get('visible',True)]
    nodes=on_screen(nodes)
    counts={key:Counter(n.get(key) for n in nodes if n.get(key)) for key in ['resource_id','text','description']}
    elements=[]
    for node in nodes:
        locator=next(({key:node[key]} for key in counts if node.get(key) and counts[key][node[key]]==1),None)
        if locator and len(elements)<200:
            elements.append({'id':f'e{len(elements)}','role':str(node.get('class',''))[:100],
                'name':str(node.get('text') or node.get('description') or node.get('resource_id') or '')[:1000],
                'bounds':node.get('bounds'),'locator':locator})
    target={'device_id':str(driver._device_id),'package':driver._package}
    return {'target':target,'elements':elements,'text':'\n'.join(str(n.get('text','')) for n in nodes)[:12000],
            'fingerprint':fingerprint([target,elements])}
