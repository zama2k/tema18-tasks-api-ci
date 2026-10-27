/** Error that maps one-to-one to an HTTP response; anything else becomes a generic 500. */
class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, details) {
    return new HttpError(400, 'bad_request', message, details);
  }

  static notFound(message = 'resource not found') {
    return new HttpError(404, 'not_found', message);
  }
}

module.exports = { HttpError };
