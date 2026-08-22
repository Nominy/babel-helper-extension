import type { SessionService } from '../core/service-contracts';

type SessionServiceHelper = {
  runtime?: {
    isSessionInteractive?: () => unknown;
  };
};

export function createSessionService(helper: SessionServiceHelper): SessionService {
  return {
    isInteractive() {
      return Boolean(helper.runtime?.isSessionInteractive?.());
    }
  };
}
