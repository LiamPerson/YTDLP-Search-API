"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicErrorBody = exports.isAbortError = exports.toError = exports.CancelledError = exports.SearchTimeoutError = exports.FileAccessError = exports.JobNotFoundError = exports.QueueFullError = exports.ValidationError = exports.AppError = void 0;
class AppError extends Error {
    statusCode;
    code;
    expose;
    details;
    constructor(message, options) {
        super(message);
        this.name = new.target.name;
        this.statusCode = options?.statusCode ?? 500;
        this.code = options?.code ?? 'INTERNAL_ERROR';
        this.expose = options?.expose ?? this.statusCode < 500;
        this.details = options?.details;
    }
}
exports.AppError = AppError;
class ValidationError extends AppError {
    constructor(message, details) {
        super(message, { statusCode: 400, code: 'INVALID_REQUEST', expose: true, details });
    }
}
exports.ValidationError = ValidationError;
class QueueFullError extends AppError {
    constructor(limit) {
        super(`The search queue is full (${limit} waiting jobs). Try again after one of the queued searches finishes.`, {
            statusCode: 429,
            code: 'SEARCH_QUEUE_FULL',
            expose: true,
        });
    }
}
exports.QueueFullError = QueueFullError;
class JobNotFoundError extends AppError {
    constructor(jobId) {
        super(`Search job '${jobId}' was not found or has expired.`, {
            statusCode: 404,
            code: 'SEARCH_JOB_NOT_FOUND',
            expose: true,
        });
    }
}
exports.JobNotFoundError = JobNotFoundError;
class FileAccessError extends AppError {
    constructor(message, statusCode = 404, code = 'FILE_NOT_FOUND') {
        super(message, { statusCode, code, expose: true });
    }
}
exports.FileAccessError = FileAccessError;
class SearchTimeoutError extends AppError {
    constructor(timeoutMs) {
        super(`Search exceeded the ${timeoutMs}ms time limit and was cancelled.`, {
            statusCode: 504,
            code: 'SEARCH_TIMEOUT',
            expose: true,
        });
    }
}
exports.SearchTimeoutError = SearchTimeoutError;
class CancelledError extends AppError {
    constructor(message = 'The operation was cancelled.') {
        super(message, { statusCode: 499, code: 'CANCELLED', expose: true });
    }
}
exports.CancelledError = CancelledError;
const toError = (value) => {
    if (value instanceof Error)
        return value;
    if (typeof value === 'string')
        return new Error(value);
    return new Error('An unknown error occurred.');
};
exports.toError = toError;
const isAbortError = (value) => {
    return (value instanceof CancelledError ||
        (value instanceof Error && value.name === 'AbortError'));
};
exports.isAbortError = isAbortError;
const publicErrorBody = (value, includeStack = false) => {
    const error = (0, exports.toError)(value);
    const appError = error instanceof AppError ? error : undefined;
    return {
        error: {
            code: appError?.code ?? 'INTERNAL_ERROR',
            message: appError?.expose ? appError.message : 'An unexpected internal error occurred.',
            ...(appError?.details === undefined ? {} : { details: appError.details }),
            ...(includeStack && error.stack ? { stack: error.stack } : {}),
        },
    };
};
exports.publicErrorBody = publicErrorBody;
//# sourceMappingURL=errors.js.map