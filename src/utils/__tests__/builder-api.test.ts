import { afterEach, describe, expect, it, vi } from 'vitest';
import { csrfHeaders } from '../builder-api';

describe('csrfHeaders', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sends the console CSRF cookie as X-CSRFToken', () => {
    vi.stubGlobal('document', { cookie: 'openshift-session-token=x; csrf-token=abc%3D123; other=1' });
    expect(csrfHeaders()).toEqual({ 'X-CSRFToken': 'abc=123' });
  });
  it('sends nothing when there is no CSRF cookie', () => {
    vi.stubGlobal('document', { cookie: 'other=1' });
    expect(csrfHeaders()).toEqual({});
  });
});
