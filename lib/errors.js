export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const fail = (status, code, message) => { throw new AppError(status, code, message); };
export const unavailable = () => new AppError(503, 'unavailable', 'Palvelu ei ole saatavilla. Yritä myöhemmin.');
