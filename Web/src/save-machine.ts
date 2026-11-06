import { Text } from '@codemirror/state';
import { migrateImageReferences } from './migration';
import { newID } from './protocol';

export interface Context { protocolVersion: 1; sessionID: string; capability: string }
export type Outcome = 'success' | 'failure' | 'cancelled' | 'conflict' | 'unconfirmed';
export type SaveState = 'loaded' | 'saving' | 'saved' | 'failure' | 'cancelled' | 'conflict' | 'unconfirmed';
export type Transport = (body: Record<string, unknown>) => void;
interface Pending { requestID: string; revision: number; text: Text; timer: ReturnType<typeof setTimeout> }

export class SaveMachine {
  current: Text;
  baseline: Text;
  revision = 0;
  pending: Pending | null = null;
  queued = false;
  state: SaveState = 'loaded';
  error = '';
  lineSeparator = '\n';
  private listeners = new Set<() => void>();

  constructor(readonly context: Context, readonly documentID: string, initial: Text, private readonly send: Transport,
    private readonly timeoutMS = 60_000, private readonly makeID = newID) { this.current = this.baseline = initial; }
  get dirty(): boolean { return !this.current.eq(this.baseline); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private fields() { const { protocolVersion, sessionID, capability } = this.context; return { protocolVersion, sessionID, capability }; }
  private changed(): void {
    this.send({ ...this.fields(), kind: 'state', documentID: this.documentID, revision: this.revision, dirty: this.dirty, pending: this.pending !== null });
    for (const listener of this.listeners) listener();
  }
  edited(text: Text): void {
    if (text === this.current || text.eq(this.current)) return;
    this.current = text; this.revision++; this.changed();
  }
  requestSave(): void {
    if (this.pending) { this.queued = true; this.changed(); return; }
    const requestID = this.makeID(), text = this.current, revision = this.revision;
    const timer = setTimeout(() => {
      if (this.pending?.requestID !== requestID) return;
      this.state = 'unconfirmed'; this.error = '保存结果未确认，请保留文档，不要强制关闭'; this.changed();
    }, this.timeoutMS);
    this.pending = { requestID, revision, text, timer }; this.state = 'saving'; this.error = ''; this.changed();
    this.send({ ...this.fields(), kind: 'save', documentID: this.documentID, requestID, revision,
      snapshot: this.lineSeparator === '\n' ? text.toString() : text.toString().replace(/\n/g, this.lineSeparator) });
  }
  accepts(value: Record<string, unknown>): boolean {
    const pending = this.pending;
    return !!pending && value.kind === 'saveReceipt' && value.protocolVersion === 1 && value.sessionID === this.context.sessionID &&
      value.documentID === this.documentID && value.requestID === pending.requestID && value.revision === pending.revision &&
      ['success', 'failure', 'cancelled', 'conflict', 'unconfirmed'].includes(String(value.outcome));
  }
  receive(value: Record<string, unknown>): boolean {
    if (!this.accepts(value)) return false;
    const pending = this.pending!;
    this.error = typeof value.error === 'string' ? value.error : '';
    if (value.outcome === 'unconfirmed') { clearTimeout(pending.timer); this.state = 'unconfirmed'; this.changed(); return true; }
    clearTimeout(pending.timer); this.pending = null;
    this.state = value.outcome === 'success' ? 'saved' : value.outcome as SaveState;
    if (value.outcome === 'success') {
      const mapping = (value.migration ?? {}) as Record<string, string>;
      this.baseline = Text.of(migrateImageReferences(pending.text.toString(), mapping).split('\n'));
    }
    const drain = this.queued && value.outcome === 'success' && this.dirty;
    this.queued = false;
    if (drain) this.requestSave(); else this.changed();
    return true;
  }
  async saveForClose(): Promise<boolean> {
    if (this.pending) return false;
    return new Promise(resolve => {
      const unsubscribe = this.subscribe(() => {
        if (this.state === 'unconfirmed' || (!this.pending && this.state !== 'saving')) {
          unsubscribe(); resolve(this.state === 'saved' && !this.dirty && !this.pending);
        }
      });
      this.requestSave();
    });
  }
  dispose(): void { if (this.pending) clearTimeout(this.pending.timer); this.listeners.clear(); }
}
export async function protectClose(machine: SaveMachine, choose: () => Promise<'save' | 'discard' | 'cancel'>): Promise<boolean> {
  if (machine.pending) return false;
  if (!machine.dirty) return true;
  const atDecision = machine.current;
  const decision = await choose();
  if (decision === 'cancel' || machine.pending) return false;
  if (decision === 'discard') return machine.current.eq(atDecision);
  return machine.saveForClose();
}
export async function protectCloseAll(machines: SaveMachine[], choose: (machine: SaveMachine) => Promise<'save' | 'discard' | 'cancel'>): Promise<boolean> {
  const approved: { machine: SaveMachine; text: Text }[] = [];
  for (const machine of machines) {
    if (!await protectClose(machine, () => choose(machine))) return false;
    approved.push({ machine, text: machine.current });
  }
  return approved.every(({ machine, text }) => !machine.pending && machine.current.eq(text));
}
