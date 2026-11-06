import type {DriverKind,StepSpec} from '../../shared/api'

export type ImportDraft={title:string;description:string;platform:DriverKind|null;execution_mode:'agent'|'structured';steps:StepSpec[];postconditions:StepSpec[]}
export type ImportSource={line_start?:number|null;line_end?:number|null;sheet_id?:string|null;sheet_title?:string|null;topic_path:string[];topic_ids?:string[]}
export type ImportDiagnostic={code:string;message:string;severity:'error'|'warning';field?:string|null;source?:ImportSource|null}
export type ImportCandidate={candidate_id:string;source:ImportSource;draft:ImportDraft;diagnostics:ImportDiagnostic[];valid:boolean}
export type ImportResult={import_id:string;case_ids:string[];count:number}
export type ImportSession={import_id:string;expires_at:number|null;duplicate_file:boolean;result:ImportResult|null;preview:{filename:string;file_sha256:string;format:string;candidates:ImportCandidate[];diagnostics:ImportDiagnostic[]}|null}
export type ImportOptions={default_platform:DriverKind|null;case_heading_level:number;case_depth:number|null;sheet_ids:string[]|null}
export type ImportSelection={candidate_id:string;draft:ImportDraft;acknowledge_source_issues:boolean}
export type ImportCommit={session_id:string;idempotency_key:string;selections:ImportSelection[];allow_duplicate_file:boolean}
export type ImportEntry={original:ImportCandidate;text:string;selected:boolean;reviewed:boolean;valid:boolean;dirty:boolean;diagnostics:ImportDiagnostic[]}
