// Small builders for the connect-model tests. OWNER: UI engineer.
export { makeStatus } from './fixtures.js';
/** An InputErrorInfo of the native bridge: `code` is the InputErrorInfo code, `bridgeCode` / `key` the native part. */
export const nativeError = (code, bridgeCode, key) => ({ code, message: 'm', retryable: code !== 'unsupported_browser', at: 0, native: { code: bridgeCode, key } });
