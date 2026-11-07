"""Revalidate edited candidates and commit a complete batch or nothing."""
from contextlib import closing
import hashlib
import json
import sqlite3
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from autorush.api_testing.nodes import freeze_case
from autorush.domain.models import CaseCreate, CaseRecord, StepSpec
from autorush.storage.sqlite import SqliteStore
from .mapping import api_block, diagnostic
from .models import ImportCandidate, ImportPreview
from .parser import parse_import
from .store import ImportStore, ImportStoreError, receipt

REVALIDATED_ERRORS = {'expected_required', 'platform_required', 'invalid_platform', 'intent_required',
                      'case_validation', 'api_request_required', 'invalid_api_request'}


# Carries one edited candidate and its source issue acknowledgement.
class Selection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    candidate_id: str = Field(min_length=1, max_length=64)
    draft: dict[str, Any]
    acknowledge_source_issues: bool = False


# Groups selected candidates with the browser scope and retry key.
class ImportCommit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    session_id: UUID
    idempotency_key: UUID
    selections: list[Selection] = Field(min_length=1, max_length=500)
    allow_duplicate_file: bool = False


# Derive a stable storage scope from the random browser session ID.
def owner_key(session):
    # The router authenticates the current local operator before every operation.
    # The random browser scope survives bootstrap-token rotation and restarts.
    return hashlib.sha256(('autorush-import:' + str(session)).encode()).hexdigest()


# Revalidate edited content while carrying forward unresolved source issues.
def check_selection(original, selection):
    issues = [issue for issue in original.diagnostics if issue.severity == 'warning']
    if not selection.acknowledge_source_issues:
        issues += [issue for issue in original.diagnostics if issue.code not in REVALIDATED_ERRORS and issue.severity == 'error']
    draft = selection.draft
    try:
        if set(draft) - set(CaseCreate.model_fields) or draft.get('platform') not in {'web','android','desktop','api'}:
            raise ValueError('invalid import fields')
        mode = 'structured' if draft['platform'] == 'api' else 'agent'
        if draft.get('execution_mode') != mode:
            raise ValueError('invalid import execution mode')
        case = CaseCreate.model_validate(draft)
        for label in ['steps', 'postconditions']:
            for index, step in enumerate(getattr(case, label), 1):
                raw = draft[label][index - 1]
                if set(raw) - set(StepSpec.model_fields) or step.order != index or (label == 'steps' and step.always_run):
                    raise ValueError('invalid step fields or order')
                if not step.intent.strip() or (step.driver != 'api' and not (step.expected_result or '').strip()):
                    raise ValueError('empty intent or expectation')
                if step.driver == 'api':
                    if step.operation != 'api.request' or set(step.parameters) != {'request'}:
                        raise ValueError('external API references are forbidden')
                    checked = api_block(json.dumps({'order': index, 'request': step.parameters['request']}), issues, original.source)
                    if checked is None:
                        raise ValueError('invalid API request')
        draft = case.model_dump(mode='json')
    except (ValueError, TypeError, KeyError, IndexError, ValidationError, RecursionError):
        issues.append(diagnostic('case_validation', '编辑内容未通过校验，请检查标题、执行端、步骤、预期与 API 请求。', source=original.source))
    return ImportCandidate(candidate_id=original.candidate_id, source=original.source, draft=draft, diagnostics=issues)


# Coordinate preview review and transactional case creation.
class ImportService:
    # Open the formal case store and the import store on the same database.
    def __init__(self, path):
        self.cases = SqliteStore(path)
        self.store = ImportStore(path)

    # Parse the source, flag existing titles and save a temporary preview.
    def preview(self, content, filename, options, owner):
        preview = parse_import(content, filename, options)
        existing = {case.title.casefold() for case in self.cases.list_cases(include_archived=True)}
        for candidate in preview.candidates:
            if candidate.draft['title'].casefold() in existing:
                candidate.diagnostics.append(diagnostic('existing_title', '已有同名用例，将新建草稿而不会覆盖。', source=candidate.source, warning=True))
        ident, expires = self.store.create_preview(owner, preview)
        with closing(self.store.api.connect()) as db:
            duplicate = self.store.duplicate_file(db, preview.file_sha256)
        return dict(import_id=ident, expires_at=expires, preview=preview.model_dump(mode='json'), duplicate_file=duplicate, result=None)

    # Recover a durable commit receipt before looking for an uncommitted preview.
    def get(self, ident, owner):
        with closing(self.store.api.connect()) as db:
            result = receipt(db.execute('SELECT result FROM case_import_commits WHERE owner=? AND import_id=?', (owner, ident)).fetchone())
            if result:
                return dict(import_id=ident, preview=None, result=result, duplicate_file=True, expires_at=None)
            expires, preview = self.store.get_preview(db, ident, owner)
            return dict(import_id=ident, preview=preview, expires_at=expires, result=None,
                        duplicate_file=self.store.duplicate_file(db, preview['file_sha256']))

    # Reject duplicate or foreign candidate IDs before validating edits.
    def selections(self, preview, payload):
        originals = {item.candidate_id:item for item in ImportPreview.model_validate(preview).candidates}
        identifiers = [item.candidate_id for item in payload.selections]
        if len(set(identifiers)) != len(identifiers) or set(identifiers) - set(originals):
            raise ImportStoreError(422, '选择项重复或不属于当前预览。')
        return [check_selection(originals[item.candidate_id], item) for item in payload.selections]

    # Return updated diagnostics without changing the formal case store.
    def validate(self, ident, owner, payload):
        with closing(self.store.api.connect()) as db:
            _, preview = self.store.get_preview(db, ident, owner)
        return {'candidates':[item.model_dump(mode='json') for item in self.selections(preview, payload)]}

    # Freeze request snapshots, create drafts and save the retry receipt in one transaction.
    def commit(self, ident, owner, payload):
        data = payload.model_dump(mode='json', exclude={'idempotency_key', 'session_id'})
        fingerprint = hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        try:
            with closing(self.store.api.connect()) as db, db:
                db.execute('BEGIN IMMEDIATE')
                previous = db.execute('SELECT import_id,fingerprint,result FROM case_import_commits WHERE owner=? AND (idempotency_key=? OR import_id=?)',
                                      (owner, str(payload.idempotency_key), ident)).fetchall()
                if previous:
                    if any(row[0] != ident or row[1] != fingerprint for row in previous):
                        raise ImportStoreError(409, '重试内容与已提交内容不一致，请检查导入结果。')
                    return json.loads(previous[0][2]), True
                _, preview = self.store.get_preview(db, ident, owner)
                selected = self.selections(preview, payload)
                if any(not item.valid for item in selected):
                    raise ImportStoreError(422, '选中的用例仍有错误，请先校验并补齐内容。')
                if self.store.duplicate_file(db, preview['file_sha256']) and not payload.allow_duplicate_file:
                    raise ImportStoreError(409, '该文件已导入，请确认允许重复文件后再提交。')
                records = []
                for item in selected:
                    case = freeze_case(CaseCreate.model_validate(item.draft), self.store.api, connection=db)
                    record = CaseRecord(**case.model_dump())
                    db.execute('INSERT INTO cases(id,status,payload) VALUES(?,?,?)', (str(record.id), record.status.value, record.model_dump_json()))
                    source = {'filename': preview['filename'], 'file_sha256': preview['file_sha256'],
                              'format': preview['format'], 'parser_version': preview['parser_version'],
                              'source': item.source.model_dump(mode='json'), 'candidate_id': item.candidate_id,
                              'reviewed_source_issues': next(s.acknowledge_source_issues for s in payload.selections if s.candidate_id == item.candidate_id)}
                    db.execute('INSERT INTO case_import_sources VALUES(?,?,?)', (str(record.id), ident, self.store.api.encode(source)))
                    records.append(record)
                result = {'import_id':ident,'case_ids':[str(record.id) for record in records], 'count':len(records)}
                db.execute('INSERT INTO case_import_commits VALUES(?,?,?,?,?,?)',
                           (owner, str(payload.idempotency_key), ident, fingerprint, preview['file_sha256'], json.dumps(result)))
                # Retain the receipt but release potentially sensitive draft content.
                db.execute('DELETE FROM case_import_previews WHERE id=?', (ident,))
                return result, False
        except sqlite3.Error:
            raise ImportStoreError(409, '批量导入未完成，所有本次写入已回滚；可使用原请求重试。') from None
