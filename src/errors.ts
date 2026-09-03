export type ProcessSupervisorErrorCode =
  | 'INVALID_SPEC'
  | 'PROCESS_ALREADY_MANAGED'
  | 'PROCESS_NOT_FOUND'
  | 'PROCESS_START_FAILED'
  | 'PROCESS_STOP_FAILED'
  | 'PROCESS_IDENTITY_MISMATCH'
  | 'PROCESS_CONTROL_UNCERTAIN'
  | 'STATE_DIRECTORY_LOCKED'
  | 'STATE_STORE_FAILED'
  | 'UNSUPPORTED_PLATFORM'
  | 'UNSUPPORTED_RECOVERY';

export class ProcessSupervisorError extends Error {
  readonly code: ProcessSupervisorErrorCode;

  constructor(code: ProcessSupervisorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProcessSupervisorError';
    this.code = code;
  }
}
