import type { RowIdentity, RowService } from '../core/service-contracts';

type RowServiceHelper = {
  getTranscriptRows?: () => unknown;
  getCurrentActionRow?: RowService['getCurrentActionRow'];
  getRowIdentity?: RowService['getRowIdentity'];
  findRowByIdentity?: RowService['findRowByIdentity'];
  getRowEditor?: RowService['getRowEditor'];
  getRowTextValue?: RowService['getRowTextValue'];
};

export function createRowServiceFacade(helper: RowServiceHelper): RowService {
  return {
    getTranscriptRows() {
      const rows = helper.getTranscriptRows?.();
      return Array.isArray(rows)
        ? rows.filter((row): row is HTMLElement => row instanceof HTMLElement)
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
    getRowEditor(row: HTMLElement) {
      return helper.getRowEditor?.(row) ?? null;
    },
    getRowTextValue(row: HTMLElement) {
      return helper.getRowTextValue?.(row) ?? '';
    }
  };
}
