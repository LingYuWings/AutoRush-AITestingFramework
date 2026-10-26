"""Enumerate only defined evidence locations; never arbitrary user dictionaries."""
def iter_step_screenshots(evidence):
    if not isinstance(evidence,dict): return
    if isinstance(evidence.get('screenshot'),dict): yield evidence['screenshot']
    agent=evidence.get('agent',{})
    if not isinstance(agent,dict): return
    for trace in agent.get('traces',[]):
        if not isinstance(trace,dict): continue
        observation=trace.get('observation',{})
        if isinstance(observation,dict) and isinstance(observation.get('screenshot'),dict): yield observation['screenshot']
        result=trace.get('result',{})
        if isinstance(result,dict):
            nested=result.get('evidence',{})
            if isinstance(nested,dict) and isinstance(nested.get('screenshot'),dict): yield nested['screenshot']

def iter_run_screenshots(run):
    for case in run.cases:
        for step in case.steps: yield from iter_step_screenshots(step.evidence)
