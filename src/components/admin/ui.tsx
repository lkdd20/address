import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type DependencyList, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Globe2, Languages, X } from 'lucide-react';
import { localeDefinitions } from '../../domain/locales';
import type { Locale } from '../../domain/types';
import { localeText } from './locale-text';
import { adminText } from './text';
import type { AdminLocale, Reveal } from './types';

export function LocaleMenu({ locale, change, className = '' }: { locale: Locale; change: (locale: Locale) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = localeDefinitions.find((definition) => definition.code === locale) || localeDefinitions[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.locale-menu-trigger')?.focus(); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    if (!open) { setOpen(true); return; }
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || [])];
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    buttons[(current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  return <div ref={root} className={`locale-menu ${className}`} onKeyDown={keyDown}>
    <button type="button" className="locale-menu-trigger" aria-label="Language" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Languages size={15} /><span>{active.label}</span><ChevronDown size={14} />
    </button>
    {open && <div className="locale-menu-options" role="listbox" aria-label="Language">
      {localeDefinitions.map((definition) => <button type="button" role="option" aria-selected={definition.code === locale} className={definition.code === locale ? 'active' : ''} key={definition.code} onClick={() => { setOpen(false); change(definition.code); }}>{definition.label}</button>)}
    </div>}
  </div>;
}
export function SecretInput({ label, name, visible, toggle, locale, required = false, value, onChange }: { label: string; name: string; visible: boolean; toggle: () => void; locale: AdminLocale; required?: boolean; value?: string; onChange?: (value: string) => void }) {
  const t = adminText[locale];
  return <label className="secret-input-field"><span>{label}</span><div><input name={name} type={visible ? 'text' : 'password'} minLength={10} required={required} autoComplete="new-password" value={value} onChange={onChange ? (event) => onChange(event.target.value) : undefined} /><button type="button" className="inline-toggle" onClick={toggle}>{visible ? t.hidePassword : t.showPassword}</button></div></label>;
}
export function SecretCell({ mask, locale, reveal, path, field }: { mask: string; locale: AdminLocale; reveal: Reveal; path: string; field: string }) {
  const t = adminText[locale];
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const copyTimer = useRef<number | undefined>(undefined);
  const requestId = useRef(0);
  const clear = useCallback(() => {
    requestId.current += 1;
    if (timer.current) window.clearTimeout(timer.current);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    timer.current = undefined;
    copyTimer.current = undefined;
    setValue(''); setVisible(false); setCopied(false); setError(false); setBusy(false);
  }, []);
  useEffect(() => { clear(); }, [clear, locale, mask, path, field]);
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) clear(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); clear(); };
  }, [clear]);
  const toggle = async () => {
    setError(false);
    if (visible) { clear(); return; }
    if (document.hidden) return;
    const id = ++requestId.current;
    setBusy(true);
    try {
      const result = await reveal(path);
      if (id !== requestId.current || document.hidden) return;
      const secret = String(result[field] || '');
      if (!secret) throw new Error('EMPTY_SECRET');
      setValue(secret); setVisible(true);
      timer.current = window.setTimeout(clear, 30_000);
    } catch { if (id === requestId.current) setError(true); }
    finally { if (id === requestId.current) setBusy(false); }
  };
  const copy = async () => {
    if (!value) return;
    const id = requestId.current;
    try {
      await navigator.clipboard.writeText(value);
      if (id !== requestId.current) return;
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch { if (id === requestId.current) setError(true); }
  };
  return <div className="secret-cell"><code>{visible ? value : mask}</code><div className="secret-actions"><button type="button" className="compact-action" disabled={busy} onClick={() => void toggle()}>{busy ? '…' : visible ? t.hideSecret : t.showSecret}</button>{visible && <button type="button" className="compact-action" onClick={() => void copy()}>{copied ? t.copied : t.copySecret}</button>}</div>{error && <small className="field-error">{t.revealFailed}</small>}</div>;
}
export const Panel = ({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) => <section className="admin-panel"><header><h2>{title}</h2>{actions}</header>{children}</section>;
export const EmptyState = ({ icon: Icon, text }: { icon: typeof Globe2; text: string }) => <div className="empty-hint"><span className="empty-hint-icon" aria-hidden="true"><Icon size={19} /></span><p>{text}</p></div>;
export function Dialog({ title, close, locale, children, className = '' }: { title: string; close: () => void; locale: AdminLocale; children: ReactNode; className?: string }) {
  const root = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  const titleId = useId();
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => [...(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    window.setTimeout(() => (focusable()[0] || root.current)?.focus(), 0);
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const values = focusable();
      if (!values.length) { event.preventDefault(); root.current?.focus(); return; }
      const first = values[0];
      const last = values[values.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyDown);
    return () => {
      document.removeEventListener('keydown', keyDown);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return createPortal(<div className="dialog-backdrop" role="presentation"><section ref={root} className={`admin-dialog ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" title={adminText[locale].close} aria-label={adminText[locale].close} onClick={close}><X aria-hidden="true" /></button></header>{children}</section></div>, document.body);
}

export const usePolling = (task: (signal: AbortSignal) => Promise<void>, intervalMs: number, deps: DependencyList, immediate = false) => {
  const taskRef = useRef(task);
  taskRef.current = task;
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const run = async () => {
      window.clearTimeout(timer);
      if (document.hidden) return;
      try { await taskRef.current(controller.signal); } catch { /* the task reports its own failures */ }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void run(), intervalMs);
    };
    const resume = () => { if (!document.hidden) void run(); };
    if (immediate) void run(); else timer = window.setTimeout(() => void run(), intervalMs);
    document.addEventListener('visibilitychange', resume);
    return () => { controller.abort(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', resume); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
};

type Confirm = (message: string) => Promise<boolean>;
const ConfirmContext = createContext<Confirm>(async (message) => window.confirm(message));
export const useConfirm = (): Confirm => useContext(ConfirmContext);
export function ConfirmProvider({ locale, children }: { locale: AdminLocale; children: ReactNode }) {
  const [pending, setPending] = useState<{ message: string; resolve: (value: boolean) => void } | null>(null);
  const confirm = useCallback<Confirm>((message) => new Promise((resolve) => setPending({ message, resolve })), []);
  const settle = (value: boolean) => { pending?.resolve(value); setPending(null); };
  return <ConfirmContext.Provider value={confirm}>{children}{pending && <Dialog title={localeText[locale].ui.confirmTitle} close={() => settle(false)} locale={locale} className="confirm-dialog">
    <div className="dialog-form"><p className="confirm-message">{pending.message}</p><div className="dialog-actions">
      <button type="button" onClick={() => settle(false)}>{adminText[locale].cancel}</button>
      <button type="button" className="primary-action danger-action" onClick={() => settle(true)}>{localeText[locale].ui.confirm}</button>
    </div></div>
  </Dialog>}</ConfirmContext.Provider>;
}
