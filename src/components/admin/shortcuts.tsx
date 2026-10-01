import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type SyntheticEvent } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, RotateCcw, Save, Search, Trash2 } from 'lucide-react';
import { isCountryCode } from '../../domain/countries';
import { localizedCountryName } from '../../domain/locales';
import type { CountryShortcutConfig, LocationOption, LocationShortcut } from '../../domain/types';
import { adminText, errorMessage, interpolate, shortcutText, syncHistoryText, usesChineseSource } from './text';
import type { AdminCountryShortcutConfig, AdminLocale, Mutate, RequestData } from './types';
import { useConfirm } from './ui';

export function CountryShortcutSettings({ values, locale, busy, mutate, request }: {
  values: AdminCountryShortcutConfig[]; locale: AdminLocale; busy: boolean; mutate: Mutate; request: RequestData;
}) {
  const text = shortcutText(locale);
  const sorted = values.slice().sort((left, right) => {
    const leftName = isCountryCode(left.countryCode) ? localizedCountryName(left.countryCode, locale, left.countryCode) : left.countryCode;
    const rightName = isCountryCode(right.countryCode) ? localizedCountryName(right.countryCode, locale, right.countryCode) : right.countryCode;
    return leftName.localeCompare(rightName, locale);
  });
  const initialCode = sorted.some((value) => value.countryCode === 'US') ? 'US' : sorted[0]?.countryCode || '';
  const [selectedCode, setSelectedCode] = useState<string>(initialCode);
  const selected = sorted.find((value) => value.countryCode === selectedCode) || sorted[0];
  useEffect(() => {
    if (!sorted.some((value) => value.countryCode === selectedCode)) setSelectedCode(initialCode);
  }, [initialCode, selectedCode, sorted]);
  if (!selected) return <div className="admin-empty">{text.defaults}</div>;
  return <section className="shortcut-settings-page">
    <header className="shortcut-settings-heading">
      <label><span>{text.country}</span><select value={selected.countryCode} onChange={(event) => setSelectedCode(event.target.value)}>
        {sorted.map((value) => <option key={value.countryCode} value={value.countryCode}>{isCountryCode(value.countryCode) ? localizedCountryName(value.countryCode, locale, value.countryCode) : value.countryCode}</option>)}
      </select></label>
    </header>
    <CountryShortcutEditor key={selected.countryCode} value={selected} locale={locale} busy={busy} mutate={mutate} request={request} />
  </section>;
}
export type ShortcutListKey = 'adminShortcuts' | 'popularCities' | 'specialAreas';
export type ShortcutCatalogField = 'region' | 'city' | 'postcode';
export interface ShortcutOptionPage { options: LocationOption[]; total: number; nextCursor?: string }
export const shortcutLabel = (item: LocationShortcut, locale: AdminLocale): string =>
  usesChineseSource(locale) ? item.label['zh-CN'] || item.label.en : item.label.en || item.label['zh-CN'];
export const shortcutOptionLabel = (item: LocationOption, locale: AdminLocale): string => usesChineseSource(locale)
  ? item.zhCN || item.native || item.en || item.value
  : item.en || item.value || item.label;
export function ShortcutPicker({ countryCode, field, items, locale, request, add }: {
  countryCode: string; field: ShortcutCatalogField; items: LocationShortcut[];
  locale: AdminLocale; request: RequestData; add: (item: LocationShortcut) => void;
}) {
  const text = shortcutText(locale);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<LocationOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState('');
  const [previous, setPrevious] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [retry, setRetry] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setOptions([]); setActiveIndex(-1);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ field, q: query, cursor });
      void request<ShortcutOptionPage>(`/settings/country-shortcuts/${countryCode}/options?${params}`, { signal: controller.signal })
        .then((value) => {
          if (controller.signal.aborted) return;
          setOptions((value.options || []).filter((option) => option.availableCount !== 0));
          setTotal(value.total || 0); setNextCursor(value.nextCursor);
        })
        .catch((error) => { if (!controller.signal.aborted) setError(errorMessage(error, locale)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [countryCode, field, open, query, cursor, retry, request, locale]);
  useEffect(() => { setCursor(''); setPrevious([]); setNextCursor(undefined); }, [countryCode, field]);
  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, open, activeIndex]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const selected = new Set(items.map((item) => `${item.type}:${item.value.toLocaleLowerCase()}`));
  const unavailable = (option: LocationOption) => Boolean(option.disabled || selected.has(`${field}:${(field === 'region' && option.regionCode ? option.regionCode : option.value).toLocaleLowerCase()}`));
  const choose = (option: LocationOption) => {
    const type: LocationShortcut['type'] = field;
    const value = field === 'region' && option.regionCode ? option.regionCode : option.value;
    if (selected.has(`${type}:${value.toLocaleLowerCase()}`)) return;
    add({
      label: { en: option.en || option.value, 'zh-CN': option.zhCN || option.native || option.en || option.value },
      value,
      type
    });
    setQuery('');
    setCursor(''); setPrevious([]);
    setOpen(false);
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
    if (event.key === 'Enter' && open) { event.preventDefault(); if (options[activeIndex] && !unavailable(options[activeIndex])) choose(options[activeIndex]); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); setOpen(true);
    for (let index = activeIndex + (event.key === 'ArrowDown' ? 1 : -1); index >= 0 && index < options.length; index += event.key === 'ArrowDown' ? 1 : -1) {
      if (!unavailable(options[index])) { setActiveIndex(index); break; }
    }
  };
  return <div className="shortcut-picker" ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <div className={`shortcut-picker-control ${open ? 'open' : ''}`}>
      <Search size={15} aria-hidden="true" />
      <input role="combobox" aria-label={text.choose} aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        placeholder={text.choose} value={query} onFocus={() => setOpen(true)} onKeyDown={keyDown}
        onChange={(event) => { setQuery(event.target.value); setCursor(''); setPrevious([]); setOpen(true); }} />
      <button type="button" aria-label={text.choose} aria-expanded={open} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((value) => !value)}><ChevronDown size={15} /></button>
    </div>
    {open && <div className="shortcut-picker-popup">
      <div className="shortcut-picker-options" id={`${id}-list`} role="listbox" aria-label={text.choose} aria-busy={loading}>
      {options.map((option, index) => {
        const disabled = unavailable(option);
        return <button id={`${id}-option-${index}`} type="button" role="option" tabIndex={-1} aria-selected={disabled} disabled={disabled}
          className={activeIndex === index ? 'active' : ''} key={option.id || option.value} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
          <span>{shortcutOptionLabel(option, locale)}</span>
          {option.availableCount !== undefined && <small>{interpolate(text.available, { count: option.availableCount.toLocaleString(locale) })}</small>}
        </button>;
      })}</div>
      {loading ? <p role="status">{text.loading}</p> : error ? <div className="shortcut-picker-error" role="alert"><span>{error}</span>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setRetry((value) => value + 1)}>{adminText[locale].retry}</button>
      </div> : !options.length && <p>{text.noOptions}</p>}
      <div className="shortcut-picker-status"><span>{options.length ? `${Number(cursor) + 1}–${Number(cursor) + options.length}` : 0} / {total.toLocaleString(locale)}</span>
        {previous.length > 0 && <button type="button" disabled={loading} onMouseDown={(event) => event.preventDefault()} onClick={() => {
          setCursor(previous[previous.length - 1]); setPrevious((values) => values.slice(0, -1));
        }}>{syncHistoryText[locale].previous}</button>}
        {nextCursor && !error && <button type="button" disabled={loading} onMouseDown={(event) => event.preventDefault()} onClick={() => {
          setPrevious((values) => [...values, cursor]); setCursor(nextCursor);
        }}>{syncHistoryText[locale].next}</button>}
      </div>
    </div>}
  </div>;
}
export function CountryShortcutEditor({ value, locale, busy, mutate, request }: {
  value: AdminCountryShortcutConfig; locale: AdminLocale; busy: boolean; mutate: Mutate; request: RequestData;
}) {
  const confirm = useConfirm();
  const text = shortcutText(locale);
  const editable = (source: AdminCountryShortcutConfig): CountryShortcutConfig => ({
    countryCode: source.countryCode,
    popularCities: structuredClone(source.popularCities),
    adminShortcuts: structuredClone(source.adminShortcuts),
    specialAreaTitle: { ...source.specialAreaTitle },
    specialAreas: structuredClone(source.specialAreas)
  });
  const [draft, setDraft] = useState<CountryShortcutConfig>(() => editable(value));
  const serverDraft = useRef(JSON.stringify(editable(value)));
  const [specialType, setSpecialType] = useState<ShortcutCatalogField>(() => {
    const type = value.specialAreas[0]?.type;
    return type === 'city' || type === 'postcode' ? type : 'region';
  });
  useEffect(() => {
    const previous = serverDraft.current;
    serverDraft.current = JSON.stringify(editable(value));
    setDraft((current) => current.countryCode !== value.countryCode || JSON.stringify(current) === previous ? editable(value) : current);
  }, [value]);
  const addItem = (section: ShortcutListKey, item: LocationShortcut) => setDraft((current) => ({ ...current, [section]: [...current[section], item] }));
  const removeItem = (section: ShortcutListKey, index: number) => {
    setDraft((current) => ({ ...current, [section]: current[section].filter((_, itemIndex) => itemIndex !== index) }));
  };
  const moveItem = (section: ShortcutListKey, index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= draft[section].length) return;
    setDraft((current) => {
      const items = [...current[section]];
      [items[index], items[target]] = [items[target], items[index]];
      return { ...current, [section]: items };
    });
  };
  const renderList = (section: ShortcutListKey, title: string, field: ShortcutCatalogField) => <section className="shortcut-editor-section">
    <header><h3>{title}</h3><span>{interpolate(text.selected, { count: draft[section].length })}</span></header>
    <ShortcutPicker countryCode={value.countryCode} field={field} items={draft[section]} locale={locale} request={request} add={(item) => addItem(section, item)} />
    <div className="shortcut-editor-list">{draft[section].map((item, index) => <div className="shortcut-editor-row" key={`${section}-${index}`}>
      <strong>{shortcutLabel(item, locale)}</strong>
      <span className="shortcut-row-actions">
        <button type="button" className="icon-action" title={text.moveUp} aria-label={text.moveUp} disabled={index === 0} onClick={() => moveItem(section, index, -1)}><ArrowUp size={14} /></button>
        <button type="button" className="icon-action" title={text.moveDown} aria-label={text.moveDown} disabled={index === draft[section].length - 1} onClick={() => moveItem(section, index, 1)}><ArrowDown size={14} /></button>
        <button type="button" className="icon-action danger-control" title={text.remove} aria-label={text.remove} onClick={() => removeItem(section, index)}><Trash2 size={14} /></button>
      </span>
    </div>)}</div>
  </section>;
  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitted = JSON.stringify(draft);
    const result = await mutate<AdminCountryShortcutConfig>(`/settings/country-shortcuts/${value.countryCode}`, 'PUT', draft, text.saved);
    if (result) setDraft((current) => JSON.stringify(current) === submitted ? editable(result) : current);
  };
  const reset = async () => {
    if (!await confirm(text.confirmReset)) return;
    const result = await mutate<AdminCountryShortcutConfig>(`/settings/country-shortcuts/${value.countryCode}`, 'DELETE', undefined, text.resetDone);
    if (result) setDraft(editable(result));
  };
  return <form className="shortcut-editor" onSubmit={save}>
    <div className="shortcut-editor-toolbar">
      <div className="shortcut-editor-status"><strong>{isCountryCode(value.countryCode) ? localizedCountryName(value.countryCode, locale, value.countryCode) : value.countryCode}</strong><span className={`badge ${value.customized ? 'customized' : ''}`}>{value.customized ? text.customized : text.defaults}</span></div>
      <div className="shortcut-editor-actions"><button type="button" className="secondary-action" disabled={busy || !value.customized} onClick={() => void reset()}><RotateCcw size={15} />{text.reset}</button><button className="primary-action" disabled={busy}><Save size={15} />{text.save}</button></div>
    </div>
    <section className="shortcut-editor-section special-title-editor"><header><h3>{text.specialTitle}</h3></header><div>
      <input required aria-label={text.specialTitle} value={usesChineseSource(locale) ? draft.specialAreaTitle['zh-CN'] : draft.specialAreaTitle.en} onChange={(event) => setDraft((current) => ({ ...current, specialAreaTitle: { ...current.specialAreaTitle, [usesChineseSource(locale) ? 'zh-CN' : 'en']: event.target.value } }))} />
    </div></section>
    {renderList('adminShortcuts', text.adminAreas, 'region')}
    {renderList('popularCities', text.cities, 'city')}
    <section className="shortcut-special-type"><label><span>{text.type}</span><select value={specialType} onChange={(event) => setSpecialType(event.target.value as ShortcutCatalogField)}><option value="region">{text.region}</option><option value="city">{text.city}</option><option value="postcode">{text.postcode}</option></select></label></section>
    {renderList('specialAreas', text.specialAreas, specialType)}
  </form>;
}
