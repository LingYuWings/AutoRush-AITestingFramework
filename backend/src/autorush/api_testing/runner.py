"""Shared sequential HTTP core and managed durable collection jobs."""
import asyncio
import hashlib
import json
import time

from autorush.api_testing.datasets import parse_dataset
from autorush.api_testing.engine import ApiEngine, bounded_evidence
from autorush.api_testing.models import ApiRequest, configuration
from autorush.api_testing.runner_store import ApiRunStore, now
from autorush.api_testing.tree import TreeError
from autorush.api_testing.variables import redact, secret_strings, variable_values


async def execute_sequence(snapshot, allowed_hosts, *, on_result=None):
    """Per-iteration variables/cookies; deterministic selected request order."""
    secrets = set(snapshot.get('secret_values', []))
    for iteration, row in enumerate(snapshot['rows'], 1):
        values = {**snapshot['seed'], **row, **snapshot.get('variables', {})}
        secrets.update(secret_strings(values))
        engine = ApiEngine(allowed_hosts, variables=values, secret_values=secrets)
        for request in snapshot['requests']:
            if snapshot['delay_ms']: await asyncio.sleep(snapshot['delay_ms'] / 1000)
            spec = ApiRequest.model_validate(request['configuration'])
            replay = {'request': spec.model_dump(), 'variables': dict(engine.variables), 'secret_values': list(engine.secrets)}
            result = await engine.execute(spec)
            secrets.update(engine.secrets)
            if on_result: await on_result(result.public, request['id'], replay)
            yield {**result.public, 'request_id': request['id'], 'request_version': request['version'], 'iteration': iteration}
            if snapshot['stop_on_failure'] and result.public['status'] != 'passed': return


class ApiRunner:
    def __init__(self, vault, tree, allowed_hosts):
        self.vault, self.tree, self.allowed_hosts = vault, tree, allowed_hosts
        self.store = ApiRunStore(vault)
        self.lock = asyncio.Lock()
        self.task = None
        self.active_id = None
        self.closing = False

    def prepare(self, command):
        requests = self.tree.ordered_requests(command.collection_id, command.folder_id)
        if command.request_ids:
            choices = {value['id']: value for value in requests}
            if any(record_id not in choices for record_id in command.request_ids):
                raise ValueError('selected request is outside the chosen collection or folder')
            requests = [choices[record_id] for record_id in command.request_ids]
        if not 1 <= len(requests) <= 100: raise ValueError('run requires 1..100 selected requests')
        rows = parse_dataset(command.data.format, command.data.content) if command.data else None
        iterations = command.iterations or (len(rows) if rows else 1)
        if rows and iterations > len(rows): raise ValueError('iteration count exceeds available dataset rows')
        if len(requests) * iterations > 1000: raise ValueError('run cannot exceed 1000 requests across all iterations')
        collection = self.vault.get('collections', command.collection_id)
        environment = self.vault.get('environments', command.environment_id) if command.environment_id else None
        if command.environment_id and environment is None: raise ValueError('environment not found')
        seed, secrets = variable_values([*collection['variables'], *(environment['variables'] if environment else [])])
        source = {'collection_id': command.collection_id, 'collection_name': collection['name'],
            'collection_version': collection['version'], 'folder_id': command.folder_id,
            'request_ids': [value['id'] for value in requests], 'request_versions': [value['version'] for value in requests],
            'environment_id': command.environment_id, 'environment_name': environment['name'] if environment else None,
            'environment_version': environment['version'] if environment else None,
            'iterations': iterations, 'dataset_row_count': len(rows) if rows else 0, 'delay_ms': command.delay_ms,
            'timeout_seconds': command.timeout_seconds, 'stop_on_failure': command.stop_on_failure}
        snapshot = {'requests': [{'id': value['id'], 'version': value['version'], 'configuration': configuration(value)} for value in requests],
            'rows': rows[:iterations] if rows else [{} for _ in range(iterations)], 'seed': seed,
            'secret_values': list(secrets), 'variables': command.variables, 'delay_ms': command.delay_ms,
            'timeout_seconds': command.timeout_seconds, 'stop_on_failure': command.stop_on_failure}
        return redact(source, secrets), snapshot

    async def start(self, command):
        signature = hashlib.sha256(json.dumps(command.model_dump(), sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        async with self.lock:
            existing = self.store.find(command.idempotency_key)
            if existing:
                if self.store.snapshot(existing['id']).get('signature') != signature:
                    raise TreeError('idempotency key belongs to another run configuration', 409)
                return existing
            source, snapshot = self.prepare(command)
            snapshot['signature'] = signature
            return self.launch(source, snapshot, command.idempotency_key)

    def launch(self, source, snapshot, key):
        if self.task and not self.task.done(): raise TreeError('a Runner task is already active: ' + self.active_id, 409)
        record = self.store.create(source, snapshot, key)
        self.active_id = record['id']
        self.task = asyncio.create_task(self.execute(record, snapshot))
        return record

    async def rerun(self, run_id, key):
        async with self.lock:
            original = self.store.get(run_id)
            if original is None: raise TreeError('run not found', 404)
            existing = self.store.find(key)
            if existing:
                if self.store.snapshot(existing['id']).get('rerun_of') != run_id:
                    raise TreeError('idempotency key belongs to another run', 409)
                return existing
            snapshot = self.store.snapshot(run_id)
            snapshot['rerun_of'] = run_id
            return self.launch(original['source'], snapshot, key)

    async def execute(self, record, snapshot):
        started = time.perf_counter()
        record.update(state='running', started_at=now())
        self.store.save(record)
        try:
            async with asyncio.timeout(snapshot['timeout_seconds']):
                async for value in execute_sequence(snapshot, self.allowed_hosts):
                    value = bounded_evidence(value)
                    value['seq'] = record['completed']
                    for assertion in value.get('assertions', []): assertion['detail'] = assertion['detail'][:4096]
                    size = len(json.dumps(value.get('response'), ensure_ascii=False).encode())
                    if record['retained_bytes'] + size > 10485760:
                        value['response'] = None
                        value['response_omitted'] = 'run response retention limit (10 MiB) reached'
                    else: record['retained_bytes'] += size
                    record['completed'] += 1
                    record['counts'][value['status']] += 1
                    record.update(current_iteration=value['iteration'], current_request=value['name'],
                        elapsed_ms=round((time.perf_counter()-started)*1000, 2))
                    self.store.append(record['id'], value['seq'], value, progress=record)
            record['state'] = 'completed'
            record['status'] = next((status for status in ['error', 'failed', 'blocked'] if record['counts'][status]), 'passed')
        except asyncio.CancelledError:
            record.update(state='interrupted' if self.closing else 'cancelled', status='blocked',
                detail='service stopped; requests will not be replayed' if self.closing else 'cancelled; already sent requests may have been processed')
        except TimeoutError:
            record.update(state='completed', status='blocked', detail='run deadline exceeded; no further requests sent')
        except Exception as exc:
            record.update(state='interrupted', status='error', detail='Runner stopped: ' + type(exc).__name__)
        finally:
            record['counts']['skipped'] += record['total'] - record['completed']
            record.update(finished_at=now(), current_request=None, elapsed_ms=round((time.perf_counter()-started)*1000, 2))
            self.store.save(record)

    async def cancel(self, run_id):
        async with self.lock:
            record = self.store.get(run_id)
            if record is None: raise TreeError('run not found', 404)
            if record['state'] not in {'queued', 'running', 'cancelling'}: return record
            if run_id != self.active_id or not self.task: raise TreeError('run has no active worker', 409)
            record['state'] = 'cancelling'
            self.store.save(record)
            self.task.cancel()
            # Let the task enter execute even if cancellation arrives immediately after POST.
            if record.get('started_at') is None:
                try: await self.task
                except asyncio.CancelledError:
                    record.update(state='cancelled', status='blocked', finished_at=now(), detail='cancelled before dispatch')
                    record['counts']['skipped'] = record['total']
                    self.store.save(record)
            return self.store.get(run_id)

    async def recover_interrupted(self):
        for record in self.store.summaries(limit=100)['items']:
            if record['state'] in {'queued', 'running', 'cancelling'}:
                record.update(state='interrupted', status='blocked', finished_at=now(), detail='service restarted; requests will not be replayed')
                record['counts']['skipped'] = record['total'] - record['completed']
                self.store.save(record)

    async def close(self):
        self.closing = True
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
