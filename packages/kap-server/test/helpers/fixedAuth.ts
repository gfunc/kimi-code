import type { IAuthTokenService } from '../../src/services/auth/authTokenService';

export function fixedTokenAuth(token = 'test-token'): IAuthTokenService {
  return {
    _serviceBrand: undefined,
    getToken: () => token,
    isValid: async (candidate) => candidate === token,
    createPairingCode: () => 'test-pairing-code',
    exchangePairingCode: async () => undefined,
    revokeDeviceToken: async () => false,
  };
}
