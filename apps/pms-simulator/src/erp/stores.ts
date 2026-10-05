import type { CommandHandler, QueryHandler } from '../agent/link-client';

interface StockLine {
  readonly onHand: number;
  readonly unit: string;
  readonly warehouse: string;
}

/**
 * The ERP face of the simulator (BUILD_PLAN 13.5, Planova ERP Profile v1): a stores ledger that answers `ERP_STOCK`
 * reads and records `REQUISITION_CREATE` commands. Items listed in `blockedItems` refuse requisitions, so a failure can
 * be played.
 */
export class SimulatedErp {
  readonly stock = new Map<string, StockLine[]>();
  /** Requisitions received, in order (for scenarios and tests). */
  readonly requisitions: Array<{
    readonly ref: string;
    readonly lines: ReadonlyArray<{ item_code: string; quantity: number; unit: string }>;
  }> = [];
  readonly blockedItems = new Set<string>();

  constructor(stock: Record<string, StockLine[]> = {}) {
    for (const [item, lines] of Object.entries(stock)) this.stock.set(item, lines);
  }

  readonly onQuery: QueryHandler = async (query) => {
    if (query.query_type !== 'ERP_STOCK') return { rows: [] };
    const items = ((query.params as { items?: unknown }).items ?? []) as string[];
    const rows = items.flatMap((item) =>
      (this.stock.get(item) ?? []).map((l) => ({
        item_code: item,
        on_hand: l.onHand,
        unit: l.unit,
        warehouse: l.warehouse,
      })),
    );
    return { rows };
  };

  readonly onCommand: CommandHandler = async (command) => {
    if (command.command_type !== 'REQUISITION_CREATE')
      return { status: 'FAILED', error: `unsupported command ${command.command_type}` };
    const p = command.payload as {
      requisition_ref: string;
      lines: Array<{ item_code: string; quantity: number; unit: string }>;
    };
    const blocked = p.lines.find((l) => this.blockedItems.has(l.item_code));
    if (blocked) return { status: 'FAILED', error: `item ${blocked.item_code} is blocked` };
    if (!this.requisitions.some((r) => r.ref === p.requisition_ref))
      this.requisitions.push({ ref: p.requisition_ref, lines: p.lines });
    return { status: 'ACKNOWLEDGED' };
  };
}
