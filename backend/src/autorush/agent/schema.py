"""Provider guidance mirrors fixed driver contracts; local validation remains authoritative."""
from copy import deepcopy
from autorush.agent.contracts import DECISION_ADAPTER
from autorush.agent.intent import read_only_operations,navigation_path

S={'type':'string'};I={'type':'integer','minimum':0};XY={'x':I,'y':I}
OPERATIONS={
 'web':{'open':({'path':S},['path']),'click':({},[]),'fill':({'value':S},['value']),
   'press':({'key':{'enum':['Enter','Tab','Escape','Control+A']}},['key']),
   'select':({'value':S},['value']),'wait':({'state':{'enum':['visible','hidden']},'timeout_ms':{'type':'integer','minimum':100,'maximum':30000}},['state']),'inspect':({},[])},
 'desktop':{'click':({**XY,'button':{'enum':['left','right','middle']}},['x','y']),
   'write':({'text':S},['text']),'hotkey':({'keys':{'type':'array','items':S,'minItems':1,'maxItems':4}},['keys']),
   'scroll':({**XY,'direction':{'enum':['up','down']},'amount':{'type':'integer','minimum':1,'maximum':20}},['x','y','direction','amount']),
   'inspect_pixel':(XY,['x','y'])},
 'android':{'launch':({},[]),'tap':({},[]),'input_text':({'text':S},['text']),'back':({},[]),
   'swipe':({'from_x':I,'from_y':I,'to_x':I,'to_y':I,'duration_ms':{'type':'integer','minimum':100,'maximum':2000}},['from_x','from_y','to_x','to_y']),
   'inspect':({},[])},
 'api':{'request':({'method':{'enum':['GET','POST','PUT','PATCH','DELETE','HEAD']},'path':S,
    'query':{'type':'object','additionalProperties':True},'json':{}},['method','path'])}}

def decision_schema(step,observation):
    schema=DECISION_ADAPTER.json_schema()
    action=schema['$defs'].pop('ActionDecision')
    schema['oneOf']=[entry for entry in schema['oneOf'] if entry.get('$ref')!='#/$defs/ActionDecision']
    schema.pop('discriminator',None)
    verification=schema['$defs']['VerifyDecision']['properties']
    verification['observation_id']={'const':observation.id};verification['expected_result']={'const':step.expected_result}
    if step.driver=='desktop':
        # JPEG images cannot supply exact native RGB or OCR text. Natural goals
        # use visual judgment; explicit pixel assertions remain structured cases.
        verification['check']={'$ref':'#/$defs/VisualCheck'}
    ids=[e.id for e in observation.elements[:80]]
    readonly=read_only_operations(step)
    path=navigation_path(step)
    for name,(properties,required) in OPERATIONS[step.driver].items():
        if path is not None and name!='open':continue
        if readonly is not None and step.driver+'.'+name not in readonly:continue
        if observation.startup and name!={'web':'open','android':'launch'}.get(step.driver):continue
        needs_element=step.driver=='web' and name!='open' or step.driver=='android' and name in {'tap','input_text'}
        if needs_element and not ids:continue
        variant=deepcopy(action)
        props=variant['properties'];props['driver']={'const':step.driver};props['observation_id']={'const':observation.id}
        props['operation']={'const':step.driver+'.'+name}
        props['parameters']={'type':'object','properties':properties,'required':required,'additionalProperties':False}
        if path is not None:props['parameters']['properties']={**properties,'path':{'const':path}}
        variant['required'].append('parameters')
        if step.driver=='desktop' and name in {'click','scroll','inspect_pixel'} or step.driver=='android' and name=='swipe':
            props['coordinate_space']={'const':'normalized_1000'}
            variant['required'].append('coordinate_space')
            for key in (('from_x','from_y','to_x','to_y') if step.driver=='android' else ('x','y')):
                props['parameters']['properties'][key]={'type':'integer','minimum':0,'maximum':999}
        else:props.pop('coordinate_space',None)
        if needs_element:
            props['element_id']={'enum':ids};variant['required'].append('element_id')
        elif step.driver=='android' and name=='inspect' and ids:props['element_id']={'enum':ids}
        else:props.pop('element_id',None)
        schema['oneOf'].append(variant)
    return schema
