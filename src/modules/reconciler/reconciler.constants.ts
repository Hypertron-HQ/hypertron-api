export const RECONCILER_QUEUE = 'reconciler';
export const EXPIRY_QUEUE = 'expiry-checker';

export const JOB_POLL_OPEN = 'poll-open-payments';
export const JOB_FINALITY_CHECK = 'finality-check';
export const JOB_EXPIRE_OVERDUE = 'expire-overdue-payments';

export const SCHEDULER_POLL_OPEN = 'scheduler-poll-open-payments';
export const SCHEDULER_EXPIRE = 'scheduler-expire-overdue';

export interface FinalityCheckJob {
  paymentInternalId: string;
}
