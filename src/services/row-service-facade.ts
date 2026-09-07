import type { RowIdentity, RowService } from '../core/service-contracts';

type RowServiceHelper = {
  getTranscriptRows?: () => unknown;
  getCurrentActionRow?: RowService['getCurrentActionRow'];
  getRowIdentity?: RowService['getRowIdentity'];
  findRowByIdentity?: RowService['findRowByIdentity'];
  getRowTextarea?: RowService['getRowTextarea'];
  getRowTextValue?: RowService['getRowTextValue'];
};

export function createRowServiceFacade(helper: RowServiceHelper): RowService {
  return {
    getTranscriptRows() {
      const rows = helper.getTranscriptRows?.();
      return Array.isArray(rows)
        ? rows.filter((row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement)
        : [];
    },
    getCurrentActionRow(options = { allowFallback: false }) {
      return helper.getCurrentActionRow?.(options) ?? null;
    },
    getRowIdentity(row: HTMLElement) {
      return helper.getRowIdentity?.(row) ?? null;
    },
    findRowByIdentity(identity: RowIdentity) {
      return helper.findRowByIdentity?.(identity) ?? null;
    },
    getRowTextarea(row: HTMLElement) {
      return helper.getRowTextarea?.(row) ?? null;
    },
    getRowTextValue(row: HTMLElement) {
      return helper.getRowTextValue?.(row) ?? '';
    }
  };
}
