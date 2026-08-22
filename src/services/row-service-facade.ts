import type { RowService } from '../core/service-contracts';

type RowServiceHelper = {
  getTranscriptRows?: () => unknown;
};

export function createRowServiceFacade(helper: RowServiceHelper): RowService {
  return {
    getTranscriptRows() {
      const rows = helper.getTranscriptRows?.();
      return Array.isArray(rows)
        ? rows.filter((row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement)
        : [];
    }
  };
}
